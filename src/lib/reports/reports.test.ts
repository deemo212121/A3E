import { describe, expect, it } from "vitest";

import { csvCell, toCsv } from "./csv";
import { comparisonRange } from "./periods";
import {
  balanceSheet,
  cashFlow,
  incomeStatement,
  roundBalanceSheet,
  roundBlock,
  roundIncomeStatement,
  roundPeso,
  toText,
  trialBalance,
  type BalanceRow,
} from "./statements";
import { balanceSheetTable, incomeStatementTable } from "./tables";

/*
 * Hand-worked September (synthetic). Opening: capital 10,000 in cash.
 *  a) loan received 5,000          Dr 1010 / Cr 2200
 *  b) equipment bought 3,000 cash  Dr 1500 / Cr 1010
 *  c) credit sale 7,240            Dr 1100 / Cr 4010
 *  d) collection 5,000             Dr 1010 / Cr 1100
 *  e) supplies on credit 1,000     Dr 6040 / Cr 2010
 *  f) depreciation 100             Dr 6050 / Cr 1510
 *  g) salaries paid 2,000.55       Dr 6010 / Cr 1010
 */
type Spec = [
  string,
  BalanceRow["account_type"],
  BalanceRow["section"],
  BalanceRow["cash_flow_class"],
  string,
  string,
  string,
];
const spec: Spec[] = [
  ["1010", "asset", "cash", "cash", "10000.00", "10000.00", "5000.55"],
  ["1100", "asset", "current_asset", "operating", "0.00", "7240.00", "5000.00"],
  ["1500", "asset", "noncurrent_asset", "investing", "0.00", "3000.00", "0.00"],
  ["1510", "asset", "noncurrent_asset", "noncash", "0.00", "0.00", "100.00"],
  ["2010", "liability", "current_liability", "operating", "0.00", "0.00", "1000.00"],
  ["2200", "liability", "noncurrent_liability", "financing", "0.00", "0.00", "5000.00"],
  ["3010", "equity", "equity", "financing", "-10000.00", "0.00", "0.00"],
  ["4010", "revenue", "revenue", null, "0.00", "0.00", "7240.00"],
  ["6010", "expense", "operating_expense", null, "0.00", "2000.55", "0.00"],
  ["6040", "expense", "operating_expense", null, "0.00", "1000.00", "0.00"],
  ["6050", "expense", "operating_expense", null, "0.00", "100.00", "0.00"],
];
const C = (s: string) => {
  const neg = s.startsWith("-");
  const [w, f] = s.replace("-", "").split(".");
  const c = BigInt(w) * 100n + BigInt(f);
  return neg ? -c : c;
};
const rows: BalanceRow[] = spec.map(([code, type, section, cf, opening, dr, cr]) => ({
  account_id: `id-${code}`,
  code,
  name: `Account ${code}`,
  account_type: type,
  normal_balance:
    type === "asset" || type === "expense" ? (code === "1510" ? "credit" : "debit") : "credit",
  section,
  cash_flow_class: cf,
  mapping_is_default: true,
  opening_net: opening,
  period_debit: dr,
  period_credit: cr,
  closing_net: toText(C(opening) + C(dr) - C(cr)),
}));

describe("statements from posted balances (hand-worked month)", () => {
  it("trial balance: opening and closing net to zero; debits equal credits", () => {
    const tb = trialBalance(rows);
    expect(tb.balanced).toBe(true);
    expect(toText(tb.totals.debit)).toBe("23340.55");
  });

  it("income statement", () => {
    const is = incomeStatement(rows);
    expect(toText(is.revenue.total)).toBe("7240.00");
    expect(toText(is.operatingExpenses.total)).toBe("3100.55");
    expect(toText(is.netProfit)).toBe("4139.45");
  });

  it("balance sheet balances, with profit not yet closed shown in equity", () => {
    const bs = balanceSheet(rows);
    expect(toText(bs.currentAssets.total)).toBe("17239.45");
    expect(toText(bs.noncurrentAssets.total)).toBe("2900.00"); // 3,000 - 100 depreciation
    expect(toText(bs.totalLiabilities)).toBe("6000.00");
    expect(bs.equity.lines.map((l) => [l.label, toText(l.amount)])).toEqual([
      ["3010 Account 3010", "10000.00"],
      ["Profit for the current year to date", "4139.45"],
    ]);
    expect(bs.balanced).toBe(true);
    expect(toText(bs.totalAssets)).toBe("20139.45");
  });

  it("cash flow (indirect) reconciles to the change in cash", () => {
    const cf = cashFlow(rows);
    expect(toText(cf.profit)).toBe("4139.45");
    expect(toText(cf.noncash.total)).toBe("100.00");
    expect(toText(cf.workingCapital.total)).toBe("-1240.00"); // AR -2,240, AP +1,000
    expect(toText(cf.operating)).toBe("2999.45");
    expect(toText(cf.investing.total)).toBe("-3000.00");
    expect(toText(cf.financing.total)).toBe("5000.00");
    expect([toText(cf.openingCash), toText(cf.netChange), toText(cf.closingCash)]).toEqual([
      "10000.00",
      "4999.45",
      "14999.45",
    ]);
    expect(cf.reconciles).toBe(true);
  });

  it("comparison columns show the change", () => {
    const t = incomeStatementTable(
      {
        current: incomeStatement(rows),
        prior: incomeStatement(
          rows.map((r) => ({ ...r, period_debit: "0.00", period_credit: "0.00" })),
        ),
      },
      "Sep",
      "Aug",
    );
    expect(t.columns).toEqual(["Sep", "Aug", "Change"]);
    const net = t.rows.find((r) => r.label === "Net profit (loss)")!;
    expect(net.values.map((v) => (v === null ? null : toText(v)))).toEqual([
      "4139.45",
      "0.00",
      "4139.45",
    ]);
    const bsT = balanceSheetTable({ current: balanceSheet(rows) }, "30 Sep");
    expect(bsT.rows.at(-1)!.values.map((v) => toText(v!))).toEqual(["20139.45"]);
  });
});

describe("rounding to whole pesos", () => {
  it("rounds half away from zero", () => {
    expect([roundPeso(150n), roundPeso(149n), roundPeso(-150n), roundPeso(-149n)]).toEqual([
      200n,
      100n,
      -200n,
      -100n,
    ]);
  });

  it("adds a rounding-difference line so lines add up to the rounded total", () => {
    const b = roundBlock({
      key: "x",
      title: "X",
      lines: ["a", "b", "c"].map((k) => ({ key: k, label: k, amount: 50n })), // 0.50 each
      total: 150n,
    });
    expect(b.lines.map((l) => [l.label, l.amount])).toEqual([
      ["a", 100n],
      ["b", 100n],
      ["c", 100n],
      ["Rounding difference", -100n],
    ]);
    expect(b.total).toBe(200n);
  });

  it("rounded statements still balance and keep the net profit", () => {
    const is = roundIncomeStatement(incomeStatement(rows));
    expect(toText(is.netProfit)).toBe("4139.00");
    const bs = roundBalanceSheet(balanceSheet(rows));
    expect(bs.balanced).toBe(true);
    expect(toText(bs.totalAssets)).toBe("20139.00");
  });
});

describe("comparison periods", () => {
  it("previous period of whole months, prior year, and day ranges", () => {
    expect(comparisonRange("2026-07-01", "2026-09-30", "previous")).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(comparisonRange("2026-03-01", "2026-03-31", "previous")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(comparisonRange("2024-02-01", "2024-02-29", "prior_year")).toEqual({
      from: "2023-02-01",
      to: "2023-02-28",
    });
    expect(comparisonRange("2026-09-10", "2026-09-19", "previous")).toEqual({
      from: "2026-08-31",
      to: "2026-09-09",
    });
  });
});

describe("CSV export", () => {
  it("quotes, keeps numbers, and neutralizes formulas", () => {
    expect(csvCell("-1234.50")).toBe("-1234.50");
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("Sales, net")).toBe('"Sales, net"');
    expect(toCsv([["a", 1n]])).toBe("﻿a,1\r\n");
  });
});
