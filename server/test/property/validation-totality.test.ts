import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { z } from "zod";

import {
  StrokeSegmentSchema,
  JoinRoomSchema,
  DrawSchema,
  CursorMoveSchema,
  ClearSchema,
  parsePayload,
  type ParseResult,
} from "../../src/validation/schemas";

// ─── Property 6: Validation totality ─────────────────────────────────
//
// **Validates: Requirements 2.2**
//
// Requirement 2.2 states that when any inbound socket payload is received,
// the Schema_Validator SHALL parse the payload against its schema and return
// EITHER a success result OR a failure result WITHOUT throwing an exception.
//
// `parsePayload` is the single parse seam every handler uses. This property
// asserts totality: for *arbitrary* and *adversarial* JSON-like input, the
// call (a) never throws and (b) always returns a well-formed discriminated
// result. We exercise every exported schema with at least 100 generated
// inputs each (the harness default is 100 runs; we pin it explicitly).

// The schemas under test, paired with a readable name for diagnostics.
const SCHEMAS: ReadonlyArray<{ name: string; schema: z.ZodType<unknown> }> = [
  { name: "StrokeSegmentSchema", schema: StrokeSegmentSchema },
  { name: "JoinRoomSchema", schema: JoinRoomSchema },
  { name: "DrawSchema", schema: DrawSchema },
  { name: "CursorMoveSchema", schema: CursorMoveSchema },
  { name: "ClearSchema", schema: ClearSchema },
];

/**
 * Assert that a `parsePayload` result is a well-formed discriminated union:
 * exactly one shape, with the expected companion field present and typed.
 * This is what "returns Ok or Err" concretely means at runtime.
 */
function assertWellFormedResult(result: ParseResult<unknown>): void {
  expect(typeof result.success).toBe("boolean");
  if (result.success) {
    // Ok branch: carries `data`, no `issues`.
    expect(result).toHaveProperty("data");
    expect(result).not.toHaveProperty("issues");
  } else {
    // Err branch: carries a non-empty array of `{ path, message }` issues.
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
  }
}

/**
 * Adversarial leaf values that have historically broken naive validators:
 * the non-finite numbers, boundary numbers, control-character and oversized
 * strings, and the JS "empty"/exotic values.
 */
const adversarialLeaf: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(Number.MAX_SAFE_INTEGER),
  fc.constant(Number.MIN_SAFE_INTEGER),
  fc.constant(-0),
  fc.constant(1e6),
  fc.constant(-1e6),
  fc.constant(1e9),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constant("\u0000\u0001\u001F\u007F"), // control characters
  fc.constant("a".repeat(10_000)), // oversized string
  fc.constant("rgb(300, 300, 300)"), // out-of-range color-ish string
  fc.constant("javascript:alert(1)"), // injection-ish string
  fc.constant("__proto__"),
  fc.string(),
  fc.integer(),
  fc.double(),
  fc.boolean(),
);

/**
 * An adversarial object roughly shaped like the real payloads, but with each
 * field independently drawn from the adversarial leaves (and sometimes extra
 * keys, which `.strict()` must reject without throwing).
 */
const adversarialShaped: fc.Arbitrary<unknown> = fc.record(
  {
    roomId: adversarialLeaf,
    username: adversarialLeaf,
    token: adversarialLeaf,
    x: adversarialLeaf,
    y: adversarialLeaf,
    x0: adversarialLeaf,
    y0: adversarialLeaf,
    x1: adversarialLeaf,
    y1: adversarialLeaf,
    color: adversarialLeaf,
    width: adversarialLeaf,
    stroke: fc.oneof(
      adversarialLeaf,
      fc.record({
        x0: adversarialLeaf,
        y0: adversarialLeaf,
        x1: adversarialLeaf,
        y1: adversarialLeaf,
        color: adversarialLeaf,
        width: adversarialLeaf,
        extra: adversarialLeaf,
      }),
    ),
    extra: adversarialLeaf,
  },
  { requiredKeys: [] },
);

/**
 * The full adversarial input space: completely arbitrary JSON-ish values
 * (`fc.anything()`), the adversarial leaves, and the loosely payload-shaped
 * objects. `fc.anything()` reaches deeply nested arrays/objects, bigints,
 * boxed values, and `Object.create(null)` records.
 */
const adversarialInput: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything({
    withBigInt: true,
    withDate: true,
    withMap: true,
    withSet: true,
    withNullPrototype: true,
    withObjectString: true,
  }),
  adversarialLeaf,
  adversarialShaped,
);

describe("Property 6: Validation totality (Requirement 2.2)", () => {
  for (const { name, schema } of SCHEMAS) {
    it(`${name}: parsePayload never throws and always returns Ok or Err on arbitrary/adversarial JSON`, () => {
      fc.assert(
        fc.property(adversarialInput, (payload) => {
          // (a) Must never throw — totality of the parse call itself.
          const result = parsePayload(schema, payload);
          // (b) Must return a well-formed discriminated success/failure result.
          assertWellFormedResult(result);
        }),
        { numRuns: 200 },
      );
    });
  }

  it("returns a failure result (not a throw) for hostile non-plain inputs", () => {
    // A spot-check with values fc.anything() rarely emits directly, ensuring
    // the defensive wrapper holds for exotic runtime objects too.
    const hostile: unknown[] = [
      Object.create(null),
      (() => {
        const o: Record<string, unknown> = {};
        o.self = o; // circular reference
        return o;
      })(),
      Symbol("x"),
      () => undefined,
      new Map([["a", 1]]),
      new Set([1, 2, 3]),
      10n,
    ];

    for (const { schema } of SCHEMAS) {
      for (const payload of hostile) {
        expect(() => parsePayload(schema, payload)).not.toThrow();
        assertWellFormedResult(parsePayload(schema, payload));
      }
    }
  });
});
