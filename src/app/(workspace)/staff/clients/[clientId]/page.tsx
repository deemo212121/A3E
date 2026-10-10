import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import {
  Badge,
  MoreActions,
  PageHeader,
  PageSkeleton,
  Section,
  StatCard,
} from "@/components/ui/primitives";
import { createContactAction, deleteContactAction } from "@/features/clients/actions";
import { SubNav } from "@/components/ui/sub-nav";
import { roleLabel } from "@/lib/access/labels";
import { pathFor, staffClientTabs } from "@/lib/access/route-policy";
import { listEntries } from "@/server/data/ledger";
import { guardRoute } from "@/server/auth/route-guard";
import {
  getVisibleClient,
  listAssignments,
  listContacts,
  listMembers,
} from "@/server/data/workspace";

export const metadata: Metadata = { title: "Client workspace" };

export default function StaffClientPage({ params }: PageProps<"/staff/clients/[clientId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StaffClient params={params} />
    </Suspense>
  );
}

async function StaffClient({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId: raw } = await params;
  const { facts, decision } = await guardRoute("staff.client", { clientId: raw });
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const clientId = raw.toLowerCase();
  const client = await getVisibleClient(clientId);
  if (!client) return <DeniedState reason="not_found" />;

  const [contacts, members, assignments, entries] = await Promise.all([
    listContacts(clientId),
    listMembers(clientId),
    listAssignments(clientId),
    listEntries(clientId),
  ]);
  const n = (s: string) => entries.filter((e) => e.status === s).length;
  const lastPosted = entries
    .filter((e) => e.status === "posted" || e.status === "reversed")
    .map((e) => e.entry_date)
    .sort()
    .at(-1);
  const journal = pathFor("staff.journal", { clientId });
  const canDelete = facts.firmRole === "firm_manager" || facts.firmRole === "reviewer";

  return (
    <div data-route="staff.client">
      <PageHeader
        title={client.display_name}
        breadcrumbs={[{ href: "/staff", label: "My clients" }, { label: client.display_name }]}
        description={`${client.code} · ${client.status}`}
      />
      <SubNav label="Client workspace sections" items={staffClientTabs(facts, clientId)} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Drafts" value={n("draft")} href={`${journal}?status=draft`} />
        <StatCard
          label="Awaiting review"
          value={n("submitted")}
          tone={n("submitted") > 0 ? "warning" : "neutral"}
          href={`${journal}?status=submitted`}
        />
        <StatCard
          label="Posted entries"
          value={n("posted") + n("reversed")}
          tone="success"
          href={`${journal}?status=posted`}
        />
        <StatCard label="Last posting" value={lastPosted ?? "—"} hint="Entry date" />
      </div>
      <Section title="Business contacts">
        <DataTable
          caption="Business contacts"
          rows={contacts}
          rowKey={(c) => c.id}
          empty="No contacts yet."
          columns={[
            { header: "Name", cell: (c) => c.full_name },
            { header: "Position", cell: (c) => c.position ?? "—" },
            { header: "Email", cell: (c) => c.email ?? "—" },
            ...(canDelete
              ? [
                  {
                    header: "Actions",
                    srOnlyHeader: true,
                    cell: (c: (typeof contacts)[number]) => (
                      <ActionForm
                        action={deleteContactAction}
                        submitLabel="Delete"
                        variant="danger"
                        className="flex gap-2"
                        confirmMessage={`Delete ${c.full_name}?`}
                      >
                        <input type="hidden" name="clientId" value={clientId} />
                        <input type="hidden" name="contactId" value={c.id} />
                      </ActionForm>
                    ),
                  },
                ]
              : []),
          ]}
        />
        <div className="mt-4">
          <MoreActions label="+ Add a contact">
            <ActionForm action={createContactAction} submitLabel="Add contact">
              <input type="hidden" name="clientId" value={clientId} />
              <Field label="Full name" name="fullName" required />
              <Field label="Position" name="position" />
              <Field label="Email" name="email" type="email" />
            </ActionForm>
          </MoreActions>
        </div>
      </Section>
      <Section title="Client portal users">
        <DataTable
          caption="Client portal users"
          rows={members}
          rowKey={(m) => m.user_id}
          empty="No portal users yet."
          columns={[
            { header: "Name", cell: (m) => m.name || m.email },
            { header: "Role", cell: (m) => <Badge>{roleLabel(m.role)}</Badge> },
          ]}
        />
      </Section>
      <Section title="Assigned firm staff">
        <DataTable
          caption="Assigned firm staff"
          rows={assignments}
          rowKey={(a) => `${a.user_id}-${a.assignment_role}`}
          columns={[
            { header: "Name", cell: (a) => a.name || a.email },
            { header: "Assignment", cell: (a) => roleLabel(a.assignment_role) },
          ]}
        />
      </Section>
    </div>
  );
}
