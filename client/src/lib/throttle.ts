// ─── Leading-edge time throttle ───────────────────────────────────────
// Bounds how often a function may run to once per `intervalMs`. Used for
// low-value, high-frequency side effects that should not ride the paint loop
// (e.g. emitting cursor frames to the network at a capped cadence).
//
// Hot-path *rendering* uses the rAF scheduler instead; this is for rate-capping
// outbound work where a fixed wall-clock interval is the right bound.

/** A throttled wrapper exposing a `cancel` to drop any trailing invocation. */
export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Cancel a pending trailing call. */
  cancel: () => void;
}

/**
 * Throttle `fn` to at most once per `intervalMs`. The leading call runs
 * immediately; subsequent calls within the window are coalesced into a single
 * trailing call fired at the window's end with the latest arguments.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
): Throttled<A> {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  const invoke = (args: A) => {
    last = Date.now();
    fn(...args);
  };

  const throttled = ((...args: A) => {
    const now = Date.now();
    const remaining = intervalMs - (now - last);

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(args);
      return;
    }

    // Within the window: remember the latest args for a single trailing call.
    pendingArgs = args;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pendingArgs) {
          const next = pendingArgs;
          pendingArgs = null;
          invoke(next);
        }
      }, remaining);
    }
  }) as Throttled<A>;

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  return throttled;
}
