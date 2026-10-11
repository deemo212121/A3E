import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { purchaseConfigAction } from "@/features/purchases/actions";
import { DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { formatAmount } from "@/lib/money/amount";
import { listAccounts } from "@/server/data/ledger";
import {
  getApAging,
  getApReconciliation,
  getPurchaseSettings,
  getWithholdingSummary,
  listBills,
  listCategories,
  listPayments,
  listWithholdingCodes,
} from "@/server/data/purchases";
import { canApproveIntake } from "@/server/intake/access";

export const metadata: Metadata = { title: "Purchases & payables" };

const TABS = [
  { key: "bills", label: "Bills & expenses" },
  { key: "payments", label: "Payments" },
  { key: "payables", label: "Payables & aging" },
  { key: "withholding", label: "Withholding" },
  { key: "setup", label: "Categories & accounts" },
] as const;
const KIND_LABEL: Record<string, string> = {
  inventory: "Inventory",
  fixed_asset: "Fixed asset",
  prepayment: "Prepayment",
  expense: "Expense",
};
const TYPE_LABEL: Record<string, string> = {
  bill: "Bill",
  cash_purchase: "Cash purchase",
  reimbursement: "Reimbursement",
};

type Props = PageProps<"/staff/clients/[clientId]/purchases">;

export default function PurchasesPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Purchases params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Purchases({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.purchases",
    { clientId },
    "Purchases & payables",
    async ({ access, client }) => {
      const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as string) : "bills";
      const base = pathFor("staff.purchases", { clientId: client.id });
      const asOf =
        typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayPh();
      const settings = await getPurchaseSettings(client.id);
      const approver = canApproveIntake(access, client.id);
      const hidden = (op: string, id = "") => (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="op" value={op} />
          <input type="hidden" name="id" value={id} />
        </>
      );
      let body: React.ReactNode = null;

      if (tab === "bills") {
        const rows = await listBills(client.id);
        body = (
          <Section
            title="Bills, cash purchases and reimbursements"
            actions={
              <LinkButton
                href={pathFor("staff.purchase_bill_new", { clientId: client.id })}
                variant="primary"
              >
                + Record bill or expense
              </LinkButton>
            }
          >
            <DataTable
              caption="Bills"
              rows={rows}
              rowKey={(r) => r.id}
              empty="No bills recorded yet."
              columns={[
                { header: "Date", kind: "nowrap", cell: (r) => r.bill_date },
                {
                  header: "Document",
                  cell: (r) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.purchase_bill", { clientId: client.id, itemId: r.id })}
                    >
                      {r.bill_no}
                    </Link>
                  ),
                },
                { header: "Supplier / payee", cell: (r) => r.supplier },
                { header: "Type", hideOnMobile: true, cell: (r) => TYPE_LABEL[r.bill_type] },
                { header: "Total", kind: "num", cell: (r) => formatAmount(r.gross_amount) },
                {
                  header: "Withheld",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (r) =>
                    r.withholding_amount === "0.00" ? "" : formatAmount(r.withholding_amount),
                },
                { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
              ]}
            />
          </Section>
        );
      } else if (tab === "payments") {
        const rows = await listPayments(client.id);
        body = (
          <Section
            title="Supplier payments"
            actions={
              <LinkButton
                href={pathFor("staff.supplier_payment_new", { clientId: client.id })}
                variant="primary"
              >
                + Record payment
              </LinkButton>
            }
          >
            <DataTable
              caption="Supplier payments"
              rows={rows}
              rowKey={(r) => r.id}
              empty="No payments recorded yet."
              columns={[
                { header: "Date", kind: "nowrap", cell: (r) => r.payment_date },
                {
                  header: "Voucher",
                  cell: (r) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.supplier_payment", {
                        clientId: client.id,
                        itemId: r.id,
                      })}
                    >
                      {r.payment_no}
                    </Link>
                  ),
                },
                { header: "Supplier / payee", cell: (r) => r.supplier },
                { header: "Amount", kind: "num", cell: (r) => formatAmount(r.amount_paid) },
                { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
              ]}
            />
          </Section>
        );
      } else if (tab === "payables") {
        const [aging, recon] = await Promise.all([
          getApAging(client.id, asOf),
          settings ? getApReconciliation(client.id, asOf) : null,
        ]);
        body = (
          <>
            <form className="mb-4 flex flex-wrap items-end gap-2" action={base}>
              <input type="hidden" name="tab" value="payables" />
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
                  <Alert tone="success" title="Payables agree with the general ledger">
                    Open bills total {formatAmount(recon.subledger_total)}; the payables account
                    shows {formatAmount(recon.ledger_balance)}.
                  </Alert>
                ) : (
                  <Alert tone="warning" title={`Difference of ${formatAmount(recon.difference)}`}>
                    Open bills total {formatAmount(recon.subledger_total)} but the payables account
                    shows {formatAmount(recon.ledger_balance)}. Something was posted to the payables
                    account outside the purchases module.
                  </Alert>
                )}
              </Section>
            ) : null}
            <Section title={`Payables aging as of ${asOf}`}>
              <DataTable
                caption="Payables aging"
                rows={aging}
                rowKey={(r) => r.counterparty_id}
                empty="Nothing outstanding."
                columns={[
                  { header: "Supplier / payee", cell: (r) => r.supplier_name },
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
      } else if (tab === "withholding") {
        const from =
          typeof sp.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.from)
            ? sp.from
            : `${asOf.slice(0, 7)}-01`;
        const to = typeof sp.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : asOf;
        const [summary, codes] = await Promise.all([
          getWithholdingSummary(client.id, from, to),
          listWithholdingCodes(),
        ]);
        body = (
          <>
            <Section title="Tax withheld on posted bills">
              <form className="mb-3 flex flex-wrap items-end gap-2" action={base}>
                <input type="hidden" name="tab" value="withholding" />
                {(["from", "to"] as const).map((k) => (
                  <label key={k} className="flex flex-col gap-1 text-sm">
                    <span>{k === "from" ? "From" : "To"}</span>
                    <input
                      type="date"
                      name={k}
                      defaultValue={k === "from" ? from : to}
                      className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                    />
                  </label>
                ))}
                <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">
                  Show
                </button>
              </form>
              <DataTable
                caption="Withholding summary"
                rows={summary}
                rowKey={(r) => `${r.counterparty_id}-${r.code}-${r.code_version}`}
                empty="No withholding in this period."
                columns={[
                  { header: "Payee", cell: (r) => r.payee_name },
                  { header: "TIN", kind: "nowrap", cell: (r) => r.payee_tin ?? "" },
                  { header: "Code", cell: (r) => `${r.code} v${r.code_version}` },
                  { header: "Base", kind: "num", cell: (r) => formatAmount(r.base_total) },
                  { header: "Withheld", kind: "num", cell: (r) => formatAmount(r.withheld_total) },
                  { header: "Bills", kind: "num", cell: (r) => r.bill_count },
                ]}
              />
              <p className="mt-2 text-xs text-[var(--muted)]">
                Data captured for certificates and returns; those are prepared in a later,
                CPA-approved phase.
              </p>
            </Section>
            <Section title="Withholding codes (firm-wide)">
              <Alert tone="info">
                The platform ships with no withholding rates. A reviewer or manager enters each code
                with its rate, base and legal basis; a different person signs it off. Bills using a
                code that is not signed off cannot be posted. A signed-off code never changes: a new
                rate is a new version.
              </Alert>
              <div className="mt-3">
                <DataTable
                  caption="Withholding codes"
                  rows={codes}
                  rowKey={(c) => c.id}
                  empty="No withholding codes yet."
                  columns={[
                    { header: "Code", cell: (c) => `${c.code} v${c.version}` },
                    {
                      header: "Description",
                      cell: (c) => (
                        <span className="flex flex-col">
                          <span>{c.description}</span>
                          <span className="text-xs text-[var(--muted)]">{c.legal_basis}</span>
                        </span>
                      ),
                    },
                    { header: "Rate", kind: "num", cell: (c) => c.rate },
                    { header: "Base", cell: (c) => (c.base === "gross" ? "Gross" : "Net of VAT") },
                    {
                      header: "Effective",
                      kind: "nowrap",
                      cell: (c) =>
                        `${c.effective_from}${c.effective_to ? ` – ${c.effective_to}` : ""}`,
                    },
                    {
                      header: "Status",
                      cell: (c) => (
                        <Badge
                          tone={
                            c.status === "signed_off"
                              ? "success"
                              : c.status === "retired"
                                ? "neutral"
                                : "warning"
                          }
                        >
                          {c.status.replace("_", " ")}
                        </Badge>
                      ),
                    },
                    {
                      header: "Actions",
                      srOnlyHeader: true,
                      cell: (c) =>
                        approver &&
                        c.status === "pending_signoff" &&
                        c.entered_by !== access.user_id ? (
                          <ActionForm
                            action={purchaseConfigAction}
                            submitLabel="Sign off"
                            variant="primary"
                            confirmMessage={`Sign off ${c.code} at ${c.rate}? Check the legal basis first.`}
                          >
                            {hidden("sign_off_code", c.id)}
                          </ActionForm>
                        ) : null,
                    },
                  ]}
                />
              </div>
              {approver ? (
                <details className="mt-4 rounded-md border border-[var(--border)] p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Enter a withholding code (or a new version)
                  </summary>
                  <div className="mt-3">
                    <ActionForm action={purchaseConfigAction} submitLabel="Submit for sign-off">
                      {hidden("propose_code")}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Code (e.g. the ATC)" name="code" maxLength={12} />
                        <Field
                          label="Rate as a decimal (0.02 = 2%)"
                          name="rate"
                          inputMode="decimal"
                        />
                        <Field label="Description" name="description" maxLength={300} />
                        <Select
                          label="Applies to"
                          name="base"
                          options={[
                            { value: "net_of_vat", label: "Amount net of VAT" },
                            { value: "gross", label: "Gross amount" },
                          ]}
                        />
                        <Field label="Effective from" name="effectiveFrom" type="date" />
                        <Field label="Effective to (optional)" name="effectiveTo" type="date" />
                      </div>
                      <TextArea
                        label="Legal basis (regulation, section, source and date read)"
                        name="legalBasis"
                        rows={2}
                        required
                      />
                    </ActionForm>
                  </div>
                </details>
              ) : null}
            </Section>
          </>
        );
      } else {
        const [categories, accounts] = await Promise.all([
          listCategories(client.id),
          listAccounts(client.id),
        ]);
        const postable = accounts.filter((a) => a.is_postable && a.is_active);
        const opts = [
          { value: "", label: "Choose…" },
          ...postable.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
        ];
        body = (
          <>
            <Section title="Purchase categories (accounting policy)">
              <p className="mb-3 text-sm text-[var(--muted)]">
                Each category says how a purchase is treated (inventory, fixed asset, prepayment or
                expense) and which account it posts to. A category must be approved by a reviewer
                other than the person who proposed it.
              </p>
              <DataTable
                caption="Purchase categories"
                rows={categories}
                rowKey={(c) => c.id}
                empty="No categories yet."
                columns={[
                  { header: "Category", cell: (c) => c.name },
                  { header: "Treatment", cell: (c) => KIND_LABEL[c.kind] },
                  {
                    header: "Account",
                    cell: (c) => (c.accounts ? `${c.accounts.code} · ${c.accounts.name}` : ""),
                  },
                  {
                    header: "Status",
                    cell: (c) => (
                      <Badge tone={c.status === "approved" ? "success" : "warning"}>
                        {c.status}
                      </Badge>
                    ),
                  },
                  {
                    header: "Actions",
                    srOnlyHeader: true,
                    cell: (c) =>
                      approver && c.status === "proposed" && c.proposed_by !== access.user_id ? (
                        <ActionForm
                          action={purchaseConfigAction}
                          submitLabel="Approve"
                          variant="primary"
                        >
                          {hidden("approve_category", c.id)}
                        </ActionForm>
                      ) : null,
                  },
                ]}
              />
              <div className="mt-4 flex flex-col gap-3">
                <ActionForm
                  action={purchaseConfigAction}
                  submitLabel="Propose the usual categories (starter chart)"
                >
                  {hidden("default_categories")}
                </ActionForm>
                <details className="rounded-md border border-[var(--border)] p-3">
                  <summary className="cursor-pointer text-sm">Propose a category</summary>
                  <div className="mt-3">
                    <ActionForm action={purchaseConfigAction} submitLabel="Propose">
                      {hidden("propose_category")}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <Field label="Name" name="name" maxLength={100} />
                        <Select
                          label="Treatment"
                          name="kind"
                          options={Object.entries(KIND_LABEL).map(([value, label]) => ({
                            value,
                            label,
                          }))}
                        />
                        <Select label="Account" name="accountId" options={opts} />
                      </div>
                    </ActionForm>
                  </div>
                </details>
              </div>
            </Section>
            <Section title="Posting accounts">
              <ActionForm
                action={purchaseConfigAction}
                submitLabel="Use the starter-chart accounts"
                variant="primary"
              >
                {hidden("default_settings")}
                <p className="text-sm">
                  2010 Accounts payable · 1310 Input VAT · 2110 Withholding taxes payable · 1130
                  Advances to suppliers (added if missing)
                </p>
              </ActionForm>
              <details className="mt-3 rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm">
                  Choose the accounts and the capitalization threshold
                </summary>
                <div className="mt-3">
                  <ActionForm action={purchaseConfigAction} submitLabel="Save">
                    {hidden("settings")}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Select
                        label="Accounts payable"
                        name="ap"
                        options={opts}
                        defaultValue={settings?.ap_account_id ?? ""}
                      />
                      <Select
                        label="Input VAT"
                        name="inputVat"
                        options={opts}
                        defaultValue={settings?.input_vat_account_id ?? ""}
                      />
                      <Select
                        label="Withholding taxes payable"
                        name="whtPayable"
                        options={opts}
                        defaultValue={settings?.withholding_payable_account_id ?? ""}
                      />
                      <Select
                        label="Advances to suppliers"
                        name="advances"
                        options={opts}
                        defaultValue={settings?.supplier_advances_account_id ?? ""}
                      />
                      <Field
                        label="Capitalization threshold (accountant policy)"
                        name="threshold"
                        defaultValue={settings?.capitalization_threshold ?? ""}
                        hint="Expense lines at or above this unit cost are flagged for review. Leave blank for none."
                      />
                    </div>
                  </ActionForm>
                </div>
              </details>
            </Section>
          </>
        );
      }

      return (
        <>
          {!settings && tab !== "setup" ? (
            <div className="mb-4">
              <Alert tone="warning" title="Posting accounts are not set">
                Bills and payments cannot be posted yet.{" "}
                <Link className="underline" href={`${base}?tab=setup`}>
                  Set up categories and accounts
                </Link>
                .
              </Alert>
            </div>
          ) : null}
          <nav aria-label="Purchases sections" className="mb-4 flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "bills" ? base : `${base}?tab=${t.key}`}
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
