import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { DrawStroke } from "./useDraw";
import { decideStrokeAction, highestSeq } from "../lib/strokeSync";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

/**
 * A stroke as broadcast by the server. The server stamps every persisted
 * stroke with a monotonic, gap-free per-board `seq` (Sequence_Number). Older
 * (unsequenced) servers omit `seq`; those strokes are applied directly for
 * backward compatibility.
 */
type IncomingStroke = DrawStroke & { seq?: number };

export interface RemoteUser {
  socketId: string;
  username: string;
  cursorColor: string;
  cursor: { x: number; y: number } | null;
}

interface UseSocketOptions {
  roomId: string;
  username: string;
  onRemoteDraw: (stroke: DrawStroke) => void;
  onRoomHistory: (strokes: DrawStroke[]) => void;
  onClear: () => void;
}

export function useSocket({
  roomId,
  username,
  onRemoteDraw,
  onRoomHistory,
  onClear,
}: UseSocketOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [users, setUsers] = useState<RemoteUser[]>([]);
  const [myColor, setMyColor] = useState<string>("#ffffff");
  const [remoteCursors, setRemoteCursors] = useState<
    Map<string, { x: number; y: number }>
  >(new Map());

  // Live socket connection status. Starts false (not yet connected) and tracks
  // the socket's connect/disconnect lifecycle so the UI can surface a
  // non-blocking "Reconnecting…" indicator while the link is down (Req 4.3)
  // and remove it once the connection is re-established (Req 4.7).
  const [connected, setConnected] = useState(false);

  // Highest stroke Sequence_Number this client has applied to the canvas.
  // Drives gap detection: in-order strokes advance it, gaps trigger a resync.
  const lastAppliedSeqRef = useRef(0);

  useEffect(() => {
    // Don't connect until we have a real roomId and username
    if (!roomId || !username) return;

    const socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      // Connection (re)established: clear any "Reconnecting…" indicator (Req 4.7).
      setConnected(true);
      // Re-join and ask the server to replay anything we missed since our last
      // applied seq (0 on a fresh load). The server decides between a full
      // baseline+tail reload and an ordered delta.
      socket.emit("join-room", {
        roomId,
        username,
        sinceSeq: lastAppliedSeqRef.current,
      });
    });

    socket.on("disconnect", () => {
      // Connection lost: surface the non-blocking reconnection indicator (Req 4.3).
      // socket.io-client retries automatically; a later "connect" clears this.
      setConnected(false);
    });

    socket.on("your-color", (color: string) => {
      setMyColor(color);
    });

    socket.on("room-history", (strokes: IncomingStroke[]) => {
      onRoomHistory(strokes);
      // History arrives in ascending seq order; trust it as our new baseline.
      lastAppliedSeqRef.current = highestSeq(strokes, lastAppliedSeqRef.current);
    });

    socket.on("draw", (stroke: IncomingStroke) => {
      // Backward-compat: unsequenced strokes from a legacy server apply directly.
      if (typeof stroke.seq !== "number") {
        onRemoteDraw(stroke);
        return;
      }

      const action = decideStrokeAction(lastAppliedSeqRef.current, stroke.seq);
      if (action === "apply") {
        onRemoteDraw(stroke);
        lastAppliedSeqRef.current = stroke.seq;
      } else if (action === "resync") {
        // Gap detected: a stroke between our last applied seq and this one is
        // missing. Ask the server to resync rather than applying out of order.
        socket.emit("request-resync", {
          roomId,
          sinceSeq: lastAppliedSeqRef.current,
        });
      }
      // action === "ignore": duplicate / already-applied stroke — discard.
    });

    socket.on("clear", () => {
      onClear();
    });

    socket.on("users-update", (userList: RemoteUser[]) => {
      setUsers(userList);
    });

    socket.on(
      "cursor-update",
      (data: { socketId: string; x: number; y: number }) => {
        setRemoteCursors((prev) => {
          const next = new Map(prev);
          next.set(data.socketId, { x: data.x, y: data.y });
          return next;
        });
      }
    );

    return () => {
      socket.disconnect();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, username]);

  const emitDraw = useCallback((stroke: DrawStroke) => {
    socketRef.current?.emit("draw", { roomId, stroke });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const emitClear = useCallback(() => {
    socketRef.current?.emit("clear", roomId);
  }, [roomId]);

  const emitCursor = useCallback(
    (x: number, y: number) => {
      socketRef.current?.volatile.emit("cursor-move", { roomId, x, y });
    },
    [roomId]
  );

  return { emitDraw, emitClear, emitCursor, users, myColor, remoteCursors, connected };
}
