# Phase 15 Report: Firm Operations

**Date:** 2026-10-18
**Status:** Submitted for review. **The SQL has NOT been applied yet** (§5).
**Gate:** *Clear ang accountability at status ng bawat transaction, return, at client submission.* (The accountability and status of every transaction, return and client submission is clear.)

How the gate is met:
- **Every return (filing):**
  - Each step is a separate status: preparation, review, approval, export and actual filing confirmation.
  - Each step stores who and when.
  - An append-only history keeps every change.
- **Every work item and client document request:** status, assignee or responder, reviewer or decider, and an append-only history.
- **Transactions:** intake and journal entries already carry their own statuses and actors (Phases 5–6). Work items can link to them.
- **Every sensitive action:**
  - It goes through a database function that checks the role and client assignment.
  - It is written to the audit trail and shown in the activity reports.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Staff work queues | `/work`: what waits on me (prepare or review), client responses to check, unassigned work, firm overdue (managers) |
| Client assignments | Existing assignments drive eligibility. Removing access releases the person's open work and notifies managers. |
| Submission deadlines, filing calendars | Firm deadline rules (cited, PENDING VERIFICATION until a second person verifies), client deadlines, retry-safe calendar generation, `/calendar` |
| Missing-document reminders | Document requests to the client, with responses, accept or return, and reminders |
| Reviewer approvals | Filing and work-item review by someone other than the doer (including managers) |
| Notifications | In-app inbox and header bell. Fixed templates, no financial details; the database refuses money-looking text. |
| Client service status | Manager-set status with reason and history |
| Activity reports | `/review/activity`: changed fields only, never values. Role-scoped; viewing is audited. |
| Reassignments, role changes | Managers only, reason required; claims only for unassigned items; access changes release work |
| Locked periods, corrections, exceptional workflows | Exception requests decided by a different manager and executed once. Filed returns are frozen; amendments are new filings. |
| Not "filed" because generated or downloaded | `filed` only by `confirm_filed` after `exported`, with date, channel, reference and proof. Outputs never touch filings. |

Details: [operations/FIRM-OPERATIONS.md](operations/FIRM-OPERATIONS.md)

**Change to earlier behaviour:**
- A firm manager can no longer reopen a locked period directly. It needs an approved exception request.
- The Periods page now links to that request.

## 2. Tests actually run (2026-10-18)

| Suite | Result |
|---|---|
| `npm run check` (format, lint, typecheck, tests, build, secrets) | **Pass: 32 files, 469 tests.** `operations.test.ts` was extended afterwards to 31 tests, all passing. |
| `tests/db/operations.test.ts` | **31/31** with TEST ONLY deadline rules |
| Mutation checks | Each of these makes tests fail: dropping the locked-period exception check, notification dedupe, "filed only after export", the exception maker-checker, work self-review, filing self-review |
| Cloudflare build | Builds. Worker **2,951 KiB** compressed (limit 3,072 KiB, about 120 KiB left) |
| **Live database tests** | **Not run.** They need the SQL applied first. |

**What the operations tests cover:**
- **Workflow transitions:**
  - every filing step in order
  - the return path
  - not required
  - amendment
  - work items: open → in progress → review → returned → done
  - document requests: open → submitted → returned → submitted → accepted
- **Permission boundaries:**
  - client users cannot see firm workflow
  - other clients' staff see nothing
  - only the preparer can mark a filing prepared
  - no self-review, even for managers
  - managers-only reassignment and service status
  - exception requester ≠ decider
  - activity reports by role
- **Retry behaviour:**
  - idempotent creation
  - repeated steps are no-ops
  - stale versions are refused
  - re-running the calendar adds nothing
  - re-running reminders sends nothing
  - an approved exception cannot be replayed
- **Deadline configuration:**
  - month offset
  - month-end clamp
  - weekend rule
  - fiscal-year quarters and years
  - skipped periods
  - source required
  - second-person verification

## 3. Before real use

1. Enter the firm's deadline rules with their sources, and have a second person verify each one.
2. Apply them to clients, then build the calendar.
3. Decide who sends reminders and when. A scheduled job can call `run_reminders` with the service role.

## 4. Not built

- E-mail or SMS delivery
- A reminder scheduler
- Holiday calendars
- Return payment tracking
- Client-facing service status

## 5. SQL to run (Supabase → SQL Editor), in order

After `0036`–`0041`:
1. `supabase/migrations/0042_operations_core.sql`
2. `supabase/migrations/0043_operations_functions.sql`

Note: `0043` references the tax workpaper and output tables (0038, 0040). Run 0036–0041 first.
