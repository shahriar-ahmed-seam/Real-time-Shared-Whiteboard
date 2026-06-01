import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { nanoid } from "nanoid";
import { Plus, ArrowRight, PenLine, Users, Zap, Sparkles, User } from "lucide-react";
import { Button, Input } from "../../components/ui";
import {
  getBoards,
  getSavedUsername,
  saveBoardVisit,
  saveUsername,
  type BoardEntry,
} from "../../lib/boardStorage";

// ─── HomeRoute ────────────────────────────────────────────────────────
// Entry surface: pick a display name, create a new board, or rejoin a recent
// one. Calm, token-driven layout built on the design-system primitives — no
// canvas/particle decoration, just a centered card over a subtle dot field.

const FEATURES = [
  { icon: <Users className="h-3 w-3" />, label: "Multi-user" },
  { icon: <Zap className="h-3 w-3" />, label: "Real-time" },
  { icon: <Sparkles className="h-3 w-3" />, label: "Infinite canvas" },
];

export default function HomeRoute() {
  const navigate = useNavigate();
  // Seed directly from storage at mount — no setState-in-effect needed.
  const [boards] = useState<BoardEntry[]>(() => getBoards());
  const [username, setUsername] = useState(() => getSavedUsername());
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);

  const enter = (boardId: string) => {
    const name = username.trim();
    if (!name) {
      setError("Enter a name to continue");
      return;
    }
    setError("");
    setLeaving(true);
    saveUsername(name);
    saveBoardVisit(boardId);
    window.setTimeout(
      () => navigate(`/board/${boardId}?user=${encodeURIComponent(name)}`),
      300,
    );
  };

  return (
    <div className="relative h-full w-full overflow-y-auto bg-bg text-text-strong">
      <div aria-hidden="true" className="paper-grid pointer-events-none absolute inset-0" />

      <div className="relative z-10 flex min-h-full w-full items-center justify-center px-4 py-10 sm:py-16">
        <div
          className={`w-full max-w-[420px] transition-all duration-500 motion-reduce:transition-none ${
            leaving ? "translate-y-2 scale-[0.97] opacity-0" : "translate-y-0 scale-100 opacity-100"
          }`}
        >
          {/* Brand */}
          <div className="mb-10 text-center">
            <div className="mb-6 inline-flex h-[76px] w-[76px] items-center justify-center rounded-xl bg-primary shadow-[var(--shadow-3)]">
              <PenLine className="h-9 w-9 text-text-on-primary" />
            </div>
            <h1 className="mb-1 text-3xl font-black leading-none tracking-tight">Synapse</h1>
            <p className="mb-6 text-sm font-medium uppercase tracking-[0.2em] text-text-muted">
              Collaborative Whiteboard
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {FEATURES.map(({ icon, label }) => (
                <span
                  key={label}
                  className="inline-flex select-none items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold text-text-muted"
                >
                  {icon}
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Card */}
          <div className="rounded-2xl border border-border bg-surface-1 p-7 shadow-[var(--shadow-2)]">
            <Input
              label="Display name"
              placeholder="Enter your name..."
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && enter(nanoid(10))}
              maxLength={20}
              error={error || undefined}
              leading={<User className="h-4 w-4" />}
            />

            <div className="my-5 h-px bg-border" />

            <Button onClick={() => enter(nanoid(10))} className="group w-full">
              <Plus className="h-5 w-5 transition-transform duration-[var(--motion-fast)] group-hover:rotate-90 motion-reduce:transition-none" />
              Create new board
            </Button>

            {boards.length > 0 && (
              <div className="mt-7">
                <div className="mb-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs font-bold uppercase tracking-[0.2em] text-text-muted">
                    Recent boards
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="space-y-2">
                  {boards.map((board) => (
                    <button
                      key={board.id}
                      type="button"
                      onClick={() => enter(board.id)}
                      aria-label={`Open board ${board.id}`}
                      className="group flex w-full cursor-pointer items-center justify-between rounded-xl border border-border bg-surface-2 px-4 py-3 text-left transition-colors duration-[var(--motion-fast)] hover:border-primary hover:bg-surface-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-bold tracking-wide text-text">
                          {board.id}
                        </p>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {new Date(board.lastVisited).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      <ArrowRight className="ml-3 h-4 w-4 shrink-0 text-text-muted transition-colors duration-[var(--motion-fast)] group-hover:text-primary motion-reduce:transition-none" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <p className="mt-6 text-center text-xs uppercase tracking-widest text-text-muted">
            Share board link · Collaborate instantly
          </p>
        </div>
      </div>
    </div>
  );
}
