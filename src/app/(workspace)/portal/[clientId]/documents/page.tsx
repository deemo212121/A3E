import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { DocumentsView } from "@/features/intake/documents-view";
import { renderClientPortalPage } from "@/features/portal/client-page";

export const metadata: Metadata = { title: "Documents" };

export default function DocumentsPage({ params }: PageProps<"/portal/[clientId]/documents">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Documents params={params} />
    </Suspense>
  );
}

async function Documents({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage("portal.documents", clientId, "Documents", ({ access, client }) => (
    <DocumentsView access={access} clientId={client.id} />
  ));
}
