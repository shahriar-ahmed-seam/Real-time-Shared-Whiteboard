import type { ConnectionContext } from "../socket/context";

// ─── request-resync handler ──────────────────────────────────────────
// Reconnection / gap-recovery flow (design "Reconnection / state resync").
// A client tracks the highest Sequence_Number it has applied. When it detects a
// gap in the live `draw` stream (a stroke arrives more than one past its
// highest applied seq) or simply reconnects, it emits `request-resync` with
// `{ roomId, sinceSeq }`, where `sinceSeq` is that highest applied seq. The
// server replays exactly what the client is missing and nothing it already has,
// so the two canvases converge with no stroke applied twice.
//
// The decision the server makes (design `onClientReconnect`):
//
//   • reported seq is missing / invalid / below the compaction baseline, or
//     strictly above the server's highest seq → the client may be behind the
//     pruned prefix or reporting a value the server never issued, so send the
//     authoritative full reload (baseline snapshot + the whole retained tail);
//   • otherwise the client only missed a recent tail → send just the ordered
//     delta of strokes with seq greater than the reported value.
//
// {@link StrokeService.loadForJoin} already encodes this split: with no
// `sinceSeq` it returns the baseline snapshot + full tail; with a `sinceSeq` at
// or above the baseline it returns only the strokes after it (no snapshot). So
// the handler's job is to normalize the reported seq, pick between "reload from
// baseline" and "ordered delta", and emit the loadForJoin result on the same
// `room-history` channel the join flow uses (the client applies it and adopts
// the highest delivered seq as its new high-water mark).
//
// The Auth_Guard has already verified this connection's Join_Token for the
// referenced room during gateway dispatch (Requirement 2.1), so the handler
// trusts `ctx.userId`.
//
// Requirements:
//   3.4 — send every stroke with a Sequence_Number greater than the reported
//         value in ascending Sequence_Number order, so afterward the client's
//         highest applied seq equals the server's highest seq and no stroke is
//         applied more than once.
//   3.7 — IF the reported seq is below the board's compaction baseline, send the
//         baseline snapshot plus the strokes following it rather than the pruned
//         strokes.
//   3.8 — IF the reported seq is greater than the server's highest seq, discard
//         it and resynchronize the client from the baseline snapshot. A missing,
//         zero, negative, or fractional value is likewise discarded and treated
//         as a fresh reload from baseline.

/**
 * Normalize the client-reported "highest applied Sequence_Number" into either a
 * positive integer or `undefined`.
 *
 * A reconnecting client reports the last seq it applied; a value that is not a
 * positive integer (missing, `0`, negative, `NaN`, or fractional) is not a sane
 * reconnect position and is normalized to `undefined`, which downstream means
 * "resynchronize from the full baseline" (Requirement 3.8). Mirrors the join
 * handler's normalization so the two entry points agree on what a valid
 * reconnect seq is.
 */
function normalizeSinceSeq(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return undefined;
  }
  return raw;
}

export function registerResync(ctx: ConnectionContext): void {
  const { socket, deps } = ctx;
  const { strokeService, logger } = deps;

  socket.on(
    "request-resync",
    async (data: { roomId?: string; sinceSeq?: number }) => {
      // The client always carries the room id on the payload; fall back to the
      // room this socket has joined so a payload that omits it still resolves.
      const roomId =
        typeof data?.roomId === "string" && data.roomId.length > 0
          ? data.roomId
          : ctx.currentRoomId;
      const userId = ctx.userId ?? socket.id;

      if (!roomId) {
        socket.emit("error", {
          code: "RESYNC_FAILED",
          message: "A room id is required to resync.",
        });
        return;
      }

      const sinceSeq = normalizeSinceSeq(data?.sinceSeq);

      try {
        // Probe the authoritative baseline once: the snapshot baseline seq and
        // the server's highest seq. This payload doubles as the full-reload
        // body, so the reload paths reuse it without a second query; only the
        // genuine "ordered delta" path issues a second, smaller load.
        const baseline = await strokeService.loadForJoin(roomId);
        const snapshotSeq = baseline.snapshot?.snapshotSeq ?? 0;
        const serverHighestSeq =
          baseline.strokes.length > 0
            ? baseline.strokes[baseline.strokes.length - 1].seq
            : snapshotSeq;

        // Reload from baseline when the reported seq is unusable, predates the
        // compaction baseline (Req 3.7), or exceeds the server's highest seq
        // (Req 3.8). loadForJoin(roomId) with no sinceSeq is exactly the
        // baseline snapshot + full tail those cases require.
        const reloadFromBaseline =
          sinceSeq === undefined ||
          sinceSeq < snapshotSeq ||
          sinceSeq > serverHighestSeq;

        if (reloadFromBaseline) {
          socket.emit("room-history", baseline);
          logger.info(
            {
              event: "request-resync",
              roomId,
              userId,
              sinceSeq: sinceSeq ?? 0,
              mode: "baseline",
              serverHighestSeq,
            },
            `Resynced ${socket.id} in room "${roomId}" from baseline`,
          );
          return;
        }

        // The client only missed a recent tail: send the ordered delta of
        // strokes with seq greater than the reported value (Req 3.4). At or
        // above the baseline, loadForJoin returns just that delta, no snapshot.
        const delta = await strokeService.loadForJoin(roomId, sinceSeq);
        socket.emit("room-history", delta);
        logger.info(
          {
            event: "request-resync",
            roomId,
            userId,
            sinceSeq,
            mode: "delta",
            sent: delta.strokes.length,
            serverHighestSeq,
          },
          `Resynced ${socket.id} in room "${roomId}" with ${delta.strokes.length} stroke(s)`,
        );
      } catch (err) {
        // History (Postgres) access failed. Keep the connection open and surface
        // a recoverable error so the client can retry rather than being left
        // with a stale or gapped canvas.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { event: "request-resync", roomId, userId, err: message },
          `Failed to resync room "${roomId}": ${message}`,
        );
        socket.emit("error", {
          code: "RESYNC_FAILED",
          message: "Could not resync the board. Please retry.",
        });
      }
    },
  );
}
