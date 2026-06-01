import type { CanvasEngineRefs } from "../hooks/useCanvasEngine";

// ─── CanvasStage (Tier B mount point) ─────────────────────────────────
// Mounts the <canvas> and the remote-cursor overlay container ONCE and hands
// their refs to the engine. After mount this component never re-renders from
// drawing or cursor motion — the engine paints the canvas and mutates the
// overlay's DOM children imperatively. It is the full-bleed BASE layer; all UI
// chrome floats above it as independent siblings in the route.
//
// `touch-none` (touch-action: none) keeps one-finger draw/pan gestures from
// being hijacked by the browser's native scroll/zoom on touch devices.

export function CanvasStage({ canvasRef, cursorLayerRef }: CanvasEngineRefs) {
  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-crosshair touch-none"
      />
      {/* Remote-cursor overlay: DOM nodes positioned via compositor transforms,
          never React-reconciled. pointer-events-none so it never blocks input. */}
      <div
        ref={cursorLayerRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
      />
    </div>
  );
}
