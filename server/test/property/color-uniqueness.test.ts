import { describe, it, expect } from "vitest";
import fc from "fast-check";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";

import {
  PresenceService,
  COLOR_POOL_SIZE,
} from "../../src/services/presenceService";

// ─── Property 9: Color uniqueness across nodes ───────────────────────
//
// **Validates: Requirements 5.1**
//
// For any room with `n <= 20` present users, the cursor colors handed out by
// `PresenceService.allocateColor` are pairwise distinct — even when the users
// are spread across several Synapse_Server instances ("nodes") that share one
// Coordination_Store (Redis). The single source of cross-node coordination is
// the atomic `ALLOCATE_COLOR_LUA` test-and-set the service runs via `EVAL`, so
// the property exercises exactly that path.
//
// ─── Cross-node modeling ─────────────────────────────────────────────
// `ioredis-mock` instances share one process-global keyspace by default, so
// separate `new RedisMock()` clients faithfully model multiple PresenceService
// instances connecting to the *same* Redis: a write on one node is visible to
// every other node (verified before authoring this test). The mock executes
// the Lua `SISMEMBER`/`SADD`/`SCARD` ops the allocator relies on, so the atomic
// reservation is genuinely tested rather than stubbed.
//
// A fixed pool of node clients is built once and reused across runs: since the
// clients share the one keyspace and every run draws a *unique* room id, no
// color reservation can leak between runs (each run starts from an empty pool),
// while avoiding the cost — and EventEmitter listener growth — of constructing
// hundreds of mock clients.

/** The maximum number of simulated nodes any single run uses. */
const MAX_NODES = 5;

/** Fixed pool of PresenceService "nodes", each over its own mock client; all
 *  share the one process-global Redis keyspace (one Redis, many instances). */
const NODE_POOL: PresenceService[] = Array.from({ length: MAX_NODES }, () => {
  const client = new RedisMock() as unknown as Redis;
  return new PresenceService(client);
});

/** Monotonic room-id source: guarantees a fresh `room:{id}:colors` set per run
 *  despite the process-global mock keyspace shared across nodes. */
let roomCounter = 0;
const nextRoomId = (): string => `cross-node-room-${roomCounter++}`;

/**
 * A join scenario: `nodeCount` running instances and, for each of `n` present
 * users, the index of the node the user joins through. With `n <=
 * COLOR_POOL_SIZE` the pool is never exhausted, so all colors must be distinct
 * (Requirement 5.1). The per-user node index models users arriving in an
 * arbitrary order distributed arbitrarily across nodes.
 */
const scenarioArb = fc
  .record({
    nodeCount: fc.integer({ min: 1, max: MAX_NODES }),
    // n ≤ 20 present users (the cursor color pool size).
    userCount: fc.integer({ min: 0, max: COLOR_POOL_SIZE }),
  })
  .chain(({ nodeCount, userCount }) =>
    fc.record({
      nodeCount: fc.constant(nodeCount),
      // One node assignment per user → the per-user join ordering across nodes.
      assignments: fc.array(fc.integer({ min: 0, max: nodeCount - 1 }), {
        minLength: userCount,
        maxLength: userCount,
      }),
    })
  );

describe("Property 9: Color uniqueness across nodes", () => {
  it("assigns distinct cursor colors to all n <= 20 present users, even across simulated nodes (sequential join ordering)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ assignments }) => {
        const roomId = nextRoomId();

        const colors: string[] = [];
        for (const nodeIndex of assignments) {
          colors.push(await NODE_POOL[nodeIndex].allocateColor(roomId));
        }

        // n ≤ pool size ⇒ every assigned color is distinct.
        expect(new Set(colors).size).toBe(colors.length);
      }),
      { numRuns: 200 }
    );
  });

  it("assigns distinct cursor colors under concurrent cross-node allocation (atomicity of the EVAL test-and-set)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ assignments }) => {
        const roomId = nextRoomId();

        // All users race to allocate at once across their assigned nodes. The
        // Lua test-and-set must still hand each a distinct color.
        const colors = await Promise.all(
          assignments.map((nodeIndex) => NODE_POOL[nodeIndex].allocateColor(roomId))
        );

        expect(new Set(colors).size).toBe(colors.length);
      }),
      { numRuns: 200 }
    );
  });
});
