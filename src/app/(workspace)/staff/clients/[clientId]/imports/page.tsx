import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ui/primitives";
import { ImportsList } from "@/features/intake/imports-view";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor } from "@/lib/access/route-policy";

export const metadata: Metadata = { title: "Imports" };

export default function StaffImportsPage({
  params,
}: PageProps<"/staff/clients/[clientId]/imports">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StaffImports params={params} />
    </Suspense>
  );
}

async function StaffImports({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage("staff.imports", { clientId }, "Imports", ({ access, client }) => (
    <ImportsList
      access={access}
      clientId={client.id}
      batchHref={(id) => pathFor("staff.import", { clientId: client.id, itemId: id })}
    />
  ));
}
