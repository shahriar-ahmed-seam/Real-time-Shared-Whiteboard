import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { StrokeService } from "../../src/services/strokeService";
import type { BoardRepository } from "../../src/repositories/boardRepository";
import type { StrokeRepository } from "../../src/repositories/strokeRepository";
import type { BoardSnapshot, PersistedStroke, StrokeSegment } from "../../src/types/domain";

/**
 * Property 1: Sequence monotonicity (Requirement 3.1)
 *
 * For any sequence of `StrokeService.append` calls, the emitted `seq` values
 * are, per board, strictly increasing and gap-free (each is exactly one
 * greater than the previous emitted seq for that board). The first stroke
 * appended after a board baseline receives a seq exactly one greater than the
 * baseline's highest seq, where the baseline's highest seq is
 * `snapshotSeq + (count of persisted strokes following the snapshot)`.
 *
 * The test drives the real {@link StrokeService} against in-memory mock
 * repositories, varying: the number of boards, each board's pre-existing
 * snapshot baseline and persisted tail length, the flush batch size / interval
 * (so size- and time-triggered flushes interleave with appends), and the
 * interleaving of appends across boards. Both fully-sequential append streams
 * and bursts of concurrent appends to a single board are exercised — both are
 * "sequences of append calls" and both must preserve the invariant.
 *
 * **Validates: Requirements 3.1**
 */

// ─── In-memory mock repositories ─────────────────────────────────────

/**
 * In-memory {@link StrokeRepository}. Stores strokes per board sorted by seq
 * and deduplicated by seq (mirroring the production `ON CONFLICT (board_id,
 * seq) DO NOTHING`). Never throws, so the service's fire-and-forget flushes
 * resolve cleanly.
 */
class InMemoryStrokeRepository implements StrokeRepository {
  private readonly store = new Map<string, PersistedStroke[]>();

  /** Pre-seed a board's persisted tail (used to model a pre-existing log). */
  seed(boardId: string, strokes: PersistedStroke[]): void {
    const sorted = [...strokes].sort((a, b) => a.seq - b.seq);
    this.store.set(boardId, sorted);
  }

  async insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void> {
    const existing = this.store.get(boardId) ?? [];
    const bySeq = new Map(existing.map((s) => [s.seq, s]));
    for (const stroke of strokes) {
      // ON CONFLICT DO NOTHING: keep the first writer for a given seq.
      if (!bySeq.has(stroke.seq)) {
        bySeq.set(stroke.seq, stroke);
      }
    }
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    this.store.set(boardId, merged);
  }

  async loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]> {
    const all = this.store.get(boardId) ?? [];
    return all.filter((s) => s.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  async deleteThrough(boardId: string, throughSeq: number): Promise<void> {
    const all = this.store.get(boardId) ?? [];
    this.store.set(
      boardId,
      all.filter((s) => s.seq > throughSeq)
    );
  }

  async count(boardId: string): Promise<number> {
    return (this.store.get(boardId) ?? []).length;
  }
}

/**
 * In-memory {@link BoardRepository}. Tracks only the snapshot baseline (the
 * sole field {@link StrokeService} reads to compute the seq baseline); password
 * hash and touch are inert here.
 */
class InMemoryBoardRepository implements BoardRepository {
  private readonly snapshotSeqs = new Map<string, number>();

  /** Pre-seed a board's compaction baseline. */
  seedSnapshot(boardId: string, seq: number): void {
    this.snapshotSeqs.set(boardId, seq);
  }

  async ensure(boardId: string): Promise<void> {
    if (!this.snapshotSeqs.has(boardId)) {
      this.snapshotSeqs.set(boardId, 0);
    }
  }

  async getSnapshotSeq(boardId: string): Promise<number> {
    return this.snapshotSeqs.get(boardId) ?? 0;
  }

  async setSnapshot(boardId: string, seq: number): Promise<void> {
    this.snapshotSeqs.set(boardId, seq);
  }

  async getPasswordHash(): Promise<string | null> {
    return null;
  }

  async touch(): Promise<void> {
    // no-op: last-activity tracking is irrelevant to seq assignment.
  }
}

const noopLogger = { error() {}, warn() {}, debug() {} };

// ─── Generators ──────────────────────────────────────────────────────

/** A bounded, finite stroke segment. Values need not be schema-valid: append
 *  assumes validation already happened upstream and only assigns ordering. */
const segmentArb: fc.Arbitrary<StrokeSegment> = fc.record({
  x0: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  y0: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  x1: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  y1: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  color: fc.constantFrom("#000000", "#ff0000", "#00ff00", "rgb(1,2,3)"),
  width: fc.double({ min: 0.1, max: 200, noNaN: true }),
});

/** Per-board baseline: a snapshot seq plus a count of persisted strokes that
 *  follow it (seqs snapshotSeq+1 .. snapshotSeq+preExistingCount). */
const boardBaselineArb = fc.record({
  snapshotSeq: fc.nat({ max: 5000 }),
  preExistingCount: fc.nat({ max: 60 }),
});

/** A single append operation, targeting a board by (modular) index. */
const appendOpArb = fc.record({
  boardIndex: fc.nat({ max: 1000 }),
  userId: fc.constantFrom("u1", "u2", "u3", "u4"),
  seg: segmentArb,
});

/** A full scenario: flush tuning, a set of boards (each with a baseline), and
 *  an interleaved stream of append operations across those boards. */
const scenarioArb = fc.record({
  flushBatchSize: fc.integer({ min: 1, max: 50 }),
  flushIntervalMs: fc.integer({ min: 1, max: 1000 }),
  boards: fc.array(boardBaselineArb, { minLength: 1, maxLength: 4 }),
  appends: fc.array(appendOpArb, { maxLength: 250 }),
});

interface Scenario {
  flushBatchSize: number;
  flushIntervalMs: number;
  boards: { snapshotSeq: number; preExistingCount: number }[];
  appends: { boardIndex: number; userId: string; seg: StrokeSegment }[];
}

// ─── Harness ─────────────────────────────────────────────────────────

/** Build a service wired to freshly seeded in-memory repositories. */
function buildService(scenario: Scenario): {
  service: StrokeService;
  boardIds: string[];
} {
  const strokeRepo = new InMemoryStrokeRepository();
  const boardRepo = new InMemoryBoardRepository();
  const boardIds = scenario.boards.map((_, i) => `board-${i}`);

  scenario.boards.forEach((board, i) => {
    const id = boardIds[i];
    boardRepo.seedSnapshot(id, board.snapshotSeq);
    const seeded: PersistedStroke[] = [];
    for (let k = 1; k <= board.preExistingCount; k++) {
      seeded.push({
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        color: "#000000",
        width: 1,
        id: `seed-${id}-${k}`,
        seq: board.snapshotSeq + k,
        userId: "seed",
        ts: 0,
      });
    }
    strokeRepo.seed(id, seeded);
  });

  let idCounter = 0;
  const service = new StrokeService({
    strokeRepository: strokeRepo,
    boardRepository: boardRepo,
    flushIntervalMs: scenario.flushIntervalMs,
    flushBatchSize: scenario.flushBatchSize,
    logger: noopLogger,
    generateId: () => `gen-${idCounter++}`,
    now: () => 1_000,
  });

  return { service, boardIds };
}

/** Expected highest seq before any append: snapshot baseline + persisted tail. */
function baselineHighest(board: { snapshotSeq: number; preExistingCount: number }): number {
  return board.snapshotSeq + board.preExistingCount;
}

/** Assert a board's emitted seqs are strictly increasing and gap-free starting
 *  exactly one past the baseline. */
function assertMonotonicGapFree(emitted: number[], baseline: number): void {
  let prev = baseline;
  for (const seq of emitted) {
    expect(seq).toBe(prev + 1); // strictly increasing AND gap-free (consecutive)
    prev = seq;
  }
}

// ─── Properties ──────────────────────────────────────────────────────

describe("Property 1: Sequence_Number monotonicity", () => {
  it("sequential appends across boards emit strictly increasing, gap-free seq per board", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { service, boardIds } = buildService(scenario);
        const emittedByBoard = new Map<string, number[]>(boardIds.map((id) => [id, []]));

        for (const op of scenario.appends) {
          const id = boardIds[op.boardIndex % boardIds.length];
          const stroke = await service.append(id, op.userId, op.seg);
          emittedByBoard.get(id)!.push(stroke.seq);
        }

        scenario.boards.forEach((board, i) => {
          assertMonotonicGapFree(emittedByBoard.get(boardIds[i])!, baselineHighest(board));
        });
      }),
      { numRuns: 200 }
    );
  });

  it("concurrent appends to a single board emit a unique, gap-free, contiguous seq set", async () => {
    const concurrentArb = fc.record({
      flushBatchSize: fc.integer({ min: 1, max: 50 }),
      flushIntervalMs: fc.integer({ min: 1, max: 1000 }),
      baseline: boardBaselineArb,
      segments: fc.array(segmentArb, { minLength: 1, maxLength: 120 }),
    });

    await fc.assert(
      fc.asyncProperty(concurrentArb, async ({ flushBatchSize, flushIntervalMs, baseline, segments }) => {
        const scenario: Scenario = {
          flushBatchSize,
          flushIntervalMs,
          boards: [baseline],
          appends: [],
        };
        const { service, boardIds } = buildService(scenario);
        const id = boardIds[0];

        // Fire every append at once; resolution interleaves at await points.
        const strokes = await Promise.all(
          segments.map((seg, i) => service.append(id, `u${i % 4}`, seg))
        );

        const seqs = strokes.map((s) => s.seq).sort((a, b) => a - b);
        // No duplicates and contiguous from one past the baseline.
        const expectedFirst = baselineHighest(baseline) + 1;
        seqs.forEach((seq, i) => {
          expect(seq).toBe(expectedFirst + i);
        });
        expect(new Set(seqs).size).toBe(seqs.length);
      }),
      { numRuns: 100 }
    );
  });
});
