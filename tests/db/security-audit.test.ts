/**
 * Phase 16 security audit (PGlite). Synthetic data only.
 *
 *  1. Catalog checks over EVERY object, so a future migration that forgets a
 *     control fails here: RLS enabled and forced on every table, no anon
 *     access, no direct writes except the allow-listed columns, every
 *     SECURITY DEFINER function pins search_path, private helpers exposed to
 *     users are read-only, idempotency keys are unique.
 *  2. Privilege escalation: every public function is called by a user with no
 *     role (and by a client user) with empty arguments; nothing may change.
 *  3. Session controls: staff without MFA, disabled accounts.
 *  4. Guard bypass: the maintenance switch cannot be used by an end user.
 *  5. Injection: SQL-looking text is stored literally; the tax formula
 *     language rejects anything it does not define.
 *
 * This is automated coverage only. It is NOT an independent penetration test.
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
import { intake, newKey } from "./intake-helpers";

let db: Db;
let h: ReturnType<typeof intake>;
const A: string = IDS.clientA;
const B: string = IDS.clientB;

const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;

/** Row counts of every public table (and audit-free), to detect any write. */
async function snapshot(): Promise<Record<string, number>> {
  const tables = await rows<{ t: string }>(
    "select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1",
  );
  const out: Record<string, number> = {};
  for (const { t } of tables)
    out[t] = (await rows<{ n: number }>(`select count(*)::int n from public.${t}`))[0].n;
  return out;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
  h = intake(db);
  await db.query(
    "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
    [A, IDS.accountantB],
  );
  await h.run("reviewerA", "select public.apply_coa_template($1, 'PH-SME-V0')", [A]);
  await h.run("reviewerA", "select public.create_fiscal_year($1, '2026-01-01'::date)", [A]);
}, 120_000);

// ---------------------------------------------------------------------------
describe("catalog: every object carries its controls", () => {
  it("every public table has RLS enabled AND forced, and at least one policy", async () => {
    expect(
      await rows(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','p') and not (c.relrowsecurity and c.relforcerowsecurity)`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`,
      ),
    ).toEqual([]);
  });

  it("anon has no table, sequence or function access in public, private or audit", async () => {
    expect(
      await rows(
        "select table_name from information_schema.role_table_grants where grantee = 'anon' and table_schema in ('public','private','audit')",
      ),
    ).toEqual([]);
    expect(
      await rows(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','private','audit') and has_function_privilege('anon', p.oid, 'execute')`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'S' and n.nspname in ('public', 'audit')
            and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage'))`,
      ),
    ).toEqual([]);
  });

  it("users write directly only to the allow-listed columns; everything else goes through checked functions", async () => {
    const writes = await rows<{ t: string; c: string; p: string }>(
      `select table_name t, column_name c, privilege_type p from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT'
       union
       select table_name, '*', privilege_type from information_schema.role_table_grants
        where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT'
       order by 1, 2, 3`,
    );
    expect(writes.map((w) => `${w.t}.${w.c}:${w.p}`)).toEqual([
      "client_contacts.*:DELETE",
      "client_contacts.client_id:INSERT",
      "client_contacts.email:INSERT",
      "client_contacts.email:UPDATE",
      "client_contacts.full_name:INSERT",
      "client_contacts.full_name:UPDATE",
      "client_contacts.phone:INSERT",
      "client_contacts.phone:UPDATE",
      "client_contacts.position:INSERT",
      "client_contacts.position:UPDATE",
      "profiles.full_name:UPDATE",
    ]);
    expect(
      await rows(
        "select table_name from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'audit'",
      ),
    ).toEqual([]);
  });

  it("every function pins search_path; private helpers callable by users are read-only", async () => {
    expect(
      await rows(
        `select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','private','audit')
            and not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=""'])`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('private','audit') and has_function_privilege('authenticated', p.oid, 'execute')
            and p.provolatile = 'v'`,
      ),
    ).toEqual([]);
  });

  it("no views (they would bypass RLS by default); idempotency keys are unique; storage is private", async () => {
    expect(
      await rows("select table_name from information_schema.views where table_schema = 'public'"),
    ).toEqual([]);
    expect(
      await rows(
        `select c.table_name from information_schema.columns c where c.table_schema = 'public' and c.column_name = 'idempotency_key'
          and not exists (select 1 from pg_index i join pg_class t on t.oid = i.indrelid
                          join pg_attribute a on a.attrelid = t.oid and a.attnum = any (i.indkey)
                          where t.relname = c.table_name and i.indisunique and a.attname = 'idempotency_key')`,
      ),
    ).toEqual([]);
    expect(await rows("select id from storage.buckets where public")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("privilege escalation", () => {
  const callable = () =>
    rows<{ name: string; nargs: number; sig: string }>(
      `select p.proname name, p.pronargs nargs, p.oid::regprocedure::text sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
          and p.prokind = 'f' order by 1`,
    );

  it("a signed-in user with no role changes nothing through ANY public function", async () => {
    const before = await snapshot();
    const fns = await callable();
    expect(fns.length).toBeGreaterThan(150);
    const succeeded: string[] = [];
    for (const f of fns) {
      const args = Array.from({ length: f.nargs }, (_, i) => `$${i + 1}`).join(", ");
      const params = Array.from({ length: f.nargs }, () => null);
      const ok = await asUserCommit(db, actor("outsider"), async (tx) => {
        await tx.query(`select public.${f.name}(${args})`, params);
        return true;
      }).catch(() => false);
      if (ok) succeeded.push(f.name);
    }
    // Anything that "succeeded" must be a read or a no-op on the caller's own data.
    expect(await snapshot()).toEqual(before);
    for (const name of succeeded)
      expect(
        [
          "get_my_access",
          "list_my_invitations",
          "mark_notifications_read",
          "intake_summary",
          "trial_balance",
          "general_ledger",
          "ar_reconciliation",
          "ar_aging",
          "sales_invoice_balances",
          "purchase_bill_balances",
          "ap_aging",
          "ap_reconciliation",
          "withholding_summary",
          "inventory_valuation",
          "inventory_stock_by_location",
          "inventory_reconciliation",
          "inventory_quantity_check",
          "report_period_status",
          "payroll_reconciliation",
          "payroll_month_summary",
          "workpaper_schedule",
          "tax_regression",
          "form_regression",
          "tax_rule_fixture_results",
          "tax_form_fixture_results",
          "output_fixture_results",
          "report_closed_through",
        ],
        `${name} succeeded for a user with no role`,
      ).toContain(name);
  }, 120_000);

  it("client users cannot reach staff or admin powers, for their own client or another", async () => {
    const before = await snapshot();
    const attempts: [string, unknown[]][] = [
      ["select public.set_firm_role($1, 'firm_admin')", [IDS.ownerA]],
      ["select public.assign_staff($1, $2, 'reviewer')", [A, IDS.ownerA]],
      ["select public.create_invitation('x@example.test', 'firm', 'firm_manager', null, null)", []],
      ["select public.set_client_member_role($1, $2, 'client_owner')", [B, IDS.ownerA]],
      ["select public.set_user_active($1, false, 'x')", [IDS.manager]],
      ["select public.apply_coa_template($1, 'PH-SME-V0')", [B]],
      ["select public.set_period_status(id, 'locked') from public.accounting_periods limit 1", []],
      ['select public.create_work_item($1, \'{"title":"x x x"}\'::jsonb, $2)', [A, newKey()]],
      ["select public.run_reminders(current_date)", []],
      ["select * from public.ops_activity_report($1, current_date - 1, current_date)", [A]],
    ];
    for (const who of ["ownerA", "staffA", "viewerA"] as const)
      for (const [sql, params] of attempts)
        expect(await h.errorOf(who, sql, params), `${who}: ${sql}`).toBeDefined();
    expect(await snapshot()).toEqual(before);
  });

  it("activity reports: no role, client users and other clients' staff are refused (regression)", async () => {
    const R = "select * from public.ops_activity_report($1, current_date - 1, current_date)";
    for (const who of ["outsider", "ownerA", "staffA", "viewerA", "ownerB"] as const)
      for (const c of [A, B]) expect(await h.errorOf(who, R, [c]), `${who} ${c}`).toBe("42501");
    expect(await h.errorOf("accountantB", R, [A])).toBe("42501"); // staff, but not a reviewer
    expect(await h.errorOf("reviewerA", R, [B])).toBe("42501"); // another client
    expect(await h.errorOf("reviewerA", R, [A])).toBeUndefined();
  });

  it("staff without MFA (when required) and disabled accounts lose firm powers", async () => {
    const noMfa = await asUser(db, actor("manager", "aal1"), async (tx) => ({
      role: (await tx.query<{ r: string | null }>("select private.firm_role()::text r")).rows[0].r,
      clients: (await tx.query("select id from public.clients")).rows.length,
    }));
    expect(noMfa).toEqual({ role: null, clients: 0 });
    await db.query(
      "update public.profiles set is_active = false, disabled_at = now() where id = $1",
      [IDS.reviewerA],
    );
    const disabled = await asUser(db, actor("reviewerA"), async (tx) => ({
      clients: (await tx.query("select id from public.clients")).rows.length,
      post: await pgErrorCode(
        tx.query('select public.create_work_item($1, \'{"title":"xyz"}\'::jsonb, $2)', [
          A,
          newKey(),
        ]),
      ),
    }));
    expect(disabled.clients).toBe(0);
    expect(disabled.post).toBeDefined();
    await db.query(
      "update public.profiles set is_active = true, disabled_at = null where id = $1",
      [IDS.reviewerA],
    );
  });
});

// ---------------------------------------------------------------------------
describe("guard bypass", () => {
  it("an end user cannot switch on the maintenance purge mode to skip guards", async () => {
    const inactive = (
      await rows<{ id: string }>(
        "select id from public.accounts where client_id = $1 and code = '6990'",
        [A],
      )
    )[0]?.id;
    const target =
      inactive ??
      (
        await rows<{ id: string }>(
          "select id from public.accounts where client_id = $1 and is_postable order by code desc limit 1",
          [A],
        )
      )[0].id;
    await h.run("reviewerA", "select public.update_account($1, null, false)", [target]);
    const cash = (
      await rows<{ id: string }>(
        "select id from public.accounts where client_id = $1 and code = '1020'",
        [A],
      )
    )[0].id;
    const lines = JSON.stringify([
      { account_id: target, debit: "10.00", credit: "" },
      { account_id: cash, debit: "", credit: "10.00" },
    ]);
    const attempt = await asUser(db, actor("accountantB"), async (tx) => {
      await tx.query("select set_config('app.purge', 'on', true)");
      return pgErrorCode(
        tx.query(
          "select public.save_draft_entry($1, null, '2026-01-15'::date, 'general', 'bypass', null, null, $2, $3::jsonb)",
          [A, newKey(), lines],
        ),
      );
    });
    expect(attempt).toBe("22023"); // the guard still runs: inactive account refused
    // and audit history cannot be rewritten by anyone, even with the switch
    const audit = await asUser(db, actor("manager"), async (tx) => {
      await tx.query("select set_config('app.purge', 'on', true)");
      return pgErrorCode(tx.query("delete from audit.events"));
    });
    expect(audit).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("input validation and injection", () => {
  const PAYLOADS = [
    "'); drop table public.clients; --",
    "Robert'); DELETE FROM public.journal_entries; --",
    "<script>alert(1)</script>",
    "${7*7} {{7*7}} %s %n",
    "‮gnp.exe",
  ];

  it("SQL-looking and script text is stored literally and changes nothing else", async () => {
    const before = await snapshot();
    for (const p of PAYLOADS) {
      const [r] = await h.run<{ id: string }>(
        "accountantB",
        "select public.save_counterparty($1, null, null, $2::jsonb, $3) as id",
        [A, JSON.stringify({ kind: "customer", registered_name: p.slice(0, 100) }), newKey()],
      );
      const stored = (
        await rows<{ n: string }>(
          "select registered_name n from public.counterparties where id = $1",
          [r.id],
        )
      )[0].n;
      expect(stored).toBe(p.slice(0, 100).trim());
    }
    const after = await snapshot();
    expect(after.counterparties).toBe(before.counterparties + PAYLOADS.length);
    // only the new records and their intake history changed
    expect({ ...after, counterparties: 0, intake_events: 0 }).toEqual({
      ...before,
      counterparties: 0,
      intake_events: 0,
    });
  });

  it("enum and type arguments reject anything outside their domain", async () => {
    expect(
      await h.errorOf(
        "accountantB",
        "select public.submit_sales_document($1::public.intake_subject, $2)",
        ["sales_invoice; drop table x", IDS.clientA],
      ),
    ).toBe("22P02");
    expect(
      await h.errorOf(
        "accountantB",
        "select public.transition_work_item($1, 'done; select 1', null, null)",
        ["not-a-uuid"],
      ),
    ).toBe("22P02");
  });

  it("the tax formula language accepts only its own operators", async () => {
    const rule = (formula: unknown) =>
      JSON.stringify({
        code: "TEST_INJ",
        name: "Injection probe",
        tax_type: "other",
        effective_from: "2026-01-01",
        inputs: [{ name: "sales", source: "ledger" }],
        params: { rate: "0.10" },
        formula,
        sources: [{ citation: "TEST ONLY", issued_on: "2026-01-01" }],
      });
    const P = "select public.propose_tax_rule($1::jsonb)";
    const bad = [
      { steps: [{ name: "tax", expr: { op: "exec", args: ["select 1"] } }], outputs: ["tax"] },
      { steps: [{ name: "tax", expr: { input: "sales; drop table x" } }], outputs: ["tax"] },
      { steps: [{ name: "tax", expr: { param: "missing" } }], outputs: ["tax"] },
      { steps: [{ name: "tax", expr: "1e400" }], outputs: ["tax"] },
      { steps: [{ name: "x; drop", expr: "1" }], outputs: ["x; drop"] },
    ];
    for (const f of bad)
      expect(await h.errorOf("reviewerA", P, [rule(f)]), JSON.stringify(f)).toBeDefined();
    // a very deep expression is refused or evaluated safely; it never runs away
    let deep: unknown = { input: "sales" };
    for (let i = 0; i < 300; i++) deep = { op: "add", args: [deep, "1"] };
    const code = await h.errorOf("reviewerA", P, [
      rule({ steps: [{ name: "tax", expr: deep }], outputs: ["tax"] }),
    ]);
    expect(code === undefined || /^(22|54)/.test(code)).toBe(true);
  });
});
