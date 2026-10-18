#!/usr/bin/env node
/**
 * Creates DEV-ONLY demo accounts and DEMO client businesses so the owner can
 * sign in and explore each workspace. Refuses to run when APP_ENV=production.
 * Passwords are written to dev-accounts.local.txt (git-ignored), never printed.
 *
 *   npm run seed:dev-accounts
 *
 * Re-running resets the demo accounts' passwords and leaves other data alone.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

Object.assign(process.env, { NODE_ENV: "development" });
nextEnv.loadEnvConfig(process.cwd(), true);

if (process.env.APP_ENV === "production") {
  console.error("Refusing to seed demo accounts in production.");
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(2);
}
const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const pw = () => `Demo-${randomBytes(6).toString("hex")}-Aa1`;
const ACCOUNTS = [
  {
    key: "admin",
    email: "demo.admin@example.com",
    name: "DEMO Firm Admin",
    firmRole: "firm_admin",
  },
  {
    key: "manager",
    email: "demo.manager@example.com",
    name: "DEMO Firm Manager",
    firmRole: "firm_manager",
  },
  {
    key: "reviewer",
    email: "demo.reviewer@example.com",
    name: "DEMO Reviewer",
    firmRole: "reviewer",
  },
  {
    key: "accountant",
    email: "demo.accountant@example.com",
    name: "DEMO Accountant",
    firmRole: "accountant",
  },
  { key: "owner", email: "demo.owner@example.com", name: "DEMO Client Owner", firmRole: null },
];
const CLIENTS = [
  { code: "DEMO-A", display_name: "DEMO Sampaguita Trading", status: "active" },
  { code: "DEMO-B", display_name: "DEMO Narra Services Corp.", status: "active" },
];

const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// Accounts (create or reset password)
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
const ids = {};
const passwords = {};
for (const a of ACCOUNTS) {
  passwords[a.key] = pw();
  const existing = list.users.find((u) => u.email === a.email);
  if (existing) {
    must(
      await admin.auth.admin.updateUserById(existing.id, { password: passwords[a.key] }),
      a.email,
    );
    ids[a.key] = existing.id;
  } else {
    const data = must(
      await admin.auth.admin.createUser({
        email: a.email,
        password: passwords[a.key],
        email_confirm: true,
        user_metadata: { full_name: a.name },
      }),
      a.email,
    );
    ids[a.key] = data.user.id;
  }
  must(await admin.from("profiles").update({ full_name: a.name }).eq("id", ids[a.key]), "profile");
  if (a.firmRole) {
    must(
      await admin.from("firm_memberships").upsert({ user_id: ids[a.key], role: a.firmRole }),
      "firm role",
    );
  }
}

// Clients, memberships, assignments, sample contacts
const clientIds = {};
for (const c of CLIENTS) {
  const found = must(
    await admin.from("clients").select("id").eq("code", c.code).maybeSingle(),
    c.code,
  );
  clientIds[c.code] = found
    ? found.id
    : must(await admin.from("clients").insert(c).select("id").single(), c.code).id;
}
must(
  await admin
    .from("client_memberships")
    .upsert(
      { client_id: clientIds["DEMO-A"], user_id: ids.owner, role: "client_owner" },
      { onConflict: "client_id,user_id" },
    ),
  "membership",
);
must(
  await admin
    .from("client_assignments")
    .upsert(
      { client_id: clientIds["DEMO-A"], user_id: ids.accountant, assignment_role: "preparer" },
      { onConflict: "client_id,user_id,assignment_role" },
    ),
  "assignment",
);
const { count } = await admin
  .from("client_contacts")
  .select("id", { count: "exact", head: true })
  .eq("client_id", clientIds["DEMO-A"]);
if (!count) {
  must(
    await admin.from("client_contacts").insert([
      {
        client_id: clientIds["DEMO-A"],
        full_name: "DEMO Maria Santos",
        position: "Finance Officer",
        email: "demo.maria@example.com",
      },
      {
        client_id: clientIds["DEMO-B"],
        full_name: "DEMO Jose Reyes",
        position: "Owner",
        email: "demo.jose@example.com",
      },
    ]),
    "contacts",
  );
}

const lines = [
  "DEV-ONLY DEMO ACCOUNTS (synthetic). Never use in production. Do not commit.",
  `Generated: ${new Date().toISOString()}  App: http://localhost:3000/login`,
  "",
  ...ACCOUNTS.map(
    (a) =>
      `${a.name.padEnd(20)} ${a.email.padEnd(30)} ${passwords[a.key]}   ${
        a.firmRole
          ? `(${a.firmRole}: two-step verification required at first sign-in)`
          : "(client portal: DEMO Sampaguita Trading)"
      }`,
  ),
  "",
  "Staff accounts must set up an authenticator app (Google/Microsoft Authenticator) on first sign-in.",
];
writeFileSync("dev-accounts.local.txt", lines.join("\n") + "\n");
console.log(`Seeded ${ACCOUNTS.length} demo accounts and ${CLIENTS.length} DEMO clients.`);
console.log("Credentials written to dev-accounts.local.txt (git-ignored).");
