import { describe, it, expect } from "vitest";
import request from "supertest";

import { createApp } from "../../src/app";
import {
  evaluateReadiness,
  databaseReadinessCheck,
  redisReadinessCheck,
  flagReadinessCheck,
  persistenceReadinessCheck,
  type ReadinessCheck,
} from "../../src/observability/health";

const ORIGINS = ["http://localhost:5173"];

// ─── Liveness endpoint (Requirement 6.3) ─────────────────────────────

describe("GET /healthz (liveness)", () => {
  it("responds 200 success regardless of datastore reachability", async () => {
    // A readiness check that would hang forever must NOT affect liveness.
    const hangingCheck: ReadinessCheck = {
      name: "database",
      probe: () => new Promise(() => {}),
    };
    const app = createApp(ORIGINS, { readinessChecks: [hangingCheck] });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "alive" });
  });

  it("responds well within 1 second", async () => {
    const app = createApp(ORIGINS);
    const start = Date.now();
    await request(app).get("/healthz").expect(200);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ─── Readiness endpoint (Requirements 6.4, 6.5) ──────────────────────

describe("GET /readyz (readiness)", () => {
  it("reports ready (200) when all dependency checks succeed", async () => {
    const checks: ReadinessCheck[] = [
      { name: "database", probe: async () => undefined },
      { name: "redis", probe: async () => "PONG" },
    ];
    const app = createApp(ORIGINS, { readinessChecks: checks });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual([
      { name: "database", ok: true },
      { name: "redis", ok: true },
    ]);
  });

  it("reports ready when no checks are configured (vacuous)", async () => {
    const app = createApp(ORIGINS);
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("reports not ready (503) and names the failed dependency", async () => {
    const checks: ReadinessCheck[] = [
      { name: "database", probe: async () => undefined },
      {
        name: "redis",
        probe: async () => {
          throw new Error("connection refused");
        },
      },
    ];
    const app = createApp(ORIGINS, { readinessChecks: checks });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    const redis = res.body.checks.find(
      (c: { name: string }) => c.name === "redis"
    );
    expect(redis.ok).toBe(false);
    expect(redis.error).toContain("connection refused");
    const db = res.body.checks.find(
      (c: { name: string }) => c.name === "database"
    );
    expect(db.ok).toBe(true);
  });

  it("reports not ready when a dependency check exceeds the time budget", async () => {
    const checks: ReadinessCheck[] = [
      { name: "database", probe: () => new Promise(() => {}) },
    ];
    const app = createApp(ORIGINS, {
      readinessChecks: checks,
      readinessTimeoutMs: 50,
    });

    const start = Date.now();
    const res = await request(app).get("/readyz");
    const elapsed = Date.now() - start;

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks[0].ok).toBe(false);
    expect(res.body.checks[0].error).toContain("timed out");
    // Settles around the budget, not the (infinite) probe duration.
    expect(elapsed).toBeLessThan(1000);
  });
});

// ─── evaluateReadiness (pure logic) ──────────────────────────────────

describe("evaluateReadiness", () => {
  it("is vacuously ready with no checks", async () => {
    const result = await evaluateReadiness([]);
    expect(result).toEqual({ ready: true, checks: [] });
  });

  it("captures a synchronously-thrown probe as a failed check", async () => {
    const result = await evaluateReadiness([
      {
        name: "database",
        probe: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(result.ready).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "database",
      ok: false,
    });
    expect(result.checks[0].error).toContain("boom");
  });

  it("times out a hanging probe within the budget", async () => {
    const start = Date.now();
    const result = await evaluateReadiness(
      [{ name: "redis", probe: () => new Promise(() => {}) }],
      50
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.ready).toBe(false);
    expect(result.checks[0].error).toContain("timed out");
  });

  it("preserves the order of supplied checks in the report", async () => {
    const result = await evaluateReadiness([
      { name: "database", probe: async () => undefined },
      { name: "redis", probe: async () => undefined },
    ]);
    expect(result.checks.map((c) => c.name)).toEqual(["database", "redis"]);
  });
});

// ─── Dependency check builders ───────────────────────────────────────

describe("databaseReadinessCheck", () => {
  it("probes the pool with SELECT 1 and is named 'database'", async () => {
    const calls: string[] = [];
    const check = databaseReadinessCheck({
      query: async (text: string) => {
        calls.push(text);
        return undefined;
      },
    });
    expect(check.name).toBe("database");
    await check.probe();
    expect(calls).toEqual(["SELECT 1"]);
  });
});

describe("redisReadinessCheck", () => {
  it("probes the client with PING and is named 'redis'", async () => {
    let pinged = false;
    const check = redisReadinessCheck({
      ping: async () => {
        pinged = true;
        return "PONG";
      },
    });
    expect(check.name).toBe("redis");
    await check.probe();
    expect(pinged).toBe(true);
  });
});

// ─── Degraded-readiness flag checks (Requirements 7.3, 7.6) ──────────

describe("flagReadinessCheck", () => {
  it("resolves (ready) while the flag reports healthy", async () => {
    const check = flagReadinessCheck("custom", () => true);
    expect(check.name).toBe("custom");
    await expect(check.probe()).resolves.toBeUndefined();
  });

  it("rejects with the unhealthy message when the flag reports unhealthy", async () => {
    const check = flagReadinessCheck("custom", () => false, "degraded now");
    await expect(check.probe()).rejects.toThrow("degraded now");
  });

  it("reads the flag live on each probe (recovers when it flips back)", async () => {
    let healthy = false;
    const check = flagReadinessCheck("custom", () => healthy);
    await expect(check.probe()).rejects.toThrow();
    healthy = true;
    await expect(check.probe()).resolves.toBeUndefined();
  });
});

describe("persistenceReadinessCheck", () => {
  it("is ready when the Stroke_Service reports persistence healthy", async () => {
    const check = persistenceReadinessCheck({ isPersistenceHealthy: () => true });
    expect(check.name).toBe("persistence");
    await expect(check.probe()).resolves.toBeUndefined();
  });

  it("reports not-ready (rejects) when write retries are exhausted (Req 7.6)", async () => {
    const check = persistenceReadinessCheck({ isPersistenceHealthy: () => false });
    await expect(check.probe()).rejects.toThrow(/retries exhausted/);
  });

  it("makes /readyz report not_ready and names persistence when degraded", async () => {
    let healthy = true;
    const checks: ReadinessCheck[] = [
      { name: "database", probe: async () => undefined },
      { name: "redis", probe: async () => "PONG" },
      persistenceReadinessCheck({ isPersistenceHealthy: () => healthy }),
    ];
    const app = createApp(ORIGINS, { readinessChecks: checks });

    // Healthy: ready.
    const ok = await request(app).get("/readyz");
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("ready");

    // Degraded: not ready, persistence named as the failed dependency.
    healthy = false;
    const degraded = await request(app).get("/readyz");
    expect(degraded.status).toBe(503);
    expect(degraded.body.status).toBe("not_ready");
    const persistence = degraded.body.checks.find(
      (c: { name: string }) => c.name === "persistence"
    );
    expect(persistence.ok).toBe(false);
    expect(persistence.error).toMatch(/retries exhausted/);

    // Recovery: ready again once a later flush succeeds.
    healthy = true;
    const recovered = await request(app).get("/readyz");
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("ready");
  });
});
