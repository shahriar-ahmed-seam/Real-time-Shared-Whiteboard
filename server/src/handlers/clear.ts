import type { ConnectionContext } from "../socket/context";
import { ClearSchema, parsePayload } from "../validation/schemas";

// ─── clear handler ───────────────────────────────────────────────────
// Hardened "clear the board" relay. Unlike the prototype (which trusted a bare
// roomId string and reset an in-memory array), this validates the payload,
// enforces own-room authorization, and broadcasts the clear to the room over
// the Redis adapter so it reaches every member regardless of which instance
// they are connected to (Requirement 5.2).
//
// Pipeline:
//   1. Schema-validate the `{ roomId }` payload; a failure drops the event,
//      returns an invalid-payload error indication, and keeps the connection
//      open (Requirements 2.2, 2.11). parsePayload never throws.
//   2. Enforce own-room authorization: a socket may only clear the room it has
//      joined (the gateway Auth_Guard already verified the Join_Token's scope;
//      this is the same defense-in-depth own-room check the draw handler uses).
//   3. Broadcast `clear` to the room.
//
// Persisted clear marker (design "clear → persisted as a clear marker"):
// the design's StrokeService interface lists a `clear(boardId)` operation that
// would record a durable clear marker (advancing the board baseline so the
// cleared strokes are not replayed to future joiners). The StrokeService
// implemented for this milestone does not yet expose that operation, and there
// is no clear-marker API on the repositories, so this handler performs the
// authorized broadcast only. Wiring durable clear-marker persistence is left
// for when the StrokeService.clear seam lands; the broadcast contract here is
// unaffected by that addition.

export function registerClear(ctx: ConnectionContext): void {
  const { socket } = ctx;

  socket.on("clear", async (data: unknown) => {
    // The prototype emitted `clear` with a bare roomId string; the validated
    // protocol uses `{ roomId }`. Accept both shapes by normalizing a bare
    // string into the object the schema expects before validating.
    const payload = typeof data === "string" ? { roomId: data } : data;

    // 1. Validate (Requirements 2.2, 2.11).
    const parsed = parsePayload(ClearSchema, payload);
    if (!parsed.success) {
      ctx.logger.debug(
        { event: "clear", issues: parsed.issues },
        "Dropped invalid clear payload",
      );
      socket.emit("error", {
        code: "INVALID_PAYLOAD",
        message: "clear rejected",
      });
      return;
    }

    const { roomId } = parsed.data;

    // 2. Own-room authorization: only clear the room this socket has joined.
    if (roomId !== ctx.currentRoomId) {
      return;
    }

    // 3. Broadcast the clear to the other members of the room. Fans out across
    //    instances via the Redis adapter (Requirement 5.2). The client `clear`
    //    handler takes no payload, matching the design's Server → Client table.
    socket.to(roomId).emit("clear");

    ctx.logger.info(
      { event: "clear", roomId, userId: ctx.userId ?? socket.id },
      `Board "${roomId}" cleared by ${socket.id}`,
    );
  });
}
