// ─── Rate_Limiter (token bucket per socket per event) ────────────────
//
// Bounds the rate of high-frequency socket events (`draw`, `cursor-move`)
// per connection so a single client cannot flood the server (the
// unbounded-push DoS vector). Implements the token-bucket algorithm from
// the design pseudocode.
//
// Design contract (Requirements 2.3, 2.4, 2.9):
//   - `draw`        : capacity 120 tokens, refilling 120 tokens/second.
//   - `cursor-move` : capacity  60 tokens, refilling  60 tokens/second.
//   - A bucket's token count is always kept within [0, capacity].
//   - When the bucket is empty the event is dropped (tryConsume returns
//     false); the caller drops the event and keeps the connection open.
//     No exception is thrown for ordinary rate-limit rejection.
//
// The module is structured in two layers so the token math is pure and
// trivially testable in isolation from Socket.IO:
//   1. A pure token-bucket data structure + pure `consume`/`refill`
//      functions that take an explicit `now` (epoch ms).
//   2. A `RateLimiter` class (and per-socket factory) that holds buckets
//      keyed by event and exposes the design's `tryConsume(key, cost?)`.

// ─── Pure token-bucket primitives ────────────────────────────────────

/** Static configuration for a single token bucket. */
export interface BucketConfig {
  /** Maximum number of tokens the bucket can hold. Must be > 0. */
  readonly capacity: number;
  /** Tokens added per second of elapsed time. Must be > 0. */
  readonly refillPerSec: number;
}

/** Mutable runtime state of a single token bucket. */
export interface TokenBucket {
  /** Current token count; always kept within [0, capacity]. */
  tokens: number;
  /** Epoch milliseconds of the last refill computation. */
  lastRefill: number;
  /** Maximum token count (mirrors {@link BucketConfig.capacity}). */
  readonly capacity: number;
  /** Refill rate in tokens per second (mirrors {@link BucketConfig.refillPerSec}). */
  readonly refillPerSec: number;
}

/**
 * Create a new, full token bucket from a config.
 *
 * @param config Capacity and refill rate.
 * @param now    Current time (epoch ms). Injectable for deterministic tests.
 */
export function createBucket(config: BucketConfig, now: number = Date.now()): TokenBucket {
  return {
    tokens: config.capacity,
    lastRefill: now,
    capacity: config.capacity,
    refillPerSec: config.refillPerSec,
  };
}

/**
 * Refill a bucket based on the time elapsed since its last refill, clamped
 * so the token count never exceeds `capacity`. Mutates and returns the
 * bucket. Elapsed time is floored at zero so a backwards clock can never
 * push the token count out of the [0, capacity] range.
 */
export function refill(bucket: TokenBucket, now: number): TokenBucket {
  const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * bucket.refillPerSec);
  bucket.lastRefill = now;
  return bucket;
}

/**
 * Attempt to consume `cost` tokens from a bucket, refilling first based on
 * elapsed time. Implements the design `tryConsume` pseudocode.
 *
 * Preconditions: `cost > 0`, `capacity > 0`, `refillPerSec > 0`.
 * Postconditions: returns `true` at most `capacity` times within any window
 * before refill catches up; `tokens` never exceeds `capacity` nor drops
 * below 0. Never throws.
 *
 * @returns `true` if the tokens were available and consumed, otherwise
 *          `false` (the bucket was empty / under-supplied — drop the event).
 */
export function consume(bucket: TokenBucket, now: number = Date.now(), cost: number = 1): boolean {
  refill(bucket, now);

  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    return true;
  }
  return false;
}

// ─── Event bucket configuration ──────────────────────────────────────

/** The high-frequency socket events that are rate-limited per connection. */
export type RateLimitedEvent = "draw" | "cursor-move";

/** Token bucket for `draw` events: capacity 120, refill 120/s (Requirement 2.3). */
export const DRAW_BUCKET: BucketConfig = { capacity: 120, refillPerSec: 120 };

/** Token bucket for `cursor-move` events: capacity 60, refill 60/s (Requirement 2.9). */
export const CURSOR_MOVE_BUCKET: BucketConfig = { capacity: 60, refillPerSec: 60 };

/** Per-event bucket configuration, keyed by event name. */
export const EVENT_BUCKET_CONFIGS: Readonly<Record<RateLimitedEvent, BucketConfig>> = {
  "draw": DRAW_BUCKET,
  "cursor-move": CURSOR_MOVE_BUCKET,
};

// ─── RateLimiter ─────────────────────────────────────────────────────

/**
 * Bounds the rate of high-frequency events. A `key` identifies the bucket;
 * by convention it is `"<event>:<socketId>"` (e.g. `"draw:abc123"`) or just
 * the bare event name. The event prefix selects the bucket configuration.
 *
 * Matches the design service interface so handlers can depend on the
 * abstraction rather than the concrete implementation.
 */
export interface RateLimiter {
  /**
   * Try to consume `cost` tokens (default 1) from the bucket for `key`.
   * @returns `true` when allowed, `false` when the bucket is empty (drop).
   */
  tryConsume(key: string, cost?: number): boolean;
}

/**
 * Extract the rate-limited event name from a bucket key of the form
 * `"<event>:<socketId>"` (or a bare event name). Socket.IO ids are URL-safe
 * base64 and contain no colon, so splitting on the first colon is safe.
 */
function eventFromKey(key: string): string {
  const sep = key.indexOf(":");
  return sep === -1 ? key : key.slice(0, sep);
}

/**
 * Token-bucket rate limiter holding one bucket per distinct key, with the
 * bucket configuration resolved from the key's event prefix.
 *
 * A fresh instance is created per connection (see {@link createSocketRateLimiter}),
 * so buckets are naturally scoped per socket per event. The class works
 * equally well as a shared limiter because each full key (`event:socketId`)
 * maps to its own bucket.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  /**
   * @param clock Time source (epoch ms). Injectable for deterministic tests;
   *              defaults to {@link Date.now}.
   */
  constructor(private readonly clock: () => number = Date.now) {}

  tryConsume(key: string, cost: number = 1): boolean {
    const event = eventFromKey(key);
    const config = EVENT_BUCKET_CONFIGS[event as RateLimitedEvent];

    // Unknown / unconfigured events are not rate-limited: only `draw` and
    // `cursor-move` are bounded per the requirements. Allow them through.
    if (!config) {
      return true;
    }

    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = createBucket(config, now);
      this.buckets.set(key, bucket);
    }

    return consume(bucket, now, cost);
  }
}

/**
 * Factory for a per-socket rate limiter pre-configured with the `draw` and
 * `cursor-move` event buckets. Call once per connection and consume with
 * keys like `` `draw:${socket.id}` `` and `` `cursor-move:${socket.id}` ``.
 *
 * @param clock Optional time source for deterministic tests.
 */
export function createSocketRateLimiter(clock: () => number = Date.now): RateLimiter {
  return new TokenBucketRateLimiter(clock);
}
