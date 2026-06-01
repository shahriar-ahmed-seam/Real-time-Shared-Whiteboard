// ─── Shared domain types ─────────────────────────────────────────────
// Two families of types live here during the production-readiness migration:
//
//  1. Prototype types (DrawStroke, UserInfo, RoomData) mirror the original
//     in-memory shapes so existing handlers/services keep working unchanged
//     while the layered restructure proceeds.
//
//  2. Production domain types (StrokeSegment, PersistedStroke, User,
//     BoardSnapshot) are the richer, server-controlled shapes the hardened
//     protocol, persistence, and presence layers build on. The wire shape of
//     a stroke segment stays backward compatible with the prototype's
//     DrawStroke so the migration is incremental.

// ─── Prototype types (preserved) ─────────────────────────────────────

/** A single freehand segment drawn between two world-space points. */
export interface DrawStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
}

/** A connected user and their live cursor within a room. */
export interface UserInfo {
  socketId: string;
  username: string;
  cursorColor: string;
  cursor: { x: number; y: number } | null;
}

/** In-memory state held for a single room. */
export interface RoomData {
  strokes: DrawStroke[];
  users: Map<string, UserInfo>;
  lastActivity: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Production domain types ─────────────────────────────────────────

/**
 * A single drawn segment in world-space coordinates.
 *
 * This is the validated, backward-compatible wire shape of a stroke. It is
 * structurally identical to the prototype's {@link DrawStroke}; the server
 * enriches it with identity and ordering metadata (see {@link PersistedStroke}).
 */
export interface StrokeSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** CSS color; validated against a safe pattern at the protocol boundary. */
  color: string;
  /** World-space width; bounded > 0. */
  width: number;
}

/**
 * Server-enriched stroke as persisted in the Persistence_Store and broadcast
 * to room members. The server owns every field added beyond the segment.
 */
export interface PersistedStroke extends StrokeSegment {
  /** Server-generated stroke identifier (nanoid). */
  id: string;
  /** Monotonic, gap-free per-board ordering key assigned by the Stroke_Service. */
  seq: number;
  /** Author identity (stable per join, distinct from socketId). */
  userId: string;
  /** Server receive time, epoch milliseconds. */
  ts: number;
}

/**
 * A user present in a room, including live cursor state. `userId` is stable
 * across reconnects (derived from the join token) whereas `socketId` changes
 * per connection.
 */
export interface User {
  socketId: string;
  /** Stable per-join identity, distinct from socketId. */
  userId: string;
  username: string;
  cursorColor: string;
  cursor: { x: number; y: number } | null;
}

/**
 * Baseline snapshot of a board produced by compaction. Strokes with
 * `seq <= snapshotSeq` are baked into the snapshot; joiners receive the
 * snapshot plus the strokes following it.
 */
export interface BoardSnapshot {
  boardId: string;
  /** Strokes up to and including this seq are represented by the snapshot. */
  snapshotSeq: number;
  /** Optional rasterized baseline image (object storage URL). */
  imageUrl?: string;
  /** Snapshot creation time, epoch milliseconds. */
  createdAt: number;
}
