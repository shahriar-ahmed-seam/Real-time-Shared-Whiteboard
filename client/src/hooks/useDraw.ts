import { useRef, useCallback, useEffect, useState } from "react";

export interface DrawStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
}

// ─── FULL REWRITE ────────────────────────────────────────────────────
// Removed world-coordinate abstraction that was corrupting the 2D context
// transform stack. Now uses a single clean setTransform(dpr) per frame.

export interface Transform {
  x: number;
  y: number;
  scale: number;
}

interface UseDrawOptions {
  onDraw: (stroke: DrawStroke) => void;
  onCursorMove: (x: number, y: number) => void;
}

const BG = "#0a0a0f";
const GRID_SIZE = 40;

export function useDraw({ onDraw, onCursorMove }: UseDrawOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // All strokes in world-space
  const strokesRef = useRef<DrawStroke[]>([]);

  // Draw tool settings
  const colorRef = useRef("#ffffff");
  const widthRef = useRef(4);

  // Pan + zoom — ref so event closures always read latest value
  const panRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const [transform, setTransformState] = useState<Transform>({ x: 0, y: 0, scale: 1 });

  // Interaction flags
  const isDrawingRef = useRef(false);
  const isPanningRef = useRef(false);
  const lastWorldRef = useRef<{ x: number; y: number } | null>(null);
  const panOriginRef = useRef<{ mx: number; my: number; tx: number; ty: number } | null>(null);

  const setDrawSettings = useCallback((color: string, width: number) => {
    colorRef.current = color;
    widthRef.current = width;
  }, []);

  // ─── Screen → World conversion ───────────────────────────────────
  const toWorld = (sx: number, sy: number) => {
    const t = panRef.current;
    return { x: (sx - t.x) / t.scale, y: (sy - t.y) / t.scale };
  };

  // ─── Get pointer position relative to canvas ────────────────────
  const getPos = (e: MouseEvent | TouchEvent) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    if ("touches" in e) {
      const touch = (e as TouchEvent).touches[0] || (e as TouchEvent).changedTouches[0];
      return { x: touch.clientX - r.left, y: touch.clientY - r.top };
    }
    return { x: (e as MouseEvent).clientX - r.left, y: (e as MouseEvent).clientY - r.top };
  };

  // ─── Full redraw ─────────────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    const t = panRef.current;

    // ① Reset transform to: device-pixel identity (handles HiDPI)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ② Background fill
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);

    // ③ Enter world space (pan + zoom applied on top of DPR)
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);

    // ④ Dot grid
    const gx0 = Math.floor((-t.x / t.scale) / GRID_SIZE) * GRID_SIZE - GRID_SIZE;
    const gy0 = Math.floor((-t.y / t.scale) / GRID_SIZE) * GRID_SIZE - GRID_SIZE;
    const gx1 = gx0 + cssW / t.scale + GRID_SIZE * 3;
    const gy1 = gy0 + cssH / t.scale + GRID_SIZE * 3;

    ctx.fillStyle = "rgba(255,255,255,0.07)";
    for (let gx = gx0; gx < gx1; gx += GRID_SIZE) {
      for (let gy = gy0; gy < gy1; gy += GRID_SIZE) {
        ctx.beginPath();
        ctx.arc(gx, gy, 1.5 / t.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ⑤ Draw all strokes
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokesRef.current) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }

    ctx.restore();
  }, []);

  // ─── Add a stroke from remote or local ──────────────────────────
  const drawStroke = useCallback((stroke: DrawStroke) => {
    strokesRef.current.push(stroke);
    redraw();
  }, [redraw]);

  // ─── Clear board ────────────────────────────────────────────────
  const clearCanvas = useCallback(() => {
    strokesRef.current = [];
    redraw();
  }, [redraw]);

  // ─── Setup / resize canvas ───────────────────────────────────────
  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const r = parent.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;

    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;

    // Center world origin on first load only
    if (panRef.current.x === 0 && panRef.current.y === 0) {
      panRef.current = { x: r.width / 2, y: r.height / 2, scale: 1 };
      setTransformState({ ...panRef.current });
    }

    redraw();
  }, [redraw]);

  // ─── Event listeners ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onDown = (e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      const pos = getPos(e);

      // Pan: middle-click, right-click, or Alt+drag
      const isPan =
        e instanceof MouseEvent &&
        (e.button === 1 || e.button === 2 || e.altKey);

      if (isPan) {
        isPanningRef.current = true;
        panOriginRef.current = {
          mx: pos.x, my: pos.y,
          tx: panRef.current.x, ty: panRef.current.y,
        };
        canvas.style.cursor = "grabbing";
        return;
      }

      isDrawingRef.current = true;
      lastWorldRef.current = toWorld(pos.x, pos.y);
    };

    const onMove = (e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      const pos = getPos(e);

      // Always emit cursor
      const wc = toWorld(pos.x, pos.y);
      onCursorMove(wc.x, wc.y);

      // Panning
      if (isPanningRef.current && panOriginRef.current) {
        const o = panOriginRef.current;
        panRef.current = {
          ...panRef.current,
          x: o.tx + (pos.x - o.mx),
          y: o.ty + (pos.y - o.my),
        };
        setTransformState({ ...panRef.current });
        redraw();
        return;
      }

      // Drawing
      if (!isDrawingRef.current || !lastWorldRef.current) return;

      const world = toWorld(pos.x, pos.y);
      const stroke: DrawStroke = {
        x0: lastWorldRef.current.x,
        y0: lastWorldRef.current.y,
        x1: world.x,
        y1: world.y,
        color: colorRef.current,
        width: widthRef.current / panRef.current.scale,
      };

      strokesRef.current.push(stroke);
      redraw();
      onDraw(stroke);
      lastWorldRef.current = world;
    };

    const onUp = () => {
      isDrawingRef.current = false;
      lastWorldRef.current = null;
      if (isPanningRef.current) {
        isPanningRef.current = false;
        panOriginRef.current = null;
        canvas.style.cursor = "crosshair";
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const t = panRef.current;
      const newScale = Math.min(Math.max(t.scale * factor, 0.05), 20);

      const wx = (mx - t.x) / t.scale;
      const wy = (my - t.y) / t.scale;

      panRef.current = {
        x: mx - wx * newScale,
        y: my - wy * newScale,
        scale: newScale,
      };
      setTransformState({ ...panRef.current });
      redraw();
    };

    const noCtx = (e: Event) => e.preventDefault();

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", noCtx);
    canvas.addEventListener("touchstart", onDown, { passive: false });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);

    return () => {
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", noCtx);
      canvas.removeEventListener("touchstart", onDown);
      canvas.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  // NOTE: onDraw/onCursorMove come from Board.tsx useCallbacks with stable refs,
  // so it's safe to omit them from deps. redraw is stable (useCallback []).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw]);

  // ─── Init on mount + handle resize ──────────────────────────────
  useEffect(() => {
    // Small timeout ensures the parent div has laid out before measuring
    const id = setTimeout(() => setupCanvas(), 0);
    window.addEventListener("resize", setupCanvas);
    return () => {
      clearTimeout(id);
      window.removeEventListener("resize", setupCanvas);
    };
  }, [setupCanvas]);

  return {
    canvasRef,
    drawStroke,
    clearCanvas,
    transform,
    setDrawSettings,
  };
}
