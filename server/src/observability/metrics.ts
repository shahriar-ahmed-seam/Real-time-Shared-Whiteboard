// ─── Metrics (prom-client) ───────────────────────────────────────────
// Owns a dedicated prom-client Registry plus the small `Metrics` API the rest
// of the system uses to record runtime telemetry. The HTTP exposition route
// (`GET /metrics`) lives in `app.ts` and is mounted only when a Metrics handle
// is wired from the composition root, so health-only callers/tests stay
// unaffected.
//
// Reported series (Requirement 6.2):
//   • synapse_active_connections (gauge)   — current live socket connections.
//   • synapse_active_rooms       (gauge)   — current non-empty rooms.
//   • synapse_strokes_per_second (gauge)   — stroke throughput as strokes/sec
//                                            over a rolling 60-second window.
//   • synapse_strokes_total      (counter) — cumulative strokes since start
//                                            (the raw signal behind the rate).
//   • synapse_errors_total       (counter) — cumulative error count since the
//                                            process started.
//
// Access control (Requirements 6.6, 6.7) is enforced by the route guard in
// `app.ts` (see `createMetricsAccessGuard`), which restricts the endpoint to
// internal/private network addresses or authenticated callers and denies all
// others with no metrics data.
//
// A dedicated `Registry` (rather than the global default) is used so the
// exposition is limited to exactly the series above and so tests can construct
// isolated instances without cross-test interference.

import { Registry, Gauge, Counter } from "prom-client";

/** Rolling window length for the strokes/sec measure (Requirement 6.2). */
export const STROKE_RATE_WINDOW_SECONDS = 60;

/**
 * Fixed-memory rolling counter over a sliding window of whole seconds.
 *
 * The window is a ring of one-second buckets indexed by `epochSecond % size`.
 * Recording stamps the current bucket with its epoch-second and, when that slot
 * belonged to an older second, resets it first — so a bucket only contributes
 * while it is still inside the window. The rate is the sum of in-window buckets
 * divided by the window length, i.e. strokes per second averaged over the last
 * `windowSeconds` seconds. The clock is injectable for deterministic tests.
 */
export class RollingRate {
  private readonly windowSeconds: number;
  private readonly now: () => number;
  private readonly buckets: { epochSecond: number; count: number }[];

  constructor(windowSeconds: number = STROKE_RATE_WINDOW_SECONDS, now: () => number = Date.now) {
    this.windowSeconds = windowSeconds;
    this.now = now;
    this.buckets = Array.from({ length: windowSeconds }, () => ({
      epochSecond: -1,
      count: 0,
    }));
  }

  /** Record `amount` events (default 1) into the bucket for the current second. */
  record(amount = 1): void {
    const epochSecond = Math.floor(this.now() / 1000);
    const bucket = this.buckets[epochSecond % this.windowSeconds];
    // Reuse the slot for a newer second by resetting the stale value first.
    if (bucket.epochSecond !== epochSecond) {
      bucket.epochSecond = epochSecond;
      bucket.count = 0;
    }
    bucket.count += amount;
  }

  /** Total events recorded within the trailing window of whole seconds. */
  windowTotal(): number {
    const epochSecond = Math.floor(this.now() / 1000);
    const oldestInWindow = epochSecond - this.windowSeconds + 1;
    let total = 0;
    for (const bucket of this.buckets) {
      if (bucket.epochSecond >= oldestInWindow && bucket.epochSecond <= epochSecond) {
        total += bucket.count;
      }
    }
    return total;
  }

  /** Average events per second over the trailing window. */
  ratePerSecond(): number {
    return this.windowTotal() / this.windowSeconds;
  }
}

/**
 * Telemetry recorder backed by a dedicated prom-client {@link Registry}.
 *
 * Instantiated once in the composition root and threaded to the gateway /
 * handlers, which call the `record*` / `*Connection` / `*Room` helpers as
 * events occur. The exposition route in `app.ts` serializes {@link registry}
 * on each scrape; the strokes/sec gauge is refreshed from the rolling window at
 * scrape time via prom-client's `collect` hook so it always reflects the most
 * recent 60 seconds.
 */
export class Metrics {
  /** The registry the `/metrics` route serializes. */
  readonly registry: Registry;

  /** Current live socket connections. */
  private readonly activeConnections: Gauge<string>;
  /** Current non-empty rooms. */
  private readonly activeRooms: Gauge<string>;
  /** Strokes/sec over the rolling 60s window (refreshed on scrape). */
  private readonly strokesPerSecond: Gauge<string>;
  /** Cumulative strokes since process start. */
  private readonly strokesTotal: Counter<string>;
  /** Cumulative errors since process start. */
  private readonly errorsTotal: Counter<string>;

  /** Rolling-window backing store for the strokes/sec gauge. */
  private readonly strokeRate: RollingRate;

  constructor(options: { now?: () => number; windowSeconds?: number } = {}) {
    const windowSeconds = options.windowSeconds ?? STROKE_RATE_WINDOW_SECONDS;
    this.registry = new Registry();
    this.strokeRate = new RollingRate(windowSeconds, options.now);

    this.activeConnections = new Gauge({
      name: "synapse_active_connections",
      help: "Number of currently active socket connections.",
      registers: [this.registry],
    });

    this.activeRooms = new Gauge({
      name: "synapse_active_rooms",
      help: "Number of currently active (non-empty) rooms.",
      registers: [this.registry],
    });

    this.strokesPerSecond = new Gauge({
      name: "synapse_strokes_per_second",
      help: `Stroke throughput as strokes per second averaged over a rolling ${windowSeconds}-second window.`,
      registers: [this.registry],
      // Refresh from the rolling window at scrape time so the reported rate
      // always reflects the trailing window even between explicit records.
      collect: () => {
        this.strokesPerSecond.set(this.strokeRate.ratePerSecond());
      },
    });

    this.strokesTotal = new Counter({
      name: "synapse_strokes_total",
      help: "Cumulative number of strokes appended since process start.",
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: "synapse_errors_total",
      help: "Cumulative number of errors since process start.",
      registers: [this.registry],
    });
  }

  /** Record a new live connection. */
  connectionOpened(): void {
    this.activeConnections.inc();
  }

  /** Record a closed connection. */
  connectionClosed(): void {
    this.activeConnections.dec();
  }

  /** Set the active connection count to an absolute value. */
  setActiveConnections(count: number): void {
    this.activeConnections.set(count);
  }

  /** Record a newly-active (first member joined) room. */
  roomOpened(): void {
    this.activeRooms.inc();
  }

  /** Record a room becoming empty / removed. */
  roomClosed(): void {
    this.activeRooms.dec();
  }

  /** Set the active room count to an absolute value. */
  setActiveRooms(count: number): void {
    this.activeRooms.set(count);
  }

  /**
   * Record `amount` appended strokes (default 1): increments the cumulative
   * counter and feeds the rolling strokes/sec window.
   */
  recordStroke(amount = 1): void {
    this.strokesTotal.inc(amount);
    this.strokeRate.record(amount);
  }

  /** Increment the cumulative error counter. */
  recordError(amount = 1): void {
    this.errorsTotal.inc(amount);
  }

  /** Current strokes/sec over the rolling window (for tests / introspection). */
  currentStrokesPerSecond(): number {
    return this.strokeRate.ratePerSecond();
  }

  /** Serialize the registry in Prometheus text exposition format. */
  async serialize(): Promise<string> {
    return this.registry.metrics();
  }

  /** Prometheus exposition content type for the `/metrics` response. */
  get contentType(): string {
    return this.registry.contentType;
  }
}

// ─── Access restriction (Requirements 6.6, 6.7) ──────────────────────
// The metrics endpoint must be reachable only by callers on an internal /
// private network address or by callers presenting valid authentication
// credentials; everyone else is denied with no metrics data. These helpers are
// pure and testable; `app.ts` wires the resulting predicate into a route guard.

/** Strip an IPv6-mapped-IPv4 prefix and surrounding zone/brackets from an IP. */
function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  let value = ip.trim();
  // Strip an IPv6 zone id (e.g. fe80::1%eth0) and any surrounding brackets.
  value = value.replace(/^\[/, "").replace(/\]$/, "");
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  // IPv4-mapped IPv6 addresses: ::ffff:127.0.0.1 → 127.0.0.1
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) value = mapped[1];
  return value.toLowerCase();
}

/**
 * Decide whether an IP belongs to a loopback or private/internal range.
 *
 * Recognized as internal:
 *   • IPv4 loopback 127.0.0.0/8, private 10/8, 172.16/12, 192.168/16, and
 *     link-local 169.254/16.
 *   • IPv6 loopback ::1, unique-local fc00::/7 (fc/fd), and link-local fe80::/10.
 */
export function isInternalAddress(rawIp: string | undefined): boolean {
  const ip = normalizeIp(rawIp);
  if (ip.length === 0) return false;

  // IPv4
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map((part) => Number(part));
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  // IPv6
  if (ip === "::1") return true; // loopback
  if (ip === "::") return false; // unspecified
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique-local fc00::/7
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true; // link-local fe80::/10
  }

  return false;
}

/** Minimal request shape the access predicate inspects. */
export interface MetricsRequestLike {
  /** Authorization header value, if present. */
  authorization?: string;
  /** Direct peer address of the underlying connection (not proxy-forwarded). */
  remoteAddress?: string;
}

export interface MetricsAccessOptions {
  /**
   * Bearer token that authenticates a scraper. When set, a request carrying
   * `Authorization: Bearer <token>` is permitted regardless of source address.
   * Compared in constant time to avoid leaking the token via timing.
   */
  authToken?: string;
  /**
   * Custom authentication predicate, evaluated when the bearer-token check does
   * not apply/pass. Lets the composition root plug in alternative credentials.
   */
  isAuthenticated?: (req: MetricsRequestLike) => boolean;
}

/** Constant-time string comparison to avoid token timing side-channels. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Extract a bearer token from an Authorization header, if present. */
function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

/**
 * Pure predicate deciding whether a metrics request is permitted: it must come
 * from an internal/private address OR present valid authentication credentials
 * (Requirement 6.6). Everything else is denied (Requirement 6.7).
 */
export function isMetricsAccessAllowed(
  req: MetricsRequestLike,
  options: MetricsAccessOptions = {}
): boolean {
  if (isInternalAddress(req.remoteAddress)) return true;

  if (options.authToken) {
    const provided = bearerToken(req.authorization);
    if (provided && timingSafeEqual(provided, options.authToken)) return true;
  }

  if (options.isAuthenticated && options.isAuthenticated(req)) return true;

  return false;
}

/**
 * Configuration for wiring the `/metrics` endpoint into the Express app.
 * Supplied from the composition root; when omitted the route is not mounted so
 * existing callers/tests keep working unchanged.
 */
export interface MetricsConfig {
  /** The Metrics instance whose registry is exposed. */
  metrics: Metrics;
  /** Access-restriction options (Requirements 6.6, 6.7). */
  access?: MetricsAccessOptions;
  /**
   * Resolve the caller's source address for the access check. Defaults (in the
   * route) to the *direct* TCP peer (`req.socket.remoteAddress`), which cannot
   * be spoofed by a client header. A deployment behind a *trusted* reverse
   * proxy can override this to read the real client IP from a forwarded header
   * — the composition root owns that decision since only it knows the proxy
   * topology. Keeping the default on the direct peer is the safe choice.
   */
  resolveClientIp?: (req: { socket: { remoteAddress?: string } }) => string | undefined;
}
