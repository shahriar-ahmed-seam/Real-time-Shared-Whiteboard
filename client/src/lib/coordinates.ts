// ─── Pure coordinate-transform helpers ──────────────────────────────
// Extracted from useDraw.ts so the pan/zoom math can be unit- and
// property-tested in isolation. Every function here is pure: it reads
// its inputs and returns a fresh value with no side effects, no DOM
// access, and no mutation of the arguments.
//
// Requirement 4.1: converting a point screen→world→screen with the same
// transform at any scale in [0.05, 20] must round-trip within 0.01px.

/** A pan + zoom transform. `x`/`y` are the screen-space translation of the
 *  world origin; `scale` is the zoom factor (world units → screen pixels). */
export interface Transform {
  x: number;
  y: number;
  scale: number;
}

/** A 2D point. Used for both screen-space and world-space coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** Supported zoom range. Mirrors the clamp the canvas enforces on wheel zoom. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 20;

/** Clamp a proposed scale into the supported zoom range. */
export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(Math.max(scale, min), max);
}

/**
 * Convert a screen-space point to world space under `t`.
 *
 * Inverse of {@link worldToScreen}. screen = world * scale + offset, so
 * world = (screen - offset) / scale.
 */
export function screenToWorld(screen: Point, t: Transform): Point {
  return {
    x: (screen.x - t.x) / t.scale,
    y: (screen.y - t.y) / t.scale,
  };
}

/**
 * Convert a world-space point to screen space under `t`.
 *
 * Inverse of {@link screenToWorld}.
 */
export function worldToScreen(world: Point, t: Transform): Point {
  return {
    x: world.x * t.scale + t.x,
    y: world.y * t.scale + t.y,
  };
}

/**
 * Compute the transform after zooming around a fixed screen anchor (e.g. the
 * cursor). The world point currently under `anchor` stays under `anchor`
 * after the zoom, which is the "zoom toward the cursor" behavior.
 *
 * @param t          current transform
 * @param anchor     screen-space point to keep fixed (cursor position)
 * @param factor     multiplicative zoom step (>1 zooms in, <1 zooms out)
 * @param minScale   lower clamp for the resulting scale
 * @param maxScale   upper clamp for the resulting scale
 */
export function zoomAround(
  t: Transform,
  anchor: Point,
  factor: number,
  minScale = MIN_SCALE,
  maxScale = MAX_SCALE,
): Transform {
  const newScale = clampScale(t.scale * factor, minScale, maxScale);

  // World point currently under the anchor.
  const world = screenToWorld(anchor, t);

  // Reposition the translation so that `world` maps back to `anchor` at the
  // new scale: anchor = world * newScale + offset  =>  offset = anchor - world * newScale.
  return {
    x: anchor.x - world.x * newScale,
    y: anchor.y - world.y * newScale,
    scale: newScale,
  };
}
