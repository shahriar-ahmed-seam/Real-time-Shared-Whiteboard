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
  Loader2,
} from "lucide-react";
import { jsPDF } from "jspdf";
import { useDraw, type DrawStroke } from "../hooks/useDraw";
import { useSocket, type RemoteUser } from "../hooks/useSocket";
import { saveBoardVisit, getSavedUsername, saveUsername } from "./Home";
import {
  Button,
  Input,
  Modal,
  Popover,
  Toolbar,
  ToolbarButton,
  Tooltip,
} from "../components/ui";

// Drawing palette — application data (the colors a user can pick), not UI
// theme. Each value is bound to a swatch's `backgroundColor` at render time.
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

// Canvas background color. This is a rendering constant that MUST match the
// `BG` used by useDraw (the eraser paints with the background color), so it is
// intentionally not a theme token.
const BG_COLOR = "#0a0a0f";

/* ─── Responsive breakpoint helper ─────────────────────────────────── */
// Documented breakpoints (design.md → "Responsive behavior"):
//   • Mobile  (<640px):    toolbar collapses into a compact bottom dock.
//   • Tablet  (640–1023px) and Desktop (≥1024px): floating top bar + left
//     vertical toolbar (the zoom hint text already hides below `md`).
// 640px is the single layout-model switch, so we track `(max-width: 639px)`.
// Subscribing to `matchMedia` keeps the layout reactive to viewport/orientation
// changes without a reload (Requirement 10.5).
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/* ─── Username Entry Modal ─────────────────────────────────────────── */
function UsernameModal({
  onSubmit,
  onCancel,
  initial,
}: {
  onSubmit: (name: string) => void;
  onCancel: () => void;
  initial: string;
}) {
  const [name, setName] = useState(initial);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title="Join board"
      footer={
        <Button
          onClick={handleSubmit}
          className="brand-gradient w-full shadow-[var(--shadow-glow)]"
        >
          Enter board
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-5">
        <div className="brand-gradient flex items-center justify-center w-14 h-14 rounded-xl shadow-[var(--shadow-glow)]">
          <User className="w-7 h-7 text-text-on-primary" />
        </div>
        <p className="text-center text-sm leading-relaxed text-text-muted">
          Enter your name so others can see who's drawing.
        </p>
        <div className="w-full">
          <Input
            label="Display name"
            hideLabel
            placeholder="Your name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            maxLength={20}
          />
        </div>
      </div>
    </Modal>
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
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      aria-label="People in this board"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${users.length} people in this board`}
          className="gap-2.5"
        >
          {/* Stacked avatars — each fill is the user's live cursor color (data). */}
          <span className="flex -space-x-2">
            {users.slice(0, 4).map((u) => (
              <span
                key={u.socketId}
                className="w-6 h-6 rounded-full border-2 border-bg ring-1 ring-border"
                style={{ backgroundColor: u.cursorColor }}
              />
            ))}
          </span>
          <span className="text-sm text-text font-medium">{users.length}</span>
          <ChevronDown
            aria-hidden="true"
            className={`w-3.5 h-3.5 text-text-muted transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </Button>
      }
    >
      <div className="w-56">
        <div className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
          In this board
        </div>
        <ul className="flex flex-col">
          {users.map((u) => (
            <li
              key={u.socketId}
              className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-surface-2"
            >
              <span
                className="w-5 h-5 rounded-full shrink-0 ring-1 ring-border"
                style={{ backgroundColor: u.cursorColor }}
              />
              <span className="text-sm text-text truncate flex-1">
                {u.username}
              </span>
              {u.cursorColor === mySocketColor && (
                <span className="text-xs text-text-muted font-medium">
                  (you)
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Popover>
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
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none overflow-hidden z-30"
    >
      {users
        .filter((u) => u.cursorColor !== myColor && remoteCursors.has(u.socketId))
        .map((u) => {
          const pos = remoteCursors.get(u.socketId)!;
          // World to screen — dynamic positioning data.
          const sx = pos.x * transform.scale + transform.x;
          const sy = pos.y * transform.scale + transform.y;

          return (
            <div
              key={u.socketId}
              className="absolute transition-all duration-100 ease-out motion-reduce:transition-none"
              style={{ left: sx, top: sy, transform: "translate(-3px, -3px)" }}
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
                className="absolute left-5 top-5 px-2.5 py-1 rounded-lg text-xs font-semibold text-text-on-primary whitespace-nowrap shadow-[var(--shadow-md)]"
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

/* ─── Reconnection Indicator ───────────────────────────────────────── */
// Non-blocking status pill shown while the socket connection is down. It sits
// in a corner with `pointer-events-none` so it never disables or obscures the
// canvas or its controls (Req 4.3); the parent only mounts it while
// disconnected, so it disappears on reconnect (Req 4.7). Announced politely to
// assistive tech via `role="status"`.
function ReconnectingIndicator() {
  return (
    <div
      className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-surface-1/95 backdrop-blur-xl border border-border rounded-full px-4 py-2 shadow-[var(--shadow-md)] mt-16 sm:mt-0"
      role="status"
      aria-live="polite"
    >
      <Loader2
        className="w-4 h-4 text-text-muted animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span className="text-sm text-text font-medium">Reconnecting…</span>
    </div>
  );
}

/* ─── Toolbar Separator ────────────────────────────────────────────── */
// Orientation-aware divider between tool groups. In the vertical (desktop)
// toolbar it is a horizontal rule; in the horizontal (mobile) dock it becomes a
// vertical rule. Purely decorative, so hidden from assistive tech.
function ToolbarSeparator({ vertical }: { vertical: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={vertical ? "w-px h-8 bg-border mx-1" : "w-8 h-px bg-border my-1"}
    />
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

  const activeColor = isEraser ? BG_COLOR : color;
  const activeWidth = isEraser ? 24 : lineWidth;

  // Below 640px we switch to the mobile layout model (bottom toolbar dock,
  // compact top bar). At 640px and up we keep the desktop/tablet layout
  // (floating top bar + left vertical toolbar) per the documented breakpoints.
  const isMobile = useMediaQuery("(max-width: 639px)");

  // ── useDraw hook ───────────────────────────────────────────────────
  const handleDraw = useCallback((stroke: DrawStroke) => {
    emitDrawRef.current?.(stroke);
  }, []);

  const handleCursorMove = useCallback((x: number, y: number) => {
    emitCursorRef.current?.(x, y);
  }, []);

  const { canvasRef, drawStroke, clearCanvas, transform, setDrawSettings } =
    useDraw({
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

  const { emitDraw, emitClear, emitCursor, users, myColor, remoteCursors, connected } =
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
    <div className="relative w-screen h-screen bg-bg overflow-hidden select-none">
      {/* Canvas — ALWAYS in DOM so useDraw effects can attach listeners.
          `touch-none` sets touch-action:none so one-finger drawing and pan
          gestures aren't hijacked by the browser's native scroll/zoom, keeping
          drawing functional on touch devices (Requirement 10.5). */}
      <div className="absolute inset-0">
        <canvas
          ref={canvasRef}
          className="block w-full h-full cursor-crosshair touch-none"
        />
      </div>

      {/* Username modal — overlays everything when not joined */}
      {!joined && (
        <UsernameModal
          onSubmit={handleJoin}
          onCancel={() => navigate("/")}
          initial={username}
        />
      )}

      {/* Board UI — only shown after joining */}
      {joined && (
        <>
          {/* Reconnection indicator — non-blocking; only mounted while the
              socket is disconnected and removed on reconnect (Req 4.3, 4.7). */}
          {!connected && <ReconnectingIndicator />}

          {/* Remote cursors */}
          <RemoteCursors
            users={users}
            remoteCursors={remoteCursors}
            transform={transform}
            myColor={myColor}
          />

          {/* ── Top Bar ─────────────────────────────────────────────────────
              Reflows within the viewport: tighter insets and gaps on mobile,
              `flex-wrap` so groups stack instead of forcing horizontal scroll,
              and a min-w-0 identity pill whose name truncates on narrow screens
              (Requirement 10.5). */}
          <div className="absolute top-3 left-3 right-3 sm:top-4 sm:left-4 sm:right-4 flex flex-wrap items-center justify-between gap-2 sm:gap-3 z-50">
            {/* Left: Home + Room + Copy */}
            <div className="flex items-center gap-1 bg-surface-1/95 backdrop-blur-xl border border-border rounded-xl px-2 py-1.5 shadow-[var(--shadow-md)]">
              <Tooltip label="Home" placement="bottom">
                <Button
                  variant="icon"
                  aria-label="Go to home"
                  onClick={() => navigate("/")}
                >
                  <Home className="w-4 h-4" />
                </Button>
              </Tooltip>

              <div className="w-px h-6 bg-border" aria-hidden="true" />

              <span className="text-xs font-mono text-text-muted px-2 max-w-[80px] sm:max-w-[140px] truncate">
                {roomId}
              </span>

              <Tooltip
                label={copied ? "Link copied" : "Copy board link"}
                placement="bottom"
              >
                <Button
                  variant="icon"
                  aria-label="Copy board link"
                  onClick={handleCopyLink}
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-success" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </Tooltip>
            </div>

            {/* Center: Zoom info — hidden below the tablet breakpoint (640px). */}
            <div className="hidden sm:flex items-center gap-3 bg-surface-1/95 backdrop-blur-xl border border-border rounded-xl px-4 py-2.5 shadow-[var(--shadow-md)]">
              <Move className="w-4 h-4 text-text-muted" aria-hidden="true" />
              <span className="text-sm text-text font-mono font-semibold">
                {Math.round(transform.scale * 100)}%
              </span>
              <span className="text-xs text-text-muted hidden md:inline">
                Alt+drag to pan · Scroll to zoom
              </span>
            </div>

            {/* Right: Identity + Users */}
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="flex items-center gap-2.5 bg-surface-1/95 backdrop-blur-xl border border-border rounded-xl px-3 sm:px-4 py-2.5 shadow-[var(--shadow-md)] min-w-0">
                {/* My cursor color — live presence data. */}
                <span
                  className="w-3.5 h-3.5 rounded-full ring-1 ring-border shrink-0"
                  style={{ backgroundColor: myColor }}
                />
                <span className="text-sm text-text font-medium truncate max-w-[80px] sm:max-w-none">
                  {username}
                </span>
              </div>

              <div className="bg-surface-1/95 backdrop-blur-xl border border-border rounded-xl shadow-[var(--shadow-md)]">
                <UsersDropdown users={users} mySocketColor={myColor} />
              </div>
            </div>
          </div>

          {/* ── Bottom region (mobile) / independent floats (desktop) ───────
              On mobile (<640px) the toolbar dock and the status pill share a
              single bottom-anchored flex column so they stack without
              overlapping, regardless of how many rows the dock wraps to. On
              ≥640px the wrapper is `display:contents`, so each child keeps its
              own floating position (left toolbar, bottom-center status). */}
          <div
            className={
              isMobile
                ? "absolute inset-x-3 bottom-3 z-50 flex flex-col-reverse items-center gap-2"
                : "contents"
            }
          >
            {/* ── Tool dock ─────────────────────────────────────────────────
                Desktop/tablet (≥640px): vertical toolbar floating on the left.
                Mobile (<640px): horizontal dock that wraps within the viewport
                so it never causes horizontal scroll and keeps every tool
                reachable (Requirement 10.5). All ToolbarButtons are ≥44×44px
                via the shared component. */}
            <Toolbar
              aria-label="Drawing tools"
              orientation={isMobile ? "horizontal" : "vertical"}
              className={
                isMobile
                  ? "max-w-full flex-wrap justify-center backdrop-blur-xl shadow-[var(--shadow-md)]"
                  : "absolute left-4 top-1/2 -translate-y-1/2 z-50 backdrop-blur-xl shadow-[var(--shadow-md)]"
              }
            >
              {/* Brush + color palette */}
              <Popover
                open={showColors}
                onOpenChange={(o) => {
                  setShowColors(o);
                  if (o) setIsEraser(false);
                }}
                // On the bottom dock the palette opens upward so it stays on screen.
                side={isMobile ? "top" : "bottom"}
                align={isMobile ? "center" : "start"}
                aria-label="Brush colors"
                trigger={
                  <ToolbarButton aria-label="Brush and color" active={!isEraser}>
                    <Palette className="w-5 h-5" />
                  </ToolbarButton>
                }
              >
                <div className="min-w-44">
                  <div className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3 px-1">
                    Colors
                  </div>
                  <div className="grid grid-cols-4 gap-2.5">
                    {COLORS.map((c) => {
                      const selected = color === c && !isEraser;
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => {
                            setColor(c);
                            setIsEraser(false);
                            setShowColors(false);
                          }}
                          aria-label={`Color ${c}`}
                          aria-pressed={selected}
                          className={`w-11 h-11 rounded-lg border-2 cursor-pointer transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                            selected
                              ? "border-focus scale-110"
                              : "border-transparent hover:border-border"
                          }`}
                          // Swatch fill is the selectable color value (data).
                          style={{ backgroundColor: c }}
                        />
                      );
                    })}
                  </div>
                </div>
              </Popover>

              {/* Eraser */}
              <ToolbarButton
                aria-label="Eraser"
                active={isEraser}
                onClick={() => {
                  setIsEraser(!isEraser);
                  setShowColors(false);
                }}
              >
                <Eraser className="w-5 h-5" />
              </ToolbarButton>

              <ToolbarSeparator vertical={isMobile} />

              {/* Line width controls */}
              <ToolbarButton aria-label="Thinner line" onClick={() => cycleWidth(-1)}>
                <Minus className="w-4 h-4" />
              </ToolbarButton>
              <div
                className="flex items-center justify-center w-11 h-9"
                aria-hidden="true"
              >
                {/* Width preview dot — size reflects the current line width (data). */}
                <div
                  className="rounded-full bg-text-strong"
                  style={{
                    width: `${Math.max(4, lineWidth)}px`,
                    height: `${Math.max(4, lineWidth)}px`,
                  }}
                />
              </div>
              <ToolbarButton aria-label="Thicker line" onClick={() => cycleWidth(1)}>
                <Plus className="w-4 h-4" />
              </ToolbarButton>

              <ToolbarSeparator vertical={isMobile} />

              {/* Clear */}
              <ToolbarButton
                aria-label="Clear board"
                onClick={handleClear}
                className="hover:text-danger"
              >
                <Trash2 className="w-5 h-5" />
              </ToolbarButton>

              <ToolbarSeparator vertical={isMobile} />

              {/* Export PNG */}
              <ToolbarButton aria-label="Export as PNG" onClick={exportPNG}>
                <FileImage className="w-5 h-5" />
              </ToolbarButton>

              {/* Export PDF */}
              <ToolbarButton aria-label="Export as PDF" onClick={exportPDF}>
                <Download className="w-5 h-5" />
              </ToolbarButton>
            </Toolbar>

            {/* ── Bottom Status ─────────────────────────────────────────────
                Desktop: floating pill at bottom-center. Mobile: flows above the
                dock inside the shared column (no overlap), capped to the
                viewport width so it never overflows horizontally. */}
            <div
              className={
                isMobile
                  ? "flex items-center gap-3 bg-surface-1/95 backdrop-blur-xl border border-border rounded-full px-4 py-2 shadow-[var(--shadow-md)] max-w-full"
                  : "absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-surface-1/95 backdrop-blur-xl border border-border rounded-full px-5 py-2.5 z-50 shadow-[var(--shadow-md)]"
              }
            >
              <div className="flex items-center gap-2.5">
                {/* Pointer + active color preview — live drawing data. */}
                <MousePointer2
                  className="w-4 h-4 shrink-0"
                  aria-hidden="true"
                  style={{ color: myColor }}
                />
                <span
                  className="w-4 h-4 rounded-full border border-border ring-1 ring-border shrink-0"
                  style={{ backgroundColor: activeColor }}
                />
              </div>
              <span className="text-sm text-text font-mono font-medium truncate">
                {isEraser ? "Eraser" : color} · {lineWidth}px
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
