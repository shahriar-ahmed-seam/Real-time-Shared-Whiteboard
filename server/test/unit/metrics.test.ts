import { describe, it, expect } from "vitest";
import request from "supertest";

import { createApp } from "../../src/app";
import {
  Metrics,
  RollingRate,
  isInternalAddress,
  isMetricsAccessAllowed,
  STROKE_RATE_WINDOW_SECONDS,
} from "../../src/observability/metrics";

// Unit tests for the metrics endpoint and recorder.
//
// Validates: Requirement 6.2 — expose active connections, active rooms,
// strokes/sec over a rolling 60s window, and cumulative error count.
// Requirement 6.6 — restrict access to internal addresses or authenticated
// callers. Requirement 6.7 — deny others with no metrics data.

const ORIGINS = ["http://localhost:5173"];

// ─── RollingRate (rolling 60s window math) ───────────────────────────

describe("RollingRate", () => {
  it("defaults to a 60-second window", () => {
    expect(STROKE_RATE_WINDOW_SECONDS).toBe(60);
  });

  it("averages recorded events over the window length", () => {
    let nowMs = 10_000;
    const rate = new RollingRate(60, () => nowMs);
    for (let i = 0; i < 120; i += 1) rate.record();
    // 120 events across a 60s window → 2 strokes/sec.
    expect(rate.windowTotal()).toBe(120);
    expect(rate.ratePerSecond()).toBeCloseTo(2, 10);
  });

  it("drops events that fall outside the trailing window", () => {
    let nowMs = 0;
    const rate = new RollingRate(60, () => nowMs);
    rate.record(30); // bucket at second 0
    nowMs = 60_000; // advance a full window (second 60); second 0 now excluded
    expect(rate.windowTotal()).toBe(0);
    rate.record(10); // bucket at second 60
    expect(rate.windowTotal()).toBe(10);
  });

  it("reuses a ring slot for a newer second without double counting", () => {
    let nowMs = 0;
    const rate = new RollingRate(60, () => nowMs);
    rate.record(5); // second 0, slot 0
    nowMs = 60_000; // second 60 maps to slot 0 again
    rate.record(7);
    // Only the newer second's value should count; the stale slot was reset.
    expect(rate.windowTotal()).toBe(7);
  });
});

// ─── Metrics recorder ────────────────────────────────────────────────

describe("Metrics recorder", () => {
  it("reports active connections, rooms, strokes/sec, and cumulative errors", async () => {
    let nowMs = 5_000;
    const metrics = new Metrics({ now: () => nowMs });

    metrics.connectionOpened();
    metrics.connectionOpened();
    metrics.connectionClosed(); // → 1 active connection

    metrics.roomOpened(); // → 1 active room

    for (let i = 0; i < 60; i += 1) metrics.recordStroke(); // 60 strokes in window → 1/s

    metrics.recordError();
    metrics.recordError(); // → 2 errors

    const text = await metrics.serialize();

    expect(text).toContain("synapse_active_connections 1");
    expect(text).toContain("synapse_active_rooms 1");
    expect(text).toContain("synapse_strokes_total 60");
    expect(text).toContain("synapse_errors_total 2");
    // 60 strokes over a 60s window → 1 stroke/sec (refreshed on scrape).
    expect(text).toMatch(/synapse_strokes_per_second 1\b/);
    expect(metrics.currentStrokesPerSecond()).toBeCloseTo(1, 10);
  });

  it("exposes the Prometheus exposition content type", () => {
    const metrics = new Metrics();
    expect(metrics.contentType).toContain("text/plain");
  });
});

// ─── isInternalAddress (Requirement 6.6) ─────────────────────────────

describe("isInternalAddress", () => {
  it("treats loopback and private IPv4 ranges as internal", () => {
    expect(isInternalAddress("127.0.0.1")).toBe(true);
    expect(isInternalAddress("10.1.2.3")).toBe(true);
    expect(isInternalAddress("172.16.0.1")).toBe(true);
    expect(isInternalAddress("172.31.255.255")).toBe(true);
    expect(isInternalAddress("192.168.1.10")).toBe(true);
    expect(isInternalAddress("169.254.1.1")).toBe(true);
  });

  it("treats public IPv4 addresses as external", () => {
    expect(isInternalAddress("8.8.8.8")).toBe(false);
    expect(isInternalAddress("172.32.0.1")).toBe(false);
    expect(isInternalAddress("172.15.0.1")).toBe(false);
    expect(isInternalAddress("203.0.113.5")).toBe(false);
  });

  it("handles IPv6 loopback, ULA, link-local, and mapped-IPv4 forms", () => {
    expect(isInternalAddress("::1")).toBe(true);
    expect(isInternalAddress("fd00::1")).toBe(true);
    expect(isInternalAddress("fe80::1")).toBe(true);
    expect(isInternalAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isInternalAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isInternalAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("returns false for missing or empty addresses", () => {
    expect(isInternalAddress(undefined)).toBe(false);
    expect(isInternalAddress("")).toBe(false);
  });
});

// ─── isMetricsAccessAllowed (Requirements 6.6, 6.7) ──────────────────

describe("isMetricsAccessAllowed", () => {
  it("allows internal addresses without credentials", () => {
    expect(isMetricsAccessAllowed({ remoteAddress: "127.0.0.1" })).toBe(true);
  });

  it("denies external addresses without credentials", () => {
    expect(isMetricsAccessAllowed({ remoteAddress: "8.8.8.8" })).toBe(false);
  });

  it("allows an external caller presenting the configured bearer token", () => {
    expect(
      isMetricsAccessAllowed(
        { remoteAddress: "8.8.8.8", authorization: "Bearer s3cret-token" },
        { authToken: "s3cret-token" }
      )
    ).toBe(true);
  });

  it("denies an external caller presenting the wrong bearer token", () => {
    expect(
      isMetricsAccessAllowed(
        { remoteAddress: "8.8.8.8", authorization: "Bearer wrong" },
        { authToken: "s3cret-token" }
      )
    ).toBe(false);
  });

  it("supports a custom authentication predicate", () => {
    expect(
      isMetricsAccessAllowed(
        { remoteAddress: "8.8.8.8" },
        { isAuthenticated: () => true }
      )
    ).toBe(true);
  });
});

// ─── GET /metrics route ──────────────────────────────────────────────

describe("GET /metrics route", () => {
  it("is not mounted when metricsConfig is omitted (health-only app)", async () => {
    const app = createApp(ORIGINS);
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(404);
  });

  it("serves metrics to a loopback caller (supertest is local)", async () => {
    const metrics = new Metrics();
    metrics.recordStroke();
    const app = createApp(ORIGINS, { metricsConfig: { metrics } });

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("synapse_strokes_total 1");
  });

  it("denies a caller that is neither internal nor authenticated with 403 and no data", async () => {
    const metrics = new Metrics();
    metrics.recordStroke();
    // Simulate an external client by resolving the source to a public IP.
    const app = createApp(ORIGINS, {
      metricsConfig: {
        metrics,
        resolveClientIp: () => "203.0.113.7",
      },
    });

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(403);
    // No metrics data is returned (Requirement 6.7).
    expect(res.text).not.toContain("synapse_strokes_total");
    expect(res.body).toEqual({
      code: "FORBIDDEN",
      message: "Metrics access is restricted",
    });
  });

  it("allows an external caller that presents valid credentials", async () => {
    const metrics = new Metrics();
    metrics.recordStroke();
    const app = createApp(ORIGINS, {
      metricsConfig: {
        metrics,
        access: { authToken: "right" },
        resolveClientIp: () => "203.0.113.7",
      },
    });

    const denied = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer wrong");
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer right");
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain("synapse_strokes_total 1");
  });
});
