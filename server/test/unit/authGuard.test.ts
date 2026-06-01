import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

import {
  verifyJoinToken,
  signJoinToken,
  createAuthGuard,
  type AuthGuardConfig,
  type AuthResult,
} from "../../src/middleware/authGuard";

// Unit tests for the Auth_Guard / Join_Token verification.
//
// Validates: Requirements 2.1 (WHERE OPEN_MODE is disabled, process a
// room-scoped event only when the Join_Token's signature is valid, expiry has
// not passed, and scope matches the referenced room) and 2.10 (reject an
// absent / invalid-signature / expired / scope-mismatched token).
//
// The verifier must NEVER throw for ordinary auth failures: each failure mode
// surfaces as a machine-readable `code` on the discriminated-union result.
// OPEN_MODE bypasses verification entirely.

// ─── Fixtures ────────────────────────────────────────────────────────

// At least 32 chars to mirror the JWT_SECRET policy from the Config_Loader.
const SECRET = "test-secret-value-at-least-32-chars-long";
const ROOM_ID = "room-abc123";
const USER_ID = "user-7";

const closedConfig: AuthGuardConfig = { secret: SECRET, openMode: false };
const openConfig: AuthGuardConfig = { secret: SECRET, openMode: true };

/** Narrowing helper so failure-code assertions read cleanly. */
function expectFailure(result: AuthResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure result");
  return result;
}

// ─── MISSING_TOKEN (Requirement 2.10) ────────────────────────────────

describe("verifyJoinToken — missing token", () => {
  it("returns MISSING_TOKEN for null, undefined, and empty-string tokens", () => {
    for (const token of [null, undefined, ""]) {
      const result = verifyJoinToken(token, ROOM_ID, closedConfig);
      expect(expectFailure(result).code).toBe("MISSING_TOKEN");
    }
  });
});

// ─── INVALID_SIGNATURE (Requirement 2.10) ────────────────────────────

describe("verifyJoinToken — invalid signature", () => {
  it("returns INVALID_SIGNATURE when the token is signed with a different secret", () => {
    const token = signJoinToken(
      { roomId: ROOM_ID, userId: USER_ID },
      "a-totally-different-secret-also-32-chars!"
    );
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("INVALID_SIGNATURE");
  });

  it("returns INVALID_SIGNATURE when the signature segment is tampered with", () => {
    const token = signJoinToken({ roomId: ROOM_ID, userId: USER_ID }, SECRET);
    const [header, payload] = token.split(".");
    const tampered = `${header}.${payload}.deadbeefdeadbeefdeadbeef`;
    const result = verifyJoinToken(tampered, ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("INVALID_SIGNATURE");
  });
});

// ─── TOKEN_EXPIRED (Requirement 2.10) ────────────────────────────────

describe("verifyJoinToken — expired token", () => {
  it("returns TOKEN_EXPIRED for a token whose exp is in the past", () => {
    // A negative TTL puts `exp` before `iat`, so the token is already expired.
    const token = signJoinToken({ roomId: ROOM_ID, userId: USER_ID }, SECRET, {
      expiresInSeconds: -10,
    });
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("TOKEN_EXPIRED");
  });
});

// ─── TOKEN_NOT_ACTIVE (nbf in the future) ────────────────────────────

describe("verifyJoinToken — not-yet-active token", () => {
  it("returns TOKEN_NOT_ACTIVE when nbf is in the future", () => {
    const token = jwt.sign({ roomId: ROOM_ID, userId: USER_ID }, SECRET, {
      notBefore: 3600, // active only one hour from now
    });
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("TOKEN_NOT_ACTIVE");
  });
});

// ─── MALFORMED_TOKEN ─────────────────────────────────────────────────

describe("verifyJoinToken — malformed token", () => {
  it("returns MALFORMED_TOKEN for a non-JWT string", () => {
    const result = verifyJoinToken("not-a-jwt", ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("MALFORMED_TOKEN");
  });

  it("returns MALFORMED_TOKEN when claims fail their schema (missing userId)", () => {
    // Signature is valid, but the payload omits the required `userId` claim.
    const token = jwt.sign({ roomId: ROOM_ID }, SECRET, { expiresIn: 300 });
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("MALFORMED_TOKEN");
  });
});

// ─── ROOM_SCOPE_MISMATCH (Requirements 2.1, 2.10) ────────────────────

describe("verifyJoinToken — wrong room scope", () => {
  it("returns ROOM_SCOPE_MISMATCH when the token is scoped to another room", () => {
    const token = signJoinToken({ roomId: "room-other", userId: USER_ID }, SECRET);
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(expectFailure(result).code).toBe("ROOM_SCOPE_MISMATCH");
  });
});

// ─── Valid token (Requirement 2.1) ───────────────────────────────────

describe("verifyJoinToken — valid token", () => {
  it("succeeds and returns the userId for a signature-valid, unexpired, in-scope token", () => {
    const token = signJoinToken({ roomId: ROOM_ID, userId: USER_ID }, SECRET);
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.userId).toBe(USER_ID);
  });
});

// ─── OPEN_MODE bypass (Requirement 2.1: "or OPEN_MODE is set") ────────

describe("verifyJoinToken — OPEN_MODE bypass", () => {
  it("succeeds with an anonymous identity when no token is presented", () => {
    const result = verifyJoinToken(null, ROOM_ID, openConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.userId).toBe("anonymous");
  });

  it("reuses the decodable token's userId without verifying signature/scope", () => {
    // Token is signed with the WRONG secret and scoped to a DIFFERENT room —
    // both would fail in closed mode, but OPEN_MODE bypasses verification.
    const token = signJoinToken(
      { roomId: "some-other-room", userId: "open-user" },
      "an-unrelated-secret-that-is-also-32-chars"
    );
    const result = verifyJoinToken(token, ROOM_ID, openConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.userId).toBe("open-user");
  });

  it("falls back to anonymous when the supplied token is not decodable", () => {
    const result = verifyJoinToken("garbage", ROOM_ID, openConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.userId).toBe("anonymous");
  });
});

// ─── signJoinToken misconfiguration ──────────────────────────────────

describe("signJoinToken", () => {
  it("throws on an empty signing secret (a misconfiguration, not an auth failure)", () => {
    expect(() => signJoinToken({ roomId: ROOM_ID, userId: USER_ID }, "")).toThrow();
  });

  it("produces a token that round-trips through verification", () => {
    const token = signJoinToken({ roomId: ROOM_ID, userId: USER_ID }, SECRET);
    const result = verifyJoinToken(token, ROOM_ID, closedConfig);
    expect(result.ok).toBe(true);
  });
});

// ─── createAuthGuard factory ─────────────────────────────────────────

describe("createAuthGuard", () => {
  it("verify/sign close over the configured secret and OPEN_MODE flag", () => {
    const guard = createAuthGuard(closedConfig);
    const token = guard.sign({ roomId: ROOM_ID, userId: USER_ID });
    const result = guard.verify(token, ROOM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.userId).toBe(USER_ID);
  });

  it("verify rejects a scope mismatch through the factory-bound config", () => {
    const guard = createAuthGuard(closedConfig);
    const token = guard.sign({ roomId: "elsewhere", userId: USER_ID });
    const result = guard.verify(token, ROOM_ID);
    expect(expectFailure(result).code).toBe("ROOM_SCOPE_MISMATCH");
  });
});
