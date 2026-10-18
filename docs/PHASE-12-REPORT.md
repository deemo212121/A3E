# Phase 12 Report: Tax Rules and Computation Framework

**Date:** 2026-10-18
**Status:** Submitted for review. **The SQL has NOT been applied yet.** The owner runs it manually (§5).
**Gate:** *Bawat implemented computation ay may verified source at accountant-approved expected results* (every implemented computation has a verified source and accountant-approved expected results).
- **Met by construction:** the database refuses to approve, and therefore to run, any rule without a cited source attested by the approver, plus normal and boundary fixtures reviewed by a different accountant that all pass.
- **No real tax rule is implemented yet,** so no real computation exists. Every scenario is "unsupported" until the firm enters and approves rules.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Versioned registry: effective dates, eligibility, sources, formulas, rounding, approval status | `tax_rules` + `tax_rule_fixtures`, with a safe JSON formula language (no code), static validation, and immutable approved versions |
| Calculate only verified, approved scenarios | `compute_tax` uses only an approved version. Otherwise the result is **unsupported**, **not applicable** or **manual (professional) review**, with the reason recorded. |
| Tax adjustments separate from accounting profit | Ledger inputs come from posted entries; adjustments and manual inputs are stored apart with a reason and reference; nothing posts to the books (tested) |
| Lineage to source transactions | Every journal line behind each input is recorded, with links to the entry and source document |
| Taxpayer profiles and configurable obligations | Profile facts confirmed by a second person (plus the approved business profile); obligations per client and rule code. Nothing is assumed. |
| Sources, boundary tests, accountant-reviewed fixtures, regression across effective dates | Required for approval; `tax_regression` reruns all fixtures with the version in effect on each date |
| No fabricated rules | **The registry ships empty.** Templates contain placeholders only. |

**Screens:**
- **Tax rules registry** (firm-wide): list, rule detail (sources, definition, fixtures with pass/fail and review, regression, workflow), and a form to enter a rule.
- **Tax** tab per client: profile, obligations, input mappings to accounts, computations, and a computation page with inputs (books vs adjustments), outputs, lineage and review.

## 2. Tests actually run (2026-10-18)

| Suite | Result |
|---|---|
| `npm run check` | **Pass: 29 files, 424 tests** |
| `tests/db/tax.test.ts` | **10/10**, with **synthetic TEST ONLY rules** (made-up rates) |
| Mutation checks | Each of these makes tests fail: removing the reviewed-fixture requirement, approver ≠ author, the approved-only rule, fixtures-must-pass, or the configured-obligation check |
| Cloudflare build | Builds. Worker 2,899 KiB compressed (free-plan limit 3,072 KiB) |
| **Live database tests** | **Not run.** They need the SQL applied first. |

What the tests cover:
- **The approval gate:** sources, fixtures, reviews, attestation, a different approver, overlap.
- **Validation:** formulas that are refused.
- **Immutability.**
- **Boundaries:** half-centavo rounding; payable floored at zero; graduated-table edges (250,000 / 250,000.01 / 400,000 / 400,001).
- **Eligibility.**
- **Regression across two versions** on both sides of the change date.
- **Computation:** drafts excluded, a reversal netting out, adjustments kept apart, lineage, no change to the books, review by a different person, supersede, idempotency, immutability.
- **Not guessing:** unsupported (no rule, or a draft rule), not applicable, and manual review (profile not confirmed, missing fact, unmapped or missing input, rule changed within the period).
- **Isolation:** clients and other tenants see nothing.

## 3. Needed before any real computation

For each tax computation the firm wants:
1. The official issuance(s), cited with dates.
2. Worked expected results, including boundary cases, prepared by one accountant and reviewed by another.
3. Entry by a reviewer or manager; approval by a different one.

Candidates are listed in doc 08 and the roadmap's tax waves.

## 4. Not built

- Return forms and DAT files
- Filing
- Compliance calendar
- Carry-forwards between computations (use a documented manual input)

## 5. SQL to run (Supabase → SQL Editor), in order

1. `supabase/migrations/0036_tax_core.sql`
2. `supabase/migrations/0037_tax_functions.sql`

(Payroll `0030`–`0032` still show as not applied on the dev database; run them when ready.)
