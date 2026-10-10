import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { ImportsList } from "@/features/intake/imports-view";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";

export const metadata: Metadata = { title: "Imports" };

export default function ImportsPage({ params }: PageProps<"/portal/[clientId]/imports">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Imports params={params} />
    </Suspense>
  );
}

async function Imports({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage("portal.imports", clientId, "Imports", ({ access, client }) => (
    <ImportsList
      access={access}
      clientId={client.id}
      batchHref={(id) => pathFor("portal.import", { clientId: client.id, itemId: id })}
    />
  ));
}
