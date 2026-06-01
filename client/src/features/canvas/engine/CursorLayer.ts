import type { Viewport } from "./Viewport";
import type { RoomUser } from "../../collaboration/transport/protocol";

// ─── CursorLayer (Tier B — DOM, no React) ─────────────────────────────
// Renders remote cursors as absolutely-positioned DOM nodes updated via
// compositor-only `transform: translate3d(...)`. This is presence, not canvas
// pixels: keeping it in the DOM means crisp labels and GPU-composited motion
// with ZERO React reconciliation and zero layout/reflow on the hot path.
//
// Inbound `cursor-update` frames mutate `positions` and request a frame; the
// engine calls render() on its tick. A viewport change also requests a render
// so cursors track pan/zoom. Membership (who exists / their color+name) is
// pushed from the low-frequency presence store via setUsers().

interface CursorNode {
  root: HTMLDivElement;
  label: HTMLDivElement;
  color: string;
  name: string;
}

export class CursorLayer {
  private container: HTMLElement | null = null;
  private readonly nodes = new Map<string, CursorNode>();
  private readonly positions = new Map<string, { x: number; y: number }>();
  private users: RoomUser[] = [];
  private myColor = "";
  private readonly viewport: Viewport;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
  }

  mount(container: HTMLElement): void {
    this.container = container;
  }

  unmount(): void {
    for (const node of this.nodes.values()) node.root.remove();
    this.nodes.clear();
    this.positions.clear();
    this.container = null;
  }

  /** Update membership (color/name per socket) and prune departed cursors. */
  setUsers(users: RoomUser[], myColor: string): void {
    this.users = users;
    this.myColor = myColor;

    const present = new Set(users.map((u) => u.socketId));
    for (const [socketId, node] of this.nodes) {
      if (!present.has(socketId)) {
        node.root.remove();
        this.nodes.delete(socketId);
        this.positions.delete(socketId);
      }
    }
  }

  /** Record a remote cursor's world-space position (from `cursor-update`). */
  setPosition(socketId: string, x: number, y: number): void {
    this.positions.set(socketId, { x, y });
  }

  /** Reposition every cursor node for the current frame. */
  render(): void {
    const container = this.container;
    if (!container) return;

    for (const user of this.users) {
      if (user.cursorColor === this.myColor) continue; // never draw my own
      const pos = this.positions.get(user.socketId);
      if (!pos) continue;

      const node = this.ensureNode(user);
      const screen = this.viewport.toScreen(pos);
      // Compositor-only transform: no layout, no reflow, no React.
      node.root.style.transform = `translate3d(${screen.x}px, ${screen.y}px, 0)`;
    }
  }

  // ─── Node management ──────────────────────────────────────────────

  private ensureNode(user: RoomUser): CursorNode {
    const existing = this.nodes.get(user.socketId);
    if (existing) {
      if (existing.color !== user.cursorColor) {
        existing.color = user.cursorColor;
        existing.label.style.backgroundColor = user.cursorColor;
        existing.root.querySelector("svg path")?.setAttribute("fill", user.cursorColor);
      }
      if (existing.name !== user.username) {
        existing.name = user.username;
        existing.label.textContent = user.username;
      }
      return existing;
    }

    const root = document.createElement("div");
    root.className = "absolute left-0 top-0 will-change-transform pointer-events-none";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <svg width="24" height="26" viewBox="0 0 24 26" fill="none" class="drop-shadow-lg" style="transform: translate(-3px, -3px)">
        <path d="M3 1.5L20 14.5H10.5L6.5 24.5L3 1.5Z" fill="${user.cursorColor}" stroke="rgba(0,0,0,0.5)" stroke-width="2" stroke-linejoin="round" />
      </svg>`;

    const label = document.createElement("div");
    label.className =
      "absolute left-5 top-5 px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap shadow-[var(--shadow-md)]";
    label.style.backgroundColor = user.cursorColor;
    label.style.color = "#fff";
    label.textContent = user.username;
    root.appendChild(label);

    this.container!.appendChild(root);
    const node: CursorNode = { root, label, color: user.cursorColor, name: user.username };
    this.nodes.set(user.socketId, node);
    return node;
  }
}
