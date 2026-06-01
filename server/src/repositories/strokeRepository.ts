// ─── Stroke repository (PostgreSQL-backed) ───────────────────────────
// The durable data-access layer for the append-only, per-board stroke log.
// The Stroke_Service owns ordering, buffering, and compaction policy; this
// repository owns only the SQL that moves PersistedStroke rows in and out of
// the `strokes` table (board_id, seq, id, user_id, payload jsonb, ts), keyed
// by the composite primary key (board_id, seq) and read via idx_strokes_board_seq.
//
// Every statement is parameterized ($1, $2, …) — never string-interpolated —
// so untrusted stroke payloads can never alter the query (security hardening).
//
// Requirements:
//   3.1 — strokes carry a gap-free per-board Sequence_Number; this layer
//         preserves and orders by that seq on read.
//   3.6 — on restart the server restores each board's persisted history;
//         loadSince / count back that ordered replay, while insertBatch and
//         deleteThrough keep the durable log consistent and bounded.

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { getPool } from "../persistence/db";
import type { PersistedStroke, StrokeSegment } from "../types/domain";

/**
 * Persistence boundary for board stroke history. Constructor-injected into the
 * Stroke_Service so it can be mocked in tests; the production implementation is
 * {@link PgStrokeRepository}.
 */
export interface StrokeRepository {
  /** Durably append a batch of already-sequenced strokes for one board. */
  insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void>;
  /** Return strokes with `seq > sinceSeq` for a board, ascending by seq. */
  loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]>;
  /** Prune all strokes with `seq <= throughSeq` for a board, in bounded batches. */
  deleteThrough(boardId: string, throughSeq: number): Promise<void>;
  /** Count the live (non-compacted) strokes retained for a board. */
  count(boardId: string): Promise<number>;
}

// ── Tuning constants ────────────────────────────────────────────────

/**
 * Rows per multi-row INSERT statement. PostgreSQL caps a statement at 65535
 * bind parameters; at 5 params per row this leaves a wide safety margin while
 * keeping each round-trip cheap. Batches larger than this are chunked.
 */
const MAX_INSERT_ROWS = 1000;

/**
 * Rows deleted per DELETE statement during pruning. Bounding the batch keeps
 * each statement's lock footprint small so compaction never blocks live writes
 * for long (see design: "delete now-redundant strokes in bounded batches").
 */
const DELETE_BATCH_SIZE = 1000;

// ── Row shape returned by loadSince ─────────────────────────────────

interface StrokeRow extends QueryResultRow {
  id: string;
  // bigint columns arrive as strings from node-pg; parsed to number below.
  seq: string;
  user_id: string;
  payload: StrokeSegment;
  // ts is projected as epoch-milliseconds (bigint → string) by the query.
  ts_ms: string;
}

/**
 * PostgreSQL-backed {@link StrokeRepository}.
 *
 * The pool is resolved lazily via {@link getPool} so the repository can be
 * constructed at module load while the shared pool is initialized later at the
 * composition root. A pool may also be injected directly (used by tests).
 */
export class PgStrokeRepository implements StrokeRepository {
  constructor(private readonly injectedPool?: Pool) {}

  private pool(): Pool {
    return this.injectedPool ?? getPool();
  }

  /**
   * Append a batch of strokes durably. The caller (Stroke_Service) has already
   * assigned each stroke its gap-free `seq`, so rows are inserted verbatim.
   *
   * Rows are written with multi-row INSERT statements. `ON CONFLICT (board_id,
   * seq) DO NOTHING` makes the operation idempotent, so a write retry that
   * partially succeeded earlier cannot raise a duplicate-key error. When the
   * batch exceeds {@link MAX_INSERT_ROWS} it is chunked across several
   * statements inside a single transaction so the batch lands atomically.
   */
  async insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void> {
    if (strokes.length === 0) {
      return;
    }

    const chunks = chunk(strokes, MAX_INSERT_ROWS);

    // Single statement: no transaction overhead needed (one statement is atomic).
    if (chunks.length === 1) {
      const { text, values } = buildInsert(boardId, chunks[0]);
      await this.pool().query(text, values);
      return;
    }

    // Multiple statements: wrap in a transaction so the whole batch is atomic.
    const client: PoolClient = await this.pool().connect();
    try {
      await client.query("BEGIN");
      for (const group of chunks) {
        const { text, values } = buildInsert(boardId, group);
        await client.query(text, values);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Load every stroke for `boardId` with `seq > sinceSeq`, ordered by ascending
   * seq. This backs reconnection delta replay and post-restart history restore;
   * the ORDER BY is served by idx_strokes_board_seq. Pass `sinceSeq = 0` (or any
   * value below the first seq) to load the entire live tail.
   */
  async loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]> {
    const text = `
      SELECT id,
             seq,
             user_id,
             payload,
             (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms
        FROM strokes
       WHERE board_id = $1
         AND seq > $2
       ORDER BY seq ASC
    `;
    const result = await this.pool().query<StrokeRow>(text, [boardId, sinceSeq]);
    return result.rows.map(rowToStroke);
  }

  /**
   * Prune all strokes with `seq <= throughSeq` for a board. Deletion proceeds in
   * bounded batches of {@link DELETE_BATCH_SIZE} rows (selected by `ctid` with a
   * LIMIT, since PostgreSQL DELETE has no direct LIMIT) so no single statement
   * holds locks across the whole pruned range. The loop stops once a statement
   * deletes fewer rows than the batch size, i.e. nothing matching remains.
   */
  async deleteThrough(boardId: string, throughSeq: number): Promise<void> {
    const text = `
      DELETE FROM strokes
       WHERE ctid IN (
         SELECT ctid
           FROM strokes
          WHERE board_id = $1
            AND seq <= $2
          LIMIT $3
       )
    `;
    // Drain in batches until a pass removes fewer rows than the batch size.
    for (;;) {
      const result = await this.pool().query(text, [boardId, throughSeq, DELETE_BATCH_SIZE]);
      if ((result.rowCount ?? 0) < DELETE_BATCH_SIZE) {
        break;
      }
    }
  }

  /** Count the live strokes retained for a board (drives compaction decisions). */
  async count(boardId: string): Promise<number> {
    const result = await this.pool().query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM strokes WHERE board_id = $1",
      [boardId]
    );
    // COUNT(*) is a bigint and arrives as a string; parse to a JS number.
    return Number(result.rows[0]?.count ?? 0);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Split an array into consecutive sub-arrays of at most `size` elements. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Build a parameterized multi-row INSERT for one chunk of strokes. `board_id`
 * is bound once as `$1` and shared by every row; each stroke contributes five
 * further parameters (seq, id, user_id, payload, ts). The stroke's epoch-ms
 * `ts` is converted to a timestamptz with `to_timestamp`, and the segment
 * payload is serialized to JSON and cast to jsonb.
 */
function buildInsert(
  boardId: string,
  strokes: readonly PersistedStroke[]
): { text: string; values: unknown[] } {
  const values: unknown[] = [boardId];
  const rows: string[] = [];

  for (const stroke of strokes) {
    const segment: StrokeSegment = {
      x0: stroke.x0,
      y0: stroke.y0,
      x1: stroke.x1,
      y1: stroke.y1,
      color: stroke.color,
      width: stroke.width,
    };
    // Param indices: $1 is board_id; subsequent params start at the current length.
    const base = values.length;
    values.push(stroke.seq, stroke.id, stroke.userId, JSON.stringify(segment), stroke.ts);
    rows.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, to_timestamp($${base + 5} / 1000.0))`
    );
  }

  const text =
    "INSERT INTO strokes (board_id, seq, id, user_id, payload, ts) VALUES " +
    rows.join(", ") +
    " ON CONFLICT (board_id, seq) DO NOTHING";

  return { text, values };
}

/** Reconstruct a {@link PersistedStroke} from a queried row. */
function rowToStroke(row: StrokeRow): PersistedStroke {
  return {
    ...row.payload,
    id: row.id,
    seq: Number(row.seq),
    userId: row.user_id,
    ts: Number(row.ts_ms),
  };
}
