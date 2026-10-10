import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { Timeline } from "@/features/intake/components/intake-ui";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { DocActions, DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount, fromCentavos, toCentavos } from "@/lib/money/amount";
import { getTimeline } from "@/server/data/intake";
import { getReceipt } from "@/server/data/sales";

export const metadata: Metadata = { title: "Customer receipt" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ReceiptPage({
  params,
}: PageProps<"/staff/clients/[clientId]/sales/receipts/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Receipt params={params} />
    </Suspense>
  );
}

async function Receipt({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.sales_receipt",
    { clientId },
    "Customer receipt",
    async ({ access, client }) => {
      const r = UUID.test(itemId) ? await getReceipt(client.id, itemId.toLowerCase()) : null;
      if (!r) return <NotFoundState />;
      const applied = r.allocations.reduce((s, a) => s + toCentavos(a.amount), 0n);
      const unapplied = toCentavos(r.amount_received) + toCentavos(r.withholding_amount) - applied;
      const timeline = await getTimeline(client.id, "sales_receipt", r.id);
      return (
        <>
          <div className="mb-4">
            <LinkButton href={`${pathFor("staff.sales", { clientId: client.id })}?tab=receipts`}>
              ← Receipts
            </LinkButton>
          </div>
          <Section title={`Receipt ${r.receipt_no}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <DocStatus status={r.status} />
              <span>
                {r.customer} · {r.receipt_date} · {r.payment_method.replace("_", " ")}
                {r.reference ? ` · ref ${r.reference}` : ""}
              </span>
            </div>
            {r.review_comment && r.status === "draft" ? (
              <div className="mb-3">
                <Alert tone="warning" title="Returned by the reviewer">
                  {r.review_comment}
                </Alert>
              </div>
            ) : null}
            {r.cancel_reason ? <p className="mb-3 text-sm">Cancelled: {r.cancel_reason}</p> : null}
            <dl className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-[var(--muted)]">Received</dt>
                <dd className="tabular-nums">{formatAmount(r.amount_received)}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Withheld (as stated)</dt>
                <dd className="tabular-nums">{formatAmount(r.withholding_amount)}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Applied</dt>
                <dd className="tabular-nums">{formatAmount(fromCentavos(applied))}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Customer advance</dt>
                <dd className="tabular-nums">{formatAmount(fromCentavos(unapplied))}</dd>
              </div>
            </dl>
            <DataTable
              caption="Applied to invoices"
              rows={r.allocations}
              rowKey={(a) => a.invoice_id}
              empty="Not applied to any invoice (recorded as a customer advance)."
              columns={[
                {
                  header: "Invoice",
                  cell: (a) => (
                    <Link
                      className="underline"
                      href={pathFor("staff.sales_invoice", {
                        clientId: client.id,
                        itemId: a.invoice_id,
                      })}
                    >
                      {a.invoice_no}
                    </Link>
                  ),
                },
                { header: "Amount", kind: "num", cell: (a) => formatAmount(a.amount) },
              ]}
            />
            {r.journal_entry_id ? (
              <p className="mt-2 text-sm">
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: r.journal_entry_id,
                  })}
                >
                  Journal entry
                </Link>
              </p>
            ) : null}
          </Section>
          <Section title="Workflow">
            <DocActions
              access={access}
              clientId={client.id}
              subject="sales_receipt"
              id={r.id}
              status={r.status}
              preparedBy={r.prepared_by}
              label="receipt"
            />
          </Section>
          <Section title="History">
            <Timeline items={timeline} />
          </Section>
        </>
      );
    },
  );
}
