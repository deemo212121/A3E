/**
 * Phase 6 import tests (PGlite). Synthetic data only.
 * Covers: staging, duplicate detection (existing records, within the file,
 * possible duplicates), retry-safe commit, row limits, permissions, isolation.
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db, type UserKey } from "./harness";
import { intake, newKey, purchase } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;

async function sourceFile(who: UserKey = "ownerA", client = A, category = "import_source") {
  const [d] = await h.run<{ document_id: string; object_path: string }>(
    who,
    "select * from public.begin_document_upload($1, $2, 'sales.csv', 'csv', 'text/csv', 100, $3, $4::public.document_category, null, null)",
    [client, newKey("src"), createHash("sha256").update(newKey("f")).digest("hex"), category],
  );
  await db.query(
    "insert into storage.objects (bucket_id, name, metadata) values ('client-documents', $1, '{\"size\":100}')",
    [d.object_path],
  );
  await h.run(who, "select public.complete_document_upload($1)", [d.document_id]);
  return d.document_id;
}

const CREATE =
  "select public.create_import_batch($1, $2, $3, $4, 'csv', null, $5::text[], $6::jsonb) as id";

async function batch(
  rows: unknown[][],
  target = "transactions",
  who: UserKey = "ownerA",
  key = newKey("batch"),
) {
  const doc = await sourceFile(who);
  const [r] = await h.run<{ id: string }>(who, CREATE, [
    A,
    key,
    doc,
    target,
    ["c1", "c2"],
    JSON.stringify(rows),
  ]);
  return r.id;
}

type Result = { row_no: number; normalized: Record<string, unknown> | null; errors: unknown[] };
const MAP = "select public.save_import_mapping($1, '{}'::jsonb, '{}'::jsonb, $2::jsonb) as s";
const COMMIT = "select public.commit_import_batch($1, $2) as s";

async function map(who: UserKey, id: string, results: Result[]) {
  const [r] = await h.run<{ s: Record<string, number> }>(who, MAP, [id, JSON.stringify(results)]);
  return r.s;
}
async function commit(who: UserKey, id: string, includePossible = false) {
  const [r] = await h.run<{ s: Record<string, number> }>(who, COMMIT, [id, includePossible]);
  return r.s;
}
async function outcomes(id: string) {
  const { rows } = await db.query<{
    row_no: number;
    outcome: string;
    duplicate_note: string | null;
  }>(
    "select row_no, outcome, duplicate_note from public.import_rows where batch_id = $1 order by row_no",
    [id],
  );
  return rows.map((r) => [r.row_no, r.outcome, r.duplicate_note]);
}

const sale = (ref: string | null, extra: Record<string, unknown> = {}) => ({
  kind: "sale",
  txn_date: "2026-09-10",
  document_ref: ref,
  counterparty_name: "Sample Hardware Inc.",
  counterparty_tin: "777888999000",
  gross_amount: "336000.00",
  ...extra,
});
const ok = (row_no: number, normalized: Record<string, unknown>): Result => ({
  row_no,
  normalized,
  errors: [],
});

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  // An already-recorded sale, to be detected as a duplicate.
  await h.saveTxn("ownerA", A, sale("SI-0451"));
}, 60_000);

describe("staging", () => {
  it("requires an uploaded import-source document of the same client", async () => {
    const receipt = await sourceFile("ownerA", A, "expense_receipt");
    expect(
      await h.errorOf("ownerA", CREATE, [A, newKey(), receipt, "transactions", ["a"], '[["1"]]']),
    ).toBe("22023");
    const otherClient = await sourceFile("ownerB", B);
    expect(
      await h.errorOf("ownerA", CREATE, [
        A,
        newKey(),
        otherClient,
        "transactions",
        ["a"],
        '[["1"]]',
      ]),
    ).toBe("22023");
  });

  it("limits a batch to 5000 rows and rejects empty files", async () => {
    const doc = await sourceFile();
    const tooMany = JSON.stringify(Array.from({ length: 5001 }, (_, i) => [String(i)]));
    expect(
      await h.messageOf("ownerA", CREATE, [A, newKey(), doc, "transactions", ["a"], tooMany]),
    ).toMatch(/at most 5000/);
    expect(await h.errorOf("ownerA", CREATE, [A, newKey(), doc, "transactions", ["a"], "[]"])).toBe(
      "22023",
    );
  });

  it("creating the same batch twice (retry) returns the same batch", async () => {
    const doc = await sourceFile();
    const key = newKey("same");
    const [a] = await h.run<{ id: string }>("ownerA", CREATE, [
      A,
      key,
      doc,
      "transactions",
      ["a"],
      '[["1"]]',
    ]);
    const [b] = await h.run<{ id: string }>("ownerA", CREATE, [
      A,
      key,
      doc,
      "transactions",
      ["a"],
      '[["1"]]',
    ]);
    expect(b.id).toBe(a.id);
  });

  it("viewers and other tenants cannot import", async () => {
    const doc = await sourceFile();
    expect(
      await h.errorOf("viewerA", CREATE, [A, newKey(), doc, "transactions", ["a"], '[["1"]]']),
    ).toBe("42501");
    expect(
      await h.errorOf("ownerB", CREATE, [A, newKey(), doc, "transactions", ["a"], '[["1"]]']),
    ).toBe("42501");
  });
});

describe("preview: row errors and duplicate detection", () => {
  let id = "";

  it("classifies every row", async () => {
    id = await batch(Array.from({ length: 7 }, (_, i) => [`r${i + 1}`]));
    const summary = await map("ownerA", id, [
      ok(1, sale("SI-0451")), // already recorded
      ok(2, sale("SI-0452")), // new
      ok(3, sale("si-0452", { counterparty_tin: "777-888-999-000" })), // same as row 2
      { row_no: 4, normalized: null, errors: [{ field: "txn_date", message: "Invalid date" }] },
      ok(5, sale(null, { kind: "collection", txn_date: "2026-09-11", gross_amount: "100.00" })), // no number
      ok(6, sale(null, { kind: "collection", txn_date: "2026-09-11", gross_amount: "100.00" })), // repeats row 5
      ok(7, sale("SI-0453")),
    ]);
    expect(summary).toEqual({
      total: 7,
      valid: 3,
      invalid: 1,
      duplicate: 2,
      possible_duplicate: 1,
    });
    expect(await outcomes(id)).toEqual([
      [1, "duplicate", "already recorded"],
      [2, "valid", null],
      [3, "duplicate", "same as row 2"],
      [4, "invalid", null],
      [5, "valid", null],
      [6, "possible_duplicate", "same date, amount and party as row 5"],
      [7, "valid", null],
    ]);
  });

  it("results must cover every row", async () => {
    expect(await h.errorOf("ownerA", MAP, [id, JSON.stringify([ok(1, sale("X"))])])).toBe("22023");
  });

  it("GATE: commit creates each valid row once; retries create nothing more", async () => {
    const first = await commit("ownerA", id);
    expect(first).toEqual({ total: 7, imported: 3, invalid: 1, duplicate: 2, skipped: 1 });
    const again = await commit("ownerA", id);
    const third = await commit("staffA", id, true);
    expect(again).toEqual(first);
    expect(third).toEqual(first);
    const { rows } = await db.query<{
      document_ref: string | null;
      status: string;
      source: string;
    }>(
      "select document_ref, status, source from public.intake_transactions where import_batch_id = $1 order by import_row_no",
      [id],
    );
    expect(rows).toEqual([
      { document_ref: "SI-0452", status: "submitted", source: "import" },
      { document_ref: null, status: "submitted", source: "import" },
      { document_ref: "SI-0453", status: "submitted", source: "import" },
    ]);
  });

  it("re-importing the same rows in a new batch finds them all as duplicates", async () => {
    const again = await batch([["a"], ["b"], ["c"]]);
    await map("staffA", again, [
      ok(1, sale("SI-0452")),
      ok(2, sale(null, { kind: "collection", txn_date: "2026-09-11", gross_amount: "100.00" })),
      ok(3, sale("SI-0453")),
    ]);
    expect((await outcomes(again)).map((o) => o[1])).toEqual([
      "duplicate",
      "possible_duplicate",
      "duplicate",
    ]);
    const summary = await commit("staffA", again);
    expect(summary).toMatchObject({ imported: 0, duplicate: 2, skipped: 1 });
  });

  it("possible duplicates are imported only when the user explicitly includes them", async () => {
    const b = await batch([["a"]]);
    await map("ownerA", b, [
      ok(1, sale(null, { kind: "collection", txn_date: "2026-09-11", gross_amount: "100.00" })),
    ]);
    expect(await commit("ownerA", b, true)).toMatchObject({ imported: 1 });
  });

  it("rows that pass the preview but fail the database's own rules are reported, not imported", async () => {
    const b = await batch([["a"], ["b"]]);
    await map("ownerA", b, [
      ok(1, sale("SI-0999", { counterparty_tin: "12345" })), // bad TIN slipped past the preview
      ok(2, sale("SI-1000", { txn_date: "2099-01-01" })), // future date
    ]);
    expect(await commit("ownerA", b)).toMatchObject({ imported: 0, invalid: 2 });
  });

  it("a committed batch cannot be re-mapped or cancelled", async () => {
    expect(await h.errorOf("ownerA", MAP, [id, JSON.stringify([])])).toBe("22023");
    expect(await h.errorOf("ownerA", "select public.cancel_import_batch($1)", [id])).toBe("22023");
  });

  it("other tenants cannot see or commit the batch", async () => {
    expect(
      await h.read("ownerB", "select 1 from public.import_rows where batch_id = $1", [id]),
    ).toEqual([]);
    expect(
      await h.read("ownerB", "select 1 from public.import_batches where id = $1", [id]),
    ).toEqual([]);
    expect(await h.errorOf("ownerB", COMMIT, [id, false])).toBe("P0002");
    expect(await h.errorOf("viewerA", COMMIT, [id, false])).toBe("42501");
  });
});

describe("customer/supplier list import", () => {
  it("imports suppliers once, detecting duplicates by TIN or name", async () => {
    await h.run("ownerA", "select public.save_counterparty($1, null, null, $2::jsonb, $3)", [
      A,
      JSON.stringify({
        kind: "supplier",
        registered_name: "Existing Supplier",
        tin: "100200300000",
      }),
      newKey(),
    ]);
    const b = await batch([["1"], ["2"], ["3"], ["4"]], "counterparties");
    const supplier = (name: string, tin: string | null) => ({
      kind: "supplier",
      registered_name: name,
      tin,
    });
    const summary = await map("ownerA", b, [
      ok(1, supplier("Existing (renamed)", "100-200-300-000")),
      ok(2, supplier("New Supplier", "200300400000")),
      ok(3, supplier("New Supplier copy", "200300400000")),
      ok(4, supplier("No TIN Store", null)),
    ]);
    expect(summary).toMatchObject({ valid: 2, duplicate: 2 });
    expect(await commit("ownerA", b)).toMatchObject({ imported: 2, duplicate: 2 });
    expect(await commit("ownerA", b)).toMatchObject({ imported: 2, duplicate: 2 });
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.counterparties where import_batch_id = $1 and status = 'submitted'",
      [b],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe("imports never post", () => {
  it("imported transactions stay submitted until staff review and approve them", async () => {
    const { rows } = await db.query<{ status: string }>(
      "select distinct status::text as status from public.intake_transactions where source = 'import'",
    );
    expect(rows.map((r) => r.status)).toEqual(["submitted"]);
    expect(purchase().kind).toBe("purchase");
  });
});
