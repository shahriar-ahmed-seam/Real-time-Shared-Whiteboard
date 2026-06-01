// ─── HTTP token-bucket rate limiter (per client) ─────────────────────
//
// An Express middleware that bounds the request rate of an HTTP endpoint per
// client, reusing the pure token-bucket primitives that back the socket
// Rate_Limiter (`createBucket` / `consume`) so the token math is shared and
// already unit-tested. One bucket is held per client key (the client IP by
// default); when a client's bucket is empty the request is rejected with
// HTTP 429 and a machine-readable error body, and no exception is thrown.
//
// This guards the join-token endpoint (`POST /api/rooms/:id/join`) against
// brute-forcing room passwords and against token-issuance floods — part of
// Requirement 2.7's defense posture (the join endpoint "is rate-limited").

import type { Request, Response, NextFunction, RequestHandler } from "express";

import { createBucket, consume, type BucketConfig, type TokenBucket } from "./rateLimiter";

/** Error code returned in the body when a request is rate-limited. */
export const RATE_LIMITED_CODE = "RATE_LIMITED";

/**
 * Default bucket for the join endpoint: a burst of 10 requests, refilling at
 * 1 request/second. Generous enough for legitimate join/retry flows yet tight
 * enough to blunt password brute-forcing.
 */
export const DEFAULT_JOIN_RATE_LIMIT: BucketConfig = {
  capacity: 10,
  refillPerSec: 1,
};

export interface HttpRateLimiterOptions {
  /** Token-bucket capacity / refill rate. Defaults to {@link DEFAULT_JOIN_RATE_LIMIT}. */
  bucket?: BucketConfig;
  /**
   * Derive the bucket key from a request. Defaults to the client IP so each
   * caller is limited independently. Falls back to a shared key when no IP is
   * resolvable so a missing address still cannot bypass the limit.
   */
  keyOf?: (req: Request) => string;
  /** Time source (epoch ms); injectable for deterministic tests. */
  clock?: () => number;
}

/** Resolve the client key from the request IP, with a safe shared fallback. */
function defaultKeyOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Build an Express rate-limiting middleware backed by a per-key token bucket.
 *
 * Buckets are created lazily on first sight of a key and retained in-process.
 * On an empty bucket the middleware responds `429 Too Many Requests` with a
 * `{ code, message }` body and does NOT call `next()`, so the protected
 * handler never runs. Never throws for ordinary rate-limit rejection.
 */
export function createHttpRateLimiter(
  options: HttpRateLimiterOptions = {}
): RequestHandler {
  const config = options.bucket ?? DEFAULT_JOIN_RATE_LIMIT;
  const keyOf = options.keyOf ?? defaultKeyOf;
  const clock = options.clock ?? Date.now;

  const buckets = new Map<string, TokenBucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyOf(req);
    const now = clock();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createBucket(config, now);
      buckets.set(key, bucket);
    }

    if (consume(bucket, now)) {
      next();
      return;
    }

    res.status(429).json({
      code: RATE_LIMITED_CODE,
      message: "Too many requests; please retry shortly",
    });
  };
}
