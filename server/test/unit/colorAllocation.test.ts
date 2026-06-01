import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";

import {
  PresenceService,
  CURSOR_COLORS,
  COLOR_POOL_SIZE,
} from "../../src/services/presenceService";
import type { User } from "../../src/types/domain";

// Unit tests for the Presence_Service cursor-color allocation (task 5.4).
//
// Validates: Requirements 5.1 (WHILE at most the 20-color pool size of users
// are present, a joining user is assigned a color distinct from every other
// present user, even across instances) and 5.5 (IF the pool size of 20 is
// reached, distinctness for an additional joining user is NOT guaranteed).
//
// The service's color allocation/release runs entirely inside server-side Lua
// scripts (eval). We back it with `ioredis-mock`, whose bundled Lua VM (fengari)
// does not ship Redis's `cjson` library, which `leave` relies on to decode the
// stored user. We therefore prepend a small pure-Lua `cjson` polyfill to every
// script so the REAL, unmodified service scripts execute against the mock — the
// allocation/release behaviour under test is exercised exactly as in production.

// ─── cjson polyfill (pure Lua) ───────────────────────────────────────
// Minimal JSON decode/encode sufficient for the flat `User` objects the
// service stores. `decode` yields a genuine Lua table so the service's
// `type(user) == 'table'` guard holds; `encode` is included for parity with
// the scripts that re-encode a user (cursor updates), unused by these tests.
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

/**
 * Build an `ioredis-mock` instance whose `eval` transparently prepends the
 * `cjson` polyfill, then cast to the `ioredis` `Redis` type the service expects.
 * Only `eval` is wrapped; every other command the service uses (hvals, smembers,
 * expire, …) is provided natively by the mock.
 */
function makeRedis(): Redis {
  const redis = new RedisMock();
  const originalEval = redis.eval.bind(redis);
  // The service always calls eval(script, numKeys, ...args). Only the scripts
  // that actually use cjson (leave / cursor / sweep) pay the prelude's
  // compile cost; allocateColor / join run unmodified to keep the VM light.
  (redis as unknown as { eval: (...a: unknown[]) => unknown }).eval = (
    script: string,
    ...rest: unknown[]
  ) => {
    const prepared = script.includes("cjson") ? `${CJSON_PRELUDE}\n${script}` : script;
    return originalEval(prepared, ...(rest as never[]));
  };
  return redis as unknown as Redis;
}

/** Construct a minimal present `User` for a given socket/color. */
function makeUser(socketId: string, cursorColor: string): User {
  return {
    socketId,
    userId: `user-${socketId}`,
    username: `name-${socketId}`,
    cursorColor,
    cursor: null,
  };
}

const ROOM = "room-colors";

describe("PresenceService.allocateColor — distinctness up to pool size (Req 5.1)", () => {
  let redis: Redis;
  let presence: PresenceService;

  // ioredis-mock shares one keyspace across all instances in a process, so the
  // store is flushed before each test to keep cases independent.
  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    presence = new PresenceService(redis);
  });

  it("allocates COLOR_POOL_SIZE distinct colors, all drawn from the pool", async () => {
    const allocated: string[] = [];
    for (let i = 0; i < COLOR_POOL_SIZE; i++) {
      // allocateColor atomically reserves the color in the in-use set, so
      // consecutive calls model consecutive joiners without a separate join.
      allocated.push(await presence.allocateColor(ROOM));
    }

    // Distinct: no color handed out twice while within the pool size.
    expect(new Set(allocated).size).toBe(COLOR_POOL_SIZE);
    // Every allocated color is a member of the defined pool.
    for (const color of allocated) {
      expect(CURSOR_COLORS).toContain(color);
    }
    // Together they exhaust exactly the pool (a permutation of it).
    expect([...allocated].sort()).toEqual([...CURSOR_COLORS].sort());
  });

  it("hands out the first unused pool color in order on an empty room", async () => {
    const first = await presence.allocateColor(ROOM);
    expect(first).toBe(CURSOR_COLORS[0]);

    // It is reserved atomically, so the next allocation must skip it.
    const second = await presence.allocateColor(ROOM);
    expect(second).toBe(CURSOR_COLORS[1]);
    expect(second).not.toBe(first);
  });

  it("keeps colors distinct across two independent service instances sharing the store", async () => {
    // Two PresenceService instances over the SAME backing store simulate two
    // Synapse_Server nodes; allocation is atomic so colors stay distinct.
    const presenceA = new PresenceService(redis);
    const presenceB = new PresenceService(redis);

    const seen = new Set<string>();
    for (let i = 0; i < COLOR_POOL_SIZE; i++) {
      const node = i % 2 === 0 ? presenceA : presenceB;
      const color = await node.allocateColor(ROOM);
      expect(seen.has(color)).toBe(false);
      seen.add(color);
    }
    expect(seen.size).toBe(COLOR_POOL_SIZE);
  });
});

describe("PresenceService.allocateColor — graceful behavior at/over pool capacity (Req 5.5)", () => {
  let redis: Redis;
  let presence: PresenceService;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    presence = new PresenceService(redis);
  });

  it("returns a valid pool color (no throw, no distinctness guarantee) once the pool is full", async () => {
    // Fill the pool: every color now reserved in the in-use set.
    for (let i = 0; i < COLOR_POOL_SIZE; i++) {
      await presence.allocateColor(ROOM);
    }

    // The (pool+1)-th allocation must still succeed gracefully.
    const overflow = await presence.allocateColor(ROOM);
    expect(typeof overflow).toBe("string");
    expect(CURSOR_COLORS).toContain(overflow);
    // It necessarily collides with an already-assigned color — that is allowed
    // past the pool size (Requirement 5.5 makes no distinctness guarantee).
  });

  it("never throws and always yields a pool color for several allocations beyond capacity", async () => {
    for (let i = 0; i < COLOR_POOL_SIZE; i++) {
      await presence.allocateColor(ROOM);
    }

    for (let i = 0; i < 5; i++) {
      const color = await presence.allocateColor(ROOM);
      expect(CURSOR_COLORS).toContain(color);
    }
  });
});

describe("PresenceService leave — releases a color back to the pool for reuse (Req 5.1)", () => {
  let redis: Redis;
  let presence: PresenceService;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    presence = new PresenceService(redis);
  });

  it("returns a leaver's color to the pool so the next joiner can reuse it", async () => {
    const first = await presence.allocateColor(ROOM);
    await presence.join(ROOM, makeUser("s0", first));

    const second = await presence.allocateColor(ROOM);
    await presence.join(ROOM, makeUser("s1", second));
    expect(second).not.toBe(first);

    // s0 leaves: their color is released.
    const remaining = await presence.leave(ROOM, "s0");
    expect(remaining.map((u) => u.socketId)).toEqual(["s1"]);

    // The next allocation reuses the freed color rather than advancing past it.
    const reused = await presence.allocateColor(ROOM);
    expect(reused).toBe(first);
  });

  it("frees a full pool by one on leave so a subsequent join is distinct again", async () => {
    const colors: string[] = [];
    for (let i = 0; i < COLOR_POOL_SIZE; i++) {
      const color = await presence.allocateColor(ROOM);
      await presence.join(ROOM, makeUser(`s${i}`, color));
      colors.push(color);
    }

    // Free one slot.
    await presence.leave(ROOM, "s0");

    // The newly-freed color is the only one available, so it is handed back and
    // is distinct from every still-present user's color.
    const next = await presence.allocateColor(ROOM);
    expect(next).toBe(colors[0]);
    expect(colors.slice(1)).not.toContain(next);
  });
});
