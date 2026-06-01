import type { Server, Socket } from "socket.io";
import type { RoomRepository } from "../repositories/roomRepository";
import type { RoomService } from "../services/roomService";
import type { PresenceService } from "../services/presenceService";
import type { StrokeService } from "../services/strokeService";
import { childLogger, type Logger } from "../observability/logger";
import type { AuthGuard, AuthResult } from "../middleware/authGuard";
import { createSocketRateLimiter, type RateLimiter } from "../middleware/rateLimiter";

// ─── Per-connection context ──────────────────────────────────────────
// Bundles the dependencies a handler needs plus the mutable per-connection
// state built during the connection lifecycle:
//
//   • `token`        — the Join_Token presented in the socket handshake
//                      (`handshake.auth.token`), read once on connect.
//   • `userId`       — the stable identity returned by the Auth_Guard once a
//                      room-scoped event has been authorized (Requirement 2.1).
//   • `currentRoomId`— the room the socket has joined (prototype `currentRoomId`).
//   • `rateLimiter`  — a fresh per-connection token-bucket limiter so the
//                      `draw`/`cursor-move` buckets are scoped per socket.
//   • `logger`       — a child logger stamped with the connection correlation
//                      id so every log line for this socket is correlated.
//
// The gateway runs the Auth_Guard against the referenced room on each
// room-scoped event via {@link ConnectionContext.authorize}; handlers consume
// the rate limiter and the resolved `userId`.

export interface ConnectionDeps {
  io: Server;
  rooms: RoomRepository;
  roomService: RoomService;
  presenceService: PresenceService;
  /**
   * Assigns Sequence_Numbers, buffers/persists strokes, and serves the
   * snapshot + tail history a (re)joining client needs (`loadForJoin`).
   * Consumed by the join handler (task 6.2) and the draw handler (task 6.3).
   */
  strokeService: StrokeService;
  /**
   * Verifies a room-scoped Join_Token's signature, expiry, and scope
   * (Requirement 2.1). Honors OPEN_MODE to bypass verification for demos.
   */
  authGuard: AuthGuard;
  logger: Logger;
}

export class ConnectionContext {
  /** The room this socket has joined, or null before joining. */
  currentRoomId: string | null = null;

  /**
   * Stable per-join identity resolved by the Auth_Guard once a room-scoped
   * event is authorized. Null until the first successful authorization.
   */
  userId: string | null = null;

  /** Join_Token presented in the handshake (`auth.token`), or null if absent. */
  readonly token: string | null;

  /** Per-connection token-bucket rate limiter (draw / cursor-move buckets). */
  readonly rateLimiter: RateLimiter;

  /** Connection-correlated child logger (`connectionId` bound). */
  readonly logger: Logger;

  constructor(
    public readonly socket: Socket,
    public readonly deps: ConnectionDeps
  ) {
    this.token = readHandshakeToken(socket);
    this.rateLimiter = createSocketRateLimiter();
    this.logger = childLogger({ connectionId: socket.id }, deps.logger);
  }

  /**
   * Verify the connection's Join_Token against a referenced room using the
   * Auth_Guard (Requirement 2.1). On success the resolved `userId` is cached on
   * the context. Never throws — ordinary auth failures are returned as a
   * discriminated result the gateway acts on.
   *
   * @param roomId        The room the inbound event references.
   * @param tokenOverride A token carried on the event payload (e.g. the
   *                      `join-room` payload's `token` field). When omitted the
   *                      handshake token is used; pass `null` to force "no token".
   */
  authorize(roomId: string, tokenOverride?: string | null): AuthResult {
    const token = tokenOverride !== undefined ? tokenOverride : this.token;
    const result = this.deps.authGuard.verify(token, roomId);
    if (result.ok) {
      this.userId = result.userId;
    }
    return result;
  }
}

/**
 * Read the Join_Token a client presents in the socket handshake
 * (`handshake.auth.token`). Returns null when absent or not a non-empty string,
 * so a missing token is normalized to a single value the Auth_Guard rejects.
 */
export function readHandshakeToken(socket: Socket): string | null {
  const auth = socket.handshake?.auth as { token?: unknown } | undefined;
  const token = auth?.token;
  return typeof token === "string" && token.length > 0 ? token : null;
}
