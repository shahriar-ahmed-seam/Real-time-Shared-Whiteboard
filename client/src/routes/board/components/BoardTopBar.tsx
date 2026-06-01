import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Home, Copy, Check } from "lucide-react";
import { Button, Tooltip } from "../../../components/ui";
import { AvatarStack } from "../../../features/presence/components/AvatarStack";
import { SyncStatusBadge } from "../../../features/presence/components/SyncStatusBadge";
import { ZoomIndicator } from "../../../features/canvas/components/ZoomIndicator";
import { useUsers } from "../../../stores/presenceStore";
import { useMyColor, useConnected } from "../../../stores/sessionStore";
import { useToast } from "../../../components/ui";
import type { CanvasEngine } from "../../../features/canvas/engine/CanvasEngine";

// ─── BoardTopBar (Tier A — floating chrome) ───────────────────────────
// Independent floating layer over the canvas. Three isolated clusters: room
// identity + copy-link (left), zoom + sync status (center), identity + avatar
// stack (right). Reflows with flex-wrap so it never forces horizontal scroll.

export function BoardTopBar({
  engine,
  roomId,
  username,
}: {
  engine: CanvasEngine;
  roomId: string;
  username: string;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const users = useUsers();
  const myColor = useMyColor();
  const connected = useConnected();
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/board/${roomId}`);
      setCopied(true);
      toast({ message: "Board link copied", variant: "success" });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ message: "Could not copy the link", variant: "error" });
    }
  };

  return (
    <div className="absolute inset-x-3 top-3 z-50 flex flex-wrap items-center justify-between gap-2 sm:inset-x-4 sm:top-4 sm:gap-3">
      {/* Left: home + room + copy */}
      <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-1/95 px-2 py-1.5 shadow-[var(--shadow-md)] backdrop-blur-xl">
        <Tooltip label="Home" placement="bottom">
          <Button variant="icon" aria-label="Go to home" onClick={() => navigate("/")}>
            <Home className="h-4 w-4" />
          </Button>
        </Tooltip>
        <div className="h-6 w-px bg-border" aria-hidden="true" />
        <span className="max-w-[80px] truncate px-2 font-mono text-xs text-text-muted sm:max-w-[140px]">
          {roomId}
        </span>
        <Tooltip label={copied ? "Link copied" : "Copy board link"} placement="bottom">
          <Button variant="icon" aria-label="Copy board link" onClick={copyLink}>
            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </Button>
        </Tooltip>
      </div>

      {/* Center: zoom + sync */}
      <div className="flex items-center gap-2 sm:gap-3">
        <ZoomIndicator engine={engine} />
        <div className="rounded-xl border border-border bg-surface-1/95 shadow-[var(--shadow-md)] backdrop-blur-xl">
          <SyncStatusBadge connected={connected} compact />
        </div>
      </div>

      {/* Right: identity + avatars */}
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-surface-1/95 px-3 py-2.5 shadow-[var(--shadow-md)] backdrop-blur-xl sm:px-4">
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-border"
            style={{ backgroundColor: myColor }}
          />
          <span className="max-w-[80px] truncate text-sm font-medium text-text sm:max-w-none">
            {username}
          </span>
        </div>
        <div className="rounded-xl border border-border bg-surface-1/95 px-2 py-1.5 shadow-[var(--shadow-md)] backdrop-blur-xl">
          <AvatarStack users={users} myColor={myColor} />
        </div>
      </div>
    </div>
  );
}
