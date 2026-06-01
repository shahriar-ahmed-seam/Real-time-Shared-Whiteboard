// ─── Local board / username persistence ───────────────────────────────
// Small, dependency-free wrapper over localStorage for the recent-boards list
// and the remembered display name. Pure data access; no UI.

const BOARDS_KEY = "synapse-boards";
const USERNAME_KEY = "synapse-username";
const MAX_BOARDS = 5;

export interface BoardEntry {
  id: string;
  lastVisited: string;
}

export function getBoards(): BoardEntry[] {
  try {
    const raw = localStorage.getItem(BOARDS_KEY);
    return raw ? (JSON.parse(raw) as BoardEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveBoardVisit(id: string): void {
  const boards = getBoards().filter((b) => b.id !== id);
  boards.unshift({ id, lastVisited: new Date().toISOString() });
  try {
    localStorage.setItem(BOARDS_KEY, JSON.stringify(boards.slice(0, MAX_BOARDS)));
  } catch {
    // Ignore storage failures (private mode / quota).
  }
}

export function getSavedUsername(): string {
  try {
    return localStorage.getItem(USERNAME_KEY) || "";
  } catch {
    return "";
  }
}

export function saveUsername(name: string): void {
  try {
    localStorage.setItem(USERNAME_KEY, name);
  } catch {
    // Ignore storage failures.
  }
}
