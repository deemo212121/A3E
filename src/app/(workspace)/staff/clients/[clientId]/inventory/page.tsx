import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { inventoryConfigAction } from "@/features/inventory/actions";
import { formatQty } from "@/features/inventory/format";
import { MOVEMENT_LABEL, type MovementType } from "@/features/inventory/labels";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { formatAmount } from "@/lib/money/amount";
import {
  getInventoryReconciliation,
  getInventorySettings,
  getQuantityCheck,
  getStockByLocation,
  getValuation,
  listItems,
  listLocations,
  listMovements,
} from "@/server/data/inventory";
import { listAccounts } from "@/server/data/ledger";
import { canApproveIntake } from "@/server/intake/access";

export const metadata: Metadata = { title: "Inventory" };

const TABS = [
  { key: "stock", label: "Stock & valuation" },
  { key: "movements", label: "Movements" },
  { key: "items", label: "Items" },
  { key: "locations", label: "Locations" },
  { key: "setup", label: "Accounts & policy" },
] as const;

type Props = PageProps<"/staff/clients/[clientId]/inventory">;

export default function InventoryPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Inventory params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Inventory({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.inventory",
    { clientId },
    "Inventory",
    async ({ access, client }) => {
      const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as string) : "stock";
      const base = pathFor("staff.inventory", { clientId: client.id });
      const asOf =
        typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayPh();
      const settings = await getInventorySettings(client.id);
      const approver = canApproveIntake(access, client.id);
      const hidden = (op: string, id = "") => (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="op" value={op} />
          <input type="hidden" name="id" value={id} />
        </>
      );
      let body: React.ReactNode = null;

      if (tab === "stock") {
        const [valuation, byLocation, recon, qtyIssues] = await Promise.all([
          getValuation(client.id, asOf),
          getStockByLocation(client.id, asOf),
          getInventoryReconciliation(client.id, asOf),
          getQuantityCheck(client.id),
        ]);
        const off = recon.filter((r) => r.difference !== "0.00");
        body = (
          <>
            <form className="mb-4 flex flex-wrap items-end gap-2" action={base}>
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
            <Section title="Ledger reconciliation">
              {qtyIssues.length > 0 ? (
                <div className="mb-3">
                  <Alert tone="danger" title="Stock balances disagree with the stock ledger">
                    {qtyIssues.map((r) => r.sku).join(", ")}. Report this to the system
                    administrator.
                  </Alert>
                </div>
              ) : null}
              {recon.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No items yet.</p>
              ) : off.length === 0 ? (
                <Alert tone="success" title="Stock value agrees with the general ledger">
                  Quantities match the stock ledger, and for every inventory account the stock value
                  plus goods billed but not yet received equals the ledger balance.
                </Alert>
              ) : (
                <Alert tone="warning" title="Differences found">
                  Something was posted to an inventory account outside the inventory and purchases
                  modules (e.g. a manual journal entry). See the table below.
                </Alert>
              )}
              {recon.length > 0 ? (
                <div className="mt-3">
                  <DataTable
                    caption="Inventory reconciliation"
                    rows={recon}
                    rowKey={(r) => r.account_id}
                    columns={[
                      { header: "Account", cell: (r) => r.account_code },
                      {
                        header: "Stock value",
                        kind: "num",
                        cell: (r) => formatAmount(r.stock_value),
                      },
                      {
                        header: "Billed, not received",
                        kind: "num",
                        cell: (r) => formatAmount(r.billed_not_received),
                      },
                      {
                        header: "Ledger balance",
                        kind: "num",
                        cell: (r) => formatAmount(r.ledger_balance),
                      },
                      {
                        header: "Difference",
                        kind: "num",
                        cell: (r) =>
                          r.difference === "0.00" ? (
                            "0.00"
                          ) : (
                            <strong className="text-[var(--danger)]">
                              {formatAmount(r.difference)}
                            </strong>
                          ),
                      },
                    ]}
                  />
                </div>
              ) : null}
            </Section>
            <Section title={`Valuation as of ${asOf} (moving average, pending verification)`}>
              <DataTable
                caption="Inventory valuation"
                rows={valuation}
                rowKey={(r) => r.item_id}
                empty="No items yet."
                columns={[
                  { header: "SKU", kind: "nowrap", cell: (r) => r.sku },
                  { header: "Item", cell: (r) => r.name },
                  {
                    header: "Quantity",
                    kind: "num",
                    cell: (r) => `${formatQty(r.quantity)} ${r.unit}`,
                  },
                  {
                    header: "Average cost",
                    kind: "num",
                    hideOnMobile: true,
                    cell: (r) => (r.average_cost ? formatAmount(r.average_cost) : ""),
                  },
                  { header: "Value", kind: "num", cell: (r) => formatAmount(r.value) },
                ]}
              />
            </Section>
            <Section title="Quantity by location">
              <DataTable
                caption="Stock by location"
                rows={byLocation}
                rowKey={(r) => `${r.item_id}-${r.location_id}`}
                empty="No stock on hand."
                columns={[
                  { header: "SKU", kind: "nowrap", cell: (r) => r.sku },
                  { header: "Location", cell: (r) => r.location_code },
                  { header: "Quantity", kind: "num", cell: (r) => formatQty(r.quantity) },
                ]}
              />
            </Section>
          </>
        );
      } else if (tab === "movements") {
        const rows = await listMovements(client.id);
        body = (
          <Section
            title="Stock movements"
            actions={
              <LinkButton
                href={pathFor("staff.inventory_movement_new", { clientId: client.id })}
                variant="primary"
              >
                + Record movement
              </LinkButton>
            }
          >
            <DataTable
              caption="Movements"
              rows={rows}
              rowKey={(r) => r.id}
              empty="No stock movements yet."
              columns={[
                { header: "Date", kind: "nowrap", cell: (r) => r.movement_date },
                {
                  header: "Movement",
                  cell: (r) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.inventory_movement", {
                        clientId: client.id,
                        itemId: r.id,
                      })}
                    >
                      {MOVEMENT_LABEL[r.movement_type as MovementType]}
                    </Link>
                  ),
                },
                { header: "Reason", hideOnMobile: true, cell: (r) => r.reason ?? "" },
                {
                  header: "Value",
                  kind: "num",
                  cell: (r) => (r.total_value ? formatAmount(r.total_value) : ""),
                },
                { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
              ]}
            />
          </Section>
        );
      } else if (tab === "items" || tab === "locations") {
        const [items, locations, accounts] = await Promise.all([
          listItems(client.id),
          listLocations(client.id),
          listAccounts(client.id),
        ]);
        const assets = accounts.filter(
          (a) => a.account_type === "asset" && a.is_postable && a.is_active,
        );
        const code = Object.fromEntries(accounts.map((a) => [a.id, a.code]));
        body =
          tab === "items" ? (
            <Section title="Items">
              <DataTable
                caption="Items"
                rows={items}
                rowKey={(r) => r.id}
                empty="No items yet."
                columns={[
                  { header: "SKU", kind: "nowrap", cell: (r) => r.sku },
                  { header: "Name", cell: (r) => r.name },
                  { header: "Unit", cell: (r) => r.unit },
                  { header: "Account", cell: (r) => code[r.inventory_account_id] ?? "" },
                  { header: "On hand", kind: "num", cell: (r) => formatQty(r.qty_on_hand) },
                  { header: "Value", kind: "num", cell: (r) => formatAmount(r.value_on_hand) },
                  {
                    header: "Active",
                    hideOnMobile: true,
                    cell: (r) => (r.is_active ? "" : <Badge tone="neutral">inactive</Badge>),
                  },
                ]}
              />
              <details className="mt-4 rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm">Add an item</summary>
                <div className="mt-3">
                  <ActionForm action={inventoryConfigAction} submitLabel="Add item">
                    {hidden("item")}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                      <Field label="SKU" name="code" maxLength={40} />
                      <Field label="Name" name="name" maxLength={200} />
                      <Field label="Unit (pc, box, kg…)" name="unit" maxLength={20} />
                      <Select
                        label="Inventory account"
                        name="accountId"
                        defaultValue={assets.find((a) => a.code === "1200")?.id ?? ""}
                        options={assets.map((a) => ({
                          value: a.id,
                          label: `${a.code} · ${a.name}`,
                        }))}
                      />
                    </div>
                  </ActionForm>
                </div>
              </details>
              <p className="mt-2 text-xs text-[var(--muted)]">
                To receive goods from a purchase bill, the bill line&apos;s category must post to
                the item&apos;s inventory account (e.g. a category &quot;Merchandise inventory&quot;
                → 1200). Bills booked to 5020 Purchases are treated as an expense and cannot be
                received into stock.
              </p>
            </Section>
          ) : (
            <Section title="Warehouses and locations">
              <DataTable
                caption="Locations"
                rows={locations}
                rowKey={(r) => r.id}
                empty="No locations yet."
                columns={[
                  { header: "Code", kind: "nowrap", cell: (r) => r.code },
                  { header: "Name", cell: (r) => r.name },
                  {
                    header: "Active",
                    cell: (r) => (r.is_active ? "" : <Badge tone="neutral">inactive</Badge>),
                  },
                ]}
              />
              <details className="mt-4 rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm">Add a location</summary>
                <div className="mt-3">
                  <ActionForm action={inventoryConfigAction} submitLabel="Add location">
                    {hidden("location")}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Code" name="code" maxLength={20} />
                      <Field label="Name" name="name" maxLength={100} />
                    </div>
                  </ActionForm>
                </div>
              </details>
            </Section>
          );
      } else {
        const accounts = await listAccounts(client.id);
        const opts = [
          { value: "", label: "Choose…" },
          ...accounts
            .filter((a) => a.is_postable && a.is_active)
            .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
        ];
        body = (
          <>
            <Section title="Costing method">
              <Alert tone="warning" title="Moving weighted average: PENDING VERIFICATION">
                Proposed method, to be confirmed by the firm&apos;s CPA (see
                docs/inventory/COSTING-METHOD.md). Values are computed by the database; they are not
                yet validated for financial reporting or tax.
              </Alert>
            </Section>
            <Section title="Posting accounts">
              <ActionForm
                action={inventoryConfigAction}
                submitLabel="Use the starter-chart accounts"
                variant="primary"
              >
                {hidden("default_settings")}
                <p className="text-sm">
                  5010 Cost of goods sold · 6900 Miscellaneous (count differences) · 1130 Advances
                  to suppliers (goods returned to suppliers)
                </p>
              </ActionForm>
              <details className="mt-3 rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm">Choose the accounts</summary>
                <div className="mt-3">
                  <ActionForm action={inventoryConfigAction} submitLabel="Save">
                    {hidden("settings")}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Select
                        label="Cost of goods sold"
                        name="cogs"
                        options={opts}
                        defaultValue={settings?.cogs_account_id ?? ""}
                      />
                      <Select
                        label="Count differences"
                        name="adjustment"
                        options={opts}
                        defaultValue={settings?.adjustment_account_id ?? ""}
                      />
                      <Select
                        label="Goods returned to suppliers"
                        name="supplierReturn"
                        options={opts}
                        defaultValue={settings?.supplier_return_account_id ?? ""}
                      />
                    </div>
                  </ActionForm>
                </div>
              </details>
            </Section>
            <Section title="Negative stock policy">
              {settings?.allow_negative_stock ? (
                <Alert tone="warning" title="Negative stock is ALLOWED">
                  Approved {settings.negative_stock_approved_at?.slice(0, 10)}:{" "}
                  {settings.negative_stock_reason}. Issues beyond the quantity on hand are costed at
                  the last unit cost.
                </Alert>
              ) : (
                <Alert tone="info" title="Negative stock is refused">
                  A movement that would take any item or location below zero cannot be posted.
                </Alert>
              )}
              {approver && settings ? (
                <div className="mt-3">
                  {settings.allow_negative_stock ? (
                    <ActionForm action={inventoryConfigAction} submitLabel="Refuse negative stock">
                      {hidden("policy")}
                      <input type="hidden" name="allow" value="false" />
                    </ActionForm>
                  ) : (
                    <details className="rounded-md border border-[var(--border)] p-3">
                      <summary className="cursor-pointer text-sm">Allow negative stock</summary>
                      <div className="mt-3">
                        <ActionForm
                          action={inventoryConfigAction}
                          submitLabel="Approve policy"
                          variant="danger"
                        >
                          {hidden("policy")}
                          <input type="hidden" name="allow" value="true" />
                          <TextArea
                            label="Approved business reason"
                            name="reason"
                            rows={2}
                            required
                          />
                        </ActionForm>
                      </div>
                    </details>
                  )}
                </div>
              ) : null}
            </Section>
          </>
        );
      }

      return (
        <>
          {!settings && tab !== "setup" ? (
            <div className="mb-4">
              <Alert tone="warning" title="Inventory accounts are not set">
                Stock movements cannot be posted yet.{" "}
                <Link className="underline" href={`${base}?tab=setup`}>
                  Set up the accounts
                </Link>
                .
              </Alert>
            </div>
          ) : null}
          <nav aria-label="Inventory sections" className="mb-4 flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "stock" ? base : `${base}?tab=${t.key}`}
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
