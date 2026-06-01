// ─── Board repository (PostgreSQL-backed) ────────────────────────────
// Durable metadata for each board: existence, the compaction baseline
// (snapshot_seq / snapshot_url), the optional password hash that gates
// Join_Token issuance, and the last-activity timestamp used for idle
// cleanup. All access goes through the shared pool's parameterized `query`
// helper so board ids and values are never string-interpolated into SQL.
//
// Requirements:
//   2.7 — issue a Join_Token only when the supplied password matches the
//         stored password hash (getPasswordHash exposes the stored hash).
//   3.6 — restore each board's persisted history on restart; the boards row
//         (snapshot baseline) is the anchor history replay is read against.

import { query } from "../persistence/db";

/**
 * Durable board metadata store. Implementations persist one row per board in
 * the Persistence_Store. Mutating helpers operate by id and are no-ops when
 * the board row does not exist, so callers that need the row to be present
 * (e.g. before recording a snapshot) should call {@link BoardRepository.ensure}
 * first.
 */
export interface BoardRepository {
  /** Create the board row if it does not already exist (idempotent). */
  ensure(boardId: string): Promise<void>;
  /** Highest Sequence_Number baked into the board's baseline snapshot (0 if none). */
  getSnapshotSeq(boardId: string): Promise<number>;
  /** Record a new compaction baseline: strokes with seq <= `seq` are represented by the snapshot. */
  setSnapshot(boardId: string, seq: number, url?: string): Promise<void>;
  /** Stored password hash gating Join_Token issuance, or null when the board is unprotected/unknown. */
  getPasswordHash(boardId: string): Promise<string | null>;
  /** Bump the board's last-activity timestamp to now. */
  touch(boardId: string): Promise<void>;
}

/** Row shape for the `snapshot_seq` lookup. `bigint` arrives as a string from pg. */
interface SnapshotSeqRow {
  snapshot_seq: string;
}

/** Row shape for the `password_hash` lookup. */
interface PasswordHashRow {
  password_hash: string | null;
}

/**
 * PostgreSQL-backed {@link BoardRepository}. Stateless: every method issues a
 * single parameterized statement against the process-wide pool exposed by
 * `persistence/db`.
 */
export class PgBoardRepository implements BoardRepository {
  /**
   * Insert the board row if absent. Uses `ON CONFLICT DO NOTHING` so concurrent
   * callers racing to create the same board converge on a single row without
   * error; created_at/last_activity/snapshot_seq fall back to their column
   * defaults.
   */
  async ensure(boardId: string): Promise<void> {
    await query("INSERT INTO boards (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [boardId]);
  }

  /**
   * Read the compaction baseline. Returns 0 when the board is unknown, matching
   * the column default for a freshly created board (no strokes compacted yet).
   * The `bigint` column is returned by pg as a string and parsed back to a number.
   */
  async getSnapshotSeq(boardId: string): Promise<number> {
    const result = await query<SnapshotSeqRow>("SELECT snapshot_seq FROM boards WHERE id = $1", [boardId]);
    const row = result.rows[0];
    if (!row) {
      return 0;
    }
    return Number(row.snapshot_seq);
  }

  /**
   * Persist a new compaction baseline. `url` is the optional rasterized snapshot
   * location; when omitted the stored `snapshot_url` is cleared to NULL.
   */
  async setSnapshot(boardId: string, seq: number, url?: string): Promise<void> {
    await query("UPDATE boards SET snapshot_seq = $2, snapshot_url = $3 WHERE id = $1", [
      boardId,
      seq,
      url ?? null,
    ]);
  }

  /**
   * Return the stored password hash, or null when the board is unprotected
   * (NULL column) or does not exist. Callers compare a supplied password
   * against this hash before issuing a Join_Token.
   */
  async getPasswordHash(boardId: string): Promise<string | null> {
    const result = await query<PasswordHashRow>("SELECT password_hash FROM boards WHERE id = $1", [boardId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return row.password_hash;
  }

  /** Mark the board as recently active. No-op if the board row does not exist. */
  async touch(boardId: string): Promise<void> {
    await query("UPDATE boards SET last_activity = now() WHERE id = $1", [boardId]);
  }
}
