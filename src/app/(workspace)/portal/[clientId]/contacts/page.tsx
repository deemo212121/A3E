import type { Metadata } from "next";
import { Suspense } from "react";

import { ActionForm, Field } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { PageSkeleton, Section } from "@/components/ui/primitives";
import { createContactAction, deleteContactAction } from "@/features/clients/actions";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { listContacts } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Business contacts" };

export default function ContactsPage({ params }: PageProps<"/portal/[clientId]/contacts">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Contacts params={params} />
    </Suspense>
  );
}

async function Contacts({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage(
    "portal.contacts",
    clientId,
    "Business contacts",
    async ({ access, client }) => {
      const role = access.client_memberships.find((m) => m.client_id === client.id)?.role;
      const canWrite = role === "client_owner" || role === "client_staff";
      const canDelete = role === "client_owner";
      const contacts = await listContacts(client.id);
      return (
        <>
          <Section title="Contacts">
            <DataTable
              caption="Business contacts"
              rows={contacts}
              rowKey={(c) => c.id}
              empty="No contacts yet."
              columns={[
                { header: "Name", cell: (c) => c.full_name },
                { header: "Position", cell: (c) => c.position ?? "—" },
                { header: "Email", cell: (c) => c.email ?? "—" },
                { header: "Phone", cell: (c) => c.phone ?? "—" },
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
                            <input type="hidden" name="clientId" value={client.id} />
                            <input type="hidden" name="contactId" value={c.id} />
                          </ActionForm>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Section>
          {canWrite ? (
            <Section title="Add a contact">
              <ActionForm action={createContactAction} submitLabel="Add contact">
                <input type="hidden" name="clientId" value={client.id} />
                <Field label="Full name" name="fullName" required autoComplete="name" />
                <Field label="Position" name="position" />
                <Field label="Email" name="email" type="email" autoComplete="email" />
                <Field label="Phone" name="phone" type="tel" autoComplete="tel" />
              </ActionForm>
            </Section>
          ) : null}
        </>
      );
    },
  );
}
