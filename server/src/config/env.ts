// ─── Validated environment configuration (Config_Loader) ─────────────
// Loads and validates all environment-specific settings at startup using a
// zod schema. Invalid or missing configuration fails fast: one log entry is
// emitted per affected variable (name + reason) and the process exits with a
// non-zero status code BEFORE the server binds to its port.
//
// Requirements: 1.1 (read all env values before binding), 1.2 (validation
// rules), 1.3 (per-variable failure logging + non-zero exit), 1.5 (defaults
// for optional values).

import { z } from "zod";
import { logger, type Logger } from "../observability/logger";

// ─── Reusable field schemas ──────────────────────────────────────────

/** A well-formed absolute URL (http, https, redis, postgres, …). */
const absoluteUrl = z.string().url({ message: "must be a well-formed absolute URL" });

/**
 * Comma-separated list of allowed client origins. Each entry must itself be a
 * well-formed absolute URL. Produces a trimmed, non-empty `string[]`.
 */
const clientOrigins = z
  .string({ required_error: "Required" })
  .transform((raw, ctx) => {
    const origins = raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    if (origins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must contain at least one origin",
      });
      return z.NEVER;
    }

    for (const origin of origins) {
      if (!absoluteUrl.safeParse(origin).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${origin}" is not a well-formed absolute URL`,
        });
      }
    }

    return origins;
  });

/**
 * Boolean parsed from a string env var. Accepts "true"/"1" (case-insensitive)
 * as true; everything else (including unset) resolves to the secure default of
 * false, so a typo can never silently enable a bypass flag.
 */
const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue;
      const normalized = value.trim().toLowerCase();
      return normalized === "true" || normalized === "1";
    });

/** Positive integer with an optional documented default. */
const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

// ─── Schema ──────────────────────────────────────────────────────────

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce
    .number()
    .int("must be an integer")
    .min(1, "must be between 1 and 65535")
    .max(65535, "must be between 1 and 65535")
    .default(3001),
  CLIENT_ORIGINS: clientOrigins,
  DATABASE_URL: absoluteUrl,
  REDIS_URL: absoluteUrl,
  JWT_SECRET: z
    .string({ required_error: "Required" })
    .min(32, "must be a non-empty string of at least 32 characters"),
  OPEN_MODE: booleanFlag(false),
  STROKE_CAP: positiveInt(50_000),
  FLUSH_INTERVAL_MS: positiveInt(1_000),
  FLUSH_BATCH_SIZE: positiveInt(200),
  // Maximum accepted inbound message size in bytes. Enforced both as the
  // Socket.IO transport `maxHttpBufferSize` cap and as an application-level
  // guard that returns an invalid-payload error indication (Requirement 2.6).
  MAX_MESSAGE_BYTES: positiveInt(16_384),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

// ─── Error formatting ────────────────────────────────────────────────

export interface EnvValidationIssue {
  /** The offending environment variable name. */
  variable: string;
  /** Human-readable reason the variable failed validation. */
  reason: string;
}

export type ParseEnvResult =
  | { success: true; env: Env }
  | { success: false; issues: EnvValidationIssue[] };

/**
 * Collapse zod issues into exactly one entry per affected variable, joining
 * multiple reasons for the same variable so each variable is reported once.
 */
function formatIssues(error: z.ZodError): EnvValidationIssue[] {
  const grouped = new Map<string, string[]>();

  for (const issue of error.issues) {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : "(root)";
    const reasons = grouped.get(variable) ?? [];
    reasons.push(issue.message);
    grouped.set(variable, reasons);
  }

  return Array.from(grouped, ([variable, reasons]) => ({
    variable,
    reason: reasons.join("; "),
  }));
}

/**
 * Validate the raw environment without side effects. Returns either the parsed
 * config or a per-variable list of validation issues. Pure and testable.
 */
export function parseEnv(raw: NodeJS.ProcessEnv): ParseEnvResult {
  const parsed = EnvSchema.safeParse(raw);
  if (parsed.success) {
    return { success: true, env: parsed.data };
  }
  return { success: false, issues: formatIssues(parsed.error) };
}

// ─── Loader (fail-fast) ──────────────────────────────────────────────

export interface LoadEnvDeps {
  logger?: Pick<Logger, "error">;
  /** Process exit hook; injectable for tests. Defaults to `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Load and validate the environment. On failure, logs one entry per affected
 * variable (name + reason) and exits with a non-zero status code so the server
 * never starts misconfigured. Must be called before binding the server port.
 */
export function loadEnv(
  raw: NodeJS.ProcessEnv = process.env,
  deps: LoadEnvDeps = {}
): Env {
  const log = deps.logger ?? logger;
  const exit = deps.exit ?? ((code: number): never => process.exit(code));

  const result = parseEnv(raw);

  if (!result.success) {
    for (const { variable, reason } of result.issues) {
      log.error(`Invalid environment configuration: ${variable} — ${reason}`);
    }
    exit(1);
    // `exit` is typed as `never`; this throw is an unreachable safeguard so the
    // function never returns an unvalidated config when a stub exit is injected.
    throw new Error("Environment validation failed");
  }

  return result.env;
}
