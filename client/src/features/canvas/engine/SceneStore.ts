import type { StrokeSegment } from "../../collaboration/transport/protocol";

// ─── Committed-stroke buffer (Tier B — non-React) ─────────────────────
// The authoritative, mutable list of every segment baked into the board. Held
// as a plain array OUTSIDE React state so appends never trigger reconciliation.
// The CanvasEngine renders incrementally from new segments and full-repaints
// from `all()` on a viewport change / resize / clear.

export class SceneStore {
  private segments: StrokeSegment[] = [];

  /** Append one committed segment. Returns it for incremental rendering. */
  add(segment: StrokeSegment): StrokeSegment {
    this.segments.push(segment);
    return segment;
  }

  /** Append many committed segments (e.g. a history / resync batch). */
  addMany(segments: readonly StrokeSegment[]): void {
    for (const s of segments) this.segments.push(s);
  }

  /** All committed segments, in commit order, for a full repaint. */
  all(): readonly StrokeSegment[] {
    return this.segments;
  }

  /** Remove every committed segment (board clear). */
  clear(): void {
    this.segments = [];
  }

  /** Number of committed segments. */
  get size(): number {
    return this.segments.length;
  }
}
