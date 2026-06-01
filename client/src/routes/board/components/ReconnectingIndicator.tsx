import { Loader2 } from "lucide-react";

// ─── ReconnectingIndicator (Tier A — floating chrome) ─────────────────
// Non-blocking status pill shown only while the socket is down. pointer-events-
// none so it never obscures or disables the canvas; the parent unmounts it on
// reconnect. Announced politely to assistive tech.

export function ReconnectingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-4 z-50 mt-16 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-border bg-surface-1/95 px-4 py-2 shadow-[var(--shadow-md)] backdrop-blur-xl sm:mt-0"
    >
      <Loader2 className="h-4 w-4 animate-spin text-text-muted motion-reduce:animate-none" aria-hidden="true" />
      <span className="text-sm font-medium text-text">Reconnecting…</span>
    </div>
  );
}
