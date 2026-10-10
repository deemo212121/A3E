/**
 * Scenario S3: one month of a VAT-registered trading client, recorded the way
 * the Firm's books record it (cash disbursements, cash receipts, semi-monthly
 * payroll, imprest petty cash), plus per-line supplier/customer, TIN and
 * receipt number.
 *
 * ALL DATA IS SYNTHETIC: names, TINs and amounts are invented. The VAT split
 * (amount / 1.12) mirrors the Firm's spreadsheet practice and the payroll
 * deduction amounts are ILLUSTRATIVE, not contribution tables. The engine does
 * not compute any tax: every amount below is typed in by the "preparer", and
 * the test only proves that the ledger records, balances and reports them.
 * Expected results are hard-coded; see docs/accounting/TEST-SCENARIOS.md (S3).
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
const PREPARER = "accountantB" as const;
const APPROVER = "reviewerA" as const;

type Line = {
  code: string;
  debit?: string;
  credit?: string;
  description?: string;
  name?: string;
  tin?: string;
  doc?: string;
};

async function accountId(code: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select id from public.accounts where client_id = $1 and code = $2",
    [A, code],
  );
  if (!rows[0]) throw new Error(`no account ${code}`);
  return rows[0].id;
}

let keySeq = 0;
const key = () => `s3-key-${++keySeq}`.padEnd(12, "x");

async function saveDraft(date: string, memo: string, lines: Line[], type = "general") {
  const payload: Record<string, string>[] = [];
  for (const l of lines) {
    payload.push({
      account_id: await accountId(l.code),
      debit: l.debit ?? "",
      credit: l.credit ?? "",
      description: l.description ?? "",
      counterparty_name: l.name ?? "",
      counterparty_tin: l.tin ?? "",
      document_ref: l.doc ?? "",
    });
  }
  return asUserCommit(db, actor(PREPARER), async (tx) => {
    const r = await tx.query<{ id: string }>(
      `select public.save_draft_entry($1, null, $2::date, $3::public.entry_type, $4, null, null, $5, $6::jsonb) as id`,
      [A, date, type, memo, key(), JSON.stringify(payload)],
    );
    return r.rows[0].id;
  });
}

async function post(date: string, memo: string, lines: Line[], type = "general") {
  const id = await saveDraft(date, memo, lines, type);
  await asUserCommit(db, actor(PREPARER), (tx) => tx.query("select public.submit_entry($1)", [id]));
  await asUserCommit(db, actor(APPROVER), (tx) =>
    tx.query("select public.approve_and_post($1)", [id]),
  );
  return id;
}

async function linesOf(entryId: string) {
  const { rows } = await db.query<{
    line_no: number;
    debit: string;
    credit: string;
    counterparty_name: string | null;
    counterparty_tin: string | null;
    document_ref: string | null;
  }>(
    `select line_no, debit::text, credit::text, counterparty_name, counterparty_tin, document_ref
       from public.journal_lines where entry_id = $1 order by line_no`,
    [entryId],
  );
  return rows;
}

const SUPPLIER = { name: "Sample Fuels Corp.", tin: "111-222-333-00000" };
const CUSTOMER = { name: "Sample Hardware Inc.", tin: "777-888-999-00000" };
let fuelEntry = "";
let mistakeEntry = "";
let reversalEntry = "";

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
}, 60_000);

describe("S3 setup: starter chart includes the accounts the Firm's books use", () => {
  it("has the petty cash, payroll-liability and expense accounts", async () => {
    const { rows } = await db.query<{ code: string }>(
      "select code from public.accounts where client_id = $1 order by code",
      [A],
    );
    const codes = rows.map((r) => r.code);
    for (const c of ["1015", "1120", "1210", "2030", "2105", "2120", "2130", "2140", "2150"]) {
      expect(codes).toContain(c);
    }
    for (const c of ["2160", "5020", "6012", "6014", "6080", "6090", "6100", "6110", "6120"]) {
      expect(codes).toContain(c);
    }
    expect(codes).toContain("6130");
    expect(codes).toContain("6140");
  });
});

describe("S3: one month in the Firm's format", () => {
  it("posts the month", async () => {
    await post("2026-09-01", "Opening capital", [
      { code: "1020", debit: "500000.00" },
      { code: "3010", credit: "500000.00" },
    ]);
    await post("2026-09-01", "Establish petty cash fund", [
      { code: "1015", debit: "40000.00", doc: "CV-0001" },
      { code: "1020", credit: "40000.00", doc: "CV-0001" },
    ]);
    // CDJ, VAT-registered supplier: 2,240.00 gross = 2,000.00 + 240.00 input tax.
    fuelEntry = await post("2026-09-03", "Fuel", [
      { code: "6090", debit: "2000.00", ...SUPPLIER, doc: "OR-1001" },
      { code: "1310", debit: "240.00", ...SUPPLIER, doc: "OR-1001" },
      { code: "1020", credit: "2240.00" },
    ]);
    // CDJ, non-VAT supplier: no input tax.
    await post("2026-09-05", "Truck spare parts", [
      {
        code: "6080",
        debit: "600.00",
        name: "Sample Auto Supply",
        tin: "444555666000",
        doc: "SI-2001",
      },
      { code: "1020", credit: "600.00" },
    ]);
    await post("2026-09-08", "Raw materials", [
      {
        code: "5020",
        debit: "100000.00",
        name: "Sample Steel Trading",
        tin: "222 333 444 00000",
        doc: "SI-3001",
      },
      {
        code: "1310",
        debit: "12000.00",
        name: "Sample Steel Trading",
        tin: "222333444-00000",
        doc: "SI-3001",
      },
      { code: "1020", credit: "112000.00" },
    ]);
    // CRJ: customer collection, 336,000.00 gross = 300,000.00 + 36,000.00 output tax.
    await post("2026-09-10", "Collection", [
      { code: "1020", debit: "336000.00" },
      { code: "4010", credit: "300000.00", ...CUSTOMER, doc: "SI-0451" },
      { code: "2100", credit: "36000.00", ...CUSTOMER, doc: "SI-0451" },
    ]);
    await post("2026-09-12", "Cash advance to employee", [
      { code: "1120", debit: "1000.00", name: "Employee 001" },
      { code: "1020", credit: "1000.00" },
    ]);
    // Payroll, first half: the Firm's books take no deductions in this half.
    await post("2026-09-15", "Payroll Sept 1-15", [
      { code: "6010", debit: "30000.00", doc: "PR-2026-09A" },
      { code: "1020", credit: "30000.00", doc: "PR-2026-09A" },
    ]);
    // Petty cash replenishment: the fund stays at 40,000.00 (imprest).
    await post("2026-09-20", "Petty cash replenishment Sept 1-19", [
      { code: "6130", debit: "1250.00", name: "Sample Eatery", doc: "OR-5512" },
      {
        code: "6040",
        debit: "860.50",
        name: "Sample Office Mart",
        tin: "555-666-777-00012",
        doc: "OR-88",
      },
      {
        code: "6080",
        debit: "2349.75",
        name: "Sample Hardware Inc.",
        tin: "777-888-999-00000",
        doc: "SI-0460",
      },
      { code: "6014", debit: "1000.00", description: "Medical assistance" },
      { code: "1020", credit: "5460.25", doc: "CV-0002" },
    ]);
    // A duplicated fuel posting, later reversed (no deletion).
    mistakeEntry = await post("2026-09-22", "Fuel (entered twice by mistake)", [
      { code: "6090", debit: "1000.00", ...SUPPLIER, doc: "OR-1002" },
      { code: "1310", debit: "120.00", ...SUPPLIER, doc: "OR-1002" },
      { code: "1020", credit: "1120.00" },
    ]);
    // Payroll, second half with deductions and employer shares (ILLUSTRATIVE amounts):
    // employee SSS 950, PhilHealth 600, Pag-IBIG 200, SSS loan 500, cash advance 1,000;
    // employer SSS 1,900, PhilHealth 600, Pag-IBIG 200. Net pay 26,750.00.
    await post("2026-09-30", "Payroll Sept 16-30", [
      { code: "6010", debit: "30000.00", doc: "PR-2026-09B" },
      { code: "6012", debit: "2700.00", doc: "PR-2026-09B" },
      { code: "2120", credit: "2850.00" },
      { code: "2130", credit: "1200.00" },
      { code: "2140", credit: "400.00" },
      { code: "2150", credit: "500.00" },
      { code: "1120", credit: "1000.00", name: "Employee 001" },
      { code: "1020", credit: "26750.00", doc: "PR-2026-09B" },
    ]);
    await post("2026-09-30", "Remit PhilHealth and Pag-IBIG", [
      { code: "2130", debit: "1200.00" },
      { code: "2140", debit: "400.00" },
      { code: "1020", credit: "1600.00" },
    ]);
  });

  it("reverses the duplicate; reversal lines keep supplier, TIN and receipt number", async () => {
    reversalEntry = await asUserCommit(db, actor(APPROVER), async (tx) => {
      const r = await tx.query<{ id: string }>(
        "select public.reverse_entry($1, '2026-09-25'::date, 'Duplicate of OR-1001 batch', $2) as id",
        [mistakeEntry, key()],
      );
      return r.rows[0].id;
    });
    const orig = await linesOf(mistakeEntry);
    const rev = await linesOf(reversalEntry);
    expect(rev.map((l) => [l.debit, l.credit])).toEqual(orig.map((l) => [l.credit, l.debit]));
    expect(rev.map((l) => [l.counterparty_name, l.counterparty_tin, l.document_ref])).toEqual(
      orig.map((l) => [l.counterparty_name, l.counterparty_tin, l.document_ref]),
    );
    expect(rev[0].counterparty_tin).toBe("111-222-333-00000");
  });

  it("produces the expected trial balance (hard-coded, see TEST-SCENARIOS S3)", async () => {
    const rows = await asUser(
      db,
      actor(APPROVER),
      async (tx) =>
        (
          await tx.query<{
            code: string;
            balance: string;
            total_debit: string;
            total_credit: string;
          }>(
            "select code, balance, total_debit, total_credit from public.trial_balance($1, '2026-09-30'::date)",
            [A],
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.code, r.balance]))).toEqual({
      "1015": "40000.00", // Petty Cash Fund: unchanged by replenishment
      "1020": "616349.75", // Cash in Bank
      "1120": "0.00", // Advances to Employees: given, then deducted from pay
      "1310": "12240.00", // Input Tax (placeholder)
      "2100": "36000.00", // Output Tax (placeholder)
      "2120": "2850.00", // SSS Contributions Payable: not yet remitted
      "2130": "0.00", // PhilHealth: remitted
      "2140": "0.00", // Pag-IBIG: remitted
      "2150": "500.00", // SSS Loans Payable
      "3010": "500000.00",
      "4010": "300000.00",
      "5020": "100000.00",
      "6010": "60000.00",
      "6012": "2700.00",
      "6014": "1000.00",
      "6040": "860.50",
      "6080": "2949.75",
      "6090": "2000.00", // the reversed duplicate nets to zero
      "6130": "1250.00",
    });
    const cents = (v: string) => BigInt(v.replace(".", ""));
    const dr = rows.reduce((s, r) => s + cents(r.total_debit), 0n);
    const cr = rows.reduce((s, r) => s + cents(r.total_credit), 0n);
    expect(dr).toBe(cr);
  });

  it("the general ledger shows supplier and receipt number per line", async () => {
    const rows = await asUser(
      db,
      actor(APPROVER),
      async (tx) =>
        (
          await tx.query<{
            document_ref: string | null;
            counterparty_name: string | null;
            running_balance: string;
          }>(
            "select document_ref, counterparty_name, running_balance from public.general_ledger($1, $2, '2026-09-01', '2026-09-30')",
            [A, await accountId("6090")],
          )
        ).rows,
    );
    expect(rows.map((r) => [r.document_ref, r.counterparty_name, r.running_balance])).toEqual([
      ["OR-1001", "Sample Fuels Corp.", "2000.00"],
      ["OR-1002", "Sample Fuels Corp.", "3000.00"],
      ["OR-1002", "Sample Fuels Corp.", "2000.00"],
    ]);
  });
});

describe("counterparty and document fields", () => {
  it("normalizes TINs to the dashed form", async () => {
    const id = await saveDraft("2026-09-02", "TIN formats", [
      { code: "6100", debit: "50.00", name: "Toll A", tin: "123456789" },
      { code: "6100", debit: "50.00", name: "Toll B", tin: "123 456 789 001" },
      { code: "1020", credit: "100.00", name: "Bank", tin: "123-456-789-00000" },
    ]);
    expect((await linesOf(id)).map((l) => l.counterparty_tin)).toEqual([
      "123-456-789",
      "123-456-789-001",
      "123-456-789-00000",
    ]);
  });

  it("rejects a malformed TIN", async () => {
    for (const tin of ["12345", "123-456-789-0", "12A-456-789", "123-456-789-123456"]) {
      expect(
        await pgErrorCode(
          saveDraft("2026-09-02", "bad TIN", [
            { code: "6100", debit: "1.00", name: "X", tin },
            { code: "1020", credit: "1.00" },
          ]),
        ),
      ).toBe("22023");
    }
  });

  it("requires a name when a TIN is given", async () => {
    expect(
      await pgErrorCode(
        saveDraft("2026-09-02", "TIN without name", [
          { code: "6100", debit: "1.00", tin: "123456789" },
          { code: "1020", credit: "1.00" },
        ]),
      ),
    ).toBe("22023");
  });

  it("freezes the fields once posted (even for the table owner)", async () => {
    expect(
      await pgErrorCode(
        db.query(
          "update public.journal_lines set counterparty_name = 'Changed' where entry_id = $1",
          [fuelEntry],
        ),
      ),
    ).toBe("42501");
    expect(
      await pgErrorCode(
        db.query("update public.journal_lines set document_ref = 'OR-9999' where entry_id = $1", [
          fuelEntry,
        ]),
      ),
    ).toBe("42501");
  });

  it("is invisible to users without access to the client", async () => {
    for (const who of ["ownerB", "outsider"] as const) {
      const rows = await asUser(
        db,
        actor(who),
        async (tx) =>
          (
            await tx.query(
              "select counterparty_tin from public.journal_lines where client_id = $1",
              [A],
            )
          ).rows,
      );
      expect(rows).toEqual([]);
    }
  });
});
