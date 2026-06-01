import { describe, it, expect } from "vitest";
import { decideStrokeAction, highestSeq } from "../../src/lib/strokeSync";

/**
 * Unit tests for the client gap-detection ordering helpers.
 *
 * These cover the apply / ignore / resync decision branches the client uses to
 * keep its canvas ordered against the server's monotonic, gap-free per-board
 * Sequence_Number, plus the helper that advances the highest-applied seq.
 *
 * Requirement 4.4 — seq > last + 1  -> resync (don't apply out of order)
 * Requirement 4.5 — seq = last + 1  -> apply and advance
 * Requirement 4.6 — seq <= last     -> ignore (duplicate/old)
 */
describe("decideStrokeAction", () => {
  describe("apply: incoming seq is exactly one past the last applied (Req 4.5)", () => {
    it("applies the very first stroke after the baseline (0 -> 1)", () => {
      expect(decideStrokeAction(0, 1)).toBe("apply");
    });

    it("applies the next consecutive stroke mid-stream", () => {
      expect(decideStrokeAction(41, 42)).toBe("apply");
    });

    it("applies the next stroke past a negative baseline (-1 -> 0)", () => {
      expect(decideStrokeAction(-1, 0)).toBe("apply");
    });
  });

  describe("ignore: incoming seq is a duplicate or older stroke (Req 4.6)", () => {
    it("ignores an exact duplicate of the last applied seq", () => {
      expect(decideStrokeAction(42, 42)).toBe("ignore");
    });

    it("ignores a strictly older stroke", () => {
      expect(decideStrokeAction(42, 7)).toBe("ignore");
    });

    it("ignores the stroke immediately before the last applied", () => {
      expect(decideStrokeAction(42, 41)).toBe("ignore");
    });

    it("ignores a stroke at the baseline (0 -> 0)", () => {
      expect(decideStrokeAction(0, 0)).toBe("ignore");
    });
  });

  describe("resync: incoming seq leaves a gap (Req 4.4)", () => {
    it("requests resync when one stroke is missing (last + 2)", () => {
      expect(decideStrokeAction(0, 2)).toBe("resync");
    });

    it("requests resync when many strokes are missing", () => {
      expect(decideStrokeAction(42, 100)).toBe("resync");
    });

    it("requests resync for the smallest possible gap mid-stream", () => {
      expect(decideStrokeAction(41, 43)).toBe("resync");
    });
  });

  describe("ignore: non-finite incoming seq is rejected (no resync storm)", () => {
    it("ignores NaN", () => {
      expect(decideStrokeAction(5, Number.NaN)).toBe("ignore");
    });

    it("ignores positive Infinity", () => {
      expect(decideStrokeAction(5, Number.POSITIVE_INFINITY)).toBe("ignore");
    });

    it("ignores negative Infinity", () => {
      expect(decideStrokeAction(5, Number.NEGATIVE_INFINITY)).toBe("ignore");
    });
  });
});

describe("highestSeq", () => {
  it("returns the current baseline when there are no strokes", () => {
    expect(highestSeq([])).toBe(0);
    expect(highestSeq([], 7)).toBe(7);
  });

  it("advances to the maximum finite seq in the batch", () => {
    const strokes = [{ seq: 1 }, { seq: 5 }, { seq: 3 }];
    expect(highestSeq(strokes)).toBe(5);
  });

  it("never returns below the provided current value", () => {
    const strokes = [{ seq: 1 }, { seq: 2 }];
    expect(highestSeq(strokes, 10)).toBe(10);
  });

  it("uses the current value as the floor when strokes exceed it", () => {
    const strokes = [{ seq: 8 }, { seq: 12 }];
    expect(highestSeq(strokes, 10)).toBe(12);
  });

  it("skips unsequenced strokes that lack a numeric seq", () => {
    const strokes = [{ seq: 1 }, {}, { seq: 4 }, {}];
    expect(highestSeq(strokes)).toBe(4);
  });

  it("skips strokes with a non-finite seq", () => {
    const strokes = [
      { seq: 2 },
      { seq: Number.NaN },
      { seq: Number.POSITIVE_INFINITY },
      { seq: 6 },
    ];
    expect(highestSeq(strokes)).toBe(6);
  });

  it("returns the baseline when every stroke is unsequenced", () => {
    const strokes = [{}, {}, {}];
    expect(highestSeq(strokes, 3)).toBe(3);
  });
});
