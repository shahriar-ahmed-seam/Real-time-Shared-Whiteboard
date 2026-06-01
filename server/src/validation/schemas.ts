// ─── Inbound socket payload schemas ──────────────────────────────────
//
// Single source of truth for the wire shape of every client → server socket
// event. Each schema is `.strict()` so unexpected/extra keys are rejected
// rather than silently ignored, and every field is bounded so malformed or
// adversarial payloads (NaN/Infinity coordinates, oversized strings, control
// characters, arbitrary colors) are turned away at the protocol boundary.
//
// The inferred types are re-exported so handlers consume the same definition
// the validator enforces — schema and type can never drift.
//
// Requirements: 2.2 (every payload parses to success/failure without throwing),
// 2.6 (per-field bounds back the payload-size defenses).

import { z } from "zod";

// ─── Shared field schemas ────────────────────────────────────────────

/**
 * A finite world-space coordinate within sane bounds. Rejects `NaN`,
 * `Infinity`, and values outside `[-1e6, 1e6]`.
 */
const finiteCoord = z.number().finite().min(-1e6).max(1e6);

/**
 * A safe CSS color: hex (`#rgb`…`#rrggbbaa`) or `rgb()`/`rgba()`. Arbitrary
 * strings (including `url(...)`, CSS keywords, or injection attempts) are
 * rejected.
 */
const safeColor = z
  .string()
  .regex(
    /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}(\s*,\s*(0|1|0?\.\d+))?\s*\))$/,
  );

/** World-space stroke width: finite and within `(0, 200]`. */
const strokeWidth = z.number().finite().gt(0).max(200);

/** Room identifier: the nanoid alphabet, 6–32 characters. */
const roomId = z.string().regex(/^[A-Za-z0-9_-]{6,32}$/);

/** Display name: 1–20 characters after trimming, with no control characters. */
const username = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[^\u0000-\u001F\u007F]+$/);

// ─── Event payload schemas ───────────────────────────────────────────

/** A single drawn segment in world-space coordinates. */
export const StrokeSegmentSchema = z
  .object({
    x0: finiteCoord,
    y0: finiteCoord,
    x1: finiteCoord,
    y1: finiteCoord,
    color: safeColor,
    width: strokeWidth,
  })
  .strict();

/** `join-room` payload: room, display name, and signed join token. */
export const JoinRoomSchema = z
  .object({
    roomId,
    username,
    token: z.string().min(1),
  })
  .strict();

/** `draw` payload: target room plus the validated stroke segment. */
export const DrawSchema = z
  .object({
    roomId,
    stroke: StrokeSegmentSchema,
  })
  .strict();

/** `cursor-move` payload: target room plus the cursor's world-space point. */
export const CursorMoveSchema = z
  .object({
    roomId,
    x: finiteCoord,
    y: finiteCoord,
  })
  .strict();

/** `clear` payload: just the target room. */
export const ClearSchema = z
  .object({
    roomId,
  })
  .strict();

// ─── Inferred types (reused across handlers) ─────────────────────────

export type StrokeSegmentInput = z.infer<typeof StrokeSegmentSchema>;
export type JoinRoomInput = z.infer<typeof JoinRoomSchema>;
export type DrawInput = z.infer<typeof DrawSchema>;
export type CursorMoveInput = z.infer<typeof CursorMoveSchema>;
export type ClearInput = z.infer<typeof ClearSchema>;

// ─── safeParse-based parse helper ────────────────────────────────────

/** A field-level validation issue: the dotted path and a human-readable reason. */
export interface ParseIssue {
  /** Dotted path to the offending field (empty string for the root). */
  path: string;
  /** Human-readable explanation of why the field failed validation. */
  message: string;
}

/**
 * Result of parsing an inbound payload. Discriminated on `success` so callers
 * can branch without touching zod internals.
 */
export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ParseIssue[] };

/**
 * Parse an arbitrary, untrusted payload against a schema.
 *
 * Uses zod's `safeParse` and is wrapped defensively so it returns a
 * success/failure result for *any* input and never throws — satisfying the
 * validation-totality requirement (2.2). On failure it returns a flat list of
 * field-level issues suitable for an `invalid-payload` error indication.
 */
export function parsePayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): ParseResult<T> {
  try {
    const result = schema.safeParse(payload);
    if (result.success) {
      return { success: true, data: result.data };
    }
    const issues: ParseIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return { success: false, issues };
  } catch (err) {
    // Defensive: a misbehaving schema or exotic input must still yield a
    // failure result rather than propagating an exception.
    return {
      success: false,
      issues: [
        {
          path: "",
          message: err instanceof Error ? err.message : "Unknown parse error",
        },
      ],
    };
  }
}
