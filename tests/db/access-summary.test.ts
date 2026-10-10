import { beforeAll, describe, expect, it } from "vitest";

import { actor, asUser, createTestDb, IDS, seedFixture, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
}, 60_000);

async function access(key: Parameters<typeof actor>[0], aal: "aal1" | "aal2" = "aal2") {
  return asUser(db, actor(key, aal), async (tx) => {
    const { rows } = await tx.query<{ a: Record<string, unknown> }>(
      "select public.get_my_access() as a",
    );
    return rows[0].a;
  });
}

describe("get_my_access staff_client_ids", () => {
  it("lists only assigned clients for assigned staff", async () => {
    expect((await access("reviewerA")).staff_client_ids).toEqual([IDS.clientA]);
    expect((await access("accountantB")).staff_client_ids).toEqual([IDS.clientB]);
  });

  it("lists all clients for managers, none for firm admins and client users", async () => {
    expect(((await access("manager")).staff_client_ids as string[]).sort()).toEqual(
      [IDS.clientA, IDS.clientB].sort(),
    );
    expect((await access("firmAdmin")).staff_client_ids).toEqual([]);
    expect((await access("ownerA")).staff_client_ids).toEqual([]);
  });

  it("is empty for staff without MFA (aal1)", async () => {
    const a = await access("reviewerA", "aal1");
    expect(a.staff_client_ids).toEqual([]);
    expect(a.mfa_required).toBe(true);
  });
});
