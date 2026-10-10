/**
 * LIVE Phase 6 intake tests against the NON-PRODUCTION Supabase project:
 * real users and sessions, real PostgREST, real Storage, real concurrency.
 *
 * GATE: one valid submission is recorded exactly once, and is never
 * duplicated by retries, including retries that arrive at the same time.
 * Also: private storage (no direct uploads, signed reads only for the right
 * tenant, bucket type/size limits), cross-tenant isolation, no direct writes.
 * Synthetic ZZTEST- clients and their stored files are removed afterwards.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totp } from "./totp";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const enabled = Boolean(URL_ && PUBLISHABLE && SECRET) && process.env.APP_ENV !== "production";
const BUCKET = "client-documents";

const run = randomBytes(4).toString("hex");
const email = (who: string) => `a3e-int-${run}-${who.toLowerCase()}@example.com`;
const password = `Int-${randomBytes(12).toString("hex")}-Aa1`;

let admin: SupabaseClient;
const users: Record<string, string> = {};
const sb: Record<string, SupabaseClient> = {};
const jwt: Record<string, string> = {};
const ids = { A: "", B: "" };

async function signIn(key: string, mfa: boolean) {
  const client = createClient(URL_, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: email(key), password });
  if (error) throw new Error(`signIn ${key}: ${error.message}`);
  if (mfa) {
    const { data, error: e1 } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `int-${run}`,
    });
    if (e1 || !data) throw new Error(`enroll ${key}: ${e1?.message}`);
    const { error: e2 } = await client.auth.mfa.challengeAndVerify({
      factorId: data.id,
      code: totp(data.totp.secret),
    });
    if (e2) throw new Error(`verify ${key}: ${e2.message}`);
  }
  const { data: s } = await client.auth.getSession();
  sb[key] = client;
  jwt[key] = s.session!.access_token;
}

async function rpc<T>(who: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb[who].rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code });
  return data as T;
}
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

const purchase = (ref: string, extra: Record<string, unknown> = {}) => ({
  kind: "purchase",
  txn_date: "2026-09-03",
  document_ref: ref,
  counterparty_name: "Sample Fuels Corp.",
  counterparty_tin: "111222333000",
  gross_amount: "2240.00",
  ...extra,
});
const saveTxn = (who: string, header: Record<string, unknown>, key: string) =>
  rpc<string>(who, "save_intake_transaction", {
    p_client_id: ids.A,
    p_transaction_id: null,
    p_expected_version: null,
    p_header: header,
    p_lines: [],
    p_document_ids: null,
    p_idempotency_key: key,
  });

/** The server's upload flow: begin (as user) -> write bytes (server key) -> complete (as user). */
async function upload(
  who: string,
  client: string,
  bytes: Uint8Array,
  name: string,
  ext: string,
  mime: string,
  category = "expense_receipt",
) {
  const rows = await rpc<{ document_id: string; object_path: string; state: string }[]>(
    who,
    "begin_document_upload",
    {
      p_client_id: client,
      p_idempotency_key: `up-${randomUUID()}`,
      p_original_filename: name,
      p_extension: ext,
      p_mime_type: mime,
      p_size_bytes: bytes.length,
      p_sha256: createHash("sha256").update(bytes).digest("hex"),
      p_category: category,
      p_period_month: null,
      p_description: null,
    },
  );
  const d = rows[0];
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(d.object_path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(`storage upload: ${error.message}`);
  await rpc(who, "complete_document_upload", { p_document_id: d.document_id });
  return d;
}

const PDF = new TextEncoder().encode(`%PDF-1.7\n% synthetic ${run}\n%%EOF\n`);

describe.skipIf(!enabled)("LIVE intake on Supabase", () => {
  beforeAll(async () => {
    admin = createClient(URL_, SECRET, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const key of ["preparer", "approver", "ownerA", "viewerA", "ownerB"]) {
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
          code: `ZZTEST-${run}-IA`.toUpperCase(),
          display_name: `ZZTEST ${run} IA`,
          status: "active",
        },
        {
          code: `ZZTEST-${run}-IB`.toUpperCase(),
          display_name: `ZZTEST ${run} IB`,
          status: "active",
        },
      ])
      .select("id, code");
    if (error || !clients) throw new Error(`clients: ${error?.message}`);
    ids.A = clients.find((c) => c.code.endsWith("-IA"))!.id;
    ids.B = clients.find((c) => c.code.endsWith("-IB"))!.id;
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
      { client_id: ids.A, user_id: users.viewerA, role: "client_viewer" },
      { client_id: ids.B, user_id: users.ownerB, role: "client_owner" },
    ]);
    await signIn("preparer", true);
    await signIn("approver", true);
    await signIn("ownerA", false);
    await signIn("viewerA", false);
    await signIn("ownerB", false);
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of [ids.A, ids.B].filter(Boolean)) {
      const { data: docs } = await admin
        .from("documents")
        .select("storage_path")
        .eq("client_id", id);
      const paths = (docs ?? []).map((d) => d.storage_path);
      if (paths.length) {
        const { error } = await admin.storage.from(BUCKET).remove(paths);
        if (error) console.error(`storage cleanup failed: ${error.message}`);
      }
      const { error } = await admin.rpc("purge_synthetic_client", { p_client_id: id });
      if (error) console.error(`purge failed: ${error.message}`);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id);
  });

  it("GATE: 8 simultaneous retries of one submission record ONE transaction", async () => {
    const key = `gate-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => saveTxn("ownerA", purchase("OR-GATE"), key)),
    );
    expect(new Set(results).size).toBe(1);
    const { count } = await admin
      .from("intake_transactions")
      .select("id", { count: "exact", head: true })
      .eq("client_id", ids.A)
      .eq("document_ref", "OR-GATE");
    expect(count).toBe(1);
  });

  it("GATE: 6 simultaneous entries of the same receipt with DIFFERENT keys: exactly one is recorded", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        codeOf(saveTxn("ownerA", purchase("OR-RACE"), `race-${randomUUID()}`)),
      ),
    );
    expect(outcomes.filter((c) => c === undefined)).toHaveLength(1);
    expect(outcomes.filter((c) => c === "23505")).toHaveLength(5);
  });

  it("GATE: 5 simultaneous submits of one draft submit it once (one history entry)", async () => {
    const id = await saveTxn("ownerA", purchase("OR-SUBMIT"), `sub-${randomUUID()}`);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc("ownerA", "transition_intake_transaction", {
          p_transaction_id: id,
          p_to: "submitted",
          p_comment: null,
        }),
      ),
    );
    expect(results.every((r) => r === "submitted")).toBe(true);
    const { data } = await admin
      .from("intake_events")
      .select("id")
      .eq("subject_id", id)
      .eq("to_status", "submitted");
    expect(data).toHaveLength(1);
  });

  it("GATE: 5 simultaneous commits of one import create each row once", async () => {
    const csv = new TextEncoder().encode(`date,si no,customer,amount\n${run}\n`);
    const doc = await upload("ownerA", ids.A, csv, "sales.csv", "csv", "text/csv", "import_source");
    const batch = await rpc<string>("ownerA", "create_import_batch", {
      p_client_id: ids.A,
      p_idempotency_key: `batch-${randomUUID()}`,
      p_document_id: doc.document_id,
      p_target: "transactions",
      p_file_type: "csv",
      p_sheet_name: null,
      p_headers: ["date", "si no", "customer", "amount"],
      p_rows: [["x"], ["x"], ["x"], ["x"]],
      p_row_numbers: [2, 3, 4, 5],
    });
    const sale = (ref: string) => ({
      kind: "sale",
      txn_date: "2026-09-10",
      document_ref: ref,
      counterparty_name: "Sample Hardware Inc.",
      gross_amount: "1000.00",
    });
    await rpc("ownerA", "save_import_mapping", {
      p_batch_id: batch,
      p_mapping: {},
      p_options: {},
      p_results: [
        { row_no: 2, normalized: sale("SI-1"), errors: [] },
        { row_no: 3, normalized: sale("SI-2"), errors: [] },
        { row_no: 4, normalized: sale("SI-1"), errors: [] },
        { row_no: 5, normalized: null, errors: [{ field: "txn_date", message: "bad" }] },
      ],
    });
    const summaries = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc<Record<string, number>>("ownerA", "commit_import_batch", {
          p_batch_id: batch,
          p_include_possible_duplicates: false,
        }),
      ),
    );
    for (const s of summaries)
      expect(s).toEqual({ total: 4, imported: 2, duplicate: 1, invalid: 1, skipped: 0 });
    const { data } = await admin
      .from("intake_transactions")
      .select("document_ref, status")
      .eq("import_batch_id", batch)
      .order("document_ref");
    expect(data).toEqual([
      { document_ref: "SI-1", status: "submitted" },
      { document_ref: "SI-2", status: "submitted" },
    ]);
  });

  describe("private document storage", () => {
    let docPath = "";
    let docId = "";

    it("API users cannot upload directly, even into their own client's folder", async () => {
      const path = `clients/${ids.A}/2026/10/${randomUUID()}.pdf`;
      const { error } = await sb.ownerA.storage
        .from(BUCKET)
        .upload(path, PDF, { contentType: "application/pdf" });
      expect(error).not.toBeNull();
      const { error: e2 } = await sb.preparer.storage
        .from(BUCKET)
        .upload(path, PDF, { contentType: "application/pdf" });
      expect(e2).not.toBeNull();
    });

    it("the server flow stores a file that same-client users can read through a signed URL", async () => {
      const d = await upload("ownerA", ids.A, PDF, "receipt.pdf", "pdf", "application/pdf");
      docPath = d.object_path;
      docId = d.document_id;
      for (const who of ["ownerA", "viewerA", "preparer"]) {
        const { data, error } = await sb[who].storage
          .from(BUCKET)
          .createSignedUrl(docPath, 60, { download: "receipt.pdf" });
        expect(error, who).toBeNull();
        const res = await fetch(data!.signedUrl);
        expect(res.status, who).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
        expect(res.headers.get("content-disposition") ?? "").toMatch(/attachment/);
      }
    });

    it("another tenant cannot read it, and there is no public URL", async () => {
      const { data, error } = await sb.ownerB.storage.from(BUCKET).createSignedUrl(docPath, 60);
      expect(data?.signedUrl ?? null).toBeNull();
      expect(error).not.toBeNull();
      const { data: dl } = await sb.ownerB.storage.from(BUCKET).download(docPath);
      expect(dl).toBeNull();
      const pub = await fetch(`${URL_}/storage/v1/object/public/${BUCKET}/${docPath}`);
      expect(pub.status).toBeGreaterThanOrEqual(400);
      const anon = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${docPath}`, {
        headers: { apikey: PUBLISHABLE },
      });
      expect(anon.status).toBeGreaterThanOrEqual(400);
    });

    it("the same file cannot be stored twice; the bucket refuses other types and oversize files", async () => {
      expect(
        await codeOf(upload("ownerA", ids.A, PDF, "again.pdf", "pdf", "application/pdf")),
      ).toBe("23505");
      const html = await admin.storage
        .from(BUCKET)
        .upload(`clients/${ids.A}/x/${randomUUID()}.html`, new TextEncoder().encode("<html>"), {
          contentType: "text/html",
        });
      expect(html.error).not.toBeNull();
      const big = new Uint8Array(10 * 1024 * 1024 + 1);
      const tooBig = await admin.storage
        .from(BUCKET)
        .upload(`clients/${ids.A}/x/${randomUUID()}.pdf`, big, { contentType: "application/pdf" });
      expect(tooBig.error).not.toBeNull();
    });

    it("two uploads of the same file finishing at the same moment: exactly one is kept", async () => {
      const bytes = new TextEncoder().encode(`%PDF-1.7
% race ${run}
%%EOF
`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const begun = await Promise.all(
        ["ownerA", "preparer"].map((who) =>
          rpc<{ document_id: string; object_path: string }[]>(who, "begin_document_upload", {
            p_client_id: ids.A,
            p_idempotency_key: `race-${randomUUID()}`,
            p_original_filename: "race.pdf",
            p_extension: "pdf",
            p_mime_type: "application/pdf",
            p_size_bytes: bytes.length,
            p_sha256: sha,
            p_category: "expense_receipt",
            p_period_month: null,
            p_description: null,
          }).then((r) => ({ who, ...r[0] })),
        ),
      );
      for (const b of begun) {
        const { error } = await admin.storage
          .from(BUCKET)
          .upload(b.object_path, bytes, { contentType: "application/pdf" });
        expect(error).toBeNull();
      }
      const outcomes = await Promise.all(
        begun.map((b) =>
          codeOf(rpc(b.who, "complete_document_upload", { p_document_id: b.document_id })),
        ),
      );
      expect(outcomes.filter((c) => c === undefined)).toHaveLength(1);
      expect(outcomes.filter((c) => c === "23505")).toHaveLength(1);
      const { count } = await admin
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("client_id", ids.A)
        .eq("sha256", sha)
        .eq("upload_state", "complete");
      expect(count).toBe(1);
    });

    it("downloads are logged; another tenant cannot log or delete", async () => {
      await rpc("viewerA", "log_document_access", { p_document_id: docId });
      expect(await codeOf(rpc("ownerB", "log_document_access", { p_document_id: docId }))).toBe(
        "P0002",
      );
      expect(
        await codeOf(rpc("ownerB", "delete_document", { p_document_id: docId, p_reason: "nope" })),
      ).toBe("P0002");
      expect(
        await codeOf(rpc("viewerA", "delete_document", { p_document_id: docId, p_reason: "nope" })),
      ).toBe("42501");
    });
  });

  it("workflow over the API: review, internal note hidden from the client, approval by a different person", async () => {
    const id = await saveTxn("ownerA", purchase("OR-WF"), `wf-${randomUUID()}`);
    await rpc("ownerA", "transition_intake_transaction", {
      p_transaction_id: id,
      p_to: "submitted",
      p_comment: null,
    });
    await rpc("preparer", "add_intake_comment", {
      p_client_id: ids.A,
      p_subject: "transaction",
      p_subject_id: id,
      p_body: "Matches the bank statement",
      p_visibility: "internal",
      p_idempotency_key: `c-${randomUUID()}`,
    });
    await rpc("preparer", "transition_intake_transaction", {
      p_transaction_id: id,
      p_to: "reviewed",
      p_comment: null,
    });
    expect(
      await codeOf(
        rpc("preparer", "transition_intake_transaction", {
          p_transaction_id: id,
          p_to: "approved",
          p_comment: null,
        }),
      ),
    ).toBe("42501");
    await rpc("approver", "transition_intake_transaction", {
      p_transaction_id: id,
      p_to: "approved",
      p_comment: null,
    });
    const { data: seenByClient } = await sb.ownerA
      .from("intake_comments")
      .select("body")
      .eq("subject_id", id);
    expect(seenByClient).toEqual([]);
    const { data: seenByStaff } = await sb.approver
      .from("intake_comments")
      .select("body")
      .eq("subject_id", id);
    expect(seenByStaff).toEqual([{ body: "Matches the bank statement" }]);
  });

  it("another tenant sees nothing and cannot act; nobody writes the tables directly", async () => {
    for (const table of [
      "intake_transactions",
      "intake_events",
      "documents",
      "import_batches",
      "counterparties",
    ]) {
      const { data } = await sb.ownerB.from(table).select("id").eq("client_id", ids.A);
      expect(data, table).toEqual([]);
    }
    const { data: one } = await admin
      .from("intake_transactions")
      .select("id")
      .eq("client_id", ids.A)
      .limit(1)
      .single();
    expect(
      await codeOf(
        rpc("ownerB", "transition_intake_transaction", {
          p_transaction_id: one!.id,
          p_to: "cancelled",
          p_comment: null,
        }),
      ),
    ).toBe("P0002");
    const patch = await fetch(`${URL_}/rest/v1/intake_transactions?client_id=eq.${ids.A}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE,
        Authorization: `Bearer ${jwt.ownerA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "approved" }),
    });
    expect([401, 403]).toContain(patch.status);
    const { error } = await sb.ownerA
      .from("intake_transactions")
      .insert({ client_id: ids.A, kind: "sale", idempotency_key: "direct-insert-x" });
    expect(error?.code).toBe("42501");
  });
});
