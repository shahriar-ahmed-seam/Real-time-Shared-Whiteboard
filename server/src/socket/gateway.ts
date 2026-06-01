import type { Server, Socket } from "socket.io";
import { ConnectionContext, type ConnectionDeps } from "./context";
import { attachRedisAdapter } from "./redisAdapter";
import type { RedisClients } from "../persistence/redis";
import { registerJoinRoom } from "../handlers/joinRoom";
import { registerDraw } from "../handlers/draw";
import { registerCursorMove } from "../handlers/cursorMove";
import { registerClear } from "../handlers/clear";
import { registerResync } from "../handlers/resync";
import { registerDisconnecting } from "../handlers/disconnecting";

// ─── Socket gateway ──────────────────────────────────────────────────
// Owns the connection lifecycle and event registration. Responsibilities:
//
//   1. Attach the Socket.IO Redis adapter so room broadcasts fan out across
//      every instance and any instance can serve any room with no instance-
//      local board state (Requirements 5.2, 5.3).
//   2. Build a per-connection {@link ConnectionContext} on connect, reading the
//      Join_Token from the handshake and constructing a per-connection rate
//      limiter and connection-correlated logger.
//   3. Run the Auth_Guard on every room-scoped event before the event reaches a
//      handler: a connection may only act on a room when it presents a valid,
//      unexpired, correctly-scoped Join_Token (Requirement 2.1). On failure the
//      event is rejected with an unauthorized error indication and the
//      connection is terminated (Requirement 2.10). OPEN_MODE bypasses this.
//   4. Register the per-event handlers (the dispatch).

/** Server → Client error indication payload (design "Server → Client" table). */
export interface SocketErrorPayload {
  code: string;
  message: string;
}

/** Error code returned to the sender when a room-scoped event is unauthorized. */
export const UNAUTHORIZED_CODE = "UNAUTHORIZED";

/** `event` field stamped on the structured log emitted for an isolated error. */
export const HANDLER_ERROR_EVENT = "handler-error";

/**
 * Inbound events that act on a specific room and therefore require a valid
 * room-scoped Join_Token before processing (Requirement 2.1). Lifecycle events
 * (`disconnecting`, `disconnect`) are intentionally excluded.
 */
const ROOM_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  "join-room",
  "draw",
  "cursor-move",
  "clear",
  "request-resync",
]);

export interface GatewayOptions {
  /**
   * Redis pub/sub connections for the Socket.IO adapter. When provided, the
   * adapter is attached so broadcasts fan out across instances. Omit only in
   * tests / single-process setups that don't need cross-instance fan-out.
   */
  redisClients?: RedisClients;
}

/**
 * Wire the socket gateway: attach the Redis adapter (if configured), then for
 * each connection build the per-connection context, install the room-scoped
 * Auth_Guard, and register the event handlers.
 */
export function registerGateway(
  io: Server,
  deps: ConnectionDeps,
  options: GatewayOptions = {}
): void {
  // 1. Cross-instance broadcast fan-out (Requirements 5.2, 5.3).
  if (options.redisClients) {
    attachRedisAdapter(io, options.redisClients);
  }

  io.on("connection", (socket) => {
    // 2. Per-connection context: handshake token, rate limiter, child logger.
    const ctx = new ConnectionContext(socket, deps);
    ctx.logger.info({ event: "connect" }, `Connected: ${socket.id}`);

    // 3. Per-event error isolation (Requirement 7.4). Install BEFORE handlers
    //    are registered so the wrapper sees every listener they attach: an
    //    unhandled exception thrown by any event listener (a synchronous throw
    //    or a rejected promise from an async listener) is caught, logged with
    //    the connection/room correlation ids, and the failed event discarded —
    //    the process and every other connection keep operating.
    installErrorIsolation(ctx);

    // 4. Run the Auth_Guard on every room-scoped event before it is handled.
    installAuthGuard(ctx);

    // 5. Register the per-event handlers (dispatch).
    registerJoinRoom(ctx);
    registerDraw(ctx);
    registerCursorMove(ctx);
    registerClear(ctx);
    registerResync(ctx);
    registerDisconnecting(ctx);
  });
}

/** A socket event listener as attached by the handlers via `socket.on`. */
type SocketListener = (...args: unknown[]) => unknown;

/**
 * Install per-event error isolation on a connection (Requirement 7.4).
 *
 * Every per-event listener the handlers register through `socket.on` is wrapped
 * so that an unhandled exception thrown while processing an event — whether a
 * synchronous `throw` or a rejected promise returned by an `async` listener —
 * is caught here rather than propagating. On a caught error the gateway:
 *
 *   • logs it through the connection-correlated child logger (so the line
 *     carries the `connectionId`) together with the failing `socketEvent` and
 *     the current `roomId`, plus the error message and stack as error context;
 *   • discards the failed event (the error is swallowed, not rethrown);
 *   • leaves the socket connected and the process running, so every other
 *     connection — and every other event on this one — keeps operating.
 *
 * This is installed before the handlers register their listeners so the wrapper
 * observes all of them. It works by shadowing this socket instance's `on`
 * method with one that wraps the supplied listener; the reserved `error` event
 * is passed through unwrapped (it is the safety-net listener installed below,
 * and wrapping it would be circular).
 *
 * A `socket.on("error")` safety-net listener is also attached: Socket.IO emits
 * an `error` event on the socket for failures it surfaces itself (for example a
 * middleware error). Without a listener a socket-level `error` can escalate; the
 * listener logs it and keeps the connection alive.
 */
export function installErrorIsolation(ctx: ConnectionContext): void {
  const { socket } = ctx;
  const originalOn = socket.on.bind(socket) as (
    event: string,
    listener: SocketListener,
  ) => Socket;

  const patchedOn = (event: string, listener: SocketListener): Socket => {
    // The reserved `error` event is the safety net itself — forward it as-is so
    // we never wrap (and recurse through) our own error logging.
    if (event === "error") {
      return originalOn(event, listener);
    }
    return originalOn(event, wrapListener(ctx, event, listener));
  };

  // Shadow only this instance's `on`; the prototype method is untouched. The
  // overloaded `Socket.on` signature is intentionally widened here.
  (socket as unknown as { on: typeof patchedOn }).on = patchedOn;

  // Safety-net listener for socket-level errors Socket.IO surfaces itself.
  originalOn("error", (err: unknown) => {
    isolateError(ctx, "error", err);
  });
}

/**
 * Wrap a single event listener so both synchronous throws and rejected promises
 * (from `async` listeners) are caught and isolated. The wrapper preserves the
 * listener's arguments and runs it exactly once per event.
 */
function wrapListener(
  ctx: ConnectionContext,
  event: string,
  listener: SocketListener,
): SocketListener {
  return (...args: unknown[]): void => {
    try {
      const result = listener(...args);
      // An `async` listener returns a promise; catch its rejection too so an
      // unhandled rejection never escapes to crash the process.
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        void (result as Promise<unknown>).catch((err) =>
          isolateError(ctx, event, err),
        );
      }
    } catch (err) {
      isolateError(ctx, event, err);
    }
  };
}

/**
 * Log an isolated handler error with connection/room correlation ids and the
 * error context, then discard the failed event. Never rethrows, so the process
 * and other connections keep operating (Requirement 7.4).
 */
function isolateError(
  ctx: ConnectionContext,
  event: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  ctx.logger.error(
    {
      event: HANDLER_ERROR_EVENT,
      socketEvent: event,
      roomId: ctx.currentRoomId ?? undefined,
      err: message,
      stack,
    },
    `Unhandled error in "${event}" handler for ${ctx.socket.id}; event discarded: ${message}`,
  );
}

/**
 * Install a per-connection inbound middleware that authorizes every room-scoped
 * event before it reaches a handler. The middleware:
 *
 *   • lets non-room-scoped events through untouched;
 *   • extracts the referenced room id (and, for `join-room`, the payload token);
 *   • runs the Auth_Guard via {@link ConnectionContext.authorize};
 *   • on success, lets the event proceed to its handler (with `ctx.userId` set);
 *   • on failure (OPEN_MODE disabled and token absent / invalid / expired /
 *     wrong-scope), emits an unauthorized error indication and terminates the
 *     connection (Requirement 2.10), dropping the event.
 *
 * In OPEN_MODE the Auth_Guard always succeeds, so the existing prototype flow
 * (clients that present no token) keeps working unchanged.
 */
function installAuthGuard(ctx: ConnectionContext): void {
  const { socket } = ctx;

  socket.use((packet, next) => {
    const [event, ...args] = packet as [string, ...unknown[]];

    if (!ROOM_SCOPED_EVENTS.has(event)) {
      next();
      return;
    }

    const roomId = extractRoomId(args);
    // A packet whose room id can't be read is left for the handler's schema
    // validation to reject; the guard only enforces auth when a room is known.
    if (roomId === null) {
      next();
      return;
    }

    // `join-room` carries its token in the payload (design protocol table);
    // fall back to the handshake token when the payload omits it so clients
    // that authenticate only at the handshake still work.
    const payloadToken = event === "join-room" ? extractToken(args) : null;
    const tokenOverride =
      event === "join-room" && payloadToken !== null ? payloadToken : undefined;

    const result = ctx.authorize(roomId, tokenOverride);
    if (result.ok) {
      next();
      return;
    }

    ctx.logger.warn(
      {
        event: "unauthorized",
        socketEvent: event,
        roomId,
        reason: result.code,
      },
      "Rejected room-scoped event: unauthorized Join_Token"
    );

    const error: SocketErrorPayload = {
      code: UNAUTHORIZED_CODE,
      message: "A valid join token scoped to this room is required",
    };
    socket.emit("error", error);
    // Drop the event (do not call next) and terminate the connection per 2.10.
    socket.disconnect(true);
  });
}

/**
 * Extract the referenced room id from a room-scoped event's argument list.
 * Handles both the object payload shape (`{ roomId, ... }`, used by `join-room`,
 * `draw`, `cursor-move`) and the bare-string shape (`clear`'s `roomId`).
 * Returns null when no room id can be determined.
 */
export function extractRoomId(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") {
    return first.length > 0 ? first : null;
  }
  if (first && typeof first === "object" && "roomId" in first) {
    const roomId = (first as { roomId?: unknown }).roomId;
    return typeof roomId === "string" && roomId.length > 0 ? roomId : null;
  }
  return null;
}

/**
 * Extract a Join_Token carried on an event payload (the `join-room` payload's
 * `token` field). Returns null when absent so the Auth_Guard treats it as a
 * missing token. `undefined` is reserved by the caller to mean "fall back to
 * the handshake token", so this never returns `undefined`.
 */
export function extractToken(args: readonly unknown[]): string | null {
  const first = args[0];
  if (first && typeof first === "object" && "token" in first) {
    const token = (first as { token?: unknown }).token;
    return typeof token === "string" && token.length > 0 ? token : null;
  }
  return null;
}
