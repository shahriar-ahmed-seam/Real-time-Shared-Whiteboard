import { useState } from "react";
import { Popover } from "../../../components/ui";
import { cn } from "../../../components/ui/utils";
import type { RoomUser } from "../../collaboration/transport/protocol";

// ─── AvatarStack (Tier A — low frequency) ─────────────────────────────
// Overlapping avatar stack of the people in the room. Driven purely by the
// presence store's membership list + the session's `myColor`; it re-renders
// only when someone joins/leaves, never on cursor motion.

const MAX_VISIBLE = 4;

/** First grapheme of a display name, upper-cased, for the avatar initial. */
function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

/** Pick a readable on-color (black/white) for text drawn over a hex fill. */
function onColor(hex: string): string {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  if (full.length < 6) return "#000";
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1f1f1f" : "#ffffff";
}

function Avatar({
  user,
  isYou,
  ring,
}: {
  user: RoomUser;
  isYou: boolean;
  ring?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex h-8 w-8 items-center justify-center rounded-full",
        "text-xs font-semibold ring-2 ring-surface-1",
        ring && "outline outline-2 outline-offset-1 outline-primary",
      )}
      style={{ backgroundColor: user.cursorColor, color: onColor(user.cursorColor) }}
      title={isYou ? `${user.username} (you)` : user.username}
    >
      {initial(user.username)}
      <span
        aria-hidden="true"
        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-surface-1"
      />
    </span>
  );
}

export function AvatarStack({
  users,
  myColor,
}: {
  users: RoomUser[];
  myColor: string;
}) {
  const [open, setOpen] = useState(false);

  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.length - visible.length;
  const label = `${users.length} ${users.length === 1 ? "person" : "people"} in this board`;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      aria-label="People in this board"
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cn(
            "flex items-center -space-x-2 rounded-full p-0.5",
            "outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
            "cursor-pointer",
          )}
        >
          {visible.map((u) => (
            <Avatar
              key={u.socketId}
              user={u}
              isYou={u.cursorColor === myColor}
              ring={u.cursorColor === myColor}
            />
          ))}
          {overflow > 0 && (
            <span
              className={cn(
                "relative inline-flex h-8 w-8 items-center justify-center rounded-full",
                "bg-surface-3 text-xs font-semibold text-text ring-2 ring-surface-1",
              )}
            >
              +{overflow}
            </span>
          )}
        </button>
      }
    >
      <div className="w-60">
        <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">
          {label}
        </div>
        <ul className="flex flex-col">
          {users.map((u) => {
            const isYou = u.cursorColor === myColor;
            return (
              <li
                key={u.socketId}
                className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 hover:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-6 shrink-0 rounded-full ring-1 ring-border"
                  style={{ backgroundColor: u.cursorColor }}
                />
                <span className="flex-1 truncate text-sm text-text">
                  {u.username}
                </span>
                {isYou && (
                  <span className="text-xs font-medium text-text-muted">(you)</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Popover>
  );
}
