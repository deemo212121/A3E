/**
 * The production readiness check (supabase/checks/production-readiness.sql)
 * runs on a fully migrated database and catches what it is meant to catch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, seedFixture, type Db } from "./harness";

const SQL = readFileSync(
  join(process.cwd(), "supabase", "checks", "production-readiness.sql"),
  "utf8",
);
let db: Db;
const run = async () =>
  Object.fromEntries(
    (await db.query<{ status: string; check_name: string }>(SQL)).rows.map((r) => [
      r.check_name,
      r.status,
    ]),
  );

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

describe("production readiness check", () => {
  it("passes on a clean, migrated database once the purge switch is off", async () => {
    const before = await run();
    expect(before["Synthetic-data purge disabled"]).toBe("FAIL"); // migrations default it on
    await db.exec(
      "update private.settings set value = 'false'::jsonb where key = 'allow_synthetic_purge'",
    );
    const after = await run();
    const notPass = Object.entries(after).filter(([, s]) => s !== "PASS");
    // a clean database has no firm admin yet: the only item left to review
    expect(notPass).toEqual([["Firm admins (expect 1-2 named people)", "REVIEW"]]);
  });

  it("fails when test data or relaxed settings are present", async () => {
    await seedFixture(db); // synthetic clients and example.test users
    await db.exec(
      "update private.settings set value = 'false'::jsonb where key = 'require_staff_mfa'",
    );
    const r = await run();
    expect(r["No test or demo user accounts"]).toBe("FAIL");
    expect(r["No synthetic or demo clients"]).toBe("FAIL");
    expect(r["Staff MFA required"]).toBe("FAIL");
  });
});
