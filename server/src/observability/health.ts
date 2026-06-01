// ─── Liveness & readiness checks (Observability) ─────────────────────
// Pure, dependency-agnostic readiness evaluation used by the HTTP probes in
// `app.ts`. Liveness (`/healthz`) is intentionally trivial — it must answer
// success quickly regardless of datastore reachability — so it lives inline in
// the route. Readiness (`/readyz`) probes external dependencies (the
// Persistence_Store and the Coordination_Store) with a bounded time budget and
// reports which dependency failed when not ready.
//
// The check list is generic: each dependency contributes a named probe that
// resolves when healthy and rejects (or times out) when not. This keeps the
// readiness route additive and lets later work append further conditions
// (e.g. a "write retries exhausted" degraded-readiness flag) without touching
// the route itself.
//
// Requirements:
//   6.3 — liveness responds success within 1s regardless of datastore reach.
//   6.4 — readiness reports ready only when DB AND Redis checks both succeed
//         within 5 seconds.
//   6.5 — on failure/timeout, readiness reports not-ready and indicates which
//         dependency failed.
//   7.3 — when the Coordination_Store (Redis) is unavailable the server keeps
//         serving same-instance members but readiness reports not-ready until
//         Redis is reachable again (the Redis connectivity probe drives this).
//   7.6 — when the Persistence_Store write retries are exhausted, readiness
//         reports not-ready until a later flush succeeds (the persistence
//         degraded-flag check below drives this).

/** Default readiness time budget (Requirement 6.4 / 6.5): 5 seconds. */
export const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

/** A single named connectivity check for one dependency. */
export interface ReadinessCheck {
  /** Stable dependency name surfaced in the readiness report (e.g. "database"). */
  name: string;
  /** Resolves when the dependency is reachable; rejects/throws otherwise. */
  probe: () => Promise<unknown>;
}

/** Outcome of probing a single dependency. */
export interface DependencyStatus {
  name: string;
  ok: boolean;
  /** Failure reason (timeout or thrown error message) when `ok` is false. */
  error?: string;
}

/** Aggregate readiness outcome across all configured dependencies. */
export interface ReadinessResult {
  /** True only when every configured check succeeded within the budget. */
  ready: boolean;
  /** Per-dependency status, in the order the checks were supplied. */
  checks: DependencyStatus[];
}

/** Minimal shape of a `pg.Pool` needed to probe the Persistence_Store. */
export interface DatabaseProbe {
  query(text: string): Promise<unknown>;
}

/** Minimal shape of a Redis client needed to probe the Coordination_Store. */
export interface RedisProbe {
  ping(): Promise<unknown>;
}

/**
 * Race a promise against a timeout. The returned promise rejects with a
 * timeout error after `ms` if the wrapped promise has not settled, so a probe
 * that hangs (e.g. an unreachable datastore) never stalls the readiness route
 * beyond the budget. The timer is cleared as soon as the wrapped promise
 * settles so no handle is left dangling on the fast path.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    // Don't let the timeout timer keep the event loop alive on its own.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Run every readiness check in parallel under a shared time budget and report
 * the aggregate result. Each probe is bounded by `timeoutMs`, so the whole
 * evaluation settles within roughly that budget even when a dependency hangs.
 *
 * A check that throws synchronously, returns a rejected promise, or exceeds the
 * budget is reported as `ok: false` with its reason — the dependency that
 * failed is identifiable by name (Requirement 6.5). With no checks configured
 * the result is vacuously ready, which keeps `createApp` callers that don't
 * wire datastore probes (e.g. unit tests) working gracefully.
 */
export async function evaluateReadiness(
  checks: ReadinessCheck[],
  timeoutMs: number = DEFAULT_READINESS_TIMEOUT_MS
): Promise<ReadinessResult> {
  const statuses = await Promise.all(
    checks.map(async (check): Promise<DependencyStatus> => {
      try {
        // Wrap in `Promise.resolve().then` so a probe that throws synchronously
        // is captured as a rejection rather than escaping this try/catch.
        await withTimeout(
          Promise.resolve().then(() => check.probe()),
          timeoutMs
        );
        return { name: check.name, ok: true };
      } catch (err) {
        return {
          name: check.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  return {
    ready: statuses.every((status) => status.ok),
    checks: statuses,
  };
}

/**
 * Build a Persistence_Store (PostgreSQL) connectivity check. Runs a trivial
 * `SELECT 1` against the supplied pool; pg opens a connection lazily on the
 * first query, so this also exercises reachability of the datastore.
 */
export function databaseReadinessCheck(
  pool: DatabaseProbe,
  name = "database"
): ReadinessCheck {
  return {
    name,
    probe: () => pool.query("SELECT 1"),
  };
}

/**
 * Build a Coordination_Store (Redis) connectivity check using a `PING`.
 */
export function redisReadinessCheck(
  client: RedisProbe,
  name = "redis"
): ReadinessCheck {
  return {
    name,
    probe: () => client.ping(),
  };
}

/**
 * Build a synchronous flag-based readiness check from a boolean predicate.
 *
 * Unlike the connectivity checks above (which probe an external dependency over
 * the network), this reads an in-process health flag: the check is "ready" when
 * `isHealthy()` returns true and "not-ready" (rejecting so `evaluateReadiness`
 * marks it failed) when it returns false. This keeps degraded-readiness signals
 * that originate from process-internal state — rather than a reachability probe
 * — expressible through the same generic check list.
 */
export function flagReadinessCheck(
  name: string,
  isHealthy: () => boolean,
  unhealthyMessage = "not ready"
): ReadinessCheck {
  return {
    name,
    probe: async () => {
      if (!isHealthy()) {
        throw new Error(unhealthyMessage);
      }
    },
  };
}

/** Minimal shape of the Stroke_Service needed for the persistence-health flag. */
export interface PersistenceHealthProbe {
  /** False once a board's flush retry budget is exhausted (degraded). */
  isPersistenceHealthy(): boolean;
}

/**
 * Build a Persistence_Store *degraded-readiness* check (Requirement 7.6).
 *
 * This does NOT probe the database over the network — {@link databaseReadinessCheck}
 * already covers reachability. Instead it reads the Stroke_Service's in-process
 * health flag, which goes false when a board's write-retry budget is exhausted:
 * the buffered strokes are retained and their durable-persistence acknowledgment
 * is withheld, so readiness must report not-ready until a later flush succeeds
 * and the service reports healthy again.
 */
export function persistenceReadinessCheck(
  service: PersistenceHealthProbe,
  name = "persistence"
): ReadinessCheck {
  return flagReadinessCheck(
    name,
    () => service.isPersistenceHealthy(),
    "persistence write retries exhausted; durable-persistence acknowledgment withheld"
  );
}
