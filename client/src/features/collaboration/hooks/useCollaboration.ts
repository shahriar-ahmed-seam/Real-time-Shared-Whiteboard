import { useEffect, useRef, useState } from "react";
import type { CanvasEngine } from "../../canvas/engine/CanvasEngine";
import { PointerSampler } from "../../canvas/input/PointerSampler";
import { SocketClient } from "../transport/SocketClient";
import { ResyncController } from "../sync/ResyncController";
import { throttle } from "../../../lib/throttle";
import { setConnected, setMyColor } from "../../../stores/sessionStore";
import { setUsers } from "../../../stores/presenceStore";
import { resolveBrush, uiStore } from "../../../stores/uiStore";
import { useToast } from "../../../components/ui";
import type { SocketError } from "../transport/protocol";

// ─── useCollaboration ─────────────────────────────────────────────────
// THE BOUNDARY. Wires the typed socket transport to the imperative canvas
// engine and the low-frequency stores, then attaches local pointer input. Once
// connected, the high-frequency paths (inbound draw/cursor, outbound segments/
// cursor) flow engine↔socket directly — React only wakes for the Tier-A store
// writes (color, users, connection status) and the occasional error toast.
//
// Server protocol (server/src/socket): `room-history` is the OBJECT shape
// `{ snapshot?, strokes }` — decoded here correctly (the legacy client's
// bare-array assumption is gone). Cursor frames are emitted volatile and
// throttled to the wire; segments are emitted per built segment.

/** Cursor wire cadence: ~50 fps is smooth and well under the server's 60/s cap. */
const CURSOR_EMIT_MS = 20;

export interface CollaborationOptions {
  engine: CanvasEngine;
  roomId: string;
  username: string;
  joined: boolean;
}

export function useCollaboration({
  engine,
  roomId,
  username,
  joined,
}: CollaborationOptions): SocketClient {
  const { toast } = useToast();

  // Latest roomId/username without re-subscribing the socket on every keystroke.
  const roomIdRef = useRef(roomId);
  const usernameRef = useRef(username);
  useEffect(() => {
    roomIdRef.current = roomId;
    usernameRef.current = username;
  }, [roomId, username]);

  // Stable socket client for this hook's lifetime.
  const [client] = useState(() => new SocketClient());

  useEffect(() => {
    if (!joined || !roomId || !username) return;

    const socket = client.connect();

    // The resync controller is scoped to this connection: it owns the
    // high-water mark and the apply/ignore/resync decision. Created here (not
    // during render) so its callbacks may read the latest room from the refs.
    const resync = new ResyncController({
      onApply: (stroke) => engine.commitRemote(stroke),
      onResync: (sinceSeq) => client.requestResync(roomIdRef.current, sinceSeq),
    });
    resync.reset();

    // ── Connection lifecycle (Tier A) ──
    const offConnect = client.on("connect" as never, (() => {
      setConnected(true);
      // (Re)join and replay anything missed since the last applied seq.
      client.joinRoom(roomIdRef.current, usernameRef.current, resync.sinceSeq);
    }) as never);

    const offDisconnect = client.on("disconnect" as never, (() => {
      setConnected(false);
    }) as never);

    // ── Identity + presence (Tier A) ──
    const offColor = client.on("your-color", (color) => setMyColor(color));
    const offUsers = client.on("users-update", (users) => {
      setUsers(users);
      engine.setCursorUsers(users, mySocketColor(users, socket.id));
    });

    // ── History / resync batch (bulk → one full repaint) ──
    const offHistory = client.on("room-history", (history) => {
      engine.loadHistory(history.strokes);
      resync.adoptBatch(history.strokes);
    });

    // ── Live strokes (Tier B; ordered via the resync controller) ──
    const offDraw = client.on("draw", (stroke) => resync.ingest(stroke));

    // ── Remote cursors (Tier B; direct overlay mutation, no React) ──
    const offCursor = client.on("cursor-update", (data) => {
      engine.setCursorPosition(data.socketId, data.x, data.y);
    });

    // ── Board clear ──
    const offClear = client.on("clear", () => engine.clearBoard());

    // ── Recoverable errors → toast (Tier A) ──
    const offError = client.on("error", (err: SocketError) => {
      toast({ message: err.message || err.code, variant: "error" });
    });

    return () => {
      offConnect();
      offDisconnect();
      offColor();
      offUsers();
      offHistory();
      offDraw();
      offCursor();
      offClear();
      offError();
      client.disconnect();
      setConnected(false);
    };
  }, [client, engine, joined, roomId, username, toast]);

  // ── Local pointer input → engine + outbound emits ──
  useEffect(() => {
    const canvas = engine.getCanvas();
    if (!canvas || !joined) return;

    const emitCursor = throttle(
      (x: number, y: number) => client.cursorMove(roomIdRef.current, x, y),
      CURSOR_EMIT_MS,
    );

    const sampler = new PointerSampler(canvas, engine, {
      getBrush: () => resolveBrush(uiStore.get()),
      onSegment: (segment) => client.draw(roomIdRef.current, segment),
      onCursor: emitCursor,
    });
    sampler.attach();

    return () => {
      sampler.detach();
      emitCursor.cancel();
    };
  }, [engine, client, joined]);

  return client;
}

/** The current user's cursor color, matched by socket id, for self-filtering. */
function mySocketColor(
  users: { socketId: string; cursorColor: string }[],
  socketId: string | undefined,
): string {
  return users.find((u) => u.socketId === socketId)?.cursorColor ?? "";
}
