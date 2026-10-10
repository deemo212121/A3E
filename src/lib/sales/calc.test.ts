import { describe, expect, it } from "vitest";

import { computeLine, totals } from "./calc";

// Same hand-worked cases as tests/db/sales.test.ts, so the display and the
// database agree.
const line = (quantity: string, unitPrice: string, taxClass = "vatable", discount = "") =>
  ({ quantity, unitPrice, discount, taxClass }) as Parameters<typeof computeLine>[0];

describe("sales line calculation (display mirror of the database)", () => {
  it("VAT-exclusive, per-line rounding half away from zero", () => {
    const ls = [
      computeLine(line("3", "33.3333"), false, "0.12"),
      computeLine(line("1", "10.005"), false, "0.12"),
      computeLine(line("2", "25", "exempt"), false, "0.12"),
    ];
    expect(ls.map((l) => [l?.lineAmount, l?.vat])).toEqual([
      [10000n, 1200n],
      [1001n, 120n],
      [5000n, 0n],
    ]);
    expect(totals(ls)).toEqual({ net: 16001n, vat: 1320n, total: 17321n, valid: true });
  });

  it("VAT-inclusive with a discount", () => {
    const ls = [
      computeLine(line("1", "1120"), true, "0.12"),
      computeLine(line("1", "100"), true, "0.12"),
      computeLine(line("2", "560", "vatable", "120"), true, "0.12"),
    ];
    expect(ls.map((l) => [l?.net, l?.vat])).toEqual([
      [100000n, 12000n],
      [8929n, 1071n],
      [89286n, 10714n],
    ]);
    expect(totals(ls).total).toBe(222000n);
  });

  it("invalid lines are flagged, never guessed", () => {
    expect(computeLine(line("1", "1.23456"), false, "0.12")).toBeNull();
    expect(computeLine(line("0", "10"), false, "0.12")).toBeNull();
    expect(computeLine(line("1", "10", "vatable", "10"), false, "0.12")).toBeNull();
    expect(totals([computeLine(line("1", "x"), false, "0.12")]).valid).toBe(false);
  });
});
