import { describe, it, expect } from "vitest";

import {
  StrokeSegmentSchema,
  JoinRoomSchema,
  DrawSchema,
  CursorMoveSchema,
  ClearSchema,
  parsePayload,
} from "../../src/validation/schemas";

// Unit tests for the inbound socket payload schemas.
//
// Validates: Requirements 2.2 (every payload parses to a success/failure
// result without throwing) and 2.6 (per-field bounds reject malformed or
// adversarial payloads — bad colors, NaN/Infinity coordinates, oversized
// fields, control characters, and unexpected extra keys via `.strict()`).

// ─── Reusable valid fixtures ─────────────────────────────────────────

const validSegment = {
  x0: 0,
  y0: 0,
  x1: 10.5,
  y1: -42,
  color: "#ff0000",
  width: 4,
};

const validRoomId = "abc123"; // 6 chars, nanoid alphabet
const validUsername = "Ada";

// ─── StrokeSegmentSchema ─────────────────────────────────────────────

describe("StrokeSegmentSchema", () => {
  it("accepts a well-formed segment", () => {
    const result = parsePayload(StrokeSegmentSchema, validSegment);
    expect(result.success).toBe(true);
  });

  it("accepts each safe color form (hex 3/6/8 digits, rgb, rgba)", () => {
    for (const color of [
      "#f00",
      "#ff0000",
      "#ff0000aa",
      "rgb(255, 0, 0)",
      "rgba(255, 0, 0, 0.5)",
      "rgba(0,0,0,1)",
    ]) {
      const result = parsePayload(StrokeSegmentSchema, { ...validSegment, color });
      expect(result.success, `expected ${color} to be accepted`).toBe(true);
    }
  });

  it("accepts coordinates at the inclusive world bounds", () => {
    const atBounds = { ...validSegment, x0: -1e6, y0: 1e6, x1: 1e6, y1: -1e6 };
    expect(parsePayload(StrokeSegmentSchema, atBounds).success).toBe(true);
  });

  it("rejects an arbitrary / unsafe color string", () => {
    for (const color of [
      "red",
      "url(javascript:alert(1))",
      "#gggggg",
      "rgb(300)",
      "",
      "<script>",
    ]) {
      const result = parsePayload(StrokeSegmentSchema, { ...validSegment, color });
      expect(result.success, `expected ${color} to be rejected`).toBe(false);
    }
  });

  it("rejects NaN and Infinity coordinates", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(parsePayload(StrokeSegmentSchema, { ...validSegment, x0: bad }).success).toBe(false);
      expect(parsePayload(StrokeSegmentSchema, { ...validSegment, y1: bad }).success).toBe(false);
    }
  });

  it("rejects coordinates outside the world bounds", () => {
    expect(parsePayload(StrokeSegmentSchema, { ...validSegment, x0: 1e6 + 1 }).success).toBe(false);
    expect(parsePayload(StrokeSegmentSchema, { ...validSegment, y0: -1e6 - 1 }).success).toBe(false);
  });

  it("rejects a non-positive or oversized width", () => {
    expect(parsePayload(StrokeSegmentSchema, { ...validSegment, width: 0 }).success).toBe(false);
    expect(parsePayload(StrokeSegmentSchema, { ...validSegment, width: -3 }).success).toBe(false);
    expect(parsePayload(StrokeSegmentSchema, { ...validSegment, width: 201 }).success).toBe(false);
    expect(parsePayload(StrokeSegmentSchema, { ...validSegment, width: Infinity }).success).toBe(false);
  });

  it("rejects extra/unexpected keys (strict)", () => {
    const result = parsePayload(StrokeSegmentSchema, { ...validSegment, evil: true });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { width, ...missingWidth } = validSegment;
    void width;
    expect(parsePayload(StrokeSegmentSchema, missingWidth).success).toBe(false);
  });
});

// ─── JoinRoomSchema ──────────────────────────────────────────────────

describe("JoinRoomSchema", () => {
  const validJoin = { roomId: validRoomId, username: validUsername, token: "t" };

  it("accepts a well-formed join payload", () => {
    expect(parsePayload(JoinRoomSchema, validJoin).success).toBe(true);
  });

  it("rejects control characters in the username", () => {
    for (const username of ["bad\u0000name", "line\nbreak", "tab\tchar", "del\u007F"]) {
      const result = parsePayload(JoinRoomSchema, { ...validJoin, username });
      expect(result.success, `expected control-char username to be rejected`).toBe(false);
    }
  });

  it("rejects an oversized username (> 20 chars after trim)", () => {
    const result = parsePayload(JoinRoomSchema, { ...validJoin, username: "a".repeat(21) });
    expect(result.success).toBe(false);
  });

  it("rejects an empty / whitespace-only username", () => {
    expect(parsePayload(JoinRoomSchema, { ...validJoin, username: "" }).success).toBe(false);
    expect(parsePayload(JoinRoomSchema, { ...validJoin, username: "   " }).success).toBe(false);
  });

  it("rejects an oversized roomId (> 32 chars)", () => {
    const result = parsePayload(JoinRoomSchema, { ...validJoin, roomId: "a".repeat(33) });
    expect(result.success).toBe(false);
  });

  it("rejects a too-short roomId (< 6 chars) and disallowed characters", () => {
    expect(parsePayload(JoinRoomSchema, { ...validJoin, roomId: "abc" }).success).toBe(false);
    expect(parsePayload(JoinRoomSchema, { ...validJoin, roomId: "room id!" }).success).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(parsePayload(JoinRoomSchema, { ...validJoin, token: "" }).success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    expect(parsePayload(JoinRoomSchema, { ...validJoin, admin: true }).success).toBe(false);
  });
});

// ─── DrawSchema ──────────────────────────────────────────────────────

describe("DrawSchema", () => {
  const validDraw = { roomId: validRoomId, stroke: validSegment };

  it("accepts a well-formed draw payload", () => {
    expect(parsePayload(DrawSchema, validDraw).success).toBe(true);
  });

  it("rejects a draw whose nested stroke is malformed", () => {
    const result = parsePayload(DrawSchema, {
      ...validDraw,
      stroke: { ...validSegment, color: "notacolor" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a draw with NaN coordinates in the nested stroke", () => {
    const result = parsePayload(DrawSchema, {
      ...validDraw,
      stroke: { ...validSegment, x1: NaN },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys at the top level (strict)", () => {
    expect(parsePayload(DrawSchema, { ...validDraw, extra: 1 }).success).toBe(false);
  });
});

// ─── CursorMoveSchema ────────────────────────────────────────────────

describe("CursorMoveSchema", () => {
  const validCursor = { roomId: validRoomId, x: 1, y: 2 };

  it("accepts a well-formed cursor-move payload", () => {
    expect(parsePayload(CursorMoveSchema, validCursor).success).toBe(true);
  });

  it("rejects Infinity / NaN cursor coordinates", () => {
    expect(parsePayload(CursorMoveSchema, { ...validCursor, x: Infinity }).success).toBe(false);
    expect(parsePayload(CursorMoveSchema, { ...validCursor, y: NaN }).success).toBe(false);
  });

  it("rejects coordinates outside world bounds", () => {
    expect(parsePayload(CursorMoveSchema, { ...validCursor, x: 1e6 + 1 }).success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    expect(parsePayload(CursorMoveSchema, { ...validCursor, z: 0 }).success).toBe(false);
  });
});

// ─── ClearSchema ─────────────────────────────────────────────────────

describe("ClearSchema", () => {
  it("accepts a well-formed clear payload", () => {
    expect(parsePayload(ClearSchema, { roomId: validRoomId }).success).toBe(true);
  });

  it("rejects an invalid roomId", () => {
    expect(parsePayload(ClearSchema, { roomId: "no!" }).success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    expect(parsePayload(ClearSchema, { roomId: validRoomId, foo: "bar" }).success).toBe(false);
  });
});

// ─── parsePayload totality on adversarial input (Requirement 2.2) ────

describe("parsePayload never throws", () => {
  const schemas = [
    StrokeSegmentSchema,
    JoinRoomSchema,
    DrawSchema,
    CursorMoveSchema,
    ClearSchema,
  ];

  const adversarial: unknown[] = [
    undefined,
    null,
    0,
    "string",
    true,
    [],
    {},
    { roomId: 123 },
    Symbol("x"),
    () => undefined,
  ];

  it("returns a success/failure result for any input and schema", () => {
    for (const schema of schemas) {
      for (const input of adversarial) {
        const result = parsePayload(schema, input);
        expect(typeof result.success).toBe("boolean");
        if (!result.success) {
          expect(Array.isArray(result.issues)).toBe(true);
        }
      }
    }
  });
});
