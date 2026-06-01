// ─── Shared requestAnimationFrame batcher ─────────────────────────────
// One rAF loop for the whole app's high-frequency paint path. Many input and
// network events between two frames (pointermove, cursor-update, viewport
// changes) collapse into a SINGLE callback per frame, so work is coalesced to
// the display's cadence instead of running per event. This is the core of the
// "no layout thrashing" guarantee: callers request a frame; the scheduler runs
// each registered task at most once per frame.

/** A task invoked once per frame while scheduled. */
export type FrameTask = (now: number) => void;

/**
 * A frame scheduler. Register a task with {@link schedule}; it runs on the next
 * animation frame and then stops until requested again (`request`), giving an
 * on-demand loop that idles to zero cost when nothing is moving.
 */
export interface RafScheduler {
  /** Register a task. Returns an unregister function. */
  schedule: (task: FrameTask) => () => void;
  /** Request that the registered tasks run on the next frame. */
  request: () => void;
  /** Cancel any pending frame (tasks stay registered). */
  cancel: () => void;
}

/** Create an on-demand rAF scheduler. */
export function createRafScheduler(): RafScheduler {
  const tasks = new Set<FrameTask>();
  let frame: number | null = null;

  const tick = (now: number) => {
    frame = null;
    // Snapshot so a task unregistering itself mid-flush doesn't skip a sibling.
    for (const task of [...tasks]) task(now);
  };

  const request = () => {
    if (frame !== null) return;
    if (typeof requestAnimationFrame === "undefined") return;
    frame = requestAnimationFrame(tick);
  };

  const cancel = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const schedule = (task: FrameTask) => {
    tasks.add(task);
    return () => {
      tasks.delete(task);
      if (tasks.size === 0) cancel();
    };
  };

  return { schedule, request, cancel };
}
