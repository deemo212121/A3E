import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { InvoiceForm } from "@/features/sales/components/invoice-form";
import { todayPh } from "@/lib/intake/rules";
import { getTransaction, listCounterparties } from "@/server/data/intake";
import { listAccounts } from "@/server/data/ledger";
import { getVatRate } from "@/server/data/sales";

export const metadata: Metadata = { title: "Record sales invoice" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Props = PageProps<"/staff/clients/[clientId]/sales/invoices/new">;

export default function NewInvoicePage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewInvoice params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function NewInvoice({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.sales_invoice_new",
    { clientId },
    "Record sales invoice",
    async ({ client }) => {
      const intakeId =
        typeof sp.intake === "string" && UUID.test(sp.intake) ? sp.intake.toLowerCase() : null;
      const [parties, accounts, vat, txn] = await Promise.all([
        listCounterparties(client.id, ["approved"]),
        listAccounts(client.id),
        getVatRate(),
        intakeId ? getTransaction(client.id, intakeId) : null,
      ]);
      const customers = parties.filter((c) => c.kind === "customer" || c.kind === "both");
      const fromIntake =
        txn && txn.kind === "sale" && txn.status === "approved" && !txn.journal_entry_id
          ? txn
          : null;
      return (
        <Section title="Record a sales invoice">
          <div className="mb-4">
            <Alert tone="info" title="Recording only">
              Enter an invoice the client already issued (its own invoice number). The platform does
              not issue invoices or transmit e-invoices to the BIR.
            </Alert>
          </div>
          {customers.length === 0 ? (
            <Alert tone="warning">
              Add and approve the customer first (Intake → Customers &amp; suppliers).
            </Alert>
          ) : null}
          <InvoiceForm
            clientId={client.id}
            idempotencyKey={randomUUID()}
            today={todayPh()}
            customers={customers.map((c) => ({ id: c.id, name: c.registered_name, terms: null }))}
            revenueAccounts={accounts
              .filter((a) => a.account_type === "revenue" && a.is_postable && a.is_active)
              .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            vatRate={{ rate: vat.rate, status: vat.verification_status }}
            initial={
              fromIntake
                ? {
                    counterpartyId: fromIntake.counterparty_id ?? "",
                    invoiceNo: fromIntake.document_ref ?? "",
                    invoiceDate: fromIntake.txn_date ?? todayPh(),
                    dueDate: "",
                    saleType: "credit",
                    pricesIncludeVat: true,
                    memo: fromIntake.description ?? "",
                    intakeTransactionId: fromIntake.id,
                    lines: fromIntake.lines.map((l) => ({
                      description: l.description ?? "Item",
                      quantity: l.quantity ?? "1",
                      unit_price: l.quantity && l.unit_price ? l.unit_price : l.amount,
                      discount_amount: "",
                      tax_class: "vatable" as const,
                      revenue_account_id: "",
                    })),
                  }
                : undefined
            }
          />
        </Section>
      );
    },
  );
}
