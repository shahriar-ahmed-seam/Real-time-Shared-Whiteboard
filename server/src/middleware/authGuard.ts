// ─── Auth_Guard and Join_Token verification ──────────────────────────
// Verifies the signed, short-lived, room-scoped Join_Token a client presents
// in the socket handshake before any room-scoped event is processed.
//
// The verifier NEVER throws for ordinary auth failures: an absent, malformed,
// tamper-with-signature, expired, or wrong-room token is expected control flow
// and is reported through a machine-readable failure `code` on a discriminated
// union result. Only a programmer error (e.g. an empty signing secret) throws.
//
// OPEN_MODE bypasses verification entirely for demo/development use.
//
// Requirements:
//   2.1  — WHERE OPEN_MODE is disabled, process a room-scoped event only when
//          the connection presents a Join_Token whose signature is valid, whose
//          expiry has not passed, and whose scope matches the referenced room.
//   2.10 — WHERE OPEN_MODE is disabled, reject events whose Join_Token is absent,
//          has an invalid signature, has expired, or has a scope mismatch.

import jwt from "jsonwebtoken";
import { z } from "zod";

// ─── Failure codes (machine-readable, stable) ────────────────────────

/**
 * Distinct, machine-readable reasons a Join_Token can fail verification. These
 * map onto the failure modes called out by Requirement 2.10 (absent, invalid
 * signature, expired, scope mismatch) plus structural malformations.
 */
export type AuthFailureCode =
  | "MISSING_TOKEN" // no token presented
  | "MALFORMED_TOKEN" // not a parseable JWT, or claims fail their schema
  | "INVALID_SIGNATURE" // signature does not match JWT_SECRET
  | "TOKEN_EXPIRED" // `exp` has passed
  | "TOKEN_NOT_ACTIVE" // `nbf` is in the future
  | "ROOM_SCOPE_MISMATCH"; // valid token, but scoped to a different room

/**
 * Result of an Auth_Guard verification. A discriminated union so callers branch
 * on `ok` and never have to handle exceptions for ordinary auth failures.
 */
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; code: AuthFailureCode };

// ─── Token claims ────────────────────────────────────────────────────

/**
 * The room-scoped claims carried by a Join_Token. `roomId` is the scope checked
 * against the referenced room; `userId` is the stable per-join identity the
 * guard returns on success. Standard `iat`/`exp` claims are added by signing.
 */
export interface JoinTokenClaims {
  /** Room this token authorizes — must match the referenced room. */
  roomId: string;
  /** Stable per-join user identity, distinct from the socket id. */
  userId: string;
}

/** Validates the decoded payload shape so a structurally odd token is rejected. */
const ClaimsSchema = z
  .object({
    roomId: z.string().min(1),
    userId: z.string().min(1),
  })
  .passthrough();

/** Default Join_Token lifetime — short-lived per the security model. */
export const DEFAULT_JOIN_TOKEN_TTL_SECONDS = 5 * 60;

// ─── Configuration ───────────────────────────────────────────────────

export interface AuthGuardConfig {
  /** Signing secret (`JWT_SECRET`). Must be non-empty. */
  secret: string;
  /** When true, verification is bypassed (demo/development). */
  openMode: boolean;
}

export interface SignJoinTokenOptions {
  /** Token lifetime in seconds. Defaults to {@link DEFAULT_JOIN_TOKEN_TTL_SECONDS}. */
  expiresInSeconds?: number;
}

// ─── Signing (used later by the join endpoint, task 2.10) ─────────────

/**
 * Sign a room-scoped Join_Token. Produces a JWT carrying `roomId` and `userId`
 * claims plus a short `exp`. This is the issuer seam the `POST /api/rooms/:id/join`
 * endpoint builds on.
 *
 * @throws Error if `secret` is empty — a misconfiguration, not an auth failure.
 */
export function signJoinToken(
  claims: JoinTokenClaims,
  secret: string,
  options: SignJoinTokenOptions = {}
): string {
  if (!secret) {
    throw new Error("Cannot sign Join_Token: signing secret is empty");
  }
  const expiresIn = options.expiresInSeconds ?? DEFAULT_JOIN_TOKEN_TTL_SECONDS;
  return jwt.sign({ roomId: claims.roomId, userId: claims.userId }, secret, {
    expiresIn,
  });
}

// ─── Verification (Auth_Guard core) ──────────────────────────────────

/**
 * Verify a Join_Token against a referenced room. Returns a discriminated union
 * and NEVER throws for ordinary auth failures (Requirement 2.1 / 2.10).
 *
 * Success requires (unless `openMode`): a parseable JWT, a signature valid under
 * `secret`, an unexpired token, and a `roomId` claim equal to `roomId`.
 *
 * In `openMode` the token is not enforced: a decodable token's `userId` is
 * honored, otherwise an `"anonymous"` identity is returned. No side effects.
 */
export function verifyJoinToken(
  token: string | null | undefined,
  roomId: string,
  config: AuthGuardConfig
): AuthResult {
  // OPEN_MODE bypass: never reject. Reuse the token's identity if it decodes,
  // otherwise fall back to an anonymous identity so demos need no token at all.
  if (config.openMode) {
    const decoded = decodeClaims(token);
    return { ok: true, userId: decoded?.userId ?? "anonymous" };
  }

  if (!token) {
    return { ok: false, code: "MISSING_TOKEN" };
  }

  let payload: unknown;
  try {
    payload = jwt.verify(token, config.secret);
  } catch (err) {
    return { ok: false, code: mapVerifyError(err) };
  }

  const parsed = ClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, code: "MALFORMED_TOKEN" };
  }

  if (parsed.data.roomId !== roomId) {
    return { ok: false, code: "ROOM_SCOPE_MISMATCH" };
  }

  return { ok: true, userId: parsed.data.userId };
}

// ─── Guard factory (wired by the gateway, task 6.1) ──────────────────

export interface AuthGuard {
  /** Verify a token for a referenced room. Never throws on auth failure. */
  verify(token: string | null | undefined, roomId: string): AuthResult;
  /** Sign a room-scoped Join_Token with the configured secret. */
  sign(claims: JoinTokenClaims, options?: SignJoinTokenOptions): string;
}

/**
 * Build an Auth_Guard bound to a signing secret and OPEN_MODE flag (sourced from
 * the validated env config). The returned guard closes over configuration so
 * handlers and the gateway call `verify`/`sign` without re-threading config.
 */
export function createAuthGuard(config: AuthGuardConfig): AuthGuard {
  return {
    verify: (token, roomId) => verifyJoinToken(token, roomId, config),
    sign: (claims, options) => signJoinToken(claims, config.secret, options),
  };
}

// ─── Internals ───────────────────────────────────────────────────────

/** Map a `jwt.verify` error onto a stable failure code. Never re-throws. */
function mapVerifyError(err: unknown): AuthFailureCode {
  if (err instanceof jwt.TokenExpiredError) {
    return "TOKEN_EXPIRED";
  }
  if (err instanceof jwt.NotBeforeError) {
    return "TOKEN_NOT_ACTIVE";
  }
  if (err instanceof jwt.JsonWebTokenError) {
    // `jsonwebtoken` reports signature tampering with this exact message;
    // every other JsonWebTokenError (malformed jwt, unexpected algorithm,
    // bad structure) is a structural problem.
    return err.message === "invalid signature"
      ? "INVALID_SIGNATURE"
      : "MALFORMED_TOKEN";
  }
  // Unknown error shape — treat conservatively as malformed rather than throw.
  return "MALFORMED_TOKEN";
}

/**
 * Best-effort decode WITHOUT signature verification, used only by the OPEN_MODE
 * bypass to reuse a supplied identity. Returns null for anything that is not a
 * JWT with valid claims. `jwt.decode` does not throw on malformed input.
 */
function decodeClaims(token: string | null | undefined): JoinTokenClaims | null {
  if (!token) return null;
  const decoded = jwt.decode(token);
  const parsed = ClaimsSchema.safeParse(decoded);
  return parsed.success
    ? { roomId: parsed.data.roomId, userId: parsed.data.userId }
    : null;
}
