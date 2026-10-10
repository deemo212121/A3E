import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { Timeline } from "@/features/intake/components/intake-ui";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { CreditNoteForm } from "@/features/sales/components/credit-note-form";
import { InvoiceForm } from "@/features/sales/components/invoice-form";
import { DocActions, DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { formatAmount } from "@/lib/money/amount";
import { TAX_CLASSES, type TaxClass } from "@/lib/sales/calc";
import { getTimeline, listCounterparties } from "@/server/data/intake";
import { listAccounts } from "@/server/data/ledger";
import { getBalances, getInvoice } from "@/server/data/sales";

export const metadata: Metadata = { title: "Sales invoice" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const taxLabel = (v: string) => TAX_CLASSES.find((t) => t.value === v)?.label ?? v;

export default function InvoicePage({
  params,
}: PageProps<"/staff/clients/[clientId]/sales/invoices/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Invoice params={params} />
    </Suspense>
  );
}

async function Invoice({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.sales_invoice",
    { clientId },
    "Sales invoice",
    async ({ access, client }) => {
      const inv = UUID.test(itemId) ? await getInvoice(client.id, itemId.toLowerCase()) : null;
      if (!inv) return <NotFoundState />;
      const base = pathFor("staff.sales", { clientId: client.id });
      const balance =
        inv.status === "posted"
          ? (await getBalances(client.id, "2100-12-31")).find((b) => b.invoice_id === inv.id)
          : undefined;
      const timeline = await getTimeline(client.id, "sales_invoice", inv.id);
      const amountRow = (label: string, v: string, strong = false) =>
        v !== "0.00" || strong ? (
          <div className="flex justify-between gap-6">
            <dt className="text-[var(--muted)]">{label}</dt>
            <dd className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{formatAmount(v)}</dd>
          </div>
        ) : null;

      return (
        <>
          <div className="mb-4">
            <LinkButton href={base}>← Sales</LinkButton>
          </div>
          <Section title={`Invoice ${inv.invoice_no}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <DocStatus status={inv.status} />
              <span>
                {inv.customer} · {inv.invoice_date} · due {inv.due_date} · {inv.sale_type} sale ·
                prices {inv.prices_include_vat ? "include" : "exclude"} VAT
              </span>
            </div>
            {inv.review_comment && inv.status === "draft" ? (
              <div className="mb-3">
                <Alert tone="warning" title="Returned by the reviewer">
                  {inv.review_comment}
                </Alert>
              </div>
            ) : null}
            {inv.cancel_reason ? (
              <p className="mb-3 text-sm">Cancelled: {inv.cancel_reason}</p>
            ) : null}
            <DataTable
              caption="Invoice lines"
              rows={inv.lines}
              rowKey={(l) => String(l.line_no)}
              columns={[
                { header: "Description", cell: (l) => l.description },
                {
                  header: "Qty",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (l) => l.quantity.replace(/\.?0+$/, ""),
                },
                {
                  header: "Unit price",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (l) => l.unit_price.replace(/(\.\d\d)0+$/, "$1"),
                },
                {
                  header: "Discount",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (l) =>
                    l.discount_amount === "0.00" ? "" : formatAmount(l.discount_amount),
                },
                { header: "Tax", cell: (l) => taxLabel(l.tax_class) },
                { header: "Net", kind: "num", cell: (l) => formatAmount(l.net_amount) },
                { header: "VAT", kind: "num", cell: (l) => formatAmount(l.vat_amount) },
              ]}
            />
            <dl className="mt-3 ml-auto flex max-w-xs flex-col gap-1 text-sm">
              {amountRow("VATable sales", inv.vatable_sales)}
              {amountRow("Zero-rated sales", inv.zero_rated_sales)}
              {amountRow("VAT-exempt sales", inv.exempt_sales)}
              {amountRow("Sales (non-VAT seller)", inv.not_subject_sales)}
              {amountRow(`VAT (${(Number(inv.vat_rate) * 100).toFixed(0)}%)`, inv.vat_amount)}
              {amountRow("Amount due", inv.total_amount, true)}
              {balance ? amountRow("Balance now", balance.outstanding, true) : null}
            </dl>
            <p className="mt-2 text-xs text-[var(--muted)]">
              VAT rate{" "}
              {inv.vat_rate_status === "signed_off" ? "signed off" : "pending CPA sign-off"}. This
              is a record of the client&apos;s invoice, not an invoice.
            </p>
            {inv.journal_entry_id ? (
              <p className="mt-2 text-sm">
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: inv.journal_entry_id,
                  })}
                >
                  Journal entry
                </Link>
                {inv.cancel_journal_entry_id ? (
                  <>
                    {" "}
                    ·{" "}
                    <Link
                      className="underline"
                      href={pathFor("staff.entry", {
                        clientId: client.id,
                        entryId: inv.cancel_journal_entry_id,
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
              subject="sales_invoice"
              id={inv.id}
              status={inv.status}
              preparedBy={inv.prepared_by}
              label="invoice"
            />
          </Section>

          {inv.status === "posted" || inv.payments.length > 0 || inv.credit_notes.length > 0 ? (
            <Section title="Payments and credit notes">
              <DataTable
                caption="Payments and credit notes"
                rows={[
                  ...inv.payments.map((p) => ({
                    key: `p${p.receipt_id}`,
                    date: p.receipt_date,
                    doc: (
                      <Link
                        className="underline"
                        href={pathFor("staff.sales_receipt", {
                          clientId: client.id,
                          itemId: p.receipt_id,
                        })}
                      >
                        Receipt {p.receipt_no}
                      </Link>
                    ),
                    status: p.status,
                    amount: p.amount,
                    cn: null,
                  })),
                  ...inv.credit_notes.map((c) => ({
                    key: `c${c.id}`,
                    date: c.credit_date,
                    doc: (
                      <>
                        Credit note {c.credit_note_no} — {c.reason}
                      </>
                    ),
                    status: c.status,
                    amount: c.total_amount,
                    cn: c,
                  })),
                ]}
                rowKey={(r) => r.key}
                empty="None yet."
                columns={[
                  { header: "Date", kind: "nowrap", cell: (r) => r.date },
                  { header: "Document", cell: (r) => r.doc },
                  { header: "Amount", kind: "num", cell: (r) => formatAmount(r.amount) },
                  { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
                  {
                    header: "Actions",
                    srOnlyHeader: true,
                    cell: (r) =>
                      r.cn && r.cn.status !== "cancelled" ? (
                        <DocActions
                          access={access}
                          clientId={client.id}
                          subject="credit_note"
                          id={r.cn.id}
                          status={r.cn.status}
                          preparedBy={r.cn.prepared_by}
                          label="credit note"
                        />
                      ) : null,
                  },
                ]}
              />
              {inv.status === "posted" && balance && balance.outstanding !== "0.00" ? (
                <details className="mt-4 rounded-md border border-[var(--border)] p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Record a credit note (return, adjustment, correction)
                  </summary>
                  <div className="mt-3">
                    <CreditNoteForm
                      clientId={client.id}
                      invoiceId={inv.id}
                      idempotencyKey={randomUUID()}
                      today={todayPh()}
                      taxClasses={[...new Set(inv.lines.map((l) => l.tax_class as TaxClass))]}
                      pricesIncludeVat={inv.prices_include_vat}
                      vatRate={inv.vat_rate}
                      outstanding={balance.outstanding}
                    />
                  </div>
                </details>
              ) : null}
            </Section>
          ) : null}

          <Section title="History">
            <Timeline items={timeline} />
          </Section>

          {inv.status === "draft" ? (
            <Section title="Edit draft">
              <InvoiceForm
                clientId={client.id}
                idempotencyKey={randomUUID()}
                today={todayPh()}
                customers={(await listCounterparties(client.id, ["approved"]))
                  .filter((c) => c.kind !== "supplier")
                  .map((c) => ({ id: c.id, name: c.registered_name, terms: null }))}
                revenueAccounts={(await listAccounts(client.id))
                  .filter((a) => a.account_type === "revenue" && a.is_postable && a.is_active)
                  .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
                vatRate={{ rate: inv.vat_rate, status: inv.vat_rate_status }}
                initial={{
                  invoiceId: inv.id,
                  rowVersion: inv.row_version,
                  counterpartyId: inv.counterparty_id,
                  invoiceNo: inv.invoice_no,
                  invoiceDate: inv.invoice_date,
                  dueDate: inv.sale_type === "credit" ? inv.due_date : "",
                  saleType: inv.sale_type,
                  pricesIncludeVat: inv.prices_include_vat,
                  memo: inv.memo ?? "",
                  intakeTransactionId: inv.intake_transaction_id ?? "",
                  lines: inv.lines.map((l) => ({
                    description: l.description,
                    quantity: l.quantity,
                    unit_price: l.unit_price,
                    discount_amount: l.discount_amount === "0.00" ? "" : l.discount_amount,
                    tax_class: l.tax_class as TaxClass,
                    revenue_account_id: l.revenue_account_id ?? "",
                  })),
                }}
              />
            </Section>
          ) : null}
        </>
      );
    },
  );
}
