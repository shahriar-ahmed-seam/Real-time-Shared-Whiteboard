import { cloneElement, useCallback, useEffect, useId, useRef } from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { cn, getFocusableElements } from "./utils";

type Align = "start" | "center" | "end";
type Side = "top" | "bottom";

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger element. Gets aria-haspopup/aria-expanded wired automatically. */
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  side?: Side;
  align?: Align;
  /** Accessible name for the popover surface. */
  "aria-label"?: string;
}

const sideClass: Record<Side, string> = {
  bottom: "top-full mt-2",
  top: "bottom-full mb-2",
};

const alignClass: Record<Align, string> = {
  start: "left-0",
  center: "left-1/2 -translate-x-1/2",
  end: "right-0",
};

/**
 * Popover with focus management (focus moves into the surface on open and
 * returns to the trigger on close), click-outside dismissal, and Esc to close.
 * Styling is token-only.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  side = "bottom",
  align = "start",
  ...rest
}: PopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const surfaceId = useId();

  /** The trigger is the first focusable element inside the container. */
  const focusTrigger = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const trig = container.querySelector<HTMLElement>("[aria-haspopup]");
    trig?.focus();
  }, []);

  // Move focus into the surface when it opens.
  useEffect(() => {
    if (!open) return;
    const surface = surfaceRef.current;
    if (surface) {
      const focusables = getFocusableElements(surface);
      (focusables[0] ?? surface).focus();
    }
  }, [open]);

  // Dismiss on outside click / outside focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onOpenChange]);

  const close = useCallback(() => {
    onOpenChange(false);
    focusTrigger();
  }, [onOpenChange, focusTrigger]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    },
    [close],
  );

  const triggerProps = trigger.props;
  // Inject ARIA + click toggling only (no ref) so we don't read refs at render.
  const wrappedTrigger = cloneElement(trigger, {
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? surfaceId : undefined,
    onClick: (e: MouseEvent) => {
      (triggerProps.onClick as ((e: MouseEvent) => void) | undefined)?.(e);
      onOpenChange(!open);
    },
  });

  return (
    <div ref={containerRef} className="relative inline-flex">
      {wrappedTrigger}
      {open && (
        <div
          ref={surfaceRef}
          id={surfaceId}
          role="dialog"
          aria-label={rest["aria-label"]}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={cn(
            "absolute z-50 min-w-44 outline-none",
            "rounded-md border border-border bg-surface-1 text-text",
            "p-2 shadow-[var(--shadow-md)]",
            sideClass[side],
            alignClass[align],
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
