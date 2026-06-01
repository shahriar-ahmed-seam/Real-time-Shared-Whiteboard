import { describe, it, expect, vi } from "vitest";
import type { Socket } from "socket.io";

import {
  extractRoomId,
  extractToken,
  installErrorIsolation,
  HANDLER_ERROR_EVENT,
  UNAUTHORIZED_CODE,
} from "../../src/socket/gateway";
import {
  ConnectionContext,
  readHandshakeToken,
  type ConnectionDeps,
} from "../../src/socket/context";
import { createAuthGuard } from "../../src/middleware/authGuard";

// ─── extractRoomId (room-scoped event dispatch) ──────────────────────

describe("extractRoomId", () => {
  it("reads roomId from an object payload (join-room/draw/cursor-move shape)", () => {
    expect(extractRoomId([{ roomId: "abc123", username: "x" }])).toBe("abc123");
    expect(extractRoomId([{ roomId: "room-1", stroke: {} }])).toBe("room-1");
  });

  it("reads a bare-string roomId (clear shape)", () => {
    expect(extractRoomId(["room-9"])).toBe("room-9");
  });

  it("returns null when no room id can be determined", () => {
    expect(extractRoomId([])).toBeNull();
    expect(extractRoomId([""])).toBeNull();
    expect(extractRoomId([{ username: "x" }])).toBeNull();
    expect(extractRoomId([{ roomId: 42 }])).toBeNull();
    expect(extractRoomId([null])).toBeNull();
  });
});

// ─── extractToken (join-room payload token) ──────────────────────────

describe("extractToken", () => {
  it("reads a non-empty token from the payload", () => {
    expect(extractToken([{ roomId: "r", token: "jwt-here" }])).toBe("jwt-here");
  });

  it("returns null when token is absent or not a non-empty string", () => {
    expect(extractToken([{ roomId: "r" }])).toBeNull();
    expect(extractToken([{ roomId: "r", token: "" }])).toBeNull();
    expect(extractToken([{ roomId: "r", token: 5 }])).toBeNull();
    expect(extractToken([])).toBeNull();
  });
});

// ─── readHandshakeToken ──────────────────────────────────────────────

function fakeSocket(auth?: unknown): Socket {
  return {
    id: "socket-1",
    handshake: { auth },
  } as unknown as Socket;
}

describe("readHandshakeToken", () => {
  it("reads a non-empty handshake auth token", () => {
    expect(readHandshakeToken(fakeSocket({ token: "abc" }))).toBe("abc");
  });

  it("returns null when the handshake token is missing or invalid", () => {
    expect(readHandshakeToken(fakeSocket({}))).toBeNull();
    expect(readHandshakeToken(fakeSocket({ token: "" }))).toBeNull();
    expect(readHandshakeToken(fakeSocket(undefined))).toBeNull();
    expect(readHandshakeToken(fakeSocket({ token: 123 }))).toBeNull();
  });
});

// ─── ConnectionContext.authorize (Auth_Guard wiring) ─────────────────

const SECRET = "test-secret-test-secret-test-secret-123456";
const ROOM = "room-abc";

function makeDeps(openMode: boolean): ConnectionDeps {
  return {
    io: {} as ConnectionDeps["io"],
    rooms: {} as ConnectionDeps["rooms"],
    roomService: {} as ConnectionDeps["roomService"],
    presenceService: {} as ConnectionDeps["presenceService"],
    authGuard: createAuthGuard({ secret: SECRET, openMode }),
    // A no-op logger that still supports `.child()` (returns itself).
    logger: makeLogger(),
  };
}

function makeLogger(): ConnectionDeps["logger"] {
  const noop = () => undefined;
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return logger as unknown as ConnectionDeps["logger"];
}

describe("ConnectionContext.authorize", () => {
  it("authorizes a valid room-scoped token and caches the userId", () => {
    const deps = makeDeps(false);
    const token = deps.authGuard.sign({ roomId: ROOM, userId: "user-7" });
    const ctx = new ConnectionContext(fakeSocket({ token }), deps);

    const result = ctx.authorize(ROOM);

    expect(result.ok).toBe(true);
    expect(ctx.userId).toBe("user-7");
  });

  it("rejects an absent token when OPEN_MODE is disabled", () => {
    const deps = makeDeps(false);
    const ctx = new ConnectionContext(fakeSocket({}), deps);

    const result = ctx.authorize(ROOM);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_TOKEN");
    expect(ctx.userId).toBeNull();
  });

  it("rejects a token scoped to a different room", () => {
    const deps = makeDeps(false);
    const token = deps.authGuard.sign({ roomId: "other-room", userId: "u" });
    const ctx = new ConnectionContext(fakeSocket({ token }), deps);

    const result = ctx.authorize(ROOM);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROOM_SCOPE_MISMATCH");
  });

  it("honors a payload token override over the handshake token", () => {
    const deps = makeDeps(false);
    const payloadToken = deps.authGuard.sign({ roomId: ROOM, userId: "payload-user" });
    const ctx = new ConnectionContext(fakeSocket({ token: "bogus" }), deps);

    const result = ctx.authorize(ROOM, payloadToken);

    expect(result.ok).toBe(true);
    expect(ctx.userId).toBe("payload-user");
  });

  it("bypasses verification in OPEN_MODE (prototype flow with no token)", () => {
    const deps = makeDeps(true);
    const ctx = new ConnectionContext(fakeSocket({}), deps);

    const result = ctx.authorize(ROOM);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe("anonymous");
  });

  it("builds a per-connection rate limiter scoped to the socket", () => {
    const deps = makeDeps(true);
    const ctx = new ConnectionContext(fakeSocket({}), deps);
    // draw bucket capacity is 120 — the 121st immediate consume is dropped.
    const key = `draw:${ctx.socket.id}`;
    for (let i = 0; i < 120; i++) {
      expect(ctx.rateLimiter.tryConsume(key)).toBe(true);
    }
    expect(ctx.rateLimiter.tryConsume(key)).toBe(false);
  });

  it("exposes a stable unauthorized error code", () => {
    expect(UNAUTHORIZED_CODE).toBe("UNAUTHORIZED");
  });
});

// ─── installErrorIsolation (per-event error isolation, Req 7.4) ──────

/** A recording logger that captures `.error(...)` calls and is its own child. */
function makeRecordingLogger() {
  const errors: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    debug: noop,
    error: (fields: Record<string, unknown>, msg: string) => {
      errors.push({ fields, msg });
    },
    child: () => logger,
  };
  return { logger: logger as unknown as ConnectionDeps["logger"], errors };
}

/**
 * A fake Socket that stores registered listeners so a test can invoke them
 * directly (simulating an inbound event) and capture emitted events.
 */
function makeListenerSocket(): Socket & {
  listeners: Map<string, (...args: unknown[]) => unknown>;
  emitted: Array<{ event: string; args: unknown[] }>;
} {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const socket = {
    id: "socket-iso",
    handshake: { auth: {} },
    on(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, listener);
      return socket;
    },
    emit(event: string, ...args: unknown[]) {
      emitted.push({ event, args });
      return true;
    },
    listeners,
    emitted,
  };
  return socket as unknown as Socket & {
    listeners: Map<string, (...args: unknown[]) => unknown>;
    emitted: Array<{ event: string; args: unknown[] }>;
  };
}

function makeIsolationCtx() {
  const { logger, errors } = makeRecordingLogger();
  const deps = {
    ...makeDeps(true),
    logger,
  } as ConnectionDeps;
  const socket = makeListenerSocket();
  const ctx = new ConnectionContext(socket, deps);
  return { ctx, socket, errors };
}

describe("installErrorIsolation", () => {
  it("catches a synchronous throw, logs with correlation ids, and does not rethrow", () => {
    const { ctx, socket, errors } = makeIsolationCtx();
    installErrorIsolation(ctx);
    ctx.currentRoomId = "room-iso";

    socket.on("draw", () => {
      throw new Error("boom");
    });

    // Invoke the (now-wrapped) listener as Socket.IO would on an inbound event.
    const wrapped = socket.listeners.get("draw")!;
    expect(() => wrapped({ roomId: "room-iso" })).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0].fields.event).toBe(HANDLER_ERROR_EVENT);
    expect(errors[0].fields.socketEvent).toBe("draw");
    expect(errors[0].fields.roomId).toBe("room-iso");
    expect(errors[0].fields.err).toBe("boom");
  });

  it("catches a rejected promise from an async listener and keeps the connection alive", async () => {
    const { ctx, socket, errors } = makeIsolationCtx();
    installErrorIsolation(ctx);

    socket.on("draw", async () => {
      throw new Error("async-boom");
    });

    const wrapped = socket.listeners.get("draw")!;
    // The wrapper returns void synchronously; the rejection is caught later.
    expect(() => wrapped({ roomId: "r" })).not.toThrow();

    // Allow the caught rejection's microtask to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0].fields.socketEvent).toBe("draw");
    expect(errors[0].fields.err).toBe("async-boom");
  });

  it("runs a well-behaved listener exactly once and leaves it intact", () => {
    const { ctx, socket, errors } = makeIsolationCtx();
    installErrorIsolation(ctx);

    const inner = vi.fn();
    socket.on("draw", inner);

    const wrapped = socket.listeners.get("draw")!;
    wrapped("a", "b");

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith("a", "b");
    expect(errors).toHaveLength(0);
  });

  it("isolates one failing event without affecting other events on the connection", () => {
    const { ctx, socket, errors } = makeIsolationCtx();
    installErrorIsolation(ctx);

    socket.on("draw", () => {
      throw new Error("draw-fail");
    });
    const clearInner = vi.fn();
    socket.on("clear", clearInner);

    socket.listeners.get("draw")!({ roomId: "r" });
    socket.listeners.get("clear")!("r");

    expect(errors).toHaveLength(1);
    expect(errors[0].fields.socketEvent).toBe("draw");
    expect(clearInner).toHaveBeenCalledTimes(1);
  });

  it("installs a socket-level error safety net that logs and stays alive", () => {
    const { ctx, socket, errors } = makeIsolationCtx();
    installErrorIsolation(ctx);

    const errorListener = socket.listeners.get("error")!;
    expect(errorListener).toBeDefined();
    expect(() => errorListener(new Error("socket-level"))).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0].fields.socketEvent).toBe("error");
    expect(errors[0].fields.err).toBe("socket-level");
  });
});
