import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { nanoid } from "nanoid";
import { Plus, ArrowRight, Sparkles, PenLine, Users, Zap, User, Shield } from "lucide-react";
import { Button, Input } from "../components/ui";

const STORAGE_KEY = "synapse-boards";
const USERNAME_KEY = "synapse-username";
const MAX_BOARDS = 5;

interface BoardEntry {
  id: string;
  lastVisited: string;
}

function getBoards(): BoardEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveBoardVisit(id: string) {
  const boards = getBoards().filter((b) => b.id !== id);
  boards.unshift({ id, lastVisited: new Date().toISOString() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(boards.slice(0, MAX_BOARDS)));
}

export function getSavedUsername(): string {
  return localStorage.getItem(USERNAME_KEY) || "";
}

export function saveUsername(name: string) {
  localStorage.setItem(USERNAME_KEY, name);
}

// ── Particle System ───────────────────────────────────────────────────────────
// Decorative ambient layer that carries the product's visual identity. Its
// palette is derived from the design tokens (read from CSS custom properties)
// rather than hardcoded color literals, so it stays in sync with the theme.
interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  opacity: number;
  opacityDelta: number;
  color: string;
  glow: boolean;
}

/** Brand tokens (defined in index.css `@theme`) used to tint the particles. */
const PARTICLE_COLOR_TOKENS = [
  "--color-primary",
  "--color-accent",
  "--color-focus",
  "--color-primary-hover",
];

/** Parse a `#rgb`/`#rrggbb` token value into an `r,g,b` triple. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const value = hex.trim().replace("#", "");
  const full =
    value.length === 3
      ? value.split("").map((c) => c + c).join("")
      : value;
  if (full.length < 6) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

/** Build `rgba(r,g,b,` prefixes from the brand tokens at runtime. */
function readParticleColorPrefixes(): string[] {
  if (typeof window === "undefined") return [];
  const styles = getComputedStyle(document.documentElement);
  const prefixes: string[] = [];
  for (const token of PARTICLE_COLOR_TOKENS) {
    const rgb = hexToRgb(styles.getPropertyValue(token));
    if (rgb) prefixes.push(`rgba(${rgb.r},${rgb.g},${rgb.b},`);
  }
  return prefixes;
}

function createParticle(w: number, h: number, palette: string[]): Particle {
  const color = palette[Math.floor(Math.random() * palette.length)];
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4 - 0.1,
    size: Math.random() * 2 + 0.5,
    opacity: Math.random() * 0.6 + 0.1,
    opacityDelta: (Math.random() - 0.5) * 0.005,
    color,
    glow: Math.random() > 0.75,
  };
}

function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const paletteRef = useRef<string[]>([]);
  const rafRef = useRef<number>(0);

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width = window.innerWidth;
    const h = canvas.height = window.innerHeight;
    if (paletteRef.current.length === 0) {
      paletteRef.current = readParticleColorPrefixes();
    }
    const palette = paletteRef.current;
    particlesRef.current =
      palette.length === 0
        ? []
        : Array.from({ length: 120 }, () => createParticle(w, h, palette));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Honor the user's reduced-motion preference (Requirement 10.4). The
    // particle field is purely decorative (non-informative), so when reduced
    // motion is requested we skip the animation loop entirely instead of
    // running requestAnimationFrame. We also react to live changes of the
    // preference so toggling it starts/stops the loop without a reload.
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let running = false;

    const tick = () => {
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);

      for (const p of particlesRef.current) {
        p.x += p.vx;
        p.y += p.vy;
        p.opacity += p.opacityDelta;

        if (p.opacity <= 0.05 || p.opacity >= 0.75) p.opacityDelta *= -1;
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;

        ctx.save();
        if (p.glow) {
          ctx.shadowColor = p.color + "1)";
          ctx.shadowBlur = 12;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + p.opacity.toFixed(2) + ")";
        ctx.fill();
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      init();
      rafRef.current = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafRef.current);
      // Clear any rendered frame so no static particle residue lingers.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    const applyMotionPreference = () => {
      if (motionQuery.matches) stop();
      else start();
    };

    applyMotionPreference();
    window.addEventListener("resize", init);
    motionQuery.addEventListener("change", applyMotionPreference);

    return () => {
      stop();
      window.removeEventListener("resize", init);
      motionQuery.removeEventListener("change", applyMotionPreference);
    };
  }, [init]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 z-0 pointer-events-none"
    />
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: <Users className="w-3 h-3" />, label: "Multi-user" },
  { icon: <Zap className="w-3 h-3" />, label: "Real-time" },
  { icon: <Sparkles className="w-3 h-3" />, label: "Infinite canvas" },
];

export default function Home() {
  const navigate = useNavigate();
  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [isEntering, setIsEntering] = useState(false);

  useEffect(() => {
    setBoards(getBoards());
    setUsername(getSavedUsername());
  }, []);

  const validateAndGo = (boardId: string) => {
    const name = username.trim();
    if (!name) {
      setError("Enter a name to continue");
      return;
    }
    setError("");
    setIsEntering(true);
    saveUsername(name);
    saveBoardVisit(boardId);
    setTimeout(() => {
      navigate(`/board/${boardId}?user=${encodeURIComponent(name)}`);
    }, 350);
  };

  const createBoard = () => validateAndGo(nanoid(10));
  const joinBoard = (id: string) => validateAndGo(id);

  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden bg-bg text-text-strong relative">
      {/* ── Particle layer ── */}
      <ParticleCanvas />

      {/* ── Hex grid overlay ── */}
      <div aria-hidden="true" className="brand-grid absolute inset-0 z-0 pointer-events-none" />

      {/* ── Deep ambient glows ── */}
      <div aria-hidden="true" className="brand-glow-top absolute inset-0 z-0 pointer-events-none" />
      <div aria-hidden="true" className="brand-glow-bottom absolute inset-0 z-0 pointer-events-none" />

      {/* Centering wrapper. `min-h-full` keeps the card vertically centered on
          tall viewports, while the parent scroll container lets content that is
          taller than a small/mobile viewport scroll into view instead of being
          clipped (no lost content — Requirement 10.5). Vertical padding is
          smaller on mobile to conserve space. */}
      <div className="relative z-10 min-h-full w-full flex items-center justify-center px-4 py-10 sm:py-16">
      {/* ── Content ── */}
      <div
        className={`w-full max-w-[420px] transition-all duration-500 motion-reduce:transition-none ${
          isEntering
            ? "opacity-0 scale-[0.97] translate-y-2"
            : "opacity-100 scale-100 translate-y-0"
        }`}
      >
        {/* ── Logo + Title ── */}
        <div className="text-center mb-10">
          {/* Icon with animated ring */}
          <div className="relative inline-flex items-center justify-center mb-8">
            {/* Animated outer ring */}
            <div aria-hidden="true" className="brand-ring absolute -inset-[3px] rounded-xl p-px" />
            <div aria-hidden="true" className="absolute -inset-0.5 rounded-xl bg-bg" />
            <div className="brand-gradient relative flex items-center justify-center w-[76px] h-[76px] rounded-xl shadow-[var(--shadow-glow)]">
              <PenLine className="w-9 h-9 text-text-on-primary" />
            </div>
          </div>

          {/* Status badge */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold tracking-[0.15em] uppercase px-3 py-1 rounded-sm border border-border bg-surface-2 text-focus shadow-[var(--shadow-glow)]">
              <Shield className="w-3 h-3" />
              Secure rooms
            </span>
          </div>

          <h1 className="brand-text text-3xl font-black tracking-tight leading-none mb-1">
            Synapse
          </h1>
          <p className="text-sm text-text-muted tracking-[0.2em] uppercase font-medium mb-6">
            Collaborative Whiteboard
          </p>

          {/* Feature badges */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {FEATURES.map(({ icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border border-border bg-surface-2 text-text-muted transition-colors duration-[var(--motion-fast)] motion-reduce:transition-none hover:border-primary hover:text-text select-none cursor-default"
              >
                {icon}
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Main Card ── */}
        <div className="brand-card rounded-2xl border border-border p-7 shadow-[var(--shadow-md)]">
          {/* Username input */}
          <Input
            label="Display name"
            placeholder="Enter your name..."
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && createBoard()}
            maxLength={20}
            error={error || undefined}
            leading={<User className="w-4 h-4" />}
          />

          {/* Divider */}
          <div className="my-5 h-px bg-border" />

          {/* Create Board CTA */}
          <Button
            onClick={createBoard}
            className="group brand-gradient w-full shadow-[var(--shadow-glow)]"
          >
            <Plus className="w-5 h-5 transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none group-hover:rotate-90" />
            Create new board
          </Button>

          {/* Recent Boards */}
          {boards.length > 0 && (
            <div className="mt-7">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs font-bold tracking-[0.2em] uppercase text-text-muted">
                  Recent boards
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="space-y-2">
                {boards.map((board) => (
                  <button
                    key={board.id}
                    type="button"
                    onClick={() => joinBoard(board.id)}
                    aria-label={`Open board ${board.id}`}
                    className="group w-full flex items-center justify-between rounded-xl px-4 py-3 border border-border bg-surface-2 text-left cursor-pointer transition-colors duration-[var(--motion-fast)] motion-reduce:transition-none hover:border-primary hover:bg-surface-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-text font-mono truncate tracking-wide">
                        {board.id}
                      </p>
                      <p className="text-xs text-text-muted mt-0.5">
                        {new Date(board.lastVisited).toLocaleDateString(undefined, {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 shrink-0 ml-3 text-text-muted transition-colors duration-[var(--motion-fast)] motion-reduce:transition-none group-hover:text-primary" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-text-muted text-xs mt-6 tracking-widest uppercase">
          Share board link · Collaborate instantly
        </p>
      </div>
      </div>
    </div>
  );
}
