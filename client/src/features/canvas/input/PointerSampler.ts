import type { Point } from "../../../lib/coordinates";
import type { StrokeSegment } from "../../collaboration/transport/protocol";
import type { CanvasEngine } from "../engine/CanvasEngine";
import { StrokeBuilder, type Brush } from "./StrokeBuilder";

// ─── PointerSampler (Tier B — input, no React) ────────────────────────
// Attaches pointer/wheel listeners to the canvas and translates raw input into
// engine mutations. Drawing and panning mutate the engine directly; nothing
// here calls setState. Emissions to the network are handed to plain callbacks
// supplied by the collaboration layer.
//
// Pointer move is the highest-frequency local event. Each move:
//   1. emits a cursor frame (volatile, the collab layer throttles to the wire),
//   2. while drawing, builds a world-space segment, commits it locally (which
//      schedules a single coalesced paint), and emits it to the network.
// The engine's rAF loop guarantees at most one paint per frame no matter how
// many move events fire between frames.

export interface SamplerCallbacks {
  /** Current brush (color + on-screen width), resolved from the UI store. */
  getBrush: () => Brush;
  /** Emit a finished local segment to the network. */
  onSegment: (segment: StrokeSegment) => void;
  /** Emit the local cursor position (world space) to the network. */
  onCursor: (x: number, y: number) => void;
}

export class PointerSampler {
  private readonly builder = new StrokeBuilder();
  private panning = false;
  private panOrigin: { mx: number; my: number; tx: number; ty: number } | null = null;
  private detachers: Array<() => void> = [];

  private readonly canvas: HTMLCanvasElement;
  private readonly engine: CanvasEngine;
  private readonly cb: SamplerCallbacks;

  constructor(canvas: HTMLCanvasElement, engine: CanvasEngine, cb: SamplerCallbacks) {
    this.canvas = canvas;
    this.engine = engine;
    this.cb = cb;
  }

  /** Wire up all input listeners. Returns nothing; call {@link detach} to clean up. */
  attach(): void {
    const add = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type as string, handler as EventListener, opts);
      this.detachers.push(() =>
        target.removeEventListener(type as string, handler as EventListener, opts),
      );
    };

    add(this.canvas, "pointerdown", this.onDown);
    add(this.canvas, "pointermove", this.onMove);
    add(window, "pointerup", this.onUp);
    add(this.canvas, "wheel", this.onWheel, { passive: false });
    add(this.canvas, "contextmenu", (e) => e.preventDefault());
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  // ─── Geometry ─────────────────────────────────────────────────────

  private localPoint(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ─── Handlers ─────────────────────────────────────────────────────

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const screen = this.localPoint(e);

    // Pan with middle/right button or Alt+drag; otherwise draw.
    const isPan = e.button === 1 || e.button === 2 || e.altKey;
    if (isPan) {
      this.panning = true;
      const t = this.engine.viewport.get();
      this.panOrigin = { mx: screen.x, my: screen.y, tx: t.x, ty: t.y };
      this.canvas.style.cursor = "grabbing";
      this.canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    this.builder.begin(this.engine.viewport.toWorld(screen));
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    e.preventDefault();
    const screen = this.localPoint(e);
    const world = this.engine.viewport.toWorld(screen);

    // Always relay the cursor (collab layer throttles to the wire cadence).
    this.cb.onCursor(world.x, world.y);

    if (this.panning && this.panOrigin) {
      const o = this.panOrigin;
      this.engine.viewport.setTranslation(
        o.tx + (screen.x - o.mx),
        o.ty + (screen.y - o.my),
      );
      this.engine.markFull();
      return;
    }

    if (!this.builder.active) return;

    const brush = this.cb.getBrush();
    const segment = this.builder.extend(world, brush, this.engine.viewport.getScale());
    if (segment) {
      this.engine.commitLocal(segment);
      this.cb.onSegment(segment);
    }
  };

  private onUp = (): void => {
    this.builder.end();
    if (this.panning) {
      this.panning = false;
      this.panOrigin = null;
      this.canvas.style.cursor = "crosshair";
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    this.engine.viewport.zoomAround(anchor, factor);
    this.engine.markFull();
  };
}
