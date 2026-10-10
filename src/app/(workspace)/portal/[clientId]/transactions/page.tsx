import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { NewTransactionButtons, TransactionList } from "@/features/intake/transaction-list";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";
import { canWriteIntake } from "@/server/intake/access";

export const metadata: Metadata = { title: "Transactions" };

type Props = PageProps<"/portal/[clientId]/transactions">;

export default function TransactionsPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Transactions params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Transactions({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderClientPortalPage(
    "portal.transactions",
    clientId,
    "Transactions",
    ({ access, client }) => {
      const writer = canWriteIntake(access, client.id);
      return (
        <TransactionList
          clientId={client.id}
          status={typeof sp.status === "string" ? sp.status : undefined}
          basePath={pathFor("portal.transactions", { clientId: client.id })}
          itemHref={(id) => pathFor("portal.transaction", { clientId: client.id, itemId: id })}
          actions={
            writer ? (
              <NewTransactionButtons
                newHref={pathFor("portal.transaction_new", { clientId: client.id })}
                importHref={pathFor("portal.imports", { clientId: client.id })}
              />
            ) : null
          }
        />
      );
    },
  );
}
