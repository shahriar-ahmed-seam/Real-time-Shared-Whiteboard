import { randomUUID } from "crypto";

import express, { type Express } from "express";
import cors from "cors";
import bcrypt from "bcryptjs";

import { isSecureRequest } from "./socket/transport";
import {
  evaluateReadiness,
  DEFAULT_READINESS_TIMEOUT_MS,
  type ReadinessCheck,
} from "./observability/health";
import {
  DEFAULT_JOIN_TOKEN_TTL_SECONDS,
  type JoinTokenClaims,
  type SignJoinTokenOptions,
} from "./middleware/authGuard";
import {
  createHttpRateLimiter,
  type HttpRateLimiterOptions,
} from "./middleware/httpRateLimiter";
import {
  isMetricsAccessAllowed,
  type MetricsConfig,
} from "./observability/metrics";
import type { BoardRepository } from "./repositories/boardRepository";

// ─── Express app ─────────────────────────────────────────────────────
// Builds the HTTP app (CORS + health/readiness routes), exported separately
// from the composition root so it can be exercised in tests. Accepts the
// validated allowlist of client origins from the Config_Loader.
//
// Transport security (Requirements 2.5, 2.8):
//   • CORS is restricted to the validated origin allowlist so only those
//     origins receive an `Access-Control-Allow-Origin` grant.
//   • When `requireSecureTransport` is set (NODE_ENV=production), plaintext
//     HTTP requests are rejected so the API is reachable only over HTTPS.
//
// Health probes (Requirements 6.3, 6.4, 6.5):
//   • `/healthz` (liveness) always answers success quickly, independently of
//     datastore reachability.
//   • `/readyz` (readiness) probes the Persistence_Store and Coordination_Store
//     within a bounded budget and reports which dependency failed when not
//     ready. The dependency probes are injected via `readinessChecks` so this
//     module stays decoupled from the concrete pg/Redis handles; when none are
//     provided readiness is vacuously ready.
//
// Join-token issuance (Requirement 2.7):
//   • `POST /api/rooms/:id/join` validates an optional room password against the
//     board's stored bcrypt hash and issues a short-lived, room-scoped
//     Join_Token on success. A protected board with a wrong/absent password is
//     denied with an incorrect-password error indication. The endpoint is
//     rate-limited per client. The board password lookup and the token signer
//     are injected via `joinTokenConfig` so this module stays decoupled from
//     the concrete repository / signing wiring; when not provided the route is
//     not registered so existing callers/tests keep working unchanged.

/** Stable error codes returned by the join-token endpoint. */
export const JOIN_ERROR_CODES = {
  /** The `:id` path segment is not a well-formed room id. */
  INVALID_ROOM_ID: "INVALID_ROOM_ID",
  /** The request body is not a JSON object / the password is the wrong type. */
  INVALID_BODY: "INVALID_BODY",
  /** The board is password-protected and the supplied password did not match. */
  INCORRECT_PASSWORD: "INCORRECT_PASSWORD",
} as const;

/** Room id shape accepted by the join endpoint (nanoid alphabet, 6–32 chars). */
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * Dependencies the join-token endpoint needs. Supplied from the composition
 * root; when omitted (e.g. health-only unit tests) the route is not mounted.
 */
export interface JoinTokenConfig {
  /**
   * Board metadata access — only {@link BoardRepository.getPasswordHash} and
   * {@link BoardRepository.ensure} are used by the endpoint. Typed as a narrow
   * subset so tests can supply a minimal stub.
   */
  boardRepository: Pick<BoardRepository, "getPasswordHash" | "ensure">;
  /**
   * Sign a room-scoped Join_Token. Typically the Auth_Guard's `sign` method
   * (which closes over `JWT_SECRET`) so this module never handles the secret.
   */
  signToken: (claims: JoinTokenClaims, options?: SignJoinTokenOptions) => string;
  /** Token lifetime in seconds. Defaults to {@link DEFAULT_JOIN_TOKEN_TTL_SECONDS}. */
  tokenTtlSeconds?: number;
  /**
   * Generate the stable per-join `userId` baked into the token. Defaults to a
   * random UUID so each join gets a distinct identity. Injectable for tests.
   */
  generateUserId?: () => string;
  /** Rate-limiter options for the endpoint. Defaults to the join bucket. */
  rateLimit?: HttpRateLimiterOptions;
}

export interface AppOptions {
  /** Reject non-encrypted (plain HTTP) requests — enabled in production. */
  requireSecureTransport?: boolean;
  /**
   * Connectivity checks the readiness probe (`/readyz`) runs. Typically the
   * Persistence_Store (PostgreSQL) and Coordination_Store (Redis) checks wired
   * from the composition root. Defaults to an empty list (readiness reports
   * ready) so callers that don't wire datastores — such as unit tests — keep
   * working.
   */
  readinessChecks?: ReadinessCheck[];
  /**
   * Time budget for the readiness connectivity checks (ms). Defaults to 5000ms
   * per Requirements 6.4/6.5.
   */
  readinessTimeoutMs?: number;
  /**
   * Dependencies for the `POST /api/rooms/:id/join` endpoint (Requirement 2.7).
   * When provided, the route is mounted; when omitted it is not, so callers
   * that don't issue tokens — such as health-only unit tests — keep working.
   */
  joinTokenConfig?: JoinTokenConfig;
  /**
   * Telemetry handle + access policy for the `GET /metrics` endpoint
   * (Requirements 6.2, 6.6, 6.7). When provided, the route is mounted and
   * serializes the prom-client registry — but only for callers on an internal
   * network address or presenting valid credentials; all others are denied with
   * no metrics data. When omitted the route is not mounted so existing
   * callers/tests keep working unchanged.
   */
  metricsConfig?: MetricsConfig;
}

export function createApp(
  clientOrigins: string | string[],
  options: AppOptions = {}
): Express {
  const app = express();

  // Trust the proxy so `X-Forwarded-Proto` from a TLS-terminating load
  // balancer is honored when determining whether a request was encrypted.
  app.set("trust proxy", true);

  // Enforce encrypted transport in production before anything else runs.
  if (options.requireSecureTransport) {
    app.use((req, res, next) => {
      if (!isSecureRequest(req)) {
        res.status(403).json({
          code: "INSECURE_TRANSPORT",
          message: "HTTPS is required",
        });
        return;
      }
      next();
    });
  }

  // CORS restricted to the validated origin allowlist (Requirement 2.5).
  app.use(cors({ origin: clientOrigins }));

  // Health check
  app.get("/", (_req, res) => {
    res.json({ status: "Synapse server running" });
  });

  // ─── Liveness probe (Requirement 6.3) ──────────────────────────────
  // Answers success immediately and unconditionally — it reflects only that
  // the process is up and the event loop is responsive, never whether the
  // datastores are reachable. An orchestrator uses this to decide whether to
  // restart the process, so it must not depend on (or wait on) external
  // dependencies. There is no I/O here, so it resolves well within 1 second.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "alive" });
  });

  // ─── Readiness probe (Requirements 6.4, 6.5) ───────────────────────
  // Reports ready only when every configured dependency connectivity check
  // (Persistence_Store + Coordination_Store) succeeds within the time budget.
  // On failure or timeout it responds 503 and names the dependency that failed
  // so operators (and orchestrators) can see which backend is unreachable.
  const readinessChecks = options.readinessChecks ?? [];
  const readinessTimeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  app.get("/readyz", async (_req, res) => {
    const result = await evaluateReadiness(readinessChecks, readinessTimeoutMs);
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks,
    });
  });

  // ─── Join-token endpoint (Requirement 2.7) ─────────────────────────
  // Issues a short-lived, room-scoped Join_Token, gated by the board's optional
  // password. Mounted only when the issuing dependencies are wired (see
  // AppOptions.joinTokenConfig) so health-only callers are unaffected.
  if (options.joinTokenConfig) {
    registerJoinRoute(app, options.joinTokenConfig);
  }

  // ─── Metrics endpoint (Requirements 6.2, 6.6, 6.7) ─────────────────
  // Exposes the prom-client registry at `GET /metrics`, gated by an access
  // guard that admits only internal/private addresses or authenticated callers
  // and denies everyone else with no metrics data. Mounted only when a Metrics
  // handle is wired so health-only callers are unaffected.
  if (options.metricsConfig) {
    registerMetricsRoute(app, options.metricsConfig);
  }

  return app;
}

// ─── Join-token route ────────────────────────────────────────────────

/**
 * Mount `POST /api/rooms/:id/join`.
 *
 * Flow (Requirement 2.7):
 *   1. Rate-limit the caller (token bucket per client IP).
 *   2. Validate the `:id` path segment against the room-id pattern.
 *   3. Parse the optional `password` from the JSON body (a body is optional;
 *      `password` must be a string when present).
 *   4. Look up the board's stored password hash. When the board is protected,
 *      compare the supplied password against the hash with bcrypt; on a missing
 *      or mismatched password respond 403 with an INCORRECT_PASSWORD code and
 *      issue no token. When the board is unprotected, skip the password check.
 *   5. Ensure the board row exists and issue a signed, room-scoped Join_Token.
 *
 * The handler is defensive: the password comparison and lookups are wrapped so
 * an unexpected error becomes a 500 rather than crashing the process.
 */
function registerJoinRoute(app: Express, config: JoinTokenConfig): void {
  const {
    boardRepository,
    signToken,
    tokenTtlSeconds = DEFAULT_JOIN_TOKEN_TTL_SECONDS,
    generateUserId = randomUUID,
    rateLimit,
  } = config;

  const limiter = createHttpRateLimiter(rateLimit);
  // `express.json()` is scoped to this route so the rest of the app (and the
  // Socket.IO transport) is unaffected. A small body cap blunts oversized
  // request bodies; tolerate a missing/empty body (no password).
  const parseJson = express.json({ limit: "4kb" });

  app.post(
    "/api/rooms/:id/join",
    limiter,
    parseJson,
    async (req, res): Promise<void> => {
      const rawRoomId = req.params.id;
      const roomId = Array.isArray(rawRoomId) ? rawRoomId[0] : rawRoomId;

      // 2. Validate the room id shape before any datastore access.
      if (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId)) {
        res.status(400).json({
          code: JOIN_ERROR_CODES.INVALID_ROOM_ID,
          message: "Room id must be 6–32 characters of [A-Za-z0-9_-]",
        });
        return;
      }

      // 3. Extract the optional password. A missing body is allowed; when a
      //    body is present `password` must be a string if provided.
      const body: unknown = req.body;
      let password: string | undefined;
      if (body !== undefined && body !== null) {
        if (typeof body !== "object" || Array.isArray(body)) {
          res.status(400).json({
            code: JOIN_ERROR_CODES.INVALID_BODY,
            message: "Request body must be a JSON object",
          });
          return;
        }
        const rawPassword = (body as Record<string, unknown>).password;
        if (rawPassword !== undefined && typeof rawPassword !== "string") {
          res.status(400).json({
            code: JOIN_ERROR_CODES.INVALID_BODY,
            message: "password must be a string",
          });
          return;
        }
        password = rawPassword;
      }

      try {
        // 4. Gate on the board's stored password hash.
        const passwordHash = await boardRepository.getPasswordHash(roomId);
        if (passwordHash) {
          const matches =
            typeof password === "string" &&
            (await bcrypt.compare(password, passwordHash));
          if (!matches) {
            res.status(403).json({
              code: JOIN_ERROR_CODES.INCORRECT_PASSWORD,
              message: "Incorrect room password",
            });
            return;
          }
        }

        // 5. Ensure the board exists and issue the room-scoped token.
        await boardRepository.ensure(roomId);
        const userId = generateUserId();
        const token = signToken(
          { roomId, userId },
          { expiresInSeconds: tokenTtlSeconds }
        );

        res.status(200).json({
          token,
          userId,
          roomId,
          expiresInSeconds: tokenTtlSeconds,
        });
      } catch {
        res.status(500).json({
          code: "INTERNAL_ERROR",
          message: "Failed to issue join token",
        });
      }
    }
  );
}

// ─── Metrics route ───────────────────────────────────────────────────

/**
 * Mount `GET /metrics`.
 *
 * Flow (Requirements 6.2, 6.6, 6.7):
 *   1. Evaluate the access guard against the request's *direct* peer address
 *      (`req.socket.remoteAddress`, never a client-supplied forwarded header)
 *      and Authorization header. A caller is admitted only when it originates
 *      from an internal/private address or presents valid credentials.
 *   2. On denial, respond 403 with no metrics data (an error code only).
 *   3. On success, serialize the prom-client registry and respond 200 with the
 *      Prometheus text exposition content type.
 *
 * Using the direct socket address (rather than a forwarded header) ensures a
 * remote caller cannot spoof an internal source via `X-Forwarded-For`.
 */
function registerMetricsRoute(app: Express, config: MetricsConfig): void {
  const { metrics, access, resolveClientIp } = config;
  // Default to the direct TCP peer — a client cannot spoof it via a header.
  const getClientIp =
    resolveClientIp ?? ((req: { socket: { remoteAddress?: string } }) => req.socket.remoteAddress);

  app.get("/metrics", async (req, res): Promise<void> => {
    const allowed = isMetricsAccessAllowed(
      {
        authorization: req.headers.authorization,
        remoteAddress: getClientIp(req),
      },
      access
    );

    if (!allowed) {
      // Deny with no metrics data (Requirement 6.7).
      res.status(403).json({
        code: "FORBIDDEN",
        message: "Metrics access is restricted",
      });
      return;
    }

    try {
      const body = await metrics.serialize();
      res.setHeader("Content-Type", metrics.contentType);
      res.status(200).send(body);
    } catch {
      res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Failed to collect metrics",
      });
    }
  });
}
