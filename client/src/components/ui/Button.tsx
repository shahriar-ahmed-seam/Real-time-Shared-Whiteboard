import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn, focusRing } from "./utils";

export type ButtonVariant = "primary" | "tonal" | "ghost" | "icon" | "danger";
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
  "font-sans font-medium whitespace-nowrap",
  // Material 3 pill geometry for the labelled variants.
  "rounded-full border",
  // >= 44x44px touch target (Requirement 10.5)
  "min-h-11 min-w-11",
  // Built-in, always-visible focus ring with >=3:1 contrast token (Req 10.6)
  focusRing,
  // Token-driven motion; respects reduced-motion via motion-reduce
  "transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none",
  // Material 3 state layer: a subtle press feedback that respects reduced motion.
  "active:scale-[0.98] motion-reduce:active:scale-100",
  "disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
);

const variants: Record<ButtonVariant, string> = {
  // Filled — the primary call to action. Elevates slightly on hover.
  primary: cn(
    "bg-primary border-primary text-text-on-primary shadow-[var(--shadow-1)]",
    "hover:bg-primary-hover hover:border-primary-hover hover:shadow-[var(--shadow-2)]",
  ),
  // Tonal — secondary emphasis on a tinted container (Material 3 "tonal").
  tonal: cn(
    "border-transparent text-primary",
    "bg-[color-mix(in_srgb,var(--color-primary)_12%,var(--color-surface-1))]",
    "hover:bg-[color-mix(in_srgb,var(--color-primary)_20%,var(--color-surface-1))]",
  ),
  danger: cn(
    "bg-danger border-danger text-text-on-primary shadow-[var(--shadow-1)]",
    "hover:opacity-90",
  ),
  // Outlined/ghost — quiet action on a hairline outline.
  ghost: cn(
    "bg-surface-1 border-border text-text",
    "hover:bg-surface-2 hover:text-text-strong",
  ),
  // Icon — circular, transparent, with a hover state layer. No fill at rest.
  icon: cn(
    "bg-transparent border-transparent text-text-muted",
    "hover:bg-[color-mix(in_srgb,var(--color-text-muted)_14%,transparent)] hover:text-text-strong",
  ),
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-3 text-sm",
  md: "px-5 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", type, className, children, ...rest },
    ref,
  ) {
    // Icon buttons are square (circular via rounded-full) and ignore padding.
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
