// ─── Stroke sequence tracking & gap detection ──────────────────────────
// Pure, side-effect-free helpers that decide what a client should do with an
// incoming sequenced stroke. Extracted from useSocket so the apply/ignore/
// resync decision can be unit-tested in isolation (see task 10.4).
//
// The server stamps every persisted stroke with a monotonic, gap-free,
// per-board `seq` (Sequence_Number). The client tracks the highest seq it has
// applied and uses these helpers to keep its canvas ordered:
//
//   Requirement 4.4 — seq > last + 1  → request a resync (don't apply out of order)
//   Requirement 4.5 — seq = last + 1  → apply and advance the highest applied seq
//   Requirement 4.6 — seq <= last     → discard without re-applying

/** What the client should do with an incoming sequenced stroke. */
export type StrokeAction = "apply" | "ignore" | "resync";

/**
 * Decide how to handle a stroke given the highest seq already applied.
 *
 * - `"apply"`  — `incomingSeq` is exactly one past `lastAppliedSeq`; render it
 *   and advance the highest applied seq (Req 4.5).
 * - `"ignore"` — `incomingSeq` is less than or equal to `lastAppliedSeq`; it is
 *   a duplicate or already-applied stroke and must be discarded (Req 4.6).
 * - `"resync"` — `incomingSeq` is more than one past `lastAppliedSeq`; a stroke
 *   is missing, so request a resync instead of applying out of order (Req 4.4).
 *
 * A non-finite `incomingSeq` is treated as `"ignore"` so malformed input can
 * never trigger a resync storm or corrupt ordering.
 */
export function decideStrokeAction(
  lastAppliedSeq: number,
  incomingSeq: number,
): StrokeAction {
  if (!Number.isFinite(incomingSeq)) return "ignore";
  if (incomingSeq <= lastAppliedSeq) return "ignore";
  if (incomingSeq === lastAppliedSeq + 1) return "apply";
  return "resync";
}

/**
 * Return the highest finite `seq` among `strokes`, never below `current`.
 *
 * Used to advance the client's highest-applied seq after replaying a batch of
 * history (or a resync delta) so the next live stroke is judged against the
 * right baseline. Strokes without a numeric `seq` (legacy/unsequenced) are
 * skipped.
 */
export function highestSeq(
  strokes: ReadonlyArray<{ seq?: number }>,
  current = 0,
): number {
  let max = current;
  for (const s of strokes) {
    if (typeof s.seq === "number" && Number.isFinite(s.seq) && s.seq > max) {
      max = s.seq;
    }
  }
  return max;
}
