import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { Suspense } from "react";

import { PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { ReceiptForm } from "@/features/sales/components/receipt-form";
import { todayPh } from "@/lib/intake/rules";
import { listCounterparties } from "@/server/data/intake";
import { listAccounts } from "@/server/data/ledger";
import { getBalances } from "@/server/data/sales";

export const metadata: Metadata = { title: "Record customer receipt" };

export default function NewReceiptPage({
  params,
}: PageProps<"/staff/clients/[clientId]/sales/receipts/new">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewReceipt params={params} />
    </Suspense>
  );
}

async function NewReceipt({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage(
    "staff.sales_receipt_new",
    { clientId },
    "Record customer receipt",
    async ({ client }) => {
      const [parties, accounts, balances] = await Promise.all([
        listCounterparties(client.id, ["approved"]),
        listAccounts(client.id),
        getBalances(client.id, "2100-12-31"),
      ]);
      return (
        <Section title="Record a payment from a customer">
          <ReceiptForm
            clientId={client.id}
            idempotencyKey={randomUUID()}
            today={todayPh()}
            customers={parties
              .filter((c) => c.kind !== "supplier")
              .map((c) => ({ id: c.id, name: c.registered_name }))}
            depositAccounts={accounts
              .filter((a) => a.account_type === "asset" && a.is_postable && a.is_active)
              .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            openInvoices={balances.filter((b) => b.outstanding !== "0.00")}
          />
        </Section>
      );
    },
  );
}
