/**
 * Phase 13 forms and workpapers (PGlite). Synthetic data.
 *
 * EVERYTHING HERE IS A SYNTHETIC "TEST ONLY" DEFINITION: TEST_R (a tax rule
 * at a made-up 10%) and TEST_FORM (a made-up form). No real BIR form exists in
 * the platform.
 *
 * TEST_FORM v1 (2026-01-01..06-30): TIN (fact), L1 = TEST_R input "sales",
 *   L2 = TEST_R output "tax", L3 = manual credits, L4 = max(L2 - L3, 0);
 *   warning CREDITS_EXCEED when L3 > L2; error NEGATIVE_BASE when L1 < 0;
 *   schedule SCH1 = the source lines behind "sales".
 * TEST_FORM v2 (from 2026-07-01): L4 = max(L2 - L3 - 10, 0).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const PREP = "accountantB" as const;
const AUTHOR = "reviewerA" as const;
const MANAGER = "manager" as const;
const acct: Record<string, string> = {};
const form: Record<string, string> = {};
let computation = "";
const SRC = [
  { citation: "TEST ONLY - synthetic form for automated tests", issued_on: "2026-01-01" },
];
const FACTS = { vat_status: "vat_registered", tin: "000-000-000-000" };

const definition = (minus: string) => ({
  lines: [
    { code: "TIN", label: "TIN", kind: "fact", fact: "tin" },
    { code: "L1", label: "Sales", kind: "tax_input", rule_code: "TEST_R", input: "sales" },
    { code: "L2", label: "Tax", kind: "tax_output", rule_code: "TEST_R", output: "tax" },
    { code: "L3", label: "Credits", kind: "manual" },
    {
      code: "L4",
      label: "Payable",
      kind: "formula",
      expr: {
        op: "max",
        args: [
          { op: "sub", args: [{ op: "sub", args: [{ input: "L2" }, { input: "L3" }] }, minus] },
          "0",
        ],
      },
    },
  ],
  schedules: [{ code: "SCH1", title: "Sales", rule_code: "TEST_R", input: "sales" }],
  validations: [
    {
      code: "CREDITS_EXCEED",
      severity: "warning",
      message: "Credits exceed the tax due",
      when: { cmp: "gt", args: [{ input: "L3" }, { input: "L2" }] },
    },
    {
      code: "NEGATIVE_BASE",
      severity: "error",
      message: "Sales cannot be negative",
      when: { cmp: "lt", args: [{ input: "L1" }, "0"] },
    },
  ],
});
const formJson = (from: string, to: string | null, minus = "0") => ({
  form_code: "TEST_FORM",
  title: "Synthetic test form",
  official_version: "TEST ONLY",
  frequency: "monthly",
  effective_from: from,
  effective_to: to,
  eligibility: [{ fact: "vat_status", op: "eq", value: "vat_registered" }],
  definition: definition(minus),
  sources: SRC,
  limitations: "Synthetic test form; not a BIR form. Export is a CSV workpaper only.",
});
const propose = async (j: unknown) =>
  (
    await h.run<{ id: string }>(AUTHOR, "select public.propose_tax_form($1::jsonb) as id", [
      JSON.stringify(j),
    ])
  )[0].id;
const fixture = (formId: string, f: Record<string, unknown>) =>
  h.run(PREP, "select public.add_form_fixture($1, $2::jsonb)", [
    formId,
    JSON.stringify({ basis: "Hand-worked from the synthetic test form", facts: FACTS, ...f }),
  ]);
async function reviewAll(formId: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.tax_form_fixtures where form_id = $1",
    [formId],
  );
  for (const r of rows) await h.run(AUTHOR, "select public.review_form_fixture($1)", [r.id]);
}
const given = (l1: string, l2: string, l3: string) => ({ TIN: "x", L1: l1, L2: l2, L3: l3 });
const prepare = (manual: unknown[] = [], overrides: unknown[] = [], key = newKey("wp")) =>
  h
    .run<{ r: { workpaper_id: string; status: string; reason: string | null } }>(
      PREP,
      "select public.prepare_workpaper($1, 'TEST_FORM', '2026-03-01'::date, '2026-03-31'::date, $2::jsonb, $3::jsonb, $4) as r",
      [A, JSON.stringify(manual), JSON.stringify(overrides), key],
    )
    .then((rows) => rows[0].r);
const workpaper = async (id: string) =>
  (
    await db.query<{
      status: string;
      lines: Record<string, string>;
      line_sources: Record<string, Record<string, unknown>>;
      messages: { code: string; severity: string }[];
    }>("select status, lines, line_sources, messages from public.tax_workpapers where id = $1", [
      id,
    ])
  ).rows[0];

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

  // A synthetic approved tax rule and a reviewed computation for March.
  const [{ id: rule }] = await h.run<{ id: string }>(
    AUTHOR,
    "select public.propose_tax_rule($1::jsonb) as id",
    [
      JSON.stringify({
        code: "TEST_R",
        name: "Synthetic test rule",
        tax_type: "other",
        effective_from: "2026-01-01",
        inputs: [{ name: "sales", source: "ledger" }],
        params: { rate: "0.10" },
        formula: {
          steps: [
            {
              name: "tax",
              expr: { round: { op: "mul", args: [{ input: "sales" }, { param: "rate" }] } },
            },
          ],
          outputs: ["tax"],
        },
        sources: SRC,
      }),
    ],
  );
  for (const [name, kind, sales, tax] of [
    ["normal", "normal", "100", "10.00"],
    ["boundary", "boundary", "0.05", "0.01"],
  ])
    await h.run(PREP, "select public.add_tax_fixture($1, $2::jsonb)", [
      rule,
      JSON.stringify({
        name,
        kind,
        as_of: "2026-03-01",
        basis: "synthetic",
        inputs: { sales },
        expected: { tax },
      }),
    ]);
  await h.run(AUTHOR, "select public.submit_tax_rule($1)", [rule]);
  for (const r of (
    await db.query<{ id: string }>("select id from public.tax_rule_fixtures where rule_id = $1", [
      rule,
    ])
  ).rows)
    await h.run(AUTHOR, "select public.review_tax_fixture($1, null)", [r.id]);
  await h.run(MANAGER, "select public.approve_tax_rule($1, true, null)", [rule]);

  await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [A, JSON.stringify(FACTS)]);
  await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
  await h.run(
    PREP,
    "select public.add_tax_obligation($1, 'TEST_R', '2026-01-01'::date, null, null)",
    [A],
  );
  await h.run(
    PREP,
    "select public.set_tax_input_mapping($1, 'TEST_R', 'sales', $2::uuid[], 'credit_minus_debit')",
    [A, [acct["4010"]]],
  );
  const [{ id: je }] = await h.run<{ id: string }>(
    PREP,
    "select public.save_draft_entry($1, null, '2026-03-05'::date, 'general', 'sale', null, null, $2, $3::jsonb) as id",
    [
      A,
      newKey(),
      JSON.stringify([
        { account_id: acct["1100"], debit: "10000", credit: "" },
        { account_id: acct["4010"], debit: "", credit: "10000" },
      ]),
    ],
  );
  await h.run(PREP, "select public.submit_entry($1)", [je]);
  await h.run(AUTHOR, "select public.approve_and_post($1)", [je]);
  const [{ r }] = await h.run<{ r: { computation_id: string } }>(
    PREP,
    "select public.compute_tax($1, 'TEST_R', '2026-03-01'::date, '2026-03-31'::date, '[]'::jsonb, $2) as r",
    [A, newKey()],
  );
  computation = r.computation_id; // computed, NOT yet reviewed
}, 60_000);

describe("form definitions: verified, then signed off before production", () => {
  it("only reviewers/managers enter definitions; definitions are checked", async () => {
    const P = "select public.propose_tax_form($1::jsonb)";
    expect(await h.errorOf(PREP, P, [JSON.stringify(formJson("2026-01-01", null))])).toBe("42501");
    const bad = (lines: unknown[]) =>
      JSON.stringify({ ...formJson("2026-01-01", null), definition: { lines } });
    expect(
      await h.messageOf(AUTHOR, P, [bad([{ code: "A", label: "Line A", kind: "magic" }])]),
    ).toMatch(/unknown kind magic/);
    expect(
      await h.messageOf(AUTHOR, P, [
        bad([
          { code: "A", label: "Line A", kind: "formula", expr: { input: "B" } },
          { code: "B", label: "Line B", kind: "manual" },
        ]),
      ]),
    ).toMatch(/undeclared input B/); // formulas may only use earlier lines
  });

  it("approval needs passing, accountant-reviewed normal and boundary fixtures", async () => {
    form.v1 = await propose(formJson("2026-01-01", "2026-06-30"));
    expect(await h.messageOf(AUTHOR, "select public.submit_tax_form($1)", [form.v1])).toMatch(
      /normal and one boundary/,
    );
    await fixture(form.v1, {
      name: "normal",
      kind: "normal",
      as_of: "2026-03-31",
      given: given("10000", "1000.00", "300"),
      expected: { lines: { L4: "700.00" }, messages: [] },
    });
    await fixture(form.v1, {
      name: "credits equal tax: no warning",
      kind: "boundary",
      as_of: "2026-03-31",
      given: given("10000", "1000.00", "1000"),
      expected: { lines: { L4: "0.00" }, messages: [] },
    });
    await fixture(form.v1, {
      name: "credits exceed tax by 0.01",
      kind: "boundary",
      as_of: "2026-01-01",
      given: given("10000", "1000.00", "1000.01"),
      expected: { lines: { L4: "0.00" }, messages: ["CREDITS_EXCEED"] },
    });
    await fixture(form.v1, {
      name: "negative sales is an error",
      kind: "boundary",
      as_of: "2026-06-30",
      given: given("-1", "0", "0"),
      expected: { lines: { L4: "0.00" }, messages: ["NEGATIVE_BASE"] },
    });
    await fixture(form.v1, {
      name: "non-VAT is not applicable",
      kind: "boundary",
      as_of: "2026-03-31",
      facts: { vat_status: "non_vat" },
      given: given("1", "0", "0"),
      expected: { lines: {}, messages: ["NOT_APPLICABLE"] },
    });
    await h.run(AUTHOR, "select public.submit_tax_form($1)", [form.v1]);
    expect(
      await h.errorOf(AUTHOR, "select public.approve_tax_form($1, true, null)", [form.v1]),
    ).toBe("42501");
    expect(
      await h.messageOf(MANAGER, "select public.approve_tax_form($1, true, null)", [form.v1]),
    ).toMatch(/reviewed by an accountant/);
    await reviewAll(form.v1);
    expect(
      await h.messageOf(MANAGER, "select public.approve_tax_form($1, false, null)", [form.v1]),
    ).toMatch(/official form/);
    await h.run(
      MANAGER,
      "select public.approve_tax_form($1, true, 'checked against the test form')",
      [form.v1],
    );
  });

  it("a failing fixture blocks submission", async () => {
    const bad = await propose({ ...formJson("2027-01-01", null), form_code: "TEST_BADFORM" });
    await fixture(bad, {
      name: "normal",
      kind: "normal",
      as_of: "2027-01-31",
      given: given("10", "1", "0"),
      expected: { lines: { L4: "1.00" } },
    });
    await fixture(bad, {
      name: "wrong",
      kind: "boundary",
      as_of: "2027-01-31",
      given: given("10", "1", "0"),
      expected: { lines: { L4: "2.00" } },
    });
    expect(await h.messageOf(AUTHOR, "select public.submit_tax_form($1)", [bad])).toMatch(
      /fixtures do not pass: wrong/,
    );
  });

  it("approved is not enough: production needs a documented manager sign-off", async () => {
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_FORM', '2026-01-01'::date, null, null)",
      [A],
    );
    expect(
      await prepare([{ line: "L3", value: "300", reason: "credits per workpaper (test)" }]),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/no form version is enabled/),
    });
    const EN = "select public.enable_tax_form($1, $2, $3)";
    expect(
      await h.errorOf(AUTHOR, EN, [
        form.v1,
        "I reviewed the form computations against the official form",
        "WP folder 1",
      ]),
    ).toBe("42501");
    // not a manager (and not the author): refused
    expect(
      await h.errorOf(PREP, EN, [
        form.v1,
        "I reviewed the form computations against the official form",
        "WP 1",
      ]),
    ).toBe("42501");
    expect(await h.errorOf(MANAGER, EN, [form.v1, "ok", "x"])).toBe("22023");
    await h.run(MANAGER, EN, [
      form.v1,
      "I reviewed every line and the fixtures against the official form and instructions.",
      "Synthetic test evidence ref T-1",
    ]);
    let code: string | undefined;
    try {
      await db.query(`update public.tax_forms set definition = '{}' where id = $1`, [form.v1]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });
});

describe("workpapers: traceable lines, validations, authorized edits, sign-off", () => {
  it("lines trace to the tax computation and its sources; an unreviewed computation blocks sign-off", async () => {
    const r = await prepare([
      { line: "L3", value: "300", reason: "Credits per prior return (test)", reference: "WP-3" },
    ]);
    expect(r.status).toBe("prepared");
    let w = await workpaper(r.workpaper_id);
    expect(w.lines).toEqual({
      TIN: "000-000-000-000",
      L1: "10000.00",
      L2: "1000.00",
      L3: "300",
      L4: "700.00",
    });
    expect(w.line_sources.L2).toMatchObject({
      kind: "tax_output",
      rule_code: "TEST_R",
      computation_id: computation,
      computation_status: "computed",
    });
    expect(w.line_sources.L4).toMatchObject({ kind: "formula", depends_on: ["L2", "L3"] });
    expect(w.messages.map((m) => m.code)).toEqual(["UNREVIEWED:L1", "UNREVIEWED:L2"]);
    expect(
      await h.messageOf(AUTHOR, "select public.sign_off_workpaper($1, 'Checked all lines')", [
        r.workpaper_id,
      ]),
    ).toMatch(/validation errors/);

    await h.run(AUTHOR, "select public.review_tax_computation($1, null)", [computation]);
    const ok = await prepare([
      { line: "L3", value: "300", reason: "Credits per prior return (test)" },
    ]);
    w = await workpaper(ok.workpaper_id);
    expect(w.messages).toEqual([]);
    expect((await workpaper(r.workpaper_id)).status).toBe("superseded");
    const sched = await h.read<{ schedule_code: string; amount: string; entry_date: string }>(
      AUTHOR,
      "select schedule_code, amount, entry_date::text from public.workpaper_schedule($1)",
      [ok.workpaper_id],
    );
    expect(sched).toEqual([
      { schedule_code: "SCH1", amount: "10000.00", entry_date: "2026-03-05" },
    ]);

    expect(
      await h.errorOf(PREP, "select public.sign_off_workpaper($1, 'Checked all lines carefully')", [
        ok.workpaper_id,
      ]),
    ).toBe("42501");
    await h.run(
      AUTHOR,
      "select public.sign_off_workpaper($1, 'Checked all lines against the books and schedules')",
      [ok.workpaper_id],
    );
    expect((await workpaper(ok.workpaper_id)).status).toBe("signed_off");
    const ev = await h.read<{ event: string }>(
      AUTHOR,
      "select event from public.tax_workpaper_events where workpaper_id = $1 order by id",
      [ok.workpaper_id],
    );
    expect(ev.map((e) => e.event)).toEqual(["prepared", "signed_off"]);
  });

  it("overrides need a reason, are recorded with the computed value, and raise a warning; formulas cannot be overridden", async () => {
    const r = await prepare(
      [{ line: "L3", value: "300", reason: "Credits per prior return (test)" }],
      [{ line: "L2", value: "1100", reason: "Adjusted per CPA memo (test)", reference: "MEMO-9" }],
    );
    const w = await workpaper(r.workpaper_id);
    expect(w.lines.L4).toBe("800.00"); // formulas use the overridden source
    expect(w.messages).toEqual([
      expect.objectContaining({ code: "OVERRIDDEN:L2", severity: "warning" }),
    ]);
    const { rows } = await db.query<{ kind: string; value: string; computed: string }>(
      "select kind, value::text, computed::text from public.tax_workpaper_entries where workpaper_id = $1 order by kind",
      [r.workpaper_id],
    );
    expect(rows).toEqual([
      { kind: "manual", value: "300.00", computed: null },
      { kind: "override", value: "1100.00", computed: "1000.00" },
    ]);
    const W =
      "select public.prepare_workpaper($1, 'TEST_FORM', '2026-03-01'::date, '2026-03-31'::date, $2::jsonb, $3::jsonb, $4)";
    expect(
      await h.errorOf(PREP, W, [
        A,
        "[]",
        JSON.stringify([{ line: "L4", value: "1", reason: "not allowed here" }]),
        newKey(),
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf(PREP, W, [
        A,
        JSON.stringify([{ line: "L3", value: "1", reason: "" }]),
        "[]",
        newKey(),
      ]),
    ).toBe("22023");
    let code: string | undefined;
    try {
      await db.query(`update public.tax_workpapers set lines = '{}' where id = $1`, [
        r.workpaper_id,
      ]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("missing manual lines are validation errors; ineligible clients get not applicable", async () => {
    const r = await prepare();
    expect((await workpaper(r.workpaper_id)).messages.map((m) => m.code)).toContain("MISSING:L3");
    await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [
      A,
      JSON.stringify({ ...FACTS, vat_status: "non_vat" }),
    ]);
    await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
    expect(await prepare([{ line: "L3", value: "1", reason: "test value" }])).toMatchObject({
      status: "not_applicable",
    });
    await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [A, JSON.stringify(FACTS)]);
    await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
  });
});

describe("regression across form versions", () => {
  it("v2 takes over on its date; every fixture still passes with the version in effect", async () => {
    form.v2 = await propose(formJson("2026-07-01", null, "10"));
    await fixture(form.v2, {
      name: "v2 normal",
      kind: "normal",
      as_of: "2026-07-31",
      given: given("10000", "1000.00", "300"),
      expected: { lines: { L4: "690.00" }, messages: [] },
    });
    await fixture(form.v2, {
      name: "v2 first day",
      kind: "boundary",
      as_of: "2026-07-01",
      given: given("10000", "1000.00", "990"),
      expected: { lines: { L4: "0.00" }, messages: [] },
    });
    await h.run(AUTHOR, "select public.submit_tax_form($1)", [form.v2]);
    await reviewAll(form.v2);
    await h.run(MANAGER, "select public.approve_tax_form($1, true, null)", [form.v2]);
    const reg = await h.read<{
      fixture_name: string;
      written_for: number;
      ran_with: number;
      passed: boolean;
    }>(
      AUTHOR,
      "select fixture_name, written_for, ran_with, passed from public.form_regression('TEST_FORM')",
    );
    expect(reg).toHaveLength(7);
    for (const r of reg)
      expect(r, r.fixture_name).toMatchObject({ passed: true, ran_with: r.written_for });
  });

  it("clients and other tenants see no workpapers or form registry", async () => {
    for (const who of ["ownerA", "ownerB", "outsider"] as const) {
      expect(
        await h.read(who, "select 1 from public.tax_workpapers where client_id = $1", [A]),
      ).toEqual([]);
      expect(await h.read(who, "select 1 from public.tax_forms")).toEqual([]);
    }
  });
});
