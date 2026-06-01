// ─── Transport security (CORS allowlist, secure transport, payload cap) ──────
// Pure, testable helpers that enforce the production transport rules shared by
// the Express app and the Socket.IO handshake:
//   • Requirement 2.5 — accept a cross-origin request / socket handshake only
//     when the request Origin is a member of the configured allowlist.
//   • Requirement 2.6 — reject inbound payloads that exceed the configured
//     maximum message size, returning an invalid-payload error indication to
//     the sender and leaving board state unchanged.
//   • Requirement 2.8 — in production, accept connections only over encrypted
//     transport (HTTPS / WSS).

import type { IncomingMessage } from "http";
import type { Socket } from "socket.io";
import type { Logger } from "../observability/logger";

/** Documented default maximum inbound message size (16 KiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 16_384;

/** Error code emitted to the sender when a payload is rejected. */
export const INVALID_PAYLOAD_CODE = "INVALID_PAYLOAD";

/**
 * Normalize a possibly-array header value to a single trimmed string, or
 * `undefined` when absent/empty.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Decide whether a request Origin is permitted by the allowlist.
 *
 * A request with no `Origin` header is not a cross-origin browser request
 * (browsers always send `Origin` for cross-origin calls), so it is treated as
 * same-origin / non-browser and allowed — this is the standard CORS semantic
 * and avoids breaking server-side and non-browser clients. When an `Origin`
 * is present it must match an entry in the allowlist exactly.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[]
): boolean {
  if (origin === undefined || origin.length === 0) return true;
  return allowlist.includes(origin);
}

/**
 * Determine whether the underlying handshake request arrived over encrypted
 * transport. Honors a direct TLS socket as well as the `X-Forwarded-Proto`
 * header set by a TLS-terminating load balancer / ingress.
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  if (encrypted) return true;

  const forwardedProto = headerValue(req.headers["x-forwarded-proto"]);
  if (forwardedProto) {
    // The header may carry a comma-separated proxy chain; the first hop wins.
    const proto = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (proto === "https" || proto === "wss") return true;
  }

  return false;
}

export interface AllowRequestOptions {
  /** Validated allowlist of permitted client origins. */
  allowlist: readonly string[];
  /** When true (production), reject handshakes not on encrypted transport. */
  requireSecureTransport: boolean;
  logger?: Pick<Logger, "warn">;
}

/** Socket.IO `allowRequest` callback signature. */
export type AllowRequestFn = (
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void
) => void;

/**
 * Build a Socket.IO `allowRequest` handler that rejects handshakes whose Origin
 * is not allowlisted (2.5) and, in production, whose transport is not encrypted
 * (2.8). Rejection refuses the connection before any room event is processed.
 */
export function createAllowRequest(options: AllowRequestOptions): AllowRequestFn {
  const { allowlist, requireSecureTransport, logger } = options;

  return (req, callback) => {
    const origin = headerValue(req.headers.origin);

    if (!isOriginAllowed(origin, allowlist)) {
      logger?.warn(
        { event: "handshake_rejected", reason: "origin_not_allowed", origin },
        "Rejected socket handshake: origin not allowlisted"
      );
      callback("origin_not_allowed", false);
      return;
    }

    if (requireSecureTransport && !isSecureRequest(req)) {
      logger?.warn(
        { event: "handshake_rejected", reason: "insecure_transport" },
        "Rejected socket handshake: encrypted transport required in production"
      );
      callback("insecure_transport", false);
      return;
    }

    callback(null, true);
  };
}

/**
 * Best-effort byte size of an event's argument list. Binary (Buffer/typed
 * array) args are summed directly; everything else is measured by its UTF-8
 * JSON serialization. Falls back to a conservative large value if a value
 * cannot be serialized, so unserializable payloads are treated as oversized.
 */
export function payloadByteSize(args: readonly unknown[]): number {
  let total = 0;
  for (const arg of args) {
    if (Buffer.isBuffer(arg)) {
      total += arg.byteLength;
    } else if (arg instanceof ArrayBuffer) {
      total += arg.byteLength;
    } else if (ArrayBuffer.isView(arg)) {
      total += arg.byteLength;
    } else {
      try {
        total += Buffer.byteLength(JSON.stringify(arg) ?? "", "utf8");
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    }
  }
  return total;
}

/**
 * Install a per-connection inbound middleware that drops any event whose
 * payload exceeds `maxBytes`, emitting an invalid-payload error indication to
 * the sender and leaving board state unchanged (the handler never runs). The
 * connection is kept open. This complements the transport-level
 * `maxHttpBufferSize` hard cap with a graceful application-level rejection.
 */
export function installPayloadSizeGuard(
  socket: Socket,
  maxBytes: number,
  logger?: Pick<Logger, "warn">
): void {
  socket.use((packet, next) => {
    const [event, ...args] = packet as [string, ...unknown[]];
    const size = payloadByteSize(args);

    if (size > maxBytes) {
      logger?.warn(
        {
          event: "payload_rejected",
          socketEvent: event,
          connectionId: socket.id,
          size,
          maxBytes,
        },
        "Dropped oversized inbound payload"
      );
      socket.emit("error", {
        code: INVALID_PAYLOAD_CODE,
        message: `Payload exceeds maximum message size of ${maxBytes} bytes`,
      });
      // Do not call next(): the event is dropped before reaching any handler,
      // so board state is unchanged and the connection stays open.
      return;
    }

    next();
  });
}
