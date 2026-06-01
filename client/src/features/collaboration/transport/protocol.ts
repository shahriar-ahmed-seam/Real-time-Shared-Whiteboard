// ─── Wire protocol types ──────────────────────────────────────────────
// Mirrors the server's domain + validation contract (server/src/types/domain.ts
// and server/src/validation/schemas.ts) exactly. This file is the SINGLE source
// of truth for the shapes that cross the socket; both directions reference it.
//
// Keeping these in lockstep with the server is non-negotiable: the server owns
// the protocol, the client conforms. Anything sent must satisfy the server's
// `.strict()` zod schemas (bounded coords, safe color, width in (0,200], etc.),
// and anything received matches the enriched server-controlled shapes.

/**
 * A single drawn segment in world-space coordinates — the validated wire shape
 * of a stroke (server `StrokeSegment`). Bounds enforced server-side:
 *   • x0/y0/x1/y1 finite, within [-1e6, 1e6]
 *   • color matches the server's safe-color pattern (#hex or rgb/rgba)
 *   • width finite, within (0, 200]
 */
export interface StrokeSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
}

/**
 * A server-enriched, persisted stroke as broadcast on the `draw` channel and
 * inside `room-history`. The server owns every field beyond the segment.
 * (server `PersistedStroke`.)
 */
export interface PersistedStroke extends StrokeSegment {
  /** Server-generated stroke id (nanoid). */
  id: string;
  /** Monotonic, gap-free per-board ordering key. */
  seq: number;
  /** Stable author identity (distinct from socketId). */
  userId: string;
  /** Server receive time, epoch ms. */
  ts: number;
}

/**
 * Baseline snapshot of a board produced by server-side compaction. Strokes with
 * `seq <= snapshotSeq` are represented by the snapshot. (server `BoardSnapshot`.)
 */
export interface BoardSnapshot {
  boardId: string;
  snapshotSeq: number;
  imageUrl?: string;
  createdAt: number;
}

/**
 * Payload of the server's `room-history` event.
 *
 * IMPORTANT: the server emits an OBJECT `{ snapshot?, strokes }`, not a bare
 * array. `strokes` is the ordered tail (ascending `seq`) following the optional
 * baseline `snapshot`. The transport decodes this object shape directly.
 */
export interface RoomHistory {
  snapshot?: BoardSnapshot;
  strokes: PersistedStroke[];
}

/** A user present in a room, with live cursor state (server `User`). */
export interface RoomUser {
  socketId: string;
  userId: string;
  username: string;
  cursorColor: string;
  cursor: { x: number; y: number } | null;
}

/** Live cursor frame broadcast on `cursor-update`. */
export interface CursorUpdate {
  socketId: string;
  x: number;
  y: number;
}

/**
 * Error indication on the `error` channel. `code` is one of the server's
 * documented codes; surfaced to the user as a toast.
 */
export interface SocketError {
  code: SocketErrorCode;
  message: string;
}

/** Error codes the server may emit (server gateway + handlers). */
export type SocketErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_PAYLOAD"
  | "RATE_LIMITED"
  | "JOIN_FAILED"
  | "RESYNC_FAILED"
  | (string & {});
