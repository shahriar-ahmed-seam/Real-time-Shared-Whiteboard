import type { RoomData } from "../types/domain";

// ─── Room repository (in-memory) ─────────────────────────────────────
// Holds the authoritative in-memory room state, exactly as the prototype
// did with its module-level `Map`. This is the seam where the durable
// PostgreSQL/Redis-backed repositories are introduced in a later task.

export class RoomRepository {
  private readonly rooms = new Map<string, RoomData>();

  /** Return the room, creating an empty one if it does not yet exist. */
  getOrCreate(roomId: string): RoomData {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        strokes: [],
        users: new Map(),
        lastActivity: Date.now(),
        cleanupTimer: null,
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Return the room if it exists, otherwise undefined. */
  get(roomId: string): RoomData | undefined {
    return this.rooms.get(roomId);
  }

  /** Remove a room from memory. */
  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
