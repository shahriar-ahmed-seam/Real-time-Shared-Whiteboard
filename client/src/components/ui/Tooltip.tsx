import { cloneElement, useId, useState } from "react";
import type { FocusEvent, MouseEvent, ReactElement } from "react";
import { cn } from "./utils";

type Placement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  /** Tooltip text. Exposed via aria-describedby (not a bare title attribute). */
  label: string;
  placement?: Placement;
  /**
   * The single interactive child the tooltip describes. It must accept
   * focus/blur/mouse handlers and an `aria-describedby` prop.
   */
  children: ReactElement<Record<string, unknown>>;
}

const placementClass: Record<Placement, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

/**
 * Keyboard-accessible tooltip: appears on both hover and keyboard focus, and is
 * announced to assistive tech via `aria-describedby` (Requirement 10.7). Styling
 * is token-only.
 */
export function Tooltip({ label, placement = "top", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  const childProps = children.props;

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  const trigger = cloneElement(children, {
    "aria-describedby": open ? tooltipId : undefined,
    onMouseEnter: (e: MouseEvent) => {
      (childProps.onMouseEnter as ((e: MouseEvent) => void) | undefined)?.(e);
      show();
    },
    onMouseLeave: (e: MouseEvent) => {
      (childProps.onMouseLeave as ((e: MouseEvent) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: FocusEvent) => {
      (childProps.onFocus as ((e: FocusEvent) => void) | undefined)?.(e);
      show();
    },
    onBlur: (e: FocusEvent) => {
      (childProps.onBlur as ((e: FocusEvent) => void) | undefined)?.(e);
      hide();
    },
  });

  return (
    <span className="relative inline-flex">
      {trigger}
      <span
        id={tooltipId}
        role="tooltip"
        // Hidden from pointer/AT when not shown; kept in DOM so the
        // aria-describedby association is valid the moment it opens.
        hidden={!open}
        className={cn(
          "pointer-events-none absolute z-50 whitespace-nowrap",
          "rounded-sm border border-border bg-surface-2 text-text-strong",
          "px-3 py-1 text-sm font-sans shadow-[var(--shadow-md)]",
          placementClass[placement],
        )}
      >
        {label}
      </span>
    </span>
  );
}
