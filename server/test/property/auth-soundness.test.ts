import { describe, it, expect } from "vitest";
import fc from "fast-check";
import jwt from "jsonwebtoken";

import {
  verifyJoinToken,
  signJoinToken,
  type AuthGuardConfig,
  type JoinTokenClaims,
} from "../../src/middleware/authGuard";

// ─── Property 8: Authorization soundness ─────────────────────────────
//
// **Validates: Requirements 2.1**
//
// An event is authorized only if its Join_Token is signature-valid and scoped
// to the referenced room, OR `OPEN_MODE` is set. This test exercises the
// Auth_Guard's `verifyJoinToken` across a diverse population of token/room
// combinations (validly signed tokens for various rooms, wrong-room tokens,
// wrong-secret tokens, expired tokens, signature-tampered tokens, structurally
// malformed-claim tokens, random strings, and absent tokens) and asserts:
//
//   • With OPEN_MODE off: `ok === true` IFF the token is signature-valid under
//     the configured secret, unexpired, carries well-formed claims, and its
//     `roomId` claim equals the referenced room (the soundness boundary).
//   • With OPEN_MODE on: the guard NEVER rejects, for any input whatsoever.

// Two distinct, ≥32-char secrets so "signed with the wrong key" is a real case.
const SECRET = "synapse-auth-soundness-secret-key-0123456789";
const OTHER_SECRET = "a-different-auth-soundness-secret-key-zyxwvut";

/**
 * Independent re-derivation of "signature-valid AND scoped to the referenced
 * room" straight from the requirement, using `jsonwebtoken` directly. This is
 * the oracle the guard is checked against — it does NOT call into the guard, so
 * a guard bug (skipping the room check, mishandling the secret, leaking
 * OPEN_MODE, etc.) shows up as a disagreement.
 */
function oracleAuthorized(
  token: string | null | undefined,
  referencedRoomId: string,
  secret: string
): { authorized: boolean; userId?: string } {
  if (!token) return { authorized: false };
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret); // checks signature AND expiry
  } catch {
    return { authorized: false };
  }
  if (typeof payload !== "object" || payload === null) {
    return { authorized: false };
  }
  const claims = payload as Record<string, unknown>;
  const roomId = claims.roomId;
  const userId = claims.userId;
  if (typeof roomId !== "string" || roomId.length < 1) {
    return { authorized: false };
  }
  if (typeof userId !== "string" || userId.length < 1) {
    return { authorized: false };
  }
  if (roomId !== referencedRoomId) {
    return { authorized: false };
  }
  return { authorized: true, userId };
}

/** Flip the last character of a JWT's signature segment to break the HMAC. */
function tamperSignature(token: string): string {
  const parts = token.split(".");
  const sig = parts[2] ?? "";
  if (sig.length === 0) return token + "x";
  const chars = sig.split("");
  const i = chars.length - 1;
  chars[i] = chars[i] === "A" ? "B" : "A";
  parts[2] = chars.join("");
  return parts.join(".");
}

// A shared room pool so a token's claimed room and the referenced room overlap
// often enough to generate both authorized and wrong-room cases.
const ROOM_POOL = ["room-a", "room-b", "room-c", "aaaaaa", "ZZ9-z_", "board42"];
const roomArb = fc.constantFrom(...ROOM_POOL);
const userIdArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.length >= 1);

const claimsArb: fc.Arbitrary<JoinTokenClaims> = fc.record({
  roomId: roomArb,
  userId: userIdArb,
});

/**
 * A token (or absent token) drawn from the full adversarial population. Each
 * branch returns the raw value a client might present in the handshake.
 */
const tokenArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  // Validly signed, unexpired token for some room in the pool.
  claimsArb.map((c) => signJoinToken(c, SECRET, { expiresInSeconds: 300 })),
  // Signed with the wrong secret → invalid signature.
  claimsArb.map((c) => signJoinToken(c, OTHER_SECRET, { expiresInSeconds: 300 })),
  // Validly signed but already expired.
  claimsArb.map((c) => signJoinToken(c, SECRET, { expiresInSeconds: -3600 })),
  // Validly signed then signature-tampered.
  claimsArb.map((c) => tamperSignature(signJoinToken(c, SECRET, { expiresInSeconds: 300 }))),
  // Signature-valid but structurally malformed claims (missing required fields).
  userIdArb.map((userId) => jwt.sign({ userId }, SECRET, { expiresIn: 300 })),
  roomArb.map((roomId) => jwt.sign({ roomId }, SECRET, { expiresIn: 300 })),
  // Arbitrary garbage strings.
  fc.string(),
  // Absent / empty tokens.
  fc.constantFrom<string | null | undefined>(null, undefined, "")
);

describe("Property 8: Authorization soundness (Requirement 2.1)", () => {
  it("with OPEN_MODE off, authorizes IFF the token is signature-valid and room-scoped", () => {
    const config: AuthGuardConfig = { secret: SECRET, openMode: false };

    fc.assert(
      fc.property(tokenArb, roomArb, (token, referencedRoomId) => {
        const result = verifyJoinToken(token, referencedRoomId, config);
        const oracle = oracleAuthorized(token, referencedRoomId, SECRET);

        // Soundness boundary: ok exactly when the oracle says authorized.
        expect(result.ok).toBe(oracle.authorized);

        if (result.ok) {
          // A granted identity must be the one the verified token actually carries.
          expect(result.userId).toBe(oracle.userId);
        } else {
          // Failures are reported as machine-readable codes, never thrown.
          expect(typeof result.code).toBe("string");
        }
      }),
      { numRuns: 200 }
    );
  });

  it("with OPEN_MODE on, never rejects any token/room combination", () => {
    const config: AuthGuardConfig = { secret: SECRET, openMode: true };

    fc.assert(
      fc.property(tokenArb, roomArb, (token, referencedRoomId) => {
        const result = verifyJoinToken(token, referencedRoomId, config);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(typeof result.userId).toBe("string");
          expect(result.userId.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 }
    );
  });
});
