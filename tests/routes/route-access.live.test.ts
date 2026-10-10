/**
 * LIVE route-access tests (gate for Phase 4).
 *
 * Runs against the PRODUCTION build (`next start`) connected to the NON-PRODUCTION
 * Supabase project. For each synthetic persona it:
 *   1. signs in through Supabase Auth and keeps the real session cookies,
 *   2. requests every protected URL DIRECTLY (what a reload / new tab does),
 *   3. classifies the server's answer (allowed / forbidden / not-found /
 *      login / mfa / disabled / redirect),
 *   4. asserts it equals the shared route policy evaluated on the persona's
 *      database facts, plus hard-coded critical expectations,
 *   5. checks that rendered navigation links are exactly the allowed routes,
 *   6. checks that denied pages leak no other tenant's data.
 * Everything created is deleted afterwards.
 */
import { randomBytes } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildNavigation,
  evaluateRoute,
  homeFor,
  matchRoute,
  type AccessFacts,
} from "@/lib/access/route-policy";

import { totp } from "../integration/totp";
import { PORT } from "./global-setup";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const enabled = Boolean(SB_URL && PUBLISHABLE && SECRET) && process.env.APP_ENV !== "production";
const APP = `http://127.0.0.1:${PORT}`;

const run = randomBytes(4).toString("hex");
const email = (who: string) => `a3e-rt-${run}-${who.toLowerCase()}@example.com`;
const password = `Rt-${randomBytes(12).toString("hex")}-Aa1`;

type PersonaKey =
  | "firmAdmin"
  | "manager"
  | "reviewerA"
  | "accountantB"
  | "ownerA"
  | "staffA"
  | "viewerA"
  | "ownerB"
  | "outsider"
  | "disabledA"
  | "reviewerNoMfa";

const STAFF: Partial<Record<PersonaKey, string>> = {
  firmAdmin: "firm_admin",
  manager: "firm_manager",
  reviewerA: "reviewer",
  accountantB: "accountant",
};

let admin: SupabaseClient;
const userIds: Record<string, string> = {};
const cookies: Partial<Record<PersonaKey, string>> = {};
const facts: Partial<Record<PersonaKey, AccessFacts>> = {};
const clientsByKey: Partial<Record<PersonaKey, ReturnType<typeof createServerClient>>> = {};
const ids = { A: "", B: "" };
const NAMES = {
  A: `RT ${run} Alpha Trading`,
  B: `RT ${run} Bravo Services`,
  contactA: `RT ${run} Contact Alpha`,
};

async function signInWithCookies(key: string, withMfa: boolean) {
  const jar = new Map<string, string>();
  const client = createServerClient(SB_URL, PUBLISHABLE, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const c of list) {
          if (c.value) jar.set(c.name, c.value);
          else jar.delete(c.name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: email(key), password });
  if (error) throw new Error(`signIn ${key}: ${error.message}`);
  if (withMfa) {
    const { data: f, error: e1 } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `rt-${run}`,
    });
    if (e1 || !f) throw new Error(`enroll ${key}: ${e1?.message}`);
    const { error: e2 } = await client.auth.mfa.challengeAndVerify({
      factorId: f.id,
      code: totp(f.totp.secret),
    });
    if (e2) throw new Error(`verify ${key}: ${e2.message}`);
  }
  const { data: accessJson, error: accessError } = await client.rpc("get_my_access");
  if (accessError) throw new Error(`get_my_access ${key}: ${accessError.message}`);
  return {
    cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
    access: accessJson as Record<string, unknown>,
    client,
  };
}

function toFacts(a: Record<string, unknown>): AccessFacts {
  return {
    firmRole: (a.firm_role_effective as AccessFacts["firmRole"]) ?? null,
    clientMemberships: (
      a.client_memberships as {
        client_id: string;
        role: never;
        display_name: string;
        code: string;
      }[]
    ).map((m) => ({
      clientId: m.client_id,
      role: m.role,
      displayName: m.display_name,
      code: m.code,
    })),
    staffClientIds: (a.staff_client_ids as string[]) ?? [],
  };
}

async function get(path: string, cookie?: string) {
  const res = await fetch(`${APP}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
    body: await res.text(),
  };
}

function redirectTarget(target: string): string {
  const path = target.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  if (path === "/login") return "login";
  if (path === "/mfa") return "mfa";
  if (path === "/account-disabled") return "disabled";
  return `redirect:${path}`;
}

/** Classifies a server response into an access outcome. */
function classify(r: { status: number; location: string; body: string }): string {
  if (r.status >= 300 && r.status < 400) return redirectTarget(r.location);
  const streamed = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/.exec(r.body);
  if (streamed) return redirectTarget(streamed[1]);
  if (/data-access(?:=|\\?":\\?")\\?"?not-found/.test(r.body)) return "not_found";
  if (/data-access(?:=|\\?":\\?")\\?"?denied/.test(r.body)) return "forbidden";
  const route = /data-route(?:=|\\?":\\?")\\?"?([a-z._]+)/.exec(r.body);
  if (route) return `allowed:${route[1]}`;
  return `unknown(${r.status})`;
}

function expectedOutcome(path: string, f: AccessFacts): string {
  const m = matchRoute(path);
  if (!m) return "not_found"; // malformed ids under a known area
  if (m.route === "home") return `redirect:${homeFor(f)}`;
  const d = evaluateRoute(m.route, f, m.params);
  if (d.allowed) return `allowed:${m.route}`;
  return d.reason;
}

function pathsToProbe(): string[] {
  const perClient = (id: string) => [
    `/portal/${id}`,
    `/portal/${id}/contacts`,
    `/portal/${id}/team`,
    `/portal/${id}/documents`,
    `/portal/${id}/requests`,
    `/staff/clients/${id}`,
    `/staff/clients/${id}/journal`,
    `/staff/clients/${id}/trial-balance`,
    `/staff/clients/${id}/ledger`,
    `/staff/clients/${id}/accounts`,
    `/staff/clients/${id}/periods`,
  ];
  return [
    "/app",
    "/account",
    "/invitations",
    "/portal",
    ...perClient(ids.A),
    ...perClient(ids.B),
    "/staff",
    "/review",
    "/review/assignments",
    "/admin",
    "/admin/clients",
    `/admin/clients/${ids.A}`,
    "/admin/users",
    "/admin/invitations",
    "/portal/not-a-uuid",
  ];
}

describe.skipIf(!enabled)("LIVE route access: UI navigation matches actual permissions", () => {
  beforeAll(async () => {
    admin = createClient(SB_URL, SECRET, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const personas: PersonaKey[] = [
      "firmAdmin",
      "manager",
      "reviewerA",
      "accountantB",
      "ownerA",
      "staffA",
      "viewerA",
      "ownerB",
      "outsider",
      "disabledA",
    ];
    for (const key of personas) {
      const { data, error } = await admin.auth.admin.createUser({
        email: email(key),
        password,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
      userIds[key] = data.user.id;
    }
    userIds.reviewerNoMfa = userIds.reviewerA;

    const { data: clients, error: cErr } = await admin
      .from("clients")
      .insert([
        { code: `ZZTEST-RT-${run}-A`.toUpperCase(), display_name: NAMES.A, status: "active" },
        { code: `ZZTEST-RT-${run}-B`.toUpperCase(), display_name: NAMES.B, status: "active" },
      ])
      .select("id, code");
    if (cErr || !clients) throw new Error(`clients: ${cErr?.message}`);
    ids.A = clients.find((c) => c.code.endsWith("-A"))!.id;
    ids.B = clients.find((c) => c.code.endsWith("-B"))!.id;

    const must = (r: { error: { message: string } | null }, what: string) => {
      if (r.error) throw new Error(`${what}: ${r.error.message}`);
    };
    must(
      await admin
        .from("firm_memberships")
        .insert(Object.entries(STAFF).map(([key, role]) => ({ user_id: userIds[key], role }))),
      "firm roles",
    );
    must(
      await admin.from("client_assignments").insert([
        { client_id: ids.A, user_id: userIds.reviewerA, assignment_role: "reviewer" },
        { client_id: ids.B, user_id: userIds.accountantB, assignment_role: "preparer" },
      ]),
      "assignments",
    );
    must(
      await admin.from("client_memberships").insert([
        { client_id: ids.A, user_id: userIds.ownerA, role: "client_owner" },
        { client_id: ids.A, user_id: userIds.staffA, role: "client_staff" },
        { client_id: ids.A, user_id: userIds.viewerA, role: "client_viewer" },
        { client_id: ids.A, user_id: userIds.disabledA, role: "client_staff" },
        { client_id: ids.B, user_id: userIds.ownerB, role: "client_owner" },
      ]),
      "memberships",
    );
    must(
      await admin.from("client_contacts").insert({ client_id: ids.A, full_name: NAMES.contactA }),
      "contact",
    );

    for (const key of personas) {
      const session = await signInWithCookies(key, key in STAFF);
      cookies[key] = session.cookie;
      clientsByKey[key] = session.client;
      facts[key] = toFacts(session.access);
    }
    // Same reviewer, but a fresh session WITHOUT completing MFA (aal1).
    cookies.reviewerNoMfa = (await signInWithCookies("reviewerA", false)).cookie;

    // Disable one account at the database level (as set_user_active does).
    must(
      await admin
        .from("profiles")
        .update({
          is_active: false,
          disabled_at: new Date().toISOString(),
          disabled_reason: "route test",
        })
        .eq("id", userIds.disabledA),
      "disable",
    );
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of [ids.A, ids.B].filter(Boolean)) {
      const { error } = await admin.rpc("purge_synthetic_client", { p_client_id: id });
      if (error) console.error(`purge failed: ${error.message}`);
    }
    for (const id of new Set(Object.values(userIds))) await admin.auth.admin.deleteUser(id);
  });

  it("unauthenticated direct requests to every protected URL are sent to /login", async () => {
    for (const path of pathsToProbe()) {
      const r = await get(path);
      expect({ path, outcome: classify(r) }).toEqual({ path, outcome: "login" });
      if (r.status >= 300 && r.status < 400) {
        expect(r.status).toBe(307);
        expect(r.location).toContain("next=");
      }
    }
  });

  const SIGNED_IN: PersonaKey[] = [
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

  it.each(SIGNED_IN)("%s: every direct URL returns exactly what the policy allows", async (key) => {
    const mismatches: string[] = [];
    for (const path of pathsToProbe()) {
      const actual = classify(await get(path, cookies[key]));
      const expected = expectedOutcome(path, facts[key]!);
      if (actual !== expected) mismatches.push(`${path}: expected ${expected}, got ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("hard-coded critical expectations hold (not derived from the policy)", async () => {
    const cases: [PersonaKey, string, string][] = [
      ["ownerA", `/portal/${ids.B}`, "not_found"],
      ["ownerA", `/portal/${ids.B}/team`, "not_found"],
      ["ownerA", "/admin", "forbidden"],
      ["ownerA", "/staff", "forbidden"],
      ["viewerA", `/portal/${ids.A}/contacts`, "allowed:portal.contacts"],
      ["reviewerA", `/staff/clients/${ids.B}`, "not_found"],
      ["reviewerA", `/staff/clients/${ids.A}`, "allowed:staff.client"],
      ["reviewerA", "/review/assignments", "forbidden"],
      ["accountantB", "/review", "forbidden"],
      ["firmAdmin", `/staff/clients/${ids.A}`, "forbidden"],
      ["firmAdmin", `/portal/${ids.A}`, "not_found"],
      ["firmAdmin", "/admin/users", "allowed:admin.users"],
      ["manager", "/admin/users", "forbidden"],
      ["manager", "/review/assignments", "allowed:review.assignments"],
      ["outsider", "/portal", "forbidden"],
    ];
    for (const [key, path, expected] of cases) {
      expect({ key, path, outcome: classify(await get(path, cookies[key])) }).toEqual({
        key,
        path,
        outcome: expected,
      });
    }
  });

  it("staff session without MFA is sent to /mfa on every protected URL", async () => {
    for (const path of ["/app", "/review", `/staff/clients/${ids.A}`, "/account"]) {
      expect({ path, outcome: classify(await get(path, cookies.reviewerNoMfa)) }).toEqual({
        path,
        outcome: "mfa",
      });
    }
  });

  it("a disabled account is sent to /account-disabled on every protected URL", async () => {
    for (const path of ["/app", "/portal", `/portal/${ids.A}`, "/account"]) {
      expect({ path, outcome: classify(await get(path, cookies.disabledA)) }).toEqual({
        path,
        outcome: "disabled",
      });
    }
  });

  it.each(SIGNED_IN)(
    "%s: rendered navigation = allowed routes, and every link opens",
    async (key) => {
      const html = (await get("/account", cookies[key])).body;
      const rendered = new Set<string>();
      for (const tag of html.match(/<a\b[^>]*data-nav-route="[^"]+"[^>]*>/g) ?? []) {
        const href = /href="([^"]+)"/.exec(tag)?.[1];
        if (href) rendered.add(href);
      }
      const expected = new Set(
        buildNavigation(facts[key]!).flatMap((s) => s.items.map((i) => i.href)),
      );
      expect([...rendered].sort()).toEqual([...expected].sort());
      for (const href of rendered) {
        expect({ href, outcome: classify(await get(href, cookies[key])) }).toMatchObject({
          href,
          outcome: expect.stringMatching(/^allowed:/),
        });
      }
    },
  );

  it("denied and other-tenant pages leak no other tenant's data", async () => {
    for (const path of [
      `/portal/${ids.B}`,
      `/portal/${ids.B}/team`,
      `/portal/${ids.B}/contacts`,
      `/staff/clients/${ids.B}`,
    ]) {
      const body = (await get(path, cookies.ownerA)).body;
      expect({ path, leaked: body.includes(NAMES.B) }).toEqual({ path, leaked: false });
    }
    const adminBody = (await get(`/staff/clients/${ids.A}`, cookies.firmAdmin)).body;
    expect(adminBody.includes(NAMES.contactA)).toBe(false);
    const outsiderBody = (await get("/admin/clients", cookies.outsider)).body;
    expect(outsiderBody.includes(NAMES.A) || outsiderBody.includes(NAMES.B)).toBe(false);
  });

  it("ledger pages render real posted data by direct URL (reviewer prepares, manager approves)", async () => {
    const reviewer = clientsByKey.reviewerA!;
    const manager = clientsByKey.manager!;
    const ok = (r: { error: { message: string } | null }, what: string) => {
      if (r.error) throw new Error(`${what}: ${r.error.message}`);
    };
    ok(
      await reviewer.rpc("apply_coa_template", {
        p_client_id: ids.A,
        p_template_code: "PH-SME-V0",
      }),
      "template",
    );
    ok(
      await reviewer.rpc("create_fiscal_year", { p_client_id: ids.A, p_start_date: "2026-01-01" }),
      "fiscal year",
    );
    const { data: accts } = await admin
      .from("accounts")
      .select("id, code")
      .eq("client_id", ids.A)
      .in("code", ["1020", "3010"]);
    const acct = (code: string) => accts!.find((a) => a.code === code)!.id;
    const draft = await reviewer.rpc("save_draft_entry", {
      p_client_id: ids.A,
      p_entry_id: null,
      p_entry_date: "2026-01-02",
      p_entry_type: "opening",
      p_memo: "RT opening balance",
      p_source_type: null,
      p_source_ref: null,
      p_idempotency_key: `rt-ledger-${run}`,
      p_lines: [
        { account_id: acct("1020"), debit: "123456.78" },
        { account_id: acct("3010"), credit: "123456.78" },
      ],
    });
    ok(draft, "draft");
    ok(await reviewer.rpc("submit_entry", { p_entry_id: draft.data }), "submit");
    ok(await manager.rpc("approve_and_post", { p_entry_id: draft.data }), "approve");

    const base = `/staff/clients/${ids.A}`;
    const pages: [string, string][] = [
      [`${base}/journal`, "allowed:staff.journal"],
      [`${base}/journal/${draft.data}`, "allowed:staff.entry"],
      [`${base}/trial-balance?asOf=2026-01-31`, "allowed:staff.trial_balance"],
      [
        `${base}/ledger?account=${acct("1020")}&from=2026-01-01&to=2026-01-31`,
        "allowed:staff.ledger",
      ],
    ];
    for (const [path, expected] of pages) {
      const r = await get(path, cookies.reviewerA);
      expect({ path, outcome: classify(r) }).toEqual({ path, outcome: expected });
      expect({ path, hasAmount: r.body.includes("123,456.78") }).toEqual({ path, hasAmount: true });
    }
    // The other tenant's owner and an unassigned accountant still get not-found / forbidden.
    expect(classify(await get(`${base}/journal/${draft.data}`, cookies.accountantB))).toBe(
      "not_found",
    );
    expect(classify(await get(`${base}/trial-balance`, cookies.ownerB))).toBe("forbidden");
    expect((await get(`${base}/trial-balance`, cookies.ownerB)).body.includes("123,456.78")).toBe(
      false,
    );
  });
});
