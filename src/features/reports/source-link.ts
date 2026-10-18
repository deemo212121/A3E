import { pathFor, type RouteKey } from "@/lib/access/route-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE: Record<string, { label: string; route: RouteKey; param?: "itemId" | "entryId" }> = {
  sales_invoice: { label: "Sales invoice", route: "staff.sales_invoice", param: "itemId" },
  sales_receipt: { label: "Collection receipt", route: "staff.sales_receipt", param: "itemId" },
  credit_note: { label: "Credit note", route: "staff.sales" },
  purchase_bill: { label: "Purchase bill", route: "staff.purchase_bill", param: "itemId" },
  supplier_payment: { label: "Supplier payment", route: "staff.supplier_payment", param: "itemId" },
  inventory_movement: {
    label: "Stock movement",
    route: "staff.inventory_movement",
    param: "itemId",
  },
  payroll_run: { label: "Payroll", route: "staff.payroll_run", param: "itemId" },
  payroll_payment: { label: "Payroll payment", route: "staff.payroll" },
  intake_transaction: { label: "Client transaction", route: "staff.intake_txn", param: "itemId" },
  reversal: { label: "Reverses entry", route: "staff.entry", param: "entryId" },
};

/**
 * Where a journal entry came from, as a staff link. The target page checks
 * access again (e.g. payroll needs a payroll grant), so a link never reveals
 * more than the user may see.
 */
export function sourceLink(
  clientId: string,
  sourceType: string | null,
  sourceRef: string | null,
): { label: string; href: string } | null {
  if (!sourceType) return null;
  const s = SOURCE[sourceType];
  if (!s) return { label: sourceType.replace(/_/g, " "), href: "" };
  if (s.param && (!sourceRef || !UUID.test(sourceRef))) return null;
  return {
    label: s.label,
    href: pathFor(s.route, { clientId, ...(s.param ? { [s.param]: sourceRef! } : {}) }),
  };
}
