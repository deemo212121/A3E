import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { pathFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "My clients" };

export default function StaffHomePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StaffHome />
    </Suspense>
  );
}

async function StaffHome() {
  const { facts, decision } = await guardRoute("staff");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  // RLS returns assigned clients (all for managers); the policy list must agree.
  const clients = (await listVisibleClients()).filter((c) => facts.staffClientIds.includes(c.id));

  return (
    <div data-route="staff">
      <PageHeader title="My clients" description="Client businesses you are assigned to." />
      <Section title="Assigned clients">
        <DataTable
          caption="Assigned clients"
          rows={clients}
          rowKey={(c) => c.id}
          empty="You are not assigned to any client yet. A firm manager assigns staff to clients."
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
