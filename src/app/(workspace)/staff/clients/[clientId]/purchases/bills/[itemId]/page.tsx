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
import { formatAmount } from "@/lib/money/amount";
import { TAX_CLASSES } from "@/lib/sales/calc";
import { getTimeline } from "@/server/data/intake";
import { getBill } from "@/server/data/purchases";

export const metadata: Metadata = { title: "Bill" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const taxLabel = (v: string) => TAX_CLASSES.find((t) => t.value === v)?.label ?? v;

export default function BillPage({
  params,
}: PageProps<"/staff/clients/[clientId]/purchases/bills/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Bill params={params} />
    </Suspense>
  );
}

async function Bill({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.purchase_bill",
    { clientId },
    "Bill",
    async ({ access, client }) => {
      const b = UUID.test(itemId) ? await getBill(client.id, itemId.toLowerCase()) : null;
      if (!b) return <NotFoundState />;
      const timeline = await getTimeline(client.id, "purchase_bill", b.id);
      const row = (label: string, v: string, strong = false) => (
        <div className="flex justify-between gap-6">
          <dt className="text-[var(--muted)]">{label}</dt>
          <dd className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{formatAmount(v)}</dd>
        </div>
      );
      return (
        <>
          <div className="mb-4">
            <LinkButton href={pathFor("staff.purchases", { clientId: client.id })}>
              ← Purchases
            </LinkButton>
          </div>
          <Section
            title={`${b.bill_type === "reimbursement" ? "Reimbursement" : b.bill_type === "cash_purchase" ? "Cash purchase" : "Bill"} ${b.bill_no}`}
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <DocStatus status={b.status} />
              <span>
                {b.supplier} · {b.bill_date} · due {b.due_date} · amounts{" "}
                {b.prices_include_vat ? "include" : "exclude"} VAT
              </span>
            </div>
            {b.policy_flags.length ? (
              <div className="mb-3">
                <Alert tone="warning" title="Policy check">
                  {b.policy_flags.join(" · ")}
                </Alert>
              </div>
            ) : null}
            {b.review_comment && b.status === "draft" ? (
              <div className="mb-3">
                <Alert tone="warning" title="Returned by the reviewer">
                  {b.review_comment}
                </Alert>
              </div>
            ) : null}
            {b.cancel_reason ? <p className="mb-3 text-sm">Cancelled: {b.cancel_reason}</p> : null}
            <DataTable
              caption="Bill lines"
              rows={b.lines}
              rowKey={(l) => String(l.line_no)}
              columns={[
                {
                  header: "Description",
                  cell: (l) => (
                    <span className="flex flex-col">
                      <span>{l.description}</span>
                      {l.source_supplier_name ? (
                        <span className="text-xs text-[var(--muted)]">
                          {l.source_supplier_name}
                          {l.source_supplier_tin ? ` · TIN ${l.source_supplier_tin}` : ""}
                          {l.source_document_ref ? ` · ${l.source_document_ref}` : ""}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                { header: "Treatment", hideOnMobile: true, cell: (l) => l.kind.replace("_", " ") },
                {
                  header: "Tax",
                  cell: (l) =>
                    `${taxLabel(l.tax_class)}${l.vat_category ? ` (${l.vat_category.replace("_", " ")})` : ""}`,
                },
                { header: "Net", kind: "num", cell: (l) => formatAmount(l.net_amount) },
                { header: "VAT", kind: "num", cell: (l) => formatAmount(l.vat_amount) },
                {
                  header: "Withheld",
                  kind: "num",
                  cell: (l) =>
                    l.withholding_amount === "0.00" ? "" : formatAmount(l.withholding_amount),
                },
              ]}
            />
            <dl className="mt-3 ml-auto flex max-w-xs flex-col gap-1 text-sm">
              {row("Net", b.net_amount)}
              {row("Input VAT", b.vat_amount)}
              {row("Total", b.gross_amount)}
              {b.withholding_amount !== "0.00" ? row("Tax withheld", b.withholding_amount) : null}
              {row(b.bill_type === "cash_purchase" ? "Paid" : "To pay", b.payable_amount, true)}
            </dl>
            {b.documents.length ? (
              <p className="mt-3 text-sm">
                Supporting documents:{" "}
                {b.documents.map((d, i) => (
                  <span key={d.id}>
                    {i ? ", " : ""}
                    <a className="underline" href={`/api/documents/${d.id}`}>
                      {d.original_filename}
                    </a>
                  </span>
                ))}
              </p>
            ) : null}
            {b.journal_entry_id ? (
              <p className="mt-2 text-sm">
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: b.journal_entry_id,
                  })}
                >
                  Journal entry
                </Link>
                {b.cancel_journal_entry_id ? (
                  <>
                    {" "}
                    ·{" "}
                    <Link
                      className="underline"
                      href={pathFor("staff.entry", {
                        clientId: client.id,
                        entryId: b.cancel_journal_entry_id,
                      })}
                    >
                      reversal
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </Section>
          <Section title="Workflow">
            <DocActions
              access={access}
              clientId={client.id}
              subject="purchase_bill"
              id={b.id}
              status={b.status}
              preparedBy={b.prepared_by}
              label="bill"
            />
          </Section>
          {b.payments.length ? (
            <Section title="Payments">
              <DataTable
                caption="Payments"
                rows={b.payments}
                rowKey={(p) => p.payment_id}
                columns={[
                  { header: "Date", kind: "nowrap", cell: (p) => p.payment_date },
                  {
                    header: "Voucher",
                    cell: (p) => (
                      <Link
                        className="underline"
                        href={pathFor("staff.supplier_payment", {
                          clientId: client.id,
                          itemId: p.payment_id,
                        })}
                      >
                        {p.payment_no}
                      </Link>
                    ),
                  },
                  { header: "Amount", kind: "num", cell: (p) => formatAmount(p.amount) },
                  { header: "Status", cell: (p) => <DocStatus status={p.status} /> },
                ]}
              />
            </Section>
          ) : null}
          <Section title="History">
            <Timeline items={timeline} />
          </Section>
        </>
      );
    },
  );
}
