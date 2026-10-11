/**
 * Phase 10 payroll tests (PGlite). Synthetic data only.
 *
 * ALL STATUTORY TABLES HERE ARE SYNTHETIC TEST TABLES ("TEST ONLY"), NOT the
 * real SSS, PhilHealth, Pag-IBIG or BIR tables. The platform ships with no
 * statutory rates; real tables are entered and signed off by the firm.
 *
 * Synthetic rules (from 2026-01-01):
 *   SSS (fixed table, monthly base): 0-9,999.99 -> EE 450 / ER 950 / EC 10;
 *     10,000-19,999.99 -> 900 / 1,900 / 10; 20,000+ -> 1,350 / 2,850 / 30.
 *     Version 2 from 2026-10-01: middle bracket EE 950 / ER 2,000 / EC 10.
 *   PhilHealth (rate table): 2.5% EE + 2.5% ER on the base clamped to
 *     [10,000, 60,000].
 *   Pag-IBIG (rate table, ceiling 5,000): up to 1,500 -> 1% EE / 2% ER;
 *     above -> 2% / 2%.
 *   Withholding (semi-monthly, after employee contributions): up to 10,000
 *     -> 0; over 10,000 -> 10% of the excess; over 20,000 -> 1,000 + 20%.
 *
 * Worked figures (hand-computed) are in each test.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const PREP = "accountantB" as const;
const POST = "reviewerA" as const;
const item: Record<string, string> = {};
const emp: Record<string, string> = {};
const rule: Record<string, string> = {};
const run: Record<string, string> = {};
let cash = "";

const acct = async (code: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.accounts where client_id = $1 and code = $2",
      [A, code],
    )
  ).rows[0].id;
const LEGAL = "TEST ONLY: synthetic table for automated tests, not a real statutory rate";
const proposeRule = async (r: Record<string, unknown>, who: "reviewerA" | "manager" = POST) =>
  (
    await h.run<{ id: string }>(who, "select public.propose_payroll_rule($1::jsonb) as id", [
      JSON.stringify({ legal_basis: LEGAL, description: "Synthetic test table", ...r }),
    ])
  )[0].id;
const signOff = (id: string, who: "reviewerA" | "manager" = "manager") =>
  h.run(who, "select public.sign_off_payroll_rule($1)", [id]);

async function payslip(runId: string, empNo: string) {
  const { rows } = await db.query<Record<string, string>>(
    `select ps.id, ps.gross_pay::text gross, ps.taxable_pay::text taxable, ps.sss_ee::text sss_ee,
            ps.sss_er::text sss_er, ps.sss_ec::text sss_ec, ps.philhealth_ee::text ph_ee,
            ps.philhealth_er::text ph_er, ps.pagibig_ee::text pi_ee, ps.pagibig_er::text pi_er,
            ps.withholding_tax::text tax, ps.other_deductions::text other, ps.net_pay::text net,
            ps.sss_rule_id::text sss_rule, ps.notes
       from public.payroll_payslips ps join public.employees e on e.id = ps.employee_id
      where ps.run_id = $1 and e.employee_no = $2`,
    [runId, empNo],
  );
  return rows[0];
}
const lines = (runId: string, empNo: string, l: Record<string, unknown>[]) =>
  payslip(runId, empNo).then((p) =>
    h.run(PREP, "select public.set_payslip_lines($1, $2::jsonb)", [p.id, JSON.stringify(l)]),
  );
async function createRun(start: string, end: string, key = newKey("run")) {
  const [r] = await h.run<{ id: string }>(
    PREP,
    "select public.create_payroll_run($1, 'semi_monthly', $2::date, $3::date, $3::date, null, $4) as id",
    [A, start, end, key],
  );
  return r.id;
}
async function entryLines(je: string) {
  const { rows } = await db.query<{
    code: string;
    debit: string;
    credit: string;
    cp: string | null;
  }>(
    `select a.code, l.debit::text, l.credit::text, l.counterparty_name cp from public.journal_lines l
       join public.accounts a on a.id = l.account_id where l.entry_id = $1 order by a.code`,
    [je],
  );
  return rows.map((r) => [r.code, r.debit, r.credit]);
}
const recon = async (asOf: string) =>
  Object.fromEntries(
    (
      await h.read<{ account_code: string; subledger_balance: string; difference: string }>(
        POST,
        "select account_code, subledger_balance, difference from public.payroll_reconciliation($1, $2::date)",
        [A, asOf],
      )
    ).map((r) => [r.account_code, [r.subledger_balance, r.difference]]),
  );

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  await h.run(POST, "select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
  await h.run(POST, "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
  cash = await acct("1020");
}, 60_000);

describe("access to payroll data is by explicit grant only", () => {
  it("assigned staff and client users see nothing until a manager grants access", async () => {
    expect(
      await h.errorOf(PREP, "select public.save_employee($1, null, $2::jsonb)", [A, "{}"]),
    ).toBe("42501");
    expect(
      await h.errorOf(PREP, "select public.grant_payroll_access($1, $2, 'prepare')", [
        A,
        IDS.accountantB,
      ]),
    ).toBe("42501");
    // role limits: approve only for reviewers/managers; firm admins get nothing
    expect(
      await h.errorOf("manager", "select public.grant_payroll_access($1, $2, 'approve')", [
        A,
        IDS.accountantB,
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf("manager", "select public.grant_payroll_access($1, $2, 'view')", [
        A,
        IDS.firmAdmin,
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf("manager", "select public.grant_payroll_access($1, $2, 'prepare')", [
        A,
        IDS.ownerA,
      ]),
    ).toBe("22023");
    await h.run("manager", "select public.grant_payroll_access($1, $2, 'prepare')", [
      A,
      IDS.accountantB,
    ]);
    await h.run("manager", "select public.grant_payroll_access($1, $2, 'approve')", [
      A,
      IDS.reviewerA,
    ]);
    const [access] = await h.read<{ payroll_client_ids: string[] }>(
      PREP,
      "select public.get_my_access() -> 'payroll_client_ids' as payroll_client_ids",
    );
    expect(access.payroll_client_ids).toEqual([A]);
  });
});

describe("statutory rules: verified, versioned, effective-dated", () => {
  it("only reviewers/managers enter rules; brackets must be contiguous; another person signs off", async () => {
    expect(
      await h.errorOf(PREP, "select public.propose_payroll_rule($1::jsonb)", [
        JSON.stringify({ kind: "sss" }),
      ]),
    ).toBe("42501");
    const gap = h.errorOf(POST, "select public.propose_payroll_rule($1::jsonb)", [
      JSON.stringify({
        kind: "sss",
        method: "fixed_table",
        description: "gap",
        legal_basis: LEGAL,
        effective_from: "2026-01-01",
        brackets: [
          { lower_bound: "0", upper_bound: "9999.99", ee_amount: "1", er_amount: "1" },
          { lower_bound: "10000.50", ee_amount: "1", er_amount: "1" },
        ],
      }),
    ]);
    expect(await gap).toBe("22023");

    rule.sss1 = await proposeRule({
      kind: "sss",
      method: "fixed_table",
      effective_from: "2026-01-01",
      brackets: [
        {
          lower_bound: "0",
          upper_bound: "9999.99",
          ee_amount: "450",
          er_amount: "950",
          ec_amount: "10",
        },
        {
          lower_bound: "10000",
          upper_bound: "19999.99",
          ee_amount: "900",
          er_amount: "1900",
          ec_amount: "10",
        },
        { lower_bound: "20000", ee_amount: "1350", er_amount: "2850", ec_amount: "30" },
      ],
    });
    rule.ph = await proposeRule({
      kind: "philhealth",
      method: "rate_table",
      effective_from: "2026-01-01",
      base_floor: "10000",
      base_ceiling: "60000",
      brackets: [{ lower_bound: "0", ee_rate: "0.025", er_rate: "0.025" }],
    });
    rule.pi = await proposeRule({
      kind: "pagibig",
      method: "rate_table",
      effective_from: "2026-01-01",
      base_ceiling: "5000",
      brackets: [
        { lower_bound: "0", upper_bound: "1500", ee_rate: "0.01", er_rate: "0.02" },
        { lower_bound: "1500.01", ee_rate: "0.02", er_rate: "0.02" },
      ],
    });
    rule.wt = await proposeRule({
      kind: "withholding",
      method: "graduated",
      effective_from: "2026-01-01",
      frequency: "semi_monthly",
      deduct_employee_contributions: true,
      brackets: [
        { lower_bound: "0", upper_bound: "10000", fixed_tax: "0", excess_rate: "0" },
        { lower_bound: "10000", upper_bound: "20000", fixed_tax: "0", excess_rate: "0.10" },
        { lower_bound: "20000", fixed_tax: "1000", excess_rate: "0.20" },
      ],
    });
    expect(await h.errorOf(POST, "select public.sign_off_payroll_rule($1)", [rule.sss1])).toBe(
      "42501",
    );
    for (const k of ["sss1", "ph", "pi"]) await signOff(rule[k]);
    // withholding is signed off later: a payroll cannot be submitted without it
  });
});

describe("setup: accounts, pay items, employees", () => {
  it("accounts default to the payroll accounts; items need a second person's approval", async () => {
    expect(await h.errorOf(PREP, "select public.apply_default_payroll_settings($1)", [A])).toBe(
      "42501",
    );
    await h.run(POST, "select public.apply_default_payroll_settings($1)", [A]);
    const P = "select public.propose_payroll_item($1, $2::jsonb) as id";
    const defs: Record<string, Record<string, unknown>> = {
      BASIC: {
        name: "Basic pay",
        kind: "earning",
        unit: "days",
        is_basic: true,
        is_taxable: true,
        in_sss_base: true,
        in_philhealth_base: true,
        in_pagibig_base: true,
        code6: "6010",
      },
      OT: {
        name: "Overtime",
        kind: "earning",
        unit: "hours",
        multiplier: "1.25",
        is_taxable: true,
        in_sss_base: true,
        code6: "6010",
      },
      ALLOW: { name: "Allowance (non-taxable, TEST)", kind: "earning", code6: "6014" },
      ADJ: {
        name: "Salary adjustment",
        kind: "earning",
        is_taxable: true,
        in_sss_base: true,
        in_philhealth_base: true,
        in_pagibig_base: true,
        code6: "6010",
      },
      LOAN: { name: "SSS loan", kind: "deduction", code6: "2150" },
    };
    for (const [code, { code6, ...d }] of Object.entries(defs)) {
      const [r] = await h.run<{ id: string }>(PREP, P, [
        A,
        JSON.stringify({ code, account_id: await acct(code6 as string), ...d }),
      ]);
      item[code] = r.id;
    }
    expect(await h.errorOf(PREP, "select public.approve_payroll_item($1)", [item.BASIC])).toBe(
      "42501",
    );
    for (const id of Object.values(item))
      await h.run(POST, "select public.approve_payroll_item($1)", [id]);
    // an expense account cannot carry a deduction
    expect(
      await h.errorOf(PREP, P, [
        A,
        JSON.stringify({
          code: "BAD",
          name: "bad",
          kind: "deduction",
          account_id: await acct("6010"),
        }),
      ]),
    ).toBe("22023");
  });

  it("employees with effective-dated rates (synthetic people)", async () => {
    const people: [string, string, string, string[]][] = [
      ["E01", "Santos", "Ana", ["monthly", "30000", "1500", "187.5"]],
      ["E02", "Reyes", "Ben", ["daily", "600", "600", "75"]],
      ["E03", "Cruz", "Cara", ["monthly", "80000", "4000", "500"]],
      ["E04", "Lim", "Dan", ["monthly", "20000", "1000", "125"]],
    ];
    for (const [no, last, first, [basis, basic, daily, hourly]] of people) {
      const [r] = await h.run<{ id: string }>(
        PREP,
        "select public.save_employee($1, null, $2::jsonb) as id",
        [
          A,
          JSON.stringify({
            employee_no: no,
            last_name: last,
            first_name: first,
            hire_date: "2026-01-05",
          }),
        ],
      );
      emp[no] = r.id;
      await h.run(
        PREP,
        "select public.add_employee_rate($1, '2026-01-05'::date, $2::public.pay_basis, $3, $4, $5)",
        [r.id, basis, basic, daily, hourly],
      );
    }
    // Ana's raise from the 16th: the first half uses 30,000, the second 36,000
    await h.run(
      PREP,
      "select public.add_employee_rate($1, '2026-09-16'::date, 'monthly', '36000', '1800', '225')",
      [emp.E01],
    );
    expect(
      await h.errorOf(PREP, "select public.save_employee($1, null, $2::jsonb)", [
        A,
        JSON.stringify({
          employee_no: "e01",
          last_name: "X",
          first_name: "Y",
          hire_date: "2026-01-01",
        }),
      ]),
    ).toBe("23505");
  });
});

describe("payroll 1: 2026-09-01 to 15 (rounding, bases, floors, ceilings)", () => {
  it("prefills basic pay; rounds per line, half away from zero", async () => {
    run.r1 = await createRun("2026-09-01", "2026-09-15", "run-key-0915x");
    expect(await createRun("2026-09-01", "2026-09-15", "run-key-0915x")).toBe(run.r1);
    expect(
      await h.errorOf(
        PREP,
        "select public.create_payroll_run($1, 'semi_monthly', '2026-09-01'::date, '2026-09-15'::date, '2026-09-15'::date, null, $2)",
        [A, newKey()],
      ),
    ).toBe("23505"); // duplicate payroll for the period
    expect((await payslip(run.r1, "E01")).gross).toBe("15000.00"); // 30,000 / 2
    expect((await payslip(run.r1, "E02")).gross).toBe("0.00"); // daily-paid: enter days
    await lines(run.r1, "E01", [
      { item_id: item.BASIC, amount: "15000" },
      { item_id: item.OT, quantity: "3.5" }, // 3.5 x 187.5 x 1.25 = 820.3125 -> 820.31
      { item_id: item.ALLOW, amount: "1000" },
    ]);
    await lines(run.r1, "E02", [
      { item_id: item.BASIC, quantity: "11" }, // 11 x 600 = 6,600
      { item_id: item.OT, quantity: "0.5" }, // 0.5 x 75 x 1.25 = 46.875 -> 46.88
      { item_id: item.LOAN, amount: "500" },
    ]);
    const { rows } = await db.query<{ amount: string }>(
      `select l.amount::text from public.payroll_lines l join public.payroll_payslips p on p.id = l.payslip_id
        where p.run_id = $1 and l.item_id = $2 order by l.amount`,
      [run.r1, item.OT],
    );
    expect(rows.map((r) => r.amount)).toEqual(["46.88", "820.31"]);
  });

  it("cannot be submitted while a statutory rule is not signed off", async () => {
    expect(await h.messageOf(PREP, "select public.submit_payroll_run($1)", [run.r1])).toMatch(
      /no signed-off withholding rule is in effect/,
    );
    await signOff(rule.wt);
    await h.run(PREP, "select public.submit_payroll_run($1)", [run.r1]);
  });

  it("computes every payslip as worked by hand", async () => {
    // Ana: gross 16,820.31; SSS base 15,820.31 -> 900/1,900/10; PhilHealth 15,000
    // x 2.5% = 375/375; Pag-IBIG 5,000 (ceiling) x 2% = 100/100; taxable
    // 15,820.31 - 1,375 = 14,445.31 -> 10% x 4,445.31 = 444.53; net 15,000.78
    expect(await payslip(run.r1, "E01")).toMatchObject({
      gross: "16820.31",
      taxable: "14445.31",
      sss_ee: "900.00",
      sss_er: "1900.00",
      sss_ec: "10.00",
      ph_ee: "375.00",
      ph_er: "375.00",
      pi_ee: "100.00",
      pi_er: "100.00",
      tax: "444.53",
      net: "15000.78",
    });
    // Ben: 6,646.88 gross; SSS lowest bracket; PhilHealth on the FLOOR 10,000 =
    // 250/250; Pag-IBIG 100/100; no tax; loan 500; net 5,346.88
    expect(await payslip(run.r1, "E02")).toMatchObject({
      gross: "6646.88",
      sss_ee: "450.00",
      ph_ee: "250.00",
      pi_ee: "100.00",
      tax: "0.00",
      other: "500.00",
      net: "5346.88",
    });
    // Cara: 40,000; SSS top bracket 1,350/2,850/30; PhilHealth 1,000/1,000;
    // taxable 37,550 -> 1,000 + 20% x 17,550 = 4,510; net 33,040
    expect(await payslip(run.r1, "E03")).toMatchObject({
      sss_ee: "1350.00",
      sss_ec: "30.00",
      ph_ee: "1000.00",
      tax: "4510.00",
      net: "33040.00",
    });
    expect(await payslip(run.r1, "E04")).toMatchObject({ sss_ee: "900.00", net: "8750.00" });
  });

  it("the preparer cannot post; the entry keeps EE, ER, expenses and liabilities apart", async () => {
    expect(await h.errorOf(PREP, "select public.post_payroll_run($1)", [run.r1])).toBe("42501");
    const [{ je }] = await h.run<{ je: string }>(POST, "select public.post_payroll_run($1) as je", [
      run.r1,
    ]);
    expect(await entryLines(je)).toEqual([
      ["2030", "0.00", "62137.66"], // net pay
      ["2115", "0.00", "4954.53"], // withholding on compensation
      ["2120", "0.00", "11260.00"], // SSS: EE 3,600 + ER 7,600 + EC 60
      ["2130", "0.00", "3750.00"], // PhilHealth: EE 1,875 + ER 1,875
      ["2140", "0.00", "800.00"], // Pag-IBIG: EE 400 + ER 400
      ["2150", "0.00", "500.00"], // loan deduction
      ["6010", "72467.19", "0.00"], // salaries (basic + overtime)
      ["6012", "9935.00", "0.00"], // employer contributions (ER + EC)
      ["6014", "1000.00", "0.00"], // allowance
    ]);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int n from public.journal_lines where entry_id = $1 and counterparty_name is not null",
      [je],
    );
    expect(rows[0].n).toBe(0); // no employee names in the general ledger
    // posting again returns the same entry (no duplicate)
    const [again] = await h.run<{ je: string }>(POST, "select public.post_payroll_run($1) as je", [
      run.r1,
    ]);
    expect(again.je).toBe(je);
    const { rows: runs } = await db.query<Record<string, string>>(
      "select gross_pay::text g, employee_contributions::text ee, employer_contributions::text er, net_pay::text n from public.payroll_runs where id = $1",
      [run.r1],
    );
    expect(runs[0]).toEqual({ g: "73467.19", ee: "5875.00", er: "9935.00", n: "62137.66" });
  });
});

describe("payroll 2: 2026-09-16 to 30 (true-up, ceiling, adjustment, termination)", () => {
  it("termination: not before a payroll the employee is on; final pay by days", async () => {
    expect(
      await h.errorOf(PREP, "select public.terminate_employee($1, '2026-08-31'::date, 'test')", [
        emp.E04,
      ]),
    ).toBe("22023");
    await h.run(PREP, "select public.terminate_employee($1, '2026-09-20'::date, 'Resigned')", [
      emp.E04,
    ]);
    run.r2 = await createRun("2026-09-16", "2026-09-30");
    expect((await payslip(run.r2, "E01")).gross).toBe("18000.00"); // new rate from the 16th
    expect((await payslip(run.r2, "E04")).gross).toBe("0.00"); // partial period: no prefill
    await lines(run.r2, "E04", [{ item_id: item.BASIC, quantity: "5" }]); // 5 x 1,000
    await lines(run.r2, "E03", [
      { item_id: item.BASIC, amount: "40000" },
      { item_id: item.ADJ, amount: "1000", description: "Adjustment for August" },
    ]);
    await h.run(PREP, "select public.remove_payslip($1)", [(await payslip(run.r2, "E02")).id]);
    await h.run(PREP, "select public.submit_payroll_run($1)", [run.r2]);
  });

  it("is posted only after the first half, and trues up month-to-date contributions", async () => {
    // Ana: SSS on 33,820.31 -> top bracket 1,350/2,850/30 less 900/1,900/10 =
    // 450/950/20; PhilHealth 33,000 x 2.5% = 825 less 375 = 450; Pag-IBIG at
    // ceiling already = 0; taxable 18,000 - 900 = 17,100 -> 710; net 16,390
    expect(await payslip(run.r2, "E01")).toMatchObject({
      sss_ee: "450.00",
      sss_er: "950.00",
      sss_ec: "20.00",
      ph_ee: "450.00",
      pi_ee: "0.00",
      tax: "710.00",
      net: "16390.00",
    });
    // Cara (CEILING): PhilHealth month base 81,000 capped at 60,000 -> 1,500
    // less 1,000 = 500; SSS unchanged; taxable 41,000 - 500 = 40,500 -> 5,100
    expect(await payslip(run.r2, "E03")).toMatchObject({
      gross: "41000.00",
      sss_ee: "0.00",
      ph_ee: "500.00",
      tax: "5100.00",
      net: "35400.00",
    });
    // Dan (final pay): PhilHealth 15,000 -> 375 less 250 = 125; net 4,875
    expect(await payslip(run.r2, "E04")).toMatchObject({
      gross: "5000.00",
      ph_ee: "125.00",
      net: "4875.00",
    });
    expect((await payslip(run.r2, "E04")).notes).toMatch(/Final pay/);
    const [{ je }] = await h.run<{ je: string }>(POST, "select public.post_payroll_run($1) as je", [
      run.r2,
    ]);
    expect(await entryLines(je)).toEqual([
      ["2030", "0.00", "56665.00"],
      ["2115", "0.00", "5810.00"],
      ["2120", "0.00", "1420.00"],
      ["2130", "0.00", "2150.00"],
      ["6010", "64000.00", "0.00"],
      ["6012", "2045.00", "0.00"],
    ]);
  });

  it("the first half cannot be cancelled while the second is posted", async () => {
    expect(
      await h.messageOf(POST, "select public.cancel_payroll_run($1, 'test')", [run.r1]),
    ).toMatch(/later payroll of this month is posted/);
  });
});

describe("effective dates: a new rule version from October", () => {
  it("a second signed-off version must not overlap; October uses version 2", async () => {
    rule.sss2 = await proposeRule({
      kind: "sss",
      method: "fixed_table",
      effective_from: "2026-10-01",
      brackets: [
        {
          lower_bound: "0",
          upper_bound: "9999.99",
          ee_amount: "450",
          er_amount: "950",
          ec_amount: "10",
        },
        {
          lower_bound: "10000",
          upper_bound: "19999.99",
          ee_amount: "950",
          er_amount: "2000",
          ec_amount: "10",
        },
        { lower_bound: "20000", ee_amount: "1350", er_amount: "2850", ec_amount: "30" },
      ],
    });
    expect(
      await h.messageOf("manager", "select public.sign_off_payroll_rule($1)", [rule.sss2]),
    ).toMatch(/another signed-off sss rule/);
    let code: string | undefined;
    try {
      await db.query(
        "update public.payroll_rule_brackets set ee_amount = 1 where rule_set_id = $1",
        [rule.sss1],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501"); // signed-off rules never change
    await h.run(POST, "select public.end_payroll_rule($1, '2026-09-30'::date)", [rule.sss1]);
    await signOff(rule.sss2);
    run.r3 = await createRun("2026-10-01", "2026-10-15");
    const ana = await payslip(run.r3, "E01");
    expect(ana).toMatchObject({ sss_ee: "950.00", sss_rule: rule.sss2 });
    // the separated employee is not on later payrolls
    expect(await payslip(run.r3, "E04")).toBeUndefined();
    expect(
      await h.errorOf(PREP, "select public.add_employee_to_run($1, $2)", [run.r3, emp.E04]),
    ).toBe("22023");
    // September payslips still show the version they used
    expect((await payslip(run.r1, "E01")).sss_rule).toBe(rule.sss1);
  });
});

describe("duplicate payrolls and self-approval", () => {
  it("the database itself refuses a second active payroll for a period", async () => {
    let code: string | undefined;
    try {
      await db.query(
        "insert into public.payroll_runs (client_id, frequency, period_start, period_end, pay_date, idempotency_key) values ($1, 'semi_monthly', '2026-09-01', '2026-09-15', '2026-09-15', 'direct-insert-key')",
        [A],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("23505");
  });

  it("an approver who prepared a payroll cannot post it", async () => {
    const [r] = await h.run<{ id: string }>(
      POST,
      "select public.create_payroll_run($1, 'semi_monthly', '2026-10-16'::date, '2026-10-31'::date, '2026-10-31'::date, null, $2) as id",
      [A, newKey()],
    );
    await h.run(POST, "select public.remove_payslip($1)", [(await payslip(r.id, "E02")).id]);
    await h.run(POST, "select public.submit_payroll_run($1)", [r.id]);
    expect(await h.messageOf(POST, "select public.post_payroll_run($1)", [r.id])).toMatch(
      /another approver must post it/,
    );
    await h.run(POST, "select public.cancel_payroll_run($1, 'test only')", [r.id]);
  });
});

describe("payments, remittances and the reconciliation gate", () => {
  it("records and posts payments by two people; no over-payment", async () => {
    const PAY =
      "select public.record_payroll_payment($1, $2::public.payroll_payment_kind, null, $3::date, $4, $5, 'REF', $6) as id";
    const [net] = await h.run<{ id: string }>(PREP, PAY, [
      run.r1,
      "net_pay",
      "2026-09-15",
      cash,
      "62137.66",
      newKey(),
    ]);
    expect(await h.errorOf(PREP, "select public.post_payroll_payment($1)", [net.id])).toBe("42501");
    await h.run(POST, "select public.post_payroll_payment($1)", [net.id]);
    expect(
      await h.errorOf(PREP, PAY, [run.r1, "sss", "2026-10-05", cash, "11260.01", newKey()]),
    ).toBe("22023");
    const [sss] = await h.run<{ id: string }>(PREP, PAY, [
      run.r1,
      "sss",
      "2026-10-05",
      cash,
      "11260.00",
      newKey(),
    ]);
    await h.run(POST, "select public.post_payroll_payment($1)", [sss.id]);
    // payroll 2 has no payments and nothing later: it can be cancelled...
    await h.run(POST, "select public.cancel_payroll_run($1, 'Recomputed in test')", [run.r2]);
    // ...and redone for the same period (the cancelled one no longer blocks it)
    const redo = await createRun("2026-09-16", "2026-09-30");
    expect(redo).not.toBe(run.r2);
    await h.run(PREP, "select public.cancel_payroll_run($1, 'not needed in test')", [redo]);
    expect(
      await h.messageOf(POST, "select public.cancel_payroll_run($1, 'test')", [run.r1]),
    ).toMatch(/payments are recorded/);
  });

  it("GATE: each payroll liability equals the general ledger on every date", async () => {
    expect(await recon("2026-09-15")).toEqual({
      "2030": ["0.00", "0.00"],
      "2115": ["4954.53", "0.00"],
      "2120": ["11260.00", "0.00"],
      "2130": ["3750.00", "0.00"],
      "2140": ["800.00", "0.00"],
    });
    // payroll 2 was posted on 09-30 and cancelled (reversed) on 09-30
    expect(await recon("2026-09-30")).toMatchObject({ "2130": ["3750.00", "0.00"] });
    expect(await recon("2026-10-10")).toMatchObject({ "2120": ["0.00", "0.00"] });
    const manual = JSON.stringify([
      { account_id: await acct("6012"), debit: "10.00", credit: "" },
      { account_id: await acct("2120"), debit: "", credit: "10.00" },
    ]);
    const [{ id }] = await h.run<{ id: string }>(
      PREP,
      "select public.save_draft_entry($1, null, '2026-10-06'::date, 'general', 'manual', null, null, $2, $3::jsonb) as id",
      [A, newKey(), manual],
    );
    await h.run(PREP, "select public.submit_entry($1)", [id]);
    await h.run(POST, "select public.approve_and_post($1)", [id]);
    expect((await recon("2026-10-10"))["2120"]).toEqual(["0.00", "10.00"]);
  });

  it("month summary per employee (posted payrolls only)", async () => {
    const rows = await h.read<{ employee_no: string; sss_ee: string; net_pay: string }>(
      POST,
      "select employee_no, sss_ee, net_pay from public.payroll_month_summary($1, '2026-09-01'::date)",
      [A],
    );
    expect(rows.find((r) => r.employee_no === "E01")).toEqual({
      employee_no: "E01",
      sss_ee: "900.00",
      net_pay: "15000.78",
    });
  });
});

describe("privacy", () => {
  it("without a grant nothing is visible; view access cannot change anything", async () => {
    const tables = [
      "employees",
      "employee_rates",
      "payroll_runs",
      "payroll_payslips",
      "payroll_lines",
      "payroll_payments",
      "payroll_items",
      "payroll_settings",
      "payroll_events",
    ];
    for (const who of ["ownerA", "ownerB", "outsider", "firmAdmin"] as const) {
      for (const t of tables) {
        expect(
          await h.read(who, `select 1 from public.${t} where client_id = $1`, [A]),
          `${who} ${t}`,
        ).toEqual([]);
      }
    }
    await h.run("manager", "select public.revoke_payroll_access($1, $2)", [A, IDS.accountantB]);
    for (const t of tables)
      expect(await h.read(PREP, `select 1 from public.${t} where client_id = $1`, [A]), t).toEqual(
        [],
      );
    expect(
      await h.read(PREP, "select * from public.payroll_reconciliation($1, '2026-12-31'::date)", [
        A,
      ]),
    ).toEqual([]);
    await h.run("manager", "select public.grant_payroll_access($1, $2, 'view')", [A, IDS.ownerA]);
    expect(
      (await h.read("ownerA", "select 1 from public.employees where client_id = $1", [A])).length,
    ).toBe(4);
    expect(
      await h.errorOf("ownerA", "select public.save_employee($1, null, $2::jsonb)", [A, "{}"]),
    ).toBe("42501");
    expect(await h.errorOf("ownerA", "update public.employees set first_name = 'X'")).toBe("42501");
    // the helper runs with the caller's rights: no grant, no amounts
    expect(
      await h.read("outsider", "select private.payroll_liability($1, 'net_pay', null)::text as v", [
        run.r1,
      ]),
    ).toEqual([{ v: "0" }]);
  });
});
