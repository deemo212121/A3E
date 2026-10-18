import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import {
  Alert,
  BUTTON_VARIANTS,
  PageHeader,
  PageSkeleton,
  Section,
} from "@/components/ui/primitives";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { activityReport } from "@/server/data/operations";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Activity reports" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function ActivityPage({ searchParams }: PageProps<"/review/activity">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Activity searchParams={searchParams} />
    </Suspense>
  );
}

async function Activity({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { access, facts, decision } = await guardRoute("review.activity");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const sp = await searchParams;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const from = typeof sp.from === "string" && DATE.test(sp.from) ? sp.from : monthAgo;
  const to = typeof sp.to === "string" && DATE.test(sp.to) ? sp.to : today;
  const firmWide = hasFirmRole(access, ["firm_admin", "firm_manager"]);
  const clients = hasFirmRole(access, ["firm_admin"])
    ? []
    : (await listVisibleClients()).filter((c) => facts.staffClientIds.includes(c.id));
  const requested =
    typeof sp.client === "string" && UUID.test(sp.client) ? sp.client.toLowerCase() : "";
  const clientId = requested || (firmWide ? "" : (clients[0]?.id ?? ""));
  const rows = clientId || firmWide ? await activityReport(clientId || null, from, to) : [];

  return (
    <div data-route="review.activity">
      <PageHeader
        title="Activity reports"
        description="Who did what, and when. Changed fields are listed; values are not shown here."
      />
      <Alert tone="info">
        Managers see every client; reviewers see their assigned clients; firm admins see firm-level
        events only (users, roles, invitations). Opening a report is itself recorded.
      </Alert>
      <Section title="Filter">
        <form
          method="get"
          action={pathFor("review.activity")}
          className="flex flex-wrap items-end gap-3 text-sm"
        >
          {clients.length > 0 ? (
            <label className="flex flex-col gap-1">
              Client
              <select
                name="client"
                defaultValue={clientId}
                className="rounded-md border border-[var(--border)] px-2 py-1.5"
              >
                {firmWide ? <option value="">Whole firm</option> : null}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name} ({c.code})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            From
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="rounded-md border border-[var(--border)] px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            To
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="rounded-md border border-[var(--border)] px-2 py-1.5"
            />
          </label>
          <button type="submit" className={BUTTON_VARIANTS.secondary}>
            Show
          </button>
        </form>
      </Section>
      <Section title={`Events (${rows.length}${rows.length === 2000 ? ", newest 2000" : ""})`}>
        <DataTable
          caption="Activity"
          rows={rows}
          rowKey={(r) => `${r.occurred_at}-${r.action}-${r.row_id}`}
          empty={
            clientId || firmWide
              ? "No activity in this range."
              : "You are not a reviewer on any client."
          }
          columns={[
            {
              header: "When",
              kind: "nowrap",
              cell: (r) => r.occurred_at.slice(0, 19).replace("T", " "),
            },
            { header: "Who", cell: (r) => r.actor_name ?? (r.actor_id ? "user" : "system") },
            { header: "Client", hideOnMobile: true, cell: (r) => r.client_code ?? "firm" },
            { header: "Action", cell: (r) => r.action },
            { header: "Record", hideOnMobile: true, cell: (r) => r.row_id ?? "" },
            { header: "Changed", cell: (r) => (r.changed_fields ?? []).join(", ") },
          ]}
        />
      </Section>
    </div>
  );
}
