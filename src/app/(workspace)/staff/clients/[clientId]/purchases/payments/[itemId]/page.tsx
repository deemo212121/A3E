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
import { getPayment } from "@/server/data/purchases";

export const metadata: Metadata = { title: "Supplier payment" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PaymentPage({
  params,
}: PageProps<"/staff/clients/[clientId]/purchases/payments/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Payment params={params} />
    </Suspense>
  );
}

async function Payment({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.supplier_payment",
    { clientId },
    "Supplier payment",
    async ({ access, client }) => {
      const p = UUID.test(itemId) ? await getPayment(client.id, itemId.toLowerCase()) : null;
      if (!p) return <NotFoundState />;
      const applied = p.allocations.reduce((s, a) => s + toCentavos(a.amount), 0n);
      const timeline = await getTimeline(client.id, "supplier_payment", p.id);
      return (
        <>
          <div className="mb-4">
            <LinkButton
              href={`${pathFor("staff.purchases", { clientId: client.id })}?tab=payments`}
            >
              ← Payments
            </LinkButton>
          </div>
          <Section title={`Payment ${p.payment_no}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <DocStatus status={p.status} />
              <span>
                {p.supplier} · {p.payment_date} · {p.payment_method.replace("_", " ")}
                {p.reference ? ` · ref ${p.reference}` : ""}
              </span>
            </div>
            {p.review_comment && p.status === "draft" ? (
              <div className="mb-3">
                <Alert tone="warning" title="Returned by the reviewer">
                  {p.review_comment}
                </Alert>
              </div>
            ) : null}
            {p.cancel_reason ? <p className="mb-3 text-sm">Cancelled: {p.cancel_reason}</p> : null}
            <p className="mb-3 text-sm tabular-nums">
              Paid {formatAmount(p.amount_paid)} · applied {formatAmount(fromCentavos(applied))} ·
              advance {formatAmount(fromCentavos(toCentavos(p.amount_paid) - applied))}
            </p>
            <DataTable
              caption="Applied to bills"
              rows={p.allocations}
              rowKey={(a) => a.bill_id}
              empty="Not applied to any bill (recorded as an advance to the supplier)."
              columns={[
                {
                  header: "Bill",
                  cell: (a) => (
                    <Link
                      className="underline"
                      href={pathFor("staff.purchase_bill", {
                        clientId: client.id,
                        itemId: a.bill_id,
                      })}
                    >
                      {a.bill_no}
                    </Link>
                  ),
                },
                { header: "Amount", kind: "num", cell: (a) => formatAmount(a.amount) },
              ]}
            />
            {p.journal_entry_id ? (
              <p className="mt-2 text-sm">
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: p.journal_entry_id,
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
              subject="supplier_payment"
              id={p.id}
              status={p.status}
              preparedBy={p.prepared_by}
              label="payment"
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
