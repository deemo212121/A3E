import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader, PageSkeleton, Section, StatCard } from "@/components/ui/primitives";
import { opsFirmAction } from "@/features/operations/actions";
import { OpsBadge, OverdueBadge, WORK_KINDS, who } from "@/features/operations/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import {
  listFilings,
  listSubmittedRequests,
  listWorkItems,
  staffNames,
  type FilingRow,
  type WorkItemRow,
} from "@/server/data/operations";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "My work queue" };

export default function WorkQueuePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorkQueue />
    </Suspense>
  );
}

async function WorkQueue() {
  const { access, facts, decision } = await guardRoute("work");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [filings, work, submitted, clients, names] = await Promise.all([
    listFilings({ open: true }),
    listWorkItems({ open: true }),
    listSubmittedRequests(),
    listVisibleClients(),
    staffNames(),
  ]);
  const me = access.user_id;
  const manager = hasFirmRole(access, ["firm_manager"]);
  const mine = (ids: (string | null)[]) => ids.includes(me);
  const scoped = <T extends { client_id: string }>(rows: T[]) =>
    rows.filter((r) => facts.staffClientIds.includes(r.client_id));
  const clientName = new Map(clients.map((c) => [c.id, c.code]));
  const today = new Date().toISOString().slice(0, 10);

  // A filing is "mine" when it waits on me: preparing it, or reviewing it.
  const myFilings = scoped(filings).filter(
    (f) =>
      (f.preparer_id === me && f.status !== "in_review") ||
      (f.reviewer_id === me && f.status === "in_review"),
  );
  const myWork = scoped(work).filter(
    (w) =>
      (w.assignee_id === me && w.status !== "in_review") ||
      (w.reviewer_id === me && w.status === "in_review"),
  );
  const unassignedFilings = scoped(filings).filter((f) => !f.preparer_id);
  const unassignedWork = scoped(work).filter((w) => !w.assignee_id);
  const overdue = scoped(filings).filter((f) => f.due_on < today);
  const waitingOnMe = scoped(submitted).filter((r) => r.requested_by === me || manager);

  const filingColumns = [
    { header: "Client", cell: (f: FilingRow) => clientName.get(f.client_id) ?? "—" },
    {
      header: "Return",
      cell: (f: FilingRow) => (
        <Link
          className="font-medium text-[var(--accent)] hover:underline"
          href={pathFor("staff.filing", { clientId: f.client_id, itemId: f.id })}
        >
          {f.form_code} {f.period_from} – {f.period_to}
        </Link>
      ),
    },
    {
      header: "Due",
      kind: "nowrap" as const,
      cell: (f: FilingRow) => (
        <span className="flex flex-wrap items-center gap-1">
          {f.due_on} <OverdueBadge due={f.due_on} closed={false} />
        </span>
      ),
    },
    { header: "Status", cell: (f: FilingRow) => <OpsBadge status={f.status} /> },
    { header: "Preparer", hideOnMobile: true, cell: (f: FilingRow) => who(names, f.preparer_id) },
    { header: "Reviewer", hideOnMobile: true, cell: (f: FilingRow) => who(names, f.reviewer_id) },
  ];
  const workColumns = [
    { header: "Client", cell: (w: WorkItemRow) => clientName.get(w.client_id) ?? "—" },
    {
      header: "Item",
      cell: (w: WorkItemRow) => (
        <Link
          className="font-medium text-[var(--accent)] hover:underline"
          href={pathFor("staff.work_item", { clientId: w.client_id, itemId: w.id })}
        >
          {w.title}
        </Link>
      ),
    },
    { header: "Kind", hideOnMobile: true, cell: (w: WorkItemRow) => WORK_KINDS[w.kind] ?? w.kind },
    { header: "Priority", hideOnMobile: true, cell: (w: WorkItemRow) => w.priority },
    {
      header: "Due",
      kind: "nowrap" as const,
      cell: (w: WorkItemRow) => (
        <span className="flex flex-wrap items-center gap-1">
          {w.due_on ?? "—"} <OverdueBadge due={w.due_on} closed={false} />
        </span>
      ),
    },
    { header: "Status", cell: (w: WorkItemRow) => <OpsBadge status={w.status} /> },
    {
      header: "Your part",
      cell: (w: WorkItemRow) =>
        mine([w.reviewer_id]) && w.status === "in_review" ? "review" : "do",
    },
  ];

  return (
    <div data-route="work">
      <PageHeader
        title="My work queue"
        description={
          manager
            ? "What waits on you, plus unassigned and overdue work across the firm."
            : "What waits on you, and unassigned work on your clients."
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Filings waiting on me" value={myFilings.length} />
        <StatCard label="Work items waiting on me" value={myWork.length} />
        <StatCard label="Client responses to check" value={waitingOnMe.length} />
        <StatCard
          label="Overdue filings"
          value={overdue.length}
          tone={overdue.length ? "danger" : "neutral"}
        />
      </div>
      <Section title="Filings waiting on me">
        <DataTable
          caption="My filings"
          rows={myFilings}
          rowKey={(f) => f.id}
          columns={filingColumns}
          empty="Nothing."
        />
      </Section>
      <Section title="Work items waiting on me">
        <DataTable
          caption="My work items"
          rows={myWork}
          rowKey={(w) => w.id}
          columns={workColumns}
          empty="Nothing."
        />
      </Section>
      <Section title="Client responses to check">
        <DataTable
          caption="Submitted document requests"
          rows={waitingOnMe}
          rowKey={(r) => r.id}
          empty="Nothing."
          columns={[
            { header: "Client", cell: (r) => clientName.get(r.client_id) ?? "—" },
            {
              header: "Request",
              cell: (r) => (
                <Link
                  className="underline"
                  href={pathFor("staff.operations", { clientId: r.client_id })}
                >
                  {r.title}
                </Link>
              ),
            },
            {
              header: "Responded",
              kind: "nowrap",
              cell: (r) => r.responded_at?.slice(0, 10) ?? "",
            },
          ]}
        />
      </Section>
      <Section title="Unassigned">
        <DataTable
          caption="Unassigned filings"
          rows={unassignedFilings}
          rowKey={(f) => f.id}
          columns={filingColumns}
          empty="No unassigned filings."
        />
        <div className="mt-3">
          <DataTable
            caption="Unassigned work items"
            rows={unassignedWork}
            rowKey={(w) => w.id}
            columns={workColumns}
            empty="No unassigned work items."
          />
        </div>
      </Section>
      {manager ? (
        <Section title="Overdue filings (firm)">
          <DataTable
            caption="Overdue filings"
            rows={overdue}
            rowKey={(f) => f.id}
            columns={filingColumns}
            empty="None overdue."
          />
          <div className="mt-3">
            <ActionForm action={opsFirmAction} submitLabel="Send today's reminders">
              <input type="hidden" name="op" value="run_reminders" />
              <p className="text-xs text-[var(--muted)]">
                Reminds preparers, reviewers and clients of upcoming and overdue items. Safe to run
                more than once a day: nothing is sent twice. A scheduler can call the same function.
              </p>
            </ActionForm>
          </div>
        </Section>
      ) : null}
    </div>
  );
}
