import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { PaymentForm } from "@/features/purchases/components/payment-form";
import { todayPh } from "@/lib/intake/rules";
import { listCounterparties } from "@/server/data/intake";
import { listAccounts } from "@/server/data/ledger";
import { getPayables } from "@/server/data/purchases";

export const metadata: Metadata = { title: "Record supplier payment" };

export default function NewPaymentPage({
  params,
}: PageProps<"/staff/clients/[clientId]/purchases/payments/new">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewPayment params={params} />
    </Suspense>
  );
}

async function NewPayment({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage(
    "staff.supplier_payment_new",
    { clientId },
    "Record supplier payment",
    async ({ client }) => {
      const [parties, accounts, payables] = await Promise.all([
        listCounterparties(client.id, ["approved"]),
        listAccounts(client.id),
        getPayables(client.id, "2100-12-31"),
      ]);
      return (
        <Section title="Record a payment to a supplier or payee">
          <PaymentForm
            clientId={client.id}
            idempotencyKey={randomUUID()}
            today={todayPh()}
            payees={parties
              .filter((p) => p.kind !== "customer")
              .map((p) => ({ id: p.id, name: p.registered_name }))}
            cashAccounts={accounts
              .filter((a) => a.account_type === "asset" && a.is_postable && a.is_active)
              .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            openBills={payables.filter((b) => b.outstanding !== "0.00")}
          />
        </Section>
      );
    },
  );
}
