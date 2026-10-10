import type { Metadata } from "next";
import { Suspense } from "react";

import { DataTable } from "@/components/ui/data-table";
import { DemoNotice, EmptyState, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { DEMO_DOCUMENTS, demoEnabled } from "@/server/demo/demo-data";

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
  return renderClientPortalPage("portal.documents", clientId, "Documents", () => (
    <>
      <EmptyState title="Document uploads are not available yet">
        Secure uploads of invoices, receipts and certificates will be delivered in a later phase.
      </EmptyState>
      {demoEnabled() ? (
        <Section title="Preview of the documents list">
          <DemoNotice>Example rows showing how uploaded documents will be listed.</DemoNotice>
          <div className="mt-3">
            <DataTable
              caption="Demo documents"
              rows={DEMO_DOCUMENTS}
              rowKey={(d) => d.id}
              columns={[
                { header: "File", cell: (d) => d.name },
                { header: "Category", cell: (d) => d.category },
                { header: "Status", cell: (d) => d.status },
              ]}
            />
          </div>
        </Section>
      ) : null}
    </>
  ));
}
