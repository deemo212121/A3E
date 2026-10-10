import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { LinkButton, PageSkeleton } from "@/components/ui/primitives";
import { TransactionDetail } from "@/features/intake/transaction-detail";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor } from "@/lib/access/route-policy";

export const metadata: Metadata = { title: "Intake transaction" };

export default function StaffTransactionPage({
  params,
}: PageProps<"/staff/clients/[clientId]/intake/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <StaffTransaction params={params} />
    </Suspense>
  );
}

async function StaffTransaction({
  params,
}: {
  params: Promise<{ clientId: string; itemId: string }>;
}) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.intake_txn",
    { clientId },
    "Intake transaction",
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
            <LinkButton href={pathFor("staff.intake", { clientId: client.id })}>
              ← Intake
            </LinkButton>
          </div>
          {body}
        </>
      );
    },
  );
}
