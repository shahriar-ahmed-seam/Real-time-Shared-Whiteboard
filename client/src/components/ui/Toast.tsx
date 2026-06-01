import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./utils";
import { ToastContext } from "./toastContext";
import type { ToastOptions, ToastVariant } from "./toastContext";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

const variantClass: Record<ToastVariant, string> = {
  info: "border-border text-text",
  success: "border-success text-text-strong",
  error: "border-danger text-text-strong",
};

/**
 * Renders a polite live region (`role="status"` + `aria-live="polite"`) so
 * assistive tech announces transient messages (copy-link confirmation, errors)
 * without stealing focus. Errors use `role="alert"`/`assertive`. Token-only
 * styling.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = ++idRef.current;
    setToasts((prev) => [
      ...prev,
      {
        id,
        message: options.message,
        variant: options.variant ?? "info",
        duration: options.duration ?? 4000,
      },
    ]);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      {createPortal(
        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
          role="region"
          aria-label="Notifications"
        >
          {toasts.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastView({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    if (item.duration <= 0) return;
    const timer = window.setTimeout(() => onDismiss(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [item.id, item.duration, onDismiss]);

  const assertive = item.variant === "error";

  return (
    <div
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      className={cn(
        "pointer-events-auto max-w-sm rounded-md border bg-surface-2",
        "px-4 py-3 font-sans text-sm shadow-[var(--shadow-md)]",
        variantClass[item.variant],
      )}
    >
      {item.message}
    </div>
  );
}
