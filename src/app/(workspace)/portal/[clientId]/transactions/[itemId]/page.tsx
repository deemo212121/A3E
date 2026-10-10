import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { LinkButton, PageSkeleton } from "@/components/ui/primitives";
import { TransactionDetail } from "@/features/intake/transaction-detail";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";

export const metadata: Metadata = { title: "Transaction" };

export default function TransactionPage({
  params,
}: PageProps<"/portal/[clientId]/transactions/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Transaction params={params} />
    </Suspense>
  );
}

async function Transaction({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderClientPortalPage(
    "portal.transaction",
    clientId,
    "Transaction",
    async ({ access, client }) => {
      const body = await TransactionDetail({
        access,
        clientId: client.id,
        id: itemId.toLowerCase(),
      });
      if (!body) return <NotFoundState />;
      return (
        <>
          <div className="mb-4">
            <LinkButton href={pathFor("portal.transactions", { clientId: client.id })}>
              ← All transactions
            </LinkButton>
          </div>
          {body}
        </>
      );
    },
  );
}
