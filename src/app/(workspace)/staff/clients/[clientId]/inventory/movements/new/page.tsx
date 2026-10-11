import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Alert, PageSkeleton, Section } from "@/components/ui/primitives";
import { MovementForm } from "@/features/inventory/components/movement-form";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import {
  listItems,
  listLocations,
  listPostedInventoryBillLines,
  listPostedInvoiceLines,
} from "@/server/data/inventory";
import { listAccounts } from "@/server/data/ledger";

export const metadata: Metadata = { title: "Record stock movement" };

export default function NewMovementPage({
  params,
}: PageProps<"/staff/clients/[clientId]/inventory/movements/new">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <NewMovement params={params} />
    </Suspense>
  );
}

async function NewMovement({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage(
    "staff.inventory_movement_new",
    { clientId },
    "Record stock movement",
    async ({ client }) => {
      const [items, locations, accounts, billLines, invoiceLines] = await Promise.all([
        listItems(client.id),
        listLocations(client.id),
        listAccounts(client.id),
        listPostedInventoryBillLines(client.id),
        listPostedInvoiceLines(client.id),
      ]);
      const activeItems = items.filter((i) => i.is_active);
      const activeLocations = locations.filter((l) => l.is_active);
      if (activeItems.length === 0 || activeLocations.length === 0) {
        return (
          <Alert tone="info" title="Add items and locations first">
            <Link
              className="underline"
              href={`${pathFor("staff.inventory", { clientId: client.id })}?tab=items`}
            >
              Set up items and locations
            </Link>
            .
          </Alert>
        );
      }
      return (
        <Section title="Record a stock movement">
          <MovementForm
            clientId={client.id}
            idempotencyKey={randomUUID()}
            today={todayPh()}
            items={activeItems.map((i) => ({
              id: i.id,
              label: `${i.sku} · ${i.name} (${i.unit})`,
            }))}
            locations={activeLocations.map((l) => ({ id: l.id, label: `${l.code} · ${l.name}` }))}
            accounts={accounts
              .filter((a) => a.is_postable && a.is_active)
              .map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            billLines={billLines}
            invoiceLines={invoiceLines}
          />
        </Section>
      );
    },
  );
}
