import { useCallback, useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn, getFocusableElements } from "./utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (wired via aria-labelledby). */
  title: string;
  children: ReactNode;
  /** Optional footer region (e.g. action buttons). */
  footer?: ReactNode;
  /** Allow closing by clicking the backdrop. Defaults to true. */
  closeOnBackdrop?: boolean;
}

/**
 * Accessible dialog: `role="dialog"`, `aria-modal`, labelled by its title,
 * Esc to close, focus trap while open, and focus restore to the previously
 * focused element on close. Styling is token-only.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  closeOnBackdrop = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Capture the element to restore focus to, then move focus into the dialog.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = getFocusableElements(dialog);
      (focusables[0] ?? dialog).focus();
    }

    return () => {
      // Restore focus to the trigger on close/unmount.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = getFocusableElements(dialog);
      if (focusables.length === 0) {
        // Keep focus on the dialog itself; nothing to tab to.
        e.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      // Wrap focus to trap it within the dialog (no keyboard escape).
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      // Material 3 scrim over content; click-outside closes when allowed.
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,#000_32%,transparent)] p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full max-w-md outline-none",
          "rounded-[var(--radius-xl)] border border-border bg-surface-3 text-text",
          "shadow-[var(--shadow-3)]",
          "p-6",
          "motion-safe:animate-[modal-in_var(--motion-base)_var(--ease-emphasized)]",
        )}
      >
        <h2
          id={titleId}
          className="font-sans text-xl font-semibold text-text-strong"
        >
          {title}
        </h2>
        <div className="mt-4 font-sans text-base text-text">{children}</div>
        {footer && (
          <div className="mt-6 flex items-center justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
