// ─── Redis clients (Coordination_Store) ──────────────────────────────
// Builds the Redis connections used for horizontal scaling. The Socket.IO
// Redis adapter requires a dedicated publisher and subscriber connection (a
// subscriber connection is placed into subscribe mode and can no longer issue
// ordinary commands), so this module creates a `pub` client and a duplicated
// `sub` client from the validated REDIS_URL.
//
// These connections let any Synapse_Server instance fan out room broadcasts to
// every other instance through Redis pub/sub, so no instance holds instance-
// local board state.
//
// Requirements: 5.2 (broadcast fan-out across instances via the Coordination_
// Store), 5.3 (any instance can serve any room — no instance-local state).

import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "../observability/logger";

/**
 * The pair of Redis connections required by the Socket.IO Redis adapter.
 *
 * - `pub` issues `PUBLISH` commands (and ordinary commands the app may need).
 * - `sub` is the subscriber connection the adapter places into subscribe mode.
 */
export interface RedisClients {
  pub: Redis;
  sub: Redis;
}

export interface CreateRedisClientsDeps {
  /** Optional logger; connection errors are reported here when provided. */
  logger?: Pick<Logger, "error" | "info">;
  /** Extra ioredis options merged over the defaults (e.g. for tests). */
  options?: RedisOptions;
}

/**
 * ioredis defaults tuned for an adapter pub/sub workload:
 * - `maxRetriesPerRequest: null` so commands queue (rather than fail fast)
 *   while a connection is briefly re-establishing — broadcasts shouldn't throw
 *   during a transient Redis blip.
 * - `enableReadyCheck: true` so the client reports ready only once Redis is
 *   actually serving, which the readiness probe depends on.
 */
const DEFAULT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
};

/**
 * Attach an `error` listener so a transient connection error never surfaces as
 * an unhandled `error` event (which would crash the Node process). Connection
 * recovery itself is handled by ioredis' built-in reconnection.
 */
function wireErrorLogging(
  client: Redis,
  role: "pub" | "sub",
  logger?: Pick<Logger, "error">
): void {
  client.on("error", (err: Error) => {
    logger?.error(`Redis ${role} client error: ${err.message}`);
  });
}

/**
 * Build the publisher/subscriber Redis connections from REDIS_URL.
 *
 * The subscriber is created with `pub.duplicate()` so both share identical
 * connection settings while remaining independent sockets, as the Socket.IO
 * Redis adapter requires.
 */
export function createRedisClients(
  redisUrl: string,
  deps: CreateRedisClientsDeps = {}
): RedisClients {
  const options: RedisOptions = { ...DEFAULT_OPTIONS, ...deps.options };

  const pub = new Redis(redisUrl, options);
  const sub = pub.duplicate();

  wireErrorLogging(pub, "pub", deps.logger);
  wireErrorLogging(sub, "sub", deps.logger);

  return { pub, sub };
}

/**
 * Gracefully close both Redis connections. Used during Graceful_Shutdown to
 * release datastore connections. Falls back to `disconnect()` if a `quit()`
 * times out or rejects so shutdown can never hang on Redis.
 */
export async function closeRedisClients(clients: RedisClients): Promise<void> {
  await Promise.all(
    [clients.pub, clients.sub].map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    })
  );
}
