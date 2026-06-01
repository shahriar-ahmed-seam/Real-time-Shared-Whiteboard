import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn, focusRing } from "./utils";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Visible, programmatically-associated label (Requirement 10.7). */
  label: string;
  /** Optional leading adornment (e.g. an icon). Marked aria-hidden. */
  leading?: ReactNode;
  /** Error message; sets aria-invalid and wires aria-describedby. */
  error?: string;
  /** Hide the label visually while keeping it for assistive tech. */
  hideLabel?: boolean;
  id?: string;
}

const field = cn(
  "w-full rounded-md border bg-surface-2 text-text",
  "font-sans text-base placeholder:text-text-muted",
  // >= 44px target height via spacing scale
  "min-h-11 px-4 py-2",
  focusRing,
  "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none",
  "disabled:opacity-50 disabled:pointer-events-none",
);

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, leading, error, hideLabel, id, className, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const errorId = `${inputId}-error`;
  const hasError = Boolean(error);

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={inputId}
        className={cn(
          "font-sans text-sm font-semibold text-text-muted",
          hideLabel && "sr-only",
        )}
      >
        {label}
      </label>
      <div className="relative flex items-center">
        {leading && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 flex items-center text-text-muted"
          >
            {leading}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : undefined}
          className={cn(
            field,
            leading ? "pl-11" : undefined,
            hasError && "border-danger",
            !hasError && "border-border",
            className,
          )}
          {...rest}
        />
      </div>
      {hasError && (
        <p id={errorId} className="font-sans text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
