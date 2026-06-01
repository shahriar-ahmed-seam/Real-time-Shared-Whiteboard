import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage } from "http";

import {
  isOriginAllowed,
  isSecureRequest,
  payloadByteSize,
  createAllowRequest,
  DEFAULT_MAX_MESSAGE_BYTES,
} from "../../src/socket/transport";

// ─── CORS origin allowlist (Requirement 2.5) ─────────────────────────

describe("isOriginAllowed", () => {
  const allowlist = ["http://localhost:5173", "https://app.synapse.example"];

  it("permits an origin that is a member of the allowlist", () => {
    expect(isOriginAllowed("http://localhost:5173", allowlist)).toBe(true);
    expect(isOriginAllowed("https://app.synapse.example", allowlist)).toBe(true);
  });

  it("rejects an origin that is not in the allowlist", () => {
    expect(isOriginAllowed("https://evil.example", allowlist)).toBe(false);
    // Subdomain / path variations must not match by accident.
    expect(isOriginAllowed("http://localhost:5174", allowlist)).toBe(false);
    expect(isOriginAllowed("https://app.synapse.example.evil.com", allowlist)).toBe(false);
  });

  it("treats a missing origin as same-origin / non-browser and allows it", () => {
    expect(isOriginAllowed(undefined, allowlist)).toBe(true);
    expect(isOriginAllowed("", allowlist)).toBe(true);
  });
});

// ─── Secure transport detection (Requirement 2.8) ────────────────────

function fakeReq(opts: {
  encrypted?: boolean;
  headers?: Record<string, string | string[]>;
}): IncomingMessage {
  return {
    socket: { encrypted: opts.encrypted ?? false },
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage;
}

describe("isSecureRequest", () => {
  it("is true for a direct TLS socket", () => {
    expect(isSecureRequest(fakeReq({ encrypted: true }))).toBe(true);
  });

  it("is true when X-Forwarded-Proto is https (TLS-terminating proxy)", () => {
    expect(
      isSecureRequest(fakeReq({ headers: { "x-forwarded-proto": "https" } }))
    ).toBe(true);
  });

  it("honors the first hop of a comma-separated forwarded proto chain", () => {
    expect(
      isSecureRequest(fakeReq({ headers: { "x-forwarded-proto": "https, http" } }))
    ).toBe(true);
  });

  it("is false for plaintext HTTP with no secure indicators", () => {
    expect(isSecureRequest(fakeReq({}))).toBe(false);
    expect(
      isSecureRequest(fakeReq({ headers: { "x-forwarded-proto": "http" } }))
    ).toBe(false);
  });
});

// ─── Payload size measurement (Requirement 2.6) ──────────────────────

describe("payloadByteSize", () => {
  it("measures JSON-serializable args by UTF-8 byte length", () => {
    expect(payloadByteSize([{ a: 1 }])).toBe(Buffer.byteLength('{"a":1}', "utf8"));
  });

  it("sums binary args directly", () => {
    const buf = Buffer.alloc(100);
    expect(payloadByteSize([buf])).toBe(100);
  });

  it("treats unserializable (circular) payloads as oversized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(payloadByteSize([circular])).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("DEFAULT_MAX_MESSAGE_BYTES is 16 KiB", () => {
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(16_384);
  });
});

// ─── allowRequest handshake gate (Requirements 2.5 + 2.8) ────────────

describe("createAllowRequest", () => {
  const allowlist = ["https://app.synapse.example"];

  it("accepts an allowlisted origin when secure transport is not required", () => {
    const allow = createAllowRequest({ allowlist, requireSecureTransport: false });
    const cb = vi.fn();
    allow(fakeReq({ headers: { origin: "https://app.synapse.example" } }), cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it("rejects a non-allowlisted origin", () => {
    const allow = createAllowRequest({ allowlist, requireSecureTransport: false });
    const cb = vi.fn();
    allow(fakeReq({ headers: { origin: "https://evil.example" } }), cb);
    expect(cb).toHaveBeenCalledWith("origin_not_allowed", false);
  });

  it("rejects an allowlisted origin over insecure transport in production", () => {
    const allow = createAllowRequest({ allowlist, requireSecureTransport: true });
    const cb = vi.fn();
    allow(fakeReq({ headers: { origin: "https://app.synapse.example" } }), cb);
    expect(cb).toHaveBeenCalledWith("insecure_transport", false);
  });

  it("accepts an allowlisted origin over secure transport in production", () => {
    const allow = createAllowRequest({ allowlist, requireSecureTransport: true });
    const cb = vi.fn();
    allow(
      fakeReq({
        encrypted: true,
        headers: { origin: "https://app.synapse.example" },
      }),
      cb
    );
    expect(cb).toHaveBeenCalledWith(null, true);
  });
});
