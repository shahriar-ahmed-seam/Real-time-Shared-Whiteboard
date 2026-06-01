import { describe, it, expect, vi } from "vitest";

import {
  parseEnv,
  loadEnv,
  type EnvValidationIssue,
} from "../../src/config/env";

// ─── Config_Loader unit tests (Requirements 1.2, 1.3, 1.5) ───────────
//
// Exercises the pure `parseEnv` and the fail-fast `loadEnv`:
//   - 1.2: validation rules (port range, well-formed URLs, ≥32-char secret)
//   - 1.3: one logged failure per affected variable + non-zero exit
//   - 1.5: documented defaults applied for optional variables

/**
 * A minimal raw environment in which every REQUIRED variable is valid and no
 * optional variable is set, so defaults are observable. Spread + override per
 * test to isolate a single failing variable.
 */
const VALID_REQUIRED: NodeJS.ProcessEnv = {
  CLIENT_ORIGINS: "http://localhost:5173,https://app.synapse.example",
  DATABASE_URL: "postgres://user:pass@localhost:5432/synapse",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
};

/** Pull the single issue for a variable, asserting it was reported exactly once. */
function issueFor(
  issues: EnvValidationIssue[],
  variable: string
): EnvValidationIssue {
  const matches = issues.filter((i) => i.variable === variable);
  expect(
    matches.length,
    `expected exactly one issue for ${variable}, got ${matches.length}: ${JSON.stringify(issues)}`
  ).toBe(1);
  return matches[0];
}

// ─── Acceptance of a valid environment ───────────────────────────────

describe("parseEnv — valid environment", () => {
  it("accepts an env where every required variable is well-formed", () => {
    const result = parseEnv({ ...VALID_REQUIRED });

    expect(result.success).toBe(true);
    if (!result.success) return; // narrow for type-checker

    // CLIENT_ORIGINS is transformed into a trimmed, non-empty string[].
    expect(result.env.CLIENT_ORIGINS).toEqual([
      "http://localhost:5173",
      "https://app.synapse.example",
    ]);
    expect(result.env.DATABASE_URL).toBe(VALID_REQUIRED.DATABASE_URL);
    expect(result.env.REDIS_URL).toBe(VALID_REQUIRED.REDIS_URL);
    expect(result.env.JWT_SECRET).toBe(VALID_REQUIRED.JWT_SECRET);
  });

  it("trims whitespace and drops empty entries in CLIENT_ORIGINS", () => {
    const result = parseEnv({
      ...VALID_REQUIRED,
      CLIENT_ORIGINS: "  http://localhost:5173 , , https://app.synapse.example  ",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.env.CLIENT_ORIGINS).toEqual([
      "http://localhost:5173",
      "https://app.synapse.example",
    ]);
  });

  it("accepts an explicitly provided in-range PORT and ≥32-char secret", () => {
    const result = parseEnv({
      ...VALID_REQUIRED,
      PORT: "8080",
      JWT_SECRET: "a".repeat(64),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.env.PORT).toBe(8080);
    expect(result.env.JWT_SECRET).toBe("a".repeat(64));
  });
});

// ─── Rejection of missing required variables (Req 1.2, 1.3) ──────────

describe("parseEnv — missing required variables", () => {
  it.each(["CLIENT_ORIGINS", "DATABASE_URL", "REDIS_URL", "JWT_SECRET"])(
    "reports a per-variable issue when %s is missing",
    (variable) => {
      const raw = { ...VALID_REQUIRED };
      delete raw[variable];

      const result = parseEnv(raw);

      expect(result.success).toBe(false);
      if (result.success) return;
      // Exactly one issue, scoped to the missing variable, with a reason.
      const issue = issueFor(result.issues, variable);
      expect(issue.reason.length).toBeGreaterThan(0);
    }
  );

  it("reports an issue per affected variable when several are missing at once", () => {
    const result = parseEnv({ JWT_SECRET: "x".repeat(32) });

    expect(result.success).toBe(false);
    if (result.success) return;

    const reported = result.issues.map((i) => i.variable).sort();
    expect(reported).toEqual(["CLIENT_ORIGINS", "DATABASE_URL", "REDIS_URL"]);
    // One entry per variable — no duplicates.
    expect(new Set(reported).size).toBe(reported.length);
  });
});

// ─── Rejection of invalid values (Requirement 1.2) ───────────────────

describe("parseEnv — invalid values", () => {
  it("rejects a PORT above the valid range with a port issue", () => {
    const result = parseEnv({ ...VALID_REQUIRED, PORT: "70000" });

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = issueFor(result.issues, "PORT");
    expect(issue.reason).toContain("65535");
  });

  it("rejects a PORT below the valid range", () => {
    const result = parseEnv({ ...VALID_REQUIRED, PORT: "0" });

    expect(result.success).toBe(false);
    if (result.success) return;
    issueFor(result.issues, "PORT");
  });

  it("rejects a non-integer PORT", () => {
    const result = parseEnv({ ...VALID_REQUIRED, PORT: "3001.5" });

    expect(result.success).toBe(false);
    if (result.success) return;
    issueFor(result.issues, "PORT");
  });

  it("rejects a malformed DATABASE_URL", () => {
    const result = parseEnv({ ...VALID_REQUIRED, DATABASE_URL: "not-a-url" });

    expect(result.success).toBe(false);
    if (result.success) return;
    issueFor(result.issues, "DATABASE_URL");
  });

  it("rejects a malformed REDIS_URL", () => {
    const result = parseEnv({ ...VALID_REQUIRED, REDIS_URL: "://broken" });

    expect(result.success).toBe(false);
    if (result.success) return;
    issueFor(result.issues, "REDIS_URL");
  });

  it("rejects CLIENT_ORIGINS containing a malformed origin", () => {
    const result = parseEnv({
      ...VALID_REQUIRED,
      CLIENT_ORIGINS: "http://localhost:5173,not-a-url",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = issueFor(result.issues, "CLIENT_ORIGINS");
    expect(issue.reason).toContain("not-a-url");
  });

  it("rejects a CLIENT_ORIGINS that resolves to no origins", () => {
    const result = parseEnv({ ...VALID_REQUIRED, CLIENT_ORIGINS: "  ,  " });

    expect(result.success).toBe(false);
    if (result.success) return;
    issueFor(result.issues, "CLIENT_ORIGINS");
  });

  it("rejects a JWT_SECRET shorter than 32 characters", () => {
    const result = parseEnv({ ...VALID_REQUIRED, JWT_SECRET: "tooshort" });

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = issueFor(result.issues, "JWT_SECRET");
    expect(issue.reason).toContain("32");
  });

  it("reports one issue per variable when multiple values are invalid", () => {
    const result = parseEnv({
      ...VALID_REQUIRED,
      PORT: "70000",
      DATABASE_URL: "nope",
      JWT_SECRET: "short",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    const reported = result.issues.map((i) => i.variable).sort();
    expect(reported).toEqual(["DATABASE_URL", "JWT_SECRET", "PORT"]);
  });
});

// ─── Defaults for optional variables (Requirement 1.5) ───────────────

describe("parseEnv — defaults for optional variables", () => {
  it("applies documented defaults when optional variables are absent", () => {
    const result = parseEnv({ ...VALID_REQUIRED });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.env.NODE_ENV).toBe("development");
    expect(result.env.PORT).toBe(3001);
    expect(result.env.OPEN_MODE).toBe(false);
    expect(result.env.STROKE_CAP).toBe(50_000);
    expect(result.env.FLUSH_INTERVAL_MS).toBe(1_000);
    expect(result.env.FLUSH_BATCH_SIZE).toBe(200);
    expect(result.env.MAX_MESSAGE_BYTES).toBe(16_384);
    expect(result.env.LOG_LEVEL).toBe("info");
  });

  it("prefers a provided optional value over its default", () => {
    const result = parseEnv({
      ...VALID_REQUIRED,
      NODE_ENV: "production",
      OPEN_MODE: "true",
      STROKE_CAP: "100",
      LOG_LEVEL: "debug",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.env.NODE_ENV).toBe("production");
    expect(result.env.OPEN_MODE).toBe(true);
    expect(result.env.STROKE_CAP).toBe(100);
    expect(result.env.LOG_LEVEL).toBe("debug");
  });

  it("treats OPEN_MODE values other than true/1 as the secure default false", () => {
    for (const value of ["false", "0", "no", "yes", "TRUE-ish", ""]) {
      const result = parseEnv({ ...VALID_REQUIRED, OPEN_MODE: value });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const expected = value.trim().toLowerCase() === "true" || value.trim() === "1";
      expect(result.env.OPEN_MODE).toBe(expected);
    }
  });
});

// ─── Fail-fast loader behavior (Requirement 1.3) ─────────────────────

describe("loadEnv — fail-fast on invalid configuration", () => {
  it("returns the parsed env without exiting when configuration is valid", () => {
    const exit = vi.fn();
    const error = vi.fn();

    const env = loadEnv(
      { ...VALID_REQUIRED },
      { exit: exit as unknown as (code: number) => never, logger: { error } }
    );

    expect(env.PORT).toBe(3001);
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs one entry per affected variable and exits non-zero on failure", () => {
    const exit = vi.fn(() => {
      throw new Error("exit called");
    });
    const error = vi.fn();

    expect(() =>
      loadEnv(
        { JWT_SECRET: "short" },
        { exit: exit as unknown as (code: number) => never, logger: { error } }
      )
    ).toThrow();

    // Missing CLIENT_ORIGINS, DATABASE_URL, REDIS_URL + invalid JWT_SECRET → 4 entries.
    expect(error).toHaveBeenCalledTimes(4);

    // Each logged line names the offending variable (Requirement 1.3).
    const loggedVariables = error.mock.calls.map((call) => String(call[0]));
    for (const variable of [
      "CLIENT_ORIGINS",
      "DATABASE_URL",
      "REDIS_URL",
      "JWT_SECRET",
    ]) {
      expect(loggedVariables.some((line) => line.includes(variable))).toBe(true);
    }

    // Exited with a non-zero status code before returning a config.
    expect(exit).toHaveBeenCalledWith(1);
  });
});
