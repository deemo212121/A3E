/**
 * Tour sandbox (0045): sample data built through the real workflows, each step
 * as the right demo person. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, IDS, seedFixture, type Db } from "./harness";
import { intake } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
let c = "";
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
}, 120_000);

describe("tour sandbox", () => {
  it("only firm users can build it, and only while it is switched on", async () => {
    expect(await h.errorOf("ownerA", "select public.tour_seed_sandbox()")).toBe("42501");
    await db.exec(
      "update private.settings set value = 'false'::jsonb where key = 'allow_tour_sandbox'",
    );
    expect(await h.errorOf("manager", "select public.tour_seed_sandbox()")).toBe("42501");
    await db.exec(
      "update private.settings set value = 'true'::jsonb where key = 'allow_tour_sandbox'",
    );
  });

  it("builds a working client through the real workflows, with the right people on each step", async () => {
    const [r] = await h.run<{ id: string }>("manager", "select public.tour_seed_sandbox() as id");
    c = r.id;
    const [client] = await q<{ code: string; display_name: string }>(
      "select code, display_name from public.clients where id = $1",
      [c],
    );
    expect(client.code).toMatch(/^ZZTEST-TOUR-/);
    expect(client.display_name).toMatch(/sample data/);

    // posted books balance; the approver is never the preparer
    const entries = await q<{ status: string; prepared_by: string; approved_by: string | null }>(
      "select status, prepared_by, approved_by from public.journal_entries where client_id = $1",
      [c],
    );
    expect(entries.filter((e) => e.status === "posted").length).toBe(3);
    expect(entries.filter((e) => e.status === "submitted").length).toBe(1);
    for (const e of entries.filter((x) => x.status === "posted"))
      expect(e.approved_by).not.toBe(e.prepared_by);
    expect(
      await q(
        `select e.id from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
          where e.client_id = $1 and e.status = 'posted' group by e.id having sum(l.debit) <> sum(l.credit)`,
        [c],
      ),
    ).toEqual([]);

    // work left for the user to do next
    const inv = await q<{ invoice_no: string; status: string }>(
      "select invoice_no, status from public.sales_invoices where client_id = $1 order by invoice_no",
      [c],
    );
    expect(inv).toEqual([
      { invoice_no: "SI-TOUR-0001", status: "posted" },
      { invoice_no: "SI-TOUR-0002", status: "submitted" },
    ]);
    expect(
      (
        await q<{ status: string }>(
          "select status from public.intake_transactions where client_id = $1 and kind = 'purchase'",
          [c],
        )
      )[0].status,
    ).toBe("submitted");

    // tax chain: reviewed computation, signed-off workpaper, validated and signed-off file, approved filing
    expect(
      (
        await q<{ status: string; tax: string }>(
          "select status, outputs ->> 'tax' tax from public.tax_computations where client_id = $1",
          [c],
        )
      )[0],
    ).toEqual({
      status: "reviewed",
      tax: "1000.00",
    });
    expect(
      (
        await q<{ status: string }>(
          "select status from public.tax_workpapers where client_id = $1",
          [c],
        )
      )[0].status,
    ).toBe("signed_off");
    expect(
      (
        await q<{ status: string }>("select status from public.output_runs where client_id = $1", [
          c,
        ])
      )[0].status,
    ).toBe("signed_off");
    const filings = await q<{ status: string }>(
      "select status from public.filings where client_id = $1 and status <> 'not_started'",
      [c],
    );
    expect(filings).toEqual([{ status: "approved" }]);

    // the client sees its business, last month's statements, and its request
    const owner = await h.read<{ id: string }>(
      "ownerA",
      "select id from public.clients where id = $1",
      [c],
    );
    expect(owner.length).toBe(1);
    const closed = await h.read<{ d: string }>(
      "ownerA",
      "select public.report_closed_through($1)::text d",
      [c],
    );
    expect(closed[0].d).toBe(
      (
        await q<{ d: string }>(
          "select (date_trunc('month', current_date) - interval '1 day')::date::text d",
        )
      )[0].d,
    );
    expect(
      (
        await h.read(
          "ownerA",
          "select id from public.notifications where kind = 'document_request' and client_id = $1",
          [c],
        )
      ).length,
    ).toBe(1);

    // the history names each demo person for their own step
    const actors = await q<{ actor_id: string }>(
      "select distinct actor_id from audit.events where client_id = $1 and actor_id is not null",
      [c],
    );
    const ids = actors.map((a) => a.actor_id);
    for (const who of [IDS.manager, IDS.reviewerA, IDS.accountantB, IDS.ownerA])
      expect(ids).toContain(who);
  });

  it("a second sandbox reuses the shared TOUR ONLY definitions", async () => {
    const [r] = await h.run<{ id: string }>(
      "accountantB",
      "select public.tour_seed_sandbox() as id",
    );
    expect(r.id).not.toBe(c);
    for (const [t, col, code] of [
      ["tax_rules", "code", "TOUR_SAMPLE_TAX"],
      ["tax_forms", "form_code", "TOUR_FORM"],
      ["output_specs", "output_code", "TOUR_SLS"],
      ["deadline_rules", "code", "TOUR-MONTHLY-RETURN"],
    ])
      expect((await q(`select id from public.${t} where ${col} = $1`, [code])).length, code).toBe(
        1,
      );
    await h.run("accountantB", "select public.tour_remove_sandbox($1)", [r.id]);
  });

  it("is removed completely, and only tour clients can be removed this way", async () => {
    expect(await h.errorOf("manager", "select public.tour_remove_sandbox($1)", [IDS.clientA])).toBe(
      "42501",
    );
    expect(await h.errorOf("ownerA", "select public.tour_remove_sandbox($1)", [c])).toBe("42501");
    await h.run("manager", "select public.tour_remove_sandbox($1)", [c]);
    expect(await q("select id from public.clients where id = $1", [c])).toEqual([]);
    expect(await q("select id from public.journal_entries where client_id = $1", [c])).toEqual([]);
  });

  it("never acts as a real person, and production readiness fails while it is on", async () => {
    await db.query(
      "insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-000000000099', 'real.person@firm.ph', now())",
    );
    await expect(
      db.query("select private.tour_as('00000000-0000-4000-8000-000000000099')"),
    ).rejects.toThrow(/only acts as demo accounts/);
  });
});
