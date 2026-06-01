import { decideStrokeAction, highestSeq } from "./strokeSync";
import type { PersistedStroke } from "../transport/protocol";

// ─── ResyncController ─────────────────────────────────────────────────
// Owns the client's high-water mark (highest applied Sequence_Number) and the
// apply / ignore / resync decision for every inbound stroke. Pure orchestration
// over the property-tested strokeSync helpers — no socket or canvas coupling,
// just callbacks the collaboration hook wires up.
//
//   seq = last + 1  → apply  (render + advance high-water mark)   Req 4.5
//   seq <= last     → ignore (duplicate / already applied)        Req 4.6
//   seq > last + 1  → resync (gap; request replay, don't apply)   Req 4.4
//
// Legacy unsequenced strokes (no numeric seq) apply directly for compatibility.

export interface ResyncCallbacks {
  /** Render an in-order stroke on the canvas. */
  onApply: (stroke: PersistedStroke) => void;
  /** Ask the server to replay everything missed since the high-water mark. */
  onResync: (sinceSeq: number) => void;
}

export class ResyncController {
  private lastAppliedSeq = 0;
  private readonly cb: ResyncCallbacks;

  constructor(cb: ResyncCallbacks) {
    this.cb = cb;
  }

  /** Highest seq applied so far — the value to report on (re)join / resync. */
  get sinceSeq(): number {
    return this.lastAppliedSeq;
  }

  /** Reset the high-water mark (e.g. on leaving a room). */
  reset(): void {
    this.lastAppliedSeq = 0;
  }

  /** Handle one live `draw` stroke. */
  ingest(stroke: PersistedStroke): void {
    if (typeof stroke.seq !== "number") {
      // Legacy/unsequenced server: apply directly.
      this.cb.onApply(stroke);
      return;
    }

    const action = decideStrokeAction(this.lastAppliedSeq, stroke.seq);
    if (action === "apply") {
      this.cb.onApply(stroke);
      this.lastAppliedSeq = stroke.seq;
    } else if (action === "resync") {
      this.cb.onResync(this.lastAppliedSeq);
    }
    // "ignore" → drop silently.
  }

  /**
   * Adopt a history / resync batch as the new baseline. The batch arrives in
   * ascending seq order; the caller renders it, and this advances the
   * high-water mark to the highest seq delivered.
   */
  adoptBatch(strokes: ReadonlyArray<{ seq?: number }>): void {
    this.lastAppliedSeq = highestSeq(strokes, this.lastAppliedSeq);
  }
}
