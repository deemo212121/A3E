import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { salesSettingsAction } from "@/features/sales/actions";
import { DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { formatAmount, fromCentavos, toCentavos } from "@/lib/money/amount";
import { listAccounts } from "@/server/data/ledger";
import {
  getAging,
  getBalances,
  getReconciliation,
  getSalesSettings,
  listInvoices,
  listReceipts,
} from "@/server/data/sales";

export const metadata: Metadata = { title: "Sales & receivables" };

const TABS = [
  { key: "invoices", label: "Invoices" },
  { key: "receipts", label: "Receipts" },
  { key: "receivables", label: "Balances & aging" },
  { key: "statement", label: "Statement of account" },
  { key: "settings", label: "Posting accounts" },
] as const;

type Props = PageProps<"/staff/clients/[clientId]/sales">;

export default function SalesPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Sales params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Sales({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.sales",
    { clientId },
    "Sales & receivables",
    async ({ client }) => {
      const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as string) : "invoices";
      const base = pathFor("staff.sales", { clientId: client.id });
      const asOf =
        typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayPh();
      const settings = await getSalesSettings(client.id);
      let body: React.ReactNode = null;

      if (tab === "invoices") {
        const rows = await listInvoices(client.id);
        body = (
          <Section
            title="Sales invoices"
            actions={
              <LinkButton
                href={pathFor("staff.sales_invoice_new", { clientId: client.id })}
                variant="primary"
              >
                + Record invoice
              </LinkButton>
            }
          >
            <DataTable
              caption="Sales invoices"
              rows={rows}
              rowKey={(r) => r.id}
              empty="No invoices recorded yet."
              columns={[
                { header: "Date", kind: "nowrap", cell: (r) => r.invoice_date },
                {
                  header: "Invoice",
                  cell: (r) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.sales_invoice", { clientId: client.id, itemId: r.id })}
                    >
                      {r.invoice_no}
                    </Link>
                  ),
                },
                { header: "Customer", cell: (r) => r.customer },
                { header: "Due", kind: "nowrap", hideOnMobile: true, cell: (r) => r.due_date },
                { header: "Total", kind: "num", cell: (r) => formatAmount(r.total_amount) },
                { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
              ]}
            />
          </Section>
        );
      } else if (tab === "receipts") {
        const rows = await listReceipts(client.id);
        body = (
          <Section
            title="Customer receipts"
            actions={
              <LinkButton
                href={pathFor("staff.sales_receipt_new", { clientId: client.id })}
                variant="primary"
              >
                + Record receipt
              </LinkButton>
            }
          >
            <DataTable
              caption="Customer receipts"
              rows={rows}
              rowKey={(r) => r.id}
              empty="No receipts recorded yet."
              columns={[
                { header: "Date", kind: "nowrap", cell: (r) => r.receipt_date },
                {
                  header: "Receipt",
                  cell: (r) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.sales_receipt", { clientId: client.id, itemId: r.id })}
                    >
                      {r.receipt_no}
                    </Link>
                  ),
                },
                { header: "Customer", cell: (r) => r.customer },
                { header: "Received", kind: "num", cell: (r) => formatAmount(r.amount_received) },
                {
                  header: "Withheld",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (r) => formatAmount(r.withholding_amount),
                },
                { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
              ]}
            />
          </Section>
        );
      } else if (tab === "receivables") {
        const [aging, recon] = await Promise.all([
          getAging(client.id, asOf),
          settings ? getReconciliation(client.id, asOf) : null,
        ]);
        body = (
          <>
            <form className="mb-4 flex flex-wrap items-end gap-2" action={base}>
              <input type="hidden" name="tab" value="receivables" />
              <label className="flex flex-col gap-1 text-sm">
                <span>As of</span>
                <input
                  type="date"
                  name="asOf"
                  defaultValue={asOf}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                />
              </label>
              <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">
                Show
              </button>
            </form>
            {recon ? (
              <Section title="Ledger reconciliation">
                {recon.difference === "0.00" ? (
                  <Alert tone="success" title="Receivables agree with the general ledger">
                    Open invoices total {formatAmount(recon.subledger_total)}; the receivables
                    account shows {formatAmount(recon.ledger_balance)}.
                  </Alert>
                ) : (
                  <Alert tone="warning" title={`Difference of ${formatAmount(recon.difference)}`}>
                    Open invoices total {formatAmount(recon.subledger_total)} but the receivables
                    account shows {formatAmount(recon.ledger_balance)}. Something was posted to the
                    receivables account outside the sales module (e.g. a manual journal entry). Find
                    it in the general ledger.
                  </Alert>
                )}
              </Section>
            ) : null}
            <Section title={`Aging as of ${asOf}`}>
              <DataTable
                caption="Receivables aging"
                rows={aging}
                rowKey={(r) => r.counterparty_id}
                empty="No outstanding receivables."
                columns={[
                  {
                    header: "Customer",
                    cell: (r) => (
                      <Link
                        className="underline"
                        href={`${base}?tab=statement&customer=${r.counterparty_id}&asOf=${asOf}`}
                      >
                        {r.customer_name}
                      </Link>
                    ),
                  },
                  { header: "Not due", kind: "num", cell: (r) => formatAmount(r.not_due) },
                  { header: "1-30", kind: "num", cell: (r) => formatAmount(r.days_1_30) },
                  { header: "31-60", kind: "num", cell: (r) => formatAmount(r.days_31_60) },
                  { header: "61-90", kind: "num", cell: (r) => formatAmount(r.days_61_90) },
                  { header: "Over 90", kind: "num", cell: (r) => formatAmount(r.over_90) },
                  {
                    header: "Total",
                    kind: "num",
                    cell: (r) => <strong>{formatAmount(r.total)}</strong>,
                  },
                ]}
              />
            </Section>
          </>
        );
      } else if (tab === "statement") {
        const customer = typeof sp.customer === "string" ? sp.customer : "";
        const rows = (await getBalances(client.id, asOf)).filter(
          (b) => b.counterparty_id === customer && b.outstanding !== "0.00",
        );
        const name = rows[0]?.customer_name;
        body = (
          <Section title="Statement of account">
            {!customer ? (
              <p className="text-sm text-[var(--muted)]">
                Open it from the aging list (click a customer name).
              </p>
            ) : (
              <div className="print:text-black">
                <p className="mb-1 text-sm">
                  <strong>{client.display_name}</strong> · statement for{" "}
                  <strong>{name ?? "—"}</strong> as of {asOf}
                </p>
                <p className="mb-3 text-xs text-[var(--muted)]">
                  This is a statement of open balances. It is not an invoice or an official receipt.
                </p>
                <DataTable
                  caption="Open invoices"
                  rows={rows}
                  rowKey={(r) => r.invoice_id}
                  empty="Nothing outstanding."
                  columns={[
                    { header: "Invoice", cell: (r) => r.invoice_no },
                    { header: "Date", kind: "nowrap", cell: (r) => r.invoice_date },
                    { header: "Due", kind: "nowrap", cell: (r) => r.due_date },
                    { header: "Total", kind: "num", cell: (r) => formatAmount(r.total) },
                    {
                      header: "Paid / credited",
                      kind: "num",
                      cell: (r) =>
                        formatAmount(fromCentavos(toCentavos(r.paid) + toCentavos(r.credited))),
                    },
                    {
                      header: "Balance",
                      kind: "num",
                      cell: (r) => <strong>{formatAmount(r.outstanding)}</strong>,
                    },
                  ]}
                />
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Use your browser&apos;s Print to print or save this statement.
                </p>
              </div>
            )}
          </Section>
        );
      } else {
        const accounts = (await listAccounts(client.id)).filter(
          (a) => a.is_postable && a.is_active,
        );
        const opts = [
          { value: "", label: "Choose…" },
          ...accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
        ];
        body = (
          <Section title="Posting accounts for sales">
            <p className="mb-3 text-sm text-[var(--muted)]">
              Which accounts the sales module posts to. See the posting rules in the documentation.
            </p>
            <div className="mb-4">
              <ActionForm
                action={salesSettingsAction}
                submitLabel="Use the starter-chart accounts"
                variant="primary"
              >
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="mode" value="defaults" />
                <p className="text-sm">
                  1100 Receivables · 4010 Sales · 2100 Output VAT · 4030 Sales returns · 1320
                  Creditable withholding tax · 2040 Advances from customers (added if missing)
                </p>
              </ActionForm>
            </div>
            <details className="rounded-md border border-[var(--border)] p-3">
              <summary className="cursor-pointer text-sm">Choose the accounts yourself</summary>
              <div className="mt-3">
                <ActionForm action={salesSettingsAction} submitLabel="Save accounts">
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="hidden" name="mode" value="custom" />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Select
                      label="Accounts receivable"
                      name="ar"
                      options={opts}
                      defaultValue={settings?.ar_account_id ?? ""}
                    />
                    <Select
                      label="Sales (default revenue)"
                      name="sales"
                      options={opts}
                      defaultValue={settings?.sales_account_id ?? ""}
                    />
                    <Select
                      label="Output VAT"
                      name="outputVat"
                      options={opts}
                      defaultValue={settings?.output_vat_account_id ?? ""}
                    />
                    <Select
                      label="Sales returns and allowances"
                      name="returns"
                      options={opts}
                      defaultValue={settings?.sales_returns_account_id ?? ""}
                    />
                    <Select
                      label="Creditable withholding tax"
                      name="cwt"
                      options={opts}
                      defaultValue={settings?.cwt_account_id ?? ""}
                    />
                    <Select
                      label="Advances from customers"
                      name="advances"
                      options={opts}
                      defaultValue={settings?.customer_advances_account_id ?? ""}
                    />
                  </div>
                </ActionForm>
              </div>
            </details>
          </Section>
        );
      }

      return (
        <>
          {!settings && tab !== "settings" ? (
            <div className="mb-4">
              <Alert tone="warning" title="Posting accounts are not set">
                Invoices and receipts cannot be posted yet.{" "}
                <Link className="underline" href={`${base}?tab=settings`}>
                  Set the posting accounts
                </Link>
                .
              </Alert>
            </div>
          ) : null}
          <nav aria-label="Sales sections" className="mb-4 flex flex-wrap gap-2 print:hidden">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "invoices" ? base : `${base}?tab=${t.key}`}
                aria-current={tab === t.key ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-sm ${tab === t.key ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]" : "border-[var(--border)] bg-[var(--surface-raised)]"}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {body}
        </>
      );
    },
  );
}
