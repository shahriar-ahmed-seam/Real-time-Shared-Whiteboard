import type { ConnectionContext } from "../socket/context";

// ─── disconnecting / disconnect handlers ─────────────────────────────
// Cleans up a socket's presence when it leaves. The `disconnecting` event
// fires while `socket.rooms` is still populated (it is cleared by the time
// `disconnect` fires), so this is the moment to remove the socket from every
// room it was in and notify the survivors.
//
// For each room the socket belongs to (excluding the socket's own id room that
// Socket.IO always includes):
//   1. Remove the user's presence entry from the distributed Presence_Service,
//      which also releases the user's cursor color back to the room's pool. The
//      call returns the updated member list (Requirement 5.4 — clean-leave path;
//      the TTL sweep handles unclean drops).
//   2. Broadcast the updated member list to the room's remaining members via the
//      Redis adapter so every instance's clients converge (Requirements 5.2, 5.6:
//      remaining members receive the updated room member list).
//
// Presence access (Redis) can fail; a failure for one room must not prevent
// cleaning up the others, so each room is handled independently and errors are
// logged rather than propagated. The handler keeps the process and other
// connections alive (Requirement 7.4).

export function registerDisconnecting(ctx: ConnectionContext): void {
  const { socket, deps } = ctx;
  const { io, presenceService } = deps;

  socket.on("disconnecting", async () => {
    // Snapshot the rooms now — `socket.rooms` is mutated as the socket leaves.
    // Skip the implicit per-socket room keyed by the socket id.
    const roomIds = [...socket.rooms].filter((roomId) => roomId !== socket.id);

    await Promise.all(
      roomIds.map(async (roomId) => {
        try {
          // 1. Remove presence + release color; returns the surviving members.
          const members = await presenceService.leave(roomId, socket.id);
          // 2. Notify the remaining members of the room (Requirements 5.6, 5.2).
          io.to(roomId).emit("users-update", members);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.error(
            { event: "disconnecting", roomId, err: message },
            `Failed to remove presence for ${socket.id} from room "${roomId}": ${message}`,
          );
        }
      }),
    );
  });

  socket.on("disconnect", (reason: string) => {
    ctx.logger.info(
      { event: "disconnect", reason },
      `Disconnected: ${socket.id} (${reason})`,
    );
  });
}
