/**
 * Phase 11 financial statements against POSTED data (PGlite). Synthetic data.
 *
 * Hand-worked books of client A:
 *   2025-01-01 OPENING  Dr 1020 Cash in bank 50,000     / Cr 3010 Capital 50,000
 *   2025-06-30          Dr 1100 AR 20,000               / Cr 4020 Service revenue 20,000
 *   2025-07-15          Dr 6020 Rent 8,000              / Cr 1020 8,000
 *   2025-12-31 CLOSING  Dr 4020 20,000 / Cr 6020 8,000, Cr 3100 Retained earnings 12,000
 *   2026-01-10          Dr 1020 20,000                  / Cr 1100 20,000 (collection)
 *   2026-02-01          Dr 1500 Equipment 30,000        / Cr 2200 Loans payable 30,000
 *   2026-02-28          Dr 6050 Depreciation 500        / Cr 1510 Accum. depreciation 500
 *   2026-03-15          Dr 1020 15,000                  / Cr 4020 15,000
 *   2026-03-20          Dr 6010 Salaries 4,000.50       / Cr 1020 4,000.50
 *   2026-03-25 DRAFT    Dr 6020 999 / Cr 1020 999       (never posted: must not appear)
 *   2026-03-26          Dr 6040 700 / Cr 1020 700, then REVERSED the same day (nets to zero)
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  balanceSheet,
  cashFlow,
  incomeStatement,
  toText,
  trialBalance,
  type BalanceRow,
} from "../../src/lib/reports/statements";
import { createTestDb, IDS, seedFixture, type Db, type UserKey } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const PREP = "accountantB" as const;
const POST = "reviewerA" as const;
const acct: Record<string, string> = {};

async function entry(date: string, type: string, lines: [string, string, string][], post = true) {
  const [{ id }] = await h.run<{ id: string }>(
    PREP,
    "select public.save_draft_entry($1, null, $2::date, $3::public.entry_type, 'test', null, null, $4, $5::jsonb) as id",
    [
      A,
      date,
      type,
      newKey(),
      JSON.stringify(
        lines.map(([code, debit, credit]) => ({ account_id: acct[code], debit, credit })),
      ),
    ],
  );
  if (post) {
    await h.run(PREP, "select public.submit_entry($1)", [id]);
    await h.run(POST, "select public.approve_and_post($1)", [id]);
  }
  return id;
}
const balances = async (from: string | null, to: string, closing = true, who: UserKey = POST) =>
  (await h.read<Record<string, unknown>>(
    who,
    "select * from public.report_account_balances($1, $2::date, $3::date, $4)",
    [A, from, to, closing],
  )) as unknown as BalanceRow[];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  await h.run(POST, "select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
  await h.run(POST, "select public.create_fiscal_year($1, '2025-01-01'::date)", [A]);
  await h.run(POST, "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
  for (const r of (
    await db.query<{ id: string; code: string }>(
      "select id, code from public.accounts where client_id = $1",
      [A],
    )
  ).rows)
    acct[r.code] = r.id;

  await entry("2025-01-01", "opening", [
    ["1020", "50000", ""],
    ["3010", "", "50000"],
  ]);
  await entry("2025-06-30", "general", [
    ["1100", "20000", ""],
    ["4020", "", "20000"],
  ]);
  await entry("2025-07-15", "general", [
    ["6020", "8000", ""],
    ["1020", "", "8000"],
  ]);
  await entry("2025-12-31", "closing", [
    ["4020", "20000", ""],
    ["6020", "", "8000"],
    ["3100", "", "12000"],
  ]);
  await entry("2026-01-10", "general", [
    ["1020", "20000", ""],
    ["1100", "", "20000"],
  ]);
  await entry("2026-02-01", "general", [
    ["1500", "30000", ""],
    ["2200", "", "30000"],
  ]);
  await entry("2026-02-28", "adjusting", [
    ["6050", "500", ""],
    ["1510", "", "500"],
  ]);
  await entry("2026-03-15", "general", [
    ["1020", "15000", ""],
    ["4020", "", "15000"],
  ]);
  await entry("2026-03-20", "general", [
    ["6010", "4000.50", ""],
    ["1020", "", "4000.50"],
  ]);
  await entry(
    "2026-03-25",
    "general",
    [
      ["6020", "999", ""],
      ["1020", "", "999"],
    ],
    false,
  );
  const wrong = await entry("2026-03-26", "general", [
    ["6040", "700", ""],
    ["1020", "", "700"],
  ]);
  await h.run(POST, "select public.reverse_entry($1, '2026-03-26'::date, 'posted in error', $2)", [
    wrong,
    newKey(),
  ]);
}, 60_000);

describe("integrity of statements built from posted entries", () => {
  it("trial balance: opening balances and period movements balance; drafts are excluded", async () => {
    const tb = trialBalance(await balances("2026-01-01", "2026-03-31"));
    expect(tb.balanced).toBe(true);
    const cash = tb.rows.find((r) => r.code === "1020")!;
    // opening 50,000 - 8,000 = 42,000; Q1: +20,000 +15,000 -4,000.50, the 700 nets out, the 999 draft is ignored
    expect([toText(cash.opening), toText(cash.closing)]).toEqual(["42000.00", "72999.50"]);
    expect(tb.rows.find((r) => r.code === "6020")).toBeUndefined(); // only the draft touched rent in 2026
  });

  it("income statement excludes year-end closing entries, so a closed year still shows its profit", async () => {
    const y2025 = incomeStatement(await balances("2025-01-01", "2025-12-31", false));
    expect([
      toText(y2025.revenue.total),
      toText(y2025.operatingExpenses.total),
      toText(y2025.netProfit),
    ]).toEqual(["20000.00", "8000.00", "12000.00"]);
    const q1 = incomeStatement(await balances("2026-01-01", "2026-03-31", false));
    expect(toText(q1.revenue.total)).toBe("15000.00");
    expect(q1.operatingExpenses.lines.map((l) => [l.code, toText(l.amount)])).toEqual([
      ["6010", "4000.50"],
      ["6050", "500.00"],
    ]); // the reversed 700 does not appear
    expect(toText(q1.netProfit)).toBe("10499.50");
  });

  it("balance sheet balances at year end and after; closed profit sits in retained earnings", async () => {
    const ye = balanceSheet(await balances("2025-01-01", "2025-12-31"));
    expect(ye.balanced).toBe(true);
    expect(toText(ye.totalAssets)).toBe("62000.00");
    expect(ye.equity.lines.map((l) => [l.label, toText(l.amount)])).toEqual([
      ["3010 Capital", "50000.00"],
      ["3100 Retained Earnings", "12000.00"],
    ]);
    const q1 = balanceSheet(await balances("2026-01-01", "2026-03-31"));
    expect(q1.balanced).toBe(true);
    expect(toText(q1.currentAssets.total)).toBe("72999.50");
    expect(toText(q1.noncurrentAssets.total)).toBe("29500.00"); // 30,000 - 500
    expect(toText(q1.noncurrentLiabilities.total)).toBe("30000.00");
    expect(q1.equity.lines.map((l) => [l.label, toText(l.amount)])).toEqual([
      ["3010 Capital", "50000.00"],
      ["3100 Retained Earnings", "12000.00"],
      ["Profit for the current year to date", "10499.50"],
    ]);
    expect(toText(q1.totalAssets)).toBe("102499.50");
  });

  it("cash flow (indirect) reconciles opening to closing cash", async () => {
    const cf = cashFlow(await balances("2026-01-01", "2026-03-31", false));
    expect(toText(cf.profit)).toBe("10499.50");
    expect(toText(cf.noncash.total)).toBe("500.00"); // depreciation added back
    expect(toText(cf.workingCapital.total)).toBe("20000.00"); // receivable collected
    expect(toText(cf.operating)).toBe("30999.50");
    expect(toText(cf.investing.total)).toBe("-30000.00");
    expect(toText(cf.financing.total)).toBe("30000.00");
    expect([toText(cf.openingCash), toText(cf.closingCash)]).toEqual(["42000.00", "72999.50"]);
    expect(cf.reconciles).toBe(true);
  });

  it("drill-down lists the posted lines of an account with their source", async () => {
    const lines = await h.read<{
      entry_date: string;
      source_type: string | null;
      debit: string;
      credit: string;
    }>(
      POST,
      "select entry_date::text, source_type, debit, credit from public.report_account_lines($1, $2, '2026-01-01'::date, '2026-03-31'::date)",
      [A, acct["1020"]],
    );
    expect(lines.map((l) => [l.entry_date, l.debit, l.credit])).toEqual([
      ["2026-01-10", "20000.00", "0.00"],
      ["2026-03-15", "15000.00", "0.00"],
      ["2026-03-20", "0.00", "4000.50"],
      ["2026-03-26", "0.00", "700.00"],
      ["2026-03-26", "700.00", "0.00"],
    ]);
    expect(lines.at(-1)!.source_type).toBe("reversal");
  });
});

describe("statement mapping (accounting policy) can be overridden per account", () => {
  it("moves a loan to current liabilities and back to the default", async () => {
    expect(
      await h.errorOf(POST, "select public.set_account_report_mapping($1, 'revenue', null)", [
        acct["2200"],
      ]),
    ).toBe("22023");
    await h.run(
      POST,
      "select public.set_account_report_mapping($1, 'current_liability', 'financing')",
      [acct["2200"]],
    );
    let bs = balanceSheet(await balances("2026-01-01", "2026-03-31"));
    expect(toText(bs.currentLiabilities.total)).toBe("30000.00");
    expect(bs.balanced).toBe(true);
    await h.run(POST, "select public.set_account_report_mapping($1, null, null)", [acct["2200"]]);
    bs = balanceSheet(await balances("2026-01-01", "2026-03-31"));
    expect(toText(bs.noncurrentLiabilities.total)).toBe("30000.00");
    expect(
      await h.errorOf(
        "ownerA",
        "select public.set_account_report_mapping($1, 'equity', 'financing')",
        [acct["3010"]],
      ),
    ).toBe("42501");
  });
});

describe("permissions and period close", () => {
  it("client users see statements only for closed periods; other tenants nothing", async () => {
    expect(
      await h.errorOf(
        "ownerA",
        "select * from public.report_account_balances($1, null, '2025-12-31'::date)",
        [A],
      ),
    ).toBe("42501"); // every period is still open
    const periods = await db.query<{ id: string }>(
      "select id from public.accounting_periods where client_id = $1 and end_date <= '2026-03-31' order by start_date",
      [A],
    );
    for (const p of periods.rows)
      await h.run(POST, "select public.set_period_status($1, 'soft_closed', 'quarter review')", [
        p.id,
      ]);
    const [{ d }] = await h.read<{ d: string }>(
      "ownerA",
      "select public.report_closed_through($1)::text as d",
      [A],
    );
    expect(d).toBe("2026-03-31");
    const owner = balanceSheet(await balances("2026-01-01", "2026-03-31", true, "ownerA"));
    expect(toText(owner.totalAssets)).toBe("102499.50"); // same figures as staff
    expect(
      await h.errorOf(
        "ownerA",
        "select * from public.report_account_balances($1, '2026-04-01'::date, '2026-04-30'::date)",
        [A],
      ),
    ).toBe("42501");
    // staff can see open periods (shown as preliminary)
    expect((await balances("2026-04-01", "2026-04-30")).length).toBeGreaterThan(0);
    for (const who of ["ownerB", "outsider", "firmAdmin"] as const)
      expect(
        await h.errorOf(
          who,
          "select * from public.report_account_balances($1, null, '2025-12-31'::date)",
          [A],
        ),
      ).toBe("42501");
  });
});
