/**
 * Offline database test harness (PGlite = PostgreSQL compiled to WASM).
 *
 * Emulates the parts of Supabase the migrations rely on:
 *   - API roles: anon, authenticated, service_role (BYPASSRLS)
 *   - auth.users, auth.uid(), auth.jwt() reading `request.jwt.claims`
 *   - Supabase's broad DEFAULT privileges on new public objects, so tests
 *     prove the migrations' explicit REVOKEs actually take effect.
 * Then applies every file in supabase/migrations in order.
 *
 * Synthetic data only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const SUPABASE_STUB = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

-- Supabase Storage (only what the migrations use). As on Supabase, API roles
-- have table privileges on storage.objects and RLS decides.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

-- Supabase CLI migration history (files end by recording themselves here).
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase-style default privileges (deliberately broad).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export type Db = PGlite;

export async function createTestDb(): Promise<Db> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  // MFA is off in the beta (migration 0034). The tests keep it ON so
  // the enforcement path stays verified for when it is switched back on.
  await db.exec(
    "update private.settings set value = 'true'::jsonb where key = 'require_staff_mfa'",
  );
  return db;
}

export interface Actor {
  id: string;
  email: string;
  /** Authenticator assurance level carried in the JWT. */
  aal?: "aal1" | "aal2";
}

/**
 * Runs `fn` as an authenticated API user inside a transaction that is ALWAYS
 * rolled back, so tests never leak state into each other.
 */
export async function asUser<T>(db: Db, actor: Actor, fn: (db: Db) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({
    sub: actor.id,
    email: actor.email,
    role: "authenticated",
    aal: actor.aal ?? "aal1",
  });
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await db.exec("set local role authenticated");
    return await fn(db);
  } finally {
    await db.exec("rollback");
  }
}

/**
 * Like asUser, but COMMITS on success (rolls back on error) so multi-step
 * scenarios can build on earlier steps. Deferred constraints are checked at
 * this commit, exactly as in production.
 */
export async function asUserCommit<T>(
  db: Db,
  actor: Actor,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const claims = JSON.stringify({
    sub: actor.id,
    email: actor.email,
    role: "authenticated",
    aal: actor.aal ?? "aal1",
  });
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await db.exec("set local role authenticated");
    const result = await fn(db);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

/** Runs `fn` as the anon API role (no JWT), rolled back. */
export async function asAnon<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec("set local role anon");
    return await fn(db);
  } finally {
    await db.exec("rollback");
  }
}

/** Postgres error code of a rejected promise (e.g. '42501'). */
export async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixture: one firm, two client businesses (A and B).
// ---------------------------------------------------------------------------
export const IDS = {
  firmAdmin: "00000000-0000-4000-8000-000000000001",
  manager: "00000000-0000-4000-8000-000000000002",
  reviewerA: "00000000-0000-4000-8000-000000000003",
  accountantB: "00000000-0000-4000-8000-000000000004",
  ownerA: "00000000-0000-4000-8000-000000000011",
  staffA: "00000000-0000-4000-8000-000000000012",
  viewerA: "00000000-0000-4000-8000-000000000013",
  ownerB: "00000000-0000-4000-8000-000000000021",
  outsider: "00000000-0000-4000-8000-000000000031",
  clientA: "10000000-0000-4000-8000-00000000000a",
  clientB: "10000000-0000-4000-8000-00000000000b",
  contactA: "20000000-0000-4000-8000-00000000000a",
  contactB: "20000000-0000-4000-8000-00000000000b",
} as const;

export type UserKey = Exclude<keyof typeof IDS, "clientA" | "clientB" | "contactA" | "contactB">;

export function actor(key: UserKey, aal: "aal1" | "aal2" = "aal2"): Actor {
  return { id: IDS[key], email: `${key.toLowerCase()}@example.test`, aal };
}

export async function seedFixture(db: Db): Promise<void> {
  const users: UserKey[] = [
    "firmAdmin",
    "manager",
    "reviewerA",
    "accountantB",
    "ownerA",
    "staffA",
    "viewerA",
    "ownerB",
    "outsider",
  ];
  for (const key of users) {
    await db.query(
      "insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())",
      [IDS[key], `${key.toLowerCase()}@example.test`],
    );
  }
  await db.exec(`
    insert into public.firm_memberships (user_id, role) values
      ('${IDS.firmAdmin}', 'firm_admin'),
      ('${IDS.manager}', 'firm_manager'),
      ('${IDS.reviewerA}', 'reviewer'),
      ('${IDS.accountantB}', 'accountant');
    insert into public.clients (id, code, display_name, status) values
      ('${IDS.clientA}', 'CLIENT-A', 'Synthetic Client A Corp.', 'active'),
      ('${IDS.clientB}', 'CLIENT-B', 'Synthetic Client B Trading', 'active');
    insert into public.client_assignments (client_id, user_id, assignment_role) values
      ('${IDS.clientA}', '${IDS.reviewerA}', 'reviewer'),
      ('${IDS.clientB}', '${IDS.accountantB}', 'preparer');
    insert into public.client_memberships (client_id, user_id, role) values
      ('${IDS.clientA}', '${IDS.ownerA}', 'client_owner'),
      ('${IDS.clientA}', '${IDS.staffA}', 'client_staff'),
      ('${IDS.clientA}', '${IDS.viewerA}', 'client_viewer'),
      ('${IDS.clientB}', '${IDS.ownerB}', 'client_owner');
    insert into public.client_contacts (id, client_id, full_name, email) values
      ('${IDS.contactA}', '${IDS.clientA}', 'Contact of A', 'a.contact@example.test'),
      ('${IDS.contactB}', '${IDS.clientB}', 'Contact of B', 'b.contact@example.test');
  `);
}
