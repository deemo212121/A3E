/**
 * Phase 16 END-TO-END lifecycle (PGlite). Synthetic data only.
 *
 * One month (March 2026) of synthetic client A, driven through every layer
 * with the real roles and maker-checker steps:
 *
 *   client submits a sale (intake) -> staff review -> reviewer approves
 *   -> sales invoice from the intake -> posted to the ledger
 *   -> customer receipt -> posted
 *   -> trial balance, statements and AR reconciliation agree
 *   -> TEST_R tax computation from the ledger -> reviewed; regression passes
 *   -> TEST_FORM workpaper -> signed off
 *   -> TEST_SLS export generated from posted invoices -> official (synthetic)
 *      validation of that exact file -> signed off
 *   -> filing: prepared (workpaper) -> reviewed/approved -> exported (the
 *      validated file) -> filing confirmed.
 * Each step is also retried to prove nothing is duplicated.
 *
 * TEST_R, TEST_FORM and TEST_SLS are SYNTHETIC "TEST ONLY" definitions (a
 * made-up 10% rule, form and file layout). The platform ships with no real
 * tax rules, forms or file layouts, so no real BIR output can be tested yet.
 *
 * Hand-worked figures: one VAT-inclusive sale of 112.00 = 100.00 vatable +
 * 12.00 VAT; collected in full. TEST_R tax = 10% of sales (4010) = 10.00.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const CLIENT = "ownerA" as const;
const PREP = "accountantB" as const;
const REV = "reviewerA" as const;
const MGR = "manager" as const;
const FACTS = { vat_status: "vat_registered", tin: "123-456-789-000" };
const SRC = [
  { citation: "TEST ONLY - synthetic definition for automated tests", issued_on: "2026-01-01" },
];
const acct: Record<string, string> = {};
const ids: Record<string, string> = {};
const CRLF = "\r\n";
const FILE =
  [
    "H,123456789000,03/2026",
    "D,1,777888999000,SAMPLE HARDWARE INC.,100.00,12.00",
    "C,1,100.00,12.00",
  ].join(CRLF) + CRLF;

const one = async <T extends Record<string, unknown>>(
  who: Parameters<typeof h.run>[0],
  sql: string,
  params: unknown[] = [],
) => (await h.run<T>(who, sql, params))[0];
const sql1 = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  await h.run(REV, "select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
  await h.run(REV, "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
  await h.run(REV, "select public.apply_default_sales_settings($1)", [A]);
  for (const r of (
    await db.query<{ id: string; code: string }>(
      "select id, code from public.accounts where client_id = $1",
      [A],
    )
  ).rows)
    acct[r.code] = r.id;
}, 120_000);

describe("end-to-end: client submission to filing confirmation", () => {
  it("1. the client submits a sale once, even when the request is retried", async () => {
    const [c] = await h.run<{ id: string }>(
      PREP,
      "select public.save_counterparty($1, null, null, $2::jsonb, $3) as id",
      [
        A,
        JSON.stringify({
          kind: "customer",
          registered_name: "Sample Hardware Inc.",
          tin: "777888999000",
        }),
        newKey(),
      ],
    );
    await h.run(PREP, "select public.transition_counterparty($1, 'submitted')", [c.id]);
    await h.run(PREP, "select public.transition_counterparty($1, 'approved')", [c.id]);
    ids.customer = c.id;

    const key = newKey("e2e-txn");
    const header = {
      kind: "sale",
      txn_date: "2026-03-05",
      document_ref: "SI-E2E-1",
      counterparty_name: "Sample Hardware Inc.",
      gross_amount: "112.00",
    };
    ids.txn = await h.saveTxn(CLIENT, A, header, { key });
    expect(await h.saveTxn(CLIENT, A, header, { key })).toBe(ids.txn); // retry
    await h.transitionTxn(CLIENT, ids.txn, "submitted");
    await h.transitionTxn(CLIENT, ids.txn, "submitted"); // retry is a no-op
    await h.transitionTxn(PREP, ids.txn, "reviewed");
    expect(await h.transitionTxnError(CLIENT, ids.txn, "approved")).toBe("42501"); // the client cannot approve
    expect(await h.transitionTxnError(PREP, ids.txn, "approved")).toBe("42501"); // preparer cannot approve
    await h.transitionTxn(REV, ids.txn, "approved");
    const n = await sql1<{ n: number }>(
      "select count(*)::int n from public.intake_transactions where client_id = $1",
      [A],
    );
    expect(n.n).toBe(1);
  });

  it("2. the approved submission becomes an invoice and is posted once (maker-checker)", async () => {
    const key = newKey("inv");
    const save = () =>
      one<{ id: string }>(
        PREP,
        "select public.save_sales_invoice($1, null, null, $2::jsonb, $3::jsonb, $4) as id",
        [
          A,
          JSON.stringify({
            counterparty_id: ids.customer,
            invoice_no: "SI-E2E-1",
            invoice_date: "2026-03-05",
            due_date: "2026-04-04",
            sale_type: "credit",
            intake_transaction_id: ids.txn,
            prices_include_vat: true,
          }),
          JSON.stringify([
            { description: "Goods", quantity: "1", unit_price: "112", tax_class: "vatable" },
          ]),
          key,
        ],
      );
    ids.invoice = (await save()).id;
    expect((await save()).id).toBe(ids.invoice); // retried save
    await h.run(PREP, "select public.submit_sales_document('sales_invoice', $1)", [ids.invoice]);
    expect(await h.errorOf(PREP, "select public.post_sales_invoice($1)", [ids.invoice])).toBe(
      "42501",
    );
    ids.invoiceJe = (
      await one<{ je: string }>(REV, "select public.post_sales_invoice($1) as je", [ids.invoice])
    ).je;
    // posting again does not post twice
    await h.errorOf(REV, "select public.post_sales_invoice($1)", [ids.invoice]);
    const entries = await sql1<{ n: number }>(
      "select count(*)::int n from public.journal_entries where client_id = $1 and status = 'posted'",
      [A],
    );
    expect(entries.n).toBe(1);
    const lines = (
      await db.query<{ code: string; debit: string; credit: string }>(
        `select a.code, l.debit::text, l.credit::text from public.journal_lines l
           join public.accounts a on a.id = l.account_id where l.entry_id = $1 order by l.line_no`,
        [ids.invoiceJe],
      )
    ).rows.map((r) => [r.code, r.debit, r.credit]);
    expect(lines).toEqual([
      ["1100", "112.00", "0.00"],
      ["4010", "0.00", "100.00"],
      ["2100", "0.00", "12.00"],
    ]);
    expect(await h.txn(ids.txn)).toMatchObject({
      status: "posted",
      journal_entry_id: ids.invoiceJe,
    });
  });

  it("3. the customer pays; the receipt is posted", async () => {
    const [r] = await h.run<{ id: string }>(
      PREP,
      "select public.save_sales_receipt($1, null, null, $2::jsonb, $3::jsonb, $4) as id",
      [
        A,
        JSON.stringify({
          counterparty_id: ids.customer,
          receipt_no: "OR-E2E-1",
          receipt_date: "2026-03-20",
          payment_method: "check",
          deposit_account_id: acct["1020"],
          amount_received: "112.00",
        }),
        JSON.stringify([{ invoice_id: ids.invoice, amount: "112.00" }]),
        newKey("rc"),
      ],
    );
    await h.run(PREP, "select public.submit_sales_document('sales_receipt', $1)", [r.id]);
    await h.run(REV, "select public.post_sales_receipt($1)", [r.id]);
  });

  it("4. the books balance and reconcile; statements agree with the ledger", async () => {
    const tb = await h.read<{
      code: string;
      total_debit: string;
      total_credit: string;
      balance: string;
    }>(
      REV,
      "select code, total_debit, total_credit, balance from public.trial_balance($1, '2026-03-31'::date) where total_debit::numeric <> 0 or total_credit::numeric <> 0 order by code",
      [A],
    );
    const sum = (k: "total_debit" | "total_credit") =>
      tb.reduce((s, r) => s + Math.round(Number(r[k]) * 100), 0);
    expect(sum("total_debit")).toBe(sum("total_credit"));
    expect(Object.fromEntries(tb.map((r) => [r.code, r.balance]))).toEqual({
      "1020": "112.00",
      "1100": "0.00",
      "2100": "12.00",
      "4010": "100.00",
    });
    expect(
      await h.read(REV, "select * from public.ar_reconciliation($1, '2026-03-31'::date)", [A]),
    ).toEqual([{ subledger_total: "0.00", ledger_balance: "0.00", difference: "0.00" }]);
    // every posted entry balances (database invariant, checked again here)
    const unbalanced = await db.query(
      `select e.id from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
        where e.client_id = $1 and e.status in ('posted','reversed') group by e.id having sum(l.debit) <> sum(l.credit)`,
      [A],
    );
    expect(unbalanced.rows).toEqual([]);
    // the statement read model agrees with the trial balance
    const rb = await h.read<{ code: string; period_debit: string; period_credit: string }>(
      REV,
      "select code, period_debit, period_credit from public.report_account_balances($1, '2026-03-01'::date, '2026-03-31'::date) where period_debit::numeric <> 0 or period_credit::numeric <> 0 order by code",
      [A],
    );
    const tbNet = Object.fromEntries(
      tb.map((r) => [r.code, (Number(r.total_debit) - Number(r.total_credit)).toFixed(2)]),
    );
    for (const r of rb)
      expect((Number(r.period_debit) - Number(r.period_credit)).toFixed(2), r.code).toBe(
        tbNet[r.code],
      );
    expect(rb.map((r) => r.code)).toEqual(tb.map((r) => r.code));
  });

  it("5. tax: an approved (synthetic) rule computes from the ledger; reviewed; regression passes", async () => {
    const [{ id: rule }] = await h.run<{ id: string }>(
      REV,
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
    await h.run(REV, "select public.submit_tax_rule($1)", [rule]);
    for (const r of (
      await db.query<{ id: string }>("select id from public.tax_rule_fixtures where rule_id = $1", [
        rule,
      ])
    ).rows)
      await h.run(REV, "select public.review_tax_fixture($1, null)", [r.id]);
    await h.run(MGR, "select public.approve_tax_rule($1, true, null)", [rule]);

    await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [A, JSON.stringify(FACTS)]);
    await h.run(REV, "select public.confirm_tax_profile($1)", [A]);
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
    const key = newKey("tax");
    const compute = () =>
      one<{ r: { computation_id: string; status: string } }>(
        PREP,
        "select public.compute_tax($1, 'TEST_R', '2026-03-01'::date, '2026-03-31'::date, '[]'::jsonb, $2) as r",
        [A, key],
      );
    const c = (await compute()).r;
    expect((await compute()).r.computation_id).toBe(c.computation_id); // retry
    ids.computation = c.computation_id;
    const comp = await sql1<{
      status: string;
      outputs: Record<string, string>;
      inputs: Record<string, string>;
    }>("select status, outputs, inputs from public.tax_computations where id = $1", [
      c.computation_id,
    ]);
    expect(comp.status).toBe("computed");
    expect(comp.inputs.sales).toBe("100.00"); // from the ledger: 4010
    expect(comp.outputs.tax).toBe("10.00");
    expect(
      await h.errorOf(PREP, "select public.review_tax_computation($1, null)", [c.computation_id]),
    ).toBe("42501");
    await h.run(REV, "select public.review_tax_computation($1, null)", [c.computation_id]);
    const reg = await h.read<{ passed: boolean }>(
      REV,
      "select passed from public.tax_regression('TEST_R')",
    );
    expect(reg.length).toBeGreaterThan(0);
    expect(reg.every((r) => r.passed)).toBe(true);
  });

  it("6. the (synthetic) form workpaper traces to the computation and is signed off", async () => {
    const def = {
      lines: [
        { code: "TIN", label: "TIN", kind: "fact", fact: "tin" },
        { code: "L1", label: "Sales", kind: "tax_input", rule_code: "TEST_R", input: "sales" },
        { code: "L2", label: "Tax", kind: "tax_output", rule_code: "TEST_R", output: "tax" },
        { code: "L3", label: "Credits", kind: "manual" },
        {
          code: "L4",
          label: "Payable",
          kind: "formula",
          expr: { op: "max", args: [{ op: "sub", args: [{ input: "L2" }, { input: "L3" }] }, "0"] },
        },
      ],
      schedules: [{ code: "SCH1", title: "Sales", rule_code: "TEST_R", input: "sales" }],
      validations: [],
    };
    const [{ id: form }] = await h.run<{ id: string }>(
      REV,
      "select public.propose_tax_form($1::jsonb) as id",
      [
        JSON.stringify({
          form_code: "TEST_FORM",
          title: "Synthetic test form",
          official_version: "TEST ONLY",
          frequency: "monthly",
          effective_from: "2026-01-01",
          effective_to: null,
          eligibility: [{ fact: "vat_status", op: "eq", value: "vat_registered" }],
          definition: def,
          sources: SRC,
          limitations: "Synthetic test form; not a BIR form.",
        }),
      ],
    );
    const given = (l1: string, l2: string, l3: string) => ({ TIN: "x", L1: l1, L2: l2, L3: l3 });
    for (const [name, kind, g, l4] of [
      ["normal", "normal", given("100", "10.00", "3"), "7.00"],
      ["credits equal tax", "boundary", given("100", "10.00", "10"), "0.00"],
    ] as const)
      await h.run(PREP, "select public.add_form_fixture($1, $2::jsonb)", [
        form,
        JSON.stringify({
          basis: "synthetic",
          facts: FACTS,
          name,
          kind,
          as_of: "2026-03-31",
          given: g,
          expected: { lines: { L4: l4 }, messages: [] },
        }),
      ]);
    await h.run(REV, "select public.submit_tax_form($1)", [form]);
    for (const r of (
      await db.query<{ id: string }>("select id from public.tax_form_fixtures where form_id = $1", [
        form,
      ])
    ).rows)
      await h.run(REV, "select public.review_form_fixture($1)", [r.id]);
    await h.run(
      MGR,
      "select public.approve_tax_form($1, true, 'checked against the synthetic form')",
      [form],
    );
    // the manager approved; a different manager-level sign-off is not available
    // in the fixture, so the enabling manager must not be the author (reviewerA)
    await h.run(MGR, "select public.enable_tax_form($1, $2, $3)", [
      form,
      "Reviewed the synthetic form computations line by line",
      "Synthetic evidence E2E-1",
    ]);
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_FORM', '2026-01-01'::date, null, null)",
      [A],
    );
    const key = newKey("wp");
    const prep = () =>
      one<{ r: { workpaper_id: string; status: string } }>(
        PREP,
        "select public.prepare_workpaper($1, 'TEST_FORM', '2026-03-01'::date, '2026-03-31'::date, $2::jsonb, '[]'::jsonb, $3) as r",
        [
          A,
          JSON.stringify([{ line: "L3", value: "0", reason: "No credits this month (synthetic)" }]),
          key,
        ],
      );
    const w = (await prep()).r;
    expect((await prep()).r.workpaper_id).toBe(w.workpaper_id); // retry
    expect(w).toMatchObject({ status: "prepared" });
    ids.workpaper = w.workpaper_id;
    const wp = await sql1<{ lines: Record<string, string> }>(
      "select lines from public.tax_workpapers where id = $1",
      [w.workpaper_id],
    );
    expect(wp.lines).toMatchObject({ L1: "100.00", L2: "10.00", L4: "10.00" });
    expect(
      await h.errorOf(PREP, "select public.sign_off_workpaper($1, 'Checked all lines carefully')", [
        w.workpaper_id,
      ]),
    ).toBe("42501");
    await h.run(
      REV,
      "select public.sign_off_workpaper($1, 'Checked all lines against the books and schedules')",
      [w.workpaper_id],
    );
  });

  it("7. the (synthetic) export file is generated, validated for that exact file, reconciled and signed off", async () => {
    const layout = {
      format: "delimited",
      delimiter: ",",
      quote: "none",
      encoding: "ascii",
      line_end: "crlf",
      final_newline: true,
      filename: "{fact.tin:digits}S{period.to:MMYYYY}.DAT",
      filename_pattern: "^[0-9]{12}S[0-9]{6}\\.DAT$",
      group_by: ["customer_tin", "customer_name"],
      sums: ["vatable", "vat"],
      order_by: ["customer_tin"],
      unique_keys: ["customer_tin"],
      records: [
        {
          record: "header",
          fields: [
            { name: "type", from: "const", value: "H" },
            {
              name: "tin",
              from: "fact.tin",
              digits: true,
              length: 12,
              required: true,
              pattern: "^[0-9]{12}$",
            },
            { name: "period", from: "period.to", type: "date", date_format: "MM/YYYY" },
          ],
        },
        {
          record: "detail",
          fields: [
            { name: "type", from: "const", value: "D" },
            { name: "seq", from: "seq" },
            { name: "tin", from: "row.customer_tin", digits: true, length: 12, required: true },
            { name: "name", from: "row.customer_name", upper: true, length: 20, required: true },
            { name: "vatable", from: "row.vatable", type: "number", decimals: 2, unsigned: true },
            { name: "vat", from: "row.vat", type: "number", decimals: 2 },
          ],
        },
        {
          record: "control",
          fields: [
            { name: "type", from: "const", value: "C" },
            { name: "count", from: "count" },
            { name: "vatable", from: "sum.vatable", type: "number", decimals: 2 },
            { name: "vat", from: "sum.vat", type: "number", decimals: 2 },
          ],
        },
      ],
    };
    const [{ id: spec }] = await h.run<{ id: string }>(
      REV,
      "select public.propose_output_spec($1::jsonb) as id",
      [
        JSON.stringify({
          output_code: "TEST_SLS",
          output_type: "other",
          title: "Synthetic test layout",
          spec_source: {
            citation: "TEST ONLY - synthetic layout",
            spec_version: "T1",
            issued_on: "2026-01-01",
          },
          official_tool: "TEST VALIDATOR",
          official_tool_version: "1.0",
          effective_from: "2026-01-01",
          dataset: "sales_by_invoice",
          layout,
          limitations: "Synthetic test layout; not a BIR file.",
        }),
      ],
    );
    const row = {
      customer_tin: "777-888-999-000",
      customer_name: "Sample Hardware Inc.",
      vatable: "100.00",
      vat: "12.00",
    };
    for (const [name, kind, rows] of [
      ["normal", "normal", [row]],
      ["same rows reversed", "boundary", [row]],
    ] as const)
      await h.run(PREP, "select public.add_output_fixture($1, $2::jsonb)", [
        spec,
        JSON.stringify({
          basis: "Hand-worked",
          as_of: "2026-03-31",
          period_from: "2026-03-01",
          period_to: "2026-03-31",
          facts: FACTS,
          name,
          kind,
          rows,
          expected_content: FILE,
        }),
      ]);
    await h.run(REV, "select public.submit_output_spec($1)", [spec]);
    for (const r of (
      await db.query<{ id: string }>(
        "select id from public.output_spec_fixtures where spec_id = $1",
        [spec],
      )
    ).rows)
      await h.run(REV, "select public.review_output_fixture($1)", [r.id]);
    await h.run(MGR, "select public.approve_output_spec($1, true, null)", [spec]);
    await h.run(MGR, "select public.enable_output_spec($1, $2, $3)", [
      spec,
      "Compliance review: layout matches the synthetic spec field by field.",
      "Synthetic evidence E2E-2",
    ]);
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_SLS', '2026-01-01'::date, null, null)",
      [A],
    );

    const key = newKey("out");
    const gen = () =>
      one<{ r: { run_id: string; status: string; precheck_passed: boolean } }>(
        PREP,
        "select public.generate_output($1, 'TEST_SLS', '2026-03-01'::date, '2026-03-31'::date, $2) as r",
        [A, key],
      );
    const g = (await gen()).r;
    expect((await gen()).r.run_id).toBe(g.run_id); // retry
    expect(g).toMatchObject({ status: "generated", precheck_passed: true });
    const run = await sql1<{
      content: string;
      content_sha256: string;
      filename: string;
      reconciliation: { passed: boolean }[];
    }>(
      "select content, content_sha256, filename, reconciliation from public.output_runs where id = $1",
      [g.run_id],
    );
    expect(run.content).toBe(FILE);
    expect(run.filename).toBe("123456789000S032026.DAT");
    expect(run.content_sha256).toBe(createHash("sha256").update(FILE).digest("hex"));
    expect(run.reconciliation.every((r) => r.passed)).toBe(true);
    const RECORD =
      "select public.record_output_validation($1, 'official_tool', $2, $3, 'passed', $4, $5, null) as s";
    // a pass for another file, or from another tool, is refused
    expect(
      await h.errorOf(PREP, RECORD, [g.run_id, "TEST VALIDATOR", "1.0", "0".repeat(64), "log"]),
    ).toBeDefined();
    expect(
      await h.errorOf(PREP, RECORD, [g.run_id, "OTHER TOOL", "1.0", run.content_sha256, "log"]),
    ).toBeDefined();
    const s = await one<{ s: string }>(PREP, RECORD, [
      g.run_id,
      "TEST VALIDATOR",
      "1.0",
      run.content_sha256,
      "Synthetic validator: 0 errors",
    ]);
    expect(s.s).toBe("validated");
    await h.run(
      REV,
      "select public.sign_off_output($1, 'Checked against the source and the validation log')",
      [g.run_id],
    );
    ids.run = g.run_id;
  });

  it("8. the return is filed only after review, approval, export and an actual filing confirmation", async () => {
    ids.filing = (
      await one<{ id: string }>(
        REV,
        "select public.add_filing($1, 'TEST_FORM', 'Synthetic monthly return', '2026-03-01', '2026-03-31', '2026-04-10', 'TEST ONLY due date') as id",
        [A],
      )
    ).id;
    const step = (
      who: Parameters<typeof h.run>[0],
      action: string,
      data: Record<string, string> = {},
    ) =>
      one<{ s: string }>(who, "select public.advance_filing($1, $2, $3::jsonb, null) as s", [
        ids.filing,
        action,
        JSON.stringify(data),
      ]);
    await h.run(MGR, "select public.assign_filing($1, $2, $3, null, null)", [
      ids.filing,
      IDS.accountantB,
      IDS.reviewerA,
    ]);
    await step(PREP, "start");
    await step(PREP, "prepared", { workpaper_id: ids.workpaper });
    await step(PREP, "submit");
    await step(REV, "approve", { note: "Workpaper, schedule and computation reviewed" });
    // the validated, signed-off file is the export; downloading it changed nothing
    expect(
      (
        await sql1<{ status: string }>("select status from public.filings where id = $1", [
          ids.filing,
        ])
      ).status,
    ).toBe("approved");
    await step(PREP, "export", { method: "validated_file", output_run_id: ids.run });
    const today = (await sql1<{ d: string }>("select current_date::text d")).d;
    const confirm = {
      filed_on: today,
      channel: "TEST CHANNEL",
      reference: "TEST-E2E-0001",
      evidence: "Synthetic confirmation",
    };
    expect((await step(PREP, "confirm_filed", confirm)).s).toBe("filed");
    expect((await step(PREP, "confirm_filed", confirm)).s).toBe("filed"); // retry
    const f = await sql1<Record<string, string>>(
      "select prepared_by, approved_by, exported_by, filed_confirmed_by, workpaper_id, output_run_id from public.filings where id = $1",
      [ids.filing],
    );
    expect(f).toEqual({
      prepared_by: IDS.accountantB,
      approved_by: IDS.reviewerA,
      exported_by: IDS.accountantB,
      filed_confirmed_by: IDS.accountantB,
      workpaper_id: ids.workpaper,
      output_run_id: ids.run,
    });
  });

  it("9. the whole month is in the audit trail, and the client sees only its own results", async () => {
    const actions = (
      await db.query<{ action: string }>(
        "select distinct action from audit.events where client_id = $1",
        [A],
      )
    ).rows.map((r) => r.action);
    for (const a of [
      "update:intake_transactions",
      "insert:sales_invoices",
      "insert:tax_computations",
      "insert:tax_workpapers",
      "insert:output_runs",
      "update:filings",
    ])
      expect(actions, a).toContain(a);
    // the client reads its posted ledger result but never the firm workflow
    expect(
      (await h.read(CLIENT, "select 1 from public.sales_invoices where client_id = $1", [A]))
        .length,
    ).toBe(1);
    for (const t of ["tax_computations", "tax_workpapers", "output_runs", "filings"])
      expect(await h.read(CLIENT, `select 1 from public.${t}`), t).toEqual([]);
    // another tenant sees nothing at all
    for (const t of [
      "intake_transactions",
      "sales_invoices",
      "journal_entries",
      "tax_computations",
      "filings",
    ])
      expect(
        await h.read("ownerB", `select 1 from public.${t} where client_id = $1`, [A]),
        t,
      ).toEqual([]);
  });
});
