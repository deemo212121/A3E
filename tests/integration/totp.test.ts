import { describe, expect, it } from "vitest";

import { totp } from "./totp";

describe("totp", () => {
  // RFC 6238 Appendix B test vector (SHA-1), secret "12345678901234567890".
  it("matches the RFC 6238 test vector at T=59s", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32 of the ASCII secret
    expect(totp(secret, 59_000)).toBe("287082");
  });
});
