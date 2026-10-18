# Phase 5 Report — Core Double-Entry Accounting Engine

**Date:** 2026-10-10
**Status:** Submitted for review. **No tax computations were built.** The next phase starts only on the owner's instruction. (Sending the Phase 5 instruction was taken as approval of Phase 4.)
**Gate:** debits and credits, trial balance, reversals and duplicate prevention are correct. **All balancing and duplicate-posting tests pass (§3).** None failed, so the "stop" condition did not trigger.

## 1. Two caveats up front

1. **"Approved chart of accounts":** none had been approved. A generic starter chart was seeded as data and marked **PROPOSED** ([accounting/COA-TEMPLATE-PROPOSED.md](accounting/COA-TEMPLATE-PROPOSED.md)). The engine is chart-agnostic.
2. **"Accountant-reviewed expected results":** the scenario results were computed by hand and hard-coded in the tests, but **no accountant has reviewed them yet**. They are written up for sign-off in [accounting/TEST-SCENARIOS.md](accounting/TEST-SCENARIOS.md), together with the policy defaults D-08 and D-10.

## 2. Delivered

| Requirement | How it is enforced (in the database unless noted) |
|---|---|
| Chart of accounts | `accounts` per client (type, normal balance, header/postable, active), unique codes, parent hierarchy; templates (`apply_coa_template`). Code, type and normal balance are frozen once an account is used. Accounts are never deleted (deactivate instead). |
| Accounting periods and status | `fiscal_years` (no overlaps; gapless entry counter) and monthly `accounting_periods` with status **open → soft_closed → locked**. Locking and reopening are manager-only; reopening needs a reason; locking is refused while drafts or submitted entries exist. |
| Journal entries and lines | Workflow `draft → submitted → posted (→ reversed)` or `void`, through checked SECURITY DEFINER functions only. API users have **no** direct write grants. |
| **Every posted entry balances** | Checked at submit and post, **plus** a deferred constraint trigger that re-verifies Σdebit = Σcredit > 0 and ≥ 2 lines at **COMMIT**, even against superuser SQL |
| Atomic posting | Each posting runs in a single transaction: entry row lock, period share-lock, fiscal-year counter lock, number assignment and status change all commit together or not at all |
| **Duplicate prevention** | Idempotency key unique per client, with an atomic insert-or-return under concurrent requests; **one live entry per source document** (`source_type` + `source_ref`); `approve_and_post` is idempotent (returns the same number); one reversal per entry (UNIQUE) |
| Account ownership, period status, posting permissions | Composite FKs (line, account and entry all belong to the client). Line guard: active, postable accounts. Period checks for each entry type. Roles: preparers (manager, reviewer, accountant, bookkeeper; assigned), approvers (manager, reviewer; assigned). Maker-checker. |
| Restrict modification of posted records | Triggers block any update or delete of posted, reversed or void entries and their lines. The only allowed change is posted → reversed. |
| Controlled reversals and adjustments | `reverse_entry`: mirror lines, dated in an open or soft-closed period, both entries linked, idempotent, at most once, a reversal cannot itself be reversed. `adjusting` entries are allowed in soft-closed periods. |
| Links to source transactions | `source_type` / `source_ref` on every entry; reversals link `reverses_entry_id` ↔ `reversed_by_entry_id` |
| General ledger and trial balance | `general_ledger()` (opening balance + running balance) and `trial_balance()` as-of date, both SECURITY INVOKER (RLS applies). Amounts are returned as **exact text**, never JSON floats. |
| Audit history | Append-only `audit.events`: row-level triggers on all 5 ledger tables plus events (`journal.submitted/returned/posted/voided/reversed`, `period.status_changed`, `coa.template_applied`) |
| Ledger visibility | Assigned staff see everything; client users see **posted/reversed only**; other tenants and the firm admin see nothing (SoD-5) |
| Staff UI | `/staff/clients/[id]/` **journal** (list and create), **journal/[entry]** (submit, approve, return, void, reverse, edit draft), **trial-balance**, **ledger**, **accounts**, **periods**; review queue now shows real submitted entries. All are added to the shared route policy and navigation tabs. |

**Migrations (all applied to the dev project; `db lint` clean):**
- `0005_accounting_core`
- `…0006_accounting_functions`
- `…0007_coa_template_proposed`
- `…0008_fix_create_fiscal_year_lint`
- `…0009_save_draft_concurrent_idempotency`
- `…0010_fix_purge_order`
- `…0011_fix_purge_reversals`
- `…0012_ledger_reads_as_text`

## 3. Tests actually executed (2026-10-10)

| Suite | Environment | Result |
|---|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | Local | **Pass:** 14 files, **207 tests** |
| **Deterministic accounting tests** (`tests/db/accounting-engine.test.ts`) | PGlite (Postgres 18) | **53/53**: S1 trial balance and GL, S2 reversal and correction, duplicates, balancing, immutability (including superuser), SoD and permissions, periods, visibility, audit, purge |
| **Live accounting suite** (`tests/integration/accounting.live.test.ts`) | **Real Supabase (Postgres 17)** | **9/9**, including **true concurrency**: 10 parallel approvals → posted once; 8 parallel postings → numbers 9..16 with no gaps; 6 parallel same-key saves → 1 entry; 5 parallel reversals → 1 reversal |
| Live route-access suite (now including ledger pages) | Production build + real sessions | **24/24**, including real posted data (123,456.78) rendering on the journal, entry, trial balance and ledger pages, and not-found/forbidden for other tenants |
| Phase 3 cross-tenant API suite (regression) | Real Supabase | **31/31** |
| Mutation checks | PGlite | Removing the balance checks lets an unbalanced entry post; removing idempotency lets a replay duplicate. **Both outcomes observable, so the tests guard real behaviour.** The probe files were deleted. |
| Cleanup | Real Supabase | 0 test clients, 0 test users, 0 journal entries left (only your DEMO clients remain) |

## 4. Problems found and fixed during this phase

| Problem | Found by | Fix |
|---|---|---|
| The deferred balance check could run as the API user and count lines **through RLS** | Design review before testing | Integrity trigger functions run as SECURITY DEFINER |
| Concurrent saves with the same idempotency key: one caller got an error (no duplicate was created) | Concurrency design review | Atomic `insert … on conflict do nothing` + return (migration 0009); proven live with 6 parallel requests |
| Test-data purge failed: FK checked before cascaded lines were deleted; then a rewrite violated maker-checker on reversals | **Live suite cleanup** (left data behind) | Explicit leaf-first deletes (0010, 0011). The PGlite purge test now includes a reversal and was shown to **fail without the fix**. Leftovers purged. |
| JSON numbers for money (floats in JavaScript) | Design review | Read models return text (0012); the UI uses BigInt centavos |
| `route-policy.ts` was corrupted by my own edit script (`$` patterns in JS `replace`) | Typecheck / format | File rewritten from the known-good version; policy tests 45/45 |
| Route-test classifier truncated `staff.trial_balance` (regex without `_`) | Live route suite | Regex fixed (test bug, not an access bug) |
| Stale `tsconfig.tsbuildinfo` after raising the TS target to ES2022 (BigInt) | Typecheck | Cache cleared |

## 5. Not done, limitations and risks

| Item | Status |
|---|---|
| Accountant sign-off of the scenarios, the chart, and D-08/D-10 | **Pending** ([accounting/TEST-SCENARIOS.md](accounting/TEST-SCENARIOS.md)) |
| Tax computations, BIR forms | Not built (as instructed) |
| Year-end closing entries (revenue/expense → retained earnings) and financial statements | Not built. The `closing` entry type exists, but automated closing belongs to the reporting phase. |
| Client-portal ledger and reports view | Not built. RLS already allows client users read access to posted data. |
| Bulk import, subledgers (sales/purchase registers), document links | Later phases. The source links are in place (`source_type`/`source_ref`). |
| **Production setting:** `private.settings.allow_synthetic_purge` is `true` (dev). **It must be set to `false` in production** (deployment checklist). The purge only accepts `ZZTEST-` clients and is executable only by the service role. | Open item |
| Multi-currency | Not supported (PHP only, as assumed in doc 12) |
| Browser click-through tests of the entry form | Not added. Server, database and HTTP layers are tested. |

## 5a. Addendum (2026-10-10): aligning with the Firm's real books

Done at the owner's request after reviewing one client's workbooks ([accounting/FIRM-WORKBOOK-REVIEW.md](accounting/FIRM-WORKBOOK-REVIEW.md)). **No tax computation was added.**

| Change | Where |
|---|---|
| 20 accounts added to the PROPOSED starter chart (now 57): petty cash fund, advances to employees, raw materials, payroll liabilities by agency, employee loans payable, VAT payable placeholder, purchases, employer contributions, benefits, repairs, fuel, transportation, communication, taxes and licenses, meals, representation | Migration `0014`; [COA-TEMPLATE-PROPOSED.md](accounting/COA-TEMPLATE-PROPOSED.md) |
| Optional **supplier/customer name, TIN and receipt/invoice no.** on each journal line. The TIN is format-checked (9 digits + optional 3–5 digit branch code) and stored in dashed form. A TIN requires a name. The fields freeze on posting (existing line guard), are copied into reversals, and are returned by `general_ledger`. | Migration `0013`; entry form (optional per-line details), entry page, ledger page |
| **Scenario S3**: one synthetic month in the Firm's format (CDJ, CRJ, two payrolls, petty cash, a reversed duplicate) with a hard-coded trial balance | `tests/db/business-month.test.ts`; [TEST-SCENARIOS.md](accounting/TEST-SCENARIOS.md) |

**Tests run 2026-10-10:**
- `npm run check` passes: 15 files, **217 tests** (S3 adds 10).
- Live accounting suite **10/10** on real Supabase; the new test round-trips the fields through the API, checks TIN normalization and rejection, and checks that the fields are invisible to another client.
- Live integration **42/42**; live routes **24/24**.
- Mutation check: removing the field copy from `reverse_entry` makes 2 S3 tests fail.
- Both migrations are applied to the dev project; `supabase db lint` reports no errors. The dev DB is clean (DEMO-A and DEMO-B only; 0 temporary users).

## 6. Acceptance criteria

- [x] Every posted journal entry balances: function checks **and** a commit-time constraint, proven against superuser SQL
- [x] Atomic posting in database transactions; concurrency proven live
- [x] Duplicate posting prevented: idempotency keys, source references, idempotent approval, single reversal; proven live under parallel load
- [x] Account ownership, period status and posting permissions validated
- [x] Posted records cannot be modified; corrections via reversal and adjustment entries
- [x] Links from entries to source transactions preserved
- [x] Append-only audit events
- [x] Deterministic automated accounting tests with hard-coded expected results
- [x] No tax computations
- [ ] **Accountant review of the expected results (S1–S3), the chart of accounts and D-08/D-10**, plus the 7 workbook questions in FIRM-WORKBOOK-REVIEW.md §3
- [ ] Owner approval of this report
