#!/usr/bin/env node
/**
 * Production smoke test (read-only, anonymous). Uses no accounts and creates
 * no data, so it is safe against production.
 *
 *   node scripts/smoke-production.mjs https://app.example.ph production
 *
 * Checks: health and environment name, security headers and a fresh CSP nonce
 * per request, protected pages redirect to sign-in, APIs refuse anonymous
 * callers, unknown pages 404, HTTP redirects to HTTPS. Exit code 1 on failure.
 */
const [base, expectedEnv = "production"] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke-production.mjs <base-url> [expected APP_ENV]");
  process.exit(2);
}
const url = (p) => new URL(p, base).toString();
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const get = (p, init = {}) => fetch(url(p), { redirect: "manual", ...init });
const ZERO = "00000000-0000-4000-8000-000000000000";

try {
  const health = await get("/api/health");
  const body = await health.json().catch(() => ({}));
  check(
    "health 200 and ok",
    health.status === 200 && body.status === "ok",
    `${health.status} ${body.status}`,
  );
  check(`APP_ENV is ${expectedEnv}`, body.appEnv === expectedEnv, body.appEnv);

  const login = await get("/login");
  const h = login.headers;
  check("sign-in page 200", login.status === 200, String(login.status));
  const csp = h.get("content-security-policy") ?? "";
  check(
    "CSP with script nonce",
    /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/.test(csp),
    csp.slice(0, 80),
  );
  check(
    "CSP blocks framing and plugins",
    csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"),
  );
  check("CSP has no unsafe-eval", !csp.includes("unsafe-eval"));
  const csp2 = (await get("/login")).headers.get("content-security-policy") ?? "";
  check("fresh nonce per request", csp2 !== csp && csp2.length > 0);
  check(
    "HSTS",
    /max-age=\d{7,}/.test(h.get("strict-transport-security") ?? ""),
    h.get("strict-transport-security") ?? "missing",
  );
  check("X-Frame-Options DENY", h.get("x-frame-options") === "DENY");
  check("nosniff", h.get("x-content-type-options") === "nosniff");
  check("no X-Powered-By", !h.get("x-powered-by"));
  check(
    "pages not cached",
    /no-store/.test(h.get("cache-control") ?? ""),
    h.get("cache-control") ?? "",
  );

  for (const p of ["/app", "/staff", "/admin", "/work", "/review/activity"]) {
    const r = await get(p);
    const loc = r.headers.get("location") ?? "";
    check(
      `${p} redirects to sign-in`,
      [302, 303, 307, 308].includes(r.status) && loc.includes("/login"),
      `${r.status} ${loc}`,
    );
  }
  for (const p of [
    `/api/reports/${ZERO}`,
    `/api/outputs/${ZERO}`,
    `/api/workpapers/${ZERO}`,
    `/api/documents/${ZERO}`,
  ]) {
    const r = await get(p);
    check(
      `${p.replace(ZERO, ":id")} refuses anonymous`,
      [401, 403, 404].includes(r.status) || r.headers.get("location")?.includes("/login"),
      String(r.status),
    );
  }
  const missing = await get("/this-page-does-not-exist");
  check("unknown page 404", missing.status === 404, String(missing.status));

  if (base.startsWith("https://")) {
    const plain = await fetch(base.replace(/^https:/, "http:"), { redirect: "manual" }).catch(
      () => null,
    );
    const loc = plain?.headers.get("location") ?? "";
    check(
      "HTTP redirects to HTTPS",
      plain && [301, 302, 307, 308].includes(plain.status) && loc.startsWith("https://"),
      `${plain?.status} ${loc}`,
    );
  }
} catch (error) {
  check("site reachable", false, error.message);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
