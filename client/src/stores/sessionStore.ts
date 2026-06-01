import { createStore, useStore } from "./createStore";

// ─── Session store (Tier A — low frequency) ───────────────────────────
// Identity and connection lifecycle for the current board session: who I am,
// my server-assigned cursor color, and whether the socket is currently up.
// These flip rarely (join, connect/disconnect) and drive chrome like the
// identity pill and the reconnection badge — never the canvas hot path.

export interface SessionState {
  roomId: string;
  username: string;
  /** True once the user has committed a name and joining has begun. */
  joined: boolean;
  /** Server-assigned cursor color for this connection. */
  myColor: string;
  /** Live socket connection status; drives the "Reconnecting…" indicator. */
  connected: boolean;
}

export const sessionStore = createStore<SessionState>({
  roomId: "",
  username: "",
  joined: false,
  myColor: "#ffffff",
  connected: false,
});

// ─── Actions ──────────────────────────────────────────────────────────

export function initSession(roomId: string, username: string, joined: boolean): void {
  sessionStore.set({ roomId, username, joined });
}

export function commitJoin(username: string): void {
  sessionStore.set({ username, joined: true });
}

export function setMyColor(myColor: string): void {
  sessionStore.set({ myColor });
}

export function setConnected(connected: boolean): void {
  sessionStore.set({ connected });
}

// ─── Hooks ──────────────────────────────────────────────────────────────

export const useSession = () => useStore(sessionStore);
export const useConnected = () => useStore(sessionStore, (s) => s.connected);
export const useMyColor = () => useStore(sessionStore, (s) => s.myColor);
export const useJoined = () => useStore(sessionStore, (s) => s.joined);
