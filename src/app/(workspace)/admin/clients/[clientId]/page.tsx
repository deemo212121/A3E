import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { revokeInvitationAction, updateClientAction } from "@/features/admin/actions";
import { inviteClientMemberAction, setClientMemberRoleAction } from "@/features/clients/actions";
import { formatManila, roleLabel } from "@/lib/access/labels";
import { guardRoute } from "@/server/auth/route-guard";
import {
  getVisibleClient,
  listAssignments,
  listMembers,
  listPendingInvitations,
} from "@/server/data/workspace";

export const metadata: Metadata = { title: "Client administration" };

const CLIENT_ROLE_OPTIONS = [
  { value: "client_owner", label: "Owner" },
  { value: "client_staff", label: "Staff" },
  { value: "client_viewer", label: "Viewer" },
] as const;

export default function AdminClientPage({ params }: PageProps<"/admin/clients/[clientId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AdminClient params={params} />
    </Suspense>
  );
}

async function AdminClient({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId: raw } = await params;
  const { access, decision } = await guardRoute("admin.client", { clientId: raw });
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const clientId = raw.toLowerCase();
  const client = await getVisibleClient(clientId);
  if (!client) return <DeniedState reason="not_found" />;

  const [members, assignments, invitations] = await Promise.all([
    listMembers(clientId),
    listAssignments(clientId),
    listPendingInvitations(clientId),
  ]);

  return (
    <div data-route="admin.client">
      <PageHeader
        title={client.display_name}
        breadcrumbs={[
          { href: "/admin", label: "Firm administration" },
          { href: "/admin/clients", label: "Clients" },
          { label: client.code },
        ]}
        description={<Badge>{client.status}</Badge>}
      />
      <Section title="Client details">
        <ActionForm action={updateClientAction} submitLabel="Save details">
          <input type="hidden" name="clientId" value={client.id} />
          <Field
            label="Business name"
            name="displayName"
            defaultValue={client.display_name}
            required
          />
          <Select
            label="Status"
            name="status"
            defaultValue={client.status}
            options={[
              { value: "onboarding", label: "Onboarding" },
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived (client users lose access)" },
            ]}
          />
        </ActionForm>
      </Section>
      <Section title="Client portal users">
        <DataTable
          caption="Client portal users"
          rows={members}
          rowKey={(m) => m.user_id}
          empty="No portal users yet. Invite the business owner below."
          columns={[
            { header: "Name", cell: (m) => m.name || m.email },
            { header: "Email", cell: (m) => m.email },
            { header: "Role", cell: (m) => <Badge>{roleLabel(m.role)}</Badge> },
            {
              header: "Manage",
              srOnlyHeader: true,
              cell: (m) =>
                m.user_id === access.user_id ? (
                  <span className="text-xs">You</span>
                ) : (
                  <ActionForm
                    action={setClientMemberRoleAction}
                    submitLabel="Apply"
                    variant="secondary"
                    className="flex items-end gap-2"
                  >
                    <input type="hidden" name="clientId" value={client.id} />
                    <input type="hidden" name="userId" value={m.user_id} />
                    <Select
                      label={`Change role for ${m.name || m.email}`}
                      name="role"
                      defaultValue={m.role}
                      options={[
                        ...CLIENT_ROLE_OPTIONS,
                        { value: "remove", label: "Remove access" },
                      ]}
                    />
                  </ActionForm>
                ),
            },
          ]}
        />
        <div className="mt-4">
          <ActionForm action={inviteClientMemberAction} submitLabel="Send invitation">
            <input type="hidden" name="clientId" value={client.id} />
            <Field label="Email" name="email" type="email" required autoComplete="off" />
            <Select
              label="Role"
              name="role"
              options={CLIENT_ROLE_OPTIONS}
              defaultValue="client_owner"
            />
          </ActionForm>
        </div>
      </Section>
      <Section title="Pending invitations">
        <DataTable
          caption="Pending invitations for this client"
          rows={invitations}
          rowKey={(i) => i.id}
          empty="No pending invitations."
          columns={[
            { header: "Email", cell: (i) => i.email },
            { header: "Role", cell: (i) => roleLabel(i.client_role) },
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
      <Section title="Assigned firm staff">
        <DataTable
          caption="Assigned firm staff"
          rows={assignments}
          rowKey={(a) => `${a.user_id}-${a.assignment_role}`}
          empty="No staff assigned. Managers assign staff in the review workspace."
          columns={[
            { header: "Name", cell: (a) => a.name || a.email },
            { header: "Assignment", cell: (a) => roleLabel(a.assignment_role) },
          ]}
        />
      </Section>
    </div>
  );
}
