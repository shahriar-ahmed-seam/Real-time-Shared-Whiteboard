import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { StrokeService } from "../../src/services/strokeService";
import type { BoardRepository } from "../../src/repositories/boardRepository";
import type { StrokeRepository } from "../../src/repositories/strokeRepository";
import type { PersistedStroke, StrokeSegment } from "../../src/types/domain";

// ─── Property 3: Compaction visual invariance ────────────────────────
//
// **Validates: Requirements 3.3**
//
// For any stroke log `L` and cap `C > 0`, compaction must not change the canvas
// a future joiner reconstructs: the strokes obtained from the baseline-
// represented prefix (everything with `seq <= snapshot_seq`) followed by the
// retained live tail (`seq > snapshot_seq`) must be exactly the same strokes, in
// the same Sequence_Number order, as the full pre-compaction log — and the
// retained live count must return to `<= STROKE_CAP`.
//
// ─── Modeling "visual invariance" without a rasterized snapshot ──────
// `maybeCompact` records the baseline as a `seq` cut point only (the optional
// `renderSnapshotImage` step is out of scope for this service), so there is no
// pixel image to diff. We therefore model the canvas as the *ordered set of
// strokes* a joiner applies, which is fully determined by Sequence_Number:
//
//   reconstructed(joiner) = { strokes with seq <= snapshot_seq, represented by
//                             the baseline } ++ { retained tail, seq > snapshot_seq }
//
// Two canvases are visually identical iff they apply the same strokes in the
// same seq order. The baseline faithfully represents the pruned prefix (that is
// the whole point of the snapshot), so we stand in for it with the prefix of the
// captured pre-compaction log whose seq <= snapshot_seq. Concatenated with the
// repository's surviving rows (the retained tail), this must reproduce the full
// log exactly. Because seqs are gap-free and strictly increasing, equality of
// the ordered seq lists (and stroke identities) is exactly canvas equality.

// ─── In-memory mock repositories ─────────────────────────────────────
// These model only what `maybeCompact` / `flush` touch, with the same
// observable contract as the PostgreSQL implementations: `insertBatch` is
// idempotent on `seq`, `loadSince` returns `seq > sinceSeq` ascending,
// `deleteThrough` prunes `seq <= throughSeq`, and `count` is the live total.

class MockStrokeRepository implements StrokeRepository {
  private readonly rows = new Map<string, PersistedStroke[]>();

  async insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void> {
    const arr = this.rows.get(boardId) ?? [];
    const seen = new Set(arr.map((s) => s.seq));
    for (const s of strokes) {
      // ON CONFLICT (board_id, seq) DO NOTHING — idempotent on seq.
      if (!seen.has(s.seq)) {
        arr.push(s);
        seen.add(s.seq);
      }
    }
    arr.sort((a, b) => a.seq - b.seq);
    this.rows.set(boardId, arr);
  }

  async loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]> {
    const arr = this.rows.get(boardId) ?? [];
    return arr.filter((s) => s.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  async deleteThrough(boardId: string, throughSeq: number): Promise<void> {
    const arr = this.rows.get(boardId) ?? [];
    this.rows.set(
      boardId,
      arr.filter((s) => s.seq > throughSeq)
    );
  }

  async count(boardId: string): Promise<number> {
    return (this.rows.get(boardId) ?? []).length;
  }

  /** Test helper: the surviving live tail, ascending by seq. */
  all(boardId: string): PersistedStroke[] {
    return [...(this.rows.get(boardId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}

class MockBoardRepository implements BoardRepository {
  private readonly snapshotSeq = new Map<string, number>();

  async ensure(boardId: string): Promise<void> {
    if (!this.snapshotSeq.has(boardId)) {
      this.snapshotSeq.set(boardId, 0);
    }
  }

  async getSnapshotSeq(boardId: string): Promise<number> {
    return this.snapshotSeq.get(boardId) ?? 0;
  }

  async setSnapshot(boardId: string, seq: number): Promise<void> {
    this.snapshotSeq.set(boardId, seq);
  }

  async getPasswordHash(): Promise<string | null> {
    return null;
  }

  async touch(): Promise<void> {
    /* no-op for this property */
  }
}

/** Silent logger so a best-effort compaction warning never spams test output. */
const silentLogger = { error: () => undefined, warn: () => undefined, debug: () => undefined };

// ─── Generators ──────────────────────────────────────────────────────

/** A single drawn segment. Content is arbitrary; only ordering matters here. */
const segmentArb: fc.Arbitrary<StrokeSegment> = fc.record({
  x0: fc.double({ min: -1_000, max: 1_000, noNaN: true }),
  y0: fc.double({ min: -1_000, max: 1_000, noNaN: true }),
  x1: fc.double({ min: -1_000, max: 1_000, noNaN: true }),
  y1: fc.double({ min: -1_000, max: 1_000, noNaN: true }),
  color: fc.constantFrom("#000000", "#ff0000", "#00ff00", "#0000ff", "#abcdef"),
  width: fc.double({ min: 0.5, max: 32, noNaN: true }),
});

/**
 * A scenario: a small cap (2–50) and a log strictly larger than the cap, so
 * compaction is guaranteed to trigger and we genuinely exercise the prune path.
 * `extra >= 1` keeps the log above the cap; the upper bound keeps runs cheap.
 */
const scenarioArb = fc
  .record({
    cap: fc.integer({ min: 2, max: 50 }),
    extra: fc.integer({ min: 1, max: 120 }),
  })
  .chain(({ cap, extra }) =>
    fc.record({
      cap: fc.constant(cap),
      segments: fc.array(segmentArb, { minLength: cap + extra, maxLength: cap + extra }),
    })
  );

describe("Property 3: Compaction visual invariance", () => {
  it("preserves the reconstructed canvas (snapshot baseline + retained tail == full log) and bounds the retained count to <= STROKE_CAP", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ cap, segments }) => {
        const strokeRepo = new MockStrokeRepository();
        const boardRepo = new MockBoardRepository();

        // Large flush thresholds so `append` never auto-flushes mid-loop; we
        // flush explicitly below to make the persisted count deterministic.
        let idCounter = 0;
        const service = new StrokeService({
          strokeRepository: strokeRepo,
          boardRepository: boardRepo,
          flushIntervalMs: 1_000_000,
          flushBatchSize: 1_000_000,
          strokeCap: cap,
          logger: silentLogger,
          generateId: () => `stroke-${idCounter++}`,
          now: () => 1_000,
        });

        const boardId = "board-compaction";

        // Append the whole log; capture each emitted PersistedStroke in order.
        const fullLog: PersistedStroke[] = [];
        for (const seg of segments) {
          fullLog.push(await service.append(boardId, "user-1", seg));
        }

        // Persist everything so the durable count reflects the full log; only
        // then can `maybeCompact` (which reads the persisted count) trigger.
        await service.flush(boardId);
        expect(await strokeRepo.count(boardId)).toBe(fullLog.length);

        await service.maybeCompact(boardId);

        const snapshotSeq = await boardRepo.getSnapshotSeq(boardId);
        const retainedTail = strokeRepo.all(boardId);

        // The log exceeds the cap, so compaction must have advanced the baseline.
        expect(snapshotSeq).toBeGreaterThan(0);

        // (a) Visual invariance: the baseline-represented prefix (seq <=
        //     snapshot_seq) followed by the retained tail reproduces the full
        //     pre-compaction log — same strokes, same seq order, no loss/dup.
        const baselinePrefix = fullLog.filter((s) => s.seq <= snapshotSeq);
        const reconstructed = [...baselinePrefix, ...retainedTail];

        expect(reconstructed.map((s) => s.seq)).toEqual(fullLog.map((s) => s.seq));
        expect(reconstructed.map((s) => s.id)).toEqual(fullLog.map((s) => s.id));

        // (b) Retained live count is bounded by the cap.
        expect(retainedTail.length).toBeLessThanOrEqual(cap);
        expect(retainedTail.length).toBeGreaterThan(0);

        // The retained rows are the highest-seq suffix of the log, contiguous
        // (gap-free) and ascending — they are the tail, never a pruned middle.
        const tailFromLog = fullLog.slice(fullLog.length - retainedTail.length);
        expect(retainedTail.map((s) => s.seq)).toEqual(tailFromLog.map((s) => s.seq));
        for (let i = 1; i < retainedTail.length; i++) {
          expect(retainedTail[i].seq).toBe(retainedTail[i - 1].seq + 1);
        }

        // The baseline and the retained tail partition the log with no overlap.
        expect(baselinePrefix.length + retainedTail.length).toBe(fullLog.length);
      }),
      { numRuns: 100 }
    );
  });
});
