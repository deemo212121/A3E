/**
 * Phase 16 operational checks (PGlite). Synthetic data only.
 *
 * 1. Performance and query analysis: 5,000 posted entries (10,000 lines) for
 *    one client plus noise for another; the main reads run as a real user
 *    under RLS and are timed; their plans must use indexes.
 * 2. Backup and restore drill: a full physical copy of the database is taken,
 *    restored into a NEW instance, and the restored books, audit trail and
 *    controls are verified. (PGlite's data-directory dump stands in for the
 *    platform backup; the production procedure is docs/runbooks/BACKUP-AND-RECOVERY.md.)
 *
 * Timings are from PGlite (single-process WebAssembly Postgres) and are only
 * an order-of-magnitude guide. They are not a production load test.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { actor, asUser, createTestDb, IDS, pgErrorCode, seedFixture, type Db } from "./harness";
import { intake } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;
const ENTRIES = 5000;

/** Bulk-loads balanced posted entries the way posting leaves them. */
async function load(client: string, n: number, seed: number) {
  await db.exec("begin");
  await db.query(
    `with acc as (
       select (select id from public.accounts where client_id = $1 and code = '1020') cash,
              (select id from public.accounts where client_id = $1 and code = '4010') sales
     ), e as (
       insert into public.journal_entries (client_id, fiscal_year_id, period_id, entry_date, memo, idempotency_key,
                                           prepared_by, status)
       select $1, p.fiscal_year_id, p.id, d, 'synthetic sale ' || g, 'bulk-' || $3 || '-' || g, $4, 'draft'
         from generate_series(1, $2) g
         cross join lateral (select date '2026-01-01' + ((g * 7) % 365) d) dd
         join public.accounting_periods p on p.client_id = $1 and dd.d between p.start_date and p.end_date
       returning id, client_id
     )
     insert into public.journal_lines (client_id, entry_id, line_no, account_id, debit, credit)
     select e.client_id, e.id, x.no, case x.no when 1 then acc.cash else acc.sales end,
            case x.no when 1 then 100.25 else 0 end, case x.no when 2 then 100.25 else 0 end
       from e cross join acc cross join (values (1), (2)) x(no)`,
    [client, n, seed, IDS.accountantB],
  );
  await db.query(
    `update public.journal_entries j set status = 'posted', entry_no = s.no, posted_at = now(), approved_by = $2
       from (select id, row_number() over (order by entry_date, id) + coalesce((select max(entry_no) from public.journal_entries where client_id = $1), 0) no
               from public.journal_entries where client_id = $1 and status = 'draft') s
      where j.id = s.id`,
    [client, IDS.reviewerA],
  );
  await db.exec("commit");
}

const timed = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const r = await fn();
  return { r, ms: Math.round(performance.now() - t) };
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  for (const [c, who] of [
    [A, "reviewerA"],
    [B, "manager"],
  ] as const) {
    await h.run(who, "select public.apply_coa_template($1, 'PH-SME-V0')", [c]);
    await h.run(who, "select public.create_fiscal_year($1, '2026-01-01'::date)", [c]);
  }
  await load(A, ENTRIES, 1);
  await load(B, 1000, 2);
  await db.exec("analyze");
}, 300_000);

describe("performance and query analysis (synthetic volume)", () => {
  const timings: Record<string, number> = {};

  it("the bulk load posted balanced books", async () => {
    const tb = await h.read<{ d: string; c: string }>(
      "reviewerA",
      "select sum(total_debit::numeric)::text d, sum(total_credit::numeric)::text c from public.trial_balance($1, '2026-12-31'::date)",
      [A],
    );
    expect(tb[0]).toEqual({ d: (ENTRIES * 100.25).toFixed(2), c: (ENTRIES * 100.25).toFixed(2) });
  });

  it("main reads under RLS stay fast at this volume", async () => {
    const runs: [string, string, unknown[]][] = [
      ["trial balance", "select * from public.trial_balance($1, '2026-12-31'::date)", [A]],
      [
        "general ledger (one account, full year)",
        "select * from public.general_ledger($1, (select id from public.accounts where client_id = $1 and code = '1020'), '2026-01-01'::date, '2026-12-31'::date)",
        [A],
      ],
      [
        "statement balances",
        "select * from public.report_account_balances($1, '2026-01-01'::date, '2026-12-31'::date)",
        [A],
      ],
      [
        "journal list (RLS)",
        "select id, entry_no, entry_date from public.journal_entries where client_id = $1 order by entry_date desc limit 100",
        [A],
      ],
      [
        "activity report",
        "select * from public.ops_activity_report($1, current_date - 1, current_date)",
        [A],
      ],
    ];
    for (const [name, sql, params] of runs) {
      const { ms } = await timed(() =>
        asUser(db, actor("reviewerA"), (tx) => tx.query(sql, params)),
      );
      timings[name] = ms;
    }
    console.warn("PHASE16_TIMINGS", JSON.stringify(timings));
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(5000);
  });

  it("hot lookups use indexes (no sequential scan of the line table)", async () => {
    const plan = async (sql: string, params: unknown[]) =>
      (await db.query<{ "QUERY PLAN": string }>(`explain ${sql}`, params)).rows
        .map((r) => r["QUERY PLAN"])
        .join("\n");
    const lines = await plan(
      "select * from public.journal_lines where entry_id = (select id from public.journal_entries where client_id = $1 limit 1)",
      [A],
    );
    expect(lines).toMatch(/Index/);
    expect(lines).not.toMatch(/Seq Scan on journal_lines/);
    const byAccount = await plan(
      "select sum(debit) from public.journal_lines where client_id = $1 and account_id = (select id from public.accounts where client_id = $1 and code = '1020')",
      [A],
    );
    expect(byAccount).toMatch(/Index|Bitmap/);
    // child tables are empty here, so check the index is usable at all
    await db.exec("set enable_seqscan = off");
    try {
      for (const [t, c] of [
        ["sales_invoice_lines", "invoice_id"],
        ["purchase_bill_lines", "bill_id"],
        ["import_rows", "batch_id"],
        ["payroll_lines", "payslip_id"],
      ])
        expect(await plan(`select * from public.${t} where ${c} = $1`, [IDS.clientA]), t).toMatch(
          /Index|Bitmap/,
        );
    } finally {
      await db.exec("set enable_seqscan = on");
    }
  });

  it("RLS keeps tenants apart at volume: the other client's staff see none of A's rows", async () => {
    const seen = await asUser(
      db,
      actor("accountantB"),
      async (tx) =>
        (
          await tx.query<{ n: number }>(
            "select count(*)::int n from public.journal_lines where client_id = $1",
            [A],
          )
        ).rows[0].n,
    );
    expect(seen).toBe(0);
  });
});

describe("backup and restore drill", () => {
  it("a full copy restores into a new instance with identical books, audit trail and controls", async () => {
    const fingerprint = async (d: Db) => ({
      tb: (
        await d.query<{ s: string }>(
          `select string_agg(code || ':' || total_debit || ':' || total_credit, ',' order by code) s
             from (select a.code, sum(l.debit)::text total_debit, sum(l.credit)::text total_credit
                     from public.journal_lines l join public.accounts a on a.id = l.account_id group by a.code) x`,
        )
      ).rows[0].s,
      entries: (await d.query<{ n: number }>("select count(*)::int n from public.journal_entries"))
        .rows[0].n,
      audit: (
        await d.query<{ n: number; last: string }>(
          "select count(*)::int n, max(id)::text last from audit.events",
        )
      ).rows[0],
      migrations: (
        await d.query<{ v: string }>(
          "select max(version) v from supabase_migrations.schema_migrations",
        )
      ).rows[0].v,
    });
    const before = await fingerprint(db);
    const { ms: dumpMs, r: backup } = await timed(() => db.dumpDataDir("none"));
    const { ms: restoreMs, r: restored } = await timed(async () => {
      const r = new PGlite({ loadDataDir: backup });
      await r.waitReady;
      return r;
    });
    try {
      expect(await fingerprint(restored)).toEqual(before);
      // controls survive the restore: posted entries stay immutable, RLS still applies
      const posted = (
        await restored.query<{ id: string }>(
          "select id from public.journal_entries where status = 'posted' limit 1",
        )
      ).rows[0].id;
      expect(
        await pgErrorCode(
          restored.query("update public.journal_entries set memo = 'tampered' where id = $1", [
            posted,
          ]),
        ),
      ).toBe("42501");
      const other = await asUser(
        restored,
        actor("ownerB"),
        async (tx) =>
          (
            await tx.query<{ n: number }>(
              "select count(*)::int n from public.journal_entries where client_id = $1",
              [A],
            )
          ).rows[0].n,
      );
      expect(other).toBe(0);
      console.warn("PHASE16_BACKUP", JSON.stringify({ bytes: backup.size, dumpMs, restoreMs }));
    } finally {
      await restored.close();
    }
  }, 300_000);
});
