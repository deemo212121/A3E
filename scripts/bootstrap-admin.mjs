#!/usr/bin/env node
/**
 * Creates the FIRST firm admin. Refuses if a firm admin already exists.
 *
 *   npm run bootstrap:admin -- person@firm.example
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and APP_BASE_URL in
 * .env.local (or the environment). Sends a Supabase invitation email when the
 * person has no account yet. Afterwards, all role changes happen in the app.
 * SQL-editor alternative: select private.bootstrap_firm_admin('person@firm.example');
 */
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

nextEnv.loadEnvConfig(process.cwd());

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: npm run bootstrap:admin -- person@firm.example");
  process.exit(2);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.");
  process.exit(2);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { count, error: countError } = await admin
  .from("firm_memberships")
  .select("user_id", { count: "exact", head: true })
  .eq("role", "firm_admin");
if (countError) throw new Error(`check existing admins: ${countError.message}`);
if ((count ?? 0) > 0) {
  console.error("A firm admin already exists. Use the application to manage roles.");
  process.exit(1);
}

let { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
if (!profile) {
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${base}/auth/confirm?next=/auth/set-password`,
  });
  if (error || !data.user) throw new Error(`invite: ${error?.message}`);
  profile = { id: data.user.id };
  console.log(`Invitation email sent to ${email}.`);
}

const { error: insertError } = await admin
  .from("firm_memberships")
  .insert({ user_id: profile.id, role: "firm_admin" });
if (insertError) throw new Error(`grant firm_admin: ${insertError.message}`);
console.log(
  `${email} is now the firm admin. They must enroll two-step verification at first sign-in.`,
);
