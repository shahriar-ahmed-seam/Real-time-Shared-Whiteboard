import type { ConnectionContext } from "../socket/context";
import { CursorMoveSchema, parsePayload } from "../validation/schemas";

// ─── cursor-move handler ─────────────────────────────────────────────
// Hardened relay of a user's live cursor position to the other members of
// their room. Cursor moves are the highest-frequency client → server event,
// so the handler is rate-limited, schema-validated, and broadcast over the
// *volatile* channel (a dropped cursor frame is harmless — the next one
// supersedes it — so it must never queue up behind a slow consumer or block).
//
// Pipeline (order matters):
//   1. Rate-limit FIRST via the per-connection token bucket so a flood — valid
//      or malformed — is bounded before any work is done (Requirement 2.9:
//      capacity 60, refill 60/s). An empty bucket drops the event silently and
//      keeps the connection open (Requirement 2.4).
//   2. Schema-validate the payload; a failure drops the event, returns an
//      invalid-payload error indication, and keeps the connection open
//      (Requirement 2.11). parsePayload never throws (Requirement 2.2).
//   3. Enforce own-room authorization: a socket may only move its cursor in the
//      room it has joined, mirroring the draw handler's defense.
//   4. Volatile-broadcast the cursor to every *other* member of the room so it
//      fans out across instances via the Redis adapter (Requirement 5.2), and
//      record the latest position in the distributed Presence_Service (which
//      also refreshes the member's liveness TTL).

export function registerCursorMove(ctx: ConnectionContext): void {
  const { socket, deps } = ctx;
  const { presenceService } = deps;

  socket.on("cursor-move", async (data: unknown) => {
    // 1. Rate limit (Requirements 2.9, 2.4). Drop silently when the bucket is
    //    empty — emitting an error per high-frequency cursor frame would itself
    //    be noise. The connection stays open.
    if (!ctx.rateLimiter.tryConsume(`cursor-move:${socket.id}`)) {
      return;
    }

    // 2. Validate (Requirements 2.2, 2.11). parsePayload returns a result and
    //    never throws on arbitrary/adversarial input.
    const parsed = parsePayload(CursorMoveSchema, data);
    if (!parsed.success) {
      ctx.logger.debug(
        { event: "cursor-move", issues: parsed.issues },
        "Dropped invalid cursor-move payload",
      );
      socket.emit("error", {
        code: "INVALID_PAYLOAD",
        message: "cursor-move rejected",
      });
      return;
    }

    const { roomId, x, y } = parsed.data;

    // 3. Own-room authorization: only relay cursors within the joined room.
    if (roomId !== ctx.currentRoomId) {
      return;
    }

    // 4a. Volatile broadcast to the other members of the room (Requirement 5.2).
    //     `volatile` lets Socket.IO drop the frame for any temporarily
    //     unwritable peer rather than buffering it; the next move replaces it.
    socket.volatile.to(roomId).emit("cursor-update", {
      socketId: socket.id,
      x,
      y,
    });

    // 4b. Record the latest cursor position in the distributed presence store
    //     and refresh the member's liveness TTL. A coordination-store hiccup
    //     must not break the (already delivered) live broadcast, so failures
    //     are logged and swallowed rather than propagated.
    try {
      await presenceService.updateCursor(roomId, socket.id, x, y);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(
        { event: "cursor-move", roomId, err: message },
        "Failed to persist cursor position to presence store",
      );
    }
  });
}
