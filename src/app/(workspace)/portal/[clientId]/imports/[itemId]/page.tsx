import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { LinkButton, PageSkeleton } from "@/components/ui/primitives";
import { ImportBatchView } from "@/features/intake/imports-view";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";
import { getImport } from "@/server/data/intake";

export const metadata: Metadata = { title: "Import" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Props = PageProps<"/portal/[clientId]/imports/[itemId]">;

export default function ImportPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ImportBatch params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ImportBatch({ params, searchParams }: Props) {
  const { clientId, itemId } = await params;
  const sp = await searchParams;
  return renderClientPortalPage("portal.import", clientId, "Import", async ({ access, client }) => {
    const batch = UUID.test(itemId) ? await getImport(client.id, itemId.toLowerCase()) : null;
    if (!batch) return <NotFoundState />;
    const basePath = pathFor("portal.import", { clientId: client.id, itemId: batch.id });
    return (
      <>
        <div className="mb-4">
          <LinkButton href={pathFor("portal.imports", { clientId: client.id })}>
            ← All imports
          </LinkButton>
        </div>
        <ImportBatchView
          access={access}
          clientId={client.id}
          batch={batch}
          view={typeof sp.view === "string" ? sp.view : undefined}
          basePath={basePath}
        />
      </>
    );
  });
}
