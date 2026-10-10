import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { listContacts, listMembers } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Business overview" };

export default function ClientOverviewPage({ params }: PageProps<"/portal/[clientId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Overview params={params} />
    </Suspense>
  );
}

async function Overview({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage("portal.client", clientId, "Overview", async ({ client }) => {
    const [contacts, members] = await Promise.all([
      listContacts(client.id),
      listMembers(client.id),
    ]);
    return (
      <>
        <Section title="At a glance">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-[var(--muted)]">Status</dt>
              <dd>{client.status}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Team members</dt>
              <dd>{members.length}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Business contacts</dt>
              <dd>{contacts.length}</dd>
            </div>
          </dl>
        </Section>
        <Alert title="Coming in later phases">
          Document uploads, requests from your accountant, financial statements and tax filings will
          appear here as those features are delivered.
        </Alert>
      </>
    );
  });
}
