import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { cn, focusRing } from "./utils";

type Orientation = "horizontal" | "vertical";

interface ToolbarContextValue {
  orientation: Orientation;
  /** The id of the single button currently in the tab order (roving tabindex). */
  activeId: string | null;
  /** Register/unregister a button element by stable id (called from an effect). */
  register: (id: string, el: HTMLButtonElement) => void;
  unregister: (id: string) => void;
  /** Mark a button active when it gains focus. */
  activate: (id: string) => void;
  /** Arrow/Home/End navigation, invoked from a button's key handler. */
  onItemKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

const ToolbarContext = createContext<ToolbarContextValue | null>(null);

export interface ToolbarProps {
  /** Accessible name for the toolbar group (Requirement 10.7). */
  "aria-label": string;
  orientation?: Orientation;
  children: ReactNode;
  className?: string;
}

/**
 * `role="toolbar"` container implementing a roving tabindex: only one button is
 * tabbable at a time, and arrow keys move focus between buttons (Home/End jump
 * to the ends). Styling is token-only.
 */
export function Toolbar({
  orientation = "horizontal",
  children,
  className,
  ...rest
}: ToolbarProps) {
  // Registered buttons keyed by stable id. Order is resolved from the DOM at
  // navigation time so it always matches reading order.
  const itemsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);

  const register = useCallback((id: string, el: HTMLButtonElement) => {
    itemsRef.current.set(id, el);
    // The first registered button becomes the initial tab stop.
    setActiveId((prev) => prev ?? id);
  }, []);

  const unregister = useCallback((id: string) => {
    itemsRef.current.delete(id);
    setActiveId((prev) => {
      if (prev !== id) return prev;
      const next = itemsRef.current.keys().next();
      return next.done ? null : next.value;
    });
  }, []);

  const activate = useCallback((id: string) => setActiveId(id), []);

  /** Return registered buttons sorted by their position in the document. */
  const orderedItems = useCallback(() => {
    return Array.from(itemsRef.current.entries())
      .filter(([, el]) => el.isConnected)
      .sort(([, a], [, b]) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      );
  }, []);

  const onItemKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      const items = orderedItems();
      const current = items.findIndex(([, el]) => el === e.currentTarget);
      if (current === -1) return;

      const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";

      let targetIndex: number | null = null;
      switch (e.key) {
        case next:
          targetIndex = (current + 1) % items.length;
          break;
        case prev:
          targetIndex = (current - 1 + items.length) % items.length;
          break;
        case "Home":
          targetIndex = 0;
          break;
        case "End":
          targetIndex = items.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const [id, el] = items[targetIndex];
      setActiveId(id);
      el.focus();
    },
    [orientation, orderedItems],
  );

  // Memoize the context value so the provider's identity stays stable across
  // renders. Without this, a new object on every render (e.g. when `activeId`
  // changes after arrow-key navigation) would change the context identity and
  // retrigger every ToolbarButton's register/unregister effect, resetting the
  // roving tabindex back to the first button. The value only changes when one
  // of its real inputs changes; the handlers are stable `useCallback`s.
  const contextValue = useMemo<ToolbarContextValue>(
    () => ({
      orientation,
      activeId,
      register,
      unregister,
      activate,
      onItemKeyDown,
    }),
    [orientation, activeId, register, unregister, activate, onItemKeyDown],
  );

  return (
    <ToolbarContext.Provider value={contextValue}>
      <div
        role="toolbar"
        aria-label={rest["aria-label"]}
        aria-orientation={orientation}
        className={cn(
          "inline-flex gap-2 rounded-lg border border-border bg-surface-1 p-2",
          orientation === "vertical" ? "flex-col" : "flex-row",
          className,
        )}
      >
        {children}
      </div>
    </ToolbarContext.Provider>
  );
}

export interface ToolbarButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required text alternative for icon-only toolbar buttons (Req 10.7). */
  "aria-label": string;
  /** Reflected as aria-pressed for toggle buttons (e.g. active tool). */
  active?: boolean;
}

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  function ToolbarButton(
    { active, className, children, type, onKeyDown, onFocus, ...rest },
    forwardedRef,
  ) {
    const ctx = useContext(ToolbarContext);
    const id = useId();
    const localRef = useRef<HTMLButtonElement | null>(null);

    const setRef = useCallback(
      (el: HTMLButtonElement | null) => {
        localRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
      [forwardedRef],
    );

    // Register with the toolbar for roving-tabindex bookkeeping. This must run
    // only on mount/unmount, so it depends on the stable `register`/`unregister`
    // callbacks rather than the whole `ctx` object. The context value's identity
    // changes whenever `activeId` changes (so consumers re-render to update
    // `tabIndex`); depending on `ctx` here would re-run register/unregister on
    // every arrow-key navigation and reset the roving tabindex to the first
    // button. The handlers are stable `useCallback`s, so this is mount-only.
    const register = ctx?.register;
    const unregister = ctx?.unregister;
    useEffect(() => {
      const el = localRef.current;
      if (!register || !unregister || !el) return;
      register(id, el);
      return () => unregister(id);
    }, [register, unregister, id]);

    // Roving tabindex driven by state (activeId), never by reading a ref during
    // render. When standalone (no toolbar), the button is normally tabbable.
    const tabIndex = ctx ? (ctx.activeId === id ? 0 : -1) : 0;

    return (
      <button
        ref={setRef}
        type={type ?? "button"}
        aria-pressed={active}
        tabIndex={tabIndex}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (!e.defaultPrevented) ctx?.onItemKeyDown(e);
        }}
        onFocus={(e) => {
          onFocus?.(e);
          ctx?.activate(id);
        }}
        className={cn(
          "inline-flex items-center justify-center min-h-11 min-w-11 p-2",
          "rounded-md border font-sans text-base",
          focusRing,
          "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none",
          "disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
          active
            ? "bg-primary border-primary text-text-on-primary"
            : "bg-transparent border-transparent text-text hover:bg-surface-2 hover:text-text-strong",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
