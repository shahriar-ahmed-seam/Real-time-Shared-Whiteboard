import { describe, it, expect } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";

import { createApp, JOIN_ERROR_CODES, type JoinTokenConfig } from "../../src/app";
import {
  verifyJoinToken,
  signJoinToken,
  type JoinTokenClaims,
  type SignJoinTokenOptions,
} from "../../src/middleware/authGuard";

// Unit tests for the join-token endpoint POST /api/rooms/:id/join.
//
// Validates: Requirement 2.7 — WHERE a board is configured with a password,
// issue a Join_Token only when the supplied password matches the stored hash;
// on mismatch deny with an incorrect-password error indication. Unprotected
// boards issue a token without a password. The endpoint is rate-limited.

const ORIGINS = ["http://localhost:5173"];
const SECRET = "test-secret-value-at-least-32-chars-long";
const ROOM_ID = "room-abc123";

/** Minimal in-memory BoardRepository stub: maps roomId → stored hash (or null). */
function makeBoardRepo(hashes: Record<string, string | null> = {}) {
  const ensured: string[] = [];
  return {
    ensured,
    async getPasswordHash(boardId: string): Promise<string | null> {
      return hashes[boardId] ?? null;
    },
    async ensure(boardId: string): Promise<void> {
      ensured.push(boardId);
    },
  };
}

/** Build an app wired with the join endpoint using the real token signer. */
function makeApp(overrides: Partial<JoinTokenConfig> = {}) {
  const boardRepository = overrides.boardRepository ?? makeBoardRepo();
  const config: JoinTokenConfig = {
    boardRepository,
    signToken: (claims: JoinTokenClaims, options?: SignJoinTokenOptions) =>
      signJoinToken(claims, SECRET, options),
    ...overrides,
  };
  return { app: createApp(ORIGINS, { joinTokenConfig: config }), boardRepository };
}

// ─── Unprotected board ───────────────────────────────────────────────

describe("POST /api/rooms/:id/join — unprotected board", () => {
  it("issues a room-scoped token without a password", async () => {
    const { app } = makeApp({ boardRepository: makeBoardRepo({ [ROOM_ID]: null }) });

    const res = await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.roomId).toBe(ROOM_ID);
    // The issued token verifies as signature-valid and scoped to the room.
    const verified = verifyJoinToken(res.body.token, ROOM_ID, {
      secret: SECRET,
      openMode: false,
    });
    expect(verified.ok).toBe(true);
  });

  it("issues a token even with no request body at all", async () => {
    const { app } = makeApp({ boardRepository: makeBoardRepo({ [ROOM_ID]: null }) });
    const res = await request(app).post(`/api/rooms/${ROOM_ID}/join`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });

  it("ensures the board row exists before issuing", async () => {
    const repo = makeBoardRepo({ [ROOM_ID]: null });
    const { app } = makeApp({ boardRepository: repo });
    await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({}).expect(200);
    expect(repo.ensured).toContain(ROOM_ID);
  });
});

// ─── Protected board ─────────────────────────────────────────────────

describe("POST /api/rooms/:id/join — protected board", () => {
  it("issues a token when the supplied password matches the stored hash", async () => {
    const hash = await bcrypt.hash("correct horse", 8);
    const { app } = makeApp({ boardRepository: makeBoardRepo({ [ROOM_ID]: hash }) });

    const res = await request(app)
      .post(`/api/rooms/${ROOM_ID}/join`)
      .send({ password: "correct horse" });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });

  it("denies with INCORRECT_PASSWORD when the password is wrong", async () => {
    const hash = await bcrypt.hash("correct horse", 8);
    const { app } = makeApp({ boardRepository: makeBoardRepo({ [ROOM_ID]: hash }) });

    const res = await request(app)
      .post(`/api/rooms/${ROOM_ID}/join`)
      .send({ password: "wrong" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(JOIN_ERROR_CODES.INCORRECT_PASSWORD);
    expect(res.body.token).toBeUndefined();
  });

  it("denies with INCORRECT_PASSWORD when no password is supplied", async () => {
    const hash = await bcrypt.hash("correct horse", 8);
    const repo = makeBoardRepo({ [ROOM_ID]: hash });
    const { app } = makeApp({ boardRepository: repo });

    const res = await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(JOIN_ERROR_CODES.INCORRECT_PASSWORD);
    // A denied request never creates / touches the board.
    expect(repo.ensured).not.toContain(ROOM_ID);
  });
});

// ─── Validation ──────────────────────────────────────────────────────

describe("POST /api/rooms/:id/join — input validation", () => {
  it("rejects a malformed room id with INVALID_ROOM_ID", async () => {
    const { app } = makeApp();
    const res = await request(app).post(`/api/rooms/!!/join`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(JOIN_ERROR_CODES.INVALID_ROOM_ID);
  });

  it("rejects a non-string password with INVALID_BODY", async () => {
    const { app } = makeApp({ boardRepository: makeBoardRepo({ [ROOM_ID]: null }) });
    const res = await request(app)
      .post(`/api/rooms/${ROOM_ID}/join`)
      .send({ password: 1234 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(JOIN_ERROR_CODES.INVALID_BODY);
  });
});

// ─── Rate limiting ───────────────────────────────────────────────────

describe("POST /api/rooms/:id/join — rate limiting", () => {
  it("returns 429 once the per-client bucket is exhausted", async () => {
    // Capacity 2, no refill within the test window, so the 3rd request is dropped.
    const { app } = makeApp({
      boardRepository: makeBoardRepo({ [ROOM_ID]: null }),
      rateLimit: { bucket: { capacity: 2, refillPerSec: 0.0001 } },
    });

    const a = await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({});
    const b = await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({});
    const c = await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({});

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
    expect(c.body.code).toBe("RATE_LIMITED");
  });
});

// ─── Route mounting ──────────────────────────────────────────────────

describe("join route mounting", () => {
  it("is not mounted when joinTokenConfig is omitted (health-only app)", async () => {
    const app = createApp(ORIGINS);
    const res = await request(app).post(`/api/rooms/${ROOM_ID}/join`).send({});
    expect(res.status).toBe(404);
  });
});
