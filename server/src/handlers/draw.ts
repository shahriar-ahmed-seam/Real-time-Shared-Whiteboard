import type { ConnectionContext } from "../socket/context";
import type { SocketErrorPayload } from "../socket/gateway";
import { parsePayload, DrawSchema } from "../validation/schemas";

// ─── draw handler ────────────────────────────────────────────────────
// Production draw flow. On each inbound `draw` the handler, in order:
//
//   1. Rate-limits the event through the connection's token bucket
//      (`draw:<socketId>`, capacity 120 / refill 120/s). When the bucket is
//      empty the event is dropped — not persisted, not broadcast — and a
//      `RATE_LIMITED` error indication is returned to the sender while the
//      connection stays open (Requirements 2.3, 2.4).
//   2. Schema-validates the untrusted payload with `parsePayload(DrawSchema, …)`,
//      which never throws. On failure the event is dropped, an `INVALID_PAYLOAD`
//      error indication is returned, and the connection stays open
//      (Requirements 2.2, 2.11).
//   3. Enforces that the stroke targets the room this connection has joined.
//      The gateway's Auth_Guard already verified the Join_Token's scope for the
//      referenced room, but the handler still rejects a draw aimed at any room
//      other than the connection's authorized `currentRoomId`.
//   4. Appends the validated segment via the Stroke_Service, which assigns the
//      gap-free per-board Sequence_Number and buffers it for write-behind
//      persistence (Requirement 3.1), returning the enriched PersistedStroke.
//   5. Broadcasts the enriched stroke to the other room members via
//      `socket.to(roomId)`, which fans out across every instance through the
//      Socket.IO Redis adapter (Requirement 5.2).
//   6. Triggers `maybeCompact` (fire-and-forget) to keep board memory bounded.
//
// An unexpected failure while persisting or broadcasting is logged with the
// connection/room correlation ids and the event is discarded; the process and
// other connections keep operating (Requirement 7.4).

/** Error code returned when the draw payload fails schema validation. */
export const INVALID_PAYLOAD_CODE = "INVALID_PAYLOAD";

/** Error code returned when the connection's draw rate-limit bucket is empty. */
export const RATE_LIMITED_CODE = "RATE_LIMITED";

export function registerDraw(ctx: ConnectionContext): void {
  const { socket, deps } = ctx;
  const { strokeService, logger } = deps;

  socket.on("draw", (raw: unknown) => {
    // 1. Rate limit (Requirements 2.3, 2.4). Drop + notify, keep the
    //    connection open and never persist/broadcast a throttled event.
    if (!ctx.rateLimiter.tryConsume(`draw:${socket.id}`)) {
      const error: SocketErrorPayload = {
        code: RATE_LIMITED_CODE,
        message: "Draw rate limit exceeded; slow down",
      };
      socket.emit("error", error);
      return;
    }

    // 2. Schema validation (Requirements 2.2, 2.11). parsePayload never throws.
    const parsed = parsePayload(DrawSchema, raw);
    if (!parsed.success) {
      logger.warn(
        { event: "draw", reason: "invalid-payload", issues: parsed.issues },
        "Rejected draw: invalid payload",
      );
      const error: SocketErrorPayload = {
        code: INVALID_PAYLOAD_CODE,
        message: "Invalid draw payload",
      };
      socket.emit("error", error);
      return;
    }

    const { roomId, stroke } = parsed.data;

    // 3. Own-room authorization: a draw may only target the room this
    //    connection has joined. Anything else is dropped silently (the
    //    connection stays open; this is not a malformed payload).
    if (roomId !== ctx.currentRoomId) {
      logger.warn(
        { event: "draw", reason: "room-mismatch", roomId },
        "Rejected draw: targets a room the connection has not joined",
      );
      return;
    }

    // Stable per-join identity resolved by the Auth_Guard; fall back to the
    // socket id so the persisted stroke always carries an author (OPEN_MODE).
    const userId = ctx.userId ?? socket.id;

    // 4–6 run on the async path. Wrap so a persistence/broadcast failure is
    // logged and the event discarded without crashing the connection (Req 7.4).
    void (async () => {
      try {
        // 4. Assign Sequence_Number + buffer for durable persistence (Req 3.1).
        const persisted = await strokeService.append(roomId, userId, stroke);

        // 5. Broadcast the enriched stroke to the rest of the room. The Redis
        //    adapter fans this out across every instance (Requirement 5.2).
        socket.to(roomId).emit("draw", persisted);

        // 6. Keep per-board memory bounded; best-effort, never blocks the draw.
        void strokeService.maybeCompact(roomId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { event: "draw", roomId, userId, err: message },
          `Failed to process draw for room "${roomId}": ${message}`,
        );
      }
    })();
  });
}
