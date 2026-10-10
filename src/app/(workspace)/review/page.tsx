import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount } from "@/lib/money/amount";
import { guardRoute } from "@/server/auth/route-guard";
import { listReviewQueue } from "@/server/data/ledger";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Review queue" };

export default function ReviewPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Review />
    </Suspense>
  );
}

async function Review() {
  const { access, facts, decision } = await guardRoute("review");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [clients, queue] = await Promise.all([listVisibleClients(), listReviewQueue()]);
  const scoped = clients.filter((c) => facts.staffClientIds.includes(c.id));
  const clientName = new Map(clients.map((c) => [c.id, c.display_name]));

  return (
    <div data-route="review">
      <PageHeader
        title="Review queue"
        description={
          facts.firmRole === "firm_manager"
            ? "Journal entries awaiting review across all clients."
            : "Journal entries awaiting review for your assigned clients."
        }
      />
      <Section title="Awaiting review">
        <DataTable
          caption="Journal entries awaiting review"
          rows={queue}
          rowKey={(e) => e.id}
          empty="Nothing is waiting for review."
          columns={[
            { header: "Client", cell: (e) => clientName.get(e.client_id) ?? "—" },
            { header: "Date", kind: "nowrap", cell: (e) => e.entry_date },
            {
              header: "Memo",
              cell: (e) => (
                <Link
                  className="underline"
                  href={pathFor("staff.entry", { clientId: e.client_id, entryId: e.id })}
                >
                  {e.memo || "(no memo)"}
                </Link>
              ),
            },
            { header: "Type", cell: (e) => e.entry_type },
            { header: "Amount", cell: (e) => formatAmount(e.total), kind: "num" },
            { header: "Status", cell: () => <Badge tone="warning">submitted</Badge> },
          ]}
        />
        <p className="mt-2 text-xs text-[var(--muted)]">
          You cannot approve entries you prepared ({access.email}); another reviewer must.
        </p>
      </Section>
      <Section title="Clients in your review scope">
        <DataTable
          caption="Clients in review scope"
          rows={scoped}
          rowKey={(c) => c.id}
          empty="No clients in your review scope."
          columns={[
            {
              header: "Client",
              cell: (c) => (
                <Link href={pathFor("staff.client", { clientId: c.id })} className="underline">
                  {c.display_name}
                </Link>
              ),
            },
            { header: "Code", cell: (c) => c.code },
            { header: "Status", cell: (c) => c.status },
          ]}
        />
      </Section>
    </div>
  );
}
