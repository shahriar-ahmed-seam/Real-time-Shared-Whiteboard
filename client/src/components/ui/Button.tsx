import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn, focusRing } from "./utils";

export type ButtonVariant = "primary" | "ghost" | "icon" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Required for icon-only buttons so assistive tech announces the action.
   * (Text alternative for a non-text control — Requirement 10.7.)
   */
  "aria-label"?: string;
  children?: ReactNode;
}

/**
 * Token-only styling. Colors come from `--color-*`, radius from `--radius-*`,
 * type scale from `--text-*`, motion from `--motion-*`/`--ease-*`. No hardcoded
 * hex or px literals: the 44px minimum touch target is expressed via the spacing
 * scale (`min-h-11` = 11 × 0.25rem = 44px).
 */
const base = cn(
  "inline-flex items-center justify-center gap-2 select-none",
  "font-sans font-semibold whitespace-nowrap",
  "rounded-md border",
  // >= 44x44px touch target (Requirement 10.5)
  "min-h-11 min-w-11",
  // Built-in, always-visible focus ring with >=3:1 contrast token (Req 10.6)
  focusRing,
  // Token-driven motion; respects reduced-motion via motion-reduce
  "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none",
  "disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
);

const variants: Record<ButtonVariant, string> = {
  primary: cn(
    "bg-primary border-primary text-text-on-primary",
    "hover:bg-primary-hover hover:border-primary-hover",
  ),
  danger: cn(
    "bg-danger border-danger text-text-strong",
    "hover:opacity-90",
  ),
  ghost: cn(
    "bg-surface-2 border-border text-text",
    "hover:bg-surface-1 hover:text-text-strong",
  ),
  icon: cn(
    "bg-transparent border-transparent text-text",
    "hover:bg-surface-2 hover:text-text-strong",
  ),
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-3 text-sm",
  md: "px-4 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", type, className, children, ...rest },
    ref,
  ) {
    // Icon buttons are square and ignore horizontal padding.
    const sizeClass = variant === "icon" ? "p-2" : sizes[size];
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(base, variants[variant], sizeClass, className)}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
