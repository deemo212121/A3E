import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { Alert, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { OpsBadge, OverdueBadge, who } from "@/features/operations/labels";
import { pathFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";
import { listDeadlineRules, listFilings, staffNames } from "@/server/data/operations";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Filing calendar" };

export default function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Calendar searchParams={searchParams} />
    </Suspense>
  );
}

const month = (d: Date) => d.toISOString().slice(0, 7);

async function Calendar({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { facts, decision } = await guardRoute("calendar");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const sp = await searchParams;
  const m =
    typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : month(new Date());
  const start = `${m}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  const prev = new Date(`${start}T00:00:00Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);

  const [filings, overdueAll, clients, names, rules] = await Promise.all([
    listFilings({ from: start, to: end }),
    listFilings({ open: true, to: new Date().toISOString().slice(0, 10) }),
    listVisibleClients(),
    staffNames(),
    listDeadlineRules(),
  ]);
  const scoped = filings.filter((f) => facts.staffClientIds.includes(f.client_id));
  const today = new Date().toISOString().slice(0, 10);
  const overdue = overdueAll.filter(
    (f) => facts.staffClientIds.includes(f.client_id) && f.due_on < today,
  );
  const clientCode = new Map(clients.map((c) => [c.id, c.code]));
  const pending = new Set(
    rules.filter((r) => r.status === "pending_verification").map((r) => r.id),
  );

  const columns = [
    { header: "Due", kind: "nowrap" as const, cell: (f: (typeof filings)[number]) => f.due_on },
    { header: "Client", cell: (f: (typeof filings)[number]) => clientCode.get(f.client_id) ?? "—" },
    {
      header: "Return",
      cell: (f: (typeof filings)[number]) => (
        <Link
          className="font-medium text-[var(--accent)] hover:underline"
          href={pathFor("staff.filing", { clientId: f.client_id, itemId: f.id })}
        >
          {f.form_code} {f.period_from} – {f.period_to}
        </Link>
      ),
    },
    {
      header: "Status",
      cell: (f: (typeof filings)[number]) => (
        <span className="flex flex-wrap gap-1">
          <OpsBadge status={f.status} />
          <OverdueBadge due={f.due_on} closed={["filed", "not_required"].includes(f.status)} />
          {f.rule_id && pending.has(f.rule_id) ? <OpsBadge status="pending_verification" /> : null}
        </span>
      ),
    },
    {
      header: "Preparer",
      hideOnMobile: true,
      cell: (f: (typeof filings)[number]) => who(names, f.preparer_id),
    },
    {
      header: "Reviewer",
      hideOnMobile: true,
      cell: (f: (typeof filings)[number]) => who(names, f.reviewer_id),
    },
  ];

  return (
    <div data-route="calendar">
      <PageHeader
        title="Filing calendar"
        description="Due dates for your clients' returns, by month."
      />
      <Alert tone="info">
        Due dates come from the firm&apos;s deadline rules. A rule marked PENDING VERIFICATION has
        not yet been checked against its source by a second person. Holidays are not known to the
        system; a moved due date is changed through an approved exception.
      </Alert>
      {overdue.length > 0 ? (
        <Section title={`Overdue (${overdue.length})`}>
          <DataTable
            caption="Overdue filings"
            rows={overdue}
            rowKey={(f) => f.id}
            columns={columns}
          />
        </Section>
      ) : null}
      <Section
        title={m}
        actions={
          <span className="flex gap-2 text-sm">
            <Link className="underline" href={`${pathFor("calendar")}?month=${month(prev)}`}>
              ← {month(prev)}
            </Link>
            <Link className="underline" href={`${pathFor("calendar")}?month=${month(next)}`}>
              {month(next)} →
            </Link>
          </span>
        }
      >
        <DataTable
          caption={`Filings due in ${m}`}
          rows={scoped}
          rowKey={(f) => f.id}
          columns={columns}
          empty="Nothing due this month."
        />
      </Section>
    </div>
  );
}
