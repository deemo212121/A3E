import type { Metadata } from "next";
import { Suspense } from "react";

import { DataTable } from "@/components/ui/data-table";
import { DemoNotice, EmptyState, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { DEMO_REQUESTS, demoEnabled } from "@/server/demo/demo-data";

export const metadata: Metadata = { title: "Requests" };

export default function RequestsPage({ params }: PageProps<"/portal/[clientId]/requests">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Requests params={params} />
    </Suspense>
  );
}

async function Requests({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage(
    "portal.requests",
    clientId,
    "Requests from your accountant",
    () => (
      <>
        <EmptyState title="No requests yet">
          Requests for information from your accounting firm will appear here in a later phase.
        </EmptyState>
        {demoEnabled() ? (
          <Section title="Preview of the requests list">
            <DemoNotice>Example rows showing how requests will be listed.</DemoNotice>
            <div className="mt-3">
              <DataTable
                caption="Demo requests"
                rows={DEMO_REQUESTS}
                rowKey={(r) => r.id}
                columns={[
                  { header: "Request", cell: (r) => r.title },
                  { header: "Status", cell: (r) => r.status },
                  { header: "Due", cell: (r) => r.due },
                ]}
              />
            </div>
          </Section>
        ) : null}
      </>
    ),
  );
}
