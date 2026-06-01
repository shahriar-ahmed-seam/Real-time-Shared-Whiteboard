/* eslint-disable camelcase */

// ─── Migration: initial boards + strokes schema ──────────────────────
// Creates the durable Persistence_Store schema for the production-readiness
// feature, matching the design's PostgreSQL data model exactly:
//
//   boards   — one row per board (durable metadata + compaction baseline)
//   strokes  — append-only, per-board ordered stroke log
//
// Plus the idx_strokes_board_seq index that backs ordered history replay
// (read strokes for a board in ascending seq order) and range pruning.
//
// Requirements: 3.6 (restore each board's persisted history on restart).

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // ── boards ─────────────────────────────────────────────────────────
  pgm.createTable("boards", {
    id: { type: "text", primaryKey: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    last_activity: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    // Nullable: NULL means the board is unprotected (no password).
    password_hash: { type: "text", notNull: false },
    // Strokes with seq <= snapshot_seq are baked into the baseline snapshot.
    snapshot_seq: { type: "bigint", notNull: true, default: 0 },
    // Optional rasterized baseline image (object-storage URL).
    snapshot_url: { type: "text", notNull: false },
  });

  // ── strokes ────────────────────────────────────────────────────────
  pgm.createTable("strokes", {
    board_id: {
      type: "text",
      notNull: true,
      references: '"boards"(id)',
      onDelete: "CASCADE",
    },
    // Monotonic, gap-free per-board ordering key assigned by the Stroke_Service.
    seq: { type: "bigint", notNull: true },
    id: { type: "text", notNull: true },
    user_id: { type: "text", notNull: true },
    // StrokeSegment payload (x0,y0,x1,y1,color,width) stored flexibly.
    payload: { type: "jsonb", notNull: true },
    ts: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // Composite primary key gives ordered, unique (board_id, seq) addressing.
  pgm.addConstraint("strokes", "strokes_pkey", {
    primaryKey: ["board_id", "seq"],
  });

  // Index backing ordered history reads and range pruning per board.
  pgm.createIndex("strokes", ["board_id", "seq"], {
    name: "idx_strokes_board_seq",
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // strokes first: it FK-references boards.
  pgm.dropTable("strokes");
  pgm.dropTable("boards");
};
