// ─── Structured logging (pino) ───────────────────────────────────────
// JSON structured logger built on pino. Every log line carries a `time`
// (ISO-8601 timestamp), a `severity` level, and any structured fields the
// caller attaches — notably an `event` type and `connectionId`/`roomId`
// correlation identifiers. Error events additionally carry their error
// context (pino serializes an `err` field via its standard error serializer).
//
// The exported `logger` instance and `Logger` type are preserved so existing
// callers — which invoke `.info/.warn/.error/.debug` with a single string —
// keep compiling unchanged. pino's log methods accept either a plain message
// string or a structured object plus message, so both styles work:
//
//   logger.info("Connected");                              // message only
//   logger.info({ event: "connect", connectionId }, "ok"); // structured
//
// The active level is driven by `LOG_LEVEL` (read directly from the
// environment to avoid an import cycle with `config/env.ts`, which itself
// depends on this module).
//
// Requirements: 6.1 (structured logs with timestamp, severity, event type,
// connection/room correlation ids, and error context for error events; level
// driven by LOG_LEVEL).

import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";

/** Severity levels supported by the logger, matching `LOG_LEVEL`. */
export type Severity = "debug" | "info" | "warn" | "error";

const SEVERITIES: readonly Severity[] = ["debug", "info", "warn", "error"];
const DEFAULT_LEVEL: Severity = "info";

/**
 * Preserve the exported `Logger` type. Aliasing pino's `Logger` keeps the
 * existing `.info/.warn/.error/.debug` surface that dependents rely on while
 * also exposing `.child(...)` for correlation-scoped logging.
 */
export type Logger = PinoLogger;

/** Correlation identifiers bound onto a child logger. */
export interface LogCorrelation {
  /** Per-connection (socket) correlation id. */
  connectionId?: string;
  /** Room the connection is acting within, when known. */
  roomId?: string;
  /** Any additional structured bindings. */
  [key: string]: unknown;
}

/** Coerce an arbitrary `LOG_LEVEL` value to a valid severity (default `info`). */
function resolveLevel(raw: string | undefined): Severity {
  const normalized = (raw ?? "").trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(normalized)
    ? (normalized as Severity)
    : DEFAULT_LEVEL;
}

/**
 * Build a pino logger. The level defaults to `process.env.LOG_LEVEL` so the
 * logger can be constructed before (and independently of) the validated config
 * loader, avoiding an import cycle.
 */
export function createLogger(
  level: string | undefined = process.env.LOG_LEVEL
): Logger {
  const options: LoggerOptions = {
    level: resolveLevel(level),
    // ISO-8601 timestamp so log lines are sortable and human-readable.
    timestamp: pino.stdTimeFunctions.isoTime,
    // Emit a string `severity` field instead of pino's numeric `level`.
    formatters: {
      level(label) {
        return { severity: label };
      },
    },
  };
  return pino(options);
}

/**
 * Derive a child logger that stamps every line with connection/room
 * correlation ids (and any extra bindings). Handlers create one per
 * connection so all of a socket's logs are correlated.
 */
export function childLogger(
  correlation: LogCorrelation,
  parent: Logger = logger
): Logger {
  return parent.child(correlation);
}

/** Application-wide root logger. */
export const logger: Logger = createLogger();
