import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageHeader, PageSkeleton } from "@/components/ui/primitives";
import { roleLabel } from "@/lib/access/labels";
import { pathFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";

export const metadata: Metadata = { title: "My businesses" };

export default function PortalPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Portal />
    </Suspense>
  );
}

async function Portal() {
  const { access, decision } = await guardRoute("portal");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;

  return (
    <div data-route="portal">
      <PageHeader
        title="My businesses"
        description="Businesses you can access in the client portal."
      />
      <DataTable
        caption="My businesses"
        rows={access.client_memberships}
        rowKey={(m) => m.client_id}
        columns={[
          {
            header: "Business",
            cell: (m) => (
              <Link
                href={pathFor("portal.client", { clientId: m.client_id })}
                className="underline"
              >
                {m.display_name}
              </Link>
            ),
          },
          { header: "Code", cell: (m) => m.code },
          { header: "Your role", cell: (m) => <Badge tone="info">{roleLabel(m.role)}</Badge> },
          { header: "Status", cell: (m) => m.status },
        ]}
      />
    </div>
  );
}
