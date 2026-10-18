# Firm Operations (Phase 15)

**Status:** implemented 2026-10-18. Migrations `0042_operations_core.sql` and `0043_operations_functions.sql`.

## 1. What it covers

| Area | Where | Who |
|---|---|---|
| My work queue | `/work` | Firm staff |
| Filing calendar | `/calendar`, client **Operations** tab | Firm staff (assigned clients) |
| Deadline rules | `/deadlines` | Accountants and above propose; a reviewer or manager other than the author verifies |
| Filings (each return and period) | Operations → filing page | Preparer, reviewer, manager |
| Work items | Operations → work item page | Assigned staff |
| Missing-document requests | Operations (staff), **Requests** tab (client) | Staff request; client owner or staff respond |
| Notifications | `/notifications`, header bell | Each user sees only their own |
| Client service status | Operations | Firm managers set; assigned staff see |
| Exception requests | Operations (request), `/review/exceptions` (decide) | Accountants and above request; a different firm manager decides |
| Activity reports | `/review/activity` | Managers: all clients; reviewers: their clients; firm admins: firm-level events only |

## 2. Filing statuses

Each return has its own status for every step, with who and when:

`not started → in preparation → prepared → in review → approved → exported → filed`

- **Prepared:**
  - Only the assigned preparer can mark a filing prepared.
  - They either link a current workpaper of the same form and period, or describe how the return was prepared.
- **Review:**
  - The reviewer cannot be the preparer, and this includes managers.
  - A return to the preparer needs a note, and it clears the preparer's mark.
  - Approval needs a note. If a workpaper is linked, it must be signed off first.
- **Exported:** records how the return was produced:
  - entered in the official form tool
  - a manual form
  - a **validated** electronic output (Phase 14)
- **Filed:**
  - Recorded only by a filing confirmation, and only after the export step. The confirmation needs:
    - the actual filing date
    - the channel
    - the confirmation reference
    - where the proof is kept
  - **Generating or downloading a file never changes a filing's status.**
- **Not required:** a firm manager only, with the reason.
- **After filing:**
  - A filed return is frozen.
  - A real amendment is a new filing linked to the original.
  - A confirmation recorded in error is withdrawn only by an approved exception. The old values stay in the history.

## 3. Deadlines

- **No statutory deadline is built in.** A rule is firm configuration:
  - frequency (monthly, quarterly or annual, aligned to the client's fiscal year end month)
  - "day N of the month M months after the period ends", clamped to the month's last day
  - an optional weekend-to-Monday shift
  - periods with no filing
  - reminder days
- A tax-return rule needs its cited source (issuance and date).
- A rule stays **PENDING VERIFICATION**, and is flagged on every filing built from it, until a second person checks it against the source.
- **Holidays are not known.** A moved deadline is set through an approved due-date change.
- **Building the calendar:**
  - It creates the missing filings for a date range.
  - Running it again, or retrying it, creates nothing twice.
  - Manual filings record where their due date comes from.

## 4. Work, reassignment and access changes

**Work items:** open → in progress ⇄ waiting for client → in review → done. Cancelled is also possible.
- Items that need review close only by a reviewer other than the assignee, including when the assignee is a manager.
- Returning or cancelling an item needs a note.

**Reassignment:**
- Only firm managers reassign, and replacing a person needs a reason.
- Other staff may only claim an unassigned item.
- Assignees must be staff assigned to the client, or a manager. Reviewers must be reviewers or managers.

**Access changes** (assignment removed, role changed, account disabled):
- The person's open work items and filings become unassigned, and managers are notified.
- Steps already completed keep their names.

**Concurrency and retries:**
- Every status change carries the version the user saw. If someone else changed the item first, the user gets "changed by someone else; reload".
- Repeating a step that already happened changes nothing, e.g. a double-click or a retried request.
- Creating items and requests uses idempotency keys.

## 5. Notifications and reminders

**Notifications** are in-app only (no e-mail yet).
- They are built from fixed templates: client code, kind of item, form code, period and due date.
- They never include amounts, request text or other financial details.
- As a second safeguard, the database refuses a notification containing ₱ or money-looking numbers.
- Users see and clear only their own.

**Reminders:**
- `run_reminders` covers:
  - filings due within each rule's reminder days, due today, or overdue (weekly)
  - client requests due in 3 or 1 days, due today, or overdue (weekly)
  - work items due today or overdue
- Every reminder has a dedupe key per item, due date and day, so re-running or retrying sends nothing twice.
- It runs from the **Send today's reminders** button (managers, on `/work`), or from a scheduler using the service role. No scheduler is set up yet.

## 6. Locked periods and exceptions

**Locked periods:** reopening one needs an exception request.
- A firm manager **other than the requester** approves it, and approving carries it out at once.
- An approval works once and cannot be replayed.
- Locking still follows the Phase 5 rules.

**Exception kinds:**
- reopen a locked period (to soft-closed or open)
- change a filing's due date
- withdraw a filing confirmation recorded in error
- other (recorded decision only)

## 7. Activity reports

The report shows the audit trail:
- when, who, client, action and record
- **which fields changed, never their values**

Range: up to one year, newest 2,000 events. Opening a report is itself audited.

## 8. Not built

- E-mail or SMS delivery and a scheduled reminder job
- Holiday calendars
- Payment tracking for returns
- Client-facing service status
