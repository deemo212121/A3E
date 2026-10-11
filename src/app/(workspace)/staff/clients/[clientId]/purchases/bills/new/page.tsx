import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { BillForm } from "@/features/purchases/components/bill-form";
import { todayPh } from "@/lib/intake/rules";
import { getTransaction, listCounterparties, listDocuments } from "@/server/data/intake";
import { listAccounts } from "@/server/data/ledger";
import { listCategories, listWithholdingCodes } from "@/server/data/purchases";
import { getVatRate } from "@/server/data/sales";

export const metadata: Metadata = { title: "Record bill or expense" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Props = PageProps<"/staff/clients/[clientId]/purchases/bills/new">;

export default function NewBillPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewBill params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function NewBill({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.purchase_bill_new",
    { clientId },
    "Record bill or expense",
    async ({ client }) => {
      const intakeId =
        typeof sp.intake === "string" && UUID.test(sp.intake) ? sp.intake.toLowerCase() : null;
      const [parties, categories, codes, accounts, docs, vat, txn] = await Promise.all([
        listCounterparties(client.id, ["approved"]),
        listCategories(client.id),
        listWithholdingCodes(),
        listAccounts(client.id),
        listDocuments(client.id),
        getVatRate(),
        intakeId ? getTransaction(client.id, intakeId) : null,
      ]);
      const approved = categories.filter((c) => c.status === "approved");
      const fromIntake =
        txn &&
        ["purchase", "expense"].includes(txn.kind) &&
        txn.status === "approved" &&
        !txn.journal_entry_id
          ? txn
          : null;
      return (
        <Section title="Record a supplier bill, cash purchase or reimbursement">
          {approved.length === 0 ? (
            <div className="mb-4">
              <Alert tone="warning">
                No approved purchase categories yet. Set them up under Purchases → Categories &amp;
                accounts.
              </Alert>
            </div>
          ) : null}
          <BillForm
            clientId={client.id}
            idempotencyKey={randomUUID()}
            today={todayPh()}
            payees={parties.map((p) => ({ id: p.id, name: p.registered_name, kind: p.kind }))}
            categories={approved.map((c) => ({
              id: c.id,
              label: `${c.name} (${c.kind.replace("_", " ")})`,
            }))}
            codes={codes
              .filter((c) => c.status !== "retired")
              .map((c) => ({
                id: c.id,
                label: `${c.code} v${c.version} · ${c.description}`,
                rate: c.rate,
                base: c.base,
                signedOff: c.status === "signed_off",
              }))}
            cashAccounts={accounts
              .filter((a) => a.account_type === "asset" && a.is_postable && a.is_active)
              .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            documents={docs.map((d) => ({ id: d.id, name: d.original_filename }))}
            vatRate={{ rate: vat.rate, status: vat.verification_status }}
            intake={
              fromIntake
                ? {
                    id: fromIntake.id,
                    counterpartyId: fromIntake.counterparty_id ?? "",
                    billNo: fromIntake.document_ref ?? "",
                    date: fromIntake.txn_date ?? todayPh(),
                    lines: fromIntake.lines.map((l) => ({
                      description: l.description ?? "",
                      quantity: "1",
                      unit_price: l.amount,
                      discount_amount: "",
                      tax_class: "vatable" as const,
                      vat_category: "goods",
                      category_id: "",
                      withholding_code_id: "",
                      source_supplier_name: "",
                      source_supplier_tin: "",
                      source_document_ref: "",
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
