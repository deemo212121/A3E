import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { revokeInvitationAction } from "@/features/admin/actions";
import { formatManila, roleLabel } from "@/lib/access/labels";
import { guardRoute } from "@/server/auth/route-guard";
import { listPendingInvitations, listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Invitations" };

export default function AdminInvitationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AdminInvitations />
    </Suspense>
  );
}

async function AdminInvitations() {
  const { decision } = await guardRoute("admin.invitations");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [invitations, clients] = await Promise.all([
    listPendingInvitations(),
    listVisibleClients(),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.display_name]));

  return (
    <div data-route="admin.invitations">
      <PageHeader
        title="Invitations"
        breadcrumbs={[{ href: "/admin", label: "Firm administration" }, { label: "Invitations" }]}
        description="Pending invitations you are allowed to see. Invitations expire automatically."
      />
      <Section title="Pending">
        <DataTable
          caption="Pending invitations"
          rows={invitations}
          rowKey={(i) => i.id}
          empty="No pending invitations."
          columns={[
            { header: "Email", cell: (i) => i.email },
            {
              header: "For",
              cell: (i) =>
                i.kind === "firm"
                  ? "Accounting firm"
                  : (clientName.get(i.client_id ?? "") ?? "Client"),
            },
            {
              header: "Role",
              cell: (i) => roleLabel(i.kind === "firm" ? i.firm_role : i.client_role),
            },
            { header: "Expires", kind: "nowrap", cell: (i) => formatManila(i.expires_at) },
            {
              header: "Actions",
              srOnlyHeader: true,
              cell: (i) => (
                <ActionForm
                  action={revokeInvitationAction}
                  submitLabel="Revoke"
                  variant="danger"
                  className="flex gap-2"
                >
                  <input type="hidden" name="invitationId" value={i.id} />
                </ActionForm>
              ),
            },
          ]}
        />
      </Section>
    </div>
  );
}
