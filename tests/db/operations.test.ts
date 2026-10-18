/**
 * Phase 15 firm operations (PGlite). Synthetic data only.
 *
 * The deadline rules here are TEST ONLY configurations (codes TEST-...). They
 * are not BIR deadlines; the platform ships with no deadline rules.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { actor, asUser, createTestDb, IDS, pgErrorCode, seedFixture, type Db } from "./harness";
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;
const PREP = "accountantB" as const; // also assigned to client A in beforeAll
const REV = "reviewerA" as const;
const MGR = "manager" as const;
let today = "";
const rule: Record<string, string> = {};
const filing: Record<string, string> = {};

const one = async <T extends Record<string, unknown>>(
  who: Parameters<typeof h.run>[0],
  sql: string,
  params: unknown[] = [],
) => (await h.run<T>(who, sql, params))[0];
const sql1 = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];
const versionOf = async (table: string, id: string) =>
  (await sql1<{ version: number }>(`select version from public.${table} where id = $1`, [id]))
    .version;
const notes = (who: Parameters<typeof h.read>[0], kind?: string) =>
  h.read<{ kind: string; title: string; body: string; client_id: string | null }>(
    who,
    `select kind, title, body, client_id from public.notifications ${kind ? "where kind = $1" : ""} order by created_at`,
    kind ? [kind] : [],
  );
const advance = (who: Parameters<typeof h.run>[0], id: string, action: string, data = {}) =>
  one<{ s: string }>(who, "select public.advance_filing($1, $2, $3::jsonb, null) as s", [
    id,
    action,
    JSON.stringify(data),
  ]);
const advanceErr = (who: Parameters<typeof h.run>[0], id: string, action: string, data = {}) =>
  h.errorOf(who, "select public.advance_filing($1, $2, $3::jsonb, null)", [
    id,
    action,
    JSON.stringify(data),
  ]);
const statusOf = async (table: string, id: string) =>
  (await sql1<{ status: string }>(`select status from public.${table} where id = $1`, [id])).status;

async function addDoc(client: string) {
  const id = (await sql1<{ id: string }>("select gen_random_uuid() as id")).id;
  await db.query(
    `insert into public.documents (id, client_id, storage_path, original_filename, extension, mime_type,
       size_bytes, sha256, category, upload_state, completed_at, idempotency_key)
     values ($1, $2, $3, 'statement.pdf', 'pdf', 'application/pdf', 100, $4, 'bank_statement', 'complete', now(), $5)`,
    [
      id,
      client,
      `clients/${client}/2026/10/${id}.pdf`,
      id.replace(/-/g, "").padEnd(64, "0"),
      newKey("doc"),
    ],
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  today = (await sql1<{ d: string }>("select current_date::text as d")).d;
}, 120_000);

// ---------------------------------------------------------------------------
describe("deadline configuration", () => {
  it("computes due dates: month offset, month-end clamp, weekend rule", async () => {
    const due = async (to: string, months: number, day: number, weekend: string) =>
      (
        await sql1<{ d: string }>("select private.ops_due_date($1::date, $2, $3, $4)::text as d", [
          to,
          months,
          day,
          weekend,
        ])
      ).d;
    expect(await due("2026-01-31", 1, 10, "none")).toBe("2026-02-10");
    expect(await due("2026-01-31", 1, 31, "none")).toBe("2026-02-28");
    expect(await due("2026-03-31", 0, 31, "none")).toBe("2026-03-31");
    // 2026-01-10 is a Saturday
    expect(await due("2025-12-31", 1, 10, "none")).toBe("2026-01-10");
    expect(await due("2025-12-31", 1, 10, "next_weekday")).toBe("2026-01-12");
    expect(await due("2026-01-31", 1, 10, "next_weekday")).toBe("2026-02-10");
  });

  it("enumerates fiscal periods aligned to the fiscal year end", async () => {
    const periods = async (freq: string, anchor: number, from: string, to: string) =>
      (
        await db.query<{ n: number; f: string; t: string }>(
          "select period_no as n, period_from::text as f, period_to::text as t from private.ops_periods($1, $2, $3::date, $4::date)",
          [freq, anchor, from, to],
        )
      ).rows;
    expect(await periods("quarterly", 12, "2026-01-01", "2026-12-31")).toEqual([
      { n: 1, f: "2026-01-01", t: "2026-03-31" },
      { n: 2, f: "2026-04-01", t: "2026-06-30" },
      { n: 3, f: "2026-07-01", t: "2026-09-30" },
      { n: 4, f: "2026-10-01", t: "2026-12-31" },
    ]);
    expect(await periods("annual", 6, "2026-01-01", "2027-12-31")).toEqual([
      { n: 1, f: "2025-07-01", t: "2026-06-30" },
      { n: 1, f: "2026-07-01", t: "2027-06-30" },
    ]);
    const fyJune = await periods("quarterly", 6, "2026-07-01", "2027-06-30");
    expect(fyJune.map((p) => [p.n, p.t])).toEqual([
      [1, "2026-09-30"],
      [2, "2026-12-31"],
      [3, "2027-03-31"],
      [4, "2027-06-30"],
    ]);
    const monthly = await periods("monthly", 12, "2026-01-01", "2026-03-31");
    expect(monthly.map((p) => p.n)).toEqual([1, 2, 3]);
  });

  it("rules need a source, and a second person verifies them", async () => {
    const propose = (who: Parameters<typeof h.run>[0], r: Record<string, unknown>) =>
      one<{ id: string }>(who, "select public.propose_deadline_rule($1::jsonb) as id", [
        JSON.stringify(r),
      ]);
    const base = {
      kind: "tax_return",
      frequency: "monthly",
      due_months_after: 1,
      due_day: 10,
      source: { citation: "TEST ONLY - synthetic deadline", issued_on: "2026-01-01" },
    };
    expect(
      await h.errorOf(PREP, "select public.propose_deadline_rule($1::jsonb)", [
        JSON.stringify({ ...base, code: "TEST-NOSRC", title: "No source", source: {} }),
      ]),
    ).toBe("22023");
    expect(
      await h.errorOf("ownerA", "select public.propose_deadline_rule($1::jsonb)", [
        JSON.stringify({ ...base, code: "TEST-OWNER", title: "Owner rule" }),
      ]),
    ).toBe("42501");
    rule.monthly = (
      await propose(PREP, { ...base, code: "TEST-M", title: "Test monthly return" })
    ).id;
    rule.quarterly = (
      await propose(PREP, {
        ...base,
        code: "TEST-Q",
        title: "Test quarterly return",
        frequency: "quarterly",
        due_months_after: 1,
        due_day: 25,
        skip_periods: [4],
      })
    ).id;
    expect(
      await h.errorOf(PREP, "select public.propose_deadline_rule($1::jsonb)", [
        JSON.stringify({ ...base, code: "TEST-BAD", title: "Bad skip", skip_periods: [13] }),
      ]),
    ).toBe("22023");
    const verify = "select public.verify_deadline_rule($1, $2, $3)";
    expect(await h.errorOf(PREP, verify, [rule.monthly, true, "checked"])).toBe("42501");
    expect(await h.errorOf(REV, verify, [rule.monthly, false, "checked the source"])).toBe("22023");
    await h.run(REV, verify, [rule.monthly, true, "checked against the test source"]);
    expect(await statusOf("deadline_rules", rule.monthly)).toBe("verified");
    // the quarterly rule stays PENDING VERIFICATION (still usable, flagged in the UI)
    expect(await statusOf("deadline_rules", rule.quarterly)).toBe("pending_verification");
    expect(await h.read("ownerA", "select * from public.deadline_rules")).toEqual([]);
  });

  it("client deadlines: reviewers/managers only, eligible assignees only", async () => {
    const set = "select public.set_client_deadline($1, $2, '2026-01-01'::date, 12, $3, $4) as id";
    expect(await h.errorOf(PREP, set, [A, rule.monthly, IDS.accountantB, IDS.reviewerA])).toBe(
      "42501",
    );
    expect(await h.errorOf(REV, set, [A, rule.monthly, IDS.firmAdmin, IDS.reviewerA])).toBe(
      "22023",
    );
    expect(await h.errorOf(REV, set, [A, rule.monthly, IDS.reviewerA, IDS.accountantB])).toBe(
      "22023",
    );
    await h.run(REV, set, [A, rule.monthly, IDS.accountantB, IDS.reviewerA]);
    await h.run(REV, set, [A, rule.quarterly, IDS.accountantB, IDS.reviewerA]);
    expect(await h.errorOf(REV, set, [A, rule.monthly, null, null])).toBe("23505");
  });

  it("generates the calendar once (retry-safe) and skips configured periods", async () => {
    const gen =
      "select public.generate_filing_calendar($1, '2026-01-01'::date, '2026-12-31'::date) as n";
    expect(await h.errorOf("ownerA", gen, [A])).toBe("42501");
    const first = await one<{ n: number }>(PREP, gen, [A]);
    expect(first.n).toBe(12 + 3);
    expect((await one<{ n: number }>(PREP, gen, [A])).n).toBe(0);
    const rows = await h.read<{
      id: string;
      form_code: string;
      period_from: string;
      due_on: string;
    }>(
      PREP,
      "select id, form_code, period_from::text, due_on::text from public.filings where client_id = $1 order by form_code, period_from",
      [A],
    );
    expect(rows).toHaveLength(15);
    const jan = rows.find((r) => r.form_code === "TEST-M" && r.period_from === "2026-01-01")!;
    expect(jan.due_on).toBe("2026-02-10");
    const q = rows.filter((r) => r.form_code === "TEST-Q").map((r) => r.due_on);
    expect(q).toEqual(["2026-04-25", "2026-07-25", "2026-10-25"]);
    filing.jan = jan.id;
    filing.feb = rows.find((r) => r.form_code === "TEST-M" && r.period_from === "2026-02-01")!.id;
    filing.mar = rows.find((r) => r.form_code === "TEST-M" && r.period_from === "2026-03-01")!.id;
    filing.apr = rows.find((r) => r.form_code === "TEST-M" && r.period_from === "2026-04-01")!.id;
    filing.may = rows.find((r) => r.form_code === "TEST-M" && r.period_from === "2026-05-01")!.id;
    // the default preparer and reviewer come from the client deadline
    const f = await sql1<{ preparer_id: string; reviewer_id: string; status: string }>(
      "select preparer_id, reviewer_id, status from public.filings where id = $1",
      [filing.jan],
    );
    expect(f).toEqual({
      preparer_id: IDS.accountantB,
      reviewer_id: IDS.reviewerA,
      status: "not_started",
    });
  });
});

// ---------------------------------------------------------------------------
describe("filing statuses: preparation, review, approval, export and filing are distinct", () => {
  it("walks every step with who and when; filed only from a real confirmation", async () => {
    const id = filing.jan;
    expect(await advanceErr(REV, id, "start")).toBe("42501"); // assigned to another preparer
    expect((await advance(PREP, id, "start")).s).toBe("in_preparation");
    expect(await advanceErr(PREP, id, "prepared")).toBe("22023"); // no workpaper and no note
    expect((await advance(PREP, id, "prepared", { note: "Prepared from the TEST ledger" })).s).toBe(
      "prepared",
    );
    expect(
      await advanceErr(PREP, id, "export", { method: "manual_form", reference: "x.pdf" }),
    ).toBe("22023");
    expect(await advanceErr(PREP, id, "confirm_filed")).toBe("22023");
    expect((await advance(PREP, id, "submit")).s).toBe("in_review");
    expect((await notes(REV, "filing_review")).length).toBe(1);
    expect(await advanceErr(PREP, id, "approve", { note: "approving my own work" })).toBe("42501");
    expect(await advanceErr(REV, id, "approve")).toBe("22023"); // approval note required
    expect(
      (await advance(REV, id, "approve", { note: "Reviewed all lines against TEST TB" })).s,
    ).toBe("approved");
    // approval is not filing; export is not filing
    expect(
      await advanceErr(PREP, id, "confirm_filed", {
        filed_on: today,
        channel: "TEST",
        reference: "REF-1",
        evidence: "doc 1",
      }),
    ).toBe("22023");
    expect(
      await advanceErr(PREP, id, "export", {
        method: "validated_file",
        output_run_id: "00000000-0000-4000-8000-0000000000ff",
      }),
    ).toBe("22023");
    expect(await advanceErr(PREP, id, "export", { method: "official_form_tool" })).toBe("22023");
    expect(
      (
        await advance(PREP, id, "export", {
          method: "official_form_tool",
          reference: "TEST-M-JAN.xml",
        })
      ).s,
    ).toBe("exported");
    expect(await statusOf("filings", id)).toBe("exported");
    const bad = [
      { filed_on: today, channel: "TEST", reference: "REF-1" }, // no evidence
      { filed_on: "2999-01-01", channel: "TEST", reference: "REF-1", evidence: "doc 1" },
      { filed_on: "2025-01-01", channel: "TEST", reference: "REF-1", evidence: "doc 1" }, // before the period
      { channel: "TEST", reference: "REF-1", evidence: "doc 1" },
    ];
    for (const data of bad) expect(await advanceErr(PREP, id, "confirm_filed", data)).toBe("22023");
    const confirm = {
      filed_on: today,
      channel: "TEST CHANNEL",
      reference: "TEST-CONF-0001",
      evidence: "Confirmation e-mail saved as document TEST-1",
    };
    expect((await advance(PREP, id, "confirm_filed", confirm)).s).toBe("filed");
    // a retried confirmation is a no-op
    expect((await advance(PREP, id, "confirm_filed", confirm)).s).toBe("filed");

    const f = await sql1<Record<string, string>>(
      "select prepared_by, approved_by, exported_by, filed_confirmed_by, filing_reference from public.filings where id = $1",
      [id],
    );
    expect(f).toEqual({
      prepared_by: IDS.accountantB,
      approved_by: IDS.reviewerA,
      exported_by: IDS.accountantB,
      filed_confirmed_by: IDS.accountantB,
      filing_reference: "TEST-CONF-0001",
    });
    const events = (
      await db.query<{ event: string; to_status: string; actor_id: string }>(
        "select event, to_status, actor_id from public.filing_events where filing_id = $1 order by id",
        [id],
      )
    ).rows;
    expect(events.map((e) => `${e.event}>${e.to_status}`)).toEqual([
      "created>not_started",
      "start>in_preparation",
      "prepared>prepared",
      "submit>in_review",
      "approve>approved",
      "export>exported",
      "confirm_filed>filed",
    ]);
    expect(events.find((e) => e.event === "approve")!.actor_id).toBe(IDS.reviewerA);
    // the client is told, without seeing the firm's workflow
    const owner = await notes("ownerA", "filing_filed");
    expect(owner).toHaveLength(1);
    expect(owner[0].body).toContain("TEST-M");
    expect(await h.read("ownerA", "select * from public.filings")).toEqual([]);
  });

  it("a filed return is frozen: no edits, no silent withdrawal", async () => {
    expect(
      await pgErrorCode(
        db.query("update public.filings set filing_reference = 'X' where id = $1", [filing.jan]),
      ),
    ).toBe("42501");
    expect(
      await pgErrorCode(
        db.query(
          "update public.filings set status = 'exported', filed_confirmed_by = null where id = $1",
          [filing.jan],
        ),
      ),
    ).toBe("42501");
    expect(
      await h.errorOf(PREP, "update public.filings set status = 'filed' where id = $1", [
        filing.feb,
      ]),
    ).toBe("42501");
    expect(await h.errorOf(PREP, "delete from public.filings where id = $1", [filing.feb])).toBe(
      "42501",
    );
  });

  it("review can return the filing; the preparer's sign is cleared", async () => {
    const id = filing.feb;
    await advance(PREP, id, "start");
    await advance(PREP, id, "prepared", { note: "Prepared from the TEST ledger" });
    await advance(PREP, id, "submit");
    expect(await advanceErr(REV, id, "return")).toBe("22023");
    expect((await advance(REV, id, "return", { note: "Line 3 needs support" })).s).toBe(
      "in_preparation",
    );
    expect(
      await sql1("select prepared_by, approved_by from public.filings where id = $1", [id]),
    ).toEqual({ prepared_by: null, approved_by: null });
    expect((await notes(PREP, "filing_returned")).length).toBe(1);
  });

  it("not required: firm managers only, with a reason", async () => {
    expect(
      await advanceErr(REV, filing.mar, "not_required", { note: "No operations in March" }),
    ).toBe("42501");
    expect(await advanceErr(MGR, filing.mar, "not_required")).toBe("22023");
    expect(
      (await advance(MGR, filing.mar, "not_required", { note: "No operations in March" })).s,
    ).toBe("not_required");
  });

  it("stale versions are refused (retry after someone else's change)", async () => {
    const v = await versionOf("filings", filing.apr);
    await h.run(PREP, "select public.advance_filing($1, 'start', '{}'::jsonb, $2)", [
      filing.apr,
      v,
    ]);
    expect(
      await h.errorOf(
        PREP,
        "select public.advance_filing($1, 'prepared', '{\"note\":\"prepared from ledger\"}'::jsonb, $2)",
        [filing.apr, v],
      ),
    ).toBe("40001");
  });

  it("an amendment is a new filing; the original stays filed", async () => {
    expect(
      await h.errorOf(PREP, "select public.amend_filing($1, 'Correcting TEST line')", [filing.jan]),
    ).toBe("42501");
    const amended = await one<{ id: string }>(
      REV,
      "select public.amend_filing($1, 'Correcting a TEST line') as id",
      [filing.jan],
    );
    expect(
      await sql1("select status, amends_id from public.filings where id = $1", [amended.id]),
    ).toEqual({ status: "not_started", amends_id: filing.jan });
    expect(await statusOf("filings", filing.jan)).toBe("filed");
  });

  it("reassignment: managers only, with a reason; others may only claim", async () => {
    const id = filing.may;
    const v = await versionOf("filings", id);
    expect(
      await h.errorOf(REV, "select public.assign_filing($1, $2, $3, 'handover', $4)", [
        id,
        IDS.reviewerA,
        null,
        v,
      ]),
    ).toBe("42501");
    expect(
      await h.errorOf(MGR, "select public.assign_filing($1, $2, $3, null, $4)", [
        id,
        IDS.reviewerA,
        IDS.manager,
        v,
      ]),
    ).toBe("22023");
    await h.run(MGR, "select public.assign_filing($1, $2, $3, 'Workload balancing', $4)", [
      id,
      IDS.reviewerA,
      IDS.manager,
      v,
    ]);
    expect(
      await sql1("select preparer_id, reviewer_id from public.filings where id = $1", [id]),
    ).toEqual({ preparer_id: IDS.reviewerA, reviewer_id: IDS.manager });
    expect((await notes(REV, "filing_assigned")).length).toBeGreaterThan(0);
  });

  it("even a manager cannot approve a filing they prepared", async () => {
    const id = filing.may;
    await h.run(MGR, "select public.assign_filing($1, $2, $3, 'Manager prepares', $4)", [
      id,
      IDS.manager,
      IDS.reviewerA,
      await versionOf("filings", id),
    ]);
    await advance(MGR, id, "start");
    await advance(MGR, id, "prepared", { note: "Prepared from the TEST ledger" });
    await advance(MGR, id, "submit");
    expect(await advanceErr(MGR, id, "approve", { note: "Approving my own return" })).toBe("42501");
    expect(
      (await advance(REV, id, "approve", { note: "Reviewed against the TEST ledger" })).s,
    ).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
describe("work queue", () => {
  const item: Record<string, string> = {};
  const create = (who: Parameters<typeof h.run>[0], client: string, body: object, key: string) =>
    one<{ id: string }>(who, "select public.create_work_item($1, $2::jsonb, $3) as id", [
      client,
      JSON.stringify(body),
      key,
    ]);
  const move = (
    who: Parameters<typeof h.run>[0],
    id: string,
    to: string,
    note: string | null = null,
  ) => h.run(who, "select public.transition_work_item($1, $2, $3, null)", [id, to, note]);
  const moveErr = (
    who: Parameters<typeof h.run>[0],
    id: string,
    to: string,
    note: string | null = null,
  ) => h.errorOf(who, "select public.transition_work_item($1, $2, $3, null)", [id, to, note]);

  it("creation is idempotent and limited to the client's staff", async () => {
    const key = newKey("work");
    const body = {
      title: "Reconcile TEST bank account",
      assignee_id: IDS.accountantB,
      reviewer_id: IDS.reviewerA,
      due_on: today,
    };
    item.a = (await create(PREP, A, body, key)).id;
    expect((await create(PREP, A, body, key)).id).toBe(item.a);
    expect(
      await h.errorOf(REV, "select public.create_work_item($1, $2::jsonb, $3)", [
        A,
        JSON.stringify(body),
        key,
      ]),
    ).toBe("23505");
    expect(
      await h.errorOf("ownerA", "select public.create_work_item($1, $2::jsonb, $3)", [
        A,
        JSON.stringify(body),
        newKey("work"),
      ]),
    ).toBe("P0002");
    expect(
      await h.errorOf(REV, "select public.create_work_item($1, $2::jsonb, $3)", [
        B,
        JSON.stringify(body),
        newKey("work"),
      ]),
    ).toBe("P0002");
    expect(
      await h.errorOf(PREP, "select public.create_work_item($1, $2::jsonb, $3)", [
        A,
        JSON.stringify({ ...body, assignee_id: IDS.firmAdmin }),
        newKey("work"),
      ]),
    ).toBe("22023");
    expect((await notes(PREP, "work_assigned")).length).toBe(0); // never notified of your own action
  });

  it("transitions follow the workflow; the doer cannot approve", async () => {
    const id = item.a;
    expect(await moveErr(PREP, id, "done")).toBe("22023");
    await move(PREP, id, "in_progress");
    expect(await moveErr(REV, id, "waiting_client")).toBe("42501");
    await move(PREP, id, "in_review");
    expect((await notes(REV, "work_review")).length).toBe(1);
    expect(await moveErr(PREP, id, "done")).toBe("42501");
    expect(await moveErr(REV, id, "in_progress")).toBe("22023");
    await move(REV, id, "in_progress", "Attach the TEST bank statement");
    await move(PREP, id, "in_review");
    await move(REV, id, "done");
    expect(
      await sql1("select status, completed_by from public.work_items where id = $1", [id]),
    ).toEqual({ status: "done", completed_by: IDS.reviewerA });
    const events = (
      await db.query<{ event: string }>(
        "select event from public.work_item_events where item_id = $1 order by id",
        [id],
      )
    ).rows.map((e) => e.event);
    expect(events).toEqual([
      "created",
      "in_progress",
      "in_review",
      "returned",
      "in_review",
      "done",
    ]);
    expect(await moveErr(PREP, id, "cancelled", "too late")).toBe("22023");
  });

  it("a stale version is refused; a repeated move is a no-op", async () => {
    item.b = (
      await create(
        PREP,
        A,
        { title: "Collect TEST receipts", assignee_id: IDS.accountantB, requires_review: false },
        newKey("work"),
      )
    ).id;
    const v = await versionOf("work_items", item.b);
    await h.run(PREP, "select public.transition_work_item($1, 'in_progress', null, $2)", [
      item.b,
      v,
    ]);
    await h.run(PREP, "select public.transition_work_item($1, 'in_progress', null, $2)", [
      item.b,
      v,
    ]);
    expect(
      await h.errorOf(PREP, "select public.transition_work_item($1, 'waiting_client', null, $2)", [
        item.b,
        v,
      ]),
    ).toBe("40001");
    await move(PREP, item.b, "done"); // no review required
    expect(await statusOf("work_items", item.b)).toBe("done");
  });

  it("reassignment needs a manager and a reason; unassigned items can be claimed", async () => {
    item.c = (
      await create(
        PREP,
        A,
        { title: "Follow up TEST supplier", assignee_id: IDS.accountantB },
        newKey("w"),
      )
    ).id;
    const v = await versionOf("work_items", item.c);
    const assign = "select public.assign_work_item($1, $2, $3, $4, $5)";
    expect(await h.errorOf(REV, assign, [item.c, IDS.reviewerA, null, "taking over", v])).toBe(
      "42501",
    );
    expect(await h.errorOf(MGR, assign, [item.c, IDS.reviewerA, null, null, v])).toBe("22023");
    await h.run(MGR, assign, [item.c, IDS.reviewerA, null, "Leave cover", v]);
    expect((await notes(PREP, "work_reassigned")).length).toBe(1);
    expect((await notes(REV, "work_assigned")).length).toBe(1);

    item.d = (await create(REV, A, { title: "Unassigned TEST task" }, newKey("w"))).id;
    await h.run(PREP, assign, [
      item.d,
      IDS.accountantB,
      null,
      null,
      await versionOf("work_items", item.d),
    ]);
    expect(
      (
        await sql1<{ assignee_id: string }>(
          "select assignee_id from public.work_items where id = $1",
          [item.d],
        )
      ).assignee_id,
    ).toBe(IDS.accountantB);
    expect(await moveErr(REV, item.c, "cancelled", "not mine")).toBe("42501");
    await move(MGR, item.c, "cancelled", "Duplicate of another item");
  });

  it("even a manager cannot approve their own work", async () => {
    const id = (
      await create(
        REV,
        A,
        { title: "Manager's own TEST task", assignee_id: IDS.manager, reviewer_id: IDS.reviewerA },
        newKey("w"),
      )
    ).id;
    await move(MGR, id, "in_progress");
    await move(MGR, id, "in_review");
    expect(await moveErr(MGR, id, "done")).toBe("42501");
    expect(await moveErr(MGR, id, "in_progress", "returning my own")).toBe("42501");
    await move(REV, id, "done");
  });

  it("losing access to the client releases open work and tells managers", async () => {
    item.e = (
      await create(
        MGR,
        A,
        { title: "TEST access change", assignee_id: IDS.accountantB },
        newKey("w"),
      )
    ).id;
    await db.query("delete from public.client_assignments where client_id = $1 and user_id = $2", [
      A,
      IDS.accountantB,
    ]);
    const w = await sql1<{ assignee_id: string | null }>(
      "select assignee_id from public.work_items where id = $1",
      [item.e],
    );
    expect(w.assignee_id).toBeNull();
    // completed steps keep their accountability
    expect(
      (
        await sql1<{ prepared_by: string }>(
          "select prepared_by from public.filings where id = $1",
          [filing.jan],
        )
      ).prepared_by,
    ).toBe(IDS.accountantB);
    expect((await notes(MGR, "work_unassigned")).length).toBeGreaterThan(0);
    await db.query(
      "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
      [A, IDS.accountantB],
    );
  });
});

// ---------------------------------------------------------------------------
describe("missing-document requests", () => {
  let req = "";
  it("staff request; client owners and staff are notified without details", async () => {
    req = (
      await one<{ id: string }>(
        REV,
        "select public.create_document_request($1, $2::jsonb, $3) as id",
        [
          A,
          JSON.stringify({
            title: "Bank statement for the deposit of 1,250.00",
            category: "bank_statement",
            due_on: today,
          }),
          newKey("req"),
        ],
      )
    ).id;
    for (const who of ["ownerA", "staffA"] as const) {
      const n = await notes(who, "document_request");
      expect(n).toHaveLength(1);
      expect(`${n[0].title} ${n[0].body}`).not.toContain("1,250");
    }
    expect(await notes("viewerA", "document_request")).toEqual([]);
    expect((await h.read("viewerA", "select id from public.document_requests")).length).toBe(1);
    expect(await h.read("ownerB", "select id from public.document_requests")).toEqual([]);
    expect(
      await h.errorOf("ownerA", "select public.create_document_request($1, $2::jsonb, $3)", [
        A,
        JSON.stringify({ title: "x req", due_on: today }),
        newKey("req"),
      ]),
    ).toBe("P0002");
  });

  it("notifications cannot carry money amounts", async () => {
    expect(
      await pgErrorCode(
        db.query(
          "insert into public.notifications (recipient_id, kind, title, body, dedupe_key) values ($1, 'test', 'Balance', 'Your balance is 12,500.00', 'test-1')",
          [IDS.ownerA],
        ),
      ),
    ).toBe("23514");
    expect(
      await pgErrorCode(
        db.query(
          "insert into public.notifications (recipient_id, kind, title, body, dedupe_key) values ($1, 'test', 'Due', 'Due ₱ soon', 'test-2')",
          [IDS.ownerA],
        ),
      ),
    ).toBe("23514");
  });

  it("the client responds with its own documents; staff accept or return", async () => {
    const mine = await addDoc(A);
    const other = await addDoc(B);
    const respond = "select public.respond_document_request($1, $2::uuid[], $3, null)";
    expect(await h.errorOf("viewerA", respond, [req, [mine], null])).toBe("42501");
    expect(await h.errorOf(REV, respond, [req, [mine], null])).toBe("42501");
    expect(await h.errorOf("staffA", respond, [req, [], null])).toBe("22023");
    expect(await h.errorOf("staffA", respond, [req, [other], null])).toBe("22023");
    await h.run("staffA", respond, [req, [mine], "Attached"]);
    await h.run("staffA", respond, [req, [mine], "Attached"]); // retried
    expect((await notes(REV, "document_response")).length).toBe(1);
    const decide = "select public.decide_document_request($1, $2, $3, null)";
    expect(await h.errorOf(REV, decide, [req, "return", null])).toBe("22023");
    expect(await h.errorOf("ownerA", decide, [req, "accept", null])).toBe("P0002");
    await h.run(REV, decide, [req, "return", "Page 2 is missing"]);
    expect((await notes("ownerA", "document_request_returned")).length).toBe(1);
    await h.run("ownerA", respond, [req, [mine], "Full statement attached"]);
    await h.run(REV, decide, [req, "accept", null]);
    expect(
      await sql1(
        "select status, responded_by, decided_by from public.document_requests where id = $1",
        [req],
      ),
    ).toEqual({ status: "accepted", responded_by: IDS.ownerA, decided_by: IDS.reviewerA });
    expect(await h.errorOf("ownerA", respond, [req, [mine], "again"])).toBe("22023");
  });
});

// ---------------------------------------------------------------------------
describe("reminders", () => {
  it("managers (or the scheduler) run them; a retried run sends nothing twice", async () => {
    await h.run(
      MGR,
      "select public.add_filing($1, 'TEST-ADHOC', 'Test ad hoc return', '2026-01-01', '2026-01-31', current_date, 'TEST ONLY manual date')",
      [A],
    );
    await h.run(REV, "select public.create_document_request($1, $2::jsonb, $3)", [
      A,
      JSON.stringify({ title: "TEST payroll register", due_on: today }),
      newKey("req"),
    ]);
    const run = "select public.run_reminders(current_date) as r";
    expect(await h.errorOf(PREP, run)).toBe("42501");
    expect(await h.errorOf(MGR, "select public.run_reminders(current_date + 400)")).toBe("22023");
    const first = (await one<{ r: { filings: number; requests: number; work: number } }>(MGR, run))
      .r;
    expect(first.filings).toBeGreaterThan(0); // the unassigned ad hoc filing -> managers
    expect(first.requests).toBe(2); // owner and staff of client A
    const second = (await one<{ r: { filings: number; requests: number; work: number } }>(MGR, run))
      .r;
    expect(second).toEqual({ filings: 0, requests: 0, work: 0 });
    const due = await notes("ownerA", "document_reminder");
    expect(due.map((n) => n.title)).toEqual(["A document request is due today"]);
    expect(await notes(MGR, "filing_due")).toHaveLength(1);
  });

  it("users read and clear only their own notifications", async () => {
    const mine = await h.read<{ id: string }>("ownerA", "select id from public.notifications");
    expect(mine.length).toBeGreaterThan(0);
    const othersSeen = await h.read(
      "ownerA",
      "select id from public.notifications where recipient_id <> $1",
      [IDS.ownerA],
    );
    expect(othersSeen).toEqual([]);
    const n = await one<{ n: number }>(
      "staffA",
      "select public.mark_notifications_read($1::uuid[]) as n",
      [mine.map((m) => m.id)],
    );
    expect(n.n).toBe(0); // someone else's ids change nothing
    expect(
      (await one<{ n: number }>("ownerA", "select public.mark_notifications_read(null) as n")).n,
    ).toBe(mine.length);
    expect(await h.errorOf("ownerA", "update public.notifications set read_at = null")).toBe(
      "42501",
    );
  });
});

// ---------------------------------------------------------------------------
describe("exceptions: locked periods, due dates, filing corrections", () => {
  let jan = "";
  it("a locked period reopens only through an exception approved by another manager", async () => {
    await h.run(MGR, "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
    jan = (
      await sql1<{ id: string }>(
        "select id from public.accounting_periods where client_id = $1 and period_no = 1",
        [A],
      )
    ).id;
    await h.run(MGR, "select public.set_period_status($1, 'locked', 'January closed')", [jan]);
    expect(
      await h.errorOf(MGR, "select public.set_period_status($1, 'open', 'need to fix')", [jan]),
    ).toBe("42501");
    const req = "select public.request_exception($1, 'reopen_locked_period', $2::jsonb, $3) as id";
    expect(
      await h.errorOf("ownerA", req, [
        A,
        JSON.stringify({ period_id: jan }),
        "Correct a TEST entry",
      ]),
    ).toBe("42501");
    const e = (
      await one<{ id: string }>(REV, req, [
        A,
        JSON.stringify({ period_id: jan, target_status: "soft_closed" }),
        "Correct a misposted TEST entry",
      ])
    ).id;
    expect(
      await h.errorOf(REV, req, [
        A,
        JSON.stringify({ period_id: jan }),
        "Correct a misposted TEST entry",
      ]),
    ).toBe("23505");
    expect((await notes(MGR, "exception_requested")).length).toBe(1);
    const decide = "select public.decide_exception($1, $2, $3) as s";
    expect(await h.errorOf(REV, decide, [e, true, "ok"])).toBe("42501");
    expect(await h.errorOf(MGR, decide, [e, true, ""])).toBe("22023");
    expect(
      (await one<{ s: string }>(MGR, decide, [e, true, "Approved for the correction"])).s,
    ).toBe("approved");
    expect(await statusOf("accounting_periods", jan)).toBe("soft_closed");
    expect((await notes(REV, "exception_decided")).length).toBe(1);
    // an executed approval cannot be replayed
    await h.run(MGR, "select public.set_period_status($1, 'locked', 'January closed again')", [
      jan,
    ]);
    const replay = await asUser(db, actor(MGR), async (tx) => {
      await tx.query("select set_config('app.ops_exception', $1, true)", [e]);
      return pgErrorCode(
        tx.query("select public.set_period_status($1, 'soft_closed', 'replay')", [jan]),
      );
    });
    expect(replay).toBe("42501");
  });

  it("the requester cannot decide their own exception", async () => {
    const e = (
      await one<{ id: string }>(
        MGR,
        "select public.request_exception($1, 'other', '{}'::jsonb, $2) as id",
        [A, "Waive the TEST internal deadline"],
      )
    ).id;
    expect(
      await h.errorOf(MGR, "select public.decide_exception($1, true, 'self approval')", [e]),
    ).toBe("42501");
    await h.run(MGR, "select public.cancel_exception($1)", [e]);
  });

  it("due-date changes go through an approved exception and are recorded", async () => {
    const e = (
      await one<{ id: string }>(
        PREP,
        "select public.request_exception($1, 'change_due_date', $2::jsonb, $3) as id",
        [
          A,
          JSON.stringify({ filing_id: filing.apr, new_due_on: "2026-05-15" }),
          "TEST ONLY extension notice",
        ],
      )
    ).id;
    await h.run(MGR, "select public.decide_exception($1, true, 'Extension verified')", [e]);
    expect(
      await sql1("select due_on::text, due_basis from public.filings where id = $1", [filing.apr]),
    ).toEqual({ due_on: "2026-05-15", due_basis: "approved_change" });
    const ev = await sql1<{ event: string }>(
      "select event from public.filing_events where filing_id = $1 order by id desc limit 1",
      [filing.apr],
    );
    expect(ev.event).toBe("due_date_changed");
  });

  it("a wrong filing confirmation is withdrawn by exception, keeping the history", async () => {
    const e = (
      await one<{ id: string }>(
        REV,
        "select public.request_exception($1, 'withdraw_filing_confirmation', $2::jsonb, $3) as id",
        [A, JSON.stringify({ filing_id: filing.jan }), "Reference belonged to another TEST return"],
      )
    ).id;
    await h.run(
      MGR,
      "select public.decide_exception($1, true, 'Checked the confirmation e-mail')",
      [e],
    );
    expect(
      await sql1("select status, filing_reference from public.filings where id = $1", [filing.jan]),
    ).toEqual({ status: "exported", filing_reference: null });
    const ev = await sql1<{ note: string }>(
      "select note from public.filing_events where filing_id = $1 and event = 'filing_confirmation_withdrawn'",
      [filing.jan],
    );
    expect(ev.note).toContain("TEST-CONF-0001");
    const rejected = (
      await one<{ id: string }>(
        PREP,
        "select public.request_exception($1, 'other', '{}'::jsonb, $2) as id",
        [A, "Another TEST exception request"],
      )
    ).id;
    expect(
      (
        await one<{ s: string }>(
          MGR,
          "select public.decide_exception($1, false, 'Not needed') as s",
          [rejected],
        )
      ).s,
    ).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
describe("service status and activity reports", () => {
  it("service status: managers only, kept as history", async () => {
    const set = "select public.set_client_service_status($1, $2, $3)";
    expect(await h.errorOf(REV, set, [A, "on_hold", "Waiting for TEST documents"])).toBe("42501");
    await h.run(MGR, set, [A, "active", "Engagement signed (TEST)"]);
    await h.run(MGR, set, [A, "awaiting_client", "Waiting for TEST documents"]);
    await h.run(MGR, set, [A, "awaiting_client", "Same status again"]);
    const rows = await h.read<{ status: string }>(
      REV,
      "select status from public.client_service_status where client_id = $1 order by id",
      [A],
    );
    expect(rows.map((r) => r.status)).toEqual(["active", "awaiting_client"]);
    expect(await h.read("ownerA", "select * from public.client_service_status")).toEqual([]);
  });

  it("activity reports show who did what (no values) to authorized people only", async () => {
    const report = "select * from public.ops_activity_report($1, current_date - 1, current_date)";
    const rows = await h.read<{
      action: string;
      actor_id: string;
      changed_fields: string[] | null;
    }>(REV, report, [A]);
    expect(rows.length).toBeGreaterThan(10);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "action",
        "actor_id",
        "actor_name",
        "changed_fields",
        "client_code",
        "client_id",
        "occurred_at",
        "row_id",
        "table_name",
      ].sort(),
    );
    const filed = rows.find(
      (r) => r.action === "update:filings" && (r.changed_fields ?? []).includes("filing_reference"),
    );
    expect(filed).toBeDefined();
    expect(await h.errorOf(REV, report, [B])).toBe("42501");
    expect(await h.errorOf(PREP, report, [A])).toBe("42501");
    expect(await h.errorOf("firmAdmin", report, [A])).toBe("42501");
    expect(await h.errorOf(REV, report, [null])).toBe("42501");
    const firm = await h.run<{ client_id: string | null }>("firmAdmin", report, [null]);
    expect(firm.every((r) => r.client_id === null)).toBe(true);
    expect(
      await h.errorOf(
        MGR,
        "select * from public.ops_activity_report($1, '2020-01-01', current_date)",
        [A],
      ),
    ).toBe("22023");
    const logged = await sql1<{ n: number }>(
      "select count(*)::int as n from audit.events where action = 'ops.activity_report_viewed'",
    );
    expect(logged.n).toBeGreaterThan(0);
  });

  it("client users never see the firm's internal workflow", async () => {
    for (const t of [
      "work_items",
      "filings",
      "ops_exceptions",
      "filing_events",
      "work_item_events",
      "client_deadlines",
    ]) {
      expect(await h.read("ownerA", `select * from public.${t}`), t).toEqual([]);
    }
    for (const t of ["work_items", "filings", "document_requests"]) {
      expect(
        await h.read("accountantB", `select * from public.${t} where client_id = $1`, [B]),
        t,
      ).toEqual([]);
    }
  });
});
