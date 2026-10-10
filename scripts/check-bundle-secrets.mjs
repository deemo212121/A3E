#!/usr/bin/env node
/**
 * Fails if browser bundles (.next/static) contain privileged keys or the
 * names of server-only secret variables. Run after `next build`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const STATIC_DIR = join(process.cwd(), ".next", "static");

const FORBIDDEN = [
  { label: "Supabase secret key value", pattern: /sb_secret_[A-Za-z0-9_-]{8,}/ },
  { label: "SUPABASE_SECRET_KEY reference", pattern: /SUPABASE_SECRET_KEY/ },
  { label: "service_role JWT claim", pattern: /"role"\s*:\s*"service_role"/ },
  { label: "SUPABASE_SERVICE_ROLE reference", pattern: /SUPABASE_SERVICE_ROLE/ },
];

// Also flag the actual secret value if it is present in this environment.
if (process.env.SUPABASE_SECRET_KEY) {
  const escaped = process.env.SUPABASE_SECRET_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  FORBIDDEN.push({ label: "current SUPABASE_SECRET_KEY value", pattern: new RegExp(escaped) });
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs|json|map|html|txt)$/.test(name)) yield full;
  }
}

if (!existsSync(STATIC_DIR)) {
  console.error(`check-bundle-secrets: ${STATIC_DIR} not found. Run "npm run build" first.`);
  process.exit(2);
}

let scanned = 0;
const findings = [];
for (const file of walk(STATIC_DIR)) {
  scanned++;
  const text = readFileSync(file, "utf8");
  for (const { label, pattern } of FORBIDDEN) {
    if (pattern.test(text)) findings.push(`${label} in ${file}`);
  }
}

if (findings.length > 0) {
  console.error("check-bundle-secrets: FAILED");
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(`check-bundle-secrets: OK (${scanned} browser files scanned, no secrets found)`);
