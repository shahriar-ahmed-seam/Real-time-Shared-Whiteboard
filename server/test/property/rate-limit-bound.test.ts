import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  createBucket,
  consume,
  DRAW_BUCKET,
  CURSOR_MOVE_BUCKET,
  createSocketRateLimiter,
  type BucketConfig,
} from "../../src/middleware/rateLimiter";

/**
 * Property 5: Rate-limit bound (Requirement 2.3)
 *
 * For a token bucket of capacity `C` refilling at `R` tokens/second, the
 * number of *allowed* events whose timestamps fall in any time window of
 * length `w` seconds must never exceed `C + R·w`, and the bucket's token
 * count must always remain within `[0, C]`.
 *
 * The arrival pattern is modeled as an array of non-negative inter-arrival
 * deltas (milliseconds). Each delta advances a monotonic clock; an event is
 * attempted at the resulting timestamp. Because allowed events are produced
 * in non-decreasing time order, the strongest test of "any window" is to
 * check every window bounded by a pair of allowed-event timestamps: shrinking
 * a window to its first/last contained event preserves the event count while
 * only tightening the `C + R·w` bound. Hence checking all such pairs implies
 * the bound for every possible window.
 *
 * **Validates: Requirements 2.3**
 */

// Allowed-event counts are integers while the bound `C + R·w` is real; a small
// epsilon absorbs floating-point error in the window arithmetic. Real
// violations would exceed the bound by a whole event (>= 1), far above EPS.
const EPS = 1e-6;

/** Arbitrary token-bucket configuration, mixing arbitrary configs with the
 *  two configured production buckets (draw 120/120, cursor-move 60/60). */
const configArb: fc.Arbitrary<BucketConfig> = fc.oneof(
  fc.record({
    capacity: fc.integer({ min: 1, max: 200 }),
    refillPerSec: fc.integer({ min: 1, max: 200 }),
  }),
  fc.constantFrom(DRAW_BUCKET, CURSOR_MOVE_BUCKET)
);

/** Arbitrary arrival pattern: inter-arrival deltas in milliseconds. A 0 delta
 *  models a burst (multiple events at the same instant); large deltas model
 *  idle gaps during which the bucket refills. */
const deltasArb: fc.Arbitrary<number[]> = fc.array(
  fc.integer({ min: 0, max: 1500 }),
  { maxLength: 200 }
);

/**
 * Replay an arrival pattern against a fresh, full bucket and return the
 * timestamps of the events that were allowed. Asserts the token invariant
 * `0 <= tokens <= capacity` after every operation.
 */
function replay(config: BucketConfig, deltas: number[]): number[] {
  const base = 0;
  const bucket = createBucket(config, base);
  let now = base;
  const allowedTimes: number[] = [];

  for (const delta of deltas) {
    now += delta;
    const allowed = consume(bucket, now, 1);

    // Token invariant: count never leaves [0, capacity].
    expect(bucket.tokens).toBeGreaterThanOrEqual(-EPS);
    expect(bucket.tokens).toBeLessThanOrEqual(config.capacity + EPS);

    if (allowed) {
      allowedTimes.push(now);
    }
  }

  return allowedTimes;
}

/**
 * Assert the window bound over every pair of allowed-event timestamps.
 * `allowedTimes` is non-decreasing, so the number of allowed events in the
 * window `[allowedTimes[i], allowedTimes[j]]` is exactly `j - i + 1`.
 */
function assertWindowBound(config: BucketConfig, allowedTimes: number[]): void {
  for (let i = 0; i < allowedTimes.length; i++) {
    for (let j = i; j < allowedTimes.length; j++) {
      const windowSeconds = (allowedTimes[j] - allowedTimes[i]) / 1000;
      const count = j - i + 1;
      const bound = config.capacity + config.refillPerSec * windowSeconds;
      expect(count).toBeLessThanOrEqual(bound + EPS);
    }
  }
}

describe("Property 5: Rate-limit bound", () => {
  it("pure token bucket: allowed events in any window w never exceed capacity + refillPerSec·w, and 0 <= tokens <= capacity", () => {
    fc.assert(
      fc.property(configArb, deltasArb, (config, deltas) => {
        const allowedTimes = replay(config, deltas);
        assertWindowBound(config, allowedTimes);
      }),
      { numRuns: 200 }
    );
  });

  it("createSocketRateLimiter (draw + cursor-move buckets): allowed events in any window w never exceed capacity + refillPerSec·w", () => {
    const cases: ReadonlyArray<{ event: string; config: BucketConfig }> = [
      { event: "draw", config: DRAW_BUCKET },
      { event: "cursor-move", config: CURSOR_MOVE_BUCKET },
    ];

    for (const { event, config } of cases) {
      fc.assert(
        fc.property(deltasArb, (deltas) => {
          let now = 0;
          const clock = () => now;
          const limiter = createSocketRateLimiter(clock);
          const key = `${event}:socket-1`;
          const allowedTimes: number[] = [];

          for (const delta of deltas) {
            now += delta;
            if (limiter.tryConsume(key)) {
              allowedTimes.push(now);
            }
          }

          assertWindowBound(config, allowedTimes);
        }),
        { numRuns: 200 }
      );
    }
  });
});
