import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { nanoid } from "nanoid";
import { Plus, ArrowRight, Sparkles, PenLine, Users, Zap, User, Shield } from "lucide-react";

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
interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  opacity: number;
  opacityDelta: number;
  color: string;
  glow: boolean;
}

const PARTICLE_COLORS = [
  "rgba(139,92,246,",   // violet
  "rgba(99,102,241,",   // indigo
  "rgba(168,85,247,",   // purple
  "rgba(59,130,246,",   // blue
  "rgba(192,132,252,",  // light purple
];

function createParticle(w: number, h: number): Particle {
  const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
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
  const rafRef = useRef<number>(0);

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width = window.innerWidth;
    const h = canvas.height = window.innerHeight;
    particlesRef.current = Array.from({ length: 120 }, () => createParticle(w, h));
  }, []);

  useEffect(() => {
    init();
    window.addEventListener("resize", init);

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

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

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", init);
    };
  }, [init]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
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
      setError("Enter your hunter name to proceed");
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
    <div className="min-h-screen bg-[#06060e] text-white flex items-center justify-center px-4 py-16 relative overflow-hidden">

      {/* ── Particle Layer ── */}
      <ParticleCanvas />

      {/* ── Hex grid overlay ── */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(rgba(139,92,246,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(139,92,246,0.04) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
          zIndex: 1,
        }}
      />

      {/* ── Deep ambient glows ── */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: "-20%", left: "50%", transform: "translateX(-50%)",
          width: 900, height: 600,
          background: "radial-gradient(ellipse, rgba(109,40,217,0.18) 0%, transparent 70%)",
          zIndex: 1,
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          bottom: "-15%", right: "-10%",
          width: 600, height: 500,
          background: "radial-gradient(ellipse, rgba(79,70,229,0.14) 0%, transparent 70%)",
          zIndex: 1,
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          bottom: "10%", left: "-10%",
          width: 500, height: 400,
          background: "radial-gradient(ellipse, rgba(168,85,247,0.08) 0%, transparent 70%)",
          zIndex: 1,
        }}
      />

      {/* ── Content ── */}
      <div
        className="relative w-full max-w-[420px] transition-all duration-500"
        style={{
          zIndex: 10,
          opacity: isEntering ? 0 : 1,
          transform: isEntering ? "scale(0.97) translateY(8px)" : "scale(1) translateY(0)",
        }}
      >
        {/* ── Logo + Title ── */}
        <div className="text-center mb-10">
          {/* Icon with animated ring */}
          <div className="relative inline-flex items-center justify-center mb-8">
            {/* Animated outer ring */}
            <div
              className="absolute rounded-[28px]"
              style={{
                inset: -3,
                background: "linear-gradient(135deg, rgba(139,92,246,0.8), rgba(99,102,241,0.4), rgba(168,85,247,0.8))",
                animation: "spin 6s linear infinite",
                borderRadius: 28,
                padding: 1,
              }}
            />
            <div
              className="absolute rounded-[26px]"
              style={{
                inset: -2,
                background: "#06060e",
                borderRadius: 26,
              }}
            />
            <div
              className="relative flex items-center justify-center w-[76px] h-[76px] rounded-[22px]"
              style={{
                background: "linear-gradient(135deg, #6d28d9 0%, #4f46e5 50%, #7c3aed 100%)",
                boxShadow: "0 0 40px rgba(109,40,217,0.6), 0 0 80px rgba(109,40,217,0.2), inset 0 1px 0 rgba(255,255,255,0.15)",
              }}
            >
              <PenLine className="w-9 h-9 text-white drop-shadow-lg" />
            </div>
          </div>

          {/* System Rank badge */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <div
              className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.15em] uppercase px-3 py-1 rounded-sm"
              style={{
                background: "linear-gradient(90deg, rgba(109,40,217,0.25), rgba(79,70,229,0.25))",
                border: "1px solid rgba(139,92,246,0.4)",
                color: "#a78bfa",
                boxShadow: "0 0 12px rgba(139,92,246,0.15)",
              }}
            >
              <Shield className="w-3 h-3" />
              Hunter System
            </div>
          </div>

          <h1
            className="text-[4rem] font-black tracking-tight leading-none mb-1"
            style={{
              background: "linear-gradient(180deg, #ffffff 0%, #c4b5fd 50%, #818cf8 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              textShadow: "none",
              filter: "drop-shadow(0 0 30px rgba(139,92,246,0.5))",
            }}
          >
            Synapse
          </h1>
          <p className="text-[13px] text-slate-500 tracking-[0.2em] uppercase font-medium mb-6">
            Collaborative Whiteboard
          </p>

          {/* Feature badges */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {[
              { icon: <Users className="w-3 h-3" />, label: "Multi-user", color: "rgba(99,102,241," },
              { icon: <Zap className="w-3 h-3" />, label: "Real-time", color: "rgba(245,158,11," },
              { icon: <Sparkles className="w-3 h-3" />, label: "Infinite canvas", color: "rgba(168,85,247," },
            ].map(({ icon, label, color }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full transition-all duration-200 cursor-default select-none"
                style={{
                  background: color + "0.08)",
                  border: `1px solid ${color}0.2)`,
                  color: color + "0.9)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = color + "0.15)";
                  (e.currentTarget as HTMLElement).style.borderColor = color + "0.5)";
                  (e.currentTarget as HTMLElement).style.boxShadow = `0 0 12px ${color}0.2)`;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = color + "0.08)";
                  (e.currentTarget as HTMLElement).style.borderColor = color + "0.2)";
                  (e.currentTarget as HTMLElement).style.boxShadow = "none";
                }}
              >
                {icon}
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Main Card ── */}
        <div
          className="rounded-2xl p-7"
          style={{
            background: "linear-gradient(160deg, rgba(17,17,30,0.95) 0%, rgba(13,13,24,0.98) 100%)",
            border: "1px solid rgba(139,92,246,0.2)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.03), 0 32px 64px rgba(0,0,0,0.6), 0 0 80px rgba(109,40,217,0.08)",
            backdropFilter: "blur(20px)",
          }}
        >

          {/* Input label */}
          <label className="block text-[11px] font-bold text-slate-400 mb-2.5 tracking-[0.15em] uppercase">
            Hunter Name
          </label>

          {/* Username input */}
          <div className="relative mb-5">
            <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-violet-500/60 pointer-events-none" />
            <input
              type="text"
              placeholder="Enter your name..."
              value={username}
              onChange={(e) => { setUsername(e.target.value); if (error) setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && createBoard()}
              maxLength={20}
              className="w-full rounded-xl pl-11 pr-4 py-3.5 text-[15px] text-white placeholder-slate-600 outline-none transition-all duration-200"
              style={{
                background: "rgba(255,255,255,0.03)",
                border: error ? "1px solid rgba(239,68,68,0.5)" : "1px solid rgba(139,92,246,0.2)",
                boxShadow: error
                  ? "0 0 0 3px rgba(239,68,68,0.08)"
                  : "none",
              }}
              onFocus={(e) => {
                if (!error) {
                  e.currentTarget.style.border = "1px solid rgba(139,92,246,0.6)";
                  e.currentTarget.style.boxShadow = "0 0 0 3px rgba(139,92,246,0.1), 0 0 20px rgba(139,92,246,0.08)";
                }
              }}
              onBlur={(e) => {
                if (!error) {
                  e.currentTarget.style.border = "1px solid rgba(139,92,246,0.2)";
                  e.currentTarget.style.boxShadow = "none";
                }
              }}
            />
            {error && (
              <p className="absolute -bottom-6 left-0 text-red-400 text-[12px] flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-red-400 inline-block shrink-0" />
                {error}
              </p>
            )}
          </div>

          {/* Spacer for error */}
          <div className={error ? "mb-9" : "mb-0"} />

          {/* Divider */}
          <div
            className="mb-5 h-px"
            style={{
              background: "linear-gradient(90deg, transparent, rgba(139,92,246,0.2), transparent)",
            }}
          />

          {/* Create Board CTA */}
          <button
            onClick={createBoard}
            className="w-full flex items-center justify-center gap-2.5 font-bold text-[15px] py-4 px-6 rounded-xl cursor-pointer select-none transition-all duration-200 active:scale-[0.97] group"
            style={{
              background: "linear-gradient(135deg, #6d28d9 0%, #4f46e5 60%, #7c3aed 100%)",
              boxShadow: "0 0 24px rgba(109,40,217,0.4), 0 4px 16px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)",
              color: "white",
              letterSpacing: "0.02em",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.boxShadow =
                "0 0 40px rgba(109,40,217,0.65), 0 8px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.boxShadow =
                "0 0 24px rgba(109,40,217,0.4), 0 4px 16px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)";
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
            }}
          >
            <Plus className="w-5 h-5 transition-transform duration-200 group-hover:rotate-90" />
            Create New Board
          </button>

          {/* Recent Boards */}
          {boards.length > 0 && (
            <div className="mt-7">
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="h-px flex-1"
                  style={{ background: "linear-gradient(90deg, transparent, rgba(139,92,246,0.2))" }}
                />
                <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-slate-600">
                  Recent Sessions
                </span>
                <div
                  className="h-px flex-1"
                  style={{ background: "linear-gradient(90deg, rgba(139,92,246,0.2), transparent)" }}
                />
              </div>

              <div className="space-y-2">
                {boards.map((board) => (
                  <button
                    key={board.id}
                    onClick={() => joinBoard(board.id)}
                    className="w-full flex items-center justify-between rounded-xl px-4 py-3 cursor-pointer transition-all duration-200 group"
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(139,92,246,0.1)",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.background = "rgba(109,40,217,0.1)";
                      el.style.borderColor = "rgba(139,92,246,0.35)";
                      el.style.boxShadow = "0 0 16px rgba(139,92,246,0.1)";
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.background = "rgba(255,255,255,0.02)";
                      el.style.borderColor = "rgba(139,92,246,0.1)";
                      el.style.boxShadow = "none";
                    }}
                  >
                    <div className="text-left min-w-0">
                      <p className="text-[13px] font-bold text-slate-200 font-mono truncate tracking-wide">
                        {board.id}
                      </p>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        {new Date(board.lastVisited).toLocaleDateString(undefined, {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <ArrowRight
                      className="w-4 h-4 shrink-0 ml-3 transition-all duration-200"
                      style={{ color: "rgba(139,92,246,0.5)" }}
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-slate-700 text-[12px] mt-6 tracking-widest uppercase">
          Share board link · Collaborate instantly
        </p>
      </div>

      {/* Spinning ring keyframe */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}