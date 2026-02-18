import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  Palette,
  Eraser,
  Trash2,
  Download,
  FileImage,
  Home,
  Copy,
  Check,
  Minus,
  Plus,
  ChevronDown,
  User,
  MousePointer2,
  Move,
} from "lucide-react";
import { jsPDF } from "jspdf";
import { useDraw, type DrawStroke } from "../hooks/useDraw";
import { useSocket, type RemoteUser } from "../hooks/useSocket";
import { saveBoardVisit, getSavedUsername, saveUsername } from "./Home";

const COLORS = [
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

const LINE_WIDTHS = [2, 4, 6, 10, 16];

/* ─── Username Entry Modal ─────────────────────────────────────────── */
function UsernameModal({
  onSubmit,
  initial,
}: {
  onSubmit: (name: string) => void;
  initial: string;
}) {
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-md flex items-center justify-center p-6">
      <div className="bg-[#111118] border border-white/[0.1] rounded-2xl p-10 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 mx-auto mb-6 shadow-lg shadow-indigo-500/30">
          <User className="w-7 h-7 text-white" />
        </div>
        <h2 className="text-2xl font-bold text-white text-center mb-2">
          Join Board
        </h2>
        <p className="text-sm text-slate-400 text-center mb-8 leading-relaxed">
          Enter your name so others can see who's drawing
        </p>
        <input
          ref={inputRef}
          type="text"
          placeholder="Your name..."
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          maxLength={20}
          className="w-full bg-white/[0.04] border border-white/[0.1] rounded-xl px-4 py-3.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all mb-5"
        />
        <button
          onClick={handleSubmit}
          className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold py-3.5 rounded-xl transition-all cursor-pointer active:scale-[0.98] shadow-lg shadow-indigo-600/25 hover:shadow-indigo-500/40"
        >
          Enter Board
        </button>
      </div>
    </div>
  );
}

/* ─── Users Presence Dropdown ──────────────────────────────────────── */
function UsersDropdown({
  users,
  mySocketColor,
}: {
  users: RemoteUser[];
  mySocketColor: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 px-4 py-2 rounded-xl bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.08] hover:border-white/[0.12] transition-all cursor-pointer"
      >
        {/* Stacked avatars */}
        <div className="flex -space-x-2">
          {users.slice(0, 4).map((u) => (
            <div
              key={u.socketId}
              className="w-6 h-6 rounded-full border-2 border-[#0a0a0f] ring-1 ring-white/10"
              style={{ backgroundColor: u.cursorColor }}
            />
          ))}
        </div>
        <span className="text-sm text-slate-300 font-medium">
          {users.length}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full mt-3 w-64 bg-[#14141c] border border-white/[0.1] rounded-xl shadow-2xl z-50 py-2 overflow-hidden">
            <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              In this board
            </div>
            {users.map((u) => (
              <div
                key={u.socketId}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.04] transition-colors"
              >
                <div
                  className="w-5 h-5 rounded-full shrink-0 ring-1 ring-white/10"
                  style={{ backgroundColor: u.cursorColor }}
                />
                <span className="text-sm text-slate-200 truncate flex-1">
                  {u.username}
                </span>
                {u.cursorColor === mySocketColor && (
                  <span className="text-[11px] text-slate-500 font-medium">
                    (you)
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Remote Cursor Renderer ───────────────────────────────────────── */
function RemoteCursors({
  users,
  remoteCursors,
  transform,
  myColor,
}: {
  users: RemoteUser[];
  remoteCursors: Map<string, { x: number; y: number }>;
  transform: { x: number; y: number; scale: number };
  myColor: string;
}) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-30">
      {users
        .filter((u) => u.cursorColor !== myColor && remoteCursors.has(u.socketId))
        .map((u) => {
          const pos = remoteCursors.get(u.socketId)!;
          // World to screen
          const sx = pos.x * transform.scale + transform.x;
          const sy = pos.y * transform.scale + transform.y;

          return (
            <div
              key={u.socketId}
              className="absolute transition-all duration-100 ease-out"
              style={{
                left: sx,
                top: sy,
                transform: "translate(-3px, -3px)",
              }}
            >
              <svg
                width="24"
                height="26"
                viewBox="0 0 24 26"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="drop-shadow-lg"
              >
                <path
                  d="M3 1.5L20 14.5H10.5L6.5 24.5L3 1.5Z"
                  fill={u.cursorColor}
                  stroke="rgba(0,0,0,0.5)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
              <div
                className="absolute left-5 top-5 px-2.5 py-1 rounded-lg text-xs font-semibold text-white whitespace-nowrap shadow-xl"
                style={{ backgroundColor: u.cursorColor }}
              >
                {u.username}
              </div>
            </div>
          );
        })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Board Component
   ═══════════════════════════════════════════════════════════════════════ */
export default function Board() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const roomId = id || "default";

  // Username handling
  const urlUser = searchParams.get("user") || "";
  const savedUser = getSavedUsername();
  const [username, setUsername] = useState(urlUser || savedUser);
  const [joined, setJoined] = useState(false);

  // Auto-join if we have a username from URL
  useEffect(() => {
    if (urlUser) {
      saveUsername(urlUser);
      setJoined(true);
    }
  }, [urlUser]);

  // Drawing state
  const [color, setColor] = useState("#ffffff");
  const [lineWidth, setLineWidth] = useState(4);
  const [isEraser, setIsEraser] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showColors, setShowColors] = useState(false);

  const BG_COLOR = "#0a0a0f";
  const activeColor = isEraser ? BG_COLOR : color;
  const activeWidth = isEraser ? 24 : lineWidth;

  // ── useDraw hook ───────────────────────────────────────────────────
  const handleDraw = useCallback(
    (stroke: DrawStroke) => {
      emitDrawRef.current?.(stroke);
    },
    []
  );

  const handleCursorMove = useCallback(
    (x: number, y: number) => {
      emitCursorRef.current?.(x, y);
    },
    []
  );

  const {
    canvasRef,
    drawStroke,
    clearCanvas,
    transform,
    setDrawSettings,
  } = useDraw({
    onDraw: handleDraw,
    onCursorMove: handleCursorMove,
  });

  // Update draw settings when color/width changes
  useEffect(() => {
    setDrawSettings(activeColor, activeWidth);
  }, [activeColor, activeWidth, setDrawSettings]);

  // ── useSocket hook ─────────────────────────────────────────────────
  const onRemoteDraw = useCallback(
    (stroke: DrawStroke) => drawStroke(stroke),
    [drawStroke]
  );

  const onRoomHistory = useCallback(
    (strokes: DrawStroke[]) => strokes.forEach((s) => drawStroke(s)),
    [drawStroke]
  );

  const onClear = useCallback(() => clearCanvas(), [clearCanvas]);

  const { emitDraw, emitClear, emitCursor, users, myColor, remoteCursors } =
    useSocket({
      roomId: joined ? roomId : "",
      username: joined ? username : "",
      onRemoteDraw,
      onRoomHistory,
      onClear,
    });

  const emitDrawRef = useRef(emitDraw);
  useEffect(() => {
    emitDrawRef.current = emitDraw;
  }, [emitDraw]);

  const emitCursorRef = useRef(emitCursor);
  useEffect(() => {
    emitCursorRef.current = emitCursor;
  }, [emitCursor]);

  // Save board visit
  useEffect(() => {
    if (joined) saveBoardVisit(roomId);
  }, [roomId, joined]);

  // ── Actions ────────────────────────────────────────────────────────
  const handleClear = () => {
    clearCanvas();
    emitClear();
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/board/${roomId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `synapse-${roomId}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const exportPDF = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width, canvas.height],
    });
    pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
    pdf.save(`synapse-${roomId}.pdf`);
  };

  const cycleWidth = (dir: 1 | -1) => {
    const idx = LINE_WIDTHS.indexOf(lineWidth);
    const next = idx + dir;
    if (next >= 0 && next < LINE_WIDTHS.length) setLineWidth(LINE_WIDTHS[next]);
  };

  const handleJoin = (name: string) => {
    setUsername(name);
    saveUsername(name);
    setJoined(true);
  };

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="relative w-screen h-screen bg-[#0a0a0f] overflow-hidden select-none">
      {/* Canvas — ALWAYS in DOM so useDraw effects can attach listeners */}
      <div className="absolute inset-0">
        <canvas ref={canvasRef} className="block w-full h-full cursor-crosshair" />
      </div>

      {/* Username modal — overlays everything when not joined */}
      {!joined && (
        <UsernameModal onSubmit={handleJoin} initial={username} />
      )}

      {/* Board UI — only shown after joining */}
      {joined && (
        <>
          {/* Remote cursors */}
          <RemoteCursors
            users={users}
            remoteCursors={remoteCursors}
            transform={transform}
            myColor={myColor}
          />

          {/* ── Top Bar ─────────────────────────────────────────────────── */}
          <div className="absolute top-4 left-4 right-4 flex items-center justify-between z-50">
            {/* Left: Logo + Room */}
            <div className="flex items-center gap-3 bg-[#111118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl px-4 py-2.5 shadow-lg">
              <button
                onClick={() => navigate("/")}
                className="p-2 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-lg hover:bg-white/[0.06]"
                title="Home"
              >
                <Home className="w-4 h-4" />
              </button>

              <div className="w-px h-6 bg-white/[0.08]" />

              <span className="text-xs font-mono text-slate-400 px-1 max-w-[140px] truncate">
                {roomId}
              </span>

              <button
                onClick={handleCopyLink}
                className="p-2 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-lg hover:bg-white/[0.06]"
                title="Copy link"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Center: Zoom info */}
            <div className="hidden sm:flex items-center gap-3 bg-[#111118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl px-4 py-2.5 shadow-lg">
              <Move className="w-4 h-4 text-slate-500" />
              <span className="text-sm text-slate-300 font-mono font-semibold">
                {Math.round(transform.scale * 100)}%
              </span>
              <span className="text-xs text-slate-500 hidden md:inline">
                Alt+drag to pan · Scroll to zoom
              </span>
            </div>

            {/* Right: Users */}
            <div className="flex items-center gap-3">
              {/* My cursor color indicator */}
              <div className="flex items-center gap-2.5 bg-[#111118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl px-4 py-2.5 shadow-lg">
                <div
                  className="w-3.5 h-3.5 rounded-full ring-1 ring-white/10"
                  style={{ backgroundColor: myColor }}
                />
                <span className="text-sm text-slate-300 font-medium">{username}</span>
              </div>

              <div className="bg-[#111118]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-lg">
                <UsersDropdown users={users} mySocketColor={myColor} />
              </div>
            </div>
          </div>

          {/* ── Left Toolbar ──────────────────────────────────────────────── */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 bg-[#111118]/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl p-2 shadow-lg z-50">
            {/* Brush */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowColors(!showColors);
                  setIsEraser(false);
                }}
                className={`p-3 rounded-xl transition-all cursor-pointer ${
                  !isEraser
                    ? "bg-white/[0.1] text-white shadow-sm"
                    : "text-slate-400 hover:text-white hover:bg-white/[0.05]"
                }`}
                title="Brush"
              >
                <Palette className="w-5 h-5" />
              </button>

              {/* Color palette popup — fixed grid, no overlaps */}
              {showColors && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowColors(false)}
                  />
                  <div className="absolute left-full ml-4 top-0 bg-[#14141c] border border-white/[0.1] rounded-xl p-4 shadow-2xl z-50 min-w-[180px]">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                      Colors
                    </div>
                    <div className="grid grid-cols-4 gap-2.5">
                      {COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => {
                            setColor(c);
                            setIsEraser(false);
                            setShowColors(false);
                          }}
                          className={`w-9 h-9 rounded-lg border-2 transition-all cursor-pointer hover:scale-110 ${
                            color === c && !isEraser
                              ? "border-indigo-400 ring-2 ring-indigo-400/40 scale-110"
                              : "border-transparent hover:border-white/30"
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Eraser */}
            <button
              onClick={() => {
                setIsEraser(!isEraser);
                setShowColors(false);
              }}
              className={`p-3 rounded-xl transition-all cursor-pointer ${
                isEraser
                  ? "bg-white/[0.1] text-white shadow-sm"
                  : "text-slate-400 hover:text-white hover:bg-white/[0.05]"
              }`}
              title="Eraser"
            >
              <Eraser className="w-5 h-5" />
            </button>

            <div className="w-8 h-px bg-white/[0.08] my-1" />

            {/* Line width controls */}
            <button
              onClick={() => cycleWidth(-1)}
              className="p-2.5 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-lg hover:bg-white/[0.05]"
              title="Thinner"
            >
              <Minus className="w-4 h-4" />
            </button>
            <div className="flex items-center justify-center w-9 h-9">
              <div
                className="rounded-full bg-white/90 shadow-sm"
                style={{
                  width: `${Math.max(4, lineWidth)}px`,
                  height: `${Math.max(4, lineWidth)}px`,
                }}
              />
            </div>
            <button
              onClick={() => cycleWidth(1)}
              className="p-2.5 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-lg hover:bg-white/[0.05]"
              title="Thicker"
            >
              <Plus className="w-4 h-4" />
            </button>

            <div className="w-8 h-px bg-white/[0.08] my-1" />

            {/* Clear */}
            <button
              onClick={handleClear}
              className="p-3 text-slate-400 hover:text-red-400 transition-colors cursor-pointer rounded-xl hover:bg-white/[0.05]"
              title="Clear board"
            >
              <Trash2 className="w-5 h-5" />
            </button>

            <div className="w-8 h-px bg-white/[0.08] my-1" />

            {/* Export PNG */}
            <button
              onClick={exportPNG}
              className="p-3 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-xl hover:bg-white/[0.05]"
              title="Export PNG"
            >
              <FileImage className="w-5 h-5" />
            </button>

            {/* Export PDF */}
            <button
              onClick={exportPDF}
              className="p-3 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-xl hover:bg-white/[0.05]"
              title="Export PDF"
            >
              <Download className="w-5 h-5" />
            </button>
          </div>

          {/* ── Bottom Status ─────────────────────────────────────────────── */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-[#111118]/95 backdrop-blur-xl border border-white/[0.08] rounded-full px-5 py-2.5 z-50 shadow-lg">
            <div className="flex items-center gap-2.5">
              <MousePointer2
                className="w-4 h-4"
                style={{ color: myColor }}
              />
              <div
                className="w-4 h-4 rounded-full border border-white/20 ring-1 ring-white/10"
                style={{ backgroundColor: activeColor }}
              />
            </div>
            <span className="text-sm text-slate-300 font-mono font-medium">
              {isEraser ? "Eraser" : color} · {lineWidth}px
            </span>
          </div>
        </>
      )}
    </div>
  );
}
