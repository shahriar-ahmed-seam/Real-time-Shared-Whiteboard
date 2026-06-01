import { useEffect, useState } from "react";
import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { cn } from "../../../components/ui/utils";

// ─── SyncStatusBadge (Tier A — low frequency) ─────────────────────────
// Subtle, non-blocking connection/sync indicator. Driven by the session
// store's `connected` flag: a brief "Syncing…" pulse on (re)connect, settling
// to "All changes saved"; "Reconnecting…" while down. Announced politely.

type SyncState = "saved" | "syncing" | "offline";

export function SyncStatusBadge({
  connected,
  compact = false,
}: {
  connected: boolean;
  compact?: boolean;
}) {
  // Detect a fresh (re)connection by adjusting state during render (React's
  // recommended pattern) rather than syncing in an effect, then run a single
  // timer to clear the transient "Syncing…" pulse.
  const [prevConnected, setPrevConnected] = useState(connected);
  const [justConnected, setJustConnected] = useState(false);

  if (connected !== prevConnected) {
    setPrevConnected(connected);
    if (connected) setJustConnected(true);
  }

  useEffect(() => {
    if (!justConnected) return;
    const t = window.setTimeout(() => setJustConnected(false), 1200);
    return () => window.clearTimeout(t);
  }, [justConnected]);

  const state: SyncState = !connected ? "offline" : justConnected ? "syncing" : "saved";

  const config: Record<
    SyncState,
    { label: string; Icon: typeof Cloud; tone: string; spin?: boolean }
  > = {
    saved: { label: "All changes saved", Icon: Cloud, tone: "text-text-muted" },
    syncing: { label: "Syncing…", Icon: RefreshCw, tone: "text-primary", spin: true },
    offline: { label: "Reconnecting…", Icon: CloudOff, tone: "text-danger" },
  };

  const { label, Icon, tone, spin } = config[state];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium", tone)}
    >
      <Icon
        className={cn("h-4 w-4 shrink-0", spin && "animate-spin motion-reduce:animate-none")}
        aria-hidden="true"
      />
      <span className={cn(compact && "sr-only")}>{label}</span>
    </div>
  );
}
