import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { CounterpartiesView } from "@/features/intake/counterparties-view";
import { renderClientPortalPage } from "@/features/portal/client-page";

export const metadata: Metadata = { title: "Customers and suppliers" };

export default function CounterpartiesPage({
  params,
}: PageProps<"/portal/[clientId]/counterparties">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Counterparties params={params} />
    </Suspense>
  );
}

async function Counterparties({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage(
    "portal.counterparties",
    clientId,
    "Customers and suppliers",
    ({ access, client }) => <CounterpartiesView access={access} clientId={client.id} />,
  );
}
