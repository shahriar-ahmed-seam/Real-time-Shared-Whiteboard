import http from "http";
import { Server } from "socket.io";

import { loadEnv } from "./config/env";
import { logger } from "./observability/logger";
import { Metrics } from "./observability/metrics";
import { createApp } from "./app";
import {
  databaseReadinessCheck,
  redisReadinessCheck,
  persistenceReadinessCheck,
  type ReadinessCheck,
} from "./observability/health";
import { initPool, closePool } from "./persistence/db";
import { createRedisClients, closeRedisClients } from "./persistence/redis";
import { PgBoardRepository } from "./repositories/boardRepository";
import { PgStrokeRepository } from "./repositories/strokeRepository";
import { createAuthGuard } from "./middleware/authGuard";
import { RoomRepository } from "./repositories/roomRepository";
import { RoomService } from "./services/roomService";
import { PresenceService } from "./services/presenceService";
import { StrokeService } from "./services/strokeService";
import { registerGateway } from "./socket/gateway";
import type { ConnectionDeps } from "./socket/context";
import { createAllowRequest, installPayloadSizeGuard } from "./socket/transport";

// ─── Composition root ────────────────────────────────────────────────
// Validates configuration, wires dependencies together, and starts the server.

// Fail fast on invalid/missing configuration BEFORE binding the port.
const env = loadEnv(process.env);

/** How long an empty room is retained before cleanup (ms). */
const ROOM_TTL_MS = 60 * 60 * 1000;

// In production, accept client connections only over encrypted transport
// (HTTPS / WSS) — Requirement 2.8.
const requireSecureTransport = env.NODE_ENV === "production";

// Datastore handles for the readiness probe (Requirements 6.4, 6.5). The pool
// connects lazily on first query, and the Redis clients connect eagerly; the
// `/readyz` checks (SELECT 1 / PING) confirm both are actually reachable.
const pool = initPool(env.DATABASE_URL);
const redis = createRedisClients(env.REDIS_URL, { logger });

const readinessChecks: ReadinessCheck[] = [
  databaseReadinessCheck(pool),
  // Coordination_Store (Redis) reachability (Requirements 6.4, 7.3). When Redis
  // is unavailable this probe fails so `/readyz` reports not-ready — yet the
  // server keeps serving members connected to THIS instance: room broadcasts
  // and presence degrade gracefully to single-node behavior (the gateway falls
  // back to local fan-out and presence may go stale), so no behavior changes
  // beyond the readiness signal. Readiness flips back to ready once Redis is
  // reachable again.
  redisReadinessCheck(redis.pub),
];
// Note: the persistence degraded-readiness check (Requirement 7.6) is appended
// below, once `strokeService` exists. `createApp` holds this same array by
// reference and `evaluateReadiness` reads it live on each `/readyz` request, so
// appending after construction is sufficient.

// Auth_Guard issues the short-lived, room-scoped Join_Token; it closes over
// JWT_SECRET / OPEN_MODE so the join endpoint never handles the secret directly.
const authGuard = createAuthGuard({
  secret: env.JWT_SECRET,
  openMode: env.OPEN_MODE,
});

// Durable board metadata access for the join endpoint's password gate
// (Requirement 2.7).
const boardRepository = new PgBoardRepository();

// Runtime telemetry (Requirement 6.2). Exposed via `GET /metrics`, restricted
// to internal/private callers (Requirements 6.6, 6.7). The gateway/handlers
// record connection, room, stroke, and error events into this handle.
const metrics = new Metrics();

const app = createApp(env.CLIENT_ORIGINS, {
  requireSecureTransport,
  readinessChecks,
  // Wire the join-token endpoint (POST /api/rooms/:id/join): validate the
  // optional room password against the stored hash and issue a room-scoped JWT.
  joinTokenConfig: {
    boardRepository,
    signToken: (claims, options) => authGuard.sign(claims, options),
  },
  // Expose Prometheus metrics at GET /metrics, restricted to internal/private
  // network addresses (loopback / RFC1918 / ULA / link-local) so the endpoint
  // is reachable by an in-cluster scrape target but denied to outside callers.
  metricsConfig: { metrics },
});
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: env.CLIENT_ORIGINS,
    methods: ["GET", "POST"],
  },
  // Cap inbound payloads at the configured maximum message size (default
  // 16 KiB). Socket.IO closes the connection for frames larger than this;
  // a per-connection guard (see gateway) emits a graceful invalid-payload
  // error for oversized application events — Requirement 2.6.
  maxHttpBufferSize: env.MAX_MESSAGE_BYTES,
  // Reject handshakes whose Origin is not allowlisted (2.5) and, in
  // production, whose transport is not encrypted (2.8), before any room
  // event is processed.
  allowRequest: createAllowRequest({
    allowlist: env.CLIENT_ORIGINS,
    requireSecureTransport,
    logger,
  }),
});

// Dependencies
const rooms = new RoomRepository();
const roomService = new RoomService(io, rooms, ROOM_TTL_MS, logger);
// Redis-backed, cross-node presence (Coordination_Store). Reuses the `pub`
// client already created for the readiness probe; the `sub` connection is
// reserved for the Socket.IO Redis adapter (attached by the gateway below).
const presenceService = new PresenceService(redis.pub);

// Durable stroke history + ordering. Assigns gap-free Sequence_Numbers, buffers
// writes behind a size/interval-bounded flush, and serves the snapshot + tail
// history a (re)joining client needs (Requirements 3.1, 3.2, 3.5). Reuses the
// board repository already constructed for the join endpoint's password gate.
const strokeRepository = new PgStrokeRepository(pool);
const strokeService = new StrokeService({
  strokeRepository,
  boardRepository,
  flushIntervalMs: env.FLUSH_INTERVAL_MS,
  flushBatchSize: env.FLUSH_BATCH_SIZE,
  logger,
});

// Persistence_Store degraded-readiness (Requirement 7.6). This is NOT a
// reachability probe — `databaseReadinessCheck` above already covers that —
// but a process-internal health flag: when a board's write-retry budget is
// exhausted, the strokes stay buffered with the durable-persistence ack
// withheld and `isPersistenceHealthy()` returns false, so `/readyz` reports
// not-ready until a later flush succeeds. Appended to the same array `createApp`
// already holds by reference (read live per `/readyz` request).
readinessChecks.push(persistenceReadinessCheck(strokeService));

const deps: ConnectionDeps = {
  io,
  rooms,
  roomService,
  presenceService,
  strokeService,
  authGuard,
  logger,
};

// Install the per-connection oversized-payload guard before handlers are
// registered so it intercepts every inbound event: oversized application
// payloads are dropped with an invalid-payload error and board state is left
// unchanged, while the connection stays open — Requirement 2.6.
io.on("connection", (socket) => {
  installPayloadSizeGuard(socket, env.MAX_MESSAGE_BYTES, logger);
});

// Attach the Socket.IO Redis adapter (via the gateway) so room broadcasts fan
// out across every instance and any instance can serve any room with no
// instance-local board state — Requirements 5.2, 5.3.
registerGateway(io, deps, { redisClients: redis });

// ─── Start ───────────────────────────────────────────────────────────
server.listen(env.PORT, () => {
  logger.info(`\nSynapse server listening on http://localhost:${env.PORT}\n`);
});

// ─── Graceful_Shutdown (Requirements 7.1, 7.5, 3.2) ───────────────────
// On a termination signal, run an orderly shutdown bounded by a hard 30s
// budget:
//   1. Stop accepting new connections (server.close — stops the HTTP listener;
//      io.close also closes the Engine.IO transport and the underlying server).
//   2. Flush ALL buffered strokes to the Persistence_Store so no accepted
//      stroke is lost on a deploy (Requirement 3.2).
//   3. Close active socket connections (io.close disconnects every socket and
//      closes the adapter).
//   4. Release datastore connections (Postgres pool + Redis pub/sub).
//
// If the sequence does not finish within SHUTDOWN_TIMEOUT_MS, the process is
// force-terminated. Because the per-board flush returns unpersisted strokes to
// the in-memory write buffer on failure, any strokes still unflushed at a
// forced exit remain retained for recovery on restart (Requirement 7.5) — the
// timeout never discards them.

/** Hard ceiling for the orderly shutdown sequence (Requirement 7.1). */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/** Guards against a second signal (or a signal during shutdown) re-entering. */
let shuttingDown = false;

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  // Idempotent: a repeated/duplicate signal while we are already winding down
  // must not start the sequence again.
  if (shuttingDown) {
    logger.warn(`Received ${signal} during shutdown; already shutting down.`);
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}; starting graceful shutdown (budget ${SHUTDOWN_TIMEOUT_MS}ms).`);

  // Force-termination timer: if the orderly sequence overruns the budget, exit
  // non-zero. Unflushed strokes remain in the StrokeService write buffer (flush
  // re-buffers on failure), so they are retained for recovery on restart.
  const forceTimer = setTimeout(() => {
    logger.error(
      `Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing termination. ` +
        `Unflushed strokes are retained in the write buffer for recovery on restart.`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Do not let the timer itself keep the event loop alive once everything else
  // has settled.
  forceTimer.unref?.();

  try {
    // 1. Stop accepting new HTTP connections (existing keep-alive sockets are
    //    closed by io.close below). Resolve even if the server was never
    //    listening.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // 2. Flush every board's buffered strokes before tearing connections down,
    //    so nothing accepted is lost on deploy (Requirement 3.2).
    try {
      await strokeService.flushAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Retained in the write buffer for recovery; surface but keep shutting
      // down so datastore connections are still released.
      logger.error(`Failed to flush buffered strokes during shutdown: ${message}`);
    }

    // 3. Close active socket connections and the Socket.IO adapter (this also
    //    closes the Engine.IO layer and the underlying HTTP server).
    await io.close();

    // 4. Release datastore connections (Postgres pool + Redis pub/sub).
    await Promise.allSettled([closePool(), closeRedisClients(redis)]);

    clearTimeout(forceTimer);
    logger.info("Graceful shutdown complete.");
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Error during graceful shutdown: ${message}`);
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on("SIGTERM", (signal) => void gracefulShutdown(signal));
process.on("SIGINT", (signal) => void gracefulShutdown(signal));

// ─── Process-level safety net (Requirement 7.4) ───────────────────────
// The gateway wraps every socket event listener so a handler's synchronous
// throw or rejected promise is caught, logged with connection/room correlation
// ids, and discarded without crashing the process. These process-level
// listeners are the last line of defense for a truly unexpected error that
// escapes that path (e.g. a fire-and-forget callback): log it with error
// context and keep the process — and every live connection — running, rather
// than letting Node's default handler terminate the process. The orderly
// SIGTERM/SIGINT shutdown above is unaffected.
process.on("uncaughtException", (err) => {
  logger.error(
    { event: "uncaughtException", err: err.message, stack: err.stack },
    `Uncaught exception; process kept alive: ${err.message}`,
  );
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error(
    { event: "unhandledRejection", err: message, stack },
    `Unhandled promise rejection; process kept alive: ${message}`,
  );
});
