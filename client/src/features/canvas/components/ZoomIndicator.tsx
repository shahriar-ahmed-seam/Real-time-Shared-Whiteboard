import { useEffect, useState } from "react";
import { Move } from "lucide-react";
import type { CanvasEngine } from "../engine/CanvasEngine";

// ─── ZoomIndicator (Tier A — coarse poll, not on the pan/zoom hot path) ─
// Shows the current zoom percentage + interaction hint. The viewport scale
// lives in the imperative engine (Tier B); rather than re-rendering React on
// every wheel/pan frame, this polls the scale on a coarse interval and only
// re-renders when the rounded percentage actually changes. This deliberately
// trades sub-frame precision (irrelevant for a status chip) for zero coupling
// to the hot path.

const POLL_MS = 150;

export function ZoomIndicator({ engine }: { engine: CanvasEngine }) {
  const [pct, setPct] = useState(() => Math.round(engine.viewport.getScale() * 100));

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = Math.round(engine.viewport.getScale() * 100);
      setPct((prev) => (prev === next ? prev : next));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [engine]);

  return (
    <div className="hidden items-center gap-3 rounded-xl border border-border bg-surface-1/95 px-4 py-2.5 shadow-[var(--shadow-md)] backdrop-blur-xl sm:flex">
      <Move className="h-4 w-4 text-text-muted" aria-hidden="true" />
      <span className="font-mono text-sm font-semibold text-text">{pct}%</span>
      <span className="hidden text-xs text-text-muted md:inline">
        Alt+drag to pan · Scroll to zoom
      </span>
    </div>
  );
}
