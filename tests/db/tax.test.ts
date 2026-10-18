/**
 * Phase 12 tax framework (PGlite). Synthetic data.
 *
 * EVERY RULE HERE IS A SYNTHETIC "TEST ONLY" RULE WITH MADE-UP RATES. None is
 * a real Philippine tax rule; the platform ships with no tax rules at all.
 *
 *   TEST_VAT v1 (2026-01-01..06-30): output = round(sales x 10%, 2);
 *            payable = max(output - input_credit - prior_excess, 0)
 *   TEST_VAT v2 (from 2026-07-01):   same with 11%
 *   TEST_GRAD: graduated table over 0 / 250,000 (15%) / 400,000 (22,500 + 20%)
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const PREP = "accountantB" as const; // writes fixtures, prepares computations
const AUTHOR = "reviewerA" as const; // enters rules, reviews fixtures
const APPROVER = "manager" as const; // approves rules
const acct: Record<string, string> = {};
const rule: Record<string, string> = {};
const SRC = [
  {
    citation: "TEST ONLY - synthetic rule for automated tests",
    title: "Synthetic",
    issued_on: "2026-01-01",
  },
];
const VAT = { vat_status: "vat_registered" };

const vatRule = (rate: string, from: string, to: string | null) => ({
  code: "TEST_VAT",
  name: "Synthetic VAT-like test rule",
  tax_type: "other",
  effective_from: from,
  effective_to: to,
  eligibility: [{ fact: "vat_status", op: "eq", value: "vat_registered" }],
  inputs: [
    { name: "sales", label: "Sales", source: "ledger" },
    { name: "input_credit", label: "Input credit", source: "ledger" },
    { name: "prior_excess", label: "Prior excess", source: "manual" },
  ],
  params: { rate },
  formula: {
    steps: [
      {
        name: "output_tax",
        expr: { round: { op: "mul", args: [{ input: "sales" }, { param: "rate" }] }, places: 2 },
      },
      {
        name: "payable",
        expr: {
          op: "max",
          args: [
            {
              op: "sub",
              args: [
                { op: "sub", args: [{ ref: "output_tax" }, { input: "input_credit" }] },
                { input: "prior_excess" },
              ],
            },
            "0",
          ],
        },
      },
    ],
    outputs: ["output_tax", "payable"],
  },
  sources: SRC,
});
const propose = async (r: unknown) =>
  (
    await h.run<{ id: string }>(AUTHOR, "select public.propose_tax_rule($1::jsonb) as id", [
      JSON.stringify(r),
    ])
  )[0].id;
const fixture = async (ruleId: string, f: Record<string, unknown>) =>
  (
    await h.run<{ id: string }>(PREP, "select public.add_tax_fixture($1, $2::jsonb) as id", [
      ruleId,
      JSON.stringify({ basis: "Hand-worked from the synthetic test rule", facts: VAT, ...f }),
    ])
  )[0].id;
async function reviewAll(ruleId: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.tax_rule_fixtures where rule_id = $1",
    [ruleId],
  );
  for (const r of rows)
    await h.run(AUTHOR, "select public.review_tax_fixture($1, 'checked')", [r.id]);
}
const approve = (id: string) =>
  h.run(APPROVER, "select public.approve_tax_rule($1, true, 'sources checked')", [id]);
const compute = (
  from: string,
  to: string,
  adjustments: unknown[] = [],
  code = "TEST_VAT",
  key = newKey("tax"),
) =>
  h
    .run<{
      r: {
        computation_id: string;
        status: string;
        reason: string | null;
        outputs: Record<string, string> | null;
      };
    }>(PREP, "select public.compute_tax($1, $2, $3::date, $4::date, $5::jsonb, $6) as r", [
      A,
      code,
      from,
      to,
      JSON.stringify(adjustments),
      key,
    ])
    .then((rows) => rows[0].r);
async function entry(date: string, lines: [string, string, string][], post = true) {
  const [{ id }] = await h.run<{ id: string }>(
    PREP,
    "select public.save_draft_entry($1, null, $2::date, 'general', 'test', null, null, $3, $4::jsonb) as id",
    [
      A,
      date,
      newKey(),
      JSON.stringify(lines.map(([c, debit, credit]) => ({ account_id: acct[c], debit, credit }))),
    ],
  );
  if (post) {
    await h.run(PREP, "select public.submit_entry($1)", [id]);
    await h.run(AUTHOR, "select public.approve_and_post($1)", [id]);
  }
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  await h.run(AUTHOR, "select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
  await h.run(AUTHOR, "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
  for (const r of (
    await db.query<{ id: string; code: string }>(
      "select id, code from public.accounts where client_id = $1",
      [A],
    )
  ).rows)
    acct[r.code] = r.id;
}, 60_000);

describe("rules registry: nothing computes until verified and approved", () => {
  it("only reviewers/managers enter rules; formulas are checked before saving", async () => {
    const P = "select public.propose_tax_rule($1::jsonb)";
    expect(await h.errorOf(PREP, P, [JSON.stringify(vatRule("0.10", "2026-01-01", null))])).toBe(
      "42501",
    );
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...vatRule("0.10", "2026-01-01", null), ...patch });
    expect(
      await h.messageOf(AUTHOR, P, [
        bad({ formula: { steps: [{ name: "x", expr: { input: "nope" } }], outputs: ["x"] } }),
      ]),
    ).toMatch(/undeclared input nope/);
    expect(
      await h.messageOf(AUTHOR, P, [
        bad({
          formula: { steps: [{ name: "x", expr: { op: "pow", args: ["2"] } }], outputs: ["x"] },
        }),
      ]),
    ).toMatch(/unknown operation pow/);
    expect(
      await h.messageOf(AUTHOR, P, [
        bad({ formula: { steps: [{ name: "x", expr: { ref: "y" } }], outputs: ["x"] } }),
      ]),
    ).toMatch(/before it is computed/);
    expect(
      await h.messageOf(AUTHOR, P, [
        bad({ formula: { steps: [{ name: "x", expr: { sql: "select 1" } }], outputs: ["x"] } }),
      ]),
    ).toMatch(/unknown formula node/);
    expect(
      await h.errorOf(AUTHOR, P, [
        bad({ eligibility: [{ fact: "vat_status", op: "like", value: "x" }] }),
      ]),
    ).toBe("22023");
  });

  it("submission needs sources and normal + boundary fixtures that pass", async () => {
    const noSrc = await propose({
      ...vatRule("0.10", "2026-01-01", null),
      code: "TEST_NOSRC",
      sources: [],
    });
    expect(await h.messageOf(AUTHOR, "select public.submit_tax_rule($1)", [noSrc])).toMatch(
      /authoritative source/,
    );
    const bad = await propose({ ...vatRule("0.10", "2026-01-01", null), code: "TEST_BAD" });
    await fixture(bad, {
      name: "normal",
      kind: "normal",
      as_of: "2026-03-31",
      inputs: { sales: "100", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "10.00", payable: "10.00" },
    });
    expect(await h.messageOf(AUTHOR, "select public.submit_tax_rule($1)", [bad])).toMatch(
      /boundary fixture/,
    );
    await fixture(bad, {
      name: "wrong",
      kind: "boundary",
      as_of: "2026-03-31",
      inputs: { sales: "100", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "11.00", payable: "11.00" },
    });
    expect(await h.messageOf(AUTHOR, "select public.submit_tax_rule($1)", [bad])).toMatch(
      /fixtures do not pass: wrong/,
    );
  });

  it("approval: accountant-reviewed fixtures, attested sources, a different approver", async () => {
    rule.v1 = await propose(vatRule("0.10", "2026-01-01", "2026-06-30"));
    const f = await fixture(rule.v1, {
      name: "normal: 10,000 sales, 300 input credit",
      kind: "normal",
      as_of: "2026-03-31",
      inputs: { sales: "10000", input_credit: "300", prior_excess: "0" },
      expected: { output_tax: "1000.00", payable: "700.00" },
    });
    await fixture(rule.v1, {
      name: "boundary: half a centavo rounds away from zero",
      kind: "boundary",
      as_of: "2026-06-30",
      inputs: { sales: "0.05", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "0.01", payable: "0.01" },
    });
    await fixture(rule.v1, {
      name: "boundary: credits exceed output, payable floors at zero",
      kind: "boundary",
      as_of: "2026-01-01",
      inputs: { sales: "1000", input_credit: "150", prior_excess: "0" },
      expected: { output_tax: "100.00", payable: "0.00" },
    });
    await fixture(rule.v1, {
      name: "boundary: non-VAT taxpayer is not eligible",
      kind: "boundary",
      as_of: "2026-03-31",
      facts: { vat_status: "non_vat" },
      inputs: { sales: "1000", input_credit: "0", prior_excess: "0" },
      expected: { not_applicable: "fails:vat_status" },
    });
    await h.run(AUTHOR, "select public.submit_tax_rule($1)", [rule.v1]);
    expect(
      await h.errorOf(AUTHOR, "select public.approve_tax_rule($1, true, null)", [rule.v1]),
    ).toBe("42501"); // author
    expect(
      await h.messageOf(APPROVER, "select public.approve_tax_rule($1, true, null)", [rule.v1]),
    ).toMatch(/reviewed by an accountant/);
    expect(await h.errorOf(PREP, "select public.review_tax_fixture($1, null)", [f])).toBe("42501"); // own fixture
    await reviewAll(rule.v1);
    expect(
      await h.messageOf(APPROVER, "select public.approve_tax_rule($1, false, null)", [rule.v1]),
    ).toMatch(/cited official sources/);
    await approve(rule.v1);
    const { rows } = await db.query<{ status: string; verified: string }>(
      "select status, sources_verified_by::text verified from public.tax_rules where id = $1",
      [rule.v1],
    );
    expect(rows[0]).toEqual({ status: "approved", verified: IDS.manager });
  });

  it("approved rules and their fixtures never change", async () => {
    let code: string | undefined;
    try {
      await db.query(`update public.tax_rules set params = '{"rate": "0.99"}' where id = $1`, [
        rule.v1,
      ]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
    expect(
      await h.errorOf(PREP, "select public.add_tax_fixture($1, $2::jsonb)", [
        rule.v1,
        JSON.stringify({
          name: "late",
          kind: "normal",
          as_of: "2026-03-01",
          basis: "x basis",
          inputs: { sales: "1", input_credit: "0", prior_excess: "0" },
          expected: { output_tax: "0.10" },
        }),
      ]),
    ).toBe("42501");
  });

  it("a new version takes over on its date; overlapping approvals are refused; regression passes across dates", async () => {
    rule.v2 = await propose(vatRule("0.11", "2026-07-01", null));
    await fixture(rule.v2, {
      name: "normal: July at 11%",
      kind: "normal",
      as_of: "2026-07-31",
      inputs: { sales: "10000", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "1100.00", payable: "1100.00" },
    });
    await fixture(rule.v2, {
      name: "boundary: first day of v2",
      kind: "boundary",
      as_of: "2026-07-01",
      inputs: { sales: "1", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "0.11", payable: "0.11" },
    });
    await h.run(AUTHOR, "select public.submit_tax_rule($1)", [rule.v2]);
    await reviewAll(rule.v2);
    await approve(rule.v2);

    const v3 = await propose(vatRule("0.12", "2026-09-01", null));
    await fixture(v3, {
      name: "normal",
      kind: "normal",
      as_of: "2026-09-30",
      inputs: { sales: "100", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "12.00", payable: "12.00" },
    });
    await fixture(v3, {
      name: "boundary",
      kind: "boundary",
      as_of: "2026-09-01",
      inputs: { sales: "1", input_credit: "0", prior_excess: "0" },
      expected: { output_tax: "0.12", payable: "0.12" },
    });
    await h.run(AUTHOR, "select public.submit_tax_rule($1)", [v3]);
    await reviewAll(v3);
    expect(
      await h.messageOf(APPROVER, "select public.approve_tax_rule($1, true, null)", [v3]),
    ).toMatch(/another approved version/);

    const reg = await h.read<{
      fixture_name: string;
      written_for: number;
      ran_with: number | null;
      passed: boolean;
    }>(
      AUTHOR,
      "select fixture_name, written_for, ran_with, passed from public.tax_regression('TEST_VAT')",
    );
    expect(reg).toHaveLength(6);
    for (const r of reg)
      expect(r, r.fixture_name).toMatchObject({ passed: true, ran_with: r.written_for });
  });

  it("graduated tables: values exactly on a bracket edge use the lower bracket", async () => {
    const g = await propose({
      code: "TEST_GRAD",
      name: "Synthetic graduated test rule",
      tax_type: "other",
      effective_from: "2026-01-01",
      inputs: [{ name: "taxable", label: "Taxable", source: "manual" }],
      params: {
        table: [
          { over: "0", fixed: "0", rate: "0" },
          { over: "250000", fixed: "0", rate: "0.15" },
          { over: "400000", fixed: "22500", rate: "0.20" },
        ],
      },
      formula: {
        steps: [{ name: "tax", expr: { graduated: { input: "taxable" }, table: "table" } }],
        outputs: ["tax"],
      },
      sources: SRC,
    });
    const cases: [string, string, string][] = [
      ["normal", "300000", "7500.00"],
      ["boundary", "250000", "0.00"],
      ["boundary", "250000.01", "0.00"], // 0.0015 rounds to 0.00
      ["boundary", "400000", "22500.00"],
      ["boundary", "400001", "22500.20"],
      ["boundary", "0", "0.00"],
    ];
    for (const [kind, taxable, tax] of cases)
      await fixture(g, {
        name: `${kind} ${taxable}`,
        kind,
        as_of: "2026-05-01",
        facts: {},
        inputs: { taxable },
        expected: { tax },
      });
    const res = await h.read<{ name: string; passed: boolean; actual: { tax: string } }>(
      AUTHOR,
      "select name, passed, actual from public.tax_rule_fixture_results($1)",
      [g],
    );
    expect(res.map((r) => [r.name, r.passed, r.actual.tax])).toEqual(
      cases.map(([k, t, tax]) => [`${k} ${t}`, true, tax]),
    );
  });
});

describe("computation: verified rules only, adjustments apart, lineage to sources", () => {
  it("is not applicable unless configured, and needs a confirmed profile, mappings and manual inputs", async () => {
    await entry("2026-03-05", [
      ["1100", "10000", ""],
      ["4010", "", "10000"],
    ]);
    await entry("2026-03-10", [
      ["6040", "3000", ""],
      ["1310", "300", ""],
      ["2010", "", "3300"],
    ]);
    await entry(
      "2026-03-12",
      [
        ["1100", "5000", ""],
        ["4010", "", "5000"],
      ],
      false,
    ); // draft: ignored
    const wrong = await entry("2026-03-20", [
      ["1100", "2000", ""],
      ["4010", "", "2000"],
    ]);
    await h.run(AUTHOR, "select public.reverse_entry($1, '2026-03-20'::date, 'error', $2)", [
      wrong,
      newKey(),
    ]);

    expect((await compute("2026-03-01", "2026-03-31")).status).toBe("not_applicable");
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_VAT', '2026-01-01'::date, null, 'monthly (test)')",
      [A],
    );
    expect(await compute("2026-03-01", "2026-03-31")).toMatchObject({
      status: "manual_review",
      reason: expect.stringMatching(/not confirmed/),
    });
    await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [A, JSON.stringify(VAT)]);
    expect(await h.errorOf(PREP, "select public.confirm_tax_profile($1)", [A])).toBe("42501");
    await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
    expect(await compute("2026-03-01", "2026-03-31")).toMatchObject({
      status: "manual_review",
      reason: expect.stringMatching(/map the input "sales"/),
    });
    const MAP = "select public.set_tax_input_mapping($1, 'TEST_VAT', $2, $3::uuid[], $4)";
    await h.run(PREP, MAP, [A, "sales", [acct["4010"]], "credit_minus_debit"]);
    await h.run(PREP, MAP, [A, "input_credit", [acct["1310"]], "debit_minus_credit"]);
    expect(await compute("2026-03-01", "2026-03-31")).toMatchObject({
      status: "manual_review",
      reason: expect.stringMatching(/prior_excess/),
    });
  });

  it("computes from posted entries plus separate adjustments, with lineage, and never touches the books", async () => {
    const before = (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.journal_entries where client_id = $1",
        [A],
      )
    ).rows[0].n;
    const r = await compute("2026-03-01", "2026-03-31", [
      {
        input: "prior_excess",
        amount: "200",
        reason: "Excess credit carried from February (test)",
        reference: "WP-02",
      },
    ]);
    // sales 10,000 (draft ignored, reversed sale nets out); output 1,000; payable 1,000 - 300 - 200
    expect(r).toMatchObject({
      status: "computed",
      outputs: { output_tax: "1000.00", payable: "500.00" },
    });
    const { rows } = await db.query<Record<string, unknown>>(
      "select ledger_inputs, adjustments, inputs from public.tax_computations where id = $1",
      [r.computation_id],
    );
    expect(rows[0]).toEqual({
      ledger_inputs: { sales: "10000.00", input_credit: "300.00" },
      adjustments: { prior_excess: "200" },
      inputs: { sales: "10000.00", input_credit: "300.00", prior_excess: "200" },
    });
    const lineage = await h.read<{ input_name: string; amount: string; n: number }>(
      AUTHOR,
      "select input_name, sum(amount)::text amount, count(*)::int n from public.tax_lineage where computation_id = $1 group by 1 order by 1",
      [r.computation_id],
    );
    expect(lineage).toEqual([
      { input_name: "input_credit", amount: "300.00", n: 1 },
      { input_name: "sales", amount: "10000.00", n: 3 }, // the sale, the reversed sale and its reversal
    ]);
    const after = (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.journal_entries where client_id = $1",
        [A],
      )
    ).rows[0].n;
    expect(after).toBe(before);
    expect(
      await h.errorOf(PREP, "select public.review_tax_computation($1, null)", [r.computation_id]),
    ).toBe("42501");
    await h.run(AUTHOR, "select public.review_tax_computation($1, 'agreed to workpapers')", [
      r.computation_id,
    ]);
    // recomputing the same period supersedes the earlier result; retries do not duplicate
    const key = newKey("again");
    const again = await compute(
      "2026-03-01",
      "2026-03-31",
      [{ input: "prior_excess", amount: "250", reason: "Corrected carry-over (test)" }],
      "TEST_VAT",
      key,
    );
    expect(again.outputs).toEqual({ output_tax: "1000.00", payable: "450.00" });
    expect((await compute("2026-03-01", "2026-03-31", [], "TEST_VAT", key)).computation_id).toBe(
      again.computation_id,
    );
    const st = await db.query<{ status: string }>(
      "select status from public.tax_computations where id = $1",
      [r.computation_id],
    );
    expect(st.rows[0].status).toBe("superseded");
    let code: string | undefined;
    try {
      await db.query(
        `update public.tax_computations set outputs = '{"payable": "0"}' where id = $1`,
        [again.computation_id],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("marks unverified or unclear scenarios instead of guessing", async () => {
    // the rule changes inside the period
    expect(
      await compute("2026-06-01", "2026-07-31", [
        { input: "prior_excess", amount: "1", reason: "test value" },
      ]),
    ).toMatchObject({
      status: "manual_review",
      reason: expect.stringMatching(/changed on 2026-07-01/),
    });
    // no approved rule at all for a configured obligation
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_NONE', '2026-01-01'::date, null, null)",
      [A],
    );
    expect(await compute("2026-03-01", "2026-03-31", [], "TEST_NONE")).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/no verified and approved rule/),
    });
    // a draft (unapproved) rule never computes
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_BAD', '2026-01-01'::date, null, null)",
      [A],
    );
    expect((await compute("2026-03-01", "2026-03-31", [], "TEST_BAD")).status).toBe("unsupported");
    // not eligible: a non-VAT profile (once confirmed)
    await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [
      A,
      JSON.stringify({ vat_status: "non_vat" }),
    ]);
    await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
    expect(
      await compute("2026-03-01", "2026-03-31", [
        { input: "prior_excess", amount: "1", reason: "test value" },
      ]),
    ).toMatchObject({
      status: "not_applicable",
      reason: expect.stringMatching(/not eligible under this rule \(vat_status\)/),
    });
    // a profile missing the fact the rule needs
    await h.run(PREP, "select public.set_tax_profile($1, '{}'::jsonb)", [A]);
    await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
    expect(
      await compute("2026-03-01", "2026-03-31", [
        { input: "prior_excess", amount: "1", reason: "test value" },
      ]),
    ).toMatchObject({
      status: "manual_review",
      reason: expect.stringMatching(/lacks the fact "vat_status"/),
    });
  });

  it("client users and other tenants see no tax data and cannot compute", async () => {
    for (const who of ["ownerA", "ownerB", "outsider", "firmAdmin"] as const)
      for (const t of [
        "tax_computations",
        "tax_lineage",
        "tax_adjustments",
        "tax_profiles",
        "tax_obligations",
      ])
        expect(
          await h.read(who, `select 1 from public.${t} where client_id = $1`, [A]),
          `${who} ${t}`,
        ).toEqual([]);
    expect(
      await h.errorOf(
        "ownerA",
        "select public.compute_tax($1, 'TEST_VAT', '2026-03-01'::date, '2026-03-31'::date, null, $2)",
        [A, newKey()],
      ),
    ).toBe("42501");
    expect(await h.read("ownerA", "select 1 from public.tax_rules")).toEqual([]);
  });
});
