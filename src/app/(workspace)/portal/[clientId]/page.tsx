import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, LinkButton, PageSkeleton, Section, StatCard } from "@/components/ui/primitives";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";
import { getIntakeSummary } from "@/server/data/intake";
import { canWriteIntake } from "@/server/intake/access";
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
  return renderClientPortalPage(
    "portal.client",
    clientId,
    "Overview",
    async ({ access, client }) => {
      const [contacts, members, intake] = await Promise.all([
        listContacts(client.id),
        listMembers(client.id),
        getIntakeSummary(client.id),
      ]);
      const t = intake.transactions;
      const writer = canWriteIntake(access, client.id);
      const href = (route: Parameters<typeof pathFor>[0], q = "") =>
        pathFor(route, { clientId: client.id }) + q;
      return (
        <>
          {(t.needs_correction ?? 0) > 0 ? (
            <div className="mb-4">
              <Alert
                tone="warning"
                title={`${t.needs_correction} transaction(s) need your correction`}
              >
                The firm returned them with a comment.{" "}
                <LinkButton href={href("portal.transactions", "?status=needs_correction")}>
                  Review them
                </LinkButton>
              </Alert>
            </div>
          ) : null}
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Drafts (not yet sent)"
              value={t.draft ?? 0}
              href={href("portal.transactions", "?status=draft")}
            />
            <StatCard
              label="With the firm for review"
              value={(t.submitted ?? 0) + (t.reviewed ?? 0)}
              href={href("portal.transactions", "?status=submitted")}
            />
            <StatCard
              label="Approved or posted"
              value={(t.approved ?? 0) + (t.posted ?? 0)}
              tone="success"
              href={href("portal.transactions", "?status=approved")}
            />
            <StatCard
              label="Documents uploaded"
              value={Object.values(intake.documents).reduce((a, b) => a + b, 0)}
              href={href("portal.documents")}
            />
          </div>
          {writer ? (
            <Section title="Send records to your accountant">
              <div className="flex flex-wrap gap-2">
                <LinkButton href={href("portal.transaction_new")} variant="primary">
                  + Record a transaction
                </LinkButton>
                <LinkButton href={href("portal.documents")}>
                  Upload receipts and invoices
                </LinkButton>
                <LinkButton href={href("portal.imports")}>Import a spreadsheet</LinkButton>
                <LinkButton href={href("portal.counterparties")}>
                  Customers and suppliers
                </LinkButton>
              </div>
            </Section>
          ) : null}
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
            Requests from your accountant, financial statements and tax filings will appear here as
            those features are delivered.
          </Alert>
        </>
      );
    },
  );
}
