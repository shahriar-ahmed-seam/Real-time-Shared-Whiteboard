import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";

// ─── Types ───────────────────────────────────────────────────────────
interface DrawStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
}

interface UserInfo {
  socketId: string;
  username: string;
  cursorColor: string;
  cursor: { x: number; y: number } | null;
}

interface RoomData {
  strokes: DrawStroke[];
  users: Map<string, UserInfo>;
  lastActivity: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Cursor Color Pool (visually distinct) ───────────────────────────
const CURSOR_COLORS = [
  "#f43f5e", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#06b6d4", "#ec4899", "#14b8a6", "#ef4444", "#6366f1",
  "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9", "#e879f9",
  "#facc15", "#2dd4bf", "#fb923c", "#818cf8", "#34d399",
];

function pickCursorColor(room: RoomData): string {
  const usedColors = new Set(
    Array.from(room.users.values()).map((u) => u.cursorColor)
  );
  for (const c of CURSOR_COLORS) {
    if (!usedColors.has(c)) return c;
  }
  // Fallback: random hex
  return `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
}

// ─── Server Setup ────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const PORT = parseInt(process.env.PORT || "3001", 10);
const ROOM_TTL = 60 * 60 * 1000; // 1 hour

app.use(cors({ origin: CLIENT_URL }));

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

// ─── Room History (in-memory) ────────────────────────────────────────
const rooms = new Map<string, RoomData>();

function getOrCreateRoom(roomId: string): RoomData {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      strokes: [],
      users: new Map(),
      lastActivity: Date.now(),
      cleanupTimer: null,
    });
  }
  return rooms.get(roomId)!;
}

function broadcastUsers(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  const userList = Array.from(room.users.values()).map(
    ({ socketId, username, cursorColor, cursor }) => ({
      socketId,
      username,
      cursorColor,
      cursor,
    })
  );
  io.to(roomId).emit("users-update", userList);
}

function scheduleCleanup(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);

  room.cleanupTimer = setTimeout(() => {
    const clients = io.sockets.adapter.rooms.get(roomId);
    if (!clients || clients.size === 0) {
      rooms.delete(roomId);
      console.log(`Room "${roomId}" cleaned up (empty for 1 hour)`);
    }
  }, ROOM_TTL);
}

// ─── Socket.IO Logic ─────────────────────────────────────────────────
io.on("connection", (socket: Socket) => {
  console.log(`Connected: ${socket.id}`);

  let currentRoomId: string | null = null;

  socket.on(
    "join-room",
    (data: { roomId: string; username: string }) => {
      const { roomId, username } = data;
      currentRoomId = roomId;
      socket.join(roomId);
      console.log(`${username} (${socket.id}) joined room "${roomId}"`);

      const room = getOrCreateRoom(roomId);
      room.lastActivity = Date.now();

      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      // Assign unique cursor color
      const cursorColor = pickCursorColor(room);
      room.users.set(socket.id, {
        socketId: socket.id,
        username,
        cursorColor,
        cursor: null,
      });

      // Send the assigned color back to this user
      socket.emit("your-color", cursorColor);

      // Send history to late joiner
      if (room.strokes.length > 0) {
        socket.emit("room-history", room.strokes);
      }

      // Broadcast updated user list
      broadcastUsers(roomId);
    }
  );

  socket.on("draw", (data: { roomId: string; stroke: DrawStroke }) => {
    const { roomId, stroke } = data;
    const room = getOrCreateRoom(roomId);
    room.strokes.push(stroke);
    room.lastActivity = Date.now();
    socket.to(roomId).emit("draw", stroke);
  });

  socket.on(
    "cursor-move",
    (data: { roomId: string; x: number; y: number }) => {
      const { roomId, x, y } = data;
      const room = rooms.get(roomId);
      if (!room) return;
      const user = room.users.get(socket.id);
      if (user) {
        user.cursor = { x, y };
      }
      // Broadcast cursor to others in the room
      socket.to(roomId).emit("cursor-update", {
        socketId: socket.id,
        x,
        y,
      });
    }
  );

  socket.on("clear", (roomId: string) => {
    const room = rooms.get(roomId);
    if (room) {
      room.strokes = [];
      room.lastActivity = Date.now();
    }
    socket.to(roomId).emit("clear");
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = rooms.get(roomId);
      if (room) {
        room.users.delete(socket.id);
        broadcastUsers(roomId);
        const clients = io.sockets.adapter.rooms.get(roomId);
        if (clients && clients.size <= 1) {
          scheduleCleanup(roomId);
        }
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
  });
});

// ─── Health Check ────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "Synapse server running" });
});

// ─── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\nSynapse server listening on http://localhost:${PORT}\n`);
});
