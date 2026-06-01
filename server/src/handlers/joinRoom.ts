import type { ConnectionContext } from "../socket/context";
import type { User } from "../types/domain";

// ─── join-room handler ───────────────────────────────────────────────
// Production join flow. When a client joins (or reconnects to) a board the
// handler:
//
//   1. joins the socket.io room so subsequent broadcasts reach this socket;
//   2. allocates a distinct cursor color and registers presence in the
//      Coordination_Store (Redis-backed PresenceService — both async and
//      consistent across instances, Requirement 5.1);
//   3. sends the assigned cursor color back to the joining client
//      (`your-color`);
//   4. serves the board's current state as a baseline snapshot (if any) plus
//      the strokes following it in ascending Sequence_Number order
//      (`room-history` carries `{ snapshot?, strokes }` per the design's
//      Server → Client protocol table);
//   5. broadcasts the updated member list to the room (`users-update`).
//
// The Auth_Guard has already verified the connection's Join_Token for this room
// during gateway dispatch (Requirement 2.1) and resolved the stable `userId`
// onto the connection context, so this handler trusts `ctx.userId`.
//
// Requirements:
//   3.5 — on join, send the current board state as a baseline snapshot plus the
//         strokes following that snapshot in ascending Sequence_Number order.
//   3.7 — IF a reconnecting client reports a highest-applied Sequence_Number
//         below the board's compaction baseline, send the baseline snapshot
//         plus the strokes following it rather than the pruned strokes. This is
//         exactly what {@link StrokeService.loadForJoin} does when the reported
//         `sinceSeq` is below `snapshot_seq`.
//   3.8 — a reported seq that is not a sane reconnect value (missing, 0,
//         negative, fractional, or otherwise out of range) is discarded and the
//         client is resynchronized from the baseline snapshot + full tail (a
//         fresh load). The dedicated resync handler (task 6.5) additionally
//         handles a reported seq strictly above the server's highest.

/**
 * Normalize the client-reported "highest applied Sequence_Number" into a value
 * safe to pass to {@link StrokeService.loadForJoin}.
 *
 * A fresh joiner reports `0` (or omits the field); a reconnecting client
 * reports the last seq it applied. Anything that is not a positive integer
 * (missing, `0`, negative, `NaN`, or fractional) is treated as a fresh join by
 * returning `undefined`, so the client is resynchronized from the full baseline
 * snapshot + tail rather than from an unusable reported value (Requirement 3.8).
 */
function normalizeSinceSeq(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return undefined;
  }
  return raw;
}

export function registerJoinRoom(ctx: ConnectionContext): void {
  const { socket, deps } = ctx;
  const { io, presenceService, strokeService, logger } = deps;

  socket.on(
    "join-room",
    async (data: { roomId: string; username: string; sinceSeq?: number }) => {
      const roomId = data?.roomId;
      const username = data?.username;
      const sinceSeq = normalizeSinceSeq(data?.sinceSeq);

      // Stable per-join identity resolved by the Auth_Guard during gateway
      // authorization. Fall back to the socket id so presence always carries a
      // userId even if the guard path left it unset (e.g. OPEN_MODE edge).
      const userId = ctx.userId ?? socket.id;

      ctx.currentRoomId = roomId;
      socket.join(roomId);

      try {
        // 1. Allocate a distinct cursor color (atomic across nodes, Req 5.1)
        //    and register presence in the Coordination_Store. `join` returns
        //    the updated member list to broadcast.
        const cursorColor = await presenceService.allocateColor(roomId);
        const user: User = {
          socketId: socket.id,
          userId,
          username,
          cursorColor,
          cursor: null,
        };
        const members = await presenceService.join(roomId, user);

        // 2. Send the assigned cursor color back to the joining client.
        socket.emit("your-color", cursorColor);

        // 3. Serve the baseline snapshot (if any) plus the strokes following it
        //    in ascending seq order. When the reconnecting client's `sinceSeq`
        //    is below the compaction baseline, loadForJoin serves the snapshot
        //    instead of the pruned strokes (Requirements 3.5, 3.7).
        const history = await strokeService.loadForJoin(roomId, sinceSeq);
        socket.emit("room-history", history);

        // 4. Broadcast the updated member list to everyone in the room.
        io.to(roomId).emit("users-update", members);

        logger.info(
          { event: "join-room", roomId, userId, sinceSeq: sinceSeq ?? 0 },
          `${username} (${socket.id}) joined room "${roomId}"`,
        );
      } catch (err) {
        // Presence (Redis) or history (Postgres) access failed. Keep the
        // connection open and surface a recoverable error indication so the
        // client can retry, rather than leaving the user with a blank board.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { event: "join-room", roomId, userId, err: message },
          `Failed to complete join for room "${roomId}": ${message}`,
        );
        socket.emit("error", {
          code: "JOIN_FAILED",
          message: "Could not join the room. Please retry.",
        });
      }
    },
  );
}
