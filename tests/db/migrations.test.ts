/**
 * Migration order checks: every migration applies in order on a fresh
 * database, with and without the optional payroll module (0030-0032), and
 * records itself in the migration history.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestDb } from "./harness";

const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) =>
  f.endsWith(".sql"),
);
const latest = files
  .map((f) => f.slice(0, 4))
  .sort()
  .at(-1);

describe("migrations", () => {
  it("are numbered 0001, 0002, ... without gaps or duplicates", () => {
    const numbers = files.map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("apply in order and record the latest version", async () => {
    const db = await createTestDb();
    const v = await db.query<{ v: string }>(
      "select max(version) v from supabase_migrations.schema_migrations",
    );
    expect(v.rows[0].v).toBe(latest);
  }, 120_000);

  it("apply without the optional payroll module", async () => {
    const db = await createTestDb({ skip: /^003[012]_/ });
    const v = await db.query<{ v: string }>(
      "select max(version) v from supabase_migrations.schema_migrations",
    );
    expect(v.rows[0].v).toBe(latest);
    expect((await db.query("select to_regclass('public.payroll_runs') r")).rows[0]).toEqual({
      r: null,
    });
  }, 120_000);
});
