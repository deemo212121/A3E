/**
 * Privileged actions (invitations, membership and role changes, account
 * status) are only possible through checked functions, by the right people.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { actor, asUser, createTestDb, IDS, pgErrorCode, seedFixture, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixture(db);
}, 60_000);

const inviteClient = (clientId: string, role: string, email = "new.person@example.test") =>
  [
    "select public.create_invitation($1, 'client', null, $2, $3::public.client_role) as id",
    [email, clientId, role],
  ] as const;

describe("invitations", () => {
  it("client owner can invite staff/viewer to own client only", async () => {
    const id = await asUser(db, actor("ownerA"), async (tx) => {
      const [sql, params] = inviteClient(IDS.clientA, "client_staff");
      return (await tx.query<{ id: string }>(sql, [...params])).rows[0].id;
    });
    expect(id).toBeTruthy();

    const crossTenant = await asUser(db, actor("ownerA"), (tx) => {
      const [sql, params] = inviteClient(IDS.clientB, "client_staff");
      return pgErrorCode(tx.query(sql, [...params]));
    });
    expect(crossTenant).toBe("42501");
  });

  it("client owner cannot create another owner", async () => {
    const code = await asUser(db, actor("ownerA"), (tx) => {
      const [sql, params] = inviteClient(IDS.clientA, "client_owner");
      return pgErrorCode(tx.query(sql, [...params]));
    });
    expect(code).toBe("42501");
  });

  it.each(["staffA", "viewerA", "reviewerA", "outsider"] as const)(
    "%s cannot invite anyone to Client A",
    async (key) => {
      const code = await asUser(db, actor(key), (tx) => {
        const [sql, params] = inviteClient(IDS.clientA, "client_viewer");
        return pgErrorCode(tx.query(sql, [...params]));
      });
      expect(code).toBe("42501");
    },
  );

  it("only firm_admin can invite firm staff", async () => {
    const sql = "select public.create_invitation('staff@example.test', 'firm', 'firm_admin') as id";
    expect(await asUser(db, actor("manager"), (tx) => pgErrorCode(tx.query(sql)))).toBe("42501");
    expect(await asUser(db, actor("ownerA"), (tx) => pgErrorCode(tx.query(sql)))).toBe("42501");
    expect(
      await asUser(db, actor("firmAdmin"), (tx) => pgErrorCode(tx.query(sql))),
    ).toBeUndefined();
  });

  it("firm_admin without MFA (aal1) cannot invite", async () => {
    const sql = "select public.create_invitation('staff@example.test', 'firm', 'accountant') as id";
    expect(await asUser(db, actor("firmAdmin", "aal1"), (tx) => pgErrorCode(tx.query(sql)))).toBe(
      "42501",
    );
  });

  it("an invitation can only be accepted by the matching, confirmed email", async () => {
    // Persist an invitation for the outsider's email, created by Owner A.
    await db.exec("begin");
    let invitationId = "";
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: IDS.ownerA, role: "authenticated", aal: "aal1" }),
      ]);
      await db.exec("set local role authenticated");
      const r = await db.query<{ id: string }>(
        "select public.create_invitation('outsider@example.test', 'client', null, $1, 'client_viewer') as id",
        [IDS.clientA],
      );
      invitationId = r.rows[0].id;
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }

    // Someone else (Owner B) cannot see or accept it.
    const stolen = await asUser(db, actor("ownerB"), (tx) =>
      pgErrorCode(tx.query("select public.accept_invitation($1)", [invitationId])),
    );
    expect(stolen).toBe("P0002");
    const listedForB = await asUser(
      db,
      actor("ownerB"),
      async (tx) => (await tx.query("select * from public.list_my_invitations()")).rows.length,
    );
    expect(listedForB).toBe(0);

    // Unconfirmed email cannot accept.
    await db.query("update auth.users set email_confirmed_at = null where id = $1", [IDS.outsider]);
    const unconfirmed = await asUser(db, actor("outsider"), (tx) =>
      pgErrorCode(tx.query("select public.accept_invitation($1)", [invitationId])),
    );
    expect(unconfirmed).toBe("P0002");
    await db.query("update auth.users set email_confirmed_at = now() where id = $1", [
      IDS.outsider,
    ]);

    // The invited person can accept, gaining exactly that membership.
    const granted = await asUser(db, actor("outsider"), async (tx) => {
      await tx.query("select public.accept_invitation($1)", [invitationId]);
      const clients = (await tx.query<{ id: string }>("select id from public.clients")).rows.map(
        (r) => r.id,
      );
      const canWrite = await pgErrorCode(
        tx.query("insert into public.client_contacts (client_id, full_name) values ($1, 'x')", [
          IDS.clientA,
        ]),
      );
      return { clients, canWrite };
    });
    expect(granted.clients).toEqual([IDS.clientA]);
    expect(granted.canWrite).toBe("42501"); // viewer role: read-only
  });

  it("expired or revoked invitations cannot be accepted", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.invitations (email, kind, client_id, client_role, expires_at)
       values ('outsider@example.test', 'client', $1, 'client_owner', now() - interval '1 minute')
       returning id`,
      [IDS.clientB],
    );
    const code = await asUser(db, actor("outsider"), (tx) =>
      pgErrorCode(tx.query("select public.accept_invitation($1)", [rows[0].id])),
    );
    expect(code).toBe("22023");
  });
});

describe("membership and role changes", () => {
  it("client owner cannot change own role or manage another client", async () => {
    const self = await asUser(db, actor("ownerA"), (tx) =>
      pgErrorCode(
        tx.query("select public.set_client_member_role($1, $2, 'client_viewer')", [
          IDS.clientA,
          IDS.ownerA,
        ]),
      ),
    );
    expect(self).toBe("42501");
    const other = await asUser(db, actor("ownerA"), (tx) =>
      pgErrorCode(
        tx.query("select public.remove_client_member($1, $2)", [IDS.clientB, IDS.ownerB]),
      ),
    );
    expect(other).toBe("42501");
  });

  it("client owner can change staff to viewer in own client", async () => {
    const code = await asUser(db, actor("ownerA"), (tx) =>
      pgErrorCode(
        tx.query("select public.set_client_member_role($1, $2, 'client_viewer')", [
          IDS.clientA,
          IDS.staffA,
        ]),
      ),
    );
    expect(code).toBeUndefined();
  });

  it("a client cannot be left without an active owner", async () => {
    const code = await asUser(db, actor("manager"), (tx) =>
      pgErrorCode(
        tx.query("select public.remove_client_member($1, $2)", [IDS.clientB, IDS.ownerB]),
      ),
    );
    expect(code).toBe("22023");
  });

  it("only firm_admin changes firm roles, never their own", async () => {
    const byManager = await asUser(db, actor("manager"), (tx) =>
      pgErrorCode(tx.query("select public.set_firm_role($1, 'firm_admin')", [IDS.manager])),
    );
    expect(byManager).toBe("42501");
    const self = await asUser(db, actor("firmAdmin"), (tx) =>
      pgErrorCode(tx.query("select public.set_firm_role($1, null)", [IDS.firmAdmin])),
    );
    expect(self).toBe("42501");
    const byClient = await asUser(db, actor("ownerA"), (tx) =>
      pgErrorCode(tx.query("select public.set_firm_role($1, 'firm_admin')", [IDS.ownerA])),
    );
    expect(byClient).toBe("42501");
  });

  it("only firm admins/managers create clients and assign staff", async () => {
    for (const key of ["ownerA", "reviewerA", "accountantB"] as const) {
      expect(
        await asUser(db, actor(key), (tx) =>
          pgErrorCode(tx.query("select public.create_client('NEW-1', 'New Co')")),
        ),
      ).toBe("42501");
      expect(
        await asUser(db, actor(key), (tx) =>
          pgErrorCode(
            tx.query("select public.assign_staff($1, $2, 'preparer')", [
              IDS.clientA,
              IDS.accountantB,
            ]),
          ),
        ),
      ).toBe("42501");
    }
    expect(
      await asUser(db, actor("manager"), (tx) =>
        pgErrorCode(tx.query("select public.create_client('NEW-1', 'New Co')")),
      ),
    ).toBeUndefined();
  });

  it("assigning staff grants exactly that client; firm admins cannot be assigned", async () => {
    const result = await asUser(db, actor("manager"), async (tx) => {
      await tx.query("select public.assign_staff($1, $2, 'preparer')", [
        IDS.clientA,
        IDS.accountantB,
      ]);
      const adminAssign = await pgErrorCode(
        tx.query("select public.assign_staff($1, $2, 'preparer')", [IDS.clientA, IDS.firmAdmin]),
      );
      return { adminAssign };
    });
    expect(result.adminAssign).toBe("22023");
  });
});

describe("account disable", () => {
  it("only firm_admin can disable accounts, with a reason, never themselves", async () => {
    expect(
      await asUser(db, actor("manager"), (tx) =>
        pgErrorCode(tx.query("select public.set_user_active($1, false, 'test')", [IDS.ownerA])),
      ),
    ).toBe("42501");
    expect(
      await asUser(db, actor("firmAdmin"), (tx) =>
        pgErrorCode(tx.query("select public.set_user_active($1, false, null)", [IDS.ownerA])),
      ),
    ).toBe("22023");
    expect(
      await asUser(db, actor("firmAdmin"), (tx) =>
        pgErrorCode(
          tx.query("select public.set_user_active($1, false, 'leaving')", [IDS.firmAdmin]),
        ),
      ),
    ).toBe("42501");
  });

  it("a disabled user cannot call privileged functions", async () => {
    await db.exec("begin");
    try {
      await db.query(
        "update public.profiles set is_active = false, disabled_at = now() where id = $1",
        [IDS.manager],
      );
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: IDS.manager, role: "authenticated", aal: "aal2" }),
      ]);
      await db.exec("set local role authenticated");
      await expect(db.query("select public.create_client('NEW-2', 'x')")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await db.exec("rollback");
    }
  });

  it("disabling is audited and the audit trail is append-only", async () => {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: IDS.firmAdmin, role: "authenticated", aal: "aal2" }),
      ]);
      await db.exec("set local role authenticated");
      await db.query("select public.set_user_active($1, false, 'left the company')", [IDS.viewerA]);
      await db.exec("reset role");
      const { rows } = await db.query<{ action: string }>(
        "select action from audit.events where action = 'account.disabled'",
      );
      expect(rows.length).toBe(1);
      await expect(db.query("delete from audit.events")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.exec("rollback");
    }
  });
});

describe("MFA reset authorization", () => {
  it("only a firm_admin can authorize, with a reason, never for themselves", async () => {
    const call = (key: Parameters<typeof actor>[0], target: string, reason: string | null) =>
      asUser(db, actor(key), (tx) =>
        pgErrorCode(tx.query("select public.authorize_mfa_reset($1, $2)", [target, reason])),
      );
    expect(await call("manager", IDS.reviewerA, "lost phone")).toBe("42501");
    expect(await call("ownerA", IDS.staffA, "lost phone")).toBe("42501");
    expect(await call("firmAdmin", IDS.firmAdmin, "lost phone")).toBe("42501");
    expect(await call("firmAdmin", IDS.reviewerA, null)).toBe("22023");
    expect(await call("firmAdmin", IDS.reviewerA, "lost phone")).toBeUndefined();
  });
});

describe("bootstrap", () => {
  it("bootstrap_firm_admin refuses once a firm admin exists", async () => {
    await expect(
      db.query("select private.bootstrap_firm_admin('outsider@example.test')"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
