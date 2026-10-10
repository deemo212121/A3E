#!/usr/bin/env node
/**
 * DEV-ONLY visual check: screenshots key pages as different roles at desktop
 * and phone widths. Creates temporary synthetic users (deleted afterwards),
 * signs them in through Supabase Auth (TOTP for staff), and drives Chromium.
 *
 *   node scripts/ui-screenshots.mjs <baseUrl> <outDir>
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import nextEnv from "@next/env";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

Object.assign(process.env, { NODE_ENV: "development" });
nextEnv.loadEnvConfig(process.cwd(), true);
if (process.env.APP_ENV === "production") throw new Error("dev only");

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "ui-shots";
mkdirSync(OUT, { recursive: true });
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const admin = createClient(URL_, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

function totp(secret) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of secret.replace(/=+$/, "")) {
    value = (value << 5) | alpha.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", Buffer.from(out)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, "0");
}

const run = randomBytes(3).toString("hex");
const password = `Ui-${randomBytes(10).toString("hex")}-Aa1`;
const { data: demoA } = await admin.from("clients").select("id").eq("code", "DEMO-A").single();
const created = [];

async function makeUser(label, setup) {
  const email = `zz-ui-${run}-${label}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `UI ${label}` },
  });
  if (error) throw error;
  created.push(data.user.id);
  await setup(data.user.id);
  return email;
}

async function cookiesFor(email, mfa) {
  const jar = new Map();
  const sb = createServerClient(URL_, KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  await sb.auth.signInWithPassword({ email, password });
  if (mfa) {
    const { data: f } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "ui" });
    await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) });
  }
  const host = new URL(BASE).hostname;
  return [...jar].map(([name, value]) => ({ name, value, domain: host, path: "/" }));
}

const A = demoA.id;
const { data: entry } = await admin
  .from("journal_entries")
  .select("id")
  .eq("client_id", A)
  .eq("entry_no", 8)
  .maybeSingle();
const personas = {
  reviewer: {
    email: await makeUser("reviewer", async (id) => {
      await admin.from("firm_memberships").insert({ user_id: id, role: "reviewer" });
      await admin
        .from("client_assignments")
        .insert({ client_id: A, user_id: id, assignment_role: "reviewer" });
    }),
    mfa: true,
    pages: [
      "/review",
      "/staff",
      `/staff/clients/${A}`,
      `/staff/clients/${A}/journal`,
      ...(entry ? [`/staff/clients/${A}/journal/${entry.id}`] : []),
      `/staff/clients/${A}/trial-balance?asOf=2026-02-28`,
      `/staff/clients/${A}/ledger`,
      `/staff/clients/${A}/periods`,
    ],
  },
  admin: {
    email: await makeUser("admin", async (id) => {
      await admin.from("firm_memberships").insert({ user_id: id, role: "firm_admin" });
    }),
    mfa: true,
    pages: ["/admin", "/admin/clients", "/admin/users"],
  },
  owner: {
    email: await makeUser("owner", async (id) => {
      await admin
        .from("client_memberships")
        .insert({ client_id: A, user_id: id, role: "client_owner" });
    }),
    mfa: false,
    pages: [`/portal/${A}`, `/portal/${A}/team`, `/portal/${A}/contacts`],
  },
};

const browser = await chromium.launch();
try {
  for (const [name, p] of Object.entries(personas)) {
    const cookies = await cookiesFor(p.email, p.mfa);
    for (const [vp, size] of Object.entries({
      desktop: { width: 1366, height: 900 },
      phone: { width: 390, height: 844 },
    })) {
      const ctx = await browser.newContext({ viewport: size });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      for (const path of p.pages) {
        await page.goto(BASE + path, { waitUntil: "networkidle" });
        const file = join(
          OUT,
          `${name}-${vp}-${path.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.png`,
        );
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
        // Journal page: also capture the entry form with the per-line supplier/receipt fields open.
        const details = page.getByLabel(/Record supplier\/customer/);
        if (path.endsWith("/journal") && (await details.count()) > 0) {
          await details.check();
          const form = page.locator("#new-entry");
          await form.screenshot({ path: file.replace(/\.png$/, "_form-details.png") });
        }
      }
      await ctx.close();
    }
  }
  // Public login page
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.screenshot({ path: join(OUT, "public-phone-login.png"), fullPage: true });
} finally {
  await browser.close();
  for (const id of created) {
    await admin.from("client_assignments").delete().eq("user_id", id);
    await admin.from("client_memberships").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  console.log(`cleaned up ${created.length} temporary users`);
}
