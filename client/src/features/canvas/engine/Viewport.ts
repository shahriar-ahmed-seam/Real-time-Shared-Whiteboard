import {
  clampScale,
  screenToWorld,
  worldToScreen,
  zoomAround,
  MIN_SCALE,
  MAX_SCALE,
  type Point,
  type Transform,
} from "../../../lib/coordinates";

// ─── Viewport (Tier B — non-React) ────────────────────────────────────
// Owns the pan/zoom transform imperatively. The hot path (pan drag, wheel zoom)
// mutates this object directly and asks the engine to repaint on the next
// frame; React is never involved. The pure transform math lives in the
// property-tested lib/coordinates module — this class is just the mutable
// stateful holder plus change notification for low-frequency readers (the zoom
// percentage chip), which poll via `getScale()` on a coarse interval rather
// than subscribing to every pan frame.

export class Viewport {
  private transform: Transform = { x: 0, y: 0, scale: 1 };

  /** Current transform (live reference; treat as read-only). */
  get(): Readonly<Transform> {
    return this.transform;
  }

  getScale(): number {
    return this.transform.scale;
  }

  /** Center the world origin in a freshly sized viewport (first layout only). */
  centerIfUnset(cssWidth: number, cssHeight: number): void {
    if (this.transform.x === 0 && this.transform.y === 0) {
      this.transform = { x: cssWidth / 2, y: cssHeight / 2, scale: 1 };
    }
  }

  /** Translate by a screen-space delta (pan). */
  panBy(dx: number, dy: number): void {
    this.transform = {
      ...this.transform,
      x: this.transform.x + dx,
      y: this.transform.y + dy,
    };
  }

  /** Set the absolute translation (used at pan-drag start bookkeeping). */
  setTranslation(x: number, y: number): void {
    this.transform = { ...this.transform, x, y };
  }

  /** Zoom around a fixed screen anchor (cursor), clamped to the supported range. */
  zoomAround(anchor: Point, factor: number): void {
    this.transform = zoomAround(this.transform, anchor, factor, MIN_SCALE, MAX_SCALE);
  }

  /** Clamp an arbitrary scale into the supported range. */
  static clampScale = clampScale;

  /** Screen → world under the current transform. */
  toWorld(screen: Point): Point {
    return screenToWorld(screen, this.transform);
  }

  /** World → screen under the current transform. */
  toScreen(world: Point): Point {
    return worldToScreen(world, this.transform);
  }
}
