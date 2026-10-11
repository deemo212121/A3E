import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/* Inventory read models (RLS applies; quantities and amounts as exact text). */

async function q<T>(
  label: string,
  run: (
    sb: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
) {
  const { data, error } = await run(await createSupabaseServerClient());
  if (error) throw fromDbError(error, label);
  return data as T;
}

export interface InventorySettings {
  cogs_account_id: string;
  adjustment_account_id: string;
  supplier_return_account_id: string;
  costing_method: string;
  costing_status: string;
  allow_negative_stock: boolean;
  negative_stock_reason: string | null;
  negative_stock_approved_at: string | null;
}
export const getInventorySettings = (clientId: string) =>
  q<InventorySettings | null>("inventory settings", (sb) =>
    sb
      .from("inventory_settings")
      .select(
        "cogs_account_id, adjustment_account_id, supplier_return_account_id, costing_method, costing_status, allow_negative_stock, negative_stock_reason, negative_stock_approved_at",
      )
      .eq("client_id", clientId)
      .maybeSingle(),
  );

export interface LocationRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}
export const listLocations = (clientId: string) =>
  q<LocationRow[]>("inventory locations", (sb) =>
    sb
      .from("inventory_locations")
      .select("id, code, name, is_active")
      .eq("client_id", clientId)
      .order("code"),
  );

export interface ItemRow {
  id: string;
  sku: string;
  name: string;
  unit: string;
  inventory_account_id: string;
  is_active: boolean;
  qty_on_hand: string;
  value_on_hand: string;
  last_unit_cost: string | null;
  last_movement_date: string | null;
}
export const listItems = (clientId: string) =>
  q<ItemRow[]>("inventory items", (sb) =>
    sb
      .from("inventory_items")
      .select(
        "id, sku, name, unit, inventory_account_id, is_active, qty_on_hand::text, value_on_hand::text, last_unit_cost::text, last_movement_date",
      )
      .eq("client_id", clientId)
      .order("sku"),
  );

export interface MovementRow {
  id: string;
  movement_type: string;
  movement_date: string;
  status: string;
  reason: string | null;
  total_value: string | null;
  purchase_bill_id: string | null;
  sales_invoice_id: string | null;
}
export const listMovements = (clientId: string) =>
  q<MovementRow[]>("inventory movements", (sb) =>
    sb
      .from("inventory_movements")
      .select(
        "id, movement_type, movement_date, status, reason, total_value::text, purchase_bill_id, sales_invoice_id",
      )
      .eq("client_id", clientId)
      .order("movement_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300),
  );

export interface MovementDetail extends MovementRow {
  offset_account_id: string | null;
  memo: string | null;
  prepared_by: string | null;
  review_comment: string | null;
  journal_entry_id: string | null;
  cancel_journal_entry_id: string | null;
  cancel_reason: string | null;
  bill_no: string | null;
  invoice_no: string | null;
  lines: {
    line_no: number;
    item_id: string;
    location_id: string;
    to_location_id: string | null;
    quantity: string;
    unit_cost: string | null;
    bill_line_no: number | null;
    invoice_line_no: number | null;
  }[];
  ledger: {
    id: number;
    line_no: number;
    item_id: string;
    location_id: string;
    is_reversal: boolean;
    qty_change: string;
    value_change: string;
  }[];
}
export async function getMovement(clientId: string, id: string): Promise<MovementDetail | null> {
  const d = await q<Record<string, unknown> | null>("inventory movement", (sb) =>
    sb
      .from("inventory_movements")
      .select(
        "id, movement_type, movement_date, status, reason, memo, total_value::text, purchase_bill_id, sales_invoice_id, offset_account_id, prepared_by, review_comment, journal_entry_id, cancel_journal_entry_id, cancel_reason, purchase_bills(bill_no), sales_invoices(invoice_no), inventory_movement_lines(line_no, item_id, location_id, to_location_id, quantity::text, unit_cost::text, bill_line_no, invoice_line_no)",
      )
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!d) return null;
  const ledger = await q<MovementDetail["ledger"]>("stock ledger", (sb) =>
    sb
      .from("inventory_ledger")
      .select(
        "id, line_no, item_id, location_id, is_reversal, qty_change::text, value_change::text",
      )
      .eq("client_id", clientId)
      .eq("movement_id", id)
      .order("id"),
  );
  const one = <T>(v: T | T[] | null) => (Array.isArray(v) ? (v[0] ?? null) : v);
  return {
    ...(d as unknown as MovementDetail),
    bill_no: one(d.purchase_bills as { bill_no: string } | null)?.bill_no ?? null,
    invoice_no: one(d.sales_invoices as { invoice_no: string } | null)?.invoice_no ?? null,
    lines: [...((d.inventory_movement_lines as MovementDetail["lines"]) ?? [])].sort(
      (a, b) => a.line_no - b.line_no,
    ),
    ledger,
  };
}

export interface ValuationRow {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: string;
  value: string;
  average_cost: string | null;
}
export const getValuation = (clientId: string, asOf: string) =>
  q<ValuationRow[]>("inventory_valuation", (sb) =>
    sb.rpc("inventory_valuation", { p_client_id: clientId, p_as_of: asOf }),
  );

export interface StockByLocationRow {
  item_id: string;
  sku: string;
  location_id: string;
  location_code: string;
  quantity: string;
}
export const getStockByLocation = (clientId: string, asOf: string) =>
  q<StockByLocationRow[]>("inventory_stock_by_location", (sb) =>
    sb.rpc("inventory_stock_by_location", { p_client_id: clientId, p_as_of: asOf }),
  );

export interface InventoryReconRow {
  account_id: string;
  account_code: string;
  stock_value: string;
  billed_not_received: string;
  ledger_balance: string;
  difference: string;
}
export const getInventoryReconciliation = (clientId: string, asOf: string) =>
  q<InventoryReconRow[]>("inventory_reconciliation", (sb) =>
    sb.rpc("inventory_reconciliation", { p_client_id: clientId, p_as_of: asOf }),
  );

export interface QuantityIssueRow {
  item_id: string;
  sku: string;
  location_id: string | null;
  balance_qty: string;
  ledger_qty: string;
}
export const getQuantityCheck = (clientId: string) =>
  q<QuantityIssueRow[]>("inventory_quantity_check", (sb) =>
    sb.rpc("inventory_quantity_check", { p_client_id: clientId }),
  );

/** Posted bill lines booked to inventory, with what is still to be received. */
export interface ReceivableBillLine {
  bill_id: string;
  bill_no: string;
  line_no: number;
  description: string;
  quantity: string;
  account_id: string;
}
export async function listPostedInventoryBillLines(
  clientId: string,
): Promise<ReceivableBillLine[]> {
  const rows = await q<
    {
      id: string;
      bill_no: string;
      purchase_bill_lines: {
        line_no: number;
        description: string;
        quantity: string;
        kind: string;
        account_id: string;
      }[];
    }[]
  >("bills to receive", (sb) =>
    sb
      .from("purchase_bills")
      .select(
        "id, bill_no, purchase_bill_lines(line_no, description, quantity::text, kind, account_id)",
      )
      .eq("client_id", clientId)
      .eq("status", "posted")
      .order("bill_date", { ascending: false })
      .limit(200),
  );
  return rows.flatMap((b) =>
    (b.purchase_bill_lines ?? [])
      .filter((l) => l.kind === "inventory")
      .map((l) => ({
        bill_id: b.id,
        bill_no: b.bill_no,
        line_no: l.line_no,
        description: l.description,
        quantity: l.quantity,
        account_id: l.account_id,
      })),
  );
}

/** Posted invoice lines that stock can be issued against or returned from. */
export interface IssuableInvoiceLine {
  invoice_id: string;
  invoice_no: string;
  line_no: number;
  description: string;
  quantity: string;
}
export async function listPostedInvoiceLines(clientId: string): Promise<IssuableInvoiceLine[]> {
  const rows = await q<
    {
      id: string;
      invoice_no: string;
      sales_invoice_lines: { line_no: number; description: string; quantity: string }[];
    }[]
  >("invoices to issue", (sb) =>
    sb
      .from("sales_invoices")
      .select("id, invoice_no, sales_invoice_lines(line_no, description, quantity::text)")
      .eq("client_id", clientId)
      .eq("status", "posted")
      .order("invoice_date", { ascending: false })
      .limit(200),
  );
  return rows.flatMap((r) =>
    (r.sales_invoice_lines ?? []).map((l) => ({
      invoice_id: r.id,
      invoice_no: r.invoice_no,
      line_no: l.line_no,
      description: l.description,
      quantity: l.quantity,
    })),
  );
}
