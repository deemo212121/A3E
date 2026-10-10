/**
 * LIVE accounting engine tests against the NON-PRODUCTION Supabase project:
 * real users and sessions, real PostgREST, real Postgres 17 concurrency.
 *
 * Proves on the real platform: correct debits/credits and trial balance,
 * reversal netting, duplicate prevention UNDER CONCURRENCY (parallel requests
 * from separate connections), gapless numbering, cross-tenant ledger isolation
 * and no direct writes. Synthetic ZZTEST- clients are purged afterwards.
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
const email = (who: string) => `a3e-acc-${run}-${who.toLowerCase()}@example.com`;
const password = `Acc-${randomBytes(12).toString("hex")}-Aa1`;

let admin: SupabaseClient;
const users: Record<string, string> = {};
const sb: Record<string, SupabaseClient> = {};
const ids = { A: "", B: "" };
let token = "";

async function userClient(
  key: string,
  mfa: boolean,
): Promise<{ client: SupabaseClient; jwt: string }> {
  const client = createClient(URL_, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: email(key), password });
  if (error) throw new Error(`signIn ${key}: ${error.message}`);
  if (mfa) {
    const { data, error: e1 } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `acc-${run}`,
    });
    if (e1 || !data) throw new Error(`enroll ${key}: ${e1?.message}`);
    const { error: e2 } = await client.auth.mfa.challengeAndVerify({
      factorId: data.id,
      code: totp(data.totp.secret),
    });
    if (e2) throw new Error(`verify ${key}: ${e2.message}`);
  }
  const { data: s } = await client.auth.getSession();
  return { client, jwt: s.session!.access_token };
}

async function rpc<T>(who: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb[who].rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code });
  return data as T;
}

async function accountId(code: string, client = ids.A): Promise<string> {
  const { data } = await admin
    .from("accounts")
    .select("id")
    .eq("client_id", client)
    .eq("code", code)
    .single();
  return data!.id;
}

async function lines(spec: [string, string, string][], client = ids.A) {
  return Promise.all(
    spec.map(async ([code, debit, credit]) => ({
      account_id: await accountId(code, client),
      debit,
      credit,
    })),
  );
}

let seq = 0;
async function draft(
  date: string,
  spec: [string, string, string][],
  extra: Record<string, unknown> = {},
) {
  return rpc<string>("preparer", "save_draft_entry", {
    p_client_id: ids.A,
    p_entry_id: null,
    p_entry_date: date,
    p_entry_type: "general",
    p_memo: "live test",
    p_source_type: null,
    p_source_ref: null,
    p_idempotency_key: `live-${run}-${++seq}`,
    p_lines: await lines(spec),
    ...extra,
  });
}

async function postEntry(
  date: string,
  spec: [string, string, string][],
  extra: Record<string, unknown> = {},
) {
  const id = await draft(date, spec, extra);
  await rpc("preparer", "submit_entry", { p_entry_id: id });
  const no = await rpc<number>("approver", "approve_and_post", { p_entry_id: id });
  return { id, no };
}

async function tb(asOf: string, who = "approver") {
  const rows = await rpc<{ code: string; balance: number | string }[]>(who, "trial_balance", {
    p_client_id: ids.A,
    p_as_of: asOf,
  });
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.balance).toFixed(2)]));
}

describe.skipIf(!enabled)("LIVE accounting engine on Supabase", () => {
  beforeAll(async () => {
    admin = createClient(URL_, SECRET, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const key of ["preparer", "approver", "ownerA", "ownerB"]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: email(key),
        password,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
      users[key] = data.user.id;
    }
    const { data: clients, error } = await admin
      .from("clients")
      .insert([
        {
          code: `ZZTEST-${run}-A`.toUpperCase(),
          display_name: `ZZTEST ${run} A`,
          status: "active",
        },
        {
          code: `ZZTEST-${run}-B`.toUpperCase(),
          display_name: `ZZTEST ${run} B`,
          status: "active",
        },
      ])
      .select("id, code");
    if (error || !clients) throw new Error(`clients: ${error?.message}`);
    ids.A = clients.find((c) => c.code.endsWith("-A"))!.id;
    ids.B = clients.find((c) => c.code.endsWith("-B"))!.id;
    await admin.from("firm_memberships").insert([
      { user_id: users.preparer, role: "accountant" },
      { user_id: users.approver, role: "reviewer" },
    ]);
    await admin.from("client_assignments").insert([
      { client_id: ids.A, user_id: users.preparer, assignment_role: "preparer" },
      { client_id: ids.A, user_id: users.approver, assignment_role: "reviewer" },
    ]);
    await admin.from("client_memberships").insert([
      { client_id: ids.A, user_id: users.ownerA, role: "client_owner" },
      { client_id: ids.B, user_id: users.ownerB, role: "client_owner" },
    ]);
    sb.preparer = (await userClient("preparer", true)).client;
    sb.approver = (await userClient("approver", true)).client;
    sb.ownerA = (await userClient("ownerA", false)).client;
    const ownerB = await userClient("ownerB", false);
    sb.ownerB = ownerB.client;
    token = ownerB.jwt;

    await rpc("approver", "apply_coa_template", {
      p_client_id: ids.A,
      p_template_code: "PH-SME-V0",
    });
    await rpc("approver", "create_fiscal_year", { p_client_id: ids.A, p_start_date: "2026-01-01" });
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of [ids.A, ids.B].filter(Boolean)) {
      const { error } = await admin.rpc("purge_synthetic_client", { p_client_id: id });
      if (error) console.error(`purge failed: ${error.message}`);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id);
  });

  it("posts Scenario S1 through the API and the trial balance matches the reviewed expectation", async () => {
    const nos = [
      (
        await postEntry(
          "2026-01-01",
          [
            ["1020", "500000.00", ""],
            ["3010", "", "500000.00"],
          ],
          { p_entry_type: "opening" },
        )
      ).no,
      (
        await postEntry("2026-01-05", [
          ["1100", "120000.00", ""],
          ["4020", "", "120000.00"],
        ])
      ).no,
      (
        await postEntry("2026-01-10", [
          ["6020", "25000.00", ""],
          ["1020", "", "25000.00"],
        ])
      ).no,
      (
        await postEntry("2026-01-15", [
          ["1500", "150000.00", ""],
          ["1020", "", "50000.00"],
          ["2200", "", "100000.00"],
        ])
      ).no,
      (
        await postEntry("2026-01-20", [
          ["1020", "80000.00", ""],
          ["1100", "", "80000.00"],
        ])
      ).no,
      (
        await postEntry("2026-01-25", [
          ["6030", "4567.89", ""],
          ["2020", "", "4567.89"],
        ])
      ).no,
      (
        await postEntry("2026-01-31", [
          ["6010", "60000.00", ""],
          ["1020", "", "60000.00"],
        ])
      ).no,
    ];
    expect(nos).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await tb("2026-01-31")).toEqual({
      "1020": "445000.00",
      "1100": "40000.00",
      "1500": "150000.00",
      "2020": "4567.89",
      "2200": "100000.00",
      "3010": "500000.00",
      "4020": "120000.00",
      "6010": "60000.00",
      "6020": "25000.00",
      "6030": "4567.89",
    });
  });

  it("CONCURRENCY: 10 simultaneous approvals of one entry post it exactly once", async () => {
    const id = await draft("2026-02-02", [
      ["6070", "10.00", ""],
      ["1020", "", "10.00"],
    ]);
    await rpc("preparer", "submit_entry", { p_entry_id: id });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        rpc<number>("approver", "approve_and_post", { p_entry_id: id }),
      ),
    );
    expect(new Set(results)).toEqual(new Set([8]));
    const { data: fy } = await admin
      .from("fiscal_years")
      .select("next_entry_no")
      .eq("client_id", ids.A)
      .single();
    expect(fy!.next_entry_no).toBe(9);
  });

  it("CONCURRENCY: 8 entries approved in parallel get unique, gapless numbers 9..16", async () => {
    const entries: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = await draft("2026-02-03", [
        ["6070", `${i + 1}.00`, ""],
        ["1020", "", `${i + 1}.00`],
      ]);
      await rpc("preparer", "submit_entry", { p_entry_id: id });
      entries.push(id);
    }
    const numbers = await Promise.all(
      entries.map((id) => rpc<number>("approver", "approve_and_post", { p_entry_id: id })),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("CONCURRENCY: 6 simultaneous saves with the same idempotency key create ONE entry", async () => {
    const key = `same-key-${run}`;
    const payload = {
      p_client_id: ids.A,
      p_entry_id: null,
      p_entry_date: "2026-02-04",
      p_entry_type: "general",
      p_memo: "race",
      p_source_type: null,
      p_source_ref: null,
      p_idempotency_key: key,
      p_lines: await lines([
        ["6070", "1.00", ""],
        ["1020", "", "1.00"],
      ]),
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => rpc<string>("preparer", "save_draft_entry", payload)),
    );
    expect(new Set(results).size).toBe(1);
    const { count } = await admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("client_id", ids.A)
      .eq("idempotency_key", key);
    expect(count).toBe(1);
  });

  it("CONCURRENCY: 5 simultaneous reversals of one entry produce ONE reversal", async () => {
    const { id } = await postEntry("2026-02-05", [
      ["6040", "1000.00", ""],
      ["1020", "", "1000.00"],
    ]);
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        rpc<string>("approver", "reverse_entry", {
          p_entry_id: id,
          p_reversal_date: "2026-02-06",
          p_reason: "wrong amount",
          p_idempotency_key: `rev-${run}-${i}`,
        }),
      ),
    );
    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(1);
    const { count } = await admin
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("reverses_entry_id", id);
    expect(count).toBe(1);
    const t = await tb("2026-02-28");
    expect(t["6040"]).toBe("0.00");
  });

  it("an unbalanced entry is rejected by the API", async () => {
    const id = await draft("2026-02-07", [
      ["6070", "100.00", ""],
      ["1020", "", "99.99"],
    ]);
    await expect(rpc("preparer", "submit_entry", { p_entry_id: id })).rejects.toMatchObject({
      code: "22023",
    });
  });

  it("numbers are gapless across the whole run (1..18)", async () => {
    const { data } = await admin
      .from("journal_entries")
      .select("entry_no")
      .eq("client_id", ids.A)
      .not("entry_no", "is", null)
      .order("entry_no");
    expect(data!.map((r) => r.entry_no)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it("Client B's owner cannot read Client A's ledger through the API", async () => {
    const e = await sb.ownerB.from("journal_entries").select("id").eq("client_id", ids.A);
    const l = await sb.ownerB.from("journal_lines").select("id").eq("client_id", ids.A);
    const t = await sb.ownerB.rpc("trial_balance", { p_client_id: ids.A, p_as_of: "2026-12-31" });
    expect([e.data, l.data, t.data]).toEqual([[], [], []]);
  });

  it("Client A's owner sees the posted ledger but cannot write to it", async () => {
    const t = await sb.ownerA.rpc("trial_balance", { p_client_id: ids.A, p_as_of: "2026-01-31" });
    expect((t.data as unknown[]).length).toBe(10);
    const res = await fetch(`${URL_}/rest/v1/journal_lines?client_id=eq.${ids.A}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ debit: 1 }),
    });
    expect([401, 403]).toContain(res.status);
    const { error } = await sb.ownerA.rpc("save_draft_entry", {
      p_client_id: ids.A,
      p_entry_id: null,
      p_entry_date: "2026-02-08",
      p_entry_type: "general",
      p_memo: "",
      p_source_type: null,
      p_source_ref: null,
      p_idempotency_key: `owner-try-${run}`,
      p_lines: await lines([
        ["6070", "1.00", ""],
        ["1020", "", "1.00"],
      ]),
    });
    expect(error?.code).toBe("42501");
  });

  it("stores supplier, normalized TIN and receipt no. per line through the API (synthetic)", async () => {
    const [fuel, cash] = await Promise.all([accountId("6040"), accountId("1020")]);
    const supplier = { counterparty_name: "Sample Fuels Corp.", document_ref: "OR-1001" };
    const { id } = await postEntry("2026-02-10", [], {
      p_lines: [
        {
          account_id: fuel,
          debit: "50.00",
          credit: "",
          ...supplier,
          counterparty_tin: "111 222 333 00000",
        },
        { account_id: cash, debit: "", credit: "50.00" },
      ],
    });
    const { data } = await sb.approver
      .from("journal_lines")
      .select("line_no, counterparty_name, counterparty_tin, document_ref")
      .eq("entry_id", id)
      .order("line_no");
    expect(data).toEqual([
      { line_no: 1, ...supplier, counterparty_tin: "111-222-333-00000" },
      { line_no: 2, counterparty_name: null, counterparty_tin: null, document_ref: null },
    ]);
    const gl = await rpc<{ document_ref: string; counterparty_tin: string }[]>(
      "approver",
      "general_ledger",
      { p_client_id: ids.A, p_account_id: fuel, p_from: "2026-02-10", p_to: "2026-02-10" },
    );
    expect(gl.map((r) => [r.document_ref, r.counterparty_tin])).toEqual([
      ["OR-1001", "111-222-333-00000"],
    ]);
    await expect(
      draft("2026-02-10", [], {
        p_lines: [
          {
            account_id: fuel,
            debit: "1.00",
            credit: "",
            counterparty_name: "X",
            counterparty_tin: "12345",
          },
          { account_id: cash, debit: "", credit: "1.00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "22023" });
    const other = await sb.ownerB
      .from("journal_lines")
      .select("counterparty_tin")
      .eq("entry_id", id);
    expect(other.data).toEqual([]);
  });
});
