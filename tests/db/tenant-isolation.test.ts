/**
 * Cross-tenant isolation: Client A users must not read, insert, update or
 * delete Client B records (and vice versa), regardless of role, and even
 * with hand-crafted SQL issued as the API's `authenticated` role.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { actor, asUser, createTestDb, IDS, pgErrorCode, seedFixture, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
}, 60_000);

/** Users who belong to (or are assigned to) Client A only. */
const CLIENT_A_SIDE = ["ownerA", "staffA", "viewerA", "reviewerA"] as const;

async function superCount(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql);
  return Number(rows[0].n);
}

describe("reads", () => {
  it.each(CLIENT_A_SIDE)("%s sees Client A contacts but never Client B", async (key) => {
    const rows = await asUser(db, actor(key), async (tx) => {
      const r = await tx.query<{ client_id: string }>(
        "select client_id from public.client_contacts",
      );
      return r.rows.map((x) => x.client_id);
    });
    expect(rows).toEqual([IDS.clientA]);
  });

  it.each(CLIENT_A_SIDE)(
    "%s gets zero rows when filtering explicitly for Client B",
    async (key) => {
      const n = await asUser(db, actor(key), async (tx) => {
        const r = await tx.query("select * from public.client_contacts where client_id = $1", [
          IDS.clientB,
        ]);
        return r.rows.length;
      });
      expect(n).toBe(0);
    },
  );

  it("Client B owner cannot see Client A's client record, members or contacts", async () => {
    const result = await asUser(db, actor("ownerB"), async (tx) => ({
      clients: (await tx.query<{ id: string }>("select id from public.clients")).rows.map(
        (r) => r.id,
      ),
      membersOfA: (
        await tx.query("select * from public.client_memberships where client_id = $1", [
          IDS.clientA,
        ])
      ).rows.length,
      contactsOfA: (
        await tx.query("select * from public.client_contacts where client_id = $1", [IDS.clientA])
      ).rows.length,
      assignmentsOfA: (
        await tx.query("select * from public.client_assignments where client_id = $1", [
          IDS.clientA,
        ])
      ).rows.length,
    }));
    expect(result).toEqual({
      clients: [IDS.clientB],
      membersOfA: 0,
      contactsOfA: 0,
      assignmentsOfA: 0,
    });
  });

  it("a user with no membership sees no clients, contacts or other profiles", async () => {
    const result = await asUser(db, actor("outsider"), async (tx) => ({
      clients: (await tx.query("select * from public.clients")).rows.length,
      contacts: (await tx.query("select * from public.client_contacts")).rows.length,
      profiles: (await tx.query<{ id: string }>("select id from public.profiles")).rows.map(
        (r) => r.id,
      ),
    }));
    expect(result).toEqual({ clients: 0, contacts: 0, profiles: [IDS.outsider] });
  });

  it("staff assigned to Client B cannot read Client A", async () => {
    const ids = await asUser(db, actor("accountantB"), async (tx) =>
      (
        await tx.query<{ client_id: string }>("select client_id from public.client_contacts")
      ).rows.map((r) => r.client_id),
    );
    expect(ids).toEqual([IDS.clientB]);
  });

  it("firm_admin sees the client roster but NO client business records (SoD-5)", async () => {
    const result = await asUser(db, actor("firmAdmin"), async (tx) => ({
      clients: (await tx.query("select * from public.clients")).rows.length,
      contacts: (await tx.query("select * from public.client_contacts")).rows.length,
    }));
    expect(result).toEqual({ clients: 2, contacts: 0 });
  });

  it("firm_manager sees all clients' records", async () => {
    const n = await asUser(
      db,
      actor("manager"),
      async (tx) => (await tx.query("select * from public.client_contacts")).rows.length,
    );
    expect(n).toBe(2);
  });

  it("authenticated users cannot read the audit trail at all", async () => {
    const code = await asUser(db, actor("manager"), (tx) =>
      pgErrorCode(tx.query("select * from audit.events")),
    );
    expect(code).toBe("42501");
  });
});

describe("inserts", () => {
  it.each(CLIENT_A_SIDE)("%s cannot insert a record into Client B", async (key) => {
    const code = await asUser(db, actor(key), (tx) =>
      pgErrorCode(
        tx.query("insert into public.client_contacts (client_id, full_name) values ($1, 'x')", [
          IDS.clientB,
        ]),
      ),
    );
    expect(code).toBe("42501");
  });

  it("client owner/staff can insert into their own client", async () => {
    for (const key of ["ownerA", "staffA"] as const) {
      const id = await asUser(db, actor(key), async (tx) => {
        const r = await tx.query<{ id: string }>(
          "insert into public.client_contacts (client_id, full_name) values ($1, 'New') returning id",
          [IDS.clientA],
        );
        return r.rows[0].id;
      });
      expect(id).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it("client viewer cannot insert even into their own client", async () => {
    const code = await asUser(db, actor("viewerA"), (tx) =>
      pgErrorCode(
        tx.query("insert into public.client_contacts (client_id, full_name) values ($1, 'x')", [
          IDS.clientA,
        ]),
      ),
    );
    expect(code).toBe("42501");
  });

  it("cannot spoof created_by", async () => {
    const code = await asUser(db, actor("ownerA"), (tx) =>
      pgErrorCode(
        tx.query(
          "insert into public.client_contacts (client_id, full_name, created_by) values ($1, 'x', $2)",
          [IDS.clientA, IDS.ownerB],
        ),
      ),
    );
    expect(code).toBe("42501");
  });

  it.each([
    "clients",
    "client_memberships",
    "client_assignments",
    "firm_memberships",
    "invitations",
  ])("cannot insert directly into %s (writes only via checked functions)", async (table) => {
    const sql: Record<string, [string, unknown[]]> = {
      clients: ["insert into public.clients (code, display_name) values ('HACK-1', 'x')", []],
      client_memberships: [
        "insert into public.client_memberships (client_id, user_id, role) values ($1, $2, 'client_owner')",
        [IDS.clientB, IDS.ownerA],
      ],
      client_assignments: [
        "insert into public.client_assignments (client_id, user_id, assignment_role) values ($1, $2, 'preparer')",
        [IDS.clientB, IDS.reviewerA],
      ],
      firm_memberships: [
        "insert into public.firm_memberships (user_id, role) values ($1, 'firm_admin')",
        [IDS.ownerA],
      ],
      invitations: [
        "insert into public.invitations (email, kind, client_id, client_role, expires_at) values ('x@example.test', 'client', $1, 'client_owner', now() + interval '1 day')",
        [IDS.clientB],
      ],
    };
    const [text, params] = sql[table];
    const code = await asUser(db, actor("ownerA"), (tx) => pgErrorCode(tx.query(text, params)));
    expect(code).toBe("42501");
  });
});

describe("updates", () => {
  it.each(CLIENT_A_SIDE)("%s cannot update a Client B record (0 rows, unchanged)", async (key) => {
    const affected = await asUser(db, actor(key), async (tx) => {
      const r = await tx.query(
        "update public.client_contacts set full_name = 'HACKED' where id = $1",
        [IDS.contactB],
      );
      return r.affectedRows;
    });
    expect(affected).toBe(0);
    expect(
      await superCount(
        `select count(*) as n from public.client_contacts where id = '${IDS.contactB}' and full_name = 'Contact of B'`,
      ),
    ).toBe(1);
  });

  it("cannot move an own record into another client (client_id not updatable)", async () => {
    const code = await asUser(db, actor("ownerA"), (tx) =>
      pgErrorCode(
        tx.query("update public.client_contacts set client_id = $1 where id = $2", [
          IDS.clientB,
          IDS.contactA,
        ]),
      ),
    );
    expect(code).toBe("42501");
  });

  it("cannot change own membership role or another client's membership directly", async () => {
    const own = await asUser(db, actor("staffA"), (tx) =>
      pgErrorCode(
        tx.query("update public.client_memberships set role = 'client_owner' where user_id = $1", [
          IDS.staffA,
        ]),
      ),
    );
    expect(own).toBe("42501");
  });

  it("can edit own profile name but not activation fields", async () => {
    const ok = await asUser(
      db,
      actor("ownerA"),
      async (tx) =>
        (
          await tx.query("update public.profiles set full_name = 'Owner A' where id = $1", [
            IDS.ownerA,
          ])
        ).affectedRows,
    );
    expect(ok).toBe(1);
    const code = await asUser(db, actor("viewerA"), (tx) =>
      pgErrorCode(
        tx.query("update public.profiles set is_active = true where id = $1", [IDS.viewerA]),
      ),
    );
    expect(code).toBe("42501");
    const other = await asUser(
      db,
      actor("ownerA"),
      async (tx) =>
        (await tx.query("update public.profiles set full_name = 'x' where id = $1", [IDS.ownerB]))
          .affectedRows,
    );
    expect(other).toBe(0);
  });
});

describe("deletes", () => {
  it.each(["ownerA", "staffA", "viewerA", "reviewerA", "accountantB"] as const)(
    "%s cannot delete the other tenant's record",
    async (key) => {
      const target = key === "accountantB" ? IDS.contactA : IDS.contactB;
      const affected = await asUser(
        db,
        actor(key),
        async (tx) =>
          (await tx.query("delete from public.client_contacts where id = $1", [target]))
            .affectedRows,
      );
      expect(affected).toBe(0);
      expect(
        await superCount(`select count(*) as n from public.client_contacts where id = '${target}'`),
      ).toBe(1);
    },
  );

  it("client_staff cannot delete even own-client records; client_owner can", async () => {
    const staff = await asUser(
      db,
      actor("staffA"),
      async (tx) =>
        (await tx.query("delete from public.client_contacts where id = $1", [IDS.contactA]))
          .affectedRows,
    );
    expect(staff).toBe(0);
    const owner = await asUser(
      db,
      actor("ownerA"),
      async (tx) =>
        (await tx.query("delete from public.client_contacts where id = $1", [IDS.contactA]))
          .affectedRows,
    );
    expect(owner).toBe(1);
  });

  it.each(["clients", "client_memberships", "firm_memberships"])(
    "cannot delete directly from %s",
    async (table) => {
      const code = await asUser(db, actor("ownerA"), (tx) =>
        pgErrorCode(tx.query(`delete from public.${table}`)),
      );
      expect(code).toBe("42501");
    },
  );
});

describe("session and account state", () => {
  it("staff without MFA (aal1) have no firm access", async () => {
    const n = await asUser(
      db,
      actor("reviewerA", "aal1"),
      async (tx) => (await tx.query("select * from public.client_contacts")).rows.length,
    );
    expect(n).toBe(0);
  });

  it("a disabled account loses all tenant access immediately", async () => {
    await db.exec("begin");
    try {
      await db.query(
        "update public.profiles set is_active = false, disabled_at = now() where id = $1",
        [IDS.ownerA],
      );
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: IDS.ownerA, role: "authenticated", aal: "aal2" }),
      ]);
      await db.exec("set local role authenticated");
      const contacts = (await db.query("select * from public.client_contacts")).rows.length;
      const clients = (await db.query("select * from public.clients")).rows.length;
      expect({ contacts, clients }).toEqual({ contacts: 0, clients: 0 });
    } finally {
      await db.exec("rollback");
    }
  });

  it("an expired membership grants nothing", async () => {
    await db.exec("begin");
    try {
      await db.query(
        "update public.client_memberships set expires_at = now() - interval '1 minute' where user_id = $1",
        [IDS.viewerA],
      );
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: IDS.viewerA, role: "authenticated" }),
      ]);
      await db.exec("set local role authenticated");
      expect((await db.query("select * from public.client_contacts")).rows.length).toBe(0);
    } finally {
      await db.exec("rollback");
    }
  });

  it("members of an archived client lose access", async () => {
    await db.exec("begin");
    try {
      await db.query("update public.clients set status = 'archived' where id = $1", [IDS.clientA]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: IDS.ownerA, role: "authenticated" }),
      ]);
      await db.exec("set local role authenticated");
      expect((await db.query("select * from public.client_contacts")).rows.length).toBe(0);
    } finally {
      await db.exec("rollback");
    }
  });
});
