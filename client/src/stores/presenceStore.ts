import { createStore, useStore } from "./createStore";
import type { RoomUser } from "../features/collaboration/transport/protocol";

// ─── Presence store (Tier A — low frequency) ──────────────────────────
// Room MEMBERSHIP only — the user list that drives the avatar stack. This flips
// when someone joins or leaves (seconds-scale), so it is allowed to re-render.
//
// Deliberate boundary: live cursor COORDINATES are NOT here. Those are the
// highest-frequency inbound signal and live in the imperative engine's cursor
// layer (Tier B), updated by direct transform mutation with zero React work.

export interface PresenceState {
  users: RoomUser[];
}

export const presenceStore = createStore<PresenceState>({ users: [] });

export function setUsers(users: RoomUser[]): void {
  presenceStore.set({ users });
}

export const useUsers = () => useStore(presenceStore, (s) => s.users);
