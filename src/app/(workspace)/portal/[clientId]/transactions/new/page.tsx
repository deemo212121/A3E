import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton, Section } from "@/components/ui/primitives";
import { TransactionForm } from "@/features/intake/components/transaction-form";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { listCounterparties, listDocuments } from "@/server/data/intake";

export const metadata: Metadata = { title: "New transaction" };

export default function NewTransactionPage({
  params,
}: PageProps<"/portal/[clientId]/transactions/new">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewTransaction params={params} />
    </Suspense>
  );
}

async function NewTransaction({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage(
    "portal.transaction_new",
    clientId,
    "New transaction",
    async ({ client }) => {
      const [parties, docs] = await Promise.all([
        listCounterparties(client.id, ["approved", "submitted"]),
        listDocuments(client.id),
      ]);
      return (
        <Section title="Record a sale, purchase, expense or payment">
          <TransactionForm
            clientId={client.id}
            idempotencyKey={randomUUID()}
            today={todayPh()}
            documentsHref={pathFor("portal.documents", { clientId: client.id })}
            counterparties={parties.map((c) => ({
              id: c.id,
              name: c.registered_name,
              tin: c.tin,
              kind: c.kind,
            }))}
            documents={docs.map((d) => ({
              id: d.id,
              name: d.original_filename,
              category: d.category,
            }))}
          />
        </Section>
      );
    },
  );
}
