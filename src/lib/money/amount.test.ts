import { describe, expect, it } from "vitest";

import { formatAmount, fromCentavos, isValidAmount, sumAmounts, toCentavos } from "./amount";

describe("money helpers (no floating point)", () => {
  it("converts to and from centavos exactly", () => {
    expect(toCentavos("4567.89")).toBe(456789n);
    expect(toCentavos("0.1")).toBe(10n);
    expect(toCentavos("")).toBe(0n);
    expect(fromCentavos(456789n)).toBe("4567.89");
    expect(fromCentavos(-5n)).toBe("-0.05");
  });

  it("sums exactly where floats would drift (0.1 + 0.2)", () => {
    expect(sumAmounts(["0.10", "0.20"])).toBe("0.30");
    expect(sumAmounts(["9999999999999999.99", "0.01"])).toBe("10000000000000000.00");
  });

  it("validates like the database parser", () => {
    for (const ok of ["0", "1", "1.5", "1234567890123456.99"]) expect(isValidAmount(ok)).toBe(true);
    for (const bad of ["-1", "1.234", "1,000", "1e3", " 1", "", "12345678901234567"])
      expect(isValidAmount(bad)).toBe(false);
    expect(() => toCentavos("1.234")).toThrow();
  });

  it("formats with thousands separators", () => {
    expect(formatAmount("1234567.5")).toBe("1,234,567.50");
    expect(formatAmount("-1000")).toBe("-1,000.00");
    expect(formatAmount("0.00")).toBe("0.00");
    expect(formatAmount(null)).toBe("");
  });
});
