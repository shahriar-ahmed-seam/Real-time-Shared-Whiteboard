import { createStore, useStore } from "./createStore";

// ─── UI store (Tier A — low frequency) ────────────────────────────────
// Discrete drawing INTENT and chrome state: active tool, color, width, and
// which transient panels are open. These change on the order of seconds and are
// allowed to re-render the React tree. They are NOT on the canvas hot path —
// the engine reads the resolved brush via a getter at stroke-start time.

/** The active drawing tool. */
export type Tool = "pen" | "eraser";

export interface UiState {
  tool: Tool;
  /** Selected pen color (CSS color string; satisfies the server safe-color pattern). */
  color: string;
  /** Selected line width in world units. */
  width: number;
  /** Whether the color palette popover is open. */
  paletteOpen: boolean;
}

/** Canvas background — the eraser paints with this, so it is a rendering constant. */
export const CANVAS_BG = "#0a0a0f";

/** Selectable pen colors (application data, not theme tokens). */
export const PALETTE: readonly string[] = [
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f43f5e",
  "#10b981",
  "#6366f1",
];

/** Discrete line-width steps the +/- controls cycle through. */
export const WIDTH_STEPS: readonly number[] = [2, 4, 6, 10, 16];

/** Eraser stroke width in world units. */
export const ERASER_WIDTH = 24;

export const uiStore = createStore<UiState>({
  tool: "pen",
  color: "#ffffff",
  width: 4,
  paletteOpen: false,
});

/** The brush actually applied to the canvas, resolving the eraser to the bg color. */
export function resolveBrush(state: UiState): { color: string; width: number } {
  return state.tool === "eraser"
    ? { color: CANVAS_BG, width: ERASER_WIDTH }
    : { color: state.color, width: state.width };
}

// ─── Actions ──────────────────────────────────────────────────────────

export function setTool(tool: Tool): void {
  uiStore.set({ tool, paletteOpen: false });
}

export function setColor(color: string): void {
  uiStore.set({ color, tool: "pen", paletteOpen: false });
}

export function setPaletteOpen(paletteOpen: boolean): void {
  uiStore.set({ paletteOpen });
}

/** Step the line width by `dir` within the allowed steps (clamped at the ends). */
export function cycleWidth(dir: 1 | -1): void {
  uiStore.set((prev) => {
    const idx = WIDTH_STEPS.indexOf(prev.width);
    const start = idx === -1 ? 1 : idx;
    const next = Math.min(Math.max(start + dir, 0), WIDTH_STEPS.length - 1);
    return { width: WIDTH_STEPS[next] };
  });
}

// ─── Hooks ──────────────────────────────────────────────────────────────

export const useTool = () => useStore(uiStore, (s) => s.tool);
export const useColor = () => useStore(uiStore, (s) => s.color);
export const useWidth = () => useStore(uiStore, (s) => s.width);
export const usePaletteOpen = () => useStore(uiStore, (s) => s.paletteOpen);
