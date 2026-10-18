# Phase 13 Report: BIR Forms and Supporting Schedules

**Date:** 2026-10-18
**Status:** Submitted for review. **The SQL has NOT been applied yet.** The owner runs it manually (§5).
**Gate:** *Verified ang form computations at may documented accountant sign-off* (form computations are verified and have a documented accountant sign-off).
- **Met by construction:** a form cannot be used for client workpapers unless it is (1) verified, with cited official sources and accountant-reviewed normal and boundary fixtures that all pass, approved by someone other than its author; and (2) enabled by a firm manager's documented accountant sign-off.
- **No real BIR form is defined.** None is yet confirmed by an approved compliance matrix against current official sources. So no form is enabled, and every attempt is "unsupported".

## 1. What was built

| Requirement | Delivered |
|---|---|
| Only forms confirmed applicable | Form definitions start as drafts; per-client obligations and eligibility decide applicability. **The registry ships empty.** |
| Per form: eligibility, official version and effective date, source fields and formulas, schedules, rounding and reconciliation, workflow, export and limitations | All required fields of the definition, shown on the registry page ([tax/FORMS.md](tax/FORMS.md)) |
| Form previews | Workpaper page: each line, its value and its source |
| Editable workpapers where authorized | Manual lines and overrides of source lines, each with a reason and kept with the computed value; formula lines are always computed |
| Validation messages | Missing lines, unreviewed computations (errors block sign-off), the form's own validations, and override warnings |
| Audit history | Workpaper event log, append-only entries, system audit log; workpapers are never edited, only superseded |
| Line-to-source traceability | Line → reviewed tax computation → journal lines → source documents; supporting schedules list them |
| No assumption that every client needs every form | A form applies only where configured as the client's obligation and the client is eligible |
| No filing integration | CSV workpaper export marked "not a filed return" |
| Regression tests per form and version | Required fixtures, plus `form_regression` across versions |
| Accountant review before production | The enable step: firm manager, not the author, with a sign-off statement and evidence location |

**Screens:**
- **Tax forms registry:** list, definition with lines, schedules and validations, fixtures, regression, approve and enable workflow.
- **Form workpapers** on each client's Tax tab: prepare, preview with traceability, schedules, sign-off, history, CSV.

## 2. Tests actually run (2026-10-18)

| Suite | Result |
|---|---|
| `npm run check` | **Pass: 30 files, 433 tests** |
| `tests/db/forms.test.ts` | **9/9** with a **synthetic TEST ONLY** form and rule |
| Mutation checks | Each of these makes tests fail: allowing approved-but-not-enabled forms, skipping the fixture reviews, letting errors through sign-off, not flagging unreviewed computations, or letting non-managers enable |
| Cloudflare build | Builds. Worker 2,907 KiB compressed (free-plan limit 3,072 KiB) |
| **Live database tests** | **Not run.** They need the SQL applied first. |

What the tests cover:
- **Definition checks**, and the two gates.
- **Unsupported until enabled:** a form is unsupported until it is enabled.
- **Traceability:** each line traces to its computation; formula dependencies are recorded.
- **Sign-off:** an unreviewed computation blocks sign-off.
- **Schedule rows** tie to the posted entry.
- **Overrides:** they need a reason, are kept with the computed value, flow into formulas, and raise a warning. Formulas cannot be overridden.
- **Validation:** missing lines are errors; validation boundaries are tested, with credits equal to tax vs credits over tax by 0.01.
- **Eligibility:** ineligible clients get not applicable.
- **History and immutability.**
- **Regression across two versions.**
- **Isolation.**

**Test infrastructure change:** the test runner now uses at most 6 parallel workers. Each database test file runs its own in-memory Postgres, and the full run had started exhausting WebAssembly memory. No test changed.

## 3. Needed before any real form

For each form:
1. Confirm it in the tax compliance matrix.
2. Obtain the current official form and instructions.
3. Approve the Phase 12 rules its lines use.
4. Prepare and review fixtures with the firm's accountants.
5. Enter, verify, then sign off and enable.

## 4. Not built

- DAT/alphalist files
- Filing or payment integrations
- A printable replica of the official form layout (the preview is a line table)
- Compliance calendar

## 5. SQL to run (Supabase → SQL Editor), in order

After `0036`–`0037`:
1. `supabase/migrations/0038_forms_core.sql`
2. `supabase/migrations/0039_forms_functions.sql`
