/**
 * Phase 6 intake workflow tests (PGlite). Synthetic data only.
 *
 * Gate: one valid submission is recorded exactly once, and a retry never
 * duplicates it. Also: required fields, workflow statuses and who may change
 * them, feedback/resubmission, tracking, the ledger link, and isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db } from "./harness";
import { intake, newKey, purchase } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  // accountantB also prepares for client A (the reviewer is reviewerA).
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  h = intake(db);
}, 60_000);

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

describe("who may record transactions", () => {
  it("client owner, client staff and assigned firm staff may; others may not", async () => {
    for (const who of ["ownerA", "staffA", "accountantB", "reviewerA", "manager"] as const) {
      expect(
        await h.saveTxnError(who, A, purchase({ document_ref: `OR-W-${who}` })),
      ).toBeUndefined();
    }
    for (const who of ["viewerA", "ownerB", "outsider", "firmAdmin"] as const) {
      expect(await h.saveTxnError(who, A, purchase({ document_ref: `OR-X-${who}` }))).toBe("42501");
    }
  });

  it("records the source: portal for client users, staff for firm staff", async () => {
    const mine = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-SRC-1" }));
    const staff = await h.saveTxn("accountantB", A, purchase({ document_ref: "OR-SRC-2" }));
    expect((await h.txn(mine)).source).toBe("portal");
    expect((await h.txn(staff)).source).toBe("staff");
  });
});

describe("GATE: one valid submission, never duplicated on retry", () => {
  it("replaying the same request key returns the same transaction (no second row)", async () => {
    const key = newKey("retry");
    const first = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-RETRY" }), { key });
    const again = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-RETRY" }), { key });
    const third = await h.saveTxn(
      "ownerA",
      A,
      purchase({ document_ref: "OR-RETRY", gross_amount: "1.00" }),
      {
        key,
      },
    );
    expect(again).toBe(first);
    expect(third).toBe(first);
    expect(
      await count(
        "select count(*) as n from public.intake_transactions where document_ref = 'OR-RETRY'",
      ),
    ).toBe(1);
    // The replay did not change the stored amount.
    expect((await h.txn(first)).gross).toBe("2240.00");
  });

  it("re-entering the same receipt from the same supplier is rejected as a duplicate", async () => {
    await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-DUP" }));
    expect(await h.saveTxnError("staffA", A, purchase({ document_ref: "or-dup" }))).toBe("23505");
    // Same number typed with a differently formatted TIN is still the same supplier.
    expect(
      await h.saveTxnError(
        "staffA",
        A,
        purchase({ document_ref: "OR-DUP", counterparty_tin: "111-222-333-000" }),
      ),
    ).toBe("23505");
    const msg = await h.messageOf(
      "staffA",
      "select public.save_intake_transaction($1, null, null, $2::jsonb, '[]'::jsonb, null, $3)",
      [A, JSON.stringify(purchase({ document_ref: "OR-DUP" })), newKey()],
    );
    expect(msg).toMatch(/already recorded \(duplicate\)/);
  });

  it("a different supplier or a different kind with the same number is not a duplicate", async () => {
    await h.saveTxn("ownerA", A, purchase({ document_ref: "SI-77" }));
    expect(
      await h.saveTxnError(
        "ownerA",
        A,
        purchase({ document_ref: "SI-77", counterparty_tin: "999888777000" }),
      ),
    ).toBeUndefined();
    expect(
      await h.saveTxnError("ownerA", A, purchase({ document_ref: "SI-77", kind: "expense" })),
    ).toBeUndefined();
  });

  it("submitting twice (retry) is a no-op, recorded once in the history", async () => {
    const id = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-SUB2" }));
    await h.transitionTxn("ownerA", id, "submitted");
    await h.transitionTxn("ownerA", id, "submitted");
    expect((await h.txn(id)).status).toBe("submitted");
    expect(
      await count(
        "select count(*) as n from public.intake_events where subject_id = $1 and to_status = 'submitted'",
        [id],
      ),
    ).toBe(1);
  });

  it("a cancelled transaction frees its number for a corrected entry", async () => {
    const id = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-CANCEL" }));
    await h.transitionTxn("ownerA", id, "cancelled");
    expect(
      await h.saveTxnError("ownerA", A, purchase({ document_ref: "OR-CANCEL" })),
    ).toBeUndefined();
  });
});

describe("required fields and validation", () => {
  it("drafts may be incomplete; submission requires the fields for the kind", async () => {
    const id = await h.saveTxn("ownerA", A, { kind: "sale", txn_date: "2026-09-01" });
    const msg = await h.messageOf(
      "ownerA",
      "select public.transition_intake_transaction($1, 'submitted')",
      [id],
    );
    expect(msg).toMatch(/total amount/);
    expect(msg).toMatch(/customer\/supplier name/);
    expect(msg).toMatch(/invoice\/receipt number/);
  });

  it("rejects a future date, mismatched lines, and malformed values", async () => {
    const future = await h.saveTxn(
      "ownerA",
      A,
      purchase({ document_ref: "OR-FUT", txn_date: "2099-01-01" }),
    );
    expect(await h.transitionTxnError("ownerA", future, "submitted")).toBe("22023");

    const lines = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-LINES" }), {
      lines: [
        { description: "Diesel", amount: "2000.00" },
        { description: "Oil", amount: "200.00" },
      ],
    });
    expect(
      await h.messageOf("ownerA", "select public.transition_intake_transaction($1, 'submitted')", [
        lines,
      ]),
    ).toMatch(/lines add up to 2200.00 but the total is 2240.00/);

    expect(await h.saveTxnError("ownerA", A, purchase({ gross_amount: "12.345" }))).toBe("22023");
    expect(await h.saveTxnError("ownerA", A, purchase({ gross_amount: "-5" }))).toBe("22023");
    expect(await h.saveTxnError("ownerA", A, purchase({ counterparty_tin: "12345" }))).toBe(
      "22023",
    );
    expect(await h.saveTxnError("ownerA", A, purchase({ txn_date: "09/03/2026" }))).toBe("22023");
    expect(await h.saveTxnError("ownerA", A, purchase({ kind: "" }))).toBe("22023");
    expect(await h.saveTxnError("ownerA", A, purchase({ vat_amount_stated: "9999.00" }))).toBe(
      "23514",
    );
    expect(
      await h.saveTxnError("ownerA", A, purchase({ document_ref: "OR-L0" }), {
        lines: [{ amount: "0" }],
      }),
    ).toBe("22023");
  });

  it("a simple transaction without lines gets one line equal to the total", async () => {
    const id = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-ONE" }));
    const { rows } = await db.query<{ amount: string }>(
      "select amount::text from public.intake_transaction_lines where transaction_id = $1",
      [id],
    );
    expect(rows).toEqual([{ amount: "2240.00" }]);
  });
});

describe("workflow: review, feedback, resubmission, approval", () => {
  let id = "";

  it("client submits; client users cannot review or approve", async () => {
    id = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-FLOW" }));
    await h.transitionTxn("ownerA", id, "submitted");
    expect(await h.transitionTxnError("ownerA", id, "reviewed")).toBe("42501");
    expect(await h.transitionTxnError("staffA", id, "needs_correction", "please fix")).toBe(
      "42501",
    );
    expect(await h.saveTxnError("ownerA", A, purchase(), { id, version: 2 })).toBe("22023"); // not editable
  });

  it("staff request a correction (comment required); the client edits and resubmits", async () => {
    expect(await h.transitionTxnError("accountantB", id, "needs_correction")).toBe("22023");
    await h.transitionTxn("accountantB", id, "needs_correction", "Attach the official receipt");
    const before = await h.txn(id);
    // A stale version (someone else edited meanwhile) is refused.
    expect(
      await h.saveTxnError("ownerA", A, purchase({ document_ref: "OR-FLOW" }), {
        id,
        version: Number(before.row_version) - 1,
      }),
    ).toBe("40001");
    await h.saveTxn(
      "ownerA",
      A,
      purchase({ document_ref: "OR-FLOW", description: "Diesel (corrected)" }),
      {
        id,
        version: Number(before.row_version),
      },
    );
    await h.transitionTxn("ownerA", id, "submitted");
    expect((await h.txn(id)).description).toBe("Diesel (corrected)");
  });

  it("a preparer reviews; a preparer cannot approve; the reviewer cannot approve their own review", async () => {
    await h.transitionTxn("reviewerA", id, "reviewed");
    expect(await h.transitionTxnError("reviewerA", id, "approved")).toBe("42501"); // SoD
    expect(await h.transitionTxnError("accountantB", id, "approved")).toBe("42501"); // role
    await h.transitionTxn("manager", id, "approved");
    const t = await h.txn(id);
    expect(t.status).toBe("approved");
    expect(t.reviewed_by).toBe(IDS.reviewerA);
    expect(t.approved_by).toBe(IDS.manager);
  });

  it("approved content is frozen, even for the table owner", async () => {
    expect(await h.saveTxnError("manager", A, purchase(), { id, version: 99 })).toBe("22023");
    let code: string | undefined;
    try {
      await db.query("update public.intake_transactions set gross_amount = 1 where id = $1", [id]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
    let lineCode: string | undefined;
    try {
      await db.query("delete from public.intake_transaction_lines where transaction_id = $1", [id]);
    } catch (e) {
      lineCode = (e as { code?: string }).code;
    }
    expect(lineCode).toBe("42501");
  });

  it("invalid transitions are refused (e.g. approved -> rejected, draft -> approved)", async () => {
    expect(await h.transitionTxnError("manager", id, "rejected", "no")).toBe("22023");
    const d = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-DRAFT-APPROVE" }));
    expect(await h.transitionTxnError("manager", d, "approved")).toBe("22023");
    expect(await h.transitionTxnError("manager", d, "posted")).toBe("22023");
  });

  it("the full history is tracked in order and cannot be altered", async () => {
    const { rows } = await db.query<{
      from_status: string | null;
      to_status: string;
      comment: string | null;
    }>(
      "select from_status, to_status, comment from public.intake_events where subject_id = $1 order by id",
      [id],
    );
    expect(rows.map((r) => `${r.from_status ?? "-"}>${r.to_status}`)).toEqual([
      "->draft",
      "draft>submitted",
      "submitted>needs_correction",
      "needs_correction>submitted",
      "submitted>reviewed",
      "reviewed>approved",
    ]);
    expect(rows[2].comment).toBe("Attach the official receipt");
    expect(await h.errorOf("ownerA", "update public.intake_events set comment = 'x'")).toBe(
      "42501",
    );
    let code: string | undefined;
    try {
      await db.query("delete from public.intake_events where subject_id = $1", [id]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });

  it("rejection requires an approver and a reason", async () => {
    const r = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-REJ" }));
    await h.transitionTxn("ownerA", r, "submitted");
    expect(await h.transitionTxnError("accountantB", r, "rejected", "not ours")).toBe("42501");
    expect(await h.transitionTxnError("reviewerA", r, "rejected")).toBe("22023");
    await h.transitionTxn("reviewerA", r, "rejected", "Not a business expense");
    expect((await h.txn(r)).status).toBe("rejected");
  });
});

describe("comments and feedback", () => {
  let id = "";
  beforeAll(async () => {
    id = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-CMT" }));
  });
  const ADD = "select public.add_intake_comment($1, 'transaction', $2, $3, $4, $5) as id";

  it("client users and staff can comment; internal notes are hidden from the client", async () => {
    await h.run("ownerA", ADD, [A, id, "Receipt is attached", "client", newKey()]);
    await h.run("accountantB", ADD, [
      A,
      id,
      "Checked against bank statement",
      "internal",
      newKey(),
    ]);
    const asClient = await h.read<{ body: string }>(
      "ownerA",
      "select body from public.intake_comments where subject_id = $1 order by created_at",
      [id],
    );
    const asStaff = await h.read<{ body: string }>(
      "reviewerA",
      "select body from public.intake_comments where subject_id = $1",
      [id],
    );
    expect(asClient.map((c) => c.body)).toEqual(["Receipt is attached"]);
    expect(asStaff).toHaveLength(2);
  });

  it("clients cannot write internal notes; viewers cannot comment; other tenants cannot see", async () => {
    expect(await h.errorOf("ownerA", ADD, [A, id, "x", "internal", newKey()])).toBe("42501");
    expect(await h.errorOf("viewerA", ADD, [A, id, "x", "client", newKey()])).toBe("42501");
    expect(await h.errorOf("ownerB", ADD, [A, id, "x", "client", newKey()])).toBe("P0002");
    expect(await h.errorOf("ownerB", ADD, [B, id, "x", "client", newKey()])).toBe("P0002");
  });

  it("a retried comment is stored once", async () => {
    const key = newKey("cmt");
    const [a] = await h.run<{ id: string }>("ownerA", ADD, [A, id, "Same note", "client", key]);
    const [b] = await h.run<{ id: string }>("ownerA", ADD, [A, id, "Same note", "client", key]);
    expect(a.id).toBe(b.id);
    expect(
      await count("select count(*) as n from public.intake_comments where body = 'Same note'"),
    ).toBe(1);
  });
});

describe("business profile", () => {
  const SAVE = "select public.save_business_profile($1, $2, $3, $4::jsonb, $5) as id";
  const MOVE = "select public.transition_business_profile($1, $2::public.intake_status, $3)";
  const complete = {
    registered_name: "Synthetic Client A Corp.",
    tin: "123456789000",
    rdo_code: "25a",
    business_type: "corporation",
    vat_status: "vat_registered",
    registered_address: "1 Sample St., Sample City",
    zip_code: "1000",
    line_of_business: "Trading",
    fiscal_year_end_month: "12",
    contact_email: "Owner@Example.test",
  };
  let id = "";

  it("only the client owner or senior staff may propose; client staff may not", async () => {
    expect(await h.errorOf("staffA", SAVE, [A, null, null, "{}", newKey()])).toBe("42501");
    expect(await h.errorOf("viewerA", SAVE, [A, null, null, "{}", newKey()])).toBe("42501");
    const [r] = await h.run<{ id: string }>("ownerA", SAVE, [
      A,
      null,
      null,
      JSON.stringify({ trade_name: "SCA" }),
      newKey(),
    ]);
    id = r.id;
  });

  it("one change at a time; incomplete profiles cannot be submitted", async () => {
    expect(await h.errorOf("ownerA", SAVE, [A, null, null, "{}", newKey()])).toBe("23505");
    expect(await h.messageOf("ownerA", MOVE, [id, "submitted", null])).toMatch(
      /registered name, TIN/,
    );
  });

  it("normalizes values, and the submitter cannot approve their own change", async () => {
    await h.run("ownerA", SAVE, [A, id, 1, JSON.stringify(complete), newKey()]);
    const { rows } = await db.query<{
      tin: string;
      rdo_code: string;
      contact_email: string;
      version: number;
    }>("select tin, rdo_code, contact_email, version from public.business_profiles where id = $1", [
      id,
    ]);
    expect(rows[0]).toMatchObject({
      tin: "123-456-789-000",
      rdo_code: "25A",
      contact_email: "owner@example.test",
      version: 1,
    });
    await h.run("ownerA", MOVE, [id, "submitted", null]);
    expect(await h.errorOf("accountantB", MOVE, [id, "approved", null])).toBe("42501"); // role
    await h.run("reviewerA", MOVE, [id, "approved", null]);

    // A reviewer proposing a change cannot approve it themselves.
    const [v2] = await h.run<{ id: string }>("reviewerA", SAVE, [
      A,
      null,
      null,
      JSON.stringify(complete),
      newKey(),
    ]);
    await h.run("reviewerA", MOVE, [v2.id, "submitted", null]);
    expect(await h.errorOf("reviewerA", MOVE, [v2.id, "approved", null])).toBe("42501");
    await h.run("manager", MOVE, [v2.id, "approved", null]);
    const versions = await db.query<{ version: number; status: string }>(
      "select version, status from public.business_profiles where client_id = $1 order by version",
      [A],
    );
    expect(versions.rows).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "approved" },
    ]);
  });
});

describe("counterparties", () => {
  const SAVE = "select public.save_counterparty($1, $2, $3, $4::jsonb, $5) as id";
  const MOVE = "select public.transition_counterparty($1, $2::public.intake_status, $3)";

  it("detects duplicates by TIN, or by name when there is no TIN", async () => {
    await h.run("ownerA", SAVE, [
      A,
      null,
      null,
      JSON.stringify({
        kind: "supplier",
        registered_name: "Sample Auto Supply",
        tin: "444555666000",
      }),
      newKey(),
    ]);
    expect(
      await h.errorOf("ownerA", SAVE, [
        A,
        null,
        null,
        JSON.stringify({ kind: "supplier", registered_name: "Other name", tin: "444-555-666-000" }),
        newKey(),
      ]),
    ).toBe("23505");
    await h.run("ownerA", SAVE, [
      A,
      null,
      null,
      JSON.stringify({ kind: "customer", registered_name: "Walk-in  Customer" }),
      newKey(),
    ]);
    expect(
      await h.errorOf("ownerA", SAVE, [
        A,
        null,
        null,
        JSON.stringify({ kind: "customer", registered_name: "walk-in customer" }),
        newKey(),
      ]),
    ).toBe("23505");
    // Client B may have the same supplier (tenants are independent).
    await h.run("ownerB", SAVE, [
      B,
      null,
      null,
      JSON.stringify({
        kind: "supplier",
        registered_name: "Sample Auto Supply",
        tin: "444555666000",
      }),
      newKey(),
    ]);
  });

  it("client submits, staff approve (single and bulk); clients cannot approve", async () => {
    const ids: string[] = [];
    for (const n of ["One", "Two", "Three"]) {
      const [r] = await h.run<{ id: string }>("staffA", SAVE, [
        A,
        null,
        null,
        JSON.stringify({ kind: "supplier", registered_name: `Supplier ${n}` }),
        newKey(),
      ]);
      await h.run("staffA", MOVE, [r.id, "submitted", null]);
      ids.push(r.id);
    }
    expect(await h.errorOf("ownerA", MOVE, [ids[0], "approved", null])).toBe("42501");
    await h.run("accountantB", MOVE, [ids[0], "approved", null]);
    const [{ n }] = await h.run<{ n: number }>(
      "accountantB",
      "select public.approve_counterparties($1, $2::uuid[]) as n",
      [A, ids],
    );
    expect(Number(n)).toBe(2);
  });

  it("a transaction can reference an approved counterparty, copying its name and TIN", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.counterparties where client_id = $1 and tin = '444-555-666-000'",
      [A],
    );
    const t = await h.saveTxn("ownerA", A, {
      kind: "purchase",
      txn_date: "2026-09-05",
      document_ref: "SI-CP",
      counterparty_id: rows[0].id,
      gross_amount: "600.00",
    });
    const row = await h.txn(t);
    expect(row.counterparty_name).toBe("Sample Auto Supply");
    expect(row.counterparty_tin).toBe("444-555-666-000");
    // Another client's counterparty cannot be referenced.
    const other = await db.query<{ id: string }>(
      "select id from public.counterparties where client_id = $1 limit 1",
      [B],
    );
    expect(
      await h.saveTxnError("ownerA", A, {
        kind: "purchase",
        counterparty_id: other.rows[0].id,
        gross_amount: "1.00",
      }),
    ).toBe("22023");
  });
});

describe("tenant isolation", () => {
  it("users of another client see no intake data of client A", async () => {
    const tables = [
      "intake_transactions",
      "intake_transaction_lines",
      "intake_events",
      "intake_comments",
      "counterparties",
      "business_profiles",
    ];
    for (const who of ["ownerB", "outsider", "firmAdmin"] as const) {
      for (const t of tables) {
        const rows = await h.read(who, `select 1 from public.${t} where client_id = $1`, [A]);
        expect(rows, `${who} on ${t}`).toEqual([]);
      }
    }
    expect(
      await count("select count(*) as n from public.intake_transactions where client_id = $1", [A]),
    ).toBeGreaterThan(5);
  });

  it("another client's user cannot act on client A's records", async () => {
    const id = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-ISO" }));
    expect(await h.transitionTxnError("ownerB", id, "submitted")).toBe("P0002");
    expect(await h.saveTxnError("ownerB", B, purchase(), { id, version: 1 })).toBe("P0002");
  });

  it("API users cannot write intake tables directly", async () => {
    expect(
      await h.errorOf(
        "ownerA",
        "insert into public.intake_transactions (client_id, kind, idempotency_key) values ($1, 'sale', 'direct-insert-1')",
        [A],
      ),
    ).toBe("42501");
    expect(
      await h.errorOf("ownerA", "update public.intake_transactions set status = 'approved'"),
    ).toBe("42501");
    expect(await h.errorOf("ownerA", "delete from public.intake_comments")).toBe("42501");
  });
});

describe("ledger link: approved transactions are booked only through maker-checker", () => {
  let txnId = "";
  const ACCOUNT = "select id from public.accounts where client_id = $1 and code = $2";

  beforeAll(async () => {
    await h.run("reviewerA", "select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
    await h.run("reviewerA", "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
    txnId = await h.saveTxn("ownerA", A, purchase({ document_ref: "OR-BOOK" }));
    await h.transitionTxn("ownerA", txnId, "submitted");
  });

  async function journalDraft(ref: string, key = newKey("je")) {
    const fuel = (await db.query<{ id: string }>(ACCOUNT, [A, "6090"])).rows[0].id;
    const cash = (await db.query<{ id: string }>(ACCOUNT, [A, "1020"])).rows[0].id;
    const lines = JSON.stringify([
      { account_id: fuel, debit: "2240.00", credit: "" },
      { account_id: cash, debit: "", credit: "2240.00" },
    ]);
    return h.run<{ id: string }>(
      "accountantB",
      "select public.save_draft_entry($1, null, '2026-09-03'::date, 'general', 'Fuel', 'intake_transaction', $2, $3, $4::jsonb) as id",
      [A, ref, key, lines],
    );
  }

  it("an unapproved transaction cannot be booked", async () => {
    await expect(journalDraft(txnId)).rejects.toMatchObject({ code: "22023" });
  });

  it("posting the journal entry marks the transaction posted; it cannot be booked twice", async () => {
    await h.transitionTxn("accountantB", txnId, "reviewed");
    await h.transitionTxn("reviewerA", txnId, "approved");
    const [{ id: je }] = await journalDraft(txnId);
    expect((await h.txn(txnId)).status).toBe("approved"); // a draft entry does not post it
    await h.run("accountantB", "select public.submit_entry($1)", [je]);
    await h.run("reviewerA", "select public.approve_and_post($1)", [je]);
    const t = await h.txn(txnId);
    expect(t.status).toBe("posted");
    expect(t.journal_entry_id).toBe(je);
    await expect(journalDraft(txnId)).rejects.toMatchObject({ code: "23505" });
  });

  it("reversing the entry returns the transaction to approved for re-booking", async () => {
    const je = String((await h.txn(txnId)).journal_entry_id);
    await h.run(
      "reviewerA",
      "select public.reverse_entry($1, '2026-09-04'::date, 'Wrong account', $2)",
      [je, newKey("rev")],
    );
    const t = await h.txn(txnId);
    expect(t.status).toBe("approved");
    expect(t.journal_entry_id).toBeNull();
    const events = await db.query<{ to_status: string }>(
      "select to_status from public.intake_events where subject_id = $1 order by id",
      [txnId],
    );
    expect(events.rows.map((e) => e.to_status).slice(-2)).toEqual(["posted", "approved"]);
  });
});
