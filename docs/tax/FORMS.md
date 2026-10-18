# BIR Forms and Supporting Schedules (Phase 13)

**Status:** framework implemented 2026-10-18.
- **No BIR form is defined.** The approved tax compliance matrix has not yet confirmed any form, and current official form versions have not been verified.
- Every form must be documented, verified and **signed off by an accountant** before production use.
- **There is no direct filing integration.** No authorized integration with eFPS/eBIRForms has been verified.

## 1. What must be documented for every form

The form definition holds each item, and the registry page shows it:

| Item | Where |
|---|---|
| Eligibility and applicable tax profile | `eligibility` (taxpayer facts) **and** a per-client obligation for the form code. Nothing is assumed for any client. |
| Official form version and effective date | `official_version`, `effective_from`/`effective_to`. A new BIR version is a new definition version. |
| Source fields and formulas | `definition.lines`: each line is a tax computation output or input (Phase 12, **reviewed** computations only), a taxpayer fact, a manual line (entered with a reason), or a formula over earlier lines in the Phase 12 safe expression language |
| Supporting schedules | `definition.schedules`: the posted entries and source documents behind a computation input |
| Rounding and reconciliation rules | the form's `rounding` (formula lines); `validations` (errors block sign-off; warnings are shown) |
| Review and approval workflow | see §2 |
| Export format and known limitations | `export_format` (CSV workpaper only) and `limitations` (required text) |
| Authoritative sources | `sources` (the official form, its instructions and issuances, with dates) |

## 2. Gates (enforced by the database)

1. **Verified (approve):**
   - sources are cited
   - at least one **normal** and one **boundary** regression fixture
   - every fixture is reviewed by an accountant other than its author, and all pass
   - approved by a reviewer or manager other than the author, who attests the check against the official form
2. **Enabled for production (documented accountant sign-off):**
   - a **firm manager** other than the author records a sign-off statement and where the evidence is kept
   - only **enabled** versions produce client workpapers

**Regression across versions:** `form_regression(code)` reruns every fixture of every version with the version in effect on the fixture's date.

## 3. Workpapers

- **Preparing:**
  - needs the form code configured as a client obligation for the whole period, and an enabled version in effect for the whole period
  - the client must be eligible; otherwise the result is *not applicable* or *unsupported*, with the reason recorded
- **Preview:** shows every line's value and **where it came from**:
  - the tax computation (and through it the journal lines and source documents)
  - the taxpayer fact
  - the manual entry and its reason
  - the lines a formula used
- **Editable where authorized:**
  - Manual lines and **overrides of source lines** need a reason.
  - An override is stored with the computed value it replaced, and flagged as a warning.
  - Formula lines cannot be overridden.
- **Validation messages:**
  - missing lines
  - lines using an **unreviewed** computation (an error)
  - the form's own validations
- **Sign-off:** a reviewer or manager other than the preparer, with a written statement, only when there are no errors.
- **Audit history:** an event log per workpaper, append-only entries, and the system audit log. Workpapers are never edited; preparing again supersedes the earlier one.
- **Export:** a CSV workpaper (lines, sources, messages, schedules, limitations), marked *not a filed return*.

## 4. Implemented forms

**None.** Each candidate form (doc 08) needs, before entry:
- confirmation in the approved compliance matrix
- the current official form and instructions
- the Phase 12 rules its lines depend on, approved
- worked fixtures from the firm's accountants
