import type { StrokeSegment } from "../../collaboration/transport/protocol";
import { createRafScheduler, type RafScheduler } from "../../../lib/rafScheduler";
import { SceneStore } from "./SceneStore";
import { Viewport } from "./Viewport";
import { CursorLayer } from "./CursorLayer";
import { CANVAS_BG } from "../../../stores/uiStore";
import type { RoomUser } from "../../collaboration/transport/protocol";

// ─── CanvasEngine (Tier B — the React-bypassing renderer) ─────────────
// Owns the single <canvas> and the single rAF loop. Once the React component
// hands it the canvas element, React is OUT of the hot path: pointer input and
// inbound network strokes mutate the SceneStore / Viewport directly and request
// a frame; the engine reconciles pixels on its own tick.
//
// Rendering strategy — dirty-flag driven, two cost tiers:
//   • "full"   redraw (background + grid + every committed stroke). Triggered by
//     a viewport change, resize, history load, or clear. O(committed strokes).
//   • "append" redraw (stroke the newly-arrived segments only, in world space,
//     on top of the existing frame). Triggered per draw segment. O(new segments).
// Many events between two frames collapse into one tick, so a flood of input or
// remote strokes costs at most one paint per frame.

const GRID_SIZE = 40;
const GRID_DOT = "rgba(255,255,255,0.07)";

type Dirty = "none" | "append" | "full";

export class CanvasEngine {
  readonly scene = new SceneStore();
  readonly viewport = new Viewport();
  readonly cursors = new CursorLayer(this.viewport);

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;

  private readonly scheduler: RafScheduler = createRafScheduler();
  private unschedule: (() => void) | null = null;

  private dirty: Dirty = "none";
  /** Whether the cursor overlay needs repositioning this frame. */
  private cursorsDirty = false;
  /** Index into scene.all() of the first segment not yet painted to the canvas. */
  private paintedCount = 0;

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Bind the canvas element and start the frame loop. Idempotent per element. */
  mount(canvas: HTMLCanvasElement, cursorContainer?: HTMLElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (cursorContainer) this.cursors.mount(cursorContainer);
    this.unschedule = this.scheduler.schedule(() => this.flush());
    this.resize();
  }

  /** Detach and stop the loop. Safe to call repeatedly. */
  unmount(): void {
    this.unschedule?.();
    this.unschedule = null;
    this.scheduler.cancel();
    this.cursors.unmount();
    this.canvas = null;
    this.ctx = null;
  }

  // ─── Sizing ───────────────────────────────────────────────────────

  /** Re-measure the backing store to the parent box at the current DPR. */
  resize(): void {
    const canvas = this.canvas;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const rect = parent.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    this.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * this.dpr);
    canvas.height = Math.round(rect.height * this.dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    this.viewport.centerIfUnset(rect.width, rect.height);
    this.markFull();
  }

  // ─── Dirty marking + frame requests ───────────────────────────────

  /** Request a full repaint on the next frame. */
  markFull(): void {
    this.dirty = "full";
    // A viewport change moves every cursor too; reposition them this frame.
    this.cursorsDirty = true;
    this.scheduler.request();
  }

  /** Request an incremental append-paint on the next frame. */
  private markAppend(): void {
    if (this.dirty === "none") this.dirty = "append";
    this.scheduler.request();
  }

  // ─── Cursor overlay ───────────────────────────────────────────────

  /** Update remote cursor membership (color/name) and prune departed peers. */
  setCursorUsers(users: RoomUser[], myColor: string): void {
    this.cursors.setUsers(users, myColor);
    this.cursorsDirty = true;
    this.scheduler.request();
  }

  /** Record a remote cursor position and schedule a reposition. */
  setCursorPosition(socketId: string, x: number, y: number): void {
    this.cursors.setPosition(socketId, x, y);
    this.cursorsDirty = true;
    this.scheduler.request();
  }

  // ─── Stroke ingestion (local + remote) ────────────────────────────

  /** Commit one local segment and schedule it to be painted. */
  commitLocal(segment: StrokeSegment): void {
    this.scene.add(segment);
    this.markAppend();
  }

  /** Commit one remote (peer) segment and schedule it to be painted. */
  commitRemote(segment: StrokeSegment): void {
    this.scene.add(segment);
    this.markAppend();
  }

  /** Bulk-apply a history / resync batch, then full repaint once. */
  loadHistory(segments: readonly StrokeSegment[]): void {
    this.scene.addMany(segments);
    this.markFull();
  }

  /** Clear the board and repaint the empty surface. */
  clearBoard(): void {
    this.scene.clear();
    this.markFull();
  }

  // ─── Frame flush ──────────────────────────────────────────────────

  private flush(): void {
    if (this.dirty !== "none") {
      const mode = this.dirty;
      this.dirty = "none";
      if (mode === "full") this.renderFull();
      else this.renderAppend();
    }

    if (this.cursorsDirty) {
      this.cursorsDirty = false;
      this.cursors.render();
    }
  }

  /** Establish the world-space transform (DPR · pan · zoom) on the context. */
  private applyWorldTransform(ctx: CanvasRenderingContext2D): void {
    const t = this.viewport.get();
    ctx.setTransform(
      this.dpr * t.scale,
      0,
      0,
      this.dpr * t.scale,
      this.dpr * t.x,
      this.dpr * t.y,
    );
  }

  private renderFull(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const t = this.viewport.get();
    const cssW = canvas.width / this.dpr;
    const cssH = canvas.height / this.dpr;

    // Background (device space).
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, cssW, cssH);

    // Enter world space and draw the grid + every committed stroke.
    this.applyWorldTransform(ctx);
    this.renderGrid(ctx, t.scale, cssW, cssH);
    this.strokeSegments(ctx, this.scene.all());

    this.paintedCount = this.scene.size;
  }

  private renderAppend(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const segments = this.scene.all();
    if (this.paintedCount >= segments.length) return;

    // Paint only the not-yet-rendered tail, in world space, on top of the frame.
    this.applyWorldTransform(ctx);
    this.strokeSegments(ctx, segments.slice(this.paintedCount));
    this.paintedCount = segments.length;
  }

  private renderGrid(
    ctx: CanvasRenderingContext2D,
    scale: number,
    cssW: number,
    cssH: number,
  ): void {
    const t = this.viewport.get();
    const gx0 = Math.floor(-t.x / scale / GRID_SIZE) * GRID_SIZE - GRID_SIZE;
    const gy0 = Math.floor(-t.y / scale / GRID_SIZE) * GRID_SIZE - GRID_SIZE;
    const gx1 = gx0 + cssW / scale + GRID_SIZE * 3;
    const gy1 = gy0 + cssH / scale + GRID_SIZE * 3;
    const r = 1.5 / scale;

    ctx.fillStyle = GRID_DOT;
    for (let gx = gx0; gx < gx1; gx += GRID_SIZE) {
      for (let gy = gy0; gy < gy1; gy += GRID_SIZE) {
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private strokeSegments(
    ctx: CanvasRenderingContext2D,
    segments: readonly StrokeSegment[],
  ): void {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of segments) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }
  }

  /** The underlying canvas, for export (PNG/PDF). */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }
}
