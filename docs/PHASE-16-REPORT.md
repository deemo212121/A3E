# Phase 16 Report: Security Hardening and End-to-End Testing (Release-Blocker Report)

**Date:** 2026-10-18
**Gate:** *Walang unresolved critical security issue o accounting mismatch.* (No unresolved critical security issue or accounting mismatch.)

**Verdict:**
- **Automated gate: met.**
  - One **critical** security issue was found in this phase and fixed (§3, F-1).
  - Every **high** issue found was fixed or is not reachable through the product.
  - No accounting mismatch was found.
- **Not yet releasable to real client data.** The open blockers in §5 must be closed first.
- **Do not deploy** this code until the SQL in §7 has been applied, in order.

> **Scope of this assurance.** Everything here is **automated testing and code review by the development team**.
> - **No independent penetration test** has been performed.
> - **No professional security or accounting audit** has been performed.
> - **No external compliance review** has been performed.
>
> These are recommended before handling real client data at scale (§5, B-6).

## 1. What was tested

| Area | How | Result |
|---|---|---|
| **Complete lifecycle** | `tests/db/e2e-lifecycle.test.ts` (9 steps): client submits a sale → staff review → approval → invoice → posting → receipt → TB, statements and AR reconciliation → tax computation from the ledger, reviewed → regression → form workpaper signed off → export file generated, validated for that exact file, reconciled, signed off → filing prepared, approved, exported, confirmed | **Pass.** Every step is retried; nothing is duplicated. |
| Cross-tenant RLS and direct API access | Catalog checks on every table; `tenant-isolation.test.ts`; isolation checks in every module suite; live `cross-tenant.api.test.ts` (real PostgREST) | PGlite: **pass**. Live: **not run this phase** (§5, B-3). |
| Role and privilege escalation | **Every** public function (over 150) called by a user with no role, with a full row-count check of all tables; client users against staff and admin functions | **Pass**, after fixing F-1 |
| Authentication and session | MFA enforcement path (kept ON in tests), disabled accounts, open-redirect protection, session cookie flags, CSP; one real browser sign-in | **Pass**, after hardening (F-4, F-5) |
| File upload | `documents.test.ts` (16) and `files.test.ts`: content sniffing, renamed executables, macro Office files, zip bombs, size limits, server-fixed paths, same-tenant reads only, hash checks | **Pass** (existing coverage, re-run) |
| Input validation and injection | SQL-looking and script payloads stored literally with no side effects; enum and type domain checks; the tax formula language refuses unknown operators, undeclared inputs, missing params, huge numbers and deep nesting; dynamic SQL reviewed (only fixed table names via `%I`) | **Pass**, after F-3 |
| Duplicate submission and retry | Idempotency keys (all unique, catalog-checked); retries at every lifecycle step; stale-version conflicts | **Pass** |
| Accounting balancing and reconciliation | Every posted entry balances (DB invariant, re-checked); TB debits = credits; statements equal the TB; AR subledger = ledger; output totals = source; workpaper = computation | **Pass**. No mismatch. |
| Tax regression | `tax_regression` and `form_regression` over reviewed fixtures; synthetic rules only | **Pass** (no real rules exist, §5, B-5) |
| DAT validation | **No supported outputs exist:** no BIR layout has been obtained, so none is shipped. Tested on a synthetic layout: exact bytes, SHA-256, the official-tool result tied to the exact file, reconciliation. | Framework **pass**. Real DAT: **not testable yet.** |
| Concurrent posting and integrity | Row locks and unique constraints reviewed; per-client entry numbering is unique; the live suites race parallel requests | PGlite cannot run in parallel. Live: **not run this phase** (B-3). |
| Performance and queries | `resilience.test.ts`: 6,000 posted entries, timed reads under RLS, plans checked for index use; catalog scan of unindexed foreign keys | **Fixed** a slow ledger policy (F-6). Indexes added. |
| Error handling and logging | Generic public errors with request ids (`toPublicError`); log redaction tests; `no-store` on API responses | Pass (existing tests) |
| Backup and restore | Offline drill: full copy restored into a new instance; books, audit trail, migration version and controls identical | Offline **pass**. Real platform: **not drilled** (B-4). |
| Dependencies and configuration | `npm audit` (production 0; build tooling 9 high, F-9); secrets only in ignored files or dashboards; bundle secret scan; security headers | Pass, with accepted items |

**Totals:**
- `npm run check`: **38 test files, 506 tests, all passing**, plus format, lint, typecheck, production build and the secrets scan.
- New suites: e2e-lifecycle 9, security-audit 14, resilience 5, migrations 3 (order, gaps, applies without payroll), CSP 3, cookies 2.
- Mutation checks: reverting each fix makes its test fail (F-1, F-2, F-5 sequences).

## 2. Measured performance (PGlite, order of magnitude only)

| Read (10,000 journal lines, under RLS) | Before | After F-6 |
|---|---|---|
| Trial balance | 1,427 ms | **19 ms** |
| General ledger (one account, full year) | 823 ms | **95 ms** |
| Statement balances | 1,180 ms | **28 ms** |
| Journal list (100 rows) | 13 ms | 2 ms |

Backup copy of the test database: 132 MB, copied in about 0.1 s and restored in about 0.7 s. **This is not a production load test.**

## 3. Findings and status

| ID | Severity | Finding | Status |
|---|---|---|---|
| **F-1** | **Critical** | **Activity report readable by anyone signed in.** `ops_activity_report` (Phase 15) checked access with `not (role = manager or …)`. With **no** firm role that is NULL, and `if NULL` does not raise. **Any signed-in user could read any client's activity report** (who did what, when, field names; no values). | **Fixed in 0044.** NULL-safe check; regression test across 7 personas × 2 clients. 0043 has never been applied, so no exposure occurred. |
| F-2 | High (not reachable via the API) | **Guard bypass via a session setting.** The maintenance setting `app.purge` turned off immutability guards for any session that could run `set_config`. API users cannot call it through PostgREST, but a direct database session as an end user could (e.g. to save a draft on an inactive account). | **Fixed in 0044.** The switch now works only without an end-user identity. Probe test added. |
| F-3 | Low | NULL-unsafe checks: `delete_document` (orphaned uploader edge case) and `tax_check` (`{"op": null}` passed validation) | **Fixed in 0044** |
| F-4 | Medium | **No Content-Security-Policy.** | **Fixed.** Per-request nonce CSP in the proxy: scripts only with the nonce, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`. Verified in Chromium with no violations, all scripts carrying the nonce, and sign-in working. |
| F-5 | Medium | **Session cookies readable by JavaScript.** The browser Supabase client was unused. | **Fixed.** Cookies are `HttpOnly; SameSite=Lax; Secure` (production); the unused browser client was removed. Verified after a real sign-in. |
| F-5b | Low | Identity sequences kept the platform's default `USAGE` grants for anon and authenticated | **Fixed in 0044.** Catalog test added. |
| F-6 | Medium | **Ledger reads slow at volume.** The journal RLS policies ran several lookups **per row**, so reads grew linearly. | **Fixed in 0044.** Same rules, evaluated once per query (about 75× faster). All isolation tests unchanged and passing. |
| F-7 | Low | 18 parent-to-child foreign keys had no index (line, allocation and row tables) | **Fixed in 0044.** Remaining unindexed FKs are "who" columns (`created_by`, etc.). Low impact; left. |
| F-8 | Low (not reachable via the API) | The payroll recompute switch (`app.payroll_compute`) could be forged by a direct database session as an end user | **Accepted.** Same reachability as F-2 before its fix. Revisit if direct database access is ever given to users. |
| F-9 | Low | `npm audit`: 9 high in **build and lint tooling only** (`braces` pattern DoS, `glob` CLI flag). Production dependencies: 0. The suggested fixes are downgrades. | **Accepted.** Re-check on each tooling update. |
| F-10 | Medium | Other client tables still use per-row `is_assigned()` in RLS (lower volume than the ledger) | **Open, follow-up.** Apply the F-6 pattern if those tables grow. |
| F-11 | Low | No application-level rate limiting on actions. Sign-in relies on Supabase Auth limits. | **Accepted for beta.** Revisit before public launch. |
| F-12 | Low | During this phase, the local demo owner password was shown in the developer's tool output | **Rotate** the demo accounts' passwords. Dev-only accounts. |

## 4. Accounting integrity

- Unbalanced posting is impossible: a deferred database invariant checks every posted entry, and the lifecycle re-checks it.
- **No mismatch** between ledger, trial balance, statements, AR subledger, tax computation, workpaper and generated file in the end-to-end month.
- **Known accepted limits** (documented in earlier phases; still pending sign-off):
  - accountant sign-off of the accounting test scenarios
  - the inventory costing method (PENDING VERIFICATION)
  - the payroll tables (none shipped)

## 5. Open release blockers (before real client data)

| ID | Blocker | Owner | How to close |
|---|---|---|---|
| **B-1** | **Apply SQL 0036 to 0044, in order** (§7). The deployed code needs these tables. Without them, pages for tax, forms, outputs, operations and notifications fail. | You | Run the files in the Supabase SQL Editor. Confirm with `select max(version) from supabase_migrations.schema_migrations` = `0044`. |
| **B-2** | **Staff MFA is OFF** (beta decision, 0034). With real client data, staff must use MFA. | Firm decision | Run `update private.settings set value = 'true'::jsonb where key = 'require_staff_mfa';` once staff have enrolled. |
| **B-3** | **Live suites not run this phase:** cross-tenant API, live accounting concurrency, intake live, route access. They prove isolation and parallel posting on real PostgREST and Postgres. | You (manual) | After B-1, against the **dev** project: `npm run test:integration` and `npm run test:routes`. |
| **B-4** | **No backup or restore drill on the real platform.** Free-plan Supabase has no downloadable backups, and Storage is not in database backups. | Firm | Choose the plan, set up backups, then do one restore drill per `docs/runbooks/BACKUP-AND-RECOVERY.md`. |
| **B-5** | **Compliance content not present:** no verified tax rules, BIR forms, DAT layouts or deadlines are shipped (by design: nothing invented). The platform cannot yet produce a real return or DAT file. | Firm accountant | Enter, verify and sign off each item through the gates (Phases 12–15). This blocks compliance claims, not the beta. |
| **B-6** | **No independent penetration test or professional audit** | Firm | Commission one before production use with real taxpayer data |
| B-7 | Rotate the demo account passwords (F-12) | You | Re-run `scripts/seed-dev-accounts.mjs`, or change them in Supabase Auth |

**Not blockers** (closed in this phase): F-1 to F-7.

## 6. Files

- **Migration:** `supabase/migrations/0044_security_hardening.sql` (F-1, F-2, F-3, F-5b, F-6, F-7)
- **Tests:**
  - `tests/db/e2e-lifecycle.test.ts`
  - `tests/db/security-audit.test.ts`
  - `tests/db/resilience.test.ts`
  - `src/lib/security/csp.test.ts`
  - `src/lib/supabase/cookies.test.ts`
- **App:**
  - `src/lib/security/csp.ts`, `src/proxy.ts` (CSP)
  - `src/lib/supabase/cookies.ts` (cookie flags)
  - `src/app/layout.tsx` (pages render per request, needed for the CSP nonce)
  - `src/lib/supabase/browser.ts` removed
- **Docs:** `docs/runbooks/BACKUP-AND-RECOVERY.md`, this report

## 7. SQL to run (Supabase → SQL Editor), in order

1. `0036_tax_core.sql`
2. `0037_tax_functions.sql`
3. `0038_forms_core.sql`
4. `0039_forms_functions.sql`
5. `0040_eoutputs_core.sql`
6. `0041_eoutputs_functions.sql`
7. `0042_operations_core.sql`
8. `0043_operations_functions.sql`
9. **`0044_security_hardening.sql`** (must follow 0043: it fixes F-1)

Payroll (`0030`–`0032`) remains optional, as before.
