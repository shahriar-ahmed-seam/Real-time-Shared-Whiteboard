import type {
  CursorUpdate,
  PersistedStroke,
  RoomHistory,
  RoomUser,
  SocketError,
  StrokeSegment,
} from "./protocol";

// ─── Typed Socket.IO event maps ───────────────────────────────────────
// The exact event names and payloads the server registers (server/src/socket/
// gateway.ts + handlers). socket.io-client is parameterized with these so every
// `emit`/`on` is checked against the real contract at compile time — a wrong
// event name or payload shape becomes a type error, not a silent runtime drop.

/** Server → Client events (what the client listens for). */
export interface ServerToClientEvents {
  /** Assigned cursor color for this connection. */
  "your-color": (color: string) => void;
  /** Baseline snapshot (optional) + ordered stroke tail. OBJECT shape. */
  "room-history": (history: RoomHistory) => void;
  /** A peer's persisted stroke, enriched with seq/id/userId/ts. */
  draw: (stroke: PersistedStroke) => void;
  /** A peer's live cursor position (volatile). */
  "cursor-update": (data: CursorUpdate) => void;
  /** Full room membership list. */
  "users-update": (users: RoomUser[]) => void;
  /** The board was cleared (no payload). */
  clear: () => void;
  /** A recoverable error indication. */
  error: (error: SocketError) => void;
}

/** Client → Server events (what the client emits). */
export interface ClientToServerEvents {
  /** Join/reconnect to a room. `sinceSeq` drives resync from the last applied seq. */
  "join-room": (data: {
    roomId: string;
    username: string;
    token?: string;
    sinceSeq?: number;
  }) => void;
  /** Append a stroke segment to a room. */
  draw: (data: { roomId: string; stroke: StrokeSegment }) => void;
  /** Relay this connection's cursor (emitted volatile). */
  "cursor-move": (data: { roomId: string; x: number; y: number }) => void;
  /** Clear the board. */
  clear: (data: { roomId: string }) => void;
  /** Request a replay of everything missed since `sinceSeq`. */
  "request-resync": (data: { roomId: string; sinceSeq: number }) => void;
}
