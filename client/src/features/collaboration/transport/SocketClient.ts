import { io, type Socket } from "socket.io-client";
import { SERVER_URL } from "../../../config/env";
import type { ClientToServerEvents, ServerToClientEvents } from "./events";
import type { StrokeSegment } from "./protocol";

// ─── SocketClient ─────────────────────────────────────────────────────
// Thin, fully-typed wrapper over socket.io-client. Owns the connection and
// exposes intent-named emit methods plus a typed `on` so the rest of the app
// never touches raw event strings. socket.io's built-in reconnection is left
// on; the connect/disconnect lifecycle is surfaced to the session store by the
// collaboration hook.

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export class SocketClient {
  private socket: TypedSocket | null = null;

  /** Open the connection. Idempotent — a second call returns the live socket. */
  connect(): TypedSocket {
    if (this.socket) return this.socket;
    this.socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
    });
    return this.socket;
  }

  /** Close the connection and drop the instance. */
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  get id(): string | undefined {
    return this.socket?.id;
  }

  /** Subscribe to a server event. Returns an unsubscribe function. */
  on<E extends keyof ServerToClientEvents>(
    event: E,
    listener: ServerToClientEvents[E],
  ): () => void {
    this.socket?.on(event, listener as never);
    return () => {
      this.socket?.off(event, listener as never);
    };
  }

  // ─── Intent-named emitters (Client → Server) ──────────────────────

  joinRoom(roomId: string, username: string, sinceSeq: number): void {
    this.socket?.emit("join-room", { roomId, username, sinceSeq });
  }

  draw(roomId: string, stroke: StrokeSegment): void {
    this.socket?.emit("draw", { roomId, stroke });
  }

  /** Volatile cursor relay — a dropped frame is harmless; the next supersedes it. */
  cursorMove(roomId: string, x: number, y: number): void {
    this.socket?.volatile.emit("cursor-move", { roomId, x, y });
  }

  clear(roomId: string): void {
    this.socket?.emit("clear", { roomId });
  }

  requestResync(roomId: string, sinceSeq: number): void {
    this.socket?.emit("request-resync", { roomId, sinceSeq });
  }
}
