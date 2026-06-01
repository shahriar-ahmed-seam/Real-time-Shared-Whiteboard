// ─── Stroke service (ordering + write-behind buffering) ──────────────
// The Stroke_Service owns stroke *policy*: it assigns each accepted stroke a
// gap-free, monotonic per-board Sequence_Number, enriches the validated wire
// segment into a PersistedStroke, buffers it in memory, and flushes batches to
// the durable Persistence_Store either when a batch fills (FLUSH_BATCH_SIZE) or
// after at most FLUSH_INTERVAL_MS. The StrokeRepository owns only the SQL; this
// service decides *what* and *when* to persist.
//
// Why write-behind: draw events arrive at high frequency (one per mouse-move
// segment). Persisting each synchronously would add per-event latency and
// connection pressure. Instead the broadcast to collaborators happens
// immediately (in the handler) while durability lags by at most one flush
// interval — and is guaranteed before a Graceful_Shutdown completes via
// {@link StrokeService.flush}.
//
// Requirements:
//   3.1 — append assigns a Sequence_Number exactly one greater than the
//         previous stroke's for that board (one past the baseline for the
//         first stroke), producing a consecutive, gap-free sequence.
//   3.2 — an accepted stroke is durably persisted within FLUSH_INTERVAL_MS
//         (or sooner when the batch fills, or before a Graceful_Shutdown).
//   3.3 — while a board's retained live stroke count exceeds STROKE_CAP,
//         maybeCompact advances the snapshot baseline to a cut point and
//         prunes the now-redundant prefix in bounded batches so the retained
//         count returns to <= STROKE_CAP, without changing the canvas a future
//         joiner reconstructs (snapshot + remaining tail).
//
// Reliability (Requirements 7.2, 7.6): a flush write that throws is retried with
// bounded exponential backoff. The failing batch is returned to the buffer (so no
// accepted stroke is lost) and the next attempt is scheduled on an unref'd timer
// with a delay that doubles each time, bounded between `retryBaseDelayMs` and
// `retryMaxDelayMs` (1s–30s by default). When the configured retry budget is
// exhausted the board's strokes stay buffered, the durable-persistence
// acknowledgment is withheld (the strokes are simply never marked persisted), and
// the board is flagged persistence-degraded so the readiness check
// ({@link StrokeService.isPersistenceHealthy}) can report not-ready until a later
// flush succeeds. The backoff is scheduled on timers rather than awaited inline so
// a single failing board never blocks `flush`/`flushAll` (the Graceful_Shutdown
// path) — the buffer is retained for recovery either way.

import { nanoid } from "nanoid";

import type { BoardRepository } from "../repositories/boardRepository";
import type { StrokeRepository } from "../repositories/strokeRepository";
import type { BoardSnapshot, PersistedStroke, StrokeSegment } from "../types/domain";
import { logger as defaultLogger, type Logger } from "../observability/logger";

/**
 * Fallback STROKE_CAP used when no `strokeCap` dependency is supplied. Mirrors
 * the validated env default (`STROKE_CAP` in {@link EnvSchema}) so the service
 * behaves identically whether the composition root wires the value explicitly
 * or relies on this default.
 */
const DEFAULT_STROKE_CAP = 50_000;

/**
 * Default flush-retry budget (Requirement 7.2): a failing flush is retried up to
 * this many additional times after the initial attempt before the board is
 * flagged persistence-degraded.
 */
const DEFAULT_MAX_FLUSH_RETRIES = 5;

/** Default lower bound for the exponential backoff delay (1 second). */
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

/** Default upper bound for the exponential backoff delay (30 seconds). */
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Per-board mutable state held in memory: the next Sequence_Number to assign,
 * the unflushed write buffer, the pending flush timer, and a memoized
 * initialization promise so the baseline is computed exactly once even under
 * concurrent appends.
 */
interface BoardState {
  /** Next Sequence_Number to hand out. Advanced synchronously on each append. */
  nextSeq: number;
  /** Strokes accepted but not yet durably persisted, in ascending seq order. */
  buffer: PersistedStroke[];
  /** Pending time-triggered flush, or null when none is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Pending backoff retry of a failed flush, or null when none is scheduled.
   * Distinct from {@link timer} (the normal interval flush) so a retry in flight
   * is not clobbered by — and does not clobber — interval scheduling.
   */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Resolves once {@link StrokeService.initBoard} has set {@link nextSeq}. */
  initPromise: Promise<void> | null;
  /**
   * Guards {@link StrokeService.maybeCompact} so at most one compaction runs per
   * board at a time. maybeCompact is invoked after every accepted draw, so two
   * concurrent draws crossing the cap must not both prune.
   */
  compacting: boolean;
  /**
   * Number of consecutive failed flush attempts for this board in the current
   * retry cycle. Reset to 0 on any successful flush. Drives the exponential
   * backoff delay and is compared against `maxFlushRetries` to decide when the
   * retry budget is exhausted (Requirement 7.2).
   */
  flushAttempts: number;
  /**
   * True once this board's flush retry budget has been exhausted without a
   * successful durable write. While true the board's strokes stay buffered (the
   * durable-persistence acknowledgment is withheld) and the readiness check
   * reads this via {@link StrokeService.isPersistenceHealthy} to report
   * not-ready (Requirement 7.6). Cleared on the next successful flush.
   */
  persistenceDegraded: boolean;
}

/** Constructor dependencies for {@link StrokeService}. */
export interface StrokeServiceDeps {
  strokeRepository: StrokeRepository;
  boardRepository: BoardRepository;
  /** Maximum delay before buffered strokes are flushed (FLUSH_INTERVAL_MS). */
  flushIntervalMs: number;
  /** Buffer length that triggers an immediate flush (FLUSH_BATCH_SIZE). */
  flushBatchSize: number;
  /**
   * Maximum number of live strokes retained per board before compaction kicks
   * in (STROKE_CAP). Optional so construction sites wired up in a later task can
   * omit it; defaults to {@link DEFAULT_STROKE_CAP}. Must be positive.
   */
  strokeCap?: number;
  /** Logger for flush failures; defaults to the shared application logger. */
  logger?: Pick<Logger, "error" | "warn" | "debug">;
  /** Stroke id generator; injectable for deterministic tests. Defaults to nanoid. */
  generateId?: () => string;
  /** Clock for stroke receive time; injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Maximum number of *retry* attempts after a failed flush before the board is
   * flagged persistence-degraded (Requirement 7.2). Defaults to
   * {@link DEFAULT_MAX_FLUSH_RETRIES} (5). Must be >= 0.
   */
  maxFlushRetries?: number;
  /**
   * Lower bound (and first delay) for the exponential backoff between flush
   * retries, in milliseconds. Defaults to {@link DEFAULT_RETRY_BASE_DELAY_MS}
   * (1s). Injectable so unit tests can use tiny delays.
   */
  retryBaseDelayMs?: number;
  /**
   * Upper bound for the exponential backoff between flush retries, in
   * milliseconds. Defaults to {@link DEFAULT_RETRY_MAX_DELAY_MS} (30s).
   * Injectable so unit tests can use tiny delays.
   */
  retryMaxDelayMs?: number;
  /**
   * Schedules a delayed retry callback and returns a handle to cancel it.
   * Injectable so tests can drive backoff deterministically without real time;
   * defaults to an unref'd {@link setTimeout} so a pending retry never keeps the
   * process alive on its own (the Graceful_Shutdown path flushes explicitly).
   */
  scheduleRetry?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  /** Cancels a handle returned by {@link scheduleRetry}. Defaults to clearTimeout. */
  cancelRetry?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Assigns ordering, buffers writes, and flushes batches to the Persistence_Store.
 *
 * Construct one per process; it tracks per-board buffers internally. The
 * gateway/draw handler (task 6.3) calls {@link append} then broadcasts the
 * returned stroke; the join handler (task 6.2) calls {@link loadForJoin}; the
 * Graceful_Shutdown sequence (task 8.1) calls {@link flushAll} (which fans out
 * to per-board {@link flush}).
 */
export class StrokeService {
  private readonly strokeRepository: StrokeRepository;
  private readonly boardRepository: BoardRepository;
  private readonly flushIntervalMs: number;
  private readonly flushBatchSize: number;
  private readonly strokeCap: number;
  private readonly logger: Pick<Logger, "error" | "warn" | "debug">;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly maxFlushRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly scheduleRetry: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancelRetry: (handle: ReturnType<typeof setTimeout>) => void;

  /** Per-board in-memory state, keyed by boardId. */
  private readonly boards = new Map<string, BoardState>();

  constructor(deps: StrokeServiceDeps) {
    this.strokeRepository = deps.strokeRepository;
    this.boardRepository = deps.boardRepository;
    this.flushIntervalMs = deps.flushIntervalMs;
    this.flushBatchSize = deps.flushBatchSize;
    // Guard against a non-positive override (the env loader already enforces a
    // positive value, but a direct test/construction could pass 0 or negative).
    this.strokeCap =
      deps.strokeCap !== undefined && deps.strokeCap > 0 ? deps.strokeCap : DEFAULT_STROKE_CAP;
    this.logger = deps.logger ?? defaultLogger;
    this.generateId = deps.generateId ?? (() => nanoid());
    this.now = deps.now ?? (() => Date.now());

    // Retry budget and backoff bounds (Requirement 7.2). Guard against
    // nonsensical overrides while still allowing 0 retries (fail fast → degrade).
    this.maxFlushRetries =
      deps.maxFlushRetries !== undefined && deps.maxFlushRetries >= 0
        ? Math.floor(deps.maxFlushRetries)
        : DEFAULT_MAX_FLUSH_RETRIES;
    const baseDelay =
      deps.retryBaseDelayMs !== undefined && deps.retryBaseDelayMs > 0
        ? deps.retryBaseDelayMs
        : DEFAULT_RETRY_BASE_DELAY_MS;
    const maxDelay =
      deps.retryMaxDelayMs !== undefined && deps.retryMaxDelayMs > 0
        ? deps.retryMaxDelayMs
        : DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryBaseDelayMs = baseDelay;
    // The ceiling can never be below the floor, regardless of overrides.
    this.retryMaxDelayMs = Math.max(baseDelay, maxDelay);
    this.scheduleRetry =
      deps.scheduleRetry ??
      ((fn, delayMs) => {
        const handle = setTimeout(fn, delayMs);
        // A pending retry must not keep the process alive on its own; the
        // Graceful_Shutdown sequence flushes explicitly before exit.
        handle.unref?.();
        return handle;
      });
    this.cancelRetry = deps.cancelRetry ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Buffer a validated stroke, assign it the next gap-free Sequence_Number, and
   * schedule durable persistence. Returns the enriched {@link PersistedStroke}
   * for the caller to broadcast.
   *
   * Preconditions: `seg` has already passed schema validation (handler
   * responsibility); `boardId` is the room the connection is authorized for.
   *
   * Postconditions:
   *  - the returned stroke's `seq` is exactly one greater than the previously
   *    appended stroke's `seq` for `boardId` (one past the baseline for the
   *    first stroke), so the sequence is strictly increasing and gap-free;
   *  - the stroke is present in the board's in-memory write buffer;
   *  - the stroke will be durably persisted within `flushIntervalMs` (or sooner
   *    if the batch fills), unless the process is killed non-gracefully;
   *  - the input `seg` object is not mutated.
   */
  async append(boardId: string, userId: string, seg: StrokeSegment): Promise<PersistedStroke> {
    const state = await this.ensureInitialized(boardId);

    // Assign the seq and advance the counter in one synchronous step (no await
    // between the read and the increment) so concurrent appends — which can
    // only interleave at await points — never observe the same seq. This is
    // what makes the sequence strictly increasing and gap-free.
    const seq = state.nextSeq;
    state.nextSeq = seq + 1;

    // Spread copies `seg` rather than mutating the caller's object.
    const stroke: PersistedStroke = {
      ...seg,
      id: this.generateId(),
      seq,
      userId,
      ts: this.now(),
    };

    state.buffer.push(stroke);

    if (state.buffer.length >= this.flushBatchSize) {
      // Size-triggered flush. Fire-and-forget so append stays low-latency;
      // durability is still bounded and failures are logged/retained.
      void this.flush(boardId).catch((err) => this.logFlushError(boardId, err));
    } else {
      this.ensureTimer(boardId, state);
    }

    return stroke;
  }

  /**
   * Load the board state a late joiner (or reconnecting client) needs: the
   * baseline snapshot, if any, plus the tail of strokes following it in
   * ascending Sequence_Number order.
   *
   * When `sinceSeq` is provided, only strokes after `max(sinceSeq, snapshotSeq)`
   * are returned, and the snapshot is included only when the client is behind
   * the compaction baseline (`sinceSeq < snapshotSeq`) or is joining fresh.
   *
   * Unflushed strokes still in the write buffer are merged in (deduplicated by
   * seq), so a just-drawn stroke is visible to a joiner before it has been
   * persisted.
   */
  async loadForJoin(
    boardId: string,
    sinceSeq?: number
  ): Promise<{ snapshot?: BoardSnapshot; strokes: PersistedStroke[] }> {
    const snapshotSeq = await this.boardRepository.getSnapshotSeq(boardId);

    // Strokes at or below the snapshot baseline are represented by the snapshot;
    // a reconnecting client that already applied past `sinceSeq` only needs the
    // strokes after it. Never read below the compaction baseline.
    const from = sinceSeq !== undefined ? Math.max(sinceSeq, snapshotSeq) : snapshotSeq;

    const persisted = await this.strokeRepository.loadSince(boardId, from);
    const strokes = this.mergeBufferedStrokes(boardId, persisted, from);

    const includeSnapshot = snapshotSeq > 0 && (sinceSeq === undefined || sinceSeq < snapshotSeq);
    const snapshot: BoardSnapshot | undefined = includeSnapshot
      ? { boardId, snapshotSeq, createdAt: this.now() }
      : undefined;

    return { snapshot, strokes };
  }

  /**
   * Enforce the per-board stroke cap (STROKE_CAP). When the durable retained
   * stroke count exceeds the cap, advance the board's compaction baseline
   * (`snapshot_seq`) to a cut point that keeps the most recent `STROKE_CAP / 2`
   * strokes live, then delete the now-redundant prefix in bounded batches so the
   * retained count returns to `<= STROKE_CAP`.
   *
   * Called by the draw handler (task 6.3) after each accepted stroke. It is a
   * best-effort, idempotent bounding operation:
   *  - It reads only the *persisted* count. Unflushed buffered strokes always
   *    carry the highest seqs (they are the most recently appended), so they are
   *    strictly greater than any computed cut point and are never pruned — no
   *    accepted stroke is lost. Deliberately not flushing here preserves the
   *    write-behind batching that makes high-frequency draws cheap; deferring a
   *    compaction by at most one flush interval is harmless given the cap's size.
   *  - A per-board `compacting` guard ensures only one compaction runs at a time,
   *    since two draws crossing the cap concurrently would both call this.
   *  - Failures are logged, not thrown: compaction must never fail the draw whose
   *    stroke was already persisted and broadcast. A failed run simply retries on
   *    the next draw, and the cut/delete steps are self-healing (a later run with
   *    a larger or equal cut point cleans up any prefix a partial run left behind).
   *
   * Postconditions (on success):
   *  - if the persisted count was `<= STROKE_CAP`, nothing changes;
   *  - otherwise `snapshot_seq` advances to `cutSeq`, strokes with `seq <= cutSeq`
   *    are deleted, and the retained count returns to `<= STROKE_CAP` (it lands at
   *    `KEEP_TAIL = floor(STROKE_CAP / 2)`, the hysteresis margin);
   *  - strokes with `seq > cutSeq` remain present and ordered, so the canvas a
   *    future joiner reconstructs from the baseline plus the retained tail is
   *    unchanged.
   *
   * Note: rasterizing the pruned prefix into a snapshot image
   * (`renderSnapshotImage` in the design) is optional and out of scope here; this
   * records the baseline `seq` only. Rebuilding the Redis "hot tail" cache is
   * likewise handled by the scaling layer, not this service — the in-memory write
   * buffer holds only `seq > cutSeq` strokes and so needs no rebuild.
   */
  async maybeCompact(boardId: string): Promise<void> {
    const state = await this.ensureInitialized(boardId);

    // Only one compaction per board at a time. maybeCompact is called after every
    // accepted draw, so concurrent draws crossing the cap must not both prune.
    if (state.compacting) {
      return;
    }

    const total = await this.strokeRepository.count(boardId);
    if (total <= this.strokeCap) {
      return; // Within budget — nothing to do.
    }

    state.compacting = true;
    try {
      // Hysteresis: keep the most recent half of the cap live so we are not
      // compacting on every subsequent stroke once the cap is first crossed.
      const keepTail = Math.max(1, Math.floor(this.strokeCap / 2));
      const snapshotSeq = await this.boardRepository.getSnapshotSeq(boardId);

      // The live tail is every stroke after the current baseline, ascending by
      // seq. Its Nth-from-last element gives the cut point that keeps `keepTail`
      // strokes live; strokes at or below it are baked into the new baseline.
      const tail = await this.strokeRepository.loadSince(boardId, snapshotSeq);
      const cutSeq =
        tail.length > keepTail ? tail[tail.length - keepTail - 1].seq : snapshotSeq;

      // 1. Record the baseline first, so even if deletion is interrupted, future
      //    joiners read from `cutSeq` and never see a half-pruned prefix.
      if (cutSeq > snapshotSeq) {
        await this.boardRepository.setSnapshot(boardId, cutSeq);
      }

      // 2. Delete the redundant prefix (seq <= cutSeq) in bounded batches — the
      //    repository already chunks the DELETE to keep lock footprints small.
      //    cutSeq >= snapshotSeq, so this also clears any prefix a previously
      //    interrupted run left behind, making the operation self-healing.
      await this.strokeRepository.deleteThrough(boardId, cutSeq);
    } catch (err) {
      this.logCompactError(boardId, err);
    } finally {
      state.compacting = false;
    }
  }

  /**
   * Force-flush a board's buffered strokes to the Persistence_Store. Called on
   * a full batch, by the interval timer, by the backoff retry, and by the
   * Graceful_Shutdown sequence.
   *
   * The buffer is captured and cleared synchronously before any await (inside
   * {@link drainOnce}), so concurrent flushes of the same board never write the
   * same strokes twice (a racing flush observes an empty buffer and returns). On
   * a write failure the captured strokes are returned to the buffer, a bounded
   * exponential-backoff retry is scheduled (Requirement 7.2), and the error is
   * rethrown so the caller (e.g. the shutdown sequence / {@link flushAll}) can
   * surface the partial failure — no accepted stroke is lost.
   *
   * A successful flush clears any prior persistence-degraded state for the
   * board; an exhausted retry budget sets it (Requirement 7.6), readable via
   * {@link isPersistenceHealthy}.
   */
  async flush(boardId: string): Promise<void> {
    const state = this.boards.get(boardId);
    if (!state) {
      return;
    }

    // A fresh, externally-triggered flush supersedes any pending interval flush
    // or scheduled backoff retry: this attempt drains the whole buffer now.
    this.cancelTimer(state);
    this.cancelRetryTimer(state);

    try {
      await this.drainOnce(boardId, state);
      this.markPersisted(state);
    } catch (err) {
      // drainOnce already re-buffered the failed batch. Schedule a bounded
      // backoff retry (or degrade if the budget is exhausted) and rethrow so the
      // caller still observes the failure.
      this.handleFlushFailure(boardId, state);
      throw err;
    }
  }

  /**
   * Report whether durable persistence is currently healthy. Returns `false`
   * when any board has exhausted its flush retry budget without a successful
   * write (its strokes remain buffered and the durable-persistence
   * acknowledgment is withheld). The readiness endpoint (task 8.3) reads this to
   * report not-ready until persistence recovers (Requirement 7.6).
   */
  isPersistenceHealthy(): boolean {
    for (const state of this.boards.values()) {
      if (state.persistenceDegraded) {
        return false;
      }
    }
    return true;
  }

  /**
   * Force-flush every board that currently holds buffered strokes. Invoked by
   * the Graceful_Shutdown sequence (task 8.1) so that every accepted-but-
   * unpersisted stroke is durably persisted before the process exits, with no
   * data loss on a deploy (Requirements 3.2, 7.1).
   *
   * Each board is flushed independently and *all* boards are attempted even if
   * one fails — a single board's persistence error must not strand the others'
   * buffers. Per-board {@link flush} already returns a board's strokes to its
   * in-memory buffer on failure, so unflushed strokes are retained for recovery
   * (Requirement 7.5). When one or more boards fail, an aggregated error is
   * rethrown so the shutdown sequence can surface the partial failure; boards
   * with an empty buffer are no-ops.
   */
  async flushAll(): Promise<void> {
    // Snapshot the board ids first so the buffer mutations inside flush() do not
    // disturb iteration over the live map.
    const boardIds = [...this.boards.keys()];

    const results = await Promise.allSettled(
      boardIds.map((boardId) => this.flush(boardId))
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length > 0) {
      const detail = failures
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join("; ");
      throw new Error(
        `flushAll failed for ${failures.length} of ${boardIds.length} board(s): ${detail}`
      );
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  /**
   * Capture-and-clear the board's buffer and write it durably in a single
   * attempt. Returns immediately when the buffer is empty. On failure the
   * captured batch is returned to the front of the buffer (preserving ascending
   * seq order) and the error is rethrown for the caller to handle (schedule a
   * retry / degrade). Kept private so `flush` owns the retry/ack policy.
   */
  private async drainOnce(boardId: string, state: BoardState): Promise<void> {
    if (state.buffer.length === 0) {
      return;
    }

    // Capture-and-clear is atomic (no await between the two lines), so a racing
    // flush observes an empty buffer and writes nothing twice.
    const batch = state.buffer;
    state.buffer = [];

    try {
      await this.strokeRepository.insertBatch(boardId, batch);
      await this.boardRepository.touch(boardId);
    } catch (err) {
      // Retain the strokes (failed batch first to preserve ascending seq order)
      // so no accepted stroke is lost and the retry can re-attempt them.
      state.buffer = batch.concat(state.buffer);
      throw err;
    }
  }

  /**
   * Record a successful durable write: clear the failed-attempt counter and any
   * persistence-degraded flag so the readiness check returns healthy again.
   */
  private markPersisted(state: BoardState): void {
    state.flushAttempts = 0;
    state.persistenceDegraded = false;
  }

  /**
   * React to a failed flush: increment the attempt counter and, while the retry
   * budget remains, schedule a bounded exponential-backoff retry. Once the
   * budget is exhausted, flag the board persistence-degraded (Requirement 7.6) —
   * the strokes stay buffered (durable-persistence ack withheld) and a later
   * interval flush or explicit flush can still recover them, clearing the flag.
   */
  private handleFlushFailure(boardId: string, state: BoardState): void {
    state.flushAttempts += 1;

    if (state.flushAttempts <= this.maxFlushRetries) {
      const delay = this.computeBackoffDelay(state.flushAttempts);
      this.scheduleRetryFlush(boardId, state, delay);
      this.logger.warn(
        `Flush failed for board "${boardId}" (attempt ${state.flushAttempts} of ` +
          `${this.maxFlushRetries + 1}); retrying in ${delay}ms`
      );
      return;
    }

    // Retry budget exhausted: withhold the durable-persistence acknowledgment by
    // keeping the strokes buffered and flag the board so readiness reports
    // not-ready until a subsequent flush succeeds.
    state.persistenceDegraded = true;
    this.logger.error(
      `Persistence degraded for board "${boardId}": flush failed after ` +
        `${this.maxFlushRetries + 1} attempts; ${state.buffer.length} stroke(s) ` +
        `retained in the write buffer and durable-persistence acknowledgment withheld`
    );
    // Keep trying in the background so the board self-heals when the store
    // recovers, without resetting the attempt counter (it only clears on a
    // successful write via markPersisted).
    this.scheduleRetryFlush(boardId, state, this.retryMaxDelayMs);
  }

  /**
   * Exponential backoff bounded to `[retryBaseDelayMs, retryMaxDelayMs]`
   * (1s–30s by default). Attempt 1 → base, doubling each subsequent attempt,
   * clamped at the ceiling (Requirement 7.2).
   */
  private computeBackoffDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** (attempt - 1);
    // Guard against overflow/NaN from a large attempt count before clamping.
    if (!Number.isFinite(exponential)) {
      return this.retryMaxDelayMs;
    }
    return Math.min(this.retryMaxDelayMs, Math.max(this.retryBaseDelayMs, exponential));
  }

  /**
   * Schedule a single backoff retry of {@link drainOnce} for the board on an
   * (injectable) timer. Replaces any pending retry. A successful retry clears
   * the degraded state; a further failure recurses through
   * {@link handleFlushFailure}.
   */
  private scheduleRetryFlush(boardId: string, state: BoardState, delayMs: number): void {
    this.cancelRetryTimer(state);
    state.retryTimer = this.scheduleRetry(() => {
      state.retryTimer = null;
      void this.drainOnce(boardId, state)
        .then(() => this.markPersisted(state))
        .catch(() => this.handleFlushFailure(boardId, state));
    }, delayMs);
  }

  /** Clear any pending backoff retry timer for the board. */
  private cancelRetryTimer(state: BoardState): void {
    if (state.retryTimer !== null) {
      this.cancelRetry(state.retryTimer);
      state.retryTimer = null;
    }
  }

  /**
   * Resolve (creating if needed) the board's in-memory state and ensure its
   * Sequence_Number baseline has been restored from the Persistence_Store. The
   * initialization promise is memoized so concurrent first appends share a
   * single baseline computation.
   *
   * Restart safety (Requirements 3.6, 3.9): the first access after a restart
   * triggers {@link initBoard}, which reads the board's persisted baseline +
   * tail from the store before any seq is assigned. If that read FAILS the
   * rejected promise is *not* cached — it is cleared so a later access can retry
   * the restore once the store recovers, rather than permanently wedging the
   * board on a transient error. {@link initBoard} also assigns `nextSeq` only
   * after every read has succeeded, so a failed restore never leaves a partial
   * (e.g. baseline-0) state behind for content to be served from.
   */
  private async ensureInitialized(boardId: string): Promise<BoardState> {
    let state = this.boards.get(boardId);
    if (!state) {
      // Created and stored synchronously, so concurrent callers in the same
      // tick share this exact state object.
      state = { nextSeq: 0, buffer: [], timer: null, retryTimer: null, initPromise: null, compacting: false, flushAttempts: 0, persistenceDegraded: false };
      this.boards.set(boardId, state);
    }
    // Narrow for the closure below (state is assigned exactly once above).
    const boardState = state;
    if (!boardState.initPromise) {
      // Memoize so concurrent first accesses share one restore. On failure,
      // clear the memoized promise (unless a newer attempt has already replaced
      // it) so the next access retries the Persistence_Store read instead of
      // re-throwing a cached rejection forever (Requirement 3.9: retain the
      // data and stay retry-able rather than serving a partial/empty baseline).
      const initPromise = this.initBoard(boardId, boardState).catch((err) => {
        if (boardState.initPromise === initPromise) {
          boardState.initPromise = null;
        }
        throw err;
      });
      boardState.initPromise = initPromise;
    }
    await boardState.initPromise;
    return boardState;
  }

  /**
   * Restore the per-board Sequence_Number baseline once from the
   * Persistence_Store: ensure the board row exists (the strokes table has a
   * foreign key to it), then derive the highest existing seq from the snapshot
   * baseline and the persisted tail. The next stroke is assigned one past that
   * highest value, satisfying the "one greater than the baseline" rule for the
   * first append.
   *
   * `state.nextSeq` is assigned only after every read resolves, so if any read
   * rejects (e.g. the Persistence_Store is unavailable on first access after a
   * restart) the method throws with the state left untouched at its initial
   * `nextSeq = 0`. The caller ({@link ensureInitialized}) then clears the
   * memoized promise so the restore can be retried — no partial baseline is
   * cached and no content is served from a half-restored board (Requirements
   * 3.6, 3.9).
   */
  private async initBoard(boardId: string, state: BoardState): Promise<void> {
    await this.boardRepository.ensure(boardId);
    const snapshotSeq = await this.boardRepository.getSnapshotSeq(boardId);
    const tail = await this.strokeRepository.loadSince(boardId, snapshotSeq);
    const highest = tail.length > 0 ? tail[tail.length - 1].seq : snapshotSeq;
    state.nextSeq = highest + 1;
  }

  /**
   * Merge persisted strokes with any unflushed buffered strokes for the board,
   * keeping only `seq > from`, deduplicating by seq, and returning them in
   * ascending seq order.
   */
  private mergeBufferedStrokes(
    boardId: string,
    persisted: PersistedStroke[],
    from: number
  ): PersistedStroke[] {
    const state = this.boards.get(boardId);
    if (!state || state.buffer.length === 0) {
      return persisted;
    }

    const seen = new Set(persisted.map((stroke) => stroke.seq));
    const buffered = state.buffer.filter((stroke) => stroke.seq > from && !seen.has(stroke.seq));
    if (buffered.length === 0) {
      return persisted;
    }

    return [...persisted, ...buffered].sort((a, b) => a.seq - b.seq);
  }

  /** Schedule a time-triggered flush if one is not already pending. */
  private ensureTimer(boardId: string, state: BoardState): void {
    if (state.timer !== null) {
      return;
    }
    const timer = setTimeout(() => {
      state.timer = null;
      void this.flush(boardId).catch((err) => this.logFlushError(boardId, err));
    }, this.flushIntervalMs);
    // Do not let a pending flush timer keep the process alive on its own; the
    // Graceful_Shutdown sequence flushes explicitly before exit.
    timer.unref?.();
    state.timer = timer;
  }

  /** Clear any pending flush timer for the board. */
  private cancelTimer(state: BoardState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private logFlushError(boardId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `Failed to flush buffered strokes for board "${boardId}": ${message}`
    );
  }

  private logCompactError(boardId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // Compaction is best-effort and retried on the next draw, so a failure is a
    // warning, not an error: the board stays correct, just temporarily over cap.
    this.logger.warn(
      `Failed to compact board "${boardId}": ${message}`
    );
  }
}
