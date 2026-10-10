import { beforeAll, describe, expect, it } from "vitest";

import { asAnon, createTestDb, pgErrorCode, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("schema guards", () => {
  it("enables AND forces RLS on every table in public", async () => {
    const { rows } = await db.query<{ relname: string; rls: boolean; forced: boolean }>(`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect({ table: row.relname, rls: row.rls, forced: row.forced }).toEqual({
        table: row.relname,
        rls: true,
        forced: true,
      });
    }
  });

  it("gives the anon role no privileges on any public table", async () => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'`);
    expect(rows).toEqual([]);
  });

  it("does not let anon execute any function in public", async () => {
    const { rows } = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(rows).toEqual([]);
  });

  it("does not let authenticated users execute internal/bootstrap functions", async () => {
    const { rows } = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('private', 'audit')
        and p.proname in ('bootstrap_firm_admin', 'require_active_user', 'member_admin_level',
                          'log_event', 'log_change', 'handle_new_auth_user')
        and has_function_privilege('authenticated', p.oid, 'execute')`);
    expect(rows).toEqual([]);
  });

  it("denies anon reading tenant data even directly", async () => {
    const code = await asAnon(db, (tx) => pgErrorCode(tx.query("select * from public.clients")));
    expect(code).toBe("42501");
  });

  it("makes SECURITY DEFINER functions pin an empty search_path", async () => {
    const { rows } = await db.query<{ fn: string }>(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname in ('public', 'private', 'audit')
        and not coalesce(p.proconfig @> array['search_path=""'], false)`);
    expect(rows).toEqual([]);
  });
});
