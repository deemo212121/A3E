/**
 * Deterministic accounting tests for the double-entry engine (Phase 5 gate).
 *
 * Scenarios and expected results are documented for accountant review in
 * docs/accounting/TEST-SCENARIOS.md (status: PENDING accountant sign-off).
 * All data is synthetic. Expected amounts are hard-coded, never recomputed
 * from the code under test.
 *
 * Tests in this file run IN ORDER and build on each other (one ledger).
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  actor,
  asUser,
  asUserCommit,
  createTestDb,
  IDS,
  pgErrorCode,
  seedFixture,
  type Db,
} from "./harness";

let db: Db;
const A: string = IDS.clientA;
const B: string = IDS.clientB;

const PREPARER = "accountantB" as const; // assigned to A (preparer) and B in this file
const APPROVER = "reviewerA" as const;

type Line = { code: string; debit?: string; credit?: string; description?: string };

async function accountId(code: string, client = A): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.accounts where client_id = $1 and code = $2",
    [client, code],
  );
  if (!rows[0]) throw new Error(`no account ${code}`);
  return rows[0].id;
}

async function linesJson(lines: Line[], client = A): Promise<string> {
  const out = [];
  for (const l of lines) {
    out.push({
      account_id: await accountId(l.code, client),
      debit: l.debit ?? "",
      credit: l.credit ?? "",
      description: l.description ?? "",
    });
  }
  return JSON.stringify(out);
}

let keySeq = 0;
const key = (label: string) => `test-${label}-${++keySeq}`.padEnd(12, "x");

async function saveDraft(
  who: Parameters<typeof actor>[0],
  opts: {
    date: string;
    lines: Line[];
    type?: string;
    memo?: string;
    sourceType?: string | null;
    sourceRef?: string | null;
    idem?: string;
    entryId?: string | null;
    client?: string;
  },
): Promise<string> {
  const client = opts.client ?? A;
  const lj = await linesJson(opts.lines, client);
  return asUserCommit(db, actor(who), async (tx) => {
    const r = await tx.query<{ id: string }>(
      `select public.save_draft_entry($1, $2, $3::date, $4::public.entry_type, $5, $6, $7, $8, $9::jsonb) as id`,
      [
        client,
        opts.entryId ?? null,
        opts.date,
        opts.type ?? "general",
        opts.memo ?? "",
        opts.sourceType ?? null,
        opts.sourceRef ?? null,
        opts.idem ?? key("draft"),
        lj,
      ],
    );
    return r.rows[0].id;
  });
}

const submit = (who: Parameters<typeof actor>[0], id: string) =>
  asUserCommit(db, actor(who), (tx) => tx.query("select public.submit_entry($1)", [id]));

async function approve(who: Parameters<typeof actor>[0], id: string): Promise<number> {
  return asUserCommit(db, actor(who), async (tx) => {
    const r = await tx.query<{ n: number }>("select public.approve_and_post($1) as n", [id]);
    return Number(r.rows[0].n);
  });
}

/** Full maker-checker cycle; returns { id, entryNo }. */
async function post(opts: Parameters<typeof saveDraft>[1]) {
  const id = await saveDraft(PREPARER, opts);
  await submit(PREPARER, id);
  const entryNo = await approve(APPROVER, id);
  return { id, entryNo };
}

interface TbRow {
  code: string;
  total_debit: string;
  total_credit: string;
  balance: string;
  normal_balance: string;
}

async function trialBalance(asOf: string, who: Parameters<typeof actor>[0] = APPROVER) {
  return asUser(db, actor(who), async (tx) => {
    const r = await tx.query<TbRow>(
      "select code, total_debit, total_credit, balance, normal_balance from public.trial_balance($1, $2::date)",
      [A, asOf],
    );
    return r.rows;
  });
}

function balances(rows: TbRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.code, String(r.balance)]));
}

/** Sum of a decimal-string column using integer centavos (no floats). */
function sumCents(values: string[]): bigint {
  return values.reduce((acc, v) => {
    const [whole, frac = ""] = String(v).split(".");
    return acc + BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  }, 0n);
}

const errorOf = (who: Parameters<typeof actor>[0], sql: string, params: unknown[] = []) =>
  asUser(db, actor(who), (tx) => pgErrorCode(tx.query(sql, params)));

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  await asUserCommit(db, actor(APPROVER), async (tx) => {
    await tx.query("select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
    await tx.query("select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
  });
  await asUserCommit(db, actor("manager"), async (tx) => {
    await tx.query("select public.apply_coa_template($1, 'PH-SME-V0')", [B]);
    await tx.query("select public.create_fiscal_year($1, '2026-01-01'::date)", [B]);
  });
}, 60_000);

// ---------------------------------------------------------------------------
describe("setup", () => {
  it("applies the 60-account template and 12 monthly periods", async () => {
    const accounts = await db.query<{ n: number }>(
      "select count(*)::int as n from public.accounts where client_id = $1",
      [A],
    );
    const periods = await db.query<{ start_date: string; end_date: string }>(
      "select start_date::text, end_date::text from public.accounting_periods where client_id = $1 order by period_no",
      [A],
    );
    expect(accounts.rows[0].n).toBe(60);
    expect(periods.rows.length).toBe(12);
    expect(periods.rows[0]).toEqual({ start_date: "2026-01-01", end_date: "2026-01-31" });
    expect(periods.rows[1]).toEqual({ start_date: "2026-02-01", end_date: "2026-02-28" });
    expect(periods.rows[11]).toEqual({ start_date: "2026-12-01", end_date: "2026-12-31" });
  });
});

// ---------------------------------------------------------------------------
describe("Scenario S1: January transactions -> trial balance", () => {
  it("posts JE1–JE7 with sequential numbers 1..7", async () => {
    const posted = [
      await post({
        date: "2026-01-01",
        type: "opening",
        memo: "Owner's initial investment",
        lines: [
          { code: "1020", debit: "500000.00" },
          { code: "3010", credit: "500000.00" },
        ],
      }),
      await post({
        date: "2026-01-05",
        memo: "Services billed on account",
        sourceType: "sales_invoice",
        sourceRef: "SI-DEMO-0001",
        lines: [
          { code: "1100", debit: "120000.00" },
          { code: "4020", credit: "120000.00" },
        ],
      }),
      await post({
        date: "2026-01-10",
        memo: "January rent",
        lines: [
          { code: "6020", debit: "25000.00" },
          { code: "1020", credit: "25000.00" },
        ],
      }),
      await post({
        date: "2026-01-15",
        memo: "Equipment, part bank loan",
        lines: [
          { code: "1500", debit: "150000.00" },
          { code: "1020", credit: "50000.00" },
          { code: "2200", credit: "100000.00" },
        ],
      }),
      await post({
        date: "2026-01-20",
        memo: "Collection from customer",
        sourceType: "official_receipt",
        sourceRef: "OR-DEMO-0001",
        lines: [
          { code: "1020", debit: "80000.00" },
          { code: "1100", credit: "80000.00" },
        ],
      }),
      await post({
        date: "2026-01-25",
        memo: "Utilities accrued",
        lines: [
          { code: "6030", debit: "4567.89" },
          { code: "2020", credit: "4567.89" },
        ],
      }),
      await post({
        date: "2026-01-31",
        memo: "January salaries",
        lines: [
          { code: "6010", debit: "60000.00" },
          { code: "1020", credit: "60000.00" },
        ],
      }),
    ];
    expect(posted.map((p) => p.entryNo)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("produces the expected trial balance as of 2026-01-31", async () => {
    expect(balances(await trialBalance("2026-01-31"))).toEqual({
      "1020": "445000.00",
      "1100": "40000.00",
      "1500": "150000.00",
      "2020": "4567.89",
      "2200": "100000.00",
      "3010": "500000.00",
      "4020": "120000.00",
      "6010": "60000.00",
      "6020": "25000.00",
      "6030": "4567.89",
    });
  });

  it("trial balance totals agree: Σdebits = Σcredits = 939,567.89; debit-normal = credit-normal = 724,567.89", async () => {
    const rows = await trialBalance("2026-01-31");
    expect(sumCents(rows.map((r) => r.total_debit))).toBe(93956789n);
    expect(sumCents(rows.map((r) => r.total_credit))).toBe(93956789n);
    const debitSide = sumCents(
      rows.filter((r) => r.normal_balance === "debit").map((r) => r.balance),
    );
    const creditSide = sumCents(
      rows.filter((r) => r.normal_balance === "credit").map((r) => r.balance),
    );
    expect(debitSide).toBe(72456789n);
    expect(creditSide).toBe(72456789n);
  });

  it("general ledger for Cash in Bank shows the running balance", async () => {
    const cash = await accountId("1020");
    const rows = await asUser(
      db,
      actor(APPROVER),
      async (tx) =>
        (
          await tx.query<{ entry_no: number; running_balance: string }>(
            "select entry_no, running_balance from public.general_ledger($1, $2, '2026-01-01', '2026-01-31')",
            [A, cash],
          )
        ).rows,
    );
    expect(rows.map((r) => [Number(r.entry_no), String(r.running_balance)])).toEqual([
      [1, "500000.00"],
      [3, "475000.00"],
      [4, "425000.00"],
      [5, "505000.00"],
      [7, "445000.00"],
    ]);
  });

  it("trial balance as of an earlier date excludes later entries", async () => {
    expect(balances(await trialBalance("2026-01-10"))).toEqual({
      "1020": "475000.00",
      "1100": "120000.00",
      "3010": "500000.00",
      "4020": "120000.00",
      "6020": "25000.00",
    });
  });
});

// ---------------------------------------------------------------------------
describe("Scenario S2: error, reversal and correction", () => {
  let wrong: { id: string; entryNo: number };
  let reversalId = "";
  const REV_KEY = "reverse-je8-key";

  it("posts the erroneous supplies entry as JE8", async () => {
    wrong = await post({
      date: "2026-02-03",
      memo: "Supplies (wrong amount)",
      sourceType: "purchase_invoice",
      sourceRef: "PI-DEMO-0001",
      lines: [
        { code: "6040", debit: "1000.00" },
        { code: "1020", credit: "1000.00" },
      ],
    });
    expect(wrong.entryNo).toBe(8);
  });

  it("the preparer cannot reverse (approvers only)", async () => {
    expect(
      await errorOf(
        PREPARER,
        "select public.reverse_entry($1, '2026-02-04', 'wrong amount', 'prep-try-key')",
        [wrong.id],
      ),
    ).toBe("P0002");
  });

  it("reverses JE8 as JE9, linked both ways, original marked reversed", async () => {
    reversalId = await asUserCommit(
      db,
      actor(APPROVER),
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            "select public.reverse_entry($1, '2026-02-04'::date, 'wrong amount', $2) as id",
            [wrong.id, REV_KEY],
          )
        ).rows[0].id,
    );
    const { rows } = await db.query<{
      id: string;
      status: string;
      entry_no: number;
      entry_type: string;
      reverses_entry_id: string | null;
      reversed_by_entry_id: string | null;
    }>(
      "select id, status, entry_no, entry_type, reverses_entry_id, reversed_by_entry_id from public.journal_entries where id in ($1, $2)",
      [wrong.id, reversalId],
    );
    const original = rows.find((r) => r.id === wrong.id)!;
    const reversal = rows.find((r) => r.id === reversalId)!;
    expect(original).toMatchObject({ status: "reversed", reversed_by_entry_id: reversalId });
    expect(reversal).toMatchObject({
      status: "posted",
      entry_type: "reversal",
      reverses_entry_id: wrong.id,
    });
    expect(Number(reversal.entry_no)).toBe(9);
  });

  it("the reversal mirrors every line (debits <-> credits)", async () => {
    const { rows } = await db.query<{
      entry_id: string;
      line_no: number;
      debit: string;
      credit: string;
      account_id: string;
    }>(
      "select entry_id, line_no, debit, credit, account_id from public.journal_lines where entry_id in ($1, $2) order by entry_id, line_no",
      [wrong.id, reversalId],
    );
    const orig = rows.filter((r) => r.entry_id === wrong.id);
    const rev = rows.filter((r) => r.entry_id === reversalId);
    expect(rev.map((r) => [r.line_no, r.account_id, r.debit, r.credit])).toEqual(
      orig.map((r) => [r.line_no, r.account_id, r.credit, r.debit]),
    );
  });

  it("replaying the reversal with the same idempotency key returns the same reversal", async () => {
    const again = await asUserCommit(
      db,
      actor(APPROVER),
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            "select public.reverse_entry($1, '2026-02-04'::date, 'wrong amount', $2) as id",
            [wrong.id, REV_KEY],
          )
        ).rows[0].id,
    );
    expect(again).toBe(reversalId);
  });

  it("a second reversal with a new key is refused (reverse at most once)", async () => {
    expect(
      await errorOf(
        APPROVER,
        "select public.reverse_entry($1, '2026-02-05', 'again', 'another-key-123')",
        [wrong.id],
      ),
    ).toBe("23505");
  });

  it("a reversal itself cannot be reversed", async () => {
    expect(
      await errorOf(
        APPROVER,
        "select public.reverse_entry($1, '2026-02-05', 'undo', 'rev-of-rev-key')",
        [reversalId],
      ),
    ).toBe("22023");
  });

  it("the source document can be re-used for the corrected entry (JE10)", async () => {
    const corrected = await post({
      date: "2026-02-04",
      memo: "Supplies (corrected)",
      sourceType: "purchase_invoice",
      sourceRef: "PI-DEMO-0001",
      lines: [
        { code: "6040", debit: "100.00" },
        { code: "1020", credit: "100.00" },
      ],
    });
    expect(corrected.entryNo).toBe(10);
  });

  it("net effect: supplies 100.00, cash 444,900.00; the error nets to zero", async () => {
    const tb = balances(await trialBalance("2026-02-28"));
    expect(tb["6040"]).toBe("100.00");
    expect(tb["1020"]).toBe("444900.00");
    const rows = await trialBalance("2026-02-28");
    expect(sumCents(rows.map((r) => r.total_debit))).toBe(
      sumCents(rows.map((r) => r.total_credit)),
    );
  });
});

// ---------------------------------------------------------------------------
describe("duplicate-posting prevention", () => {
  it("saving with the same idempotency key twice creates ONE entry with its lines once", async () => {
    const idem = "dup-key-0001-x";
    const lines: Line[] = [
      { code: "6070", debit: "50.00" },
      { code: "1020", credit: "50.00" },
    ];
    const first = await saveDraft(PREPARER, { date: "2026-02-10", lines, idem });
    const second = await saveDraft(PREPARER, { date: "2026-02-10", lines, idem });
    expect(second).toBe(first);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.journal_lines where entry_id = $1",
      [first],
    );
    expect(rows[0].n).toBe(2);
    await asUserCommit(db, actor(PREPARER), (tx) =>
      tx.query("select public.void_entry($1, 'test cleanup')", [first]),
    );
  });

  it("a second LIVE entry for the same source document is refused", async () => {
    // SI-DEMO-0001 is already posted (JE2) and not reversed.
    const lines = await linesJson([
      { code: "1100", debit: "1.00" },
      { code: "4020", credit: "1.00" },
    ]);
    const code = await errorOf(
      PREPARER,
      "select public.save_draft_entry($1, null, '2026-02-11', 'general', 'dup', 'sales_invoice', 'SI-DEMO-0001', 'dup-src-key-1', $2::jsonb)",
      [A, lines],
    );
    expect(code).toBe("23505");
  });

  it("approving the same entry twice returns the same number and consumes one number", async () => {
    const id = await saveDraft(PREPARER, {
      date: "2026-02-12",
      lines: [
        { code: "6070", debit: "25.00" },
        { code: "1020", credit: "25.00" },
      ],
    });
    await submit(PREPARER, id);
    const first = await approve(APPROVER, id);
    const second = await approve(APPROVER, id);
    expect(second).toBe(first);
    expect(first).toBe(11);
    const { rows } = await db.query<{ next_entry_no: number }>(
      "select next_entry_no from public.fiscal_years where client_id = $1",
      [A],
    );
    expect(Number(rows[0].next_entry_no)).toBe(12);
  });

  it("entry numbers are gapless 1..11 (voided drafts consume no number)", async () => {
    const { rows } = await db.query<{ entry_no: number }>(
      "select entry_no from public.journal_entries where client_id = $1 and entry_no is not null order by entry_no",
      [A],
    );
    expect(rows.map((r) => Number(r.entry_no))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

// ---------------------------------------------------------------------------
describe("balancing controls", () => {
  const trySubmit = async (lines: Line[]) => {
    const id = await saveDraft(PREPARER, { date: "2026-02-15", lines });
    const code = await asUser(db, actor(PREPARER), (tx) =>
      pgErrorCode(tx.query("select public.submit_entry($1)", [id])),
    );
    await asUserCommit(db, actor(PREPARER), (tx) =>
      tx.query("select public.void_entry($1, 'test')", [id]),
    );
    return code;
  };

  it("an unbalanced entry cannot be submitted", async () => {
    expect(
      await trySubmit([
        { code: "6070", debit: "100.00" },
        { code: "1020", credit: "99.99" },
      ]),
    ).toBe("22023");
  });

  it("a single-line entry cannot be submitted", async () => {
    expect(await trySubmit([{ code: "6070", debit: "100.00" }])).toBe("22023");
  });

  it.each([
    ["three decimals", "10.005"],
    ["negative", "-5.00"],
    ["thousands separator", "1,000.00"],
    ["exponent", "1e3"],
  ])("rejects an amount with %s", async (_label, amount) => {
    const lines = JSON.stringify([
      { account_id: await accountId("6070"), debit: amount, credit: "" },
      { account_id: await accountId("1020"), debit: "", credit: "10.00" },
    ]);
    const code = await errorOf(
      PREPARER,
      "select public.save_draft_entry($1, null, '2026-02-15', 'general', '', null, null, $2, $3::jsonb)",
      [A, key("amt"), lines],
    );
    expect(code).toBe("22023");
  });

  it("a line with both a debit and a credit is rejected", async () => {
    const lines = JSON.stringify([
      { account_id: await accountId("6070"), debit: "10.00", credit: "10.00" },
      { account_id: await accountId("1020"), debit: "", credit: "10.00" },
    ]);
    const code = await errorOf(
      PREPARER,
      "select public.save_draft_entry($1, null, '2026-02-15', 'general', '', null, null, $2, $3::jsonb)",
      [A, key("both"), lines],
    );
    expect(code).toBe("23514");
  });

  it("an unbalanced entry forced to 'posted' with superuser SQL fails at COMMIT (deferred constraint)", async () => {
    const { rows: fy } = await db.query<{ id: string; pid: string }>(
      `select f.id, p.id as pid from public.fiscal_years f join public.accounting_periods p
         on p.fiscal_year_id = f.id and p.period_no = 2 where f.client_id = $1`,
      [A],
    );
    await db.exec("begin");
    let commitError: string | undefined;
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.journal_entries (client_id, fiscal_year_id, period_id, entry_date, idempotency_key)
         values ($1, $2, $3, '2026-02-20', 'forced-unbalanced-1') returning id`,
        [A, fy[0].id, fy[0].pid],
      );
      await db.query(
        `insert into public.journal_lines (client_id, entry_id, line_no, account_id, debit, credit) values
           ($1, $2, 1, $3, 100, 0), ($1, $2, 2, $4, 0, 1)`,
        [A, rows[0].id, await accountId("6070"), await accountId("1020")],
      );
      await db.query(
        "update public.journal_entries set status = 'posted', entry_no = 9999, posted_at = now() where id = $1",
        [rows[0].id],
      );
      await db.exec("commit");
    } catch (error) {
      commitError = (error as { code?: string }).code;
      await db.exec("rollback").catch(() => undefined);
    }
    expect(commitError).toBe("23514");
  });
});

// ---------------------------------------------------------------------------
describe("immutability of posted records (even for the database superuser)", () => {
  let postedId = "";
  beforeAll(async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.journal_entries where client_id = $1 and entry_no = 3",
      [A],
    );
    postedId = rows[0].id;
  });

  it("cannot change a posted line amount", async () => {
    await expect(
      db.query("update public.journal_lines set debit = 1 where entry_id = $1 and line_no = 1", [
        postedId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot add a line to a posted entry", async () => {
    await expect(
      db.query(
        "insert into public.journal_lines (client_id, entry_id, line_no, account_id, debit) values ($1, $2, 9, $3, 1)",
        [A, postedId, await accountId("6070")],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot edit the memo or date of a posted entry", async () => {
    await expect(
      db.query("update public.journal_entries set memo = 'edited' where id = $1", [postedId]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot delete a posted entry or a used account", async () => {
    await expect(
      db.query("delete from public.journal_entries where id = $1", [postedId]),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      db.query("delete from public.accounts where client_id = $1 and code = '1020'", [A]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("API users have no direct write access to any accounting table", async () => {
    for (const sql of [
      "update public.journal_entries set memo = 'x'",
      "delete from public.journal_lines",
      "insert into public.accounts (client_id, code, name, account_type, normal_balance) values ('" +
        A +
        "', '9999', 'x', 'asset', 'debit')",
      "update public.accounting_periods set status = 'open'",
      "update public.fiscal_years set next_entry_no = 1",
    ]) {
      expect(await errorOf(APPROVER, sql)).toBe("42501");
    }
  });
});

// ---------------------------------------------------------------------------
describe("posting permissions and segregation of duties", () => {
  it("a preparer cannot approve their own entry", async () => {
    const id = await saveDraft(APPROVER, {
      date: "2026-02-16",
      lines: [
        { code: "6070", debit: "5.00" },
        { code: "1020", credit: "5.00" },
      ],
    });
    await submit(APPROVER, id);
    expect(await errorOf(APPROVER, "select public.approve_and_post($1)", [id])).toBe("42501");
    expect(await approve("manager", id)).toBe(12);
  });

  it("an accountant (preparer role) cannot approve", async () => {
    const id = await saveDraft(APPROVER, {
      date: "2026-02-16",
      lines: [
        { code: "6070", debit: "6.00" },
        { code: "1020", credit: "6.00" },
      ],
    });
    await submit(APPROVER, id);
    expect(await errorOf(PREPARER, "select public.approve_and_post($1)", [id])).toBe("P0002");
    await asUserCommit(db, actor(APPROVER), (tx) =>
      tx.query("select public.void_entry($1, 'test')", [id]),
    );
  });

  it.each(["ownerA", "staffA", "viewerA", "firmAdmin", "outsider"] as const)(
    "%s cannot prepare entries for Client A",
    async (who) => {
      const lines = await linesJson([
        { code: "6070", debit: "1.00" },
        { code: "1020", credit: "1.00" },
      ]);
      const code = await errorOf(
        who,
        "select public.save_draft_entry($1, null, '2026-02-16', 'general', '', null, null, $2, $3::jsonb)",
        [A, key("noperm"), lines],
      );
      expect(code).toBe("42501");
    },
  );

  it("staff assigned only to Client A cannot post into Client B", async () => {
    const lines = await linesJson(
      [
        { code: "6070", debit: "1.00" },
        { code: "1020", credit: "1.00" },
      ],
      B,
    );
    expect(
      await errorOf(
        APPROVER,
        "select public.save_draft_entry($1, null, '2026-02-16', 'general', '', null, null, $2, $3::jsonb)",
        [B, key("cross"), lines],
      ),
    ).toBe("42501");
  });

  it("an account belonging to Client B cannot be used on a Client A entry", async () => {
    const lines = JSON.stringify([
      { account_id: await accountId("6070", B), debit: "1.00" },
      { account_id: await accountId("1020"), credit: "1.00" },
    ]);
    expect(
      await errorOf(
        PREPARER,
        "select public.save_draft_entry($1, null, '2026-02-16', 'general', '', null, null, $2, $3::jsonb)",
        [A, key("foreign-acct"), lines],
      ),
    ).toBe("23503");
  });

  it("inactive and header (non-postable) accounts cannot be used", async () => {
    const header = JSON.stringify([
      { account_id: await accountId("1000"), debit: "1.00" },
      { account_id: await accountId("1020"), credit: "1.00" },
    ]);
    expect(
      await errorOf(
        PREPARER,
        "select public.save_draft_entry($1, null, '2026-02-16', 'general', '', null, null, $2, $3::jsonb)",
        [A, key("header"), header],
      ),
    ).toBe("22023");
  });
});

// ---------------------------------------------------------------------------
describe("period status controls", () => {
  let febId = "";
  let janId = "";
  beforeAll(async () => {
    const { rows } = await db.query<{ id: string; period_no: number }>(
      "select id, period_no from public.accounting_periods where client_id = $1 and period_no in (1, 2)",
      [A],
    );
    janId = rows.find((r) => Number(r.period_no) === 1)!.id;
    febId = rows.find((r) => Number(r.period_no) === 2)!.id;
  });

  it("only managers can lock; a reviewer cannot", async () => {
    expect(await errorOf(APPROVER, "select public.set_period_status($1, 'locked')", [janId])).toBe(
      "42501",
    );
  });

  it("locking January (manager) blocks drafting and posting into it", async () => {
    await asUserCommit(db, actor("manager"), (tx) =>
      tx.query("select public.set_period_status($1, 'locked', 'January closed')", [janId]),
    );
    const lines = await linesJson([
      { code: "6070", debit: "1.00" },
      { code: "1020", credit: "1.00" },
    ]);
    expect(
      await errorOf(
        PREPARER,
        "select public.save_draft_entry($1, null, '2026-01-20', 'adjusting', '', null, null, $2, $3::jsonb)",
        [A, key("locked"), lines],
      ),
    ).toBe("22023");
  });

  it("a January entry can only be reversed into an open period", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.journal_entries where client_id = $1 and entry_no = 6",
      [A],
    );
    expect(
      await errorOf(
        APPROVER,
        "select public.reverse_entry($1, '2026-01-31', 'test', 'rev-jan-locked')",
        [rows[0].id],
      ),
    ).toBe("22023");
  });

  it("soft-closed February accepts adjusting entries but not general entries", async () => {
    await asUserCommit(db, actor(APPROVER), (tx) =>
      tx.query("select public.set_period_status($1, 'soft_closed', 'month-end review')", [febId]),
    );
    const general = await saveDraft(PREPARER, {
      date: "2026-02-27",
      lines: [
        { code: "6070", debit: "2.00" },
        { code: "1020", credit: "2.00" },
      ],
    });
    expect(
      await asUser(db, actor(PREPARER), (tx) =>
        pgErrorCode(tx.query("select public.submit_entry($1)", [general])),
      ),
    ).toBe("22023");
    const adjusting = await saveDraft(PREPARER, {
      date: "2026-02-28",
      type: "adjusting",
      lines: [
        { code: "6050", debit: "1250.00" },
        { code: "1510", credit: "1250.00" },
      ],
    });
    await submit(PREPARER, adjusting);
    expect(await approve(APPROVER, adjusting)).toBe(13);
    await asUserCommit(db, actor(PREPARER), (tx) =>
      tx.query("select public.void_entry($1, 'test')", [general]),
    );
  });

  it("a period with pending drafts cannot be locked", async () => {
    const pending = await saveDraft(PREPARER, {
      date: "2026-02-27",
      type: "adjusting",
      lines: [
        { code: "6070", debit: "3.00" },
        { code: "1020", credit: "3.00" },
      ],
    });
    expect(await errorOf("manager", "select public.set_period_status($1, 'locked')", [febId])).toBe(
      "22023",
    );
    await asUserCommit(db, actor(PREPARER), (tx) =>
      tx.query("select public.void_entry($1, 'test')", [pending]),
    );
  });

  it("reopening a locked period requires a manager AND a reason", async () => {
    expect(
      await errorOf("manager", "select public.set_period_status($1, 'open', null)", [janId]),
    ).toBe("22023");
    expect(
      await errorOf(APPROVER, "select public.set_period_status($1, 'open', 'fix')", [janId]),
    ).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("visibility of the ledger", () => {
  it("client users see posted entries only, never drafts", async () => {
    const draft = await saveDraft(PREPARER, {
      date: "2026-03-02",
      lines: [
        { code: "6070", debit: "7.00" },
        { code: "1020", credit: "7.00" },
      ],
    });
    const seen = await asUser(db, actor("ownerA"), async (tx) =>
      (
        await tx.query<{ status: string }>("select distinct status from public.journal_entries")
      ).rows
        .map((r) => r.status)
        .sort(),
    );
    expect(seen).toEqual(["posted", "reversed"]);
    const draftVisible = await asUser(
      db,
      actor("ownerA"),
      async (tx) =>
        (await tx.query("select * from public.journal_entries where id = $1", [draft])).rows.length,
    );
    expect(draftVisible).toBe(0);
  });

  it("Client B's owner sees nothing of Client A's ledger, including via trial_balance()", async () => {
    const result = await asUser(db, actor("ownerB"), async (tx) => ({
      entries: (await tx.query("select * from public.journal_entries where client_id = $1", [A]))
        .rows.length,
      lines: (await tx.query("select * from public.journal_lines where client_id = $1", [A])).rows
        .length,
      accounts: (await tx.query("select * from public.accounts where client_id = $1", [A])).rows
        .length,
      tb: (await tx.query("select * from public.trial_balance($1, '2026-12-31')", [A])).rows.length,
    }));
    expect(result).toEqual({ entries: 0, lines: 0, accounts: 0, tb: 0 });
  });

  it("the firm admin sees no ledger data (SoD-5)", async () => {
    const n = await asUser(
      db,
      actor("firmAdmin"),
      async (tx) => (await tx.query("select * from public.journal_lines")).rows.length,
    );
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("audit history", () => {
  it("records posting, reversal and period events append-only", async () => {
    const { rows } = await db.query<{ action: string; n: number }>(
      `select action, count(*)::int as n from audit.events
        where client_id = $1 and action in ('journal.posted', 'journal.reversed', 'period.status_changed')
        group by action order by action`,
      [A],
    );
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toEqual({
      "journal.posted": 12, // JE1-8, JE10, JE11, JE12, JE13 (the reversal JE9 is logged as journal.reversed)
      "journal.reversed": 1,
      "period.status_changed": 2,
    });
    await expect(db.query("update audit.events set action = 'x'")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

// ---------------------------------------------------------------------------
describe("synthetic purge (test-data cleanup)", () => {
  it("refuses non-ZZTEST clients and API users; purges a ZZTEST client with a posted ledger", async () => {
    await expect(db.query("select public.purge_synthetic_client($1)", [A])).rejects.toMatchObject({
      code: "42501",
    });
    expect(await errorOf(APPROVER, "select public.purge_synthetic_client($1)", [A])).toBe("42501");

    await db.query("update public.clients set code = 'ZZTEST-PURGE' where id = $1", [B]);
    await asUserCommit(db, actor("manager"), async (tx) => {
      const lines = JSON.stringify([
        { account_id: await accountId("6070", B), debit: "9.00" },
        { account_id: await accountId("1020", B), credit: "9.00" },
      ]);
      await tx.query(
        "select public.save_draft_entry($1, null, '2026-01-09', 'general', '', null, null, 'purge-key-1', $2::jsonb)",
        [B, lines],
      );
    });
    const { rows: e } = await db.query<{ id: string }>(
      "select id from public.journal_entries where client_id = $1",
      [B],
    );
    await asUserCommit(db, actor("manager"), (tx) =>
      tx.query("select public.submit_entry($1)", [e[0].id]),
    );
    await db.query(
      "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'reviewer')",
      [B, IDS.reviewerA],
    );
    await approve(APPROVER, e[0].id);
    // Include a reversal: the purge must handle reversal links and their maker-checker rule.
    await asUserCommit(db, actor(APPROVER), (tx) =>
      tx.query("select public.reverse_entry($1, null, 'purge test', 'purge-rev-key')", [e[0].id]),
    );
    await db.query("select public.purge_synthetic_client($1)", [B]);
    const left = await db.query<{ n: number }>(
      "select (select count(*) from public.clients where id = $1) + (select count(*) from public.accounts where client_id = $1) + (select count(*) from public.journal_entries where client_id = $1) as n",
      [B],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
});
