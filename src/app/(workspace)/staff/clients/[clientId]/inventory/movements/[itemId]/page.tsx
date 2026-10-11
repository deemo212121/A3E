import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { formatQty } from "@/features/inventory/format";
import { MOVEMENT_LABEL, type MovementType } from "@/features/inventory/labels";
import { Timeline } from "@/features/intake/components/intake-ui";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { DocActions, DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount } from "@/lib/money/amount";
import { getMovement, listItems, listLocations } from "@/server/data/inventory";
import { getTimeline } from "@/server/data/intake";

export const metadata: Metadata = { title: "Stock movement" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MovementPage({
  params,
}: PageProps<"/staff/clients/[clientId]/inventory/movements/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Movement params={params} />
    </Suspense>
  );
}

async function Movement({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.inventory_movement",
    { clientId },
    "Stock movement",
    async ({ access, client }) => {
      const m = UUID.test(itemId) ? await getMovement(client.id, itemId.toLowerCase()) : null;
      if (!m) return <NotFoundState />;
      const [items, locations, timeline] = await Promise.all([
        listItems(client.id),
        listLocations(client.id),
        getTimeline(client.id, "inventory_movement", m.id),
      ]);
      const sku = Object.fromEntries(items.map((i) => [i.id, `${i.sku} · ${i.name}`]));
      const loc = Object.fromEntries(locations.map((l) => [l.id, l.code]));
      const type = m.movement_type as MovementType;
      return (
        <>
          <div className="mb-4">
            <LinkButton
              href={`${pathFor("staff.inventory", { clientId: client.id })}?tab=movements`}
            >
              ← Movements
            </LinkButton>
          </div>
          <Section title={`${MOVEMENT_LABEL[type]} · ${m.movement_date}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <DocStatus status={m.status} />
              {m.purchase_bill_id ? (
                <Link
                  className="underline"
                  href={pathFor("staff.purchase_bill", {
                    clientId: client.id,
                    itemId: m.purchase_bill_id,
                  })}
                >
                  Bill {m.bill_no}
                </Link>
              ) : null}
              {m.sales_invoice_id ? (
                <Link
                  className="underline"
                  href={pathFor("staff.sales_invoice", {
                    clientId: client.id,
                    itemId: m.sales_invoice_id,
                  })}
                >
                  Invoice {m.invoice_no}
                </Link>
              ) : null}
              {m.reason ? <span>· {m.reason}</span> : null}
            </div>
            {m.review_comment && m.status === "draft" ? (
              <div className="mb-3">
                <Alert tone="warning" title="Returned by the reviewer">
                  {m.review_comment}
                </Alert>
              </div>
            ) : null}
            {m.cancel_reason ? <p className="mb-3 text-sm">Cancelled: {m.cancel_reason}</p> : null}
            <DataTable
              caption="Lines"
              rows={m.lines}
              rowKey={(l) => String(l.line_no)}
              columns={[
                { header: "#", kind: "num", cell: (l) => l.line_no },
                { header: "Item", cell: (l) => sku[l.item_id] ?? "" },
                {
                  header: "Location",
                  cell: (l) =>
                    l.to_location_id
                      ? `${loc[l.location_id]} → ${loc[l.to_location_id]}`
                      : loc[l.location_id],
                },
                { header: "Quantity", kind: "num", cell: (l) => formatQty(l.quantity) },
                {
                  header: "Unit cost",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (l) => (l.unit_cost ? formatAmount(l.unit_cost) : ""),
                },
                {
                  header: "Link",
                  hideOnMobile: true,
                  cell: (l) =>
                    l.bill_line_no
                      ? `bill line ${l.bill_line_no}`
                      : l.invoice_line_no
                        ? `invoice line ${l.invoice_line_no}`
                        : "",
                },
              ]}
            />
          </Section>
          {m.ledger.length > 0 ? (
            <Section title="Stock ledger (computed at posting)">
              <DataTable
                caption="Stock ledger"
                rows={m.ledger}
                rowKey={(r) => String(r.id)}
                columns={[
                  { header: "Item", cell: (r) => sku[r.item_id] ?? "" },
                  { header: "Location", cell: (r) => loc[r.location_id] },
                  { header: "Qty change", kind: "num", cell: (r) => formatQty(r.qty_change) },
                  {
                    header: "Value change",
                    kind: "num",
                    cell: (r) => formatAmount(r.value_change),
                  },
                  {
                    header: "",
                    srOnlyHeader: true,
                    cell: (r) => (r.is_reversal ? <Badge tone="danger">reversal</Badge> : null),
                  },
                ]}
              />
              <p className="mt-2 text-sm">
                {m.journal_entry_id ? (
                  <Link
                    className="underline"
                    href={pathFor("staff.entry", {
                      clientId: client.id,
                      entryId: m.journal_entry_id,
                    })}
                  >
                    Journal entry
                  </Link>
                ) : (
                  "No journal entry: the purchase bill already booked these goods, or the movement only moved stock between locations."
                )}
                {m.cancel_journal_entry_id ? (
                  <>
                    {" · "}
                    <Link
                      className="underline"
                      href={pathFor("staff.entry", {
                        clientId: client.id,
                        entryId: m.cancel_journal_entry_id,
                      })}
                    >
                      Reversing entry
                    </Link>
                  </>
                ) : null}
              </p>
            </Section>
          ) : null}
          <Section title="Workflow">
            {m.status === "posted" ? (
              <p className="mb-3 text-sm text-[var(--muted)]">
                Only the latest movement of an item can be cancelled (later costs depend on it).
                Cancel newer movements first.
              </p>
            ) : null}
            <DocActions
              access={access}
              clientId={client.id}
              subject="inventory_movement"
              id={m.id}
              status={m.status}
              preparedBy={m.prepared_by}
              label="movement"
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
