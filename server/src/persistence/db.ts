// ─── PostgreSQL connection pool (Persistence_Store) ──────────────────
// Exposes a single, lazily-created `pg.Pool` built from the validated
// DATABASE_URL plus a small `query` helper so repositories never touch the
// pool directly. The pool is process-wide: pg manages a bounded set of
// connections internally and hands them out per query, so repositories share
// one pool rather than opening connections ad hoc.
//
// Requirements: 3.6 (durable Persistence_Store the server restores board
// history from on restart).

import { Pool, type PoolConfig, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { logger } from "../observability/logger";

/** Options for constructing a pool; `connectionString` is the only required value. */
export interface CreatePoolOptions extends PoolConfig {
  connectionString: string;
}

/**
 * Build a new `pg.Pool` from a connection string (typically `env.DATABASE_URL`).
 *
 * An `error` listener is attached so an unexpected error on an idle backend
 * client is logged rather than crashing the process — pg will discard the
 * faulty client and create a fresh one on the next query.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const pool = new Pool(options);

  pool.on("error", (err) => {
    logger.error(`Unexpected error on idle PostgreSQL client: ${err.message}`);
  });

  return pool;
}

// ─── Shared process-wide pool ────────────────────────────────────────

let sharedPool: Pool | undefined;

/**
 * Initialize the shared pool from `DATABASE_URL`. Call once at composition-root
 * startup, before any repository issues a query. Returns the created pool.
 */
export function initPool(databaseUrl: string, options: Omit<PoolConfig, "connectionString"> = {}): Pool {
  if (sharedPool) {
    return sharedPool;
  }
  sharedPool = createPool({ connectionString: databaseUrl, ...options });
  return sharedPool;
}

/**
 * Access the shared pool. Throws if {@link initPool} has not run yet, surfacing
 * a wiring mistake immediately instead of silently creating an unconfigured pool.
 */
export function getPool(): Pool {
  if (!sharedPool) {
    throw new Error("PostgreSQL pool has not been initialized; call initPool(DATABASE_URL) first.");
  }
  return sharedPool;
}

/**
 * Run a parameterized query against the shared pool. Always use parameter
 * placeholders ($1, $2, …) rather than string interpolation to avoid SQL
 * injection.
 */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[] | undefined);
}

/**
 * Check out a client from the shared pool for a multi-statement unit of work
 * (e.g. a transaction). The caller MUST `release()` the returned client when done.
 */
export function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Close the shared pool, draining its connections. Used during Graceful_Shutdown.
 * Safe to call when no pool was initialized.
 */
export async function closePool(): Promise<void> {
  if (!sharedPool) {
    return;
  }
  const pool = sharedPool;
  sharedPool = undefined;
  await pool.end();
}
