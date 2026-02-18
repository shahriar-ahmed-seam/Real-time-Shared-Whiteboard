import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { DrawStroke } from "./useDraw";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

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

  useEffect(() => {
    // Don't connect until we have a real roomId and username
    if (!roomId || !username) return;

    const socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-room", { roomId, username });
    });

    socket.on("your-color", (color: string) => {
      setMyColor(color);
    });

    socket.on("room-history", (strokes: DrawStroke[]) => {
      onRoomHistory(strokes);
    });

    socket.on("draw", (stroke: DrawStroke) => {
      onRemoteDraw(stroke);
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

  return { emitDraw, emitClear, emitCursor, users, myColor, remoteCursors };
}
