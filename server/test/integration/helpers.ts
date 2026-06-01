// ─── Integration test harness ───────────────────────────────────────
// Stands up the REAL production socket gateway + handlers + services over an
// ephemeral `http.Server`, wired with ephemeral datastores so no Postgres or
// Redis is required:
//   • Persistence_Store → in-memory StrokeRepository + BoardRepository fakes
//     that satisfy the exact interfaces the production StrokeService consumes.
//   • Coordination_Store → `ioredis-mock` (shared in-process keyspace) backing
//     the real PresenceService, so its atomic Lua color allocation runs as in
//     production. A pure-Lua `cjson` polyfill is prepended to the scripts that
//     use it (leave/cursor/sweep) since the mock's Lua VM omits `cjson`.
//
// The gateway runs in OPEN_MODE so no signed Join_Token is required, and the
// Redis Socket.IO adapter is intentionally NOT attached — a single test process
// needs no cross-instance fan-out, and the default in-memory adapter delivers
// room broadcasts between the two connected `socket.io-client` instances.

import http from "http";
import { Server } from "socket.io";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

import { registerGateway } from "../../src/socket/gateway";
import type { ConnectionDeps } from "../../src/socket/context";
import { RoomRepository } from "../../src/repositories/roomRepository";
import { RoomService } from "../../src/services/roomService";
import { PresenceService } from "../../src/services/presenceService";
import { StrokeService } from "../../src/services/strokeService";
import { createAuthGuard } from "../../src/middleware/authGuard";
import type { Logger } from "../../src/observability/logger";
import type {
  StrokeRepository,
} from "../../src/repositories/strokeRepository";
import type { BoardRepository } from "../../src/repositories/boardRepository";
import type { PersistedStroke } from "../../src/types/domain";

// ─── cjson polyfill for ioredis-mock's Lua VM (fengari) ──────────────
// The mock's bundled Lua runtime does not ship Redis's `cjson`, which the
// PresenceService leave/cursor/sweep scripts rely on. This minimal pure-Lua
// decode/encode is sufficient for the flat `User` objects stored, so the REAL
// service scripts execute unmodified against the mock.
const CJSON_PRELUDE = `
if cjson == nil then
cjson = {}
do
  local parse_value
  local function skip_ws(str, idx)
    while idx <= #str do
      local c = string.sub(str, idx, idx)
      if c == ' ' or c == '\\t' or c == '\\n' or c == '\\r' then idx = idx + 1 else break end
    end
    return idx
  end
  local function parse_string(str, idx)
    local res = {}
    idx = idx + 1
    while idx <= #str do
      local c = string.sub(str, idx, idx)
      if c == '"' then return table.concat(res), idx + 1
      elseif c == '\\\\' then
        idx = idx + 1
        local e = string.sub(str, idx, idx)
        if e == 'n' then res[#res+1] = '\\n'
        elseif e == 't' then res[#res+1] = '\\t'
        elseif e == 'r' then res[#res+1] = '\\r'
        elseif e == 'u' then idx = idx + 4; res[#res+1] = '?'
        else res[#res+1] = e end
        idx = idx + 1
      else res[#res+1] = c; idx = idx + 1 end
    end
    error('unterminated string')
  end
  local function parse_number(str, idx)
    local start = idx
    while idx <= #str do
      local c = string.sub(str, idx, idx)
      if string.match(c, '[%d%.eE%+%-]') then idx = idx + 1 else break end
    end
    return tonumber(string.sub(str, start, idx - 1)), idx
  end
  local function parse_object(str, idx)
    local obj = {}
    idx = skip_ws(str, idx + 1)
    if string.sub(str, idx, idx) == '}' then return obj, idx + 1 end
    while true do
      idx = skip_ws(str, idx)
      local key; key, idx = parse_string(str, idx)
      idx = skip_ws(str, idx) + 1
      local val; val, idx = parse_value(str, idx)
      obj[key] = val
      idx = skip_ws(str, idx)
      local c = string.sub(str, idx, idx)
      if c == ',' then idx = idx + 1
      elseif c == '}' then return obj, idx + 1
      else error('expected , or }') end
    end
  end
  local function parse_array(str, idx)
    local arr = {}
    idx = skip_ws(str, idx + 1)
    if string.sub(str, idx, idx) == ']' then return arr, idx + 1 end
    local n = 0
    while true do
      local val; val, idx = parse_value(str, skip_ws(str, idx))
      n = n + 1; arr[n] = val
      idx = skip_ws(str, idx)
      local c = string.sub(str, idx, idx)
      if c == ',' then idx = idx + 1
      elseif c == ']' then return arr, idx + 1
      else error('expected , or ]') end
    end
  end
  parse_value = function(str, idx)
    idx = skip_ws(str, idx)
    local c = string.sub(str, idx, idx)
    if c == '{' then return parse_object(str, idx)
    elseif c == '[' then return parse_array(str, idx)
    elseif c == '"' then return parse_string(str, idx)
    elseif c == 't' then return true, idx + 4
    elseif c == 'f' then return false, idx + 5
    elseif c == 'n' then return nil, idx + 4
    else return parse_number(str, idx) end
  end
  function cjson.decode(s) local v = parse_value(s, 1); return v end
  function cjson.encode(v)
    local t = type(v)
    if t == 'table' then
      local parts = {}
      for k, val in pairs(v) do parts[#parts+1] = '"' .. tostring(k) .. '":' .. cjson.encode(val) end
      return '{' .. table.concat(parts, ',') .. '}'
    elseif t == 'string' then return '"' .. v .. '"'
    elseif t == 'number' then return tostring(v)
    elseif t == 'boolean' then return tostring(v)
    else return 'null' end
  end
end
end
`;

/** Build an `ioredis-mock` whose `eval` transparently prepends the cjson polyfill. */
export function makeMockRedis(): Redis {
  const redis = new RedisMock();
  const originalEval = redis.eval.bind(redis);
  (redis as unknown as { eval: (...a: unknown[]) => unknown }).eval = (
    script: string,
    ...rest: unknown[]
  ) => {
    const prepared = script.includes("cjson") ? `${CJSON_PRELUDE}\n${script}` : script;
    return originalEval(prepared, ...(rest as never[]));
  };
  return redis as unknown as Redis;
}

// ─── In-memory persistence fakes ─────────────────────────────────────

/** In-memory {@link StrokeRepository}: an append-only per-board stroke log. */
export class InMemoryStrokeRepository implements StrokeRepository {
  private readonly byBoard = new Map<string, PersistedStroke[]>();

  async insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void> {
    const log = this.byBoard.get(boardId) ?? [];
    const seen = new Set(log.map((s) => s.seq));
    for (const stroke of strokes) {
      if (!seen.has(stroke.seq)) {
        log.push({ ...stroke });
        seen.add(stroke.seq);
      }
    }
    log.sort((a, b) => a.seq - b.seq);
    this.byBoard.set(boardId, log);
  }

  async loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]> {
    const log = this.byBoard.get(boardId) ?? [];
    return log.filter((s) => s.seq > sinceSeq).map((s) => ({ ...s }));
  }

  async deleteThrough(boardId: string, throughSeq: number): Promise<void> {
    const log = this.byBoard.get(boardId) ?? [];
    this.byBoard.set(
      boardId,
      log.filter((s) => s.seq > throughSeq)
    );
  }

  async count(boardId: string): Promise<number> {
    return (this.byBoard.get(boardId) ?? []).length;
  }
}

/** In-memory {@link BoardRepository}: per-board snapshot baseline + metadata. */
export class InMemoryBoardRepository implements BoardRepository {
  private readonly snapshotSeq = new Map<string, number>();
  private readonly passwordHash = new Map<string, string | null>();

  async ensure(boardId: string): Promise<void> {
    if (!this.snapshotSeq.has(boardId)) {
      this.snapshotSeq.set(boardId, 0);
    }
  }

  async getSnapshotSeq(boardId: string): Promise<number> {
    return this.snapshotSeq.get(boardId) ?? 0;
  }

  async setSnapshot(boardId: string, seq: number): Promise<void> {
    this.snapshotSeq.set(boardId, seq);
  }

  async getPasswordHash(boardId: string): Promise<string | null> {
    return this.passwordHash.get(boardId) ?? null;
  }

  async touch(): Promise<void> {
    // no-op for the in-memory fake
  }
}

/** A no-op logger that satisfies the {@link Logger} surface (incl. `.child`). */
export function silentLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  logger.child = () => logger;
  return logger as unknown as Logger;
}

// ─── Test server harness ─────────────────────────────────────────────

export interface TestServer {
  /** Base URL a `socket.io-client` connects to. */
  url: string;
  io: Server;
  httpServer: http.Server;
  strokeService: StrokeService;
  presenceService: PresenceService;
  /** Tear down the io server + HTTP listener, resolving when fully closed. */
  close: () => Promise<void>;
}

/**
 * Build and start the production gateway over an ephemeral HTTP server. Returns
 * the bound URL plus the live services (so a test can synchronize on durable
 * state) and a `close` that releases every handle.
 */
export async function startTestServer(): Promise<TestServer> {
  const logger = silentLogger();
  const httpServer = http.createServer();
  const io = new Server(httpServer);

  const rooms = new RoomRepository();
  const roomService = new RoomService(io, rooms, 60 * 60 * 1000, logger);
  const presenceService = new PresenceService(makeMockRedis());
  const strokeService = new StrokeService({
    strokeRepository: new InMemoryStrokeRepository(),
    boardRepository: new InMemoryBoardRepository(),
    // Keep strokes in the write buffer for the duration of a test (no flush
    // fires); loadForJoin merges the buffer so a joiner still sees them, and the
    // behavior under test (ordering, history, resync) is unaffected.
    flushIntervalMs: 10_000,
    flushBatchSize: 10_000,
    logger,
  });

  // OPEN_MODE so no signed Join_Token is required; the gateway still runs the
  // full auth/dispatch path, it just always authorizes.
  const authGuard = createAuthGuard({
    secret: "integration-test-secret-integration-test-secret",
    openMode: true,
  });

  const deps: ConnectionDeps = {
    io,
    rooms,
    roomService,
    presenceService,
    strokeService,
    authGuard,
    logger,
  };

  // No redisClients → default in-memory adapter (single-process broadcast).
  registerGateway(io, deps);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind the test HTTP server to a port");
  }
  const url = `http://localhost:${address.port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  };

  return { url, io, httpServer, strokeService, presenceService, close };
}

// ─── socket.io-client helpers ────────────────────────────────────────

/** Connect a fresh `socket.io-client`, resolving once the handshake completes. */
export function connectClient(url: string): Promise<ClientSocket> {
  const socket = ioClient(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting socket.io-client"));
    }, 5000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolve with the payload of the first `event` emitted to `socket`. */
export function once<T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handler = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler as (...args: unknown[]) => void);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.once(event, handler as (...args: unknown[]) => void);
  });
}

/** Accumulate every `event` payload, with a `waitFor(count)` synchronizer. */
export function collect<T = unknown>(socket: ClientSocket, event: string) {
  const items: T[] = [];
  const waiters: Array<{ count: number; settle: () => void }> = [];

  socket.on(event, (payload: T) => {
    items.push(payload);
    for (const waiter of [...waiters]) {
      if (items.length >= waiter.count) {
        waiter.settle();
      }
    }
  });

  return {
    items,
    waitFor(count: number, timeoutMs = 5000): Promise<void> {
      if (items.length >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          count,
          settle: () => {
            clearTimeout(timer);
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            resolve();
          },
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(
            new Error(
              `Timed out waiting for ${count} "${event}" events; received ${items.length}`
            )
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

/** Poll `predicate` until truthy or the timeout elapses. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Emit `join-room` and resolve with the `room-history` the server returns. */
export async function joinRoom(
  socket: ClientSocket,
  roomId: string,
  username: string,
  sinceSeq?: number
): Promise<{ snapshot?: unknown; strokes: PersistedStroke[] }> {
  const history = once<{ snapshot?: unknown; strokes: PersistedStroke[] }>(
    socket,
    "room-history"
  );
  socket.emit("join-room", { roomId, username, sinceSeq });
  return history;
}

/** A valid stroke segment payload (passes DrawSchema) for a given seed. */
export function makeStroke(seed: number) {
  return {
    x0: seed,
    y0: seed + 1,
    x1: seed + 2,
    y1: seed + 3,
    color: "#3b82f6",
    width: 4,
  };
}
