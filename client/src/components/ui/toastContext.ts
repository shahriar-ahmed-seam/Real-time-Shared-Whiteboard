import { createContext, useContext } from "react";

export type ToastVariant = "info" | "success" | "error";

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. Defaults to 4000. Pass 0 to persist. */
  duration?: number;
}

export interface ToastContextValue {
  /** Queue a toast. Returns its id. */
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/** Access the toast API. Must be used within a `ToastProvider`. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}
