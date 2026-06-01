import { useSyncExternalStore } from "react";

// ─── Minimal external store ───────────────────────────────────────────
// A framework-agnostic pub/sub store consumed through React's
// `useSyncExternalStore`. This is the backbone of the LOW-FREQUENCY (Tier A)
// state — active tool, session, presence membership, connection status — the
// state React is allowed to re-render on.
//
// The high-frequency canvas/cursor path deliberately does NOT use this; it
// mutates the imperative engine's buffers directly and never touches React.
//
// Selector subscriptions mean a component only re-renders when the specific
// slice it reads changes (referential equality on the selected value), not on
// every store write.

/** A read-only snapshot accessor plus an imperative setter and subscription. */
export interface Store<T> {
  /** Current state snapshot (stable reference until the next `set`). */
  get: () => T;
  /**
   * Replace state with a patch or an updater. A shallow merge is applied for
   * object state; the resulting reference changes so subscribers re-evaluate.
   */
  set: (patch: Partial<T> | ((prev: T) => Partial<T>)) => void;
  /** Subscribe to any state change. Returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

/** Create a store seeded with `initial`. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  const get = () => state;

  const set: Store<T>["set"] = (patch) => {
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { get, set, subscribe };
}

/** Identity selector used when a hook reads the whole snapshot. */
function identity<T>(value: T): T {
  return value;
}

/**
 * React binding for a {@link Store}. Re-renders the calling component only when
 * the value returned by `selector` changes (by `Object.is`). With no selector
 * the component subscribes to the entire snapshot.
 *
 * Because the store keeps a stable snapshot reference between writes, an unchanged
 * slice yields the same selected value and React skips the re-render.
 */
export function useStore<T extends object, S = T>(
  store: Store<T>,
  selector: (state: T) => S = identity as (state: T) => S,
): S {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
