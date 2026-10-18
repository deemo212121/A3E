# Production Operations Handbook

**For:** the firm owner, firm managers, reviewers, accountants and the technical admin.
**Version:** 2026-10-18 (Phase 18). Keep this file current: every process change here goes through a release (§11).

Related documents:
- deployment: `docs/deploy/PRODUCTION-DEPLOYMENT-PLAN.md`
- backups: `docs/runbooks/BACKUP-AND-RECOVERY.md`
- account recovery: `docs/runbooks/ACCOUNT-RECOVERY-AND-DISABLE.md`
- BIR update checklist: `docs/operations/BIR-UPDATE-CHECKLIST.md`

## 0. Roles at a glance

| Role | Can | Cannot |
|---|---|---|
| Firm admin (max 2) | Users, firm roles, invitations, client records (not their books) | See or change any client's accounting data (SoD-5) |
| Firm manager | Everything on all clients; lock periods; decide exceptions; enable tax outputs; reassign work | Approve their own work; decide their own exception requests |
| Reviewer | Approve and post on assigned clients; sign off workpapers and files; verify rules | Approve what they prepared |
| Accountant | Prepare entries, documents, computations, workpapers and filings on assigned clients | Approve or post |
| Bookkeeper | Prepare on assigned clients | Tax and filing steps |
| Client owner / staff / viewer | Their own business: submit records, upload, respond to requests, read posted statements | Anything of another business; the firm's internal workflow |

## 1. Firm and client onboarding

**New staff member:**
1. An admin invites them (Admin → Invitations, firm role).
2. They accept, set a password and enroll MFA.
3. A manager assigns clients (Review → Staff assignments).
4. Payroll access is a separate explicit grant.

**New client:**
1. A manager creates the client (Admin → Clients) and invites the client owner.
2. The client owner submits the business profile; a reviewer approves it.
3. A reviewer sets up the books:
   - chart of accounts template
   - fiscal year
   - sales, purchase and inventory settings
   - report mappings
4. On the client's Operations tab, a reviewer:
   - applies the firm's **verified** deadline rules
   - builds the filing calendar
   - sets the service status to *active*
5. Configure the tax profile, obligations and input mappings only for tax items whose rules are approved (§5).

## 2. Role and access management

- Change roles in Admin → Users. Nobody can change their own role, and the last admin cannot be removed.
- **Leavers, the same day:**
  - disable the account
  - remove their assignments
  - Their open work and filings become unassigned automatically and managers are notified. Reassign them on the work queue.
- **Monthly:** review users and assignments. **Quarterly:** review clients' team members and dashboard and provider access (plan §10).
- Exceptional actions use **Exception requests**, decided by a different manager:
  - reopen a locked period
  - change a due date
  - withdraw a filing confirmation
- Evidence of every change: **Review → Activity reports** (who, what, when; changed fields only).

## 3. Routine accounting operations (daily and weekly)

| Who | What | Where |
|---|---|---|
| Client | Records sales, purchases and expenses; uploads documents; answers requests | Portal → Transactions, Documents, Requests |
| Accountant | Reviews submissions; creates invoices, bills and receipts from approved intake; prepares journal entries | Staff → client → Intake, Sales, Purchases, Journal |
| Reviewer | Approves and posts (never their own); returns with a note | Review queue |
| Everyone | Works the **work queue** daily | My work queue |
| Manager | Sends today's reminders (until a scheduler is set up); checks overdue filings | My work queue → Overdue |

**Rules that never change:**
- Posted entries are immutable. Corrections are **reversals** plus new entries.
- Duplicate submissions are refused.

## 4. Month-end and year-end

**Month-end** (target: within 10 working days):
1. All intake for the month is approved or returned; no drafts or submitted entries remain.
2. Reconciliations are all zero difference:
   - AR (sales)
   - AP (purchases)
   - inventory (if used)
   - payroll (if used)
   - bank (the trial balance cash accounts against bank statements)
3. Review the trial balance, statements and aging.
4. A reviewer **soft-closes** the period. A manager **locks** it when the month's filings are done.
5. Tax work for the month:
   - compute, then a second person reviews
   - prepare the workpaper, then a second person signs it off
   - filing: prepared → reviewed → approved → exported → **filing confirmed** with reference and proof
6. Clients read the closed month's statements in the portal (client users see closed periods only).

**Year-end:**
1. All 12 months locked, after the last adjustments (adjusting entries need an open or soft-closed period; a locked one needs an approved exception).
2. Closing entry: a journal entry of type `closing`, prepared by an accountant and approved by a reviewer. Statements can include or exclude closing entries.
3. Open the next fiscal year (Periods).
4. Annual returns follow the filing calendar.
5. Archive: export the year's reports (CSV) and keep them under §12 retention.

## 5. Tax rule and form version updates

**Principle: a change never rewrites history.**

- **Versions:**
  - Approved rules, forms and file specifications **cannot be edited**.
  - A change is a **new version** with an `effective_from` date. The database numbers versions.
  - Approval is refused when two approved versions would overlap.
- **Ending the old version:**
  - A manager ends it on the day before the new one starts.
  - Refused if computations after that date already used the old version.
- **Old periods:**
  - Old periods keep using the version in effect for that period.
  - Every computation, workpaper and file records the rule, form or specification version it used, its inputs and its lineage.
- **No automatic recalculation:**
  - A rule change does **not** touch existing computations, workpapers, files or filings.
- **Deliberate recalculation:**
  - A person computes again, giving a reason in the work item.
  - The new result is reviewed by a second person.
  - The earlier result becomes **superseded**: kept, never deleted.
  - If a return was **already filed**, the filed record stays. Any correction is an **amended filing** (a new filing linked to the original), decided by a reviewer or manager.
- **Gates for every new version** (same as the first):
  - cited official source (issuance and date)
  - normal and boundary fixtures reviewed by an accountant who is not the author
  - approval by another person
  - **forms and files:** manager sign-off with evidence before they are enabled
- **After every change:** run the **regression** (§7).

## 6. DAT and electronic-file specification updates

1. Obtain the official technical specification (annex) and the validation module version. File names are part of the spec.
2. Propose a **new specification version**:
   - transcribe the layout field by field
   - set `official_tool` and its version
   - set `effective_from`
3. Add fixtures from the specification's own samples, plus boundary cases (lengths, codes, encoding, rounding, empty and duplicate cases).
4. Review, then approve (another person), then a manager **enables** it with compliance sign-off evidence.
5. **For each client file:**
   - generate
   - run the **official** module on the downloaded file
   - record its result and log
   - The file is valid only if the official check passed **for that exact file (SHA-256)** and our validation and reconciliation passed.
   - A different person signs it off.
6. A file generated under an older specification stays as it was. Regenerating supersedes it.

## 7. Regression testing after every compliance change

| Change | Run | Pass condition |
|---|---|---|
| New or changed tax rule version | Tax rules → rule → **Regression** (`tax_regression`) | Every fixture of every version passes with the version in effect on its date |
| New or changed form version | Tax forms → **Regression** (`form_regression`) | All fixtures pass |
| New or changed DAT specification | Specification → fixture results | All fixtures produce the exact expected bytes |
| Any code or SQL release | `npm run check` plus the live suites on staging | All green (§11) |
| Production after release | Readiness SQL + `scripts/smoke-production.mjs` | All PASS; REVIEW items accepted |

Record each run (date, item, result, who) in the change log (§11). **A failing regression blocks the change.**

## 8. Backup monitoring and recovery

- **Daily:** check that the Supabase backup exists (Database → Backups).
- **Weekly:**
  - firm-held `pg_dump` and Storage copy (runbook §2)
  - record the file names and sizes
- **Quarterly:** a restore drill into a scratch project (runbook §3–4). Record the date, the backup, the time taken and the result.
- **Before every release:** a fresh `pg_dump`.
- **Recovery:** runbook §3. Never restore over production; restore to a new project, verify, then switch.

## 9. Incident response and support escalation

| Level | Who | Handles | Response target |
|---|---|---|---|
| L1 | Firm manager on duty | User questions; access requests; failed uploads; "reference number" errors (look up the request id in the logs) | Same working day |
| L2 | Technical admin | App errors, outages, deploy and rollback, database issues | 4 working hours (outage: 1 hour) |
| L3 | Developer / vendor (Supabase or Cloudflare support) | Code defects, platform incidents | Per contract |
| Privacy | DPO | Possible personal-data breach: assess, then notify the NPC and data subjects within 72 hours when required | Immediately |
| Compliance | Firm accountant | Tax rule, form or file questions; BIR updates | Per §5–6 |

The incident steps are in plan §12 (detect, contain, assess, notify, recover, review), and rollback is in plan §13.

**Keep a contact sheet** (names, phones, provider account ids) in the password manager, not in Git.

## 10. Usage and cost monitoring

- **Monthly:**
  - Supabase usage (database size, storage, egress, MAU) against the plan
  - Cloudflare requests, CPU and errors
  - the bill against the estimate (plan §17)
- **Alerts:** 80% of quotas; Supabase spend cap on.
- **Weekly:**
  - error logs
  - Auth failures
  - the activity report for admin actions
  - the readiness SQL

## 11. Database migrations and releases

1. Every change is a numbered SQL file (`NNNN_name.sql`, ending with its own history insert) plus code, in Git.
2. Before release, run on staging:
   - `npm run check` (all tests, build, secret scan)
   - live suites (`npm run test:integration`, `npm run test:routes`)
   - readiness SQL
3. Release (plan §5):
   - backup
   - SQL in order
   - merge to `production`
   - smoke test
   - readiness SQL
4. **Release log entry:** date, commit, migration version, approver, test results, rollback point (the previous deployment and the backup file).
5. Never edit an applied migration. Fix forward with a new one.

## 12. Data export, retention and offboarding

- **Exports:**
  - reports and statements (CSV) per client
  - workpapers (CSV)
  - generated files (exact bytes)
  - documents (download)
  - a full database export by the technical admin (`pg_dump`, filtered to the client)
- **Retention:**
  - Books, supporting documents, audit trail: the statutory period. Current research: 5 years under RR 7-2024 (**PENDING VERIFICATION**). Keep 10 years until confirmed.
  - Logs: provider retention.
- **Client offboarding:**
  1. Set the service status to *offboarding*.
  2. Close or hand over open work.
  3. Export everything for the client and deliver it securely.
  4. Set the service status to *ended* and archive the client (status `archived`). Client users lose access; data is kept for the retention period.
  5. After the retention period, a manager and the DPO approve deletion. The technical admin removes the client's data and records it.
- **Staff offboarding:** §2.

## 13. Known limitations and future enhancements

See the handover report §4 and §6 (`docs/HANDOVER-REPORT.md`).

## Change log

| Date | Change | By |
|---|---|---|
| 2026-10-18 | First version (Phase 18) | Development |
