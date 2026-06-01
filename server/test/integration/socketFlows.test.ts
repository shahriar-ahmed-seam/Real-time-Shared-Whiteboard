import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";

import {
  startTestServer,
  connectClient,
  once,
  collect,
  waitUntil,
  joinRoom,
  makeStroke,
  type TestServer,
} from "./helpers";
import type { PersistedStroke } from "../../src/types/domain";

// ─── Integration tests for socket flows (task 6.7) ───────────────────
//
// _Requirements: 9.3_ — integration tests covering join-and-history, draw
// broadcast, clear propagation, reconnection resync, and rate limiting.
//
// These exercise the REAL production gateway + handlers + StrokeService +
// PresenceService end-to-end over two `socket.io-client` connections. The
// datastores are ephemeral (in-memory stroke/board repositories + ioredis-mock
// for presence) so NO real Postgres/Redis is required. The gateway runs in
// OPEN_MODE so no signed Join_Token is needed, while still running the full
// auth/dispatch/rate-limit/validation path.

let server: TestServer;
const clients: ClientSocket[] = [];

/** Track a client for automatic teardown. */
function track(socket: ClientSocket): ClientSocket {
  clients.push(socket);
  return socket;
}

/** Unique room id per test (valid against the room-id schema, 6–32 chars). */
let roomCounter = 0;
const nextRoomId = (): string => `room-itg-${roomCounter++}`;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  // Disconnect every client first so the server sees clean disconnects, then
  // tear down the io server + HTTP listener to avoid open handles.
  for (const socket of clients) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  clients.length = 0;
  await server.close();
});

// ─── (1) join → history ──────────────────────────────────────────────

describe("join → history", () => {
  it("serves a late joiner the prior strokes in ascending seq order", async () => {
    const roomId = nextRoomId();

    const drawer = track(await connectClient(server.url));
    await joinRoom(drawer, roomId, "drawer");

    // Draw three strokes from the first client.
    const count = 3;
    for (let i = 0; i < count; i++) {
      drawer.emit("draw", { roomId, stroke: makeStroke(i) });
    }

    // Wait until the server has durably accepted all three (buffer/merge path).
    await waitUntil(async () => {
      const { strokes } = await server.strokeService.loadForJoin(roomId);
      return strokes.length === count;
    });

    // A late joiner receives the full prior history on join.
    const joiner = track(await connectClient(server.url));
    const history = await joinRoom(joiner, roomId, "latecomer");

    expect(history.strokes).toHaveLength(count);
    const seqs = history.strokes.map((s) => s.seq);
    // Strictly ascending and gap-free from the first stroke.
    expect(seqs).toEqual([1, 2, 3]);
  });
});

// ─── (2) draw broadcast ordering ──────────────────────────────────────

describe("draw broadcast ordering", () => {
  it("delivers strokes to the other client in ascending seq order", async () => {
    const roomId = nextRoomId();

    const a = track(await connectClient(server.url));
    const b = track(await connectClient(server.url));
    await joinRoom(a, roomId, "alice");
    await joinRoom(b, roomId, "bob");

    const received = collect<PersistedStroke>(b, "draw");

    const count = 8;
    for (let i = 0; i < count; i++) {
      a.emit("draw", { roomId, stroke: makeStroke(i * 10) });
    }

    await received.waitFor(count);

    expect(received.items).toHaveLength(count);
    const seqs = received.items.map((s) => s.seq);
    // Each broadcast stroke's seq is strictly greater than the previous one.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

// ─── (3) clear propagation ────────────────────────────────────────────

describe("clear propagation", () => {
  it("broadcasts a clear from one client to the other room member", async () => {
    const roomId = nextRoomId();

    const a = track(await connectClient(server.url));
    const b = track(await connectClient(server.url));
    await joinRoom(a, roomId, "alice");
    await joinRoom(b, roomId, "bob");

    const cleared = once(b, "clear");
    a.emit("clear", { roomId });

    // Resolves only if b received the clear broadcast.
    await expect(cleared).resolves.toBeUndefined();
  });
});

// ─── (4) reconnection resync delta ────────────────────────────────────

describe("reconnection resync delta", () => {
  it("returns only strokes newer than the reported sinceSeq", async () => {
    const roomId = nextRoomId();

    const client = track(await connectClient(server.url));
    await joinRoom(client, roomId, "resyncer");

    const count = 3;
    for (let i = 0; i < count; i++) {
      client.emit("draw", { roomId, stroke: makeStroke(i) });
    }
    await waitUntil(async () => {
      const { strokes } = await server.strokeService.loadForJoin(roomId);
      return strokes.length === count; // seqs 1, 2, 3
    });

    // Request a resync from seq 2 → server replays only the strokes after it.
    const resynced = once<{ snapshot?: unknown; strokes: PersistedStroke[] }>(
      client,
      "room-history"
    );
    client.emit("request-resync", { roomId, sinceSeq: 2 });
    const delta = await resynced;

    expect(delta.strokes.map((s) => s.seq)).toEqual([3]);
    // At/above the baseline the delta carries no snapshot — just the tail.
    expect(delta.snapshot).toBeUndefined();
  });

  it("reloads from baseline when the reported seq exceeds the server's highest", async () => {
    const roomId = nextRoomId();

    const client = track(await connectClient(server.url));
    await joinRoom(client, roomId, "resyncer");

    const count = 2;
    for (let i = 0; i < count; i++) {
      client.emit("draw", { roomId, stroke: makeStroke(i) });
    }
    await waitUntil(async () => {
      const { strokes } = await server.strokeService.loadForJoin(roomId);
      return strokes.length === count; // seqs 1, 2
    });

    // A reported seq above the server's highest (2) is discarded → full reload.
    const resynced = once<{ snapshot?: unknown; strokes: PersistedStroke[] }>(
      client,
      "room-history"
    );
    client.emit("request-resync", { roomId, sinceSeq: 99 });
    const reload = await resynced;

    expect(reload.strokes.map((s) => s.seq)).toEqual([1, 2]);
  });
});

// ─── (5) rate-limit flood dropping ────────────────────────────────────

describe("rate-limit flood dropping", () => {
  it("drops draws beyond the bucket and emits a rate-limited error", async () => {
    const roomId = nextRoomId();

    const a = track(await connectClient(server.url));
    const b = track(await connectClient(server.url));
    await joinRoom(a, roomId, "flooder");
    await joinRoom(b, roomId, "observer");

    const broadcasts = collect<PersistedStroke>(b, "draw");
    const errors = collect<{ code: string; message: string }>(a, "error");

    // The draw bucket holds 120 tokens (refill 120/s). Flooding well past it in
    // one burst must drop the excess and notify the sender.
    const flood = 200;
    for (let i = 0; i < flood; i++) {
      a.emit("draw", { roomId, stroke: makeStroke(i) });
    }

    // Wait until the sender is told it is being rate-limited.
    await waitUntil(() => errors.items.some((e) => e.code === "RATE_LIMITED"));
    // Let any in-flight allowed broadcasts settle.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(errors.items.some((e) => e.code === "RATE_LIMITED")).toBe(true);
    // The observer saw the allowed strokes only — strictly fewer than flooded.
    expect(broadcasts.items.length).toBeLessThan(flood);
    expect(broadcasts.items.length).toBeGreaterThanOrEqual(100);
    // The connection stays open after rate limiting.
    expect(a.connected).toBe(true);
  });
});
