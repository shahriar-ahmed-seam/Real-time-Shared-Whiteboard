import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { StrokeService } from "../../src/services/strokeService";
import type { BoardRepository } from "../../src/repositories/boardRepository";
import type { StrokeRepository } from "../../src/repositories/strokeRepository";
import type { PersistedStroke, StrokeSegment } from "../../src/types/domain";

// Unit tests for Stroke_Service Sequence_Number assignment and write-behind
// buffer flushing (Requirements 3.1, 3.2).
//
// Coverage:
//   • seq starts exactly one past the board baseline (fresh board, an advanced
//     compaction snapshot baseline, and a persisted tail) — Requirement 3.1.
//   • buffered strokes flush to the (mocked) StrokeRepository when the buffer
//     reaches FLUSH_BATCH_SIZE — Requirement 3.2.
//   • buffered strokes flush after FLUSH_INTERVAL_MS via the interval timer,
//     exercised with vitest fake timers — Requirement 3.2.
//   • accepted strokes reach strokeRepository.insertBatch enriched with their
//     server-assigned id/seq/userId/ts — Requirements 3.1, 3.2.
//   • Property 2 (No stroke loss before flush boundary), graceful path: every
//     appended stroke is durably persisted exactly once after flush, with a
//     gap-free contiguous seq range and no duplicates.
//
// All repositories are in-memory fakes (no mocks of the service under test, no
// real database) so the tests validate the service's real buffering/ordering
// logic. The id generator and clock are injected for determinism.

// ─── In-memory fake repositories ─────────────────────────────────────

/**
 * In-memory StrokeRepository fake. Records every insertBatch call (with a
 * defensive copy of the batch) and stores persisted strokes per board so the
 * graceful no-loss path can be asserted against the durable view.
 *
 * The synchronous body (recording + store mutation) runs before any await, so
 * fire-and-forget batch flushes are observable deterministically without
 * extra ticks.
 */
class InMemoryStrokeRepository implements StrokeRepository {
  readonly insertBatchCalls: { boardId: string; strokes: PersistedStroke[] }[] = [];
  private readonly store = new Map<string, PersistedStroke[]>();

  async insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void> {
    this.insertBatchCalls.push({ boardId, strokes: strokes.map((s) => ({ ...s })) });
    const existing = this.store.get(boardId) ?? [];
    this.store.set(
      boardId,
      [...existing, ...strokes.map((s) => ({ ...s }))].sort((a, b) => a.seq - b.seq)
    );
  }

  async loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]> {
    return (this.store.get(boardId) ?? [])
      .filter((s) => s.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ ...s }));
  }

  async deleteThrough(boardId: string, throughSeq: number): Promise<void> {
    const existing = this.store.get(boardId) ?? [];
    this.store.set(boardId, existing.filter((s) => s.seq > throughSeq));
  }

  async count(boardId: string): Promise<number> {
    return (this.store.get(boardId) ?? []).length;
  }

  /** Test helper: every persisted stroke for a board, ascending by seq. */
  persisted(boardId: string): PersistedStroke[] {
    return (this.store.get(boardId) ?? []).slice().sort((a, b) => a.seq - b.seq);
  }

  /** Test helper: seed an already-persisted tail (e.g. after a restart). */
  seed(boardId: string, strokes: PersistedStroke[]): void {
    this.store.set(boardId, strokes.slice().sort((a, b) => a.seq - b.seq));
  }
}

/**
 * In-memory BoardRepository fake. Tracks the compaction baseline per board and
 * counts touch() calls so persistence acknowledgements can be observed.
 */
class InMemoryBoardRepository implements BoardRepository {
  readonly ensured = new Set<string>();
  private readonly snapshotSeq = new Map<string, number>();
  touchCount = 0;

  async ensure(boardId: string): Promise<void> {
    this.ensured.add(boardId);
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
    this.touchCount += 1;
  }

  /** Test helper: pretend the board already has a compaction baseline. */
  setBaseline(boardId: string, seq: number): void {
    this.snapshotSeq.set(boardId, seq);
  }
}

// ─── Fixtures / helpers ──────────────────────────────────────────────

const BOARD = "board-xyz123";
const USER = "user-1";

/** A deterministic, valid stroke segment; `n` varies the coordinates. */
function seg(n = 0): StrokeSegment {
  return { x0: n, y0: n, x1: n + 1, y1: n + 1, color: "#abcdef", width: 2 };
}

interface Harness {
  service: StrokeService;
  strokeRepo: InMemoryStrokeRepository;
  boardRepo: InMemoryBoardRepository;
}

/** Build a StrokeService over fresh in-memory repositories with injected id/clock. */
function makeHarness(opts: { flushIntervalMs: number; flushBatchSize: number }): Harness {
  const strokeRepo = new InMemoryStrokeRepository();
  const boardRepo = new InMemoryBoardRepository();
  let idCounter = 0;
  let clock = 1_700_000_000_000;
  const service = new StrokeService({
    strokeRepository: strokeRepo,
    boardRepository: boardRepo,
    flushIntervalMs: opts.flushIntervalMs,
    flushBatchSize: opts.flushBatchSize,
    // Silence flush-error logging in tests.
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    generateId: () => `stroke-${idCounter++}`,
    now: () => clock++,
  });
  return { service, strokeRepo, boardRepo };
}

/** Build a PersistedStroke for seeding a fake repository. */
function persistedStroke(seq: number): PersistedStroke {
  return { ...seg(seq), id: `seed-${seq}`, seq, userId: "seed-user", ts: seq };
}

// ─── Sequence_Number baseline (Requirement 3.1) ──────────────────────

describe("StrokeService.append — seq starts one past the baseline", () => {
  it("assigns seq 1 to the first stroke on a fresh board (baseline 0)", async () => {
    const { service } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });

    const stroke = await service.append(BOARD, USER, seg());

    expect(stroke.seq).toBe(1);
  });

  it("starts one past an advanced compaction snapshot baseline", async () => {
    const { service, boardRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });
    // Board has been compacted: strokes up to seq 10 are baked into the snapshot.
    boardRepo.setBaseline(BOARD, 10);

    const stroke = await service.append(BOARD, USER, seg());

    expect(stroke.seq).toBe(11);
  });

  it("starts one past the highest persisted stroke when a tail exists", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });
    // Restart scenario: strokes seq 1..5 already persisted, no compaction.
    strokeRepo.seed(BOARD, [1, 2, 3, 4, 5].map(persistedStroke));

    const stroke = await service.append(BOARD, USER, seg());

    expect(stroke.seq).toBe(6);
  });

  it("assigns strictly increasing, gap-free seqs across consecutive appends", async () => {
    const { service } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });

    const seqs: number[] = [];
    for (let i = 0; i < 8; i++) {
      seqs.push((await service.append(BOARD, USER, seg(i))).seq);
    }

    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("ensures the board row exists before assigning the baseline", async () => {
    const { service, boardRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });

    await service.append(BOARD, USER, seg());

    expect(boardRepo.ensured.has(BOARD)).toBe(true);
  });
});

// ─── Restore on restart + failure handling (Requirements 3.6, 3.9) ───

describe("StrokeService — board history restore on first access (Requirements 3.6, 3.9)", () => {
  it("restores the persisted baseline from the store before serving content", async () => {
    const { service, strokeRepo, boardRepo } = makeHarness({
      flushIntervalMs: 10_000,
      flushBatchSize: 100,
    });
    // Restart scenario: a compaction baseline plus a persisted tail already
    // exist in the store from before the (simulated) restart.
    boardRepo.setBaseline(BOARD, 10);
    strokeRepo.seed(BOARD, [11, 12, 13].map(persistedStroke));

    // First access after restart serves the restored history, not an empty one.
    const history = await service.loadForJoin(BOARD);
    expect(history.snapshot?.snapshotSeq).toBe(10);
    expect(history.strokes.map((s) => s.seq)).toEqual([11, 12, 13]);

    // ...and the seq baseline is restored so the next append continues the
    // sequence rather than restarting from 1.
    const next = await service.append(BOARD, USER, seg());
    expect(next.seq).toBe(14);
  });

  it("throws (does not serve partial/empty history) when the store read fails on join", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });

    vi.spyOn(strokeRepo, "loadSince").mockRejectedValueOnce(new Error("db down"));

    // loadForJoin must propagate the failure so the handler emits an error
    // indication rather than serving an empty/partial canvas (Requirement 3.9).
    await expect(service.loadForJoin(BOARD)).rejects.toThrow(/db down/);
  });

  it("does not assign a seq or buffer a stroke when the restore read fails", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 100 });

    vi.spyOn(strokeRepo, "loadSince").mockRejectedValueOnce(new Error("db down"));

    await expect(service.append(BOARD, USER, seg())).rejects.toThrow(/db down/);
    // Nothing was persisted or left buffered from the failed-restore attempt.
    expect(strokeRepo.insertBatchCalls).toHaveLength(0);
  });

  it("retries the restore on the next access after a transient failure (does not cache the rejection)", async () => {
    const { service, strokeRepo, boardRepo } = makeHarness({
      flushIntervalMs: 10_000,
      flushBatchSize: 100,
    });
    boardRepo.setBaseline(BOARD, 5);
    strokeRepo.seed(BOARD, [6, 7].map(persistedStroke));

    // First access fails (store transiently unavailable during restore)...
    vi.spyOn(strokeRepo, "loadSince").mockRejectedValueOnce(new Error("db down"));
    await expect(service.append(BOARD, USER, seg())).rejects.toThrow(/db down/);

    // ...the store recovers; the next access must retry the restore and succeed,
    // continuing the sequence from the restored baseline (not a wedged board).
    const stroke = await service.append(BOARD, USER, seg());
    expect(stroke.seq).toBe(8);
  });
});

// ─── Flush triggered by FLUSH_BATCH_SIZE (Requirement 3.2) ───────────

describe("StrokeService — flush triggered by batch size", () => {
  it("does not flush while the buffer is below the batch size", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 3 });

    await service.append(BOARD, USER, seg(0));
    await service.append(BOARD, USER, seg(1));

    expect(strokeRepo.insertBatchCalls).toHaveLength(0);
  });

  it("flushes the whole buffer in one batch when it reaches FLUSH_BATCH_SIZE", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 3 });

    await service.append(BOARD, USER, seg(0));
    await service.append(BOARD, USER, seg(1));
    await service.append(BOARD, USER, seg(2)); // reaches batch size → flush

    expect(strokeRepo.insertBatchCalls).toHaveLength(1);
    expect(strokeRepo.insertBatchCalls[0].boardId).toBe(BOARD);
    expect(strokeRepo.insertBatchCalls[0].strokes.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it("delivers strokes to the repository enriched with id, seq, userId, and ts", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 1 });

    const returned = await service.append(BOARD, USER, seg(42));

    expect(strokeRepo.insertBatchCalls).toHaveLength(1);
    const persisted = strokeRepo.insertBatchCalls[0].strokes[0];
    expect(persisted).toMatchObject({
      seq: 1,
      userId: USER,
      x0: 42,
      y0: 42,
      x1: 43,
      y1: 43,
      color: "#abcdef",
      width: 2,
    });
    expect(persisted.id).toBe(returned.id);
    expect(typeof persisted.ts).toBe("number");
  });

  it("starts a fresh buffer after a batch flush so later strokes are not re-persisted", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 10_000, flushBatchSize: 2 });

    await service.append(BOARD, USER, seg(0));
    await service.append(BOARD, USER, seg(1)); // flush batch [1,2]
    await service.append(BOARD, USER, seg(2)); // buffered, below batch size again

    expect(strokeRepo.insertBatchCalls).toHaveLength(1);
    expect(strokeRepo.insertBatchCalls[0].strokes.map((s) => s.seq)).toEqual([1, 2]);
  });
});

// ─── Flush triggered by FLUSH_INTERVAL_MS timer (Requirement 3.2) ────

describe("StrokeService — flush triggered by the interval timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flush before the flush interval elapses", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000, flushBatchSize: 100 });

    await service.append(BOARD, USER, seg());
    await vi.advanceTimersByTimeAsync(999);

    expect(strokeRepo.insertBatchCalls).toHaveLength(0);
  });

  it("flushes buffered strokes once the flush interval elapses", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000, flushBatchSize: 100 });

    await service.append(BOARD, USER, seg(0));
    await service.append(BOARD, USER, seg(1));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(strokeRepo.insertBatchCalls).toHaveLength(1);
    expect(strokeRepo.insertBatchCalls[0].strokes.map((s) => s.seq)).toEqual([1, 2]);
  });

  it("does not re-flush an empty buffer after the timer has fired", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000, flushBatchSize: 100 });

    await service.append(BOARD, USER, seg());
    await vi.advanceTimersByTimeAsync(1_000); // timer flush
    await vi.advanceTimersByTimeAsync(5_000); // no new strokes → no extra flush

    expect(strokeRepo.insertBatchCalls).toHaveLength(1);
  });
});

// ─── Property 2: No stroke loss before flush boundary (graceful path) ─

describe("StrokeService — Property 2 graceful path (no stroke loss across flush)", () => {
  // Property 2: every accepted stroke is durably persisted, with no loss and no
  // duplication, after a graceful flush. Exercised here across several batch
  // sizes and stroke counts so both auto-flushed batches and the final
  // graceful flush contribute to the durable view.
  it("persists every appended stroke exactly once with a gap-free seq range", async () => {
    const cases: { count: number; flushBatchSize: number }[] = [
      { count: 1, flushBatchSize: 5 },
      { count: 4, flushBatchSize: 5 },
      { count: 5, flushBatchSize: 5 },
      { count: 7, flushBatchSize: 5 },
      { count: 23, flushBatchSize: 4 },
      { count: 50, flushBatchSize: 10 },
    ];

    for (const { count, flushBatchSize } of cases) {
      const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000_000, flushBatchSize });
      const board = `board-${count}-${flushBatchSize}`;

      const appended: PersistedStroke[] = [];
      for (let i = 0; i < count; i++) {
        appended.push(await service.append(board, USER, seg(i)));
      }

      // Graceful shutdown: force-flush any remaining buffered strokes.
      await service.flush(board);

      const persisted = strokeRepo.persisted(board);

      // No loss and no duplication: persisted ids exactly equal appended ids.
      expect(persisted.map((s) => s.id).sort()).toEqual(appended.map((s) => s.id).sort());

      // seq range is contiguous and gap-free from 1..count, with no duplicates.
      const seqs = persisted.map((s) => s.seq);
      expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(new Set(seqs).size).toBe(count);
    }
  });

  it("leaves an empty buffer with nothing lost when flush is called with no pending strokes", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000_000, flushBatchSize: 5 });

    await service.append(BOARD, USER, seg(0));
    await service.flush(BOARD); // persists the single buffered stroke
    await service.flush(BOARD); // nothing left to persist

    expect(strokeRepo.insertBatchCalls).toHaveLength(1);
    expect(strokeRepo.persisted(BOARD).map((s) => s.seq)).toEqual([1]);
  });
});

// ─── flushAll across boards (Graceful_Shutdown — Requirements 3.2, 7.1, 7.5) ─

describe("StrokeService.flushAll — graceful shutdown flush of every board", () => {
  it("persists buffered strokes for every board that has a non-empty buffer", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000_000, flushBatchSize: 100 });

    await service.append("board-a", USER, seg(0));
    await service.append("board-a", USER, seg(1));
    await service.append("board-b", USER, seg(2));

    await service.flushAll();

    expect(strokeRepo.persisted("board-a").map((s) => s.seq)).toEqual([1, 2]);
    expect(strokeRepo.persisted("board-b").map((s) => s.seq)).toEqual([1]);
  });

  it("is a no-op when no boards have buffered strokes", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000_000, flushBatchSize: 100 });

    await service.flushAll();

    expect(strokeRepo.insertBatchCalls).toHaveLength(0);
  });

  it("does not re-persist boards whose buffers were already flushed", async () => {
    const { service, strokeRepo } = makeHarness({ flushIntervalMs: 1_000_000, flushBatchSize: 1 });

    // batch size 1 → each append auto-flushes, leaving empty buffers.
    await service.append("board-a", USER, seg(0));
    await service.append("board-b", USER, seg(1));
    expect(strokeRepo.insertBatchCalls).toHaveLength(2);

    await service.flushAll(); // buffers already empty → nothing more persisted

    expect(strokeRepo.insertBatchCalls).toHaveLength(2);
  });

  it("flushes the other boards and rethrows an aggregated error when one board fails", async () => {
    const { service, strokeRepo, boardRepo } = makeHarness({
      flushIntervalMs: 1_000_000,
      flushBatchSize: 100,
    });

    await service.append("board-ok", USER, seg(0));
    await service.append("board-bad", USER, seg(1));

    // Make the durable write fail only for the bad board.
    const original = strokeRepo.insertBatch.bind(strokeRepo);
    vi.spyOn(strokeRepo, "insertBatch").mockImplementation(async (boardId, strokes) => {
      if (boardId === "board-bad") {
        throw new Error("db down");
      }
      return original(boardId, strokes);
    });

    await expect(service.flushAll()).rejects.toThrow(/flushAll failed for 1 of 2/);

    // The healthy board was still persisted...
    expect(strokeRepo.persisted("board-ok").map((s) => s.seq)).toEqual([1]);
    // ...and the failed board's strokes are retained for recovery (re-buffered),
    // so a subsequent successful flush persists them with no loss.
    vi.restoreAllMocks();
    await service.flush("board-bad");
    expect(strokeRepo.persisted("board-bad").map((s) => s.seq)).toEqual([1]);
    // touch only fired for the boards whose batch actually persisted.
    expect(boardRepo.touchCount).toBeGreaterThanOrEqual(2);
  });
});
