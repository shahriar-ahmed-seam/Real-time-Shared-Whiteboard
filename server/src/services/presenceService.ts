import type { Redis } from "ioredis";
import type { RoomData, User } from "../types/domain";

// ─── Presence service (Redis-backed, cross-node) ─────────────────────
// Tracks connected users and their cursor colors per room in the
// Coordination_Store (Redis) so presence is consistent across every
// Synapse_Server instance and survives a single node restart.
//
// Redis keyspace (see design "Redis keyspace"):
//   room:{id}:users    hash    socketId -> JSON-encoded User (presence list)
//   room:{id}:colors   set     cursor colors currently in use in the room
//   room:{id}:seen     zset    socketId -> last-seen epoch-ms score (TTL track)
//   presence:rooms     set     roomIds that currently hold presence (sweep set)
//
// Cursor-color allocation is the one operation that MUST be atomic across
// nodes: two users joining the same room on different instances must never
// be handed the same color while the pool (20 colors) is not exhausted. We
// achieve this with a single server-side Lua script that test-and-sets the
// first unused color from the pool in one atomic step (Requirement 5.1).
// Once the pool is exhausted, distinctness is no longer guaranteed
// (Requirement 5.5): the script returns a pool color without reserving it.
//
// ─── Stale-member expiry (Requirements 5.4, 5.6) ─────────────────────
// A connection that drops without a clean `disconnect` (a crashed node, a
// half-open socket) would otherwise linger in the presence hash forever.
// Redis hash fields cannot be given individual TTLs, so per-member liveness
// is tracked in a per-room sorted set (`room:{id}:seen`) whose score is the
// member's last-seen epoch-ms timestamp, refreshed on every activity
// (join / cursor update / heartbeat). A periodic {@link PresenceService.sweep}
// removes any member whose last-seen is older than {@link ttlSeconds} (≤30s)
// and returns the removed socketIds together with the updated member list, so
// the gateway can broadcast `users-update` to the remaining members.
//
// Requirements: 5.1 (distinct color per present user across instances, up to
// the 20-color pool size), 5.4 (unclean disconnects expire after a TTL of at
// most 30s), 5.5 (no distinctness guarantee beyond pool size), 5.6 (updated
// member list sent to remaining members when a stale entry is removed).

/** Visually distinct cursor color pool (20 colors). */
export const CURSOR_COLORS = [
  "#f43f5e", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#06b6d4", "#ec4899", "#14b8a6", "#ef4444", "#6366f1",
  "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9", "#e879f9",
  "#facc15", "#2dd4bf", "#fb923c", "#818cf8", "#34d399",
];

/** Size of the cursor color pool. */
export const COLOR_POOL_SIZE = CURSOR_COLORS.length;

/**
 * Hard upper bound on the presence TTL mandated by Requirement 5.4: an
 * unclean disconnect must expire after a time-to-live of at most 30 seconds.
 * Configured values are clamped to this ceiling.
 */
export const MAX_PRESENCE_TTL_SECONDS = 30;

/** Default per-member presence TTL, at the Requirement 5.4 ceiling. */
export const DEFAULT_PRESENCE_TTL_SECONDS = 30;

const usersKey = (roomId: string): string => `room:${roomId}:users`;
const colorsKey = (roomId: string): string => `room:${roomId}:colors`;
const seenKey = (roomId: string): string => `room:${roomId}:seen`;

/** Global set of rooms that currently hold presence (drives {@link sweep}). */
const ROOMS_KEY = "presence:rooms";

// ─── Lua scripts (atomic, server-side) ───────────────────────────────

/**
 * Atomically allocate a cursor color for a room.
 *   KEYS[1] = colors set key
 *   ARGV[*] = the cursor color pool
 * Returns the first pool color not already in the set, reserving it. When
 * every pool color is in use, returns a pool color WITHOUT reserving it, so
 * distinctness is not guaranteed past the pool size (Requirement 5.5).
 */
const ALLOCATE_COLOR_LUA = `
local colorsKey = KEYS[1]
for i = 1, #ARGV do
  if redis.call('SISMEMBER', colorsKey, ARGV[i]) == 0 then
    redis.call('SADD', colorsKey, ARGV[i])
    return ARGV[i]
  end
end
local n = redis.call('SCARD', colorsKey)
return ARGV[(n % #ARGV) + 1]
`;

/**
 * Register/replace a user's presence entry and return the updated member list.
 *   KEYS[1] = users hash, KEYS[2] = colors set,
 *   KEYS[3] = seen zset,   KEYS[4] = rooms set
 *   ARGV[1] = socketId, ARGV[2] = JSON User, ARGV[3] = cursorColor,
 *   ARGV[4] = now (epoch ms), ARGV[5] = roomId
 * The color is added to the in-use set defensively (idempotent) so the set
 * stays consistent even if the caller did not route through allocateColor.
 * The member's last-seen score is stamped and the room is registered for the
 * sweep so its stale entries can later be reaped (Requirement 5.4).
 */
const JOIN_LUA = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] ~= '' then
  redis.call('SADD', KEYS[2], ARGV[3])
end
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[5])
return redis.call('HVALS', KEYS[1])
`;

/**
 * Remove a user's presence entry, release their color, drop their last-seen
 * score, deregister the room when it becomes empty, and return the updated
 * member list.
 *   KEYS[1] = users hash, KEYS[2] = colors set,
 *   KEYS[3] = seen zset,   KEYS[4] = rooms set
 *   ARGV[1] = socketId, ARGV[2] = roomId
 */
const LEAVE_LUA = `
local json = redis.call('HGET', KEYS[1], ARGV[1])
if json then
  local ok, user = pcall(cjson.decode, json)
  if ok and type(user) == 'table' and user.cursorColor then
    redis.call('SREM', KEYS[2], user.cursorColor)
  end
  redis.call('HDEL', KEYS[1], ARGV[1])
end
redis.call('ZREM', KEYS[3], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[4], ARGV[2])
end
return redis.call('HVALS', KEYS[1])
`;

/**
 * Update a present user's cursor position in place and refresh their last-seen
 * score, leaving every other field untouched and doing nothing if the user is
 * no longer present.
 *   KEYS[1] = users hash, KEYS[2] = seen zset
 *   ARGV[1] = socketId, ARGV[2] = x, ARGV[3] = y, ARGV[4] = now (epoch ms)
 */
const UPDATE_CURSOR_LUA = `
local json = redis.call('HGET', KEYS[1], ARGV[1])
if not json then return 0 end
local ok, user = pcall(cjson.decode, json)
if not ok or type(user) ~= 'table' then return 0 end
user.cursor = { x = tonumber(ARGV[2]), y = tonumber(ARGV[3]) }
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(user))
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
return 1
`;

/**
 * Refresh a present member's last-seen score without otherwise touching their
 * entry. Used for liveness heartbeats so an idle-but-connected user is not
 * mistaken for a stale one. No-op if the user is not present.
 *   KEYS[1] = users hash, KEYS[2] = seen zset
 *   ARGV[1] = socketId, ARGV[2] = now (epoch ms)
 */
const HEARTBEAT_LUA = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;

/**
 * Reap every member of a room whose last-seen score is at or below the cutoff,
 * releasing each reaped member's color, deregistering the room when it empties,
 * and returning both the reaped socketIds and the surviving member list.
 *   KEYS[1] = users hash, KEYS[2] = colors set,
 *   KEYS[3] = seen zset,   KEYS[4] = rooms set
 *   ARGV[1] = cutoff (epoch ms), ARGV[2] = roomId
 * Returns: { [reaped socketIds...], [surviving JSON users...] }
 */
const SWEEP_LUA = `
local stale = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
for i = 1, #stale do
  local sid = stale[i]
  local json = redis.call('HGET', KEYS[1], sid)
  if json then
    local ok, user = pcall(cjson.decode, json)
    if ok and type(user) == 'table' and user.cursorColor then
      redis.call('SREM', KEYS[2], user.cursorColor)
    end
    redis.call('HDEL', KEYS[1], sid)
  end
  redis.call('ZREM', KEYS[3], sid)
end
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[4], ARGV[2])
end
return { stale, redis.call('HVALS', KEYS[1]) }
`;

export interface PresenceServiceOptions {
  /**
   * Per-member time-to-live in seconds for presence entries. A member whose
   * last-seen timestamp is older than this is reaped by {@link
   * PresenceService.sweep}, so a connection that drops without a clean
   * disconnect expires (Requirement 5.4). Clamped to (0,
   * {@link MAX_PRESENCE_TTL_SECONDS}]; defaults to
   * {@link DEFAULT_PRESENCE_TTL_SECONDS}.
   */
  ttlSeconds?: number;
}

/** Outcome of sweeping a single room for stale presence entries. */
export interface PresenceSweepResult {
  /** The room that was swept. */
  roomId: string;
  /** socketIds of members removed as stale (empty when nothing expired). */
  expired: string[];
  /** The remaining member list after stale entries were removed. */
  members: User[];
}

/**
 * Clamp a requested TTL to the valid range. Non-finite or non-positive values
 * fall back to the default; anything above the ceiling is capped so the
 * Requirement 5.4 "at most 30 seconds" bound can never be exceeded.
 */
function resolveTtlSeconds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PRESENCE_TTL_SECONDS;
  }
  return Math.min(requested, MAX_PRESENCE_TTL_SECONDS);
}

export class PresenceService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: Redis,
    options: PresenceServiceOptions = {}
  ) {
    this.ttlSeconds = resolveTtlSeconds(options.ttlSeconds);
  }

  /** The effective per-member presence TTL in seconds (≤ 30). */
  get presenceTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /**
   * Atomically allocate a distinct cursor color for a new member of the room.
   * Distinct from every other present user's color while at most
   * {@link COLOR_POOL_SIZE} users are present, even across instances. Past the
   * pool size, distinctness is not guaranteed (Requirement 5.5).
   */
  async allocateColor(roomId: string): Promise<string> {
    const result = await this.redis.eval(
      ALLOCATE_COLOR_LUA,
      1,
      colorsKey(roomId),
      ...CURSOR_COLORS
    );
    return String(result);
  }

  /**
   * Register a user as present in a room and return the updated member list.
   * The user's `cursorColor` should already have been obtained via
   * {@link allocateColor}; it is added to the in-use set idempotently. The
   * member's last-seen timestamp is stamped so the sweep can later expire it
   * if the connection drops uncleanly.
   */
  async join(roomId: string, user: User): Promise<User[]> {
    const result = await this.redis.eval(
      JOIN_LUA,
      4,
      usersKey(roomId),
      colorsKey(roomId),
      seenKey(roomId),
      ROOMS_KEY,
      user.socketId,
      JSON.stringify(user),
      user.cursorColor ?? "",
      Date.now(),
      roomId
    );
    await this.refreshTtl(roomId);
    return parseUsers(result);
  }

  /**
   * Remove a user's presence entry, release their color back to the pool, drop
   * their last-seen score, and return the updated member list.
   */
  async leave(roomId: string, socketId: string): Promise<User[]> {
    const result = await this.redis.eval(
      LEAVE_LUA,
      4,
      usersKey(roomId),
      colorsKey(roomId),
      seenKey(roomId),
      ROOMS_KEY,
      socketId,
      roomId
    );
    return parseUsers(result);
  }

  /**
   * Update a present user's live cursor position and refresh their last-seen
   * timestamp. No-op if the user is no longer present in the room.
   */
  async updateCursor(
    roomId: string,
    socketId: string,
    x: number,
    y: number
  ): Promise<void> {
    await this.redis.eval(
      UPDATE_CURSOR_LUA,
      2,
      usersKey(roomId),
      seenKey(roomId),
      socketId,
      x,
      y,
      Date.now()
    );
    await this.refreshTtl(roomId);
  }

  /**
   * Refresh a present member's liveness without changing any other state. The
   * gateway wires this to a periodic heartbeat (e.g. Socket.IO pings) so an
   * idle-but-connected user keeps their presence entry fresh and is not reaped
   * by {@link sweep}. Returns `true` when the member was present and refreshed.
   */
  async heartbeat(roomId: string, socketId: string): Promise<boolean> {
    const result = await this.redis.eval(
      HEARTBEAT_LUA,
      2,
      usersKey(roomId),
      seenKey(roomId),
      socketId,
      Date.now()
    );
    if (result === 1 || result === "1") {
      await this.refreshTtl(roomId);
      return true;
    }
    return false;
  }

  /** Return the current list of users present in a room. */
  async list(roomId: string): Promise<User[]> {
    const values = await this.redis.hvals(usersKey(roomId));
    return parseUsers(values);
  }

  /**
   * Reap stale members from a single room: any member whose last-seen
   * timestamp is older than {@link ttlSeconds} is removed and its color
   * released. Returns the removed socketIds and the surviving member list so
   * the gateway can broadcast the updated list to the remaining members
   * (Requirement 5.6).
   */
  async sweepRoom(roomId: string): Promise<PresenceSweepResult> {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    const result = await this.redis.eval(
      SWEEP_LUA,
      4,
      usersKey(roomId),
      colorsKey(roomId),
      seenKey(roomId),
      ROOMS_KEY,
      cutoff,
      roomId
    );
    return parseSweepResult(roomId, result);
  }

  /**
   * Reap stale members across every room that currently holds presence. The
   * gateway calls this periodically (at an interval smaller than the TTL so
   * total staleness stays within the ≤30s bound) and, for each returned room,
   * broadcasts the updated member list to that room's remaining members
   * (Requirements 5.4, 5.6). Only rooms that actually lost a member are
   * returned, so the caller broadcasts solely on real change.
   */
  async sweep(): Promise<PresenceSweepResult[]> {
    const roomIds = await this.redis.smembers(ROOMS_KEY);
    const results: PresenceSweepResult[] = [];
    for (const roomId of roomIds) {
      const result = await this.sweepRoom(roomId);
      if (result.expired.length > 0) {
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Refresh the whole-room key TTL as a backstop, so a room in which every
   * member has gone silent for longer than the TTL is reclaimed even if no
   * sweep runs (e.g. the last node crashes). Per-member expiry is driven by
   * the sorted-set sweep above; this only guards fully-idle rooms. A live
   * member's activity continually pushes the expiry out, so present members
   * are never reclaimed by this backstop.
   */
  private async refreshTtl(roomId: string): Promise<void> {
    await Promise.all([
      this.redis.expire(usersKey(roomId), this.ttlSeconds),
      this.redis.expire(colorsKey(roomId), this.ttlSeconds),
      this.redis.expire(seenKey(roomId), this.ttlSeconds),
    ]);
  }

  // ─── Legacy in-memory helper (prototype compatibility) ─────────────
  // The prototype's joinRoom handler still assigns colors from the in-memory
  // RoomData. This synchronous helper is retained so that handler keeps
  // compiling until it is rewritten to use the Redis-backed API above
  // (task 6.2). It does not touch Redis.
  /** @deprecated Use {@link allocateColor}; retained for the prototype handler. */
  pickCursorColor(room: RoomData): string {
    const usedColors = new Set(
      Array.from(room.users.values()).map((u) => u.cursorColor)
    );
    for (const c of CURSOR_COLORS) {
      if (!usedColors.has(c)) return c;
    }
    return `#${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
  }
}

/**
 * Parse a Lua `HVALS` result (array of JSON-encoded users) into `User`s,
 * skipping any malformed entries defensively.
 */
function parseUsers(raw: unknown): User[] {
  if (!Array.isArray(raw)) return [];
  const users: User[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    try {
      users.push(JSON.parse(value) as User);
    } catch {
      // Skip entries that are not valid JSON rather than failing the list.
    }
  }
  return users;
}

/**
 * Parse the {@link SWEEP_LUA} reply — a two-element array of `[reaped
 * socketIds, surviving JSON users]` — into a {@link PresenceSweepResult},
 * tolerating an unexpected shape by treating it as "nothing reaped".
 */
function parseSweepResult(roomId: string, raw: unknown): PresenceSweepResult {
  let expired: string[] = [];
  let members: User[] = [];
  if (Array.isArray(raw)) {
    const [staleRaw, hvalsRaw] = raw as [unknown, unknown];
    if (Array.isArray(staleRaw)) {
      expired = staleRaw.filter((v): v is string => typeof v === "string");
    }
    members = parseUsers(hvalsRaw);
  }
  return { roomId, expired, members };
}
