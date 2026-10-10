/**
 * LIVE cross-tenant tests against a NON-PRODUCTION Supabase project.
 *
 * Creates synthetic users and two synthetic client businesses, signs in as
 * real users through Supabase Auth, then issues DIRECT HTTP requests to the
 * Data API (PostgREST) exactly as an attacker could, bypassing the app UI.
 * Everything created is deleted afterwards.
 *
 * Requires (in .env.local): NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, and
 * APP_ENV != production. Skipped otherwise.
 */
import { randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totp } from "./totp";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const enabled = Boolean(URL_ && PUBLISHABLE && SECRET) && process.env.APP_ENV !== "production";

const run = randomBytes(4).toString("hex");
const email = (who: string) => `a3e-it-${run}-${who}@example.com`;
const password = `It-${randomBytes(12).toString("hex")}-Aa1`;

interface TestUser {
  key: string;
  id: string;
  token: string;
}

let admin: SupabaseClient;
const users: Record<string, TestUser> = {};
const ids = { clientA: "", clientB: "", contactA: "", contactB: "" };

async function createUser(key: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: email(key),
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
  return data.user.id;
}

async function signIn(key: string, withMfa = false): Promise<string> {
  const client = createClient(URL_, PUBLISHABLE, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: email(key), password });
  if (error || !data.session) throw new Error(`signIn ${key}: ${error?.message}`);
  if (!withMfa) return data.session.access_token;

  const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `it-${run}`,
  });
  if (enrollError || !enrolled) throw new Error(`enroll ${key}: ${enrollError?.message}`);
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: enrolled.id,
    code: totp(enrolled.totp.secret),
  });
  if (verifyError) throw new Error(`verify ${key}: ${verifyError.message}`);
  const { data: session } = await client.auth.getSession();
  return session.session!.access_token;
}

/** Raw Data API request as a given user (or anon when token is null). */
async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: PUBLISHABLE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function contactExistsUnchanged(id: string, fullName: string): Promise<boolean> {
  const { data } = await admin
    .from("client_contacts")
    .select("full_name")
    .eq("id", id)
    .maybeSingle();
  return data?.full_name === fullName;
}

describe.skipIf(!enabled)("LIVE: Client A cannot access Client B via direct API requests", () => {
  beforeAll(async () => {
    admin = createClient(URL_, SECRET, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    for (const key of ["ownerA", "staffA", "viewerA", "ownerB", "reviewerA", "outsider"]) {
      users[key] = { key, id: await createUser(key), token: "" };
    }

    const { data: clients, error: cErr } = await admin
      .from("clients")
      .insert([
        { code: `IT-${run}-A`.toUpperCase(), display_name: `IT ${run} Client A`, status: "active" },
        { code: `IT-${run}-B`.toUpperCase(), display_name: `IT ${run} Client B`, status: "active" },
      ])
      .select("id, code");
    if (cErr || !clients) throw new Error(`clients: ${cErr?.message}`);
    ids.clientA = clients.find((c) => c.code.endsWith("-A"))!.id;
    ids.clientB = clients.find((c) => c.code.endsWith("-B"))!.id;

    const must = (r: { error: { message: string } | null }, what: string) => {
      if (r.error) throw new Error(`${what}: ${r.error.message}`);
    };
    must(
      await admin
        .from("firm_memberships")
        .insert({ user_id: users.reviewerA.id, role: "reviewer" }),
      "firm role",
    );
    must(
      await admin.from("client_assignments").insert({
        client_id: ids.clientA,
        user_id: users.reviewerA.id,
        assignment_role: "reviewer",
      }),
      "assignment",
    );
    must(
      await admin.from("client_memberships").insert([
        { client_id: ids.clientA, user_id: users.ownerA.id, role: "client_owner" },
        { client_id: ids.clientA, user_id: users.staffA.id, role: "client_staff" },
        { client_id: ids.clientA, user_id: users.viewerA.id, role: "client_viewer" },
        { client_id: ids.clientB, user_id: users.ownerB.id, role: "client_owner" },
      ]),
      "memberships",
    );
    const { data: contacts, error: kErr } = await admin
      .from("client_contacts")
      .insert([
        { client_id: ids.clientA, full_name: "Synthetic Contact A" },
        { client_id: ids.clientB, full_name: "Synthetic Contact B" },
      ])
      .select("id, client_id");
    if (kErr || !contacts) throw new Error(`contacts: ${kErr?.message}`);
    ids.contactA = contacts.find((c) => c.client_id === ids.clientA)!.id;
    ids.contactB = contacts.find((c) => c.client_id === ids.clientB)!.id;

    for (const key of ["ownerA", "staffA", "viewerA", "ownerB", "outsider"]) {
      users[key].token = await signIn(key);
    }
    users.reviewerA.token = await signIn("reviewerA", true);
  });

  afterAll(async () => {
    if (!admin) return;
    if (ids.clientA || ids.clientB) {
      await admin.from("clients").delete().in("id", [ids.clientA, ids.clientB].filter(Boolean));
    }
    for (const user of Object.values(users)) {
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  // ------------------------------------------------------------------ reads
  it.each(["ownerA", "staffA", "viewerA", "reviewerA"])(
    "READ: %s listing contacts gets only Client A rows",
    async (key) => {
      const r = await api(users[key].token, "GET", "client_contacts?select=id,client_id");
      expect(r.status).toBe(200);
      const clientIds = new Set((r.json as { client_id: string }[]).map((x) => x.client_id));
      expect(clientIds.has(ids.clientB)).toBe(false);
      expect(clientIds.has(ids.clientA)).toBe(true);
    },
  );

  it.each(["ownerA", "staffA", "viewerA", "reviewerA"])(
    "READ: %s asking explicitly for Client B gets nothing",
    async (key) => {
      for (const path of [
        `client_contacts?client_id=eq.${ids.clientB}`,
        `clients?id=eq.${ids.clientB}`,
        `client_memberships?client_id=eq.${ids.clientB}`,
        `invitations?client_id=eq.${ids.clientB}`,
      ]) {
        const r = await api(users[key].token, "GET", path);
        expect({ path, status: r.status, rows: r.json }).toEqual({ path, status: 200, rows: [] });
      }
    },
  );

  it("READ: a user with no membership sees no clients or contacts", async () => {
    for (const path of ["clients", "client_contacts", "client_memberships"]) {
      const r = await api(users.outsider.token, "GET", path);
      expect({ path, rows: r.json }).toEqual({ path, rows: [] });
    }
  });

  it("READ: anonymous requests (publishable key only) are refused", async () => {
    for (const path of ["clients", "client_contacts", "profiles"]) {
      const r = await api(null, "GET", path);
      expect(
        r.status === 401 ||
          r.status === 403 ||
          (r.status === 200 && Array.isArray(r.json) && r.json.length === 0),
      ).toBe(true);
    }
  });

  it("READ: a forged/tampered JWT is rejected", async () => {
    const parts = users.ownerA.token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.sub = users.ownerB.id;
    const forged = [
      parts[0],
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      parts[2],
    ].join(".");
    const r = await api(forged, "GET", "client_contacts");
    expect(r.status).toBe(401);
  });

  it("READ: internal schemas (audit, private) are not reachable through the API", async () => {
    for (const schema of ["audit", "private"]) {
      const r = await api(users.reviewerA.token, "GET", "events", undefined, {
        "Accept-Profile": schema,
      });
      expect(r.status).not.toBe(200);
    }
  });

  // ---------------------------------------------------------------- inserts
  it.each(["ownerA", "staffA", "viewerA", "reviewerA"])(
    "INSERT: %s cannot create a record in Client B",
    async (key) => {
      const r = await api(users[key].token, "POST", "client_contacts", {
        client_id: ids.clientB,
        full_name: "INJECTED",
      });
      expect(r.status).toBe(403);
      const { count } = await admin
        .from("client_contacts")
        .select("id", { count: "exact", head: true })
        .eq("client_id", ids.clientB)
        .eq("full_name", "INJECTED");
      expect(count).toBe(0);
    },
  );

  it("INSERT: cannot grant oneself membership of Client B", async () => {
    const r = await api(users.ownerA.token, "POST", "client_memberships", {
      client_id: ids.clientB,
      user_id: users.ownerA.id,
      role: "client_owner",
    });
    expect([401, 403]).toContain(r.status);
  });

  // ---------------------------------------------------------------- updates
  it.each(["ownerA", "staffA", "viewerA", "reviewerA"])(
    "UPDATE: %s cannot modify a Client B record",
    async (key) => {
      const r = await api(users[key].token, "PATCH", `client_contacts?id=eq.${ids.contactB}`, {
        full_name: "HACKED",
      });
      expect(r.status).toBe(200);
      expect(r.json).toEqual([]); // zero rows matched under RLS
      expect(await contactExistsUnchanged(ids.contactB, "Synthetic Contact B")).toBe(true);
    },
  );

  it("UPDATE: cannot move an own record into Client B", async () => {
    const r = await api(users.ownerA.token, "PATCH", `client_contacts?id=eq.${ids.contactA}`, {
      client_id: ids.clientB,
    });
    expect([401, 403]).toContain(r.status);
  });

  // ---------------------------------------------------------------- deletes
  it.each(["ownerA", "staffA", "viewerA", "reviewerA"])(
    "DELETE: %s cannot delete a Client B record",
    async (key) => {
      const r = await api(users[key].token, "DELETE", `client_contacts?id=eq.${ids.contactB}`);
      expect(r.status).toBe(200);
      expect(r.json).toEqual([]);
      expect(await contactExistsUnchanged(ids.contactB, "Synthetic Contact B")).toBe(true);
    },
  );

  // ------------------------------------------------------- privileged RPCs
  it("RPC: Client A owner cannot invite people into Client B", async () => {
    const r = await api(users.ownerA.token, "POST", "rpc/create_invitation", {
      p_email: email("intruder"),
      p_kind: "client",
      p_client_id: ids.clientB,
      p_client_role: "client_owner",
    });
    expect(r.status).toBe(403);
  });

  it("RPC: Client A owner cannot remove Client B's owner or change roles there", async () => {
    const r1 = await api(users.ownerA.token, "POST", "rpc/remove_client_member", {
      p_client_id: ids.clientB,
      p_user_id: users.ownerB.id,
    });
    const r2 = await api(users.ownerA.token, "POST", "rpc/set_client_member_role", {
      p_client_id: ids.clientB,
      p_user_id: users.ownerB.id,
      p_role: "client_viewer",
    });
    expect([r1.status, r2.status]).toEqual([403, 403]);
  });

  it("RPC: client users cannot grant firm roles or disable accounts", async () => {
    const r1 = await api(users.ownerA.token, "POST", "rpc/set_firm_role", {
      p_user_id: users.ownerA.id,
      p_role: "firm_admin",
    });
    const r2 = await api(users.ownerA.token, "POST", "rpc/set_user_active", {
      p_user_id: users.ownerB.id,
      p_active: false,
      p_reason: "attack",
    });
    expect([r1.status, r2.status]).toEqual([403, 403]);
  });

  it("MFA: the reviewer WITHOUT two-step verification (aal1) sees no client data", async () => {
    const client = createClient(URL_, PUBLISHABLE, { auth: { persistSession: false } });
    const { data } = await client.auth.signInWithPassword({ email: email("reviewerA"), password });
    const r = await api(data.session!.access_token, "GET", "client_contacts");
    expect(r.json).toEqual([]);
  });

  it("CONTROL: legitimate access still works (owner A can add a contact to A)", async () => {
    const r = await api(users.ownerA.token, "POST", "client_contacts", {
      client_id: ids.clientA,
      full_name: "Legit Contact",
    });
    expect(r.status).toBe(201);
  });
});
