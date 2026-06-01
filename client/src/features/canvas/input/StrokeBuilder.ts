import type { Point } from "../../../lib/coordinates";
import type { StrokeSegment } from "../../collaboration/transport/protocol";

// ─── StrokeBuilder ────────────────────────────────────────────────────
// Turns a sequence of world-space sample points into bounded StrokeSegments
// (the wire shape). A stroke is a polyline; each consecutive pair of samples
// becomes one segment carrying the brush color and the DPR-independent width.
//
// Width is divided by the current scale at build time so a stroke keeps a
// constant ON-SCREEN thickness regardless of zoom (matching the legacy feel),
// while the persisted world-space width stays scale-correct.

export interface Brush {
  color: string;
  /** Desired on-screen width in pixels. */
  width: number;
}

export class StrokeBuilder {
  private last: Point | null = null;

  /** Begin a new stroke at `start` (world space). No segment is produced yet. */
  begin(start: Point): void {
    this.last = start;
  }

  /**
   * Extend the stroke to `next` (world space), returning the segment from the
   * previous point to `next`, or null if there is no anchor yet. `scale` is the
   * current viewport scale used to keep on-screen width constant.
   */
  extend(next: Point, brush: Brush, scale: number): StrokeSegment | null {
    if (!this.last) {
      this.last = next;
      return null;
    }
    const segment: StrokeSegment = {
      x0: this.last.x,
      y0: this.last.y,
      x1: next.x,
      y1: next.y,
      color: brush.color,
      width: brush.width / scale,
    };
    this.last = next;
    return segment;
  }

  /** End the current stroke. */
  end(): void {
    this.last = null;
  }

  get active(): boolean {
    return this.last !== null;
  }
}
