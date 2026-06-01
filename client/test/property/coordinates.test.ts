import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  screenToWorld,
  worldToScreen,
  MIN_SCALE,
  MAX_SCALE,
  type Point,
  type Transform,
} from '../../src/lib/coordinates';

// ─── Property 7: Coordinate round-trip ──────────────────────────────
// For all points `p` and transforms `t`,
//   worldToScreen(screenToWorld(p, t), t) ≈ p
// within tolerance, for any zoom in the supported range [0.05, 20].
//
// Validates: Requirements 4.1

/** Acceptance tolerance from Requirement 4.1: within 0.01 pixels. */
const TOLERANCE_PX = 0.01;

/**
 * Coordinate generator. Bounded to the sane world range documented in the
 * design (`[-1e6, 1e6]`) so the values stay realistic while still exercising
 * extremes that stress floating-point round-tripping.
 */
const coord = (): fc.Arbitrary<number> =>
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });

/** Screen-space point generator. */
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: coord(),
  y: coord(),
});

/**
 * Transform generator: finite x/y translation and a scale strictly inside the
 * supported zoom range [MIN_SCALE, MAX_SCALE]. Scale is never zero, so the
 * screen→world division is always well-defined.
 */
const transformArb: fc.Arbitrary<Transform> = fc.record({
  x: coord(),
  y: coord(),
  scale: fc.double({
    min: MIN_SCALE,
    max: MAX_SCALE,
    noNaN: true,
    noDefaultInfinity: true,
  }),
});

describe('Property 7: Coordinate round-trip (Requirement 4.1)', () => {
  it('worldToScreen(screenToWorld(p, t), t) ≈ p within 0.01px for any point and in-range transform', () => {
    fc.assert(
      fc.property(pointArb, transformArb, (p, t) => {
        const roundTripped = worldToScreen(screenToWorld(p, t), t);

        expect(Math.abs(roundTripped.x - p.x)).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(Math.abs(roundTripped.y - p.y)).toBeLessThanOrEqual(TOLERANCE_PX);
      }),
      { numRuns: 1000 },
    );
  });
});
