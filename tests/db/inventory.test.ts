/**
 * Phase 9 inventory and cost of goods sold tests (PGlite). Synthetic data.
 * Costing: moving weighted average (PROPOSED, PENDING VERIFICATION).
 * Gate: stock quantities, inventory valuation and ledger balances agree.
 *
 * Widget (W) walk-through, all values worked by hand:
 *   09-01 opening receipt 10 @ 100.00                  qty 10  value 1,000.00
 *   09-02 bill: 10 @ 133.33 (net 1,333.30), not yet received
 *   09-03 receive 4 (533.32) and 6 (remainder 799.98)  qty 20  value 2,333.30
 *   09-04 issue 15 for invoice line 1 (1,749.98)       qty  5  value   583.32
 *   09-10 customer return 5 at issued cost (583.33)    qty 10  value 1,166.65
 *   09-11 transfer 2 MAIN -> STORE (233.33, no entry)  qty 10  value 1,166.65
 *   09-12 supplier return 1 (116.67)                   qty  9  value 1,049.98
 *   09-15 count shortage -1 at STORE (116.66)          qty  8  value   933.32
 *   09-15 count surplus +2 @ 120 (240.00), cancelled   qty  8  value   933.32
 *   09-20 issue all 8 from both locations (933.32)     qty  0  value     0.00
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db, type UserKey } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const PREP = "accountantB" as const;
const POST = "reviewerA" as const;
const item: Record<string, string> = {};
const loc: Record<string, string> = {};
let equity = "";
let supplier = "";
let customer = "";
let billId = "";
let invoiceId = "";
const mv: Record<string, string> = {};

const acct = async (code: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.accounts where client_id = $1 and code = $2",
      [A, code],
    )
  ).rows[0].id;

const SAVE_MV = "select public.save_inventory_movement($1, $2, $3, $4::jsonb, $5::jsonb, $6) as id";
type Line = Record<string, unknown>;
const line = (sku: string, quantity: string, extra: Line = {}): Line => ({
  item_id: item[sku],
  location_id: loc.MAIN,
  quantity,
  ...extra,
});
async function movement(
  type: string,
  date: string,
  lines: Line[],
  extra: Record<string, unknown> = {},
  who: UserKey = PREP,
  key = newKey("mv"),
) {
  const [r] = await h.run<{ id: string }>(who, SAVE_MV, [
    A,
    null,
    null,
    JSON.stringify({ movement_type: type, movement_date: date, ...extra }),
    JSON.stringify(lines),
    key,
  ]);
  return r.id;
}
const movementError = (type: string, date: string, lines: Line[], extra: Line = {}) =>
  h.errorOf(PREP, SAVE_MV, [
    A,
    null,
    null,
    JSON.stringify({ movement_type: type, movement_date: date, ...extra }),
    JSON.stringify(lines),
    newKey(),
  ]);
const submit = (subject: string, id: string) =>
  h.run(PREP, "select public.submit_sales_document($1::public.intake_subject, $2)", [subject, id]);
async function post(id: string) {
  await submit("inventory_movement", id);
  const [r] = await h.run<{ je: string | null }>(
    POST,
    "select public.post_inventory_movement($1) as je",
    [id],
  );
  return r.je;
}
async function postError(id: string) {
  await submit("inventory_movement", id);
  return h.messageOf(POST, "select public.post_inventory_movement($1)", [id]);
}
async function entryLines(je: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text, l.credit::text from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.entry_id = $1 order by a.code`,
    [je],
  );
  return rows.map((r) => [r.code, r.debit, r.credit]);
}
const itemState = async (sku: string) =>
  (
    await db.query<{ q: string; v: string }>(
      "select qty_on_hand::text q, value_on_hand::text v from public.inventory_items where id = $1",
      [item[sku]],
    )
  ).rows[0];
const atLocation = async (sku: string, code: string) =>
  (
    await db.query<{ q: string }>(
      "select coalesce((select quantity::text from public.inventory_stock where item_id = $1 and location_id = $2), '0') q",
      [item[sku], loc[code]],
    )
  ).rows[0].q;
const recon = async (asOf: string) =>
  (
    await h.read<{
      account_code: string;
      stock_value: string;
      billed_not_received: string;
      ledger_balance: string;
      difference: string;
    }>(POST, "select * from public.inventory_reconciliation($1, $2::date)", [A, asOf])
  )[0];
const valuation = async (asOf: string) =>
  Object.fromEntries(
    (
      await h.read<{ sku: string; quantity: string; value: string }>(
        POST,
        "select sku, quantity, value from public.inventory_valuation($1, $2::date)",
        [A, asOf],
      )
    ).map((r) => [r.sku, [r.quantity, r.value]]),
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
  await h.run(POST, "select public.apply_default_purchase_settings($1)", [A]);
  await h.run(POST, "select public.apply_default_sales_settings($1)", [A]);
  await h.run(POST, "select public.apply_default_inventory_settings($1)", [A]);
  const SAVE_CP = "select public.save_counterparty($1, null, null, $2::jsonb, $3) as id";
  for (const [key, fields] of Object.entries({
    supplier: { kind: "supplier", registered_name: "Sample Wholesale Corp.", tin: "333444555000" },
    customer: { kind: "customer", registered_name: "Sample Retail Inc.", tin: "444555666000" },
  })) {
    const [r] = await h.run<{ id: string }>(PREP, SAVE_CP, [A, JSON.stringify(fields), newKey()]);
    await h.run(PREP, "select public.transition_counterparty($1, 'submitted')", [r.id]);
    await h.run(PREP, "select public.transition_counterparty($1, 'approved')", [r.id]);
    if (key === "supplier") supplier = r.id;
    else customer = r.id;
  }
  equity = (
    await db.query<{ id: string }>(
      "select id from public.accounts where client_id = $1 and account_type = 'equity' and is_postable order by code limit 1",
      [A],
    )
  ).rows[0].id;
  for (const [code, name] of [
    ["MAIN", "Main warehouse"],
    ["STORE", "Store room"],
  ]) {
    const [r] = await h.run<{ id: string }>(
      PREP,
      "select public.save_inventory_location($1, null, $2, $3, true) as id",
      [A, code, name],
    );
    loc[code] = r.id;
  }
  const inv = await acct("1200");
  for (const [sku, name] of [
    ["W", "Widget"],
    ["G", "Gadget"],
    ["H", "Hinge"],
  ]) {
    const [r] = await h.run<{ id: string }>(
      PREP,
      "select public.save_inventory_item($1, null, $2, $3, 'pc', $4, true) as id",
      [A, sku, name, inv],
    );
    item[sku] = r.id;
  }
}, 60_000);

describe("master data and policy", () => {
  it("items need an asset account and a unique SKU; locations a unique code", async () => {
    const SAVE_ITEM = "select public.save_inventory_item($1, null, $2, 'x', 'pc', $3, true)";
    expect(await h.errorOf(PREP, SAVE_ITEM, [A, "X1", await acct("5010")])).toBe("22023");
    expect(await h.errorOf(PREP, SAVE_ITEM, [A, "w", await acct("1200")])).toBe("23505");
    expect(
      await h.errorOf(
        PREP,
        "select public.save_inventory_location($1, null, 'main', 'dup', true)",
        [A],
      ),
    ).toBe("23505");
    expect(await h.errorOf("ownerA", SAVE_ITEM, [A, "X2", await acct("1200")])).toBe("42501");
    let code: string | undefined;
    try {
      await db.query("delete from public.inventory_items where id = $1", [item.H]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("the costing method is recorded as pending verification", async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      "select costing_method, costing_status, allow_negative_stock from public.inventory_settings where client_id = $1",
      [A],
    );
    expect(rows[0]).toEqual({
      costing_method: "weighted_average",
      costing_status: "pending_verification",
      allow_negative_stock: false,
    });
  });
});

describe("receipts: opening stock and purchase bills without duplicate entries", () => {
  it("an opening receipt posts Dr Inventory / Cr the offset account; retries do not duplicate", async () => {
    const key = newKey("open");
    const lines = [line("W", "10", { unit_cost: "100" }), line("G", "2", { unit_cost: "50" })];
    const a = await movement(
      "receipt",
      "2026-09-01",
      lines,
      { offset_account_id: equity },
      PREP,
      key,
    );
    const b = await movement(
      "receipt",
      "2026-09-01",
      lines,
      { offset_account_id: equity },
      PREP,
      key,
    );
    expect(b).toBe(a);
    expect(await movementError("receipt", "2026-09-01", lines)).toBe("22023"); // no offset, no bill
    expect(await h.errorOf(PREP, "select public.post_inventory_movement($1)", [a])).toBe("42501");
    const je = await post(a);
    expect(je).toBeTruthy();
    const [again] = await h.run<{ je: string }>(
      POST,
      "select public.post_inventory_movement($1) as je",
      [a],
    );
    expect(again.je).toBe(je);
    const eqCode = (
      await db.query<{ code: string }>("select code from public.accounts where id = $1", [equity])
    ).rows[0].code;
    expect(await entryLines(je!)).toEqual([
      ["1200", "1100.00", "0.00"],
      [eqCode, "0.00", "1100.00"],
    ]);
    expect(await itemState("W")).toEqual({ q: "10.0000", v: "1000.00" });
    mv.opening = a;
  });

  it("a mover cannot post their own movement", async () => {
    const id = await movement(
      "adjustment",
      "2026-09-01",
      [line("H", "1", { unit_cost: "1" })],
      {},
      POST,
    );
    await h.run(POST, "select public.submit_sales_document('inventory_movement', $1)", [id]);
    expect(await h.errorOf(POST, "select public.post_inventory_movement($1)", [id])).toBe("42501");
    await h.run(POST, "select public.cancel_inventory_movement($1, 'test only')", [id]);
  });

  it("goods on a posted bill are received in parts at the bill's cost, with NO second entry", async () => {
    const merch = await h.run<{ id: string }>(
      PREP,
      "select public.propose_purchase_category($1, 'Merchandise inventory', 'inventory', $2) as id",
      [A, await acct("1200")],
    );
    await h.run(POST, "select public.approve_purchase_category($1)", [merch[0].id]);
    const [b] = await h.run<{ id: string }>(
      PREP,
      "select public.save_purchase_bill($1, null, null, $2::jsonb, $3::jsonb, null, $4) as id",
      [
        A,
        JSON.stringify({
          bill_type: "bill",
          counterparty_id: supplier,
          bill_no: "SUP-1001",
          bill_date: "2026-09-02",
        }),
        JSON.stringify([
          {
            description: "Widget",
            quantity: "10",
            unit_price: "133.33",
            tax_class: "vatable",
            vat_category: "goods",
            category_id: merch[0].id,
          },
        ]),
        newKey("bill"),
      ],
    );
    billId = b.id;
    await submit("purchase_bill", billId);
    await h.run(POST, "select public.post_purchase_bill($1)", [billId]);
    const glBefore = await recon("2026-09-02");
    expect(glBefore).toMatchObject({
      stock_value: "1100.00",
      billed_not_received: "1333.30",
      ledger_balance: "2433.30",
      difference: "0.00",
    });

    // goods cannot be received before the bill date
    const early = await movement("receipt", "2026-09-01", [line("W", "4", { bill_line_no: 1 })], {
      purchase_bill_id: billId,
    });
    expect(await postError(early)).toMatch(/before the bill date/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'wrong date')", [early]);

    const r1 = await movement("receipt", "2026-09-03", [line("W", "4", { bill_line_no: 1 })], {
      purchase_bill_id: billId,
    });
    expect(await post(r1)).toBeNull();
    const over = await movement("receipt", "2026-09-03", [line("W", "7", { bill_line_no: 1 })], {
      purchase_bill_id: billId,
    });
    expect(await postError(over)).toMatch(/only 6.0000 remain/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'over-receipt')", [over]);
    const r2 = await movement("receipt", "2026-09-03", [line("W", "6", { bill_line_no: 1 })], {
      purchase_bill_id: billId,
    });
    expect(await post(r2)).toBeNull();
    const { rows } = await db.query<{ v: string }>(
      "select value_change::text v from public.inventory_ledger where purchase_bill_id = $1 order by id",
      [billId],
    );
    expect(rows.map((r) => r.v)).toEqual(["533.32", "799.98"]);
    expect(await itemState("W")).toEqual({ q: "20.0000", v: "2333.30" });
    expect(await recon("2026-09-03")).toMatchObject({
      stock_value: "2433.30",
      billed_not_received: "0.00",
      ledger_balance: "2433.30",
      difference: "0.00",
    });
    // A fully received bill line cannot be received again.
    const dup = await movement("receipt", "2026-09-03", [line("W", "1", { bill_line_no: 1 })], {
      purchase_bill_id: billId,
    });
    expect(await postError(dup)).toMatch(/only 0.0000 remain/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'duplicate')", [dup]);
  });

  it("a bill with received goods cannot be cancelled until the receipts are", async () => {
    expect(
      await h.messageOf(POST, "select public.cancel_purchase_bill($1, 'test')", [billId]),
    ).toMatch(/stock movements are linked/);
  });
});

describe("issues, cost of goods sold and returns", () => {
  it("a sales issue posts only COGS at moving average, limited to the invoiced quantity", async () => {
    const [r] = await h.run<{ id: string }>(
      PREP,
      "select public.save_sales_invoice($1, null, null, $2::jsonb, $3::jsonb, $4) as id",
      [
        A,
        JSON.stringify({
          counterparty_id: customer,
          invoice_no: "SI-INV-1",
          invoice_date: "2026-09-04",
          due_date: "2026-10-04",
          sale_type: "credit",
        }),
        JSON.stringify([
          { description: "Widget", quantity: "15", unit_price: "200", tax_class: "vatable" },
        ]),
        newKey("inv"),
      ],
    );
    invoiceId = r.id;
    await submit("sales_invoice", invoiceId);
    await h.run(POST, "select public.post_sales_invoice($1)", [invoiceId]);

    const over = await movement("issue", "2026-09-04", [line("W", "16", { invoice_line_no: 1 })], {
      sales_invoice_id: invoiceId,
    });
    expect(await postError(over)).toMatch(/only 15.0000 remain/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'too many')", [over]);

    const id = await movement("issue", "2026-09-04", [line("W", "15", { invoice_line_no: 1 })], {
      sales_invoice_id: invoiceId,
    });
    const je = await post(id);
    expect(await entryLines(je!)).toEqual([
      ["1200", "0.00", "1749.98"],
      ["5010", "1749.98", "0.00"],
    ]);
    expect(await itemState("W")).toEqual({ q: "5.0000", v: "583.32" });
    // revenue was posted once by the invoice; the issue added no revenue lines
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int n from public.journal_entries where client_id = $1 and source_ref = $2",
      [A, id],
    );
    expect(rows[0].n).toBe(1);
    mv.issue = id;
  });

  it("an invoice with issued stock cannot be cancelled until the issue is", async () => {
    expect(
      await h.messageOf(POST, "select public.cancel_sales_invoice($1, 'test')", [invoiceId]),
    ).toMatch(/stock movements are linked/);
  });

  it("customer returns come back at the cost they were issued at, never more than issued", async () => {
    expect(await movementError("customer_return", "2026-09-10", [line("W", "1")])).toBe("22023"); // needs the invoice
    const id = await movement(
      "customer_return",
      "2026-09-10",
      [line("W", "5", { invoice_line_no: 1 })],
      { sales_invoice_id: invoiceId },
    );
    const je = await post(id);
    expect(await entryLines(je!)).toEqual([
      ["1200", "583.33", "0.00"],
      ["5010", "0.00", "583.33"],
    ]);
    expect(await itemState("W")).toEqual({ q: "10.0000", v: "1166.65" });
    const over = await movement(
      "customer_return",
      "2026-09-10",
      [line("W", "11", { invoice_line_no: 1 })],
      { sales_invoice_id: invoiceId },
    );
    expect(await postError(over)).toMatch(/only 10.0000 were issued and not yet returned/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'too many')", [over]);
    mv.customerReturn = id;
  });

  it("backdating before a later movement of the item is refused", async () => {
    const id = await movement("issue", "2026-09-05", [line("W", "1")]);
    expect(await postError(id)).toMatch(/a later stock movement exists/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'backdated')", [id]);
  });

  it("transfers move quantity and value between locations with no journal entry", async () => {
    const tooMany = await movement("transfer", "2026-09-11", [
      line("W", "3", { location_id: loc.STORE, to_location_id: loc.MAIN }),
    ]);
    expect(await postError(tooMany)).toMatch(/not enough stock/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'empty store')", [tooMany]);
    expect(
      await movementError("transfer", "2026-09-11", [line("W", "1", { to_location_id: loc.MAIN })]),
    ).toBe("22023"); // same location

    const id = await movement("transfer", "2026-09-11", [
      line("W", "2", { to_location_id: loc.STORE }),
    ]);
    expect(await post(id)).toBeNull();
    expect(await itemState("W")).toEqual({ q: "10.0000", v: "1166.65" });
    expect([await atLocation("W", "MAIN"), await atLocation("W", "STORE")]).toEqual([
      "8.0000",
      "2.0000",
    ]);
  });

  it("supplier returns and count adjustments post at average cost", async () => {
    const sr = await movement("supplier_return", "2026-09-12", [line("W", "1")], {
      reason: "Damaged on arrival",
    });
    expect(await entryLines((await post(sr))!)).toEqual([
      ["1130", "116.67", "0.00"],
      ["1200", "0.00", "116.67"],
    ]);
    const short = await movement(
      "adjustment",
      "2026-09-15",
      [line("W", "-1", { location_id: loc.STORE })],
      { reason: "Count shortage" },
    );
    expect(await entryLines((await post(short))!)).toEqual([
      ["1200", "0.00", "116.66"],
      ["6900", "116.66", "0.00"],
    ]);
    expect(await itemState("W")).toEqual({ q: "8.0000", v: "933.32" });
    const surplus = await movement(
      "adjustment",
      "2026-09-15",
      [line("W", "2", { unit_cost: "120" })],
      { reason: "Count surplus" },
    );
    expect(await entryLines((await post(surplus))!)).toEqual([
      ["1200", "240.00", "0.00"],
      ["6900", "0.00", "240.00"],
    ]);
    expect(await itemState("W")).toEqual({ q: "10.0000", v: "1173.32" });
    mv.surplus = surplus;
  });
});

describe("cancellation, closed periods and negative stock", () => {
  it("only the latest movement of an item can be cancelled; cancelling reverses stock and entry", async () => {
    expect(
      await h.messageOf(POST, "select public.cancel_inventory_movement($1, 'x reason')", [
        mv.customerReturn,
      ]),
    ).toMatch(/later stock movements exist/);
    expect(
      await h.errorOf(PREP, "select public.cancel_inventory_movement($1, 'x reason')", [
        mv.surplus,
      ]),
    ).toBe("42501");
    await h.run(POST, "select public.cancel_inventory_movement($1, 'Recount: no surplus')", [
      mv.surplus,
    ]);
    expect(await itemState("W")).toEqual({ q: "8.0000", v: "933.32" });
    const { rows } = await db.query<{ status: string; rev: string | null }>(
      "select status::text, cancel_journal_entry_id rev from public.inventory_movements where id = $1",
      [mv.surplus],
    );
    expect(rows[0].status).toBe("cancelled");
    expect(await entryLines(rows[0].rev!)).toEqual([
      ["1200", "0.00", "240.00"],
      ["6900", "240.00", "0.00"],
    ]);
  });

  it("issuing everything that remains leaves exactly zero value (no rounding residue)", async () => {
    const id = await movement("issue", "2026-09-20", [
      line("W", "7"),
      line("W", "1", { location_id: loc.STORE }),
    ]);
    expect(await entryLines((await post(id))!)).toEqual([
      ["1200", "0.00", "933.32"],
      ["5010", "933.32", "0.00"],
    ]);
    expect(await itemState("W")).toEqual({ q: "0.0000", v: "0.00" });
  });

  it("movements in a closed period are refused", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.accounting_periods where client_id = $1 and '2026-08-15'::date between start_date and end_date",
      [A],
    );
    await h.run(POST, "select public.set_period_status($1, 'soft_closed', 'month-end review')", [
      rows[0].id,
    ]);
    const id = await movement("receipt", "2026-08-15", [line("H", "5", { unit_cost: "10" })], {
      offset_account_id: equity,
    });
    expect(await postError(id)).toMatch(/period for 2026-08-15 is not open/);
    await h.run(PREP, "select public.cancel_inventory_movement($1, 'closed period')", [id]);
  });

  it("negative stock is refused unless a reviewer approves the policy with a reason", async () => {
    const id = await movement("issue", "2026-09-20", [line("G", "3")]);
    expect(await postError(id)).toMatch(/not enough stock of G/);
    const POLICY = "select public.set_negative_stock_policy($1, $2, $3)";
    expect(await h.errorOf(PREP, POLICY, [A, true, "Sell before delivery is booked"])).toBe(
      "42501",
    );
    expect(await h.errorOf(POST, POLICY, [A, true, "ok"])).toBe("22023");
    await h.run(POST, POLICY, [A, true, "Approved: deliveries booked next day"]);
    const [{ je }] = await h.run<{ je: string }>(
      POST,
      "select public.post_inventory_movement($1) as je",
      [id],
    );
    // 2 on hand at 100.00 + 1 short at the last cost of 50.00
    expect(await entryLines(je)).toEqual([
      ["1200", "0.00", "150.00"],
      ["5010", "150.00", "0.00"],
    ]);
    expect(await itemState("G")).toEqual({ q: "-1.0000", v: "-50.00" });
    await h.run(POST, POLICY, [A, false, null]);
    const again = await movement("issue", "2026-09-21", [line("G", "1")]);
    expect(await postError(again)).toMatch(/negative stock is not allowed/);
    const { rows } = await db.query<{ to_status: string }>(
      "select to_status from public.intake_events where client_id = $1 and subject_type = 'inventory_policy' order by id",
      [A],
    );
    expect(rows.map((r) => r.to_status)).toEqual([
      "negative_stock_allowed",
      "negative_stock_refused",
    ]);
  });
});

describe("GATE: stock quantities, valuation and ledger agree", () => {
  it("maintained balances equal the stock ledger", async () => {
    expect(await h.read(POST, "select * from public.inventory_quantity_check($1)", [A])).toEqual(
      [],
    );
  });

  it("valuation as of any date is consistent with the walk-through", async () => {
    expect((await valuation("2026-09-01")).W).toEqual(["10.0000", "1000.00"]);
    expect((await valuation("2026-09-04")).W).toEqual(["5.0000", "583.32"]);
    expect((await valuation("2026-09-12")).W).toEqual(["9.0000", "1049.98"]);
    expect((await valuation("2026-09-30")).W).toEqual(["0.0000", "0.00"]);
    expect((await valuation("2026-09-30")).G).toEqual(["-1.0000", "-50.00"]);
  });

  it("stock value + goods billed not received = inventory GL balance on every date; a manual entry shows", async () => {
    for (const asOf of [
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-10",
      "2026-09-15",
      "2026-09-30",
    ]) {
      expect({ asOf, d: (await recon(asOf))?.difference ?? "0.00" }).toEqual({ asOf, d: "0.00" });
    }
    const lines = JSON.stringify([
      { account_id: await acct("1200"), debit: "25.00", credit: "" },
      { account_id: await acct("6900"), debit: "", credit: "25.00" },
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

describe("permissions and isolation", () => {
  it("clients can read but not record; other tenants see nothing; no direct writes", async () => {
    expect(
      (await h.read("ownerA", "select 1 from public.inventory_ledger where client_id = $1", [A]))
        .length,
    ).toBeGreaterThan(0);
    expect(await h.errorOf("ownerA", SAVE_MV, [A, null, null, "{}", "[]", newKey()])).toBe("42501");
    for (const who of ["ownerB", "outsider", "firmAdmin"] as const) {
      for (const t of [
        "inventory_items",
        "inventory_locations",
        "inventory_stock",
        "inventory_movements",
        "inventory_movement_lines",
        "inventory_ledger",
        "inventory_settings",
      ]) {
        expect(
          await h.read(who, `select 1 from public.${t} where client_id = $1`, [A]),
          `${who} ${t}`,
        ).toEqual([]);
      }
      expect(
        await h.read(who, "select * from public.inventory_reconciliation($1, '2026-12-31'::date)", [
          A,
        ]),
      ).toEqual([]);
    }
    expect(await h.errorOf("ownerA", "update public.inventory_items set qty_on_hand = 999")).toBe(
      "42501",
    );
    expect(
      await h.errorOf(
        PREP,
        "select private.apply_stock_change(null::public.inventory_movements, 1::smallint, null, null, 1, 1, false, null, null, true)",
      ),
    ).toBe("42501");
    let code: string | undefined;
    try {
      await db.query("delete from public.inventory_ledger where client_id = $1", [A]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });
});
