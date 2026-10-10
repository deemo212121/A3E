/**
 * LIVE end-to-end intake test in a real browser (Playwright/Chromium) against
 * the PRODUCTION build and the NON-PRODUCTION Supabase project. It drives the
 * real forms and Server Actions:
 *   - a client records a transaction (double-clicking submit) -> recorded once;
 *   - required-field validation shows field errors and records nothing;
 *   - uploads: a real PDF is stored, a disguised program is refused;
 *   - XLSX import: map columns, preview row results, commit;
 *   - staff review, approval by a different person, booking through the
 *     journal's maker-checker, after which the transaction is "Posted";
 *   - correction loop: staff return with a comment, the client sees it;
 *   - a viewer cannot open the new-transaction form.
 * Synthetic data only; everything is deleted afterwards.
 * Set E2E_SCREENSHOTS=<dir> to save screenshots for a visual check.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totp } from "../integration/totp";
import { PORT } from "./global-setup";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const enabled = Boolean(SB_URL && PUBLISHABLE && SECRET) && process.env.APP_ENV !== "production";
const APP = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.E2E_SCREENSHOTS;

const run = randomBytes(4).toString("hex");
const email = (who: string) => `a3e-e2e-${run}-${who}@example.com`;
const password = `E2e-${randomBytes(12).toString("hex")}-Aa1`;

let admin: SupabaseClient;
let browser: Browser;
const users: Record<string, string> = {};
const sessions: Record<
  string,
  { cookies: { name: string; value: string }[]; client: ReturnType<typeof createServerClient> }
> = {};
let A = "";

async function signIn(key: string, mfa: boolean) {
  const jar = new Map<string, string>();
  const client = createServerClient(SB_URL, PUBLISHABLE, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) =>
        list.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: email(key), password });
  if (error) throw new Error(`signIn ${key}: ${error.message}`);
  if (mfa) {
    const { data: f } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `e2e-${run}`,
    });
    const { error: e2 } = await client.auth.mfa.challengeAndVerify({
      factorId: f!.id,
      code: totp(f!.totp.secret),
    });
    if (e2) throw new Error(`verify ${key}: ${e2.message}`);
  }
  sessions[key] = { cookies: [...jar].map(([name, value]) => ({ name, value })), client };
}

async function pageFor(key: string, width = 1280): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addCookies(
    sessions[key].cookies.map((c) => ({ ...c, domain: "127.0.0.1", path: "/" })),
  );
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  const goto = page.goto.bind(page);
  page.goto = (async (url: string, opts?: Parameters<Page["goto"]>[1]) => {
    const res = await goto(url, opts);
    await page.waitForLoadState("networkidle");
    return res;
  }) as Page["goto"];
  return page;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const count = async (table: string, filter: Record<string, string>) => {
  let q = admin.from(table).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  return (await q).count ?? 0;
};

describe.skipIf(!enabled)("LIVE end-to-end intake in the browser", () => {
  beforeAll(async () => {
    admin = createClient(SB_URL, SECRET, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const key of ["owner", "viewer", "preparer", "approver"]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: email(key),
        password,
        email_confirm: true,
        user_metadata: { full_name: `E2E ${key}` },
      });
      if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
      users[key] = data.user.id;
    }
    const { data: c, error } = await admin
      .from("clients")
      .insert({
        code: `ZZTEST-${run}-E2E`.toUpperCase(),
        display_name: `ZZTEST ${run} E2E Trading`,
        status: "active",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    A = c.id;
    await admin.from("firm_memberships").insert([
      { user_id: users.preparer, role: "accountant" },
      { user_id: users.approver, role: "reviewer" },
    ]);
    await admin.from("client_assignments").insert([
      { client_id: A, user_id: users.preparer, assignment_role: "preparer" },
      { client_id: A, user_id: users.approver, assignment_role: "reviewer" },
    ]);
    await admin.from("client_memberships").insert([
      { client_id: A, user_id: users.owner, role: "client_owner" },
      { client_id: A, user_id: users.viewer, role: "client_viewer" },
    ]);
    await signIn("owner", false);
    await signIn("viewer", false);
    await signIn("preparer", true);
    await signIn("approver", true);
    const { error: e1 } = await sessions.approver.client.rpc("apply_coa_template", {
      p_client_id: A,
      p_template_code: "PH-SME-V0",
    });
    const { error: e2 } = await sessions.approver.client.rpc("create_fiscal_year", {
      p_client_id: A,
      p_start_date: "2026-01-01",
    });
    if (e1 || e2) throw new Error(`ledger setup: ${e1?.message ?? e2?.message}`);
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    if (!admin) return;
    if (A) {
      const { data: docs } = await admin
        .from("documents")
        .select("storage_path")
        .eq("client_id", A);
      const paths = (docs ?? []).map((d) => d.storage_path as string);
      if (paths.length) await admin.storage.from("client-documents").remove(paths);
      const { error } = await admin.rpc("purge_synthetic_client", { p_client_id: A });
      if (error) console.error(`purge failed: ${error.message}`);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id);
  });

  let txnId = "";

  it("a client records a transaction; double-clicking submit records it ONCE", async () => {
    const page = await pageFor("owner");
    await page.goto(`${APP}/portal/${A}/transactions/new`);
    await page.getByLabel("Invoice / receipt no. *").fill("E2E-OR-1");
    await page.getByLabel("Name").fill("E2E Fuel Supplier");
    await page.getByLabel("TIN (optional)").fill("123456789000");
    await page.getByLabel(/Total amount/).fill("1500.50");
    await page.getByLabel("Description").fill("Diesel for delivery truck");
    await shot(page, "01-new-transaction");
    await page.getByRole("button", { name: "Save and submit for review" }).dblclick();
    await page.waitForURL(new RegExp(`/portal/${A}/transactions/[0-9a-f-]{36}$`), {
      timeout: 30_000,
    });
    txnId = page.url().split("/").pop()!;
    await expect.poll(() => page.getByText("Submitted").first().isVisible()).toBe(true);
    await shot(page, "02-transaction-submitted");
    expect(await count("intake_transactions", { client_id: A, document_ref: "E2E-OR-1" })).toBe(1);
    await page.context().close();
  });

  it("required fields are enforced with field messages; nothing is recorded", async () => {
    const page = await pageFor("owner", 390);
    await page.goto(`${APP}/portal/${A}/transactions/new`);
    await page.getByLabel(/^Type/).selectOption("sale");
    await page.getByLabel(/Total amount/).fill("100");
    await page.getByRole("button", { name: "Save and submit for review" }).click();
    await expect
      .poll(() => page.getByText("Required for sales and purchases").isVisible(), {
        timeout: 15_000,
      })
      .toBe(true);
    await shot(page, "03-validation-phone");
    expect(await count("intake_transactions", { client_id: A, kind: "sale" })).toBe(0);
    await page.context().close();
  });

  it("uploads: a real PDF is stored; a disguised program is refused", async () => {
    const page = await pageFor("owner");
    await page.goto(`${APP}/portal/${A}/documents`);
    await page.getByLabel(/^Files/).setInputFiles([
      {
        name: "receipt.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(`%PDF-1.7\n% e2e ${run}\n%%EOF\n`),
      },
      {
        name: "invoice.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]),
      },
    ]);
    await page.getByRole("button", { name: /Upload 2 files/ }).click();
    await expect
      .poll(() => page.getByText("✓ Uploaded").isVisible(), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(() => page.getByText("Programs, scripts and web pages cannot be uploaded.").isVisible())
      .toBe(true);
    await shot(page, "04-documents");
    expect(await count("documents", { client_id: A, upload_state: "complete" })).toBe(1);
    // Retrying the failed file does not create anything.
    await page.getByRole("button", { name: /Upload 1 file/ }).click();
    await expect
      .poll(() => page.getByText("Programs, scripts and web pages cannot be uploaded.").isVisible())
      .toBe(true);
    expect(await count("documents", { client_id: A, upload_state: "complete" })).toBe(1);
    await page.context().close();
  });

  it("XLSX import: columns are matched, every row is checked, and valid rows are imported once", async () => {
    const page = await pageFor("owner");
    await page.goto(`${APP}/portal/${A}/imports`);
    await page
      .getByLabel(/^File/)
      .setInputFiles(join(process.cwd(), "tests/fixtures/synthetic-books.xlsx"));
    await page.getByRole("button", { name: "Upload and read the file" }).click();
    await page.waitForURL(new RegExp(`/portal/${A}/imports/[0-9a-f-]{36}$`), { timeout: 30_000 });
    const batchId = page.url().split("/").pop()!;
    await page.getByLabel("Type for rows without a type column").selectOption("purchase");
    await page.getByRole("button", { name: "Check all rows" }).click();
    await expect
      .poll(() => page.getByRole("button", { name: /Import 3 ready rows/ }).isVisible(), {
        timeout: 30_000,
      })
      .toBe(true);
    await shot(page, "05-import-preview");
    await page.getByRole("button", { name: /Import 3 ready rows/ }).click();
    await expect
      .poll(() => page.getByText("Import finished").isVisible(), { timeout: 30_000 })
      .toBe(true);
    await shot(page, "06-import-done");
    expect(await count("intake_transactions", { client_id: A, import_batch_id: batchId })).toBe(3);
    // Uploading the same file again is refused (it is already stored).
    await page.goto(`${APP}/portal/${A}/imports`);
    await page
      .getByLabel(/^File/)
      .setInputFiles(join(process.cwd(), "tests/fixtures/synthetic-books.xlsx"));
    await page.getByRole("button", { name: "Upload and read the file" }).click();
    await expect
      .poll(
        () =>
          page
            .getByText(/already uploaded/)
            .first()
            .isVisible(),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.context().close();
  });

  it("staff review, a different person approves, and booking through the journal posts it", async () => {
    const prep = await pageFor("preparer");
    await prep.goto(`${APP}/staff/clients/${A}/intake/${txnId}`);
    await prep.getByRole("button", { name: "Mark as reviewed" }).click();
    await expect
      .poll(
        () =>
          prep
            .getByText(
              "You reviewed this transaction, so another reviewer or manager must approve it.",
            )
            .isVisible(),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(await prep.getByRole("button", { name: "Approve" }).count()).toBe(0);
    await prep.context().close();

    const appr = await pageFor("approver");
    await appr.goto(`${APP}/staff/clients/${A}/intake/${txnId}`);
    await appr.getByRole("button", { name: "Approve" }).click();
    await expect
      .poll(() => appr.getByRole("heading", { name: "Book in the journal" }).isVisible(), {
        timeout: 15_000,
      })
      .toBe(true);
    await appr.context().close();

    // The accountant books it; the reviewer approves the journal entry.
    const book = await pageFor("preparer");
    await book.goto(`${APP}/staff/clients/${A}/intake/${txnId}`);
    const selects = book
      .locator("#new-entry select, form select")
      .filter({ hasText: "Choose an account" });
    await selects.nth(0).selectOption({ label: "6090 · Fuel and Oil" });
    await selects.nth(1).selectOption({ label: "1020 · Cash in Bank" });
    await shot(book, "07-book-in-journal");
    await book.getByRole("button", { name: "Create draft" }).click();
    await book.waitForURL(new RegExp(`/staff/clients/${A}/journal/[0-9a-f-]{36}$`), {
      timeout: 30_000,
    });
    await book.getByRole("button", { name: "Submit for review" }).click();
    await book.waitForTimeout(1500);
    const entryUrl = book.url();
    await book.context().close();

    const post = await pageFor("approver");
    await post.goto(entryUrl);
    await post.getByRole("button", { name: /Approve and post/ }).click();
    await post.waitForTimeout(1500);
    await post.goto(`${APP}/staff/clients/${A}/intake/${txnId}`);
    await expect
      .poll(() => post.getByText("View the posted journal entry").isVisible(), { timeout: 15_000 })
      .toBe(true);
    await shot(post, "08-posted");
    const { data } = await admin
      .from("intake_transactions")
      .select("status")
      .eq("id", txnId)
      .single();
    expect(data?.status).toBe("posted");
    await post.context().close();
  });

  it("correction loop: staff return an imported row with a comment; the client sees it", async () => {
    const { data } = await admin
      .from("intake_transactions")
      .select("id")
      .eq("client_id", A)
      .eq("source", "import")
      .order("import_row_no")
      .limit(1)
      .single();
    const id = data!.id as string;
    const staff = await pageFor("preparer");
    await staff.goto(`${APP}/staff/clients/${A}/intake/${id}`);
    await staff.getByText("Return to the client for correction").click();
    await staff.getByLabel(/What needs to change/).fill("Please attach the official receipt");
    await staff.getByRole("button", { name: "Return for correction" }).click();
    await staff.waitForTimeout(1500);
    await staff.context().close();

    const owner = await pageFor("owner", 390);
    await owner.goto(`${APP}/portal/${A}`);
    await expect
      .poll(() => owner.getByText(/need your correction/).isVisible(), { timeout: 15_000 })
      .toBe(true);
    await shot(owner, "09-overview-phone");
    await owner.goto(`${APP}/portal/${A}/transactions/${id}`);
    await expect
      .poll(() => owner.getByText("Please attach the official receipt").isVisible())
      .toBe(true);
    await expect
      .poll(() => owner.getByRole("heading", { name: "Correct and resubmit" }).isVisible())
      .toBe(true);
    await shot(owner, "10-correction-phone");
    await owner.context().close();
  });

  it("a viewer can read but cannot open the new-transaction form or see edit controls", async () => {
    const page = await pageFor("viewer");
    await page.goto(`${APP}/portal/${A}/transactions/new`);
    expect(await page.locator('[data-access="denied"]').count()).toBe(1);
    await page.goto(`${APP}/portal/${A}/transactions/${txnId}`);
    expect(await page.getByText("Diesel for delivery truck").first().isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: /Submit|Save/ }).count()).toBe(0);
    await page.context().close();
  });
});

// Keep the fixture path resolvable when the suite is filtered.
void readFileSync;
