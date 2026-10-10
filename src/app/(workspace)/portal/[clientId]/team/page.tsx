import type { Metadata } from "next";
import { Suspense } from "react";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageSkeleton, Section } from "@/components/ui/primitives";
import { inviteClientMemberAction, setClientMemberRoleAction } from "@/features/clients/actions";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { roleLabel } from "@/lib/access/labels";
import { listMembers } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Team" };

// Client owners manage staff and viewers; only the firm can add or remove owners.
const OWNER_MANAGED_ROLES = [
  { value: "client_staff", label: "Staff" },
  { value: "client_viewer", label: "Viewer" },
] as const;

export default function TeamPage({ params }: PageProps<"/portal/[clientId]/team">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Team params={params} />
    </Suspense>
  );
}

async function Team({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage("portal.team", clientId, "Team", async ({ access, client }) => {
    const myRole = access.client_memberships.find((m) => m.client_id === client.id)?.role;
    const isOwner = myRole === "client_owner";
    const members = await listMembers(client.id);
    return (
      <>
        <Section title="People with access to this business">
          <DataTable
            caption="Team members"
            rows={members}
            rowKey={(m) => m.user_id}
            columns={[
              { header: "Name", cell: (m) => m.name || m.email },
              { header: "Email", cell: (m) => m.email },
              { header: "Role", cell: (m) => <Badge>{roleLabel(m.role)}</Badge> },
              ...(isOwner
                ? [
                    {
                      header: "Manage",
                      srOnlyHeader: true,
                      cell: (m: (typeof members)[number]) =>
                        m.user_id === access.user_id || m.role === "client_owner" ? (
                          <span className="text-xs text-[var(--muted)]">
                            {m.user_id === access.user_id ? "You" : "Managed by the firm"}
                          </span>
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
                                ...OWNER_MANAGED_ROLES,
                                { value: "remove", label: "Remove access" },
                              ]}
                            />
                          </ActionForm>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        </Section>
        {isOwner ? (
          <Section title="Invite a team member">
            <ActionForm action={inviteClientMemberAction} submitLabel="Send invitation">
              <input type="hidden" name="clientId" value={client.id} />
              <Field label="Email" name="email" type="email" required autoComplete="off" />
              <Select
                label="Role"
                name="role"
                options={OWNER_MANAGED_ROLES}
                defaultValue="client_staff"
              />
            </ActionForm>
          </Section>
        ) : null}
      </>
    );
  });
}
