import type { Server } from "socket.io";
import type { RoomRepository } from "../repositories/roomRepository";
import type { Logger } from "../observability/logger";

// ─── Room service ────────────────────────────────────────────────────
// Room lifecycle behavior lifted verbatim from the prototype: broadcasting
// the presence list and scheduling cleanup of empty rooms after a TTL.

export class RoomService {
  constructor(
    private readonly io: Server,
    private readonly rooms: RoomRepository,
    private readonly roomTtlMs: number,
    private readonly logger: Logger
  ) {}

  /** Broadcast the current user list to everyone in the room. */
  broadcastUsers(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const userList = Array.from(room.users.values()).map(
      ({ socketId, username, cursorColor, cursor }) => ({
        socketId,
        username,
        cursorColor,
        cursor,
      })
    );
    this.io.to(roomId).emit("users-update", userList);
  }

  /** Schedule removal of a room once it has been empty for the TTL. */
  scheduleCleanup(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);

    room.cleanupTimer = setTimeout(() => {
      const clients = this.io.sockets.adapter.rooms.get(roomId);
      if (!clients || clients.size === 0) {
        this.rooms.delete(roomId);
        this.logger.info(`Room "${roomId}" cleaned up (empty for 1 hour)`);
      }
    }, this.roomTtlMs);
  }
}
