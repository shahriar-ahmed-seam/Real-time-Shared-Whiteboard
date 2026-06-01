import { describe, it, expect } from "vitest";

import {
  createBucket,
  refill,
  consume,
  createSocketRateLimiter,
  DRAW_BUCKET,
  CURSOR_MOVE_BUCKET,
  type RateLimiter,
} from "../../src/middleware/rateLimiter";

// Unit tests for the token-bucket Rate_Limiter math (Requirements 2.3, 2.9).
//
// All tests inject an explicit `now` / clock so token accounting is fully
// deterministic and independent of wall-clock time.

const T0 = 1_000_000; // arbitrary fixed epoch-ms origin used as the start time.

// ─── refill: proportional to elapsed time, clamped to capacity ───────

describe("refill", () => {
  it("adds tokens proportional to the elapsed time at the configured rate", () => {
    // draw bucket: capacity 120, 120 tokens/sec. Drain to 0, then refill.
    const bucket = createBucket(DRAW_BUCKET, T0);
    bucket.tokens = 0;

    // 0.5s elapsed → 0.5 * 120 = 60 tokens.
    refill(bucket, T0 + 500);
    expect(bucket.tokens).toBeCloseTo(60, 10);

    // A further 0.25s → +30 tokens = 90.
    refill(bucket, T0 + 750);
    expect(bucket.tokens).toBeCloseTo(90, 10);
  });

  it("clamps the token count to capacity no matter how much time passes", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);
    bucket.tokens = 10;

    // 100s would add 12_000 tokens uncapped; must clamp at capacity 120.
    refill(bucket, T0 + 100_000);
    expect(bucket.tokens).toBe(DRAW_BUCKET.capacity);
    expect(bucket.tokens).toBe(120);
  });

  it("advances lastRefill to the supplied time", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);
    refill(bucket, T0 + 1234);
    expect(bucket.lastRefill).toBe(T0 + 1234);
  });

  it("treats a backwards clock as zero elapsed time (never loses or gains tokens)", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);
    bucket.tokens = 50;

    // now < lastRefill: elapsed floored at 0, tokens unchanged, lastRefill moves.
    refill(bucket, T0 - 5_000);
    expect(bucket.tokens).toBe(50);
    expect(bucket.lastRefill).toBe(T0 - 5_000);
  });

  it("keeps the token count within [0, capacity] for the cursor bucket as well", () => {
    const bucket = createBucket(CURSOR_MOVE_BUCKET, T0);
    bucket.tokens = 0;

    // 2s at 60/sec = 120 uncapped, clamps to cursor capacity 60.
    refill(bucket, T0 + 2_000);
    expect(bucket.tokens).toBe(CURSOR_MOVE_BUCKET.capacity);
    expect(bucket.tokens).toBe(60);
  });
});

// ─── Bucket configuration: draw vs cursor-move (Reqs 2.3, 2.9) ───────

describe("event bucket configuration", () => {
  it("configures the draw bucket with capacity 120 refilling 120/s", () => {
    expect(DRAW_BUCKET).toEqual({ capacity: 120, refillPerSec: 120 });
  });

  it("configures the cursor-move bucket with capacity 60 refilling 60/s", () => {
    expect(CURSOR_MOVE_BUCKET).toEqual({ capacity: 60, refillPerSec: 60 });
  });

  it("a fresh bucket starts full at its capacity", () => {
    expect(createBucket(DRAW_BUCKET, T0).tokens).toBe(120);
    expect(createBucket(CURSOR_MOVE_BUCKET, T0).tokens).toBe(60);
  });
});

// ─── consume: drain, drop-when-empty, and refill recovery ────────────

describe("consume", () => {
  it("permits exactly `capacity` events with no refill, then drops", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);

    // 120 consumes at the same instant (no time passes → no refill) all pass.
    for (let i = 0; i < 120; i++) {
      expect(consume(bucket, T0)).toBe(true);
    }
    // The 121st is dropped: bucket is empty.
    expect(consume(bucket, T0)).toBe(false);
    expect(bucket.tokens).toBeCloseTo(0, 10);
  });

  it("returns false without throwing when the bucket is empty", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);
    bucket.tokens = 0;

    expect(() => consume(bucket, T0)).not.toThrow();
    expect(consume(bucket, T0)).toBe(false);
    // A drop must not push tokens negative.
    expect(bucket.tokens).toBeGreaterThanOrEqual(0);
  });

  it("recovers capacity over elapsed time and then permits events again", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);
    // Drain the bucket.
    for (let i = 0; i < 120; i++) consume(bucket, T0);
    expect(consume(bucket, T0)).toBe(false);

    // After 1 full second the draw bucket has refilled its 120 tokens.
    expect(consume(bucket, T0 + 1_000)).toBe(true);
  });

  it("never lets the token count fall below zero or rise above capacity", () => {
    const bucket = createBucket(CURSOR_MOVE_BUCKET, T0);
    // Over-consume relative to availability; rejected consumes leave tokens intact.
    for (let i = 0; i < 200; i++) consume(bucket, T0);
    expect(bucket.tokens).toBeGreaterThanOrEqual(0);
    expect(bucket.tokens).toBeLessThanOrEqual(CURSOR_MOVE_BUCKET.capacity);
  });

  it("honors a custom cost and drops when the cost exceeds available tokens", () => {
    const bucket = createBucket(DRAW_BUCKET, T0);
    bucket.tokens = 5;

    // Cost larger than available → dropped, tokens untouched.
    expect(consume(bucket, T0, 10)).toBe(false);
    expect(bucket.tokens).toBe(5);

    // Cost exactly equal to available → allowed, drains to 0.
    expect(consume(bucket, T0, 5)).toBe(true);
    expect(bucket.tokens).toBeCloseTo(0, 10);
  });
});

// ─── Per-socket / per-event isolation via the factory ────────────────

describe("createSocketRateLimiter", () => {
  /** A controllable clock so the limiter's internal time is deterministic. */
  function fixedClock(initial: number): { limiter: RateLimiter; set: (t: number) => void } {
    let current = initial;
    const limiter = createSocketRateLimiter(() => current);
    return { limiter, set: (t: number) => (current = t) };
  }

  it("isolates buckets per socket: one flooded socket does not affect another", () => {
    const { limiter } = fixedClock(T0);

    // Drain socketA's draw bucket (capacity 120).
    for (let i = 0; i < 120; i++) {
      expect(limiter.tryConsume("draw:socketA")).toBe(true);
    }
    expect(limiter.tryConsume("draw:socketA")).toBe(false);

    // socketB is unaffected and still has a full draw bucket.
    expect(limiter.tryConsume("draw:socketB")).toBe(true);
  });

  it("isolates buckets per event: draining draw leaves cursor-move intact", () => {
    const { limiter } = fixedClock(T0);

    // Drain the draw bucket for a socket.
    for (let i = 0; i < 120; i++) limiter.tryConsume("draw:socketA");
    expect(limiter.tryConsume("draw:socketA")).toBe(false);

    // The same socket's cursor-move bucket (capacity 60) is independent.
    for (let i = 0; i < 60; i++) {
      expect(limiter.tryConsume("cursor-move:socketA")).toBe(true);
    }
    expect(limiter.tryConsume("cursor-move:socketA")).toBe(false);
  });

  it("refills a socket's bucket using the injected clock", () => {
    const { limiter, set } = fixedClock(T0);

    for (let i = 0; i < 60; i++) limiter.tryConsume("cursor-move:socketA");
    expect(limiter.tryConsume("cursor-move:socketA")).toBe(false);

    // Advance the clock 1s → cursor bucket refills 60 tokens.
    set(T0 + 1_000);
    expect(limiter.tryConsume("cursor-move:socketA")).toBe(true);
  });

  it("does not rate-limit unconfigured events (allows them through)", () => {
    const { limiter } = fixedClock(T0);
    for (let i = 0; i < 1_000; i++) {
      expect(limiter.tryConsume("join-room:socketA")).toBe(true);
    }
  });
});
