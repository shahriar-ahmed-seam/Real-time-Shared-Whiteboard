import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { StrokeService } from "../../src/services/strokeService";
import type { BoardRepository } from "../../src/repositories/boardRepository";
import type { StrokeRepository } from "../../src/repositories/strokeRepository";
import type { PersistedStroke } from "../../src/types/domain";
// The client's real sequence-tracking helpers (exported, dependency-free) drive
// the simulated client so the property validates against the actual apply model
// rather than a re-implementation.
import { decideStrokeAction, highestSeq } from "../../../client/src/lib/strokeSync";

/**
 * Property 4: Resync convergence (Requirement 3.4)
 *
 * For any reported `lastAppliedSeq` and any server log (a snapshot baseline plus
 * a persisted, contiguous tail), after the reconnection resync the client's
 * highest applied Sequence_Number equals the server's highest Sequence_Number
 * for the board, and no stroke is applied more than once.
 *
 * **Validates: Requirements 3.4**
 *
 * ─── What is exercised ───────────────────────────────────────────────
 * The core of the resync handler (`server/src/handlers/resync.ts`) is the split
 * between a full "reload from baseline" and an ordered "delta", both served by
 * the real {@link StrokeService.loadForJoin}. This test drives that real method
 * against in-memory repositories and replicates only the handler's pure
 * normalize + decision logic (which is not exported), then applies the resulting
 * payload to a simulated client using the client's real apply helpers
 * ({@link decideStrokeAction}, {@link highestSeq}).
 *
 * The reported seq is generated to span every regime the design calls out:
 *   • below the compaction baseline (Req 3.7 → baseline reload),
 *   • inside the retained tail (Req 3.4 → ordered delta),
 *   • exactly equal to the server's highest seq (empty delta),
 *   • strictly above the server's highest seq (Req 3.8 → baseline reload),
 *   • zero, negative, and fractional (invalid → normalized to a baseline reload).
 */

// ─── In-memory mock repositories ─────────────────────────────────────

/**
 * In-memory {@link StrokeRepository}. Stores strokes per board sorted and
 * deduplicated by seq (mirroring the production `ON CONFLICT (board_id, seq) DO
 * NOTHING`). Only the read paths {@link StrokeService.loadForJoin} touches are
 * meaningful here; the rest satisfy the interface and never throw.
 */
class InMemoryStrokeRepository implements StrokeRepository {
  private readonly store = new Map<string, PersistedStroke[]>();

  /** Pre-seed a board's persisted tail (models the durable stroke log). */
  seed(boardId: string, strokes: PersistedStroke[]): void {
    this.store.set(boardId, [...strokes].sort((a, b) => a.seq - b.seq));
  }

  async insertBatch(boardId: string, strokes: PersistedStroke[]): Promise<void> {
    const existing = this.store.get(boardId) ?? [];
    const bySeq = new Map(existing.map((s) => [s.seq, s]));
    for (const stroke of strokes) {
      if (!bySeq.has(stroke.seq)) bySeq.set(stroke.seq, stroke);
    }
    this.store.set(boardId, [...bySeq.values()].sort((a, b) => a.seq - b.seq));
  }

  async loadSince(boardId: string, sinceSeq: number): Promise<PersistedStroke[]> {
    return (this.store.get(boardId) ?? [])
      .filter((s) => s.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  async deleteThrough(boardId: string, throughSeq: number): Promise<void> {
    const all = this.store.get(boardId) ?? [];
    this.store.set(boardId, all.filter((s) => s.seq > throughSeq));
  }

  async count(boardId: string): Promise<number> {
    return (this.store.get(boardId) ?? []).length;
  }
}

/**
 * In-memory {@link BoardRepository}. Tracks only the snapshot baseline, the sole
 * field {@link StrokeService.loadForJoin} reads.
 */
class InMemoryBoardRepository implements BoardRepository {
  private readonly snapshotSeqs = new Map<string, number>();

  seedSnapshot(boardId: string, seq: number): void {
    this.snapshotSeqs.set(boardId, seq);
  }

  async ensure(boardId: string): Promise<void> {
    if (!this.snapshotSeqs.has(boardId)) this.snapshotSeqs.set(boardId, 0);
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
    // no-op: last-activity tracking is irrelevant to resync reads.
  }
}

const noopLogger = { error() {}, warn() {}, debug() {} };

// ─── Handler decision (replicated from handlers/resync.ts) ───────────
// `normalizeSinceSeq` and the reload-vs-delta decision are not exported from
// the handler, so they are mirrored here verbatim. Keep in lockstep with
// `server/src/handlers/resync.ts`.

/** Mirror of `normalizeSinceSeq` in handlers/resync.ts. */
function normalizeSinceSeq(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return undefined;
  }
  return raw;
}

/** What the resync handler emits on `room-history` for a given report. */
interface ResyncOutcome {
  payload: { snapshot?: { snapshotSeq: number }; strokes: PersistedStroke[] };
  reloadFromBaseline: boolean;
  serverHighestSeq: number;
}

/**
 * Replicate the resync handler's flow against the real service: probe the
 * baseline once, normalize the reported seq, decide reload-vs-delta, and return
 * the payload the handler would emit. Mirrors `registerResync`'s body.
 */
async function runResync(
  service: StrokeService,
  boardId: string,
  reportedSeq: number,
): Promise<ResyncOutcome> {
  const baseline = await service.loadForJoin(boardId);
  const snapshotSeq = baseline.snapshot?.snapshotSeq ?? 0;
  const serverHighestSeq =
    baseline.strokes.length > 0
      ? baseline.strokes[baseline.strokes.length - 1].seq
      : snapshotSeq;

  const sinceSeq = normalizeSinceSeq(reportedSeq);
  const reloadFromBaseline =
    sinceSeq === undefined || sinceSeq < snapshotSeq || sinceSeq > serverHighestSeq;

  if (reloadFromBaseline) {
    // Handler reuses the baseline probe as the full-reload body (no second read).
    return { payload: baseline, reloadFromBaseline, serverHighestSeq };
  }

  const delta = await service.loadForJoin(boardId, sinceSeq);
  return { payload: delta, reloadFromBaseline, serverHighestSeq };
}

// ─── Simulated client apply model ────────────────────────────────────

interface ClientResult {
  /** Highest Sequence_Number the client has applied after the resync. */
  highest: number;
  /** Every stroke seq the client applied during this resync, in order. */
  appliedSeqs: number[];
  /** True if any delivered stroke was rejected as out-of-order/duplicate on the
   *  delta path (would break single-pass convergence). */
  sawNonApply: boolean;
}

/**
 * Apply a resync payload to a client that had previously applied up to
 * `reportedSeq`, using the client's real sequence-tracking helpers.
 *
 *  • Baseline reload (`clientResetCanvasTo` in the design): the client resets
 *    its high-water mark to the authoritative snapshot baseline and advances it
 *    over the delivered tail via {@link highestSeq}. The canvas is rebuilt from
 *    the snapshot, so the delivered strokes (all seq > snapshotSeq) are applied
 *    exactly once with no overlap against the baseline.
 *  • Ordered delta: the client feeds each delivered stroke through
 *    {@link decideStrokeAction} starting from its reported seq; every stroke must
 *    be an in-order "apply" for the canvases to converge in one pass.
 */
function applyResync(reportedSeq: number, outcome: ResyncOutcome): ClientResult {
  const { payload, reloadFromBaseline } = outcome;
  const appliedSeqs: number[] = [];

  if (reloadFromBaseline) {
    const baselineSeq = payload.snapshot?.snapshotSeq ?? 0;
    for (const s of payload.strokes) appliedSeqs.push(s.seq);
    // Reset to the snapshot baseline, then advance over the delivered tail.
    return {
      highest: highestSeq(payload.strokes, baselineSeq),
      appliedSeqs,
      sawNonApply: false,
    };
  }

  // Delta path: apply each stroke in order from the reported high-water mark.
  let cur = reportedSeq;
  let sawNonApply = false;
  for (const s of payload.strokes) {
    const action = decideStrokeAction(cur, s.seq);
    if (action === "apply") {
      appliedSeqs.push(s.seq);
      cur = s.seq;
    } else {
      sawNonApply = true;
    }
  }
  return { highest: cur, appliedSeqs, sawNonApply };
}

// ─── Harness ─────────────────────────────────────────────────────────

const BOARD = "resync-board";

/**
 * Build a StrokeService over freshly seeded in-memory repositories modeling a
 * server log: a snapshot baseline at `snapshotSeq` plus `tailCount` contiguous
 * persisted strokes (seqs `snapshotSeq+1 .. snapshotSeq+tailCount`).
 */
function buildService(snapshotSeq: number, tailCount: number): StrokeService {
  const strokeRepo = new InMemoryStrokeRepository();
  const boardRepo = new InMemoryBoardRepository();

  boardRepo.seedSnapshot(BOARD, snapshotSeq);
  const tail: PersistedStroke[] = [];
  for (let k = 1; k <= tailCount; k++) {
    const seq = snapshotSeq + k;
    tail.push({
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
      color: "#000000",
      width: 1,
      id: `seed-${seq}`,
      seq,
      userId: "seed",
      ts: 0,
    });
  }
  strokeRepo.seed(BOARD, tail);

  let idCounter = 0;
  return new StrokeService({
    strokeRepository: strokeRepo,
    boardRepository: boardRepo,
    flushIntervalMs: 1000,
    flushBatchSize: 50,
    logger: noopLogger,
    generateId: () => `gen-${idCounter++}`,
    now: () => 1_000,
  });
}

// ─── Generators ──────────────────────────────────────────────────────

/** A server log: a snapshot baseline and a contiguous persisted tail length. */
const logArb = fc.record({
  snapshotSeq: fc.nat({ max: 5000 }),
  tailCount: fc.nat({ max: 60 }),
});

/**
 * A full scenario: a server log plus a reported `lastAppliedSeq` drawn from a
 * distribution that covers every regime relative to the log's baseline and
 * highest seq.
 */
const scenarioArb = logArb.chain(({ snapshotSeq, tailCount }) => {
  const serverHighest = snapshotSeq + tailCount;

  const reportedArbs: fc.Arbitrary<number>[] = [
    fc.constant(0), // fresh client / invalid → reload
    fc.constant(serverHighest), // exactly the highest → empty delta
    fc.integer({ min: serverHighest + 1, max: serverHighest + 60 }), // above highest → reload (Req 3.8)
    fc.integer({ min: -60, max: -1 }), // negative → invalid → reload
    fc.integer({ min: -10, max: serverHighest + 70 }), // arbitrary integer
    // fractional → invalid → reload
    fc
      .double({ min: 0.01, max: serverHighest + 10, noNaN: true })
      .map((x) => (Number.isInteger(x) ? x + 0.5 : x)),
  ];
  // Below the compaction baseline (Req 3.7) — only when a baseline exists.
  if (snapshotSeq > 0) {
    reportedArbs.push(fc.integer({ min: 1, max: snapshotSeq }));
  }
  // Inside the retained tail (Req 3.4 ordered delta) — only when a tail exists.
  if (serverHighest > snapshotSeq) {
    reportedArbs.push(fc.integer({ min: snapshotSeq + 1, max: serverHighest }));
  }

  return fc.record({
    snapshotSeq: fc.constant(snapshotSeq),
    tailCount: fc.constant(tailCount),
    reportedSeq: fc.oneof(...reportedArbs),
  });
});

// ─── Property ────────────────────────────────────────────────────────

describe("Property 4: Resync convergence", () => {
  it("converges the client to the server's highest seq with no stroke applied twice", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ snapshotSeq, tailCount, reportedSeq }) => {
        const service = buildService(snapshotSeq, tailCount);
        // Independently computed server truth (contiguous tail on the baseline).
        const serverHighest = snapshotSeq + tailCount;

        const outcome = await runResync(service, BOARD, reportedSeq);

        // Cross-check the handler's own highest-seq computation against the truth.
        expect(outcome.serverHighestSeq).toBe(serverHighest);

        const { payload, reloadFromBaseline } = outcome;
        const deliveredSeqs = payload.strokes.map((s) => s.seq);

        // The delivered strokes are always strictly ascending and unique
        // (ascending Sequence_Number order; no stroke delivered twice).
        for (let i = 1; i < deliveredSeqs.length; i++) {
          expect(deliveredSeqs[i]).toBeGreaterThan(deliveredSeqs[i - 1]);
        }
        expect(new Set(deliveredSeqs).size).toBe(deliveredSeqs.length);

        if (reloadFromBaseline) {
          // Full authoritative reload: snapshot baseline (when compacted) plus
          // the entire retained tail, contiguous from snapshotSeq+1..highest.
          expect(payload.snapshot?.snapshotSeq ?? 0).toBe(snapshotSeq);
          const expectedTail = Array.from(
            { length: serverHighest - snapshotSeq },
            (_, i) => snapshotSeq + 1 + i,
          );
          expect(deliveredSeqs).toEqual(expectedTail);
          // Delivered strokes never overlap the compacted baseline.
          for (const seq of deliveredSeqs) expect(seq).toBeGreaterThan(snapshotSeq);
        } else {
          // Ordered delta: exactly the strokes after the reported seq, no
          // snapshot, contiguous from reportedSeq+1..highest.
          const sinceSeq = normalizeSinceSeq(reportedSeq) as number;
          expect(payload.snapshot).toBeUndefined();
          const expectedDelta = Array.from(
            { length: serverHighest - sinceSeq },
            (_, i) => sinceSeq + 1 + i,
          );
          expect(deliveredSeqs).toEqual(expectedDelta);
          // Nothing the client already applied is re-sent (no re-application).
          for (const seq of deliveredSeqs) expect(seq).toBeGreaterThan(sinceSeq);
        }

        const client = applyResync(reportedSeq, outcome);

        // Every delivered stroke was applied in order (no out-of-order/duplicate).
        expect(client.sawNonApply).toBe(false);
        // No stroke applied more than once during the resync.
        expect(new Set(client.appliedSeqs).size).toBe(client.appliedSeqs.length);
        // Convergence: client's highest applied seq equals the server's highest.
        expect(client.highest).toBe(serverHighest);
      }),
      { numRuns: 200 },
    );
  });
});
