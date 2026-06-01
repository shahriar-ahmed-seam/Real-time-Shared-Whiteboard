import { useEffect, useRef, useState } from "react";
import { CanvasEngine } from "../engine/CanvasEngine";

// ─── useCanvasEngine ──────────────────────────────────────────────────
// Owns the lifecycle of a single CanvasEngine for the board view. Creates the
// engine once, binds the <canvas> + cursor overlay on mount, observes the
// container for resize, and tears everything down on unmount. The engine
// instance is returned so the collaboration layer and toolbar actions can drive
// it imperatively — without ever re-rendering this component.

export interface CanvasEngineRefs {
  engine: CanvasEngine;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  cursorLayerRef: React.RefObject<HTMLDivElement | null>;
}

export function useCanvasEngine(): CanvasEngineRefs {
  // Lazy, stable singleton for this component's lifetime (created once).
  const [engine] = useState(() => new CanvasEngine());

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    engine.mount(canvas, cursorLayerRef.current ?? undefined);

    // Re-measure the backing store whenever the container box changes.
    const parent = canvas.parentElement;
    const observer =
      parent && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => engine.resize())
        : null;
    observer?.observe(parent!);

    const onWindowResize = () => engine.resize();
    window.addEventListener("resize", onWindowResize);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      engine.unmount();
    };
  }, [engine]);

  return { engine, canvasRef, cursorLayerRef };
}
