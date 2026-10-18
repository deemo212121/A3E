/**
 * Phase 14 electronic outputs and e-invoicing register (PGlite). Synthetic.
 *
 * EVERY LAYOUT HERE IS A SYNTHETIC "TEST ONLY" LAYOUT. None is a BIR DAT,
 * alphalist, SLSP, QAP or SAWT format; the platform ships with no layouts.
 *
 *   TEST_SLS (delimited, ASCII, CRLF): header H,<TIN>,<MM/YYYY>; detail per
 *     customer D,<seq>,<TIN digits>,<NAME upper, max 20>,<vatable>,<vat>;
 *     control C,<count>,<sum vatable>,<sum vat>; file <TIN>S<MMYYYY>.DAT
 *   TEST_FIX (fixed width): <code 5, allowed WC100|WC160><amount 8, 0 dp, zero-padded>
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
const spec: Record<string, string> = {};
const party: Record<string, string> = {};
const SOURCE = {
  citation: "TEST ONLY - synthetic layout for automated tests",
  spec_version: "T1",
  issued_on: "2026-01-01",
};
const TOOL = { official_tool: "TEST VALIDATOR", official_tool_version: "1.0" };
const CRLF = "\r\n";
const FACTS = { tin: "123-456-789-000" };

const slsLayout = {
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
const specJson = (code: string, dataset: string, layout: unknown) => ({
  output_code: code,
  output_type: "other",
  title: "Synthetic test layout",
  spec_source: SOURCE,
  ...TOOL,
  effective_from: "2026-01-01",
  dataset,
  layout,
  limitations: "Synthetic test layout; not a BIR file.",
});
const row = (tin: string | null, name: string, vatable: string, vat: string) => ({
  customer_tin: tin,
  customer_name: name,
  vatable,
  vat,
});
const NORMAL_ROWS = [
  row("111-111-111-000", "Alpha Co", "1000.00", "120.00"),
  row("222-222-222-000", "Beta Inc", "100.00", "12.00"),
  row("111-111-111-000", "Alpha Co", "500.00", "60.00"),
];
const NORMAL_FILE =
  [
    "H,123456789000,03/2026",
    "D,1,111111111000,ALPHA CO,1500.00,180.00",
    "D,2,222222222000,BETA INC,100.00,12.00",
    "C,2,1600.00,192.00",
  ].join(CRLF) + CRLF;

const propose = async (j: unknown) =>
  (
    await h.run<{ id: string }>(AUTHOR, "select public.propose_output_spec($1::jsonb) as id", [
      JSON.stringify(j),
    ])
  )[0].id;
const fixture = (id: string, f: Record<string, unknown>) =>
  h.run(PREP, "select public.add_output_fixture($1, $2::jsonb)", [
    id,
    JSON.stringify({
      basis: "Hand-worked from the synthetic layout",
      as_of: "2026-03-31",
      period_from: "2026-03-01",
      period_to: "2026-03-31",
      facts: FACTS,
      ...f,
    }),
  ]);
async function reviewAll(id: string) {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.output_spec_fixtures where spec_id = $1",
    [id],
  );
  for (const r of rows) await h.run(AUTHOR, "select public.review_output_fixture($1)", [r.id]);
}
async function approveAndEnable(id: string) {
  await h.run(AUTHOR, "select public.submit_output_spec($1)", [id]);
  await reviewAll(id);
  await h.run(MANAGER, "select public.approve_output_spec($1, true, null)", [id]);
}
const generate = (key = newKey("out")) =>
  h
    .run<{
      r: { run_id: string; status: string; reason: string | null; precheck_passed: boolean };
    }>(
      PREP,
      "select public.generate_output($1, 'TEST_SLS', '2026-03-01'::date, '2026-03-31'::date, $2) as r",
      [A, key],
    )
    .then((rows) => rows[0].r);
const runRow = async (id: string) =>
  (
    await db.query<{
      status: string;
      filename: string;
      content: string;
      content_sha256: string;
      precheck_passed: boolean;
      snapshot: unknown[];
      messages: { code: string }[];
      reconciliation: { check: string; passed: boolean }[];
    }>(
      "select status, filename, content, content_sha256, precheck_passed, snapshot, messages, reconciliation from public.output_runs where id = $1",
      [id],
    )
  ).rows[0];
const RECORD = "select public.record_output_validation($1, $2, $3, $4, $5, $6, $7, $8) as s";

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
  await h.run(AUTHOR, "select public.apply_default_sales_settings($1)", [A]);
  for (const [key, fields] of Object.entries({
    alpha: { kind: "customer", registered_name: "Alpha Co", tin: "111111111000" },
    beta: { kind: "customer", registered_name: "Beta Inc", tin: "222222222000" },
    notin: { kind: "customer", registered_name: "No TIN Trading" },
  })) {
    const [r] = await h.run<{ id: string }>(
      PREP,
      "select public.save_counterparty($1, null, null, $2::jsonb, $3) as id",
      [A, JSON.stringify(fields), newKey()],
    );
    await h.run(PREP, "select public.transition_counterparty($1, 'submitted')", [r.id]);
    await h.run(PREP, "select public.transition_counterparty($1, 'approved')", [r.id]);
    party[key] = r.id;
  }
  await h.run(PREP, "select public.set_tax_profile($1, $2::jsonb)", [A, JSON.stringify(FACTS)]);
  await h.run(AUTHOR, "select public.confirm_tax_profile($1)", [A]);
}, 60_000);

async function invoice(no: string, who: string, price: string) {
  const [r] = await h.run<{ id: string }>(
    PREP,
    "select public.save_sales_invoice($1, null, null, $2::jsonb, $3::jsonb, $4) as id",
    [
      A,
      JSON.stringify({
        counterparty_id: party[who],
        invoice_no: no,
        invoice_date: "2026-03-10",
        due_date: "2026-04-10",
        sale_type: "credit",
      }),
      JSON.stringify([
        { description: "Goods", quantity: "1", unit_price: price, tax_class: "vatable" },
      ]),
      newKey("inv"),
    ],
  );
  await h.run(PREP, "select public.submit_sales_document('sales_invoice', $1)", [r.id]);
  await h.run(AUTHOR, "select public.post_sales_invoice($1)", [r.id]);
}

describe("specifications: transcribed from the official spec, verified, signed off", () => {
  it("layouts are checked; nothing is inferred", async () => {
    const P = "select public.propose_output_spec($1::jsonb)";
    expect(
      await h.errorOf(PREP, P, [
        JSON.stringify(specJson("TEST_SLS", "sales_by_invoice", slsLayout)),
      ]),
    ).toBe("42501");
    expect(
      await h.messageOf(AUTHOR, P, [
        JSON.stringify(specJson("TEST_X", "sales_by_invoice", { ...slsLayout, format: "xml" })),
      ]),
    ).toMatch(/needs format/);
    expect(
      await h.messageOf(AUTHOR, P, [
        JSON.stringify(specJson("TEST_X", "sales_by_invoice", { ...slsLayout, format: "fixed" })),
      ]),
    ).toMatch(/fixed-width layouts need every field length/);
    expect(
      await h.errorOf(AUTHOR, P, [
        JSON.stringify(specJson("TEST_X", "guess_from_extension", slsLayout)),
      ]),
    ).toBe("22023");
  });

  it("deterministic output and every boundary the layout defines", async () => {
    spec.sls = await propose(specJson("TEST_SLS", "sales_by_invoice", slsLayout));
    await fixture(spec.sls, {
      name: "normal: two customers, one aggregated",
      kind: "normal",
      rows: NORMAL_ROWS,
      expected_content: NORMAL_FILE,
      expected_filename: "123456789000S032026.DAT",
    });
    await fixture(spec.sls, {
      name: "same rows in another order give the same file",
      kind: "boundary",
      rows: [...NORMAL_ROWS].reverse(),
      expected_content: NORMAL_FILE,
    });
    await fixture(spec.sls, {
      name: "a non-ASCII letter is refused (no silent transliteration)",
      kind: "boundary",
      rows: [row("333-333-333-000", "Niño Co", "1.00", "0.12")],
      expected_messages: ["INVALID_CHAR"],
    });
    await fixture(spec.sls, {
      name: "the delimiter inside a value is refused",
      kind: "boundary",
      rows: [row("333-333-333-000", "Comma, Co", "1.00", "0.12")],
      expected_messages: ["INVALID_CHAR"],
    });
    await fixture(spec.sls, {
      name: "missing customer TIN",
      kind: "boundary",
      rows: [row(null, "Gamma", "1.00", "0.12")],
      expected_messages: ["REQUIRED"],
    });
    await fixture(spec.sls, {
      name: "name of 21 characters",
      kind: "boundary",
      rows: [row("444-444-444-000", "ABCDEFGHIJKLMNOPQRSTU", "1.00", "0.12")],
      expected_messages: ["TOO_LONG"],
    });
    await fixture(spec.sls, {
      name: "name of exactly 20 characters",
      kind: "boundary",
      rows: [row("444-444-444-000", "ABCDEFGHIJKLMNOPQRST", "1.00", "0.12")],
      expected_messages: [],
    });
    await fixture(spec.sls, {
      name: "same TIN under two names is a duplicate",
      kind: "boundary",
      rows: [
        row("555-555-555-000", "Delta", "1.00", "0.12"),
        row("555-555-555-000", "Delta Corp", "1.00", "0.12"),
      ],
      expected_messages: ["DUPLICATE"],
    });
    await fixture(spec.sls, {
      name: "no taxpayer TIN: header and file name fail",
      kind: "boundary",
      facts: {},
      rows: NORMAL_ROWS,
      expected_messages: ["FILENAME", "REQUIRED"],
    });
    await fixture(spec.sls, {
      name: "negative vatable sales",
      kind: "boundary",
      rows: [row("666-666-666-000", "Epsilon", "-1.00", "0")],
      expected_messages: ["NEGATIVE"],
    });

    const fixLayout = {
      format: "fixed",
      encoding: "ascii",
      line_end: "crlf",
      final_newline: true,
      filename: "FIX{period.to:YYYYMM}.TXT",
      sums: ["amount"],
      order_by: ["atc"],
      records: [
        {
          record: "detail",
          fields: [
            {
              name: "atc",
              from: "row.atc",
              length: 5,
              required: true,
              allowed: ["WC100", "WC160"],
            },
            { name: "amount", from: "row.amount", type: "number", decimals: 0, length: 8 },
          ],
        },
      ],
    };
    spec.fix = await propose(specJson("TEST_FIX", "withholding_by_bill_line", fixLayout));
    await fixture(spec.fix, {
      name: "zero-padded fixed width",
      kind: "normal",
      rows: [
        { atc: "WC160", amount: "250" },
        { atc: "WC100", amount: "100" },
      ],
      expected_content: `WC10000000100${CRLF}WC16000000250${CRLF}`,
      expected_filename: "FIX202603.TXT",
    });
    await fixture(spec.fix, {
      name: "invalid code",
      kind: "boundary",
      rows: [{ atc: "XX999", amount: "1" }],
      expected_messages: ["INVALID_CODE"],
    });
    await fixture(spec.fix, {
      name: "rounding to whole pesos breaks the total",
      kind: "boundary",
      rows: [
        { atc: "WC100", amount: "100.40" },
        { atc: "WC160", amount: "100.40" },
      ],
      expected_messages: ["ROUNDING"],
    });
    await fixture(spec.fix, {
      name: "amount wider than 8 digits",
      kind: "boundary",
      rows: [{ atc: "WC100", amount: "123456789" }],
      expected_messages: ["TOO_LONG"],
    });

    const res = await h.read<{
      name: string;
      passed: boolean;
      error: string | null;
      actual: unknown;
    }>(
      AUTHOR,
      "select name, passed, error, actual from public.output_fixture_results($1) union all select name, passed, error, actual from public.output_fixture_results($2)",
      [spec.sls, spec.fix],
    );
    for (const r of res)
      expect({ name: r.name, passed: r.passed, error: r.error }, JSON.stringify(r.actual)).toEqual({
        name: r.name,
        passed: true,
        error: null,
      });
  });

  it("approval needs the official spec and tool recorded, reviewed fixtures and another reviewer; production needs a manager sign-off", async () => {
    const noTool = await propose({
      ...specJson("TEST_NOTOOL", "sales_by_invoice", slsLayout),
      official_tool: "",
      official_tool_version: "",
    });
    await fixture(noTool, {
      name: "normal",
      kind: "normal",
      rows: NORMAL_ROWS,
      expected_content: NORMAL_FILE,
    });
    await fixture(noTool, { name: "boundary", kind: "boundary", rows: [], expected_messages: [] });
    expect(await h.messageOf(AUTHOR, "select public.submit_output_spec($1)", [noTool])).toMatch(
      /official validation tool/,
    );

    await h.run(AUTHOR, "select public.submit_output_spec($1)", [spec.sls]);
    expect(
      await h.errorOf(AUTHOR, "select public.approve_output_spec($1, true, null)", [spec.sls]),
    ).toBe("42501");
    expect(
      await h.messageOf(MANAGER, "select public.approve_output_spec($1, true, null)", [spec.sls]),
    ).toMatch(/reviewed by an accountant/);
    await reviewAll(spec.sls);
    expect(
      await h.messageOf(MANAGER, "select public.approve_output_spec($1, false, null)", [spec.sls]),
    ).toMatch(/official technical specification/);
    await h.run(MANAGER, "select public.approve_output_spec($1, true, 'every field compared')", [
      spec.sls,
    ]);
    await h.run(
      PREP,
      "select public.add_tax_obligation($1, 'TEST_SLS', '2026-01-01'::date, null, null)",
      [A],
    );
    expect(await generate()).toMatchObject({ status: "unsupported" }); // approved is not enabled
    expect(
      await h.errorOf(PREP, "select public.enable_output_spec($1, $2, $3)", [
        spec.sls,
        "x".repeat(30),
        "evidence",
      ]),
    ).toBe("42501");
    await h.run(MANAGER, "select public.enable_output_spec($1, $2, $3)", [
      spec.sls,
      "Compliance review: layout matches the synthetic spec field by field.",
      "Synthetic evidence ref E-1",
    ]);
    await approveAndEnable(spec.fix);
  });
});

describe("generation: snapshot, validation report, reconciliation; never valid without the official result", () => {
  it("is not applicable unless configured", async () => {
    const r = await h.run<{ r: { status: string } }>(
      PREP,
      "select public.generate_output($1, 'TEST_FIX', '2026-03-01'::date, '2026-03-31'::date, $2) as r",
      [A, newKey()],
    );
    expect(r[0].r.status).toBe("not_applicable");
  });

  it("generates the exact file from posted invoices and keeps the source snapshot", async () => {
    await invoice("SI-1", "alpha", "1000");
    await invoice("SI-2", "beta", "100");
    await invoice("SI-3", "alpha", "500");
    const g = await generate();
    expect(g).toMatchObject({ status: "generated", precheck_passed: true });
    const r = await runRow(g.run_id);
    expect([r.filename, r.content]).toEqual(["123456789000S032026.DAT", NORMAL_FILE]);
    expect(r.snapshot).toHaveLength(3);
    expect(r.snapshot[0]).toMatchObject({ source_type: "sales_invoice", doc_no: "SI-1" });
    expect(r.reconciliation.every((c) => c.passed)).toBe(true);
    expect(r.status).toBe("generated"); // generated is NOT valid
    let code: string | undefined;
    try {
      await db.query("update public.output_runs set content = 'x' where id = $1", [g.run_id]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");

    const log = "TEST VALIDATOR 1.0: 0 errors, 2 records (synthetic log)";
    expect(
      await h.messageOf(PREP, RECORD, [
        g.run_id,
        "official_tool",
        "Some Other Tool",
        "1.0",
        "passed",
        r.content_sha256,
        log,
        null,
      ]),
    ).toMatch(/must be validated with TEST VALIDATOR version 1.0/);
    expect(
      await h.messageOf(PREP, RECORD, [
        g.run_id,
        "official_tool",
        "TEST VALIDATOR",
        "1.0",
        "passed",
        "0".repeat(64),
        log,
        null,
      ]),
    ).toMatch(/this exact file/);
    expect(
      (
        await h.run<{ s: string }>(PREP, RECORD, [
          g.run_id,
          "official_tool",
          "TEST VALIDATOR",
          "1.0",
          "failed",
          r.content_sha256,
          log,
          null,
        ])
      )[0].s,
    ).toBe("validation_failed");
    expect(
      await h.messageOf(AUTHOR, "select public.sign_off_output($1, 'checked the file')", [
        g.run_id,
      ]),
    ).toMatch(/passed the official validation/);
    expect(
      (
        await h.run<{ s: string }>(PREP, RECORD, [
          g.run_id,
          "official_tool",
          "test validator",
          "1.0",
          "passed",
          r.content_sha256,
          log,
          "RUN-1",
        ])
      )[0].s,
    ).toBe("validated");
    expect(
      await h.errorOf(PREP, "select public.sign_off_output($1, 'checked the file')", [g.run_id]),
    ).toBe("42501");
    await h.run(
      AUTHOR,
      "select public.sign_off_output($1, 'Checked against the source and the validation log')",
      [g.run_id],
    );
    expect((await runRow(g.run_id)).status).toBe("signed_off");
  });

  it("an official pass is not enough when our validation or reconciliation failed", async () => {
    await invoice("SI-4", "notin", "10"); // a customer without TIN
    const g = await generate();
    const r = await runRow(g.run_id);
    expect(g.precheck_passed).toBe(false);
    expect(r.messages.map((m) => m.code)).toContain("REQUIRED");
    const s = await h.run<{ s: string }>(PREP, RECORD, [
      g.run_id,
      "official_tool",
      "TEST VALIDATOR",
      "1.0",
      "passed",
      r.content_sha256,
      "TEST VALIDATOR 1.0 says ok (synthetic)",
      null,
    ]);
    expect(s[0].s).toBe("validation_failed");
    const old = await db.query<{ n: number }>(
      "select count(*)::int n from public.output_runs where client_id = $1 and status = 'superseded'",
      [A],
    );
    expect(old.rows[0].n).toBe(1); // the earlier signed-off file is superseded, never edited
  });
});

describe("e-invoicing compliance register: evidence, not assumptions", () => {
  it("requirements are verified against cited sources; 'met' needs evidence", async () => {
    const [{ id }] = await h.run<{ id: string }>(
      AUTHOR,
      "select public.propose_einvoice_requirement($1::jsonb) as id",
      [
        JSON.stringify({
          code: "TEST_REG",
          category: "registration",
          title: "Synthetic registration requirement",
          description: "TEST ONLY requirement",
          sources: [],
        }),
      ],
    );
    const ASSESS = "select public.assess_client_einvoice($1, $2, $3, $4, $5)";
    expect(
      await h.errorOf(AUTHOR, ASSESS, [A, id, "met", "evidence of registration 123", null]),
    ).toBe("22023"); // not verified
    expect(
      await h.errorOf(MANAGER, "select public.verify_einvoice_requirement($1, true)", [id]),
    ).toBe("22023"); // no source
    const [{ id: id2 }] = await h.run<{ id: string }>(
      AUTHOR,
      "select public.propose_einvoice_requirement($1::jsonb) as id",
      [
        JSON.stringify({
          code: "TEST_CERT",
          category: "certification",
          title: "Synthetic certification",
          description: "TEST ONLY requirement",
          sources: [{ citation: "TEST ONLY synthetic source", issued_on: "2026-01-01" }],
        }),
      ],
    );
    expect(
      await h.errorOf(AUTHOR, "select public.verify_einvoice_requirement($1, true)", [id2]),
    ).toBe("42501");
    await h.run(MANAGER, "select public.verify_einvoice_requirement($1, true)", [id2]);
    expect(await h.errorOf(AUTHOR, ASSESS, [A, id2, "met", "", null])).toBe("22023");
    expect(await h.errorOf(PREP, ASSESS, [A, id2, "not_assessed", null, null])).toBe("42501");
    await h.run(AUTHOR, ASSESS, [
      A,
      id2,
      "met",
      "Synthetic certificate no. TEST-001 on file",
      null,
    ]);
    for (const who of ["ownerA", "ownerB", "outsider"] as const) {
      expect(
        await h.read(who, "select 1 from public.output_runs where client_id = $1", [A]),
      ).toEqual([]);
      expect(
        await h.read(who, "select 1 from public.client_einvoice_assessments where client_id = $1", [
          A,
        ]),
      ).toEqual([]);
    }
  });
});
