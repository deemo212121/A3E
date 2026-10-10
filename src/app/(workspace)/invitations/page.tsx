import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader, PageSkeleton } from "@/components/ui/primitives";
import { acceptInvitationAction } from "@/features/clients/actions";
import { formatManila, roleLabel } from "@/lib/access/labels";
import { guardRoute } from "@/server/auth/route-guard";
import { listMyInvitations } from "@/server/data/workspace";

export const metadata: Metadata = { title: "My invitations" };

export default function InvitationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Invitations />
    </Suspense>
  );
}

async function Invitations() {
  const { decision } = await guardRoute("invitations");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const invitations = await listMyInvitations();

  return (
    <div data-route="invitations">
      <PageHeader
        title="My invitations"
        description="Invitations sent to your confirmed email address. Accepting one gives you access."
      />
      <DataTable
        caption="Pending invitations"
        rows={invitations}
        rowKey={(r) => r.id}
        empty="You have no pending invitations."
        columns={[
          {
            header: "Invitation",
            cell: (r) =>
              r.kind === "firm" ? "Join the accounting firm" : (r.client_name ?? "Client business"),
          },
          {
            header: "Role",
            cell: (r) => roleLabel(r.kind === "firm" ? r.firm_role : r.client_role),
          },
          { header: "Expires", kind: "nowrap", cell: (r) => formatManila(r.expires_at) },
          {
            header: "Action",
            srOnlyHeader: true,
            cell: (r) => (
              <ActionForm
                action={acceptInvitationAction}
                submitLabel="Accept"
                className="flex gap-2"
              >
                <input type="hidden" name="invitationId" value={r.id} />
              </ActionForm>
            ),
          },
        ]}
      />
    </div>
  );
}
