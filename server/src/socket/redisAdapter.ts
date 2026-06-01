// ─── Socket.IO Redis adapter wiring ──────────────────────────────────
// Bridges the Redis pub/sub connections (persistence/redis.ts) to Socket.IO so
// that `socket.to(roomId).emit(...)` reaches room members on every instance,
// not just the ones connected to the local process. With the adapter attached,
// the app tier is stateless: any instance can serve any room.
//
// This module only builds and attaches the adapter. The gateway (task 6.1) is
// responsible for calling `attachRedisAdapter` during server composition.
//
// Requirements: 5.2 (room broadcasts fan out to every member across instances),
// 5.3 (any instance can serve any room without instance-local board state).

import type { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { RedisClients } from "../persistence/redis";

/**
 * Build the Socket.IO Redis adapter factory from a pub/sub client pair.
 *
 * Returned value is the adapter constructor Socket.IO expects from
 * `io.adapter(...)`. Exposed separately from {@link attachRedisAdapter} so it
 * can be unit-tested and composed without a live `Server` instance.
 */
export function createRedisAdapter(clients: RedisClients) {
  return createAdapter(clients.pub, clients.sub);
}

/**
 * Attach the Redis adapter to an existing Socket.IO server so all room
 * broadcasts fan out through Redis to every instance.
 *
 * Idempotent from the caller's perspective: it simply replaces the default
 * in-memory adapter. Call once, before the server begins accepting traffic.
 */
export function attachRedisAdapter(io: Server, clients: RedisClients): void {
  io.adapter(createRedisAdapter(clients));
}
