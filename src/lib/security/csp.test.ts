import { describe, expect, it } from "vitest";

import { buildCsp, newNonce } from "./csp";

describe("content security policy", () => {
  it("allows only nonce-bearing scripts; no plugins, framing or foreign form targets", () => {
    const csp = buildCsp("abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("unsafe-eval");
    for (const d of [
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
    ])
      expect(csp).toContain(d);
  });
  it("relaxes only what the development server needs", () => {
    expect(buildCsp("n", true)).toContain("'unsafe-eval'");
    expect(buildCsp("n", true)).not.toContain("upgrade-insecure-requests");
  });
  it("nonces are unique per request", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
  });
});
