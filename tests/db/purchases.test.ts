/**
 * Phase 8 purchases, expenses and payables tests (PGlite). Synthetic data.
 * Withholding codes here are SYNTHETIC test codes ("TST..."), not real ATCs or
 * rates: the platform ships with no withholding rates at all.
 * Gate: no duplicate supplier bills; payables, allocations and ledger agree.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db, type UserKey } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const PREP = "accountantB" as const;
const POST = "reviewerA" as const;
const party: Record<string, string> = {};
const cat: Record<string, string> = {};
const wht: Record<string, string> = {};
let cash = "";

const acct = async (code: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.accounts where client_id = $1 and code = $2",
      [A, code],
    )
  ).rows[0].id;

const SAVE =
  "select public.save_purchase_bill($1, $2, $3, $4::jsonb, $5::jsonb, $6::uuid[], $7) as id";
type Line = Record<string, unknown>;
const ln = (category: string, unit_price: string, extra: Line = {}): Line => ({
  description: category,
  quantity: "1",
  unit_price,
  tax_class: "vatable",
  vat_category: "goods",
  category_id: cat[category],
  ...extra,
});
async function bill(
  no: string,
  lines: Line[],
  extra: Record<string, unknown> = {},
  who: UserKey = PREP,
  key = newKey("bill"),
) {
  const [r] = await h.run<{ id: string }>(who, SAVE, [
    A,
    null,
    null,
    JSON.stringify({
      bill_type: "bill",
      counterparty_id: party.fuel,
      bill_no: no,
      bill_date: "2026-09-03",
      ...extra,
    }),
    JSON.stringify(lines),
    null,
    key,
  ]);
  return r.id;
}
const billError = (no: string, lines: Line[], extra: Record<string, unknown> = {}) =>
  h.errorOf(PREP, SAVE, [
    A,
    null,
    null,
    JSON.stringify({
      bill_type: "bill",
      counterparty_id: party.fuel,
      bill_no: no,
      bill_date: "2026-09-03",
      ...extra,
    }),
    JSON.stringify(lines),
    null,
    newKey(),
  ]);
const submit = (subject: string, id: string) =>
  h.run(PREP, "select public.submit_sales_document($1::public.intake_subject, $2)", [subject, id]);
async function postBill(id: string) {
  await submit("purchase_bill", id);
  const [r] = await h.run<{ je: string }>(POST, "select public.post_purchase_bill($1) as je", [id]);
  return r.je;
}
async function payment(
  no: string,
  amount: string,
  allocations: Line[],
  extra: Record<string, unknown> = {},
) {
  const [r] = await h.run<{ id: string }>(
    PREP,
    "select public.save_supplier_payment($1, null, null, $2::jsonb, $3::jsonb, $4) as id",
    [
      A,
      JSON.stringify({
        counterparty_id: party.fuel,
        payment_no: no,
        payment_date: "2026-09-20",
        payment_method: "check",
        paid_from_account_id: cash,
        amount_paid: amount,
        ...extra,
      }),
      JSON.stringify(allocations),
      newKey("pay"),
    ],
  );
  return r.id;
}
async function postPayment(id: string) {
  await submit("supplier_payment", id);
  const [r] = await h.run<{ je: string }>(POST, "select public.post_supplier_payment($1) as je", [
    id,
  ]);
  return r.je;
}
async function entryLines(je: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text, l.credit::text from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.entry_id = $1 order by l.line_no`,
    [je],
  );
  return rows.map((r) => [r.code, r.debit, r.credit]);
}
const totals = async (id: string) =>
  (
    await db.query<Record<string, unknown>>(
      "select net_amount::text n, vat_amount::text v, gross_amount::text g, withholding_amount::text w, payable_amount::text p, policy_flags f from public.purchase_bills where id = $1",
      [id],
    )
  ).rows[0];
async function balances(asOf: string) {
  return h.read<{ bill_no: string; paid: string; outstanding: string }>(
    POST,
    "select bill_no, paid, outstanding from public.purchase_bill_balances($1, $2::date) order by bill_no",
    [A, asOf],
  );
}
const recon = async (asOf: string) =>
  (
    await h.read<{ subledger_total: string; ledger_balance: string; difference: string }>(
      POST,
      "select * from public.ap_reconciliation($1, $2::date)",
      [A, asOf],
    )
  )[0];

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
  await h.run(POST, "select public.apply_default_purchase_settings($1)", [A]);
  await h.run(PREP, "select public.propose_default_purchase_categories($1)", [A]);
  for (const r of (
    await db.query<{ id: string; name: string }>(
      "select id, name from public.purchase_categories where client_id = $1",
      [A],
    )
  ).rows) {
    await h.run(POST, "select public.approve_purchase_category($1)", [r.id]);
    cat[r.name] = r.id;
  }
  const SAVE_CP = "select public.save_counterparty($1, null, null, $2::jsonb, $3) as id";
  for (const [key, fields] of Object.entries({
    fuel: { kind: "supplier", registered_name: "Sample Fuels Corp.", tin: "111222333000" },
    landlord: { kind: "supplier", registered_name: "Sample Realty Inc.", tin: "222333444000" },
    other: { kind: "both", registered_name: "Other Trading" },
    employee: { kind: "employee", registered_name: "Employee 001" },
  })) {
    const [r] = await h.run<{ id: string }>(PREP, SAVE_CP, [A, JSON.stringify(fields), newKey()]);
    await h.run(PREP, "select public.transition_counterparty($1, 'submitted')", [r.id]);
    await h.run(PREP, "select public.transition_counterparty($1, 'approved')", [r.id]);
    party[key] = r.id;
  }
  const PROPOSE =
    "select public.propose_withholding_code($1, $2, $3, $4, $5, $6::date, $7::date) as id";
  const legal = "SYNTHETIC test code; not a real ATC or rate";
  const [w1] = await h.run<{ id: string }>(POST, PROPOSE, [
    "TST01",
    "Test rate on net",
    "0.02",
    "net_of_vat",
    legal,
    "2026-01-01",
    null,
  ]);
  const [w2] = await h.run<{ id: string }>(POST, PROPOSE, [
    "TST02",
    "Test rate on gross",
    "0.01",
    "gross",
    legal,
    "2026-01-01",
    null,
  ]);
  const [w3] = await h.run<{ id: string }>(POST, PROPOSE, [
    "TST05",
    "Pending code",
    "0.05",
    "net_of_vat",
    legal,
    "2026-01-01",
    null,
  ]);
  const [w4] = await h.run<{ id: string }>(POST, PROPOSE, [
    "TST09",
    "Future code",
    "0.03",
    "net_of_vat",
    legal,
    "2027-01-01",
    null,
  ]);
  for (const w of [w1, w2, w4])
    await h.run("manager", "select public.sign_off_withholding_code($1)", [w.id]);
  Object.assign(wht, { net2: w1.id, gross1: w2.id, pending: w3.id, future: w4.id });
  cash = await acct("1020");
}, 60_000);

describe("verified configuration: withholding codes and categories", () => {
  it("withholding codes need a reviewer/manager to enter and a DIFFERENT one to sign off", async () => {
    const PROPOSE =
      "select public.propose_withholding_code('TST77', 'x code', '0.10', 'net_of_vat', 'synthetic basis', '2026-01-01'::date, null)";
    expect(await h.errorOf(PREP, PROPOSE)).toBe("42501");
    expect(await h.errorOf("ownerA", PROPOSE)).toBe("42501");
    expect(
      await h.errorOf(POST, "select public.sign_off_withholding_code($1)", [wht.pending]),
    ).toBe("42501");
    expect(
      await h.errorOf(
        POST,
        "select public.propose_withholding_code('TST78', 'x code', '2%', 'net_of_vat', 'synthetic basis', '2026-01-01'::date, null)",
      ),
    ).toBe("22023");
  });

  it("a signed-off code cannot be changed; a change is a new version", async () => {
    let code: string | undefined;
    try {
      await db.query("update public.withholding_codes set rate = 0.5 where id = $1", [wht.net2]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
    const [v2] = await h.run<{ id: string }>(
      POST,
      "select public.propose_withholding_code('TST01', 'Test rate v2', '0.03', 'net_of_vat', 'synthetic basis', '2027-01-01'::date, null) as id",
    );
    const { rows } = await db.query<{ version: number }>(
      "select version from public.withholding_codes where id = $1",
      [v2.id],
    );
    expect(rows[0].version).toBe(2);
  });

  it("categories are proposed, then approved by someone else; unapproved ones cannot be used", async () => {
    const [{ id }] = await h.run<{ id: string }>(
      PREP,
      "select public.propose_purchase_category($1, 'Software subscriptions', 'expense', $2) as id",
      [A, await acct("6900")],
    );
    expect(await h.errorOf(PREP, "select public.approve_purchase_category($1)", [id])).toBe(
      "42501",
    );
    expect(await billError("X-1", [{ ...ln("Fuel and oil", "10"), category_id: id }])).toBe(
      "22023",
    );
    expect(Object.keys(cat).length).toBeGreaterThanOrEqual(15);
  });
});

describe("VAT breakdowns and treatment by category", () => {
  it("VAT-exclusive bill with goods, services, exempt and non-VAT lines", async () => {
    const id = await bill("SI-1001", [
      ln("Raw materials", "1000"),
      ln("Repairs and maintenance", "500", { vat_category: "services" }),
      ln("Office and production supplies", "200", { tax_class: "exempt", vat_category: null }),
      ln("Fuel and oil", "300", { tax_class: "not_subject", vat_category: null }),
    ]);
    expect(await totals(id)).toMatchObject({
      n: "2000.00",
      v: "180.00",
      g: "2180.00",
      w: "0.00",
      p: "2180.00",
    });
    const { rows } = await db.query<{ vat_category: string | null; kind: string; vat: string }>(
      "select vat_category, kind::text, vat_amount::text vat from public.purchase_bill_lines where bill_id = $1 order by line_no",
      [id],
    );
    expect(rows.map((r) => [r.vat_category, r.kind, r.vat])).toEqual([
      ["goods", "inventory", "120.00"],
      ["services", "expense", "60.00"],
      [null, "expense", "0.00"],
      [null, "expense", "0.00"],
    ]);
  });

  it("VAT-inclusive receipt (the firm's ÷1.12 practice): 2,240.00 = 2,000.00 + 240.00", async () => {
    const id = await bill("OR-2240", [ln("Fuel and oil", "2240")], { prices_include_vat: true });
    expect(await totals(id)).toMatchObject({ n: "2000.00", v: "240.00", g: "2240.00" });
  });

  it("fixed assets and prepayments post to their asset accounts; expense lines above the threshold are flagged", async () => {
    await h.run(POST, "select public.set_purchase_settings($1, $2, $3, $4, $5, '50000')", [
      A,
      await acct("2010"),
      await acct("1310"),
      await acct("2110"),
      await acct("1130"),
    ]);
    const id = await bill("SI-ASSET", [
      ln("Equipment", "80000", { vat_category: "capital_goods" }),
      ln("Prepaid expenses", "12000", { tax_class: "exempt", vat_category: null }),
      ln("Repairs and maintenance", "60000", { vat_category: "services" }),
    ]);
    const t = await totals(id);
    expect(t.f).toEqual([
      "line 3: unit cost at or above the capitalization threshold; check if it is a fixed asset",
    ]);
    expect(await entryLines(await postBill(id))).toEqual([
      ["1300", "12000.00", "0.00"],
      ["1500", "80000.00", "0.00"],
      ["6080", "60000.00", "0.00"],
      ["1310", "16800.00", "0.00"],
      ["2010", "0.00", "168800.00"],
    ]);
  });
});

describe("withholding scenarios (synthetic codes)", () => {
  it("withholding on the net amount: payable = gross - withholding; the entry credits withholding payable", async () => {
    const id = await bill(
      "RENT-09",
      [ln("Rent", "10000", { vat_category: "services", withholding_code_id: wht.net2 })],
      { counterparty_id: party.landlord },
    );
    expect(await totals(id)).toMatchObject({
      n: "10000.00",
      v: "1200.00",
      g: "11200.00",
      w: "200.00",
      p: "11000.00",
    });
    expect(await entryLines(await postBill(id))).toEqual([
      ["6020", "10000.00", "0.00"],
      ["1310", "1200.00", "0.00"],
      ["2110", "0.00", "200.00"],
      ["2010", "0.00", "11000.00"],
    ]);
  });

  it("withholding on the gross amount, as the signed-off code says", async () => {
    const id = await bill(
      "SVC-1",
      [
        ln("Professional fees", "10000", {
          vat_category: "services",
          withholding_code_id: wht.gross1,
        }),
      ],
      { counterparty_id: party.landlord },
    );
    expect(await totals(id)).toMatchObject({ g: "11200.00", w: "112.00", p: "11088.00" });
  });

  it("a code that is not signed off cannot be posted; a code not yet in effect cannot be used", async () => {
    const id = await bill(
      "SVC-PEND",
      [
        ln("Professional fees", "1000", {
          vat_category: "services",
          withholding_code_id: wht.pending,
        }),
      ],
      { counterparty_id: party.landlord },
    );
    await submit("purchase_bill", id);
    expect(await h.messageOf(POST, "select public.post_purchase_bill($1)", [id])).toMatch(
      /TST05 v1 is not signed off/,
    );
    expect(
      await billError("SVC-FUT", [
        ln("Professional fees", "1000", {
          vat_category: "services",
          withholding_code_id: wht.future,
        }),
      ]),
    ).toBe("22023");
  });

  it("the withholding summary lists the captured data by payee and code", async () => {
    const rows = await h.read(
      POST,
      "select payee_name, payee_tin, code, rate, base_total, withheld_total, bill_count from public.withholding_summary($1, '2026-09-01', '2026-09-30')",
      [A],
    );
    expect(rows).toEqual([
      {
        payee_name: "Sample Realty Inc.",
        payee_tin: "222-333-444-000",
        code: "TST01",
        rate: "0.020000",
        base_total: "10000.00",
        withheld_total: "200.00",
        bill_count: 1,
      },
    ]);
  });
});

describe("GATE: no duplicate supplier bills", () => {
  it("the same supplier invoice number is refused; another supplier may use it; retries return the same bill", async () => {
    expect(await billError("si-1001", [ln("Fuel and oil", "1")])).toBe("23505");
    expect(
      await h.messageOf(PREP, SAVE, [
        A,
        null,
        null,
        JSON.stringify({
          bill_type: "bill",
          counterparty_id: party.fuel,
          bill_no: "SI-1001",
          bill_date: "2026-09-03",
        }),
        JSON.stringify([ln("Fuel and oil", "1")]),
        null,
        newKey(),
      ]),
    ).toMatch(/already recorded \(duplicate\)/);
    expect(
      await billError("SI-1001", [ln("Fuel and oil", "1")], { counterparty_id: party.other }),
    ).toBeUndefined();
    const key = newKey("retry");
    const a = await bill("SI-RETRY", [ln("Fuel and oil", "5")], {}, PREP, key);
    expect(await bill("SI-RETRY", [ln("Fuel and oil", "5")], {}, PREP, key)).toBe(a);
  });

  it("only another reviewer can post; posting twice returns the same entry", async () => {
    const id = (
      await db.query<{ id: string }>(
        "select id from public.purchase_bills where bill_no = 'SI-1001' and counterparty_id = $1",
        [party.fuel],
      )
    ).rows[0].id;
    await submit("purchase_bill", id);
    expect(await h.errorOf(PREP, "select public.post_purchase_bill($1)", [id])).toBe("42501");
    const [a] = await h.run<{ je: string }>(POST, "select public.post_purchase_bill($1) as je", [
      id,
    ]);
    const [b] = await h.run<{ je: string }>(POST, "select public.post_purchase_bill($1) as je", [
      id,
    ]);
    expect(b.je).toBe(a.je);
  });
});

describe("payments, allocations and reconciliation", () => {
  let b1 = "";
  it("partial payments, then an overpayment that becomes an advance to the supplier", async () => {
    b1 = (
      await db.query<{ id: string }>(
        "select id from public.purchase_bills where bill_no = 'SI-1001' and counterparty_id = $1",
        [party.fuel],
      )
    ).rows[0].id; // payable 2180.00
    await postPayment(await payment("CV-001", "1000", [{ bill_id: b1, amount: "1000" }]));
    expect((await balances("2026-09-30")).find((b) => b.bill_no === "SI-1001")).toMatchObject({
      outstanding: "1180.00",
    });
    const je = await postPayment(
      await payment("CV-002", "1500", [{ bill_id: b1, amount: "1180" }]),
    );
    expect(await entryLines(je)).toEqual([
      ["2010", "1180.00", "0.00"],
      ["1130", "320.00", "0.00"],
      ["1020", "0.00", "1500.00"],
    ]);
    expect((await balances("2026-09-30")).find((b) => b.bill_no === "SI-1001")).toMatchObject({
      outstanding: "0.00",
    });
  });

  it("two payments racing for the same balance: the second is refused at posting", async () => {
    const id = await bill("SI-RACE", [
      ln("Fuel and oil", "100", { tax_class: "exempt", vat_category: null }),
    ]);
    await postBill(id);
    const a = await payment("CV-R1", "100", [{ bill_id: id, amount: "100" }]);
    const b = await payment("CV-R2", "100", [{ bill_id: id, amount: "100" }]);
    await submit("supplier_payment", a);
    await submit("supplier_payment", b);
    await h.run(POST, "select public.post_supplier_payment($1)", [a]);
    expect(await h.messageOf(POST, "select public.post_supplier_payment($1)", [b])).toMatch(
      /only 0.00 is outstanding/,
    );
  });

  it("invalid allocations and duplicate payment numbers are refused", async () => {
    const SAVE_PAY =
      "select public.save_supplier_payment($1, null, null, $2::jsonb, $3::jsonb, $4)";
    const hdr = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        counterparty_id: party.fuel,
        payment_no: `CV-X-${newKey()}`,
        payment_date: "2026-09-20",
        paid_from_account_id: cash,
        amount_paid: "10",
        ...extra,
      });
    const rent = (
      await db.query<{ id: string }>(
        "select id from public.purchase_bills where bill_no = 'RENT-09'",
      )
    ).rows[0].id;
    expect(
      await h.errorOf(PREP, SAVE_PAY, [
        A,
        hdr(),
        JSON.stringify([{ bill_id: rent, amount: "5" }]),
        newKey(),
      ]),
    ).toBe("22023"); // other supplier's bill
    expect(
      await h.errorOf(PREP, SAVE_PAY, [
        A,
        hdr(),
        JSON.stringify([{ bill_id: b1, amount: "11" }]),
        newKey(),
      ]),
    ).toBe("22023"); // more than paid
    expect(
      await h.errorOf(PREP, SAVE_PAY, [A, hdr({ payment_no: "cv-001" }), "[]", newKey()]),
    ).toBe("23505");
  });

  it("a cash purchase is paid on the spot: it credits cash and never appears in payables", async () => {
    const id = await bill("OR-CASH", [ln("Meals", "560")], {
      bill_type: "cash_purchase",
      paid_from_account_id: cash,
      prices_include_vat: true,
    });
    expect(await entryLines(await postBill(id))).toEqual([
      ["6130", "500.00", "0.00"],
      ["1310", "60.00", "0.00"],
      ["1020", "0.00", "560.00"],
    ]);
    expect((await balances("2026-09-30")).map((b) => b.bill_no)).not.toContain("OR-CASH");
  });

  it("a reimbursement to an employee keeps each receipt's supplier and TIN, and is paid like a bill", async () => {
    const id = await bill(
      "EXP-2026-09",
      [
        ln("Transportation and travel", "250", {
          prices: true,
          source_supplier_name: "NLEX Corporation",
          source_supplier_tin: "004984946000",
          source_document_ref: "TOLL-123",
        }),
        ln("Meals", "300", {
          tax_class: "not_subject",
          vat_category: null,
          source_supplier_name: "Carinderia",
        }),
      ],
      { bill_type: "reimbursement", counterparty_id: party.employee },
    );
    const { rows } = await db.query(
      "select source_supplier_name s, source_supplier_tin t from public.purchase_bill_lines where bill_id = $1 order by line_no",
      [id],
    );
    expect(rows).toEqual([
      { s: "NLEX Corporation", t: "004-984-946-000" },
      { s: "Carinderia", t: null },
    ]);
    await postBill(id);
    await postPayment(
      await payment("CV-EMP", "580", [{ bill_id: id, amount: "580" }], {
        counterparty_id: party.employee,
      }),
    );
    expect((await balances("2026-09-30")).find((b) => b.bill_no === "EXP-2026-09")).toMatchObject({
      outstanding: "0.00",
    });
    expect(
      await billError("EXP-X", [ln("Meals", "1")], {
        bill_type: "bill",
        counterparty_id: party.employee,
      }),
    ).toBe("22023");
  });

  it("reversals: a paid bill cannot be cancelled until its payments are; then both are reversed", async () => {
    const id = await bill("SI-REV", [ln("Fuel and oil", "1000")]); // 1120
    await postBill(id);
    const p = await payment("CV-REV", "500", [{ bill_id: id, amount: "500" }], {
      payment_date: "2026-09-10",
    });
    await postPayment(p);
    expect(
      await h.messageOf(POST, "select public.cancel_purchase_bill($1, 'wrong supplier')", [id]),
    ).toMatch(/cancel those payments first/);
    await h.run(
      POST,
      "select public.cancel_supplier_payment($1, 'Check not released', '2026-09-12'::date)",
      [p],
    );
    expect(
      await h.messageOf(
        POST,
        "select public.cancel_purchase_bill($1, 'backdated', '2026-09-05'::date)",
        [id],
      ),
    ).toMatch(/cannot be before 2026-09-12/);
    await h.run(POST, "select public.cancel_purchase_bill($1, 'Recorded twice')", [id]);
    expect((await balances("2026-09-30")).map((b) => b.bill_no)).not.toContain("SI-REV");
    expect((await balances("2026-09-11")).find((b) => b.bill_no === "SI-REV")).toMatchObject({
      outstanding: "620.00",
    });
    expect(await billError("SI-REV", [ln("Fuel and oil", "1")])).toBeUndefined(); // the number is free again
  });

  it("GATE: payables subledger = general ledger on every date; a manual entry shows as a difference", async () => {
    for (const asOf of ["2026-09-03", "2026-09-10", "2026-09-11", "2026-09-20", "2026-09-30"]) {
      expect({ asOf, d: (await recon(asOf)).difference }).toEqual({ asOf, d: "0.00" });
    }
    const lines = JSON.stringify([
      { account_id: await acct("6900"), debit: "25.00", credit: "" },
      { account_id: await acct("2010"), debit: "", credit: "25.00" },
    ]);
    const [{ id }] = await h.run<{ id: string }>(
      PREP,
      "select public.save_draft_entry($1, null, '2026-09-25'::date, 'general', 'manual', null, null, $2, $3::jsonb) as id",
      [A, newKey(), lines],
    );
    await h.run(PREP, "select public.submit_entry($1)", [id]);
    await h.run(POST, "select public.approve_and_post($1)", [id]);
    expect((await recon("2026-09-30")).difference).toBe("25.00");
  });
});

describe("intake link, permissions and isolation", () => {
  it("an approved client expense becomes a bill and cannot also be booked by journal", async () => {
    const t = await h.saveTxn("ownerA", A, {
      kind: "expense",
      txn_date: "2026-09-04",
      document_ref: "OR-INT",
      counterparty_name: "Sample Fuels Corp.",
      gross_amount: "112.00",
    });
    await h.transitionTxn("ownerA", t, "submitted");
    await h.transitionTxn(PREP, t, "reviewed");
    await h.transitionTxn(POST, t, "approved");
    const id = await bill("OR-INT", [ln("Fuel and oil", "112")], {
      intake_transaction_id: t,
      prices_include_vat: true,
    });
    const lines = JSON.stringify([
      { account_id: await acct("6090"), debit: "112.00", credit: "" },
      { account_id: cash, debit: "", credit: "112.00" },
    ]);
    expect(
      await h.errorOf(
        PREP,
        "select public.save_draft_entry($1, null, '2026-09-04'::date, 'general', 'x', 'intake_transaction', $2, $3, $4::jsonb)",
        [A, t, newKey(), lines],
      ),
    ).toBe("22023");
    const je = await postBill(id);
    expect(await h.txn(t)).toMatchObject({ status: "posted", journal_entry_id: je });
  });

  it("clients can read but not record; other tenants see nothing; no direct writes", async () => {
    expect(
      (await h.read("ownerA", "select 1 from public.purchase_bills where client_id = $1", [A]))
        .length,
    ).toBeGreaterThan(0);
    expect(await h.errorOf("ownerA", SAVE, [A, null, null, "{}", "[]", null, newKey()])).toBe(
      "42501",
    );
    for (const who of ["ownerB", "outsider", "firmAdmin"] as const) {
      for (const t of [
        "purchase_bills",
        "purchase_bill_lines",
        "supplier_payments",
        "supplier_payment_allocations",
        "purchase_categories",
        "purchase_settings",
      ]) {
        expect(
          await h.read(who, `select 1 from public.${t} where client_id = $1`, [A]),
          `${who} ${t}`,
        ).toEqual([]);
      }
      expect(
        await h.read(who, "select * from public.ap_reconciliation($1, '2026-12-31'::date)", [A]),
      ).toEqual([{ subledger_total: "0.00", ledger_balance: "0.00", difference: "0.00" }]);
    }
    expect(await h.errorOf("ownerA", "update public.purchase_bills set status = 'posted'")).toBe(
      "42501",
    );
    expect(
      await h.errorOf(
        "ownerA",
        "insert into public.withholding_codes (code, version, description, rate, base, legal_basis, effective_from) values ('ZZ1', 1, 'x', 0.1, 'gross', 'x basis', '2026-01-01')",
      ),
    ).toBe("42501");
  });
});
