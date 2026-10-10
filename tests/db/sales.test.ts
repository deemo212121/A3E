/**
 * Phase 7 sales and receivables tests (PGlite). Synthetic data only.
 * Expected amounts are worked out by hand and hard-coded (see
 * docs/sales/POSTING-RULES.md for the rules and rounding).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db, type UserKey } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;
const PREP = "accountantB" as const; // preparer on A
const POST = "reviewerA" as const; // reviewer on A
let hardware = ""; // customer with 30-day terms
let walkin = ""; // second customer
let cash = ""; // 1020 Cash in Bank

const acct = async (code: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.accounts where client_id = $1 and code = $2",
      [A, code],
    )
  ).rows[0].id;

const SAVE_INV = "select public.save_sales_invoice($1, $2, $3, $4::jsonb, $5::jsonb, $6) as id";
async function invoice(
  no: string,
  lines: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  who: UserKey = PREP,
  key = newKey("inv"),
) {
  const [r] = await h.run<{ id: string }>(who, SAVE_INV, [
    A,
    null,
    null,
    JSON.stringify({
      counterparty_id: hardware,
      invoice_no: no,
      invoice_date: "2026-09-01",
      sale_type: "credit",
      ...extra,
    }),
    JSON.stringify(lines),
    key,
  ]);
  return r.id;
}
const submit = (subject: string, id: string, who: UserKey = PREP) =>
  h.run(who, "select public.submit_sales_document($1::public.intake_subject, $2)", [subject, id]);
async function postInvoice(id: string) {
  await submit("sales_invoice", id);
  const [r] = await h.run<{ je: string }>(POST, "select public.post_sales_invoice($1) as je", [id]);
  return r.je;
}
async function receipt(
  no: string,
  header: Record<string, unknown>,
  allocations: Record<string, unknown>[],
  key = newKey("rc"),
) {
  const [r] = await h.run<{ id: string }>(
    PREP,
    "select public.save_sales_receipt($1, null, null, $2::jsonb, $3::jsonb, $4) as id",
    [
      A,
      JSON.stringify({
        counterparty_id: hardware,
        receipt_no: no,
        receipt_date: "2026-09-15",
        payment_method: "check",
        deposit_account_id: cash,
        ...header,
      }),
      JSON.stringify(allocations),
      key,
    ],
  );
  return r.id;
}
async function postReceipt(id: string) {
  await submit("sales_receipt", id);
  const [r] = await h.run<{ je: string }>(POST, "select public.post_sales_receipt($1) as je", [id]);
  return r.je;
}
async function entryLines(je: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text, l.credit::text from public.journal_lines l
       join public.accounts a on a.id = l.account_id where l.entry_id = $1 order by l.line_no`,
    [je],
  );
  return rows.map((r) => [r.code, r.debit, r.credit]);
}
async function balances(asOf: string) {
  return h.read<{ invoice_no: string; outstanding: string; paid: string; credited: string }>(
    POST,
    "select invoice_no, outstanding, paid, credited from public.sales_invoice_balances($1, $2::date) order by invoice_no",
    [A, asOf],
  );
}
async function recon(asOf: string) {
  const [r] = await h.read<{ subledger_total: string; ledger_balance: string; difference: string }>(
    POST,
    "select * from public.ar_reconciliation($1, $2::date)",
    [A, asOf],
  );
  return r;
}

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
  await h.run(POST, "select public.apply_default_sales_settings($1)", [A]);
  const SAVE_CP = "select public.save_counterparty($1, null, null, $2::jsonb, $3) as id";
  const [c1] = await h.run<{ id: string }>(PREP, SAVE_CP, [
    A,
    JSON.stringify({
      kind: "customer",
      registered_name: "Sample Hardware Inc.",
      tin: "777888999000",
    }),
    newKey(),
  ]);
  const [c2] = await h.run<{ id: string }>(PREP, SAVE_CP, [
    A,
    JSON.stringify({ kind: "both", registered_name: "Walk-in Buyer" }),
    newKey(),
  ]);
  for (const id of [c1.id, c2.id]) {
    await h.run(PREP, "select public.transition_counterparty($1, 'submitted')", [id]);
    await h.run(PREP, "select public.transition_counterparty($1, 'approved')", [id]);
  }
  await db.query("update public.counterparties set credit_terms_days = 30 where id = $1", [c1.id]);
  hardware = c1.id;
  walkin = c2.id;
  cash = await acct("1020");
}, 60_000);

describe("totals and rounding (computed by the database)", () => {
  const totals = async (id: string) =>
    (
      await db.query(
        `select gross_amount::text g, discount_amount::text d, vatable_sales::text v, exempt_sales::text e,
                vat_amount::text vat, total_amount::text t, due_date::text due from public.sales_invoices where id = $1`,
        [id],
      )
    ).rows[0];

  it("VAT-exclusive prices: per-line rounding to the centavo, half away from zero", async () => {
    const id = await invoice("SI-0001", [
      { description: "Furring 0.5mm", quantity: "3", unit_price: "33.3333", tax_class: "vatable" }, // 99.9999 -> 100.00, VAT 12.00
      { description: "Clip", quantity: "1", unit_price: "10.005", tax_class: "vatable" }, // 10.005 -> 10.01, VAT 1.2012 -> 1.20
      { description: "Exempt item", quantity: "2", unit_price: "25", tax_class: "exempt" }, // 50.00, no VAT
    ]);
    expect(await totals(id)).toEqual({
      g: "160.01",
      d: "0.00",
      v: "110.01",
      e: "50.00",
      vat: "13.20",
      t: "173.21",
      due: "2026-10-01",
    });
  });

  it("VAT-inclusive prices and discounts: VAT extracted per line; total = sum of line amounts", async () => {
    const id = await invoice(
      "SI-0002",
      [
        { description: "Steel coil", quantity: "1", unit_price: "1120", tax_class: "vatable" }, // VAT 120.00, net 1000.00
        { description: "Channel", quantity: "1", unit_price: "100", tax_class: "vatable" }, // VAT 10.71, net 89.29
        {
          description: "Studs",
          quantity: "2",
          unit_price: "560",
          discount_amount: "120",
          tax_class: "vatable",
        }, // 1000 -> VAT 107.14
      ],
      { prices_include_vat: true, due_date: "2026-09-30" },
    );
    expect(await totals(id)).toEqual({
      g: "2340.00",
      d: "120.00",
      v: "1982.15",
      e: "0.00",
      vat: "237.85",
      t: "2220.00",
      due: "2026-09-30",
    });
  });

  it("rejects bad input: discount above the line, future date, no lines, non-customer, missing due date", async () => {
    const bad = (lines: unknown[], extra: Record<string, unknown> = {}) =>
      h.errorOf(PREP, SAVE_INV, [
        A,
        null,
        null,
        JSON.stringify({
          counterparty_id: hardware,
          invoice_no: `BAD-${newKey()}`,
          invoice_date: "2026-09-01",
          sale_type: "credit",
          ...extra,
        }),
        JSON.stringify(lines),
        newKey(),
      ]);
    const line = { description: "x", quantity: "1", unit_price: "10", tax_class: "vatable" };
    expect(await bad([{ ...line, discount_amount: "10" }])).toBe("22023");
    expect(await bad([line], { invoice_date: "2099-01-01" })).toBe("22023");
    expect(await bad([])).toBe("22023");
    expect(await bad([{ ...line, unit_price: "1.23456" }])).toBe("22023");
    expect(await bad([{ ...line, tax_class: "" }])).toBe("22023");
    expect(await bad([line], { counterparty_id: walkin, due_date: "" })).toBe("22023"); // no terms, no due date
    expect(await bad([line], { counterparty_id: IDS.clientB })).toBe("22023");
  });

  it("duplicate invoice numbers are refused; a retried request returns the same invoice", async () => {
    const key = newKey("retry");
    const line = [{ description: "x", quantity: "1", unit_price: "10", tax_class: "vatable" }];
    const a = await invoice("SI-RETRY", line, {}, PREP, key);
    const b = await invoice("SI-RETRY", line, {}, PREP, key);
    expect(b).toBe(a);
    expect(
      await h.errorOf(PREP, SAVE_INV, [
        A,
        null,
        null,
        JSON.stringify({
          counterparty_id: hardware,
          invoice_no: "si-retry",
          invoice_date: "2026-09-01",
          sale_type: "credit",
        }),
        JSON.stringify(line),
        newKey(),
      ]),
    ).toBe("23505");
  });
});

describe("posting: approved invoices become balanced journal entries", () => {
  let id = "";
  let je = "";

  it("only a reviewer other than the preparer can post", async () => {
    id = (
      await db.query<{ id: string }>(
        "select id from public.sales_invoices where invoice_no = 'SI-0001'",
      )
    ).rows[0].id;
    await submit("sales_invoice", id);
    expect(await h.errorOf(PREP, "select public.post_sales_invoice($1)", [id])).toBe("42501");
    const own = await invoice(
      "SI-OWN",
      [{ description: "x", quantity: "1", unit_price: "5", tax_class: "vatable" }],
      {},
      POST,
    );
    await submit("sales_invoice", own, POST);
    expect(await h.errorOf(POST, "select public.post_sales_invoice($1)", [own])).toBe("42501");
    const [r] = await h.run<{ je: string }>(POST, "select public.post_sales_invoice($1) as je", [
      id,
    ]);
    je = r.je;
  });

  it("Dr receivables = total; Cr sales = net; Cr output VAT = VAT", async () => {
    expect(await entryLines(je)).toEqual([
      ["1100", "173.21", "0.00"],
      ["4010", "0.00", "160.01"],
      ["2100", "0.00", "13.20"],
    ]);
  });

  it("posting again (retry) returns the same entry; posted invoices are frozen", async () => {
    const [r] = await h.run<{ je: string }>(POST, "select public.post_sales_invoice($1) as je", [
      id,
    ]);
    expect(r.je).toBe(je);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int n from public.journal_entries where source_type = 'sales_invoice' and source_ref = $1",
      [id],
    );
    expect(rows[0].n).toBe(1);
    expect(
      await h.errorOf(PREP, SAVE_INV, [
        A,
        id,
        3,
        JSON.stringify({
          counterparty_id: hardware,
          invoice_no: "SI-0001",
          invoice_date: "2026-09-01",
        }),
        "[]",
        newKey(),
      ]),
    ).toBe("22023");
    let code: string | undefined;
    try {
      await db.query("update public.sales_invoices set total_amount = 1 where id = $1", [id]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("a returned invoice goes back to draft with the reviewer's comment", async () => {
    const r = await invoice("SI-RETURN", [
      { description: "x", quantity: "1", unit_price: "5", tax_class: "vatable" },
    ]);
    await submit("sales_invoice", r);
    expect(
      await h.errorOf(PREP, "select public.return_sales_document('sales_invoice', $1, 'fix')", [r]),
    ).toBe("42501");
    await h.run(
      POST,
      "select public.return_sales_document('sales_invoice', $1, 'Wrong customer')",
      [r],
    );
    const { rows } = await db.query(
      "select status::text, review_comment from public.sales_invoices where id = $1",
      [r],
    );
    expect(rows[0]).toEqual({ status: "draft", review_comment: "Wrong customer" });
  });
});

describe("receipts: partial payments, withholding, overpayment, duplicates", () => {
  let inv2 = "";

  it("partial payments reduce the balance step by step", async () => {
    inv2 = (
      await db.query<{ id: string }>(
        "select id from public.sales_invoices where invoice_no = 'SI-0002'",
      )
    ).rows[0].id;
    await postInvoice(inv2); // total 2220.00
    const r1 = await receipt("OR-5001", { amount_received: "1000" }, [
      { invoice_id: inv2, amount: "1000" },
    ]);
    await postReceipt(r1);
    expect((await balances("2026-09-30")).find((b) => b.invoice_no === "SI-0002")).toMatchObject({
      paid: "1000.00",
      outstanding: "1220.00",
    });
    // 2nd payment: 1,000 cash + 20.00 withheld by the customer (as stated on its certificate)
    const r2 = await receipt("OR-5002", { amount_received: "1000", withholding_amount: "20" }, [
      { invoice_id: inv2, amount: "1020" },
    ]);
    const je2 = await postReceipt(r2);
    expect(await entryLines(je2)).toEqual([
      ["1020", "1000.00", "0.00"],
      ["1320", "20.00", "0.00"],
      ["1100", "0.00", "1020.00"],
    ]);
    expect((await balances("2026-09-30")).find((b) => b.invoice_no === "SI-0002")).toMatchObject({
      outstanding: "200.00",
    });
  });

  it("an overpayment settles the invoice and the rest becomes a customer advance", async () => {
    const r3 = await receipt("OR-5003", { amount_received: "500" }, [
      { invoice_id: inv2, amount: "200" },
    ]);
    expect(await entryLines(await postReceipt(r3))).toEqual([
      ["1020", "500.00", "0.00"],
      ["1100", "0.00", "200.00"],
      ["2040", "0.00", "300.00"],
    ]);
    expect((await balances("2026-09-30")).find((b) => b.invoice_no === "SI-0002")).toMatchObject({
      outstanding: "0.00",
    });
  });

  it("two receipts racing for the same balance: the second is refused at posting", async () => {
    const inv = await invoice("SI-RACE", [
      { description: "x", quantity: "1", unit_price: "100", tax_class: "exempt" },
    ]);
    await postInvoice(inv);
    const a = await receipt("OR-6001", { amount_received: "100" }, [
      { invoice_id: inv, amount: "100" },
    ]);
    const b = await receipt("OR-6002", { amount_received: "100" }, [
      { invoice_id: inv, amount: "100" },
    ]);
    await submit("sales_receipt", a);
    await submit("sales_receipt", b);
    await h.run(POST, "select public.post_sales_receipt($1)", [a]);
    expect(await h.messageOf(POST, "select public.post_sales_receipt($1)", [b])).toMatch(
      /only 0.00 is outstanding/,
    );
  });

  it("applying more than the receipt, to another customer's invoice, or twice is refused", async () => {
    const inv = await invoice("SI-ALLOC", [
      { description: "x", quantity: "1", unit_price: "50", tax_class: "exempt" },
    ]);
    await postInvoice(inv);
    const SAVE = "select public.save_sales_receipt($1, null, null, $2::jsonb, $3::jsonb, $4)";
    const hdr = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        counterparty_id: hardware,
        receipt_no: `OR-X-${newKey()}`,
        receipt_date: "2026-09-15",
        deposit_account_id: cash,
        amount_received: "10",
        ...extra,
      });
    expect(
      await h.errorOf(PREP, SAVE, [
        A,
        hdr(),
        JSON.stringify([{ invoice_id: inv, amount: "11" }]),
        newKey(),
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf(PREP, SAVE, [
        A,
        hdr({ counterparty_id: walkin }),
        JSON.stringify([{ invoice_id: inv, amount: "5" }]),
        newKey(),
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf(PREP, SAVE, [
        A,
        hdr(),
        JSON.stringify([
          { invoice_id: inv, amount: "5" },
          { invoice_id: inv, amount: "5" },
        ]),
        newKey(),
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf(PREP, SAVE, [
        A,
        hdr({ deposit_account_id: await acct("4010") }),
        "[]",
        newKey(),
      ]),
    ).toBe("22023");
  });

  it("duplicate receipt numbers are refused; retries return the same receipt", async () => {
    const key = newKey("rcretry");
    const a = await receipt("OR-7000", { amount_received: "1" }, [], key);
    const b = await receipt("OR-7000", { amount_received: "1" }, [], key);
    expect(b).toBe(a);
    expect(
      await h.messageOf(
        PREP,
        "select public.save_sales_receipt($1, null, null, $2::jsonb, '[]'::jsonb, $3)",
        [
          A,
          JSON.stringify({
            counterparty_id: hardware,
            receipt_no: "or-7000",
            receipt_date: "2026-09-15",
            deposit_account_id: cash,
            amount_received: "1",
          }),
          newKey(),
        ],
      ),
    ).toMatch(/already recorded \(duplicate\)/);
  });
});

describe("credit notes, cancellations and reversals", () => {
  let inv = "";
  let rc = "";

  it("a credit note reduces the balance and reverses sales and VAT; it can never exceed the balance", async () => {
    inv = await invoice("SI-CN", [
      { description: "Coil", quantity: "1", unit_price: "200", tax_class: "vatable" },
    ]); // 224.00
    await postInvoice(inv);
    const SAVE = "select public.save_credit_note($1, null, null, $2::jsonb, $3::jsonb, $4) as id";
    const hdr = (no: string) =>
      JSON.stringify({
        invoice_id: inv,
        credit_note_no: no,
        credit_date: "2026-09-10",
        reason_type: "return",
        reason: "Damaged item returned",
      });
    const [big] = await h.run<{ id: string }>(PREP, SAVE, [
      A,
      hdr("CN-BIG"),
      JSON.stringify([{ description: "All", amount: "250", tax_class: "vatable" }]),
      newKey(),
    ]);
    await submit("credit_note", big.id);
    expect(await h.messageOf(POST, "select public.post_credit_note($1)", [big.id])).toMatch(
      /more than the invoice balance/,
    );
    expect(
      await h.errorOf(PREP, SAVE, [
        A,
        hdr("CN-EX"),
        JSON.stringify([{ amount: "5", tax_class: "exempt" }]),
        newKey(),
      ]),
    ).toBe("22023");
    const [cn] = await h.run<{ id: string }>(PREP, SAVE, [
      A,
      hdr("CN-001"),
      JSON.stringify([{ description: "Return", amount: "20", tax_class: "vatable" }]),
      newKey(),
    ]);
    await submit("credit_note", cn.id);
    const [{ je }] = await h.run<{ je: string }>(POST, "select public.post_credit_note($1) as je", [
      cn.id,
    ]);
    expect(await entryLines(je)).toEqual([
      ["4030", "20.00", "0.00"],
      ["2100", "2.40", "0.00"],
      ["1100", "0.00", "22.40"],
    ]);
    expect((await balances("2026-09-30")).find((b) => b.invoice_no === "SI-CN")).toMatchObject({
      credited: "22.40",
      outstanding: "201.60",
    });
  });

  it("a posted invoice with payments or credits cannot be cancelled", async () => {
    rc = await receipt("OR-8001", { amount_received: "100" }, [{ invoice_id: inv, amount: "100" }]);
    await postReceipt(rc);
    expect(
      await h.messageOf(POST, "select public.cancel_sales_invoice($1, 'wrong customer')", [inv]),
    ).toMatch(/cancel those receipts first/);
  });

  it("a bounced check: cancelling the receipt reverses it and the invoice is outstanding again", async () => {
    expect(
      await h.errorOf(PREP, "select public.cancel_sales_receipt($1, 'check bounced')", [rc]),
    ).toBe("42501");
    await h.run(
      POST,
      "select public.cancel_sales_receipt($1, 'Check bounced', '2026-09-20'::date)",
      [rc],
    );
    expect((await balances("2026-09-30")).find((b) => b.invoice_no === "SI-CN")).toMatchObject({
      paid: "0.00",
      outstanding: "201.60",
    });
    // As of a date before the bounce, the payment still counted.
    expect((await balances("2026-09-16")).find((b) => b.invoice_no === "SI-CN")).toMatchObject({
      outstanding: "101.60",
    });
  });

  it("after cancelling its credit note, the invoice is cancelled by a reversing entry and its number is free again", async () => {
    const cn = (
      await db.query<{ id: string }>(
        "select id from public.sales_credit_notes where credit_note_no = 'CN-001'",
      )
    ).rows[0].id;
    await h.run(POST, "select public.cancel_credit_note($1, 'Return refused')", [cn]);
    expect(
      await h.messageOf(
        POST,
        "select public.cancel_sales_invoice($1, 'backdated', '2026-09-02'::date)",
        [inv],
      ),
    ).toMatch(/cannot be before 2026-09-20/);
    await h.run(
      POST,
      "select public.cancel_sales_invoice($1, 'Recorded under the wrong customer')",
      [inv],
    );
    const { rows } = await db.query<{ status: string; je: string; rev: string }>(
      "select status::text, journal_entry_id je, cancel_journal_entry_id rev from public.sales_invoices where id = $1",
      [inv],
    );
    expect(rows[0].status).toBe("cancelled");
    const states = await db.query<{ status: string }>(
      "select status::text from public.journal_entries where id = any($1) order by entry_no",
      [[rows[0].je, rows[0].rev]],
    );
    expect(states.rows.map((r) => r.status)).toEqual(["reversed", "posted"]);
    expect(
      await h.errorOf(PREP, SAVE_INV, [
        A,
        null,
        null,
        JSON.stringify({
          counterparty_id: hardware,
          invoice_no: "SI-CN",
          invoice_date: "2026-09-02",
          due_date: "2026-09-30",
        }),
        JSON.stringify([
          { description: "x", quantity: "1", unit_price: "1", tax_class: "vatable" },
        ]),
        newKey(),
      ]),
    ).toBeUndefined();
  });
});

describe("balances, aging and ledger reconciliation", () => {
  it("the receivables subledger equals the general ledger, at any date", async () => {
    for (const asOf of ["2026-09-01", "2026-09-16", "2026-09-30"]) {
      const r = await recon(asOf);
      expect({ asOf, difference: r.difference }).toEqual({ asOf, difference: "0.00" });
    }
    const r = await recon("2026-09-30");
    // SI-0001 173.21 + SI-0002 0 + SI-RACE 0 + SI-ALLOC 50.00 (cancelled SI-CN excluded)
    expect(r).toEqual({ subledger_total: "223.21", ledger_balance: "223.21", difference: "0.00" });
  });

  it("aging buckets by days past due", async () => {
    const rows = await h.read<{
      customer_name: string;
      not_due: string;
      days_1_30: string;
      days_31_60: string;
      total: string;
    }>(
      POST,
      "select customer_name, not_due, days_1_30, days_31_60, total from public.ar_aging($1, '2026-11-15'::date)",
      [A],
    );
    // SI-0001 due 2026-10-01 (45 days late); SI-ALLOC due 2026-10-01 too.
    expect(rows).toEqual([
      {
        customer_name: "Sample Hardware Inc.",
        not_due: "0.00",
        days_1_30: "0.00",
        days_31_60: "223.21",
        total: "223.21",
      },
    ]);
  });

  it("a manual journal entry to receivables shows up as a reconciliation difference", async () => {
    const lines = JSON.stringify([
      { account_id: await acct("1100"), debit: "10.00", credit: "" },
      { account_id: await acct("4100"), debit: "", credit: "10.00" },
    ]);
    const [{ id }] = await h.run<{ id: string }>(
      PREP,
      "select public.save_draft_entry($1, null, '2026-09-25'::date, 'general', 'manual', null, null, $2, $3::jsonb) as id",
      [A, newKey(), lines],
    );
    await h.run(PREP, "select public.submit_entry($1)", [id]);
    await h.run(POST, "select public.approve_and_post($1)", [id]);
    expect(await recon("2026-09-30")).toEqual({
      subledger_total: "223.21",
      ledger_balance: "233.21",
      difference: "10.00",
    });
  });
});

describe("intake link, permissions and isolation", () => {
  it("an approved intake sale becomes an invoice; posting marks it posted; it cannot also be booked by journal", async () => {
    const t = await h.saveTxn("ownerA", A, {
      kind: "sale",
      txn_date: "2026-09-05",
      document_ref: "SI-INTAKE",
      counterparty_name: "Sample Hardware Inc.",
      gross_amount: "112.00",
    });
    await h.transitionTxn("ownerA", t, "submitted");
    await h.transitionTxn(PREP, t, "reviewed");
    await h.transitionTxn(POST, t, "approved");
    const inv = await invoice(
      "SI-INTAKE",
      [{ description: "From client", quantity: "1", unit_price: "112", tax_class: "vatable" }],
      { intake_transaction_id: t, prices_include_vat: true },
    );
    const lines = JSON.stringify([
      { account_id: await acct("1100"), debit: "112.00", credit: "" },
      { account_id: await acct("4010"), debit: "", credit: "112.00" },
    ]);
    expect(
      await h.errorOf(
        PREP,
        "select public.save_draft_entry($1, null, '2026-09-05'::date, 'general', 'x', 'intake_transaction', $2, $3, $4::jsonb)",
        [A, t, newKey(), lines],
      ),
    ).toBe("22023");
    const je = await postInvoice(inv);
    expect(await h.txn(t)).toMatchObject({ status: "posted", journal_entry_id: je });
    await h.run(POST, "select public.cancel_sales_invoice($1, 'Wrong amount')", [inv]);
    expect(await h.txn(t)).toMatchObject({ status: "approved", journal_entry_id: null });
  });

  it("clients can read their receivables but not record or post; other tenants see nothing", async () => {
    expect(
      (await h.read("ownerA", "select 1 from public.sales_invoices where client_id = $1", [A]))
        .length,
    ).toBeGreaterThan(0);
    expect(await h.errorOf("ownerA", SAVE_INV, [A, null, null, "{}", "[]", newKey()])).toBe(
      "42501",
    );
    for (const who of ["ownerB", "outsider", "firmAdmin"] as const) {
      for (const t of [
        "sales_invoices",
        "sales_receipts",
        "sales_credit_notes",
        "sales_receipt_allocations",
        "sales_settings",
      ]) {
        expect(
          await h.read(who, `select 1 from public.${t} where client_id = $1`, [A]),
          `${who} ${t}`,
        ).toEqual([]);
      }
      expect(
        await h.read(who, "select * from public.sales_invoice_balances($1, '2026-12-31'::date)", [
          A,
        ]),
      ).toEqual([]);
    }
    expect(
      await h.errorOf(
        "ownerB",
        "select public.post_sales_invoice(id) from public.sales_invoices limit 1",
      ),
    ).toBeUndefined(); // sees no rows
    expect(await h.errorOf("ownerA", "update public.sales_invoices set status = 'posted'")).toBe(
      "42501",
    );
    expect(await h.errorOf("ownerA", "select public.apply_default_sales_settings($1)", [A])).toBe(
      "42501",
    );
    expect(B).not.toBe(A);
  });
});
