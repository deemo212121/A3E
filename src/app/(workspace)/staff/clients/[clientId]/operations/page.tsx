import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, PageSkeleton, Section, StatCard } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { opsClientAction } from "@/features/operations/actions";
import {
  EXCEPTION_KINDS,
  OpsBadge,
  OverdueBadge,
  SERVICE_STATUSES,
  WORK_KINDS,
  who,
} from "@/features/operations/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { listFiscalYears } from "@/server/data/ledger";
import {
  eligibleStaff,
  listClientDeadlines,
  listDeadlineRules,
  listDocumentRequests,
  listExceptions,
  listFilings,
  listServiceStatus,
  listWorkItems,
  staffNames,
} from "@/server/data/operations";

export const metadata: Metadata = { title: "Operations" };

const CATEGORIES = [
  "",
  "sales_invoice",
  "official_receipt",
  "purchase_invoice",
  "expense_receipt",
  "bank_statement",
  "certificate_2307",
  "payroll",
  "registration",
  "other",
];

export default function OperationsPage({
  params,
}: PageProps<"/staff/clients/[clientId]/operations">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Operations params={params} />
    </Suspense>
  );
}

async function Operations({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage(
    "staff.operations",
    { clientId },
    "Operations",
    async ({ access, client }) => {
      const c = client.id;
      const [filings, work, requests, exceptions, status, deadlines, rules, names, staff, years] =
        await Promise.all([
          listFilings({ clientId: c }),
          listWorkItems({ clientId: c }),
          listDocumentRequests(c),
          listExceptions({ clientId: c }),
          listServiceStatus(c),
          listClientDeadlines(c),
          listDeadlineRules(),
          staffNames(),
          eligibleStaff(c),
          listFiscalYears(c),
        ]);
      const manager = hasFirmRole(access, ["firm_manager"]);
      const reviewer = hasFirmRole(access, ["firm_manager", "reviewer"]);
      const preparer = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
      const today = new Date().toISOString().slice(0, 10);
      const year = today.slice(0, 4);
      const openFilings = filings.filter((f) => !["filed", "not_required"].includes(f.status));
      const overdue = openFilings.filter((f) => f.due_on < today);
      const openWork = work.filter((w) => !["done", "cancelled"].includes(w.status));
      const openRequests = requests.filter((r) =>
        ["open", "returned", "submitted"].includes(r.status),
      );
      const ruleById = new Map(rules.map((r) => [r.id, r]));
      const staffOptions = [
        { value: "", label: "— none —" },
        ...staff.map((s) => ({ value: s.user_id, label: s.label })),
      ];
      const reviewerOptions = [
        { value: "", label: "— none —" },
        ...staff
          .filter((s) => s.role === "firm_manager" || s.role === "reviewer")
          .map((s) => ({ value: s.user_id, label: s.label })),
      ];
      const lockedPeriods = years.flatMap((y) => y.periods).filter((p) => p.status === "locked");
      const hidden = (op: string) => (
        <>
          <input type="hidden" name="clientId" value={c} />
          <input type="hidden" name="op" value={op} />
        </>
      );

      return (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Service status"
              value={status[0] ? <OpsBadge status={status[0].status} /> : "not set"}
            />
            <StatCard label="Open filings" value={openFilings.length} />
            <StatCard label="Overdue filings" value={overdue.length} />
            <StatCard
              label="Open requests / work"
              value={`${openRequests.length} / ${openWork.length}`}
            />
          </div>

          <Section title="Filing calendar">
            <Alert tone="info" title="A return is filed only when a filing is confirmed">
              Preparation, review, approval, export and filing are separate steps, each recorded
              with who and when. Generating or downloading a file never marks a return as filed;
              that needs the actual filing date, the confirmation reference and where the proof is
              kept.
            </Alert>
            <DataTable
              caption="Filings"
              rows={filings}
              rowKey={(f) => f.id}
              empty="No filings yet. Set the client's deadlines below, then build the calendar."
              columns={[
                {
                  header: "Return",
                  cell: (f) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.filing", { clientId: c, itemId: f.id })}
                    >
                      {f.form_code}
                      {f.amends_id ? " (amended)" : ""}
                    </Link>
                  ),
                },
                {
                  header: "Period",
                  kind: "nowrap",
                  cell: (f) => `${f.period_from} – ${f.period_to}`,
                },
                {
                  header: "Due",
                  kind: "nowrap",
                  cell: (f) => (
                    <span className="flex flex-wrap items-center gap-1">
                      {f.due_on}
                      <OverdueBadge
                        due={f.due_on}
                        closed={["filed", "not_required"].includes(f.status)}
                      />
                      {f.rule_id && ruleById.get(f.rule_id)?.status === "pending_verification" ? (
                        <OpsBadge status="pending_verification" />
                      ) : null}
                    </span>
                  ),
                },
                { header: "Status", cell: (f) => <OpsBadge status={f.status} /> },
                { header: "Preparer", hideOnMobile: true, cell: (f) => who(names, f.preparer_id) },
                { header: "Reviewer", hideOnMobile: true, cell: (f) => who(names, f.reviewer_id) },
              ]}
            />
            {preparer ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">Build the calendar</summary>
                <ActionForm action={opsClientAction} submitLabel="Create missing filings">
                  {hidden("generate_calendar")}
                  <Field
                    label="From"
                    name="from"
                    type="date"
                    defaultValue={`${year}-01-01`}
                    required
                  />
                  <Field label="To" name="to" type="date" defaultValue={`${year}-12-31`} required />
                  <p className="text-xs text-[var(--muted)]">
                    Creates one filing per return and period from the deadlines below. Running it
                    again never creates duplicates.
                  </p>
                </ActionForm>
              </details>
            ) : null}
            {reviewer ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Add a filing by hand
                </summary>
                <ActionForm action={opsClientAction} submitLabel="Add filing">
                  {hidden("add_filing")}
                  <Field label="Return / form code" name="formCode" required maxLength={40} />
                  <Field label="Title" name="title" required maxLength={200} />
                  <Field label="Period from" name="from" type="date" required />
                  <Field label="Period to" name="to" type="date" required />
                  <Field label="Due on" name="dueOn" type="date" required />
                  <TextArea label="Where the due date comes from" name="reason" required />
                </ActionForm>
              </details>
            ) : null}
          </Section>

          <Section title="Deadlines that apply to this client">
            <DataTable
              caption="Client deadlines"
              rows={deadlines}
              rowKey={(d) => d.id}
              empty="None set."
              columns={[
                {
                  header: "Rule",
                  cell: (d) => {
                    const r = ruleById.get(d.rule_id);
                    return r ? (
                      <span className="flex flex-wrap items-center gap-1">
                        {r.code} · {r.title} <OpsBadge status={r.status} />
                      </span>
                    ) : (
                      d.rule_id
                    );
                  },
                },
                { header: "From", kind: "nowrap", cell: (d) => d.starts_on },
                { header: "Until", kind: "nowrap", cell: (d) => d.ends_on ?? "—" },
                { header: "FY ends (month)", cell: (d) => d.anchor_month },
                { header: "Preparer", hideOnMobile: true, cell: (d) => who(names, d.preparer_id) },
                { header: "Reviewer", hideOnMobile: true, cell: (d) => who(names, d.reviewer_id) },
                {
                  header: "Actions",
                  srOnlyHeader: true,
                  cell: (d) =>
                    reviewer && !d.ends_on ? (
                      <ActionForm
                        action={opsClientAction}
                        submitLabel="End"
                        variant="secondary"
                        className="flex gap-2"
                      >
                        {hidden("end_client_deadline")}
                        <input type="hidden" name="id" value={d.id} />
                        <Field label="End on" name="endsOn" type="date" hideLabel required />
                      </ActionForm>
                    ) : null,
                },
              ]}
            />
            {reviewer ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Apply a deadline rule
                </summary>
                <ActionForm action={opsClientAction} submitLabel="Apply">
                  {hidden("set_client_deadline")}
                  <Select
                    label="Rule"
                    name="ruleId"
                    options={rules
                      .filter((r) => r.status !== "retired")
                      .map((r) => ({
                        value: r.id,
                        label: `${r.code} · ${r.title}${r.status === "pending_verification" ? " (PENDING VERIFICATION)" : ""}`,
                      }))}
                  />
                  <Field label="Applies from" name="startsOn" type="date" required />
                  <Field
                    label="Fiscal year end month (1-12)"
                    name="anchorMonth"
                    defaultValue="12"
                    inputMode="numeric"
                  />
                  <Select label="Default preparer" name="preparerId" options={staffOptions} />
                  <Select label="Default reviewer" name="reviewerId" options={reviewerOptions} />
                  <p className="text-xs text-[var(--muted)]">
                    Rules are firm configuration with a cited source (see{" "}
                    <Link className="underline" href={pathFor("deadlines")}>
                      Deadline rules
                    </Link>
                    ). None are built in.
                  </p>
                </ActionForm>
              </details>
            ) : null}
          </Section>

          <Section title="Document requests to the client">
            <DataTable
              caption="Document requests"
              rows={requests}
              rowKey={(r) => r.id}
              empty="No requests yet."
              columns={[
                { header: "Requested", cell: (r) => r.title },
                {
                  header: "Due",
                  kind: "nowrap",
                  cell: (r) => (
                    <span className="flex flex-wrap items-center gap-1">
                      {r.due_on}
                      <OverdueBadge
                        due={r.due_on}
                        closed={!["open", "returned"].includes(r.status)}
                      />
                    </span>
                  ),
                },
                { header: "Status", cell: (r) => <OpsBadge status={r.status} /> },
                {
                  header: "Response",
                  hideOnMobile: true,
                  cell: (r) =>
                    r.responded_at
                      ? `${r.document_ids.length} document(s)${r.response_note ? ` · ${r.response_note}` : ""}`
                      : `${r.reminder_count} reminder(s)`,
                },
                {
                  header: "Actions",
                  srOnlyHeader: true,
                  cell: (r) =>
                    ["open", "returned", "submitted"].includes(r.status) ? (
                      <ActionForm
                        action={opsClientAction}
                        submitLabel="Save"
                        className="flex flex-col gap-2"
                        buttons={[
                          ...(r.status === "submitted"
                            ? [
                                {
                                  label: "Accept",
                                  name: "decision",
                                  value: "accept",
                                  variant: "primary" as const,
                                },
                                { label: "Return", name: "decision", value: "return" },
                              ]
                            : []),
                          {
                            label: "Cancel request",
                            name: "decision",
                            value: "cancel",
                            variant: "danger" as const,
                          },
                        ]}
                      >
                        {hidden("decide_request")}
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="version" value={r.version} />
                        <Field label="Note (what is missing / why)" name="note" maxLength={1000} />
                      </ActionForm>
                    ) : null,
                },
              ]}
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">Request documents</summary>
              <ActionForm action={opsClientAction} submitLabel="Send request">
                {hidden("create_request")}
                <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                <Field label="What is needed" name="title" required maxLength={200} />
                <TextArea label="Details (shown to the client)" name="details" maxLength={1000} />
                <Select
                  label="Document type"
                  name="category"
                  options={CATEGORIES.map((v) => ({
                    value: v,
                    label: v ? v.replace(/_/g, " ") : "— any —",
                  }))}
                />
                <Field label="Period from" name="periodFrom" type="date" />
                <Field label="Period to" name="periodTo" type="date" />
                <Field label="Due on" name="dueOn" type="date" required />
                <p className="text-xs text-[var(--muted)]">
                  The client is notified that a request is due on this date. Notifications never
                  include the request text or any amounts; the client reads it after signing in.
                </p>
              </ActionForm>
            </details>
          </Section>

          <Section title="Work items">
            <DataTable
              caption="Work items"
              rows={work}
              rowKey={(w) => w.id}
              empty="No work items."
              columns={[
                {
                  header: "Item",
                  cell: (w) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.work_item", { clientId: c, itemId: w.id })}
                    >
                      {w.title}
                    </Link>
                  ),
                },
                { header: "Kind", hideOnMobile: true, cell: (w) => WORK_KINDS[w.kind] ?? w.kind },
                { header: "Status", cell: (w) => <OpsBadge status={w.status} /> },
                {
                  header: "Due",
                  kind: "nowrap",
                  cell: (w) => (
                    <span className="flex flex-wrap items-center gap-1">
                      {w.due_on ?? "—"}
                      <OverdueBadge
                        due={w.due_on}
                        closed={["done", "cancelled"].includes(w.status)}
                      />
                    </span>
                  ),
                },
                { header: "Assignee", cell: (w) => who(names, w.assignee_id) },
                { header: "Reviewer", hideOnMobile: true, cell: (w) => who(names, w.reviewer_id) },
              ]}
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">New work item</summary>
              <ActionForm action={opsClientAction} submitLabel="Create">
                {hidden("create_work")}
                <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                <Field label="Title" name="title" required maxLength={200} />
                <TextArea label="Details" name="details" maxLength={2000} />
                <Select
                  label="Kind"
                  name="kind"
                  options={Object.entries(WORK_KINDS).map(([value, label]) => ({ value, label }))}
                />
                <Select
                  label="Priority"
                  name="priority"
                  defaultValue="normal"
                  options={["low", "normal", "high", "urgent"].map((v) => ({ value: v, label: v }))}
                />
                <Select label="Assignee" name="assigneeId" options={staffOptions} />
                <Select label="Reviewer" name="reviewerId" options={reviewerOptions} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="requiresReview" defaultChecked /> Needs a
                  reviewer&apos;s approval to close
                </label>
                <Field label="Due on" name="dueOn" type="date" />
              </ActionForm>
            </details>
          </Section>

          <Section title="Service status">
            <DataTable
              caption="Service status history"
              rows={status}
              rowKey={(s) => String(s.id)}
              empty="Not set."
              columns={[
                { header: "Status", cell: (s) => <OpsBadge status={s.status} /> },
                { header: "Reason", cell: (s) => s.reason },
                { header: "By", cell: (s) => who(names, s.set_by) },
                { header: "When", kind: "nowrap", cell: (s) => s.set_at.slice(0, 10) },
              ]}
            />
            {manager ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Change service status
                </summary>
                <ActionForm action={opsClientAction} submitLabel="Save status">
                  {hidden("service_status")}
                  <Select
                    label="Status"
                    name="status"
                    options={SERVICE_STATUSES.map((s) => ({
                      value: s,
                      label: s.replace(/_/g, " "),
                    }))}
                  />
                  <TextArea label="Reason (internal)" name="reason" required maxLength={1000} />
                </ActionForm>
              </details>
            ) : null}
          </Section>

          <Section title="Exception requests">
            <DataTable
              caption="Exception requests"
              rows={exceptions}
              rowKey={(e) => e.id}
              empty="None."
              columns={[
                { header: "Request", cell: (e) => EXCEPTION_KINDS[e.kind] ?? e.kind },
                { header: "Reason", cell: (e) => e.reason },
                { header: "Status", cell: (e) => <OpsBadge status={e.status} /> },
                {
                  header: "Requested by",
                  hideOnMobile: true,
                  cell: (e) => who(names, e.requested_by),
                },
                {
                  header: "Decided by",
                  hideOnMobile: true,
                  cell: (e) =>
                    e.decided_by ? `${who(names, e.decided_by)}: ${e.decision_note ?? ""}` : "—",
                },
              ]}
            />
            {preparer ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Request an exception
                </summary>
                <ActionForm action={opsClientAction} submitLabel="Request">
                  {hidden("request_exception")}
                  <Select
                    label="What"
                    name="kind"
                    options={Object.entries(EXCEPTION_KINDS).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                  <Select
                    label="Locked period (to reopen)"
                    name="periodId"
                    options={[
                      { value: "", label: "—" },
                      ...lockedPeriods.map((p) => ({
                        value: p.id,
                        label: `${p.start_date} – ${p.end_date}`,
                      })),
                    ]}
                  />
                  <Select
                    label="Reopen as"
                    name="targetStatus"
                    options={[
                      {
                        value: "soft_closed",
                        label: "soft closed (reviewers can post corrections)",
                      },
                      { value: "open", label: "open" },
                    ]}
                  />
                  <Select
                    label="Filing"
                    name="filingId"
                    options={[
                      { value: "", label: "—" },
                      ...filings.map((f) => ({
                        value: f.id,
                        label: `${f.form_code} ${f.period_from} – ${f.period_to} (${f.status.replace(/_/g, " ")})`,
                      })),
                    ]}
                  />
                  <Field label="New due date (for a due-date change)" name="newDueOn" type="date" />
                  <TextArea label="Reason" name="reason" required maxLength={1000} />
                  <p className="text-xs text-[var(--muted)]">
                    A firm manager other than you decides. An approval is carried out at once and
                    recorded; a locked period cannot be reopened any other way.
                  </p>
                </ActionForm>
              </details>
            ) : null}
            {reviewer ? (
              <p className="mt-2 text-sm">
                <Link className="underline" href={`${pathFor("review.activity")}?client=${c}`}>
                  Activity report for this client
                </Link>
              </p>
            ) : null}
          </Section>
        </>
      );
    },
  );
}
