import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/* Sales read models (RLS applies; amounts as exact text). */

type Named = { registered_name: string } | { registered_name: string }[] | null;
const nameOf = (c: Named) => (Array.isArray(c) ? c[0]?.registered_name : c?.registered_name) ?? "";

async function sb() {
  return createSupabaseServerClient();
}

export interface VatRate {
  rate: string;
  verification_status: string;
  legal_basis: string;
}
export async function getVatRate(): Promise<VatRate> {
  const { data, error } = await (
    await sb()
  )
    .from("tax_rates")
    .select("rate::text, verification_status, legal_basis")
    .eq("code", "VAT_STANDARD")
    .single();
  if (error) throw fromDbError(error, "select tax rate");
  return data as VatRate;
}

export interface SalesSettings {
  ar_account_id: string;
  sales_account_id: string;
  output_vat_account_id: string;
  sales_returns_account_id: string;
  cwt_account_id: string;
  customer_advances_account_id: string;
}
export async function getSalesSettings(clientId: string): Promise<SalesSettings | null> {
  const { data, error } = await (
    await sb()
  )
    .from("sales_settings")
    .select(
      "ar_account_id, sales_account_id, output_vat_account_id, sales_returns_account_id, cwt_account_id, customer_advances_account_id",
    )
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw fromDbError(error, "select sales settings");
  return data;
}

export interface InvoiceRow {
  id: string;
  invoice_no: string;
  invoice_date: string;
  due_date: string;
  status: string;
  total_amount: string;
  customer: string;
}
export async function listInvoices(clientId: string, status?: string): Promise<InvoiceRow[]> {
  let q = (await sb())
    .from("sales_invoices")
    .select(
      "id, invoice_no, invoice_date, due_date, status, total_amount::text, counterparties(registered_name)",
    )
    .eq("client_id", clientId)
    .order("invoice_date", { ascending: false })
    .order("invoice_no", { ascending: false })
    .limit(300);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw fromDbError(error, "select sales invoices");
  return (data ?? []).map((r) => ({
    ...(r as unknown as InvoiceRow),
    customer: nameOf(r.counterparties as Named),
  }));
}

export interface InvoiceDetail {
  id: string;
  counterparty_id: string;
  customer: string;
  invoice_no: string;
  invoice_date: string;
  due_date: string;
  sale_type: string;
  prices_include_vat: boolean;
  memo: string | null;
  status: string;
  vat_rate: string;
  vat_rate_status: string;
  gross_amount: string;
  discount_amount: string;
  vatable_sales: string;
  zero_rated_sales: string;
  exempt_sales: string;
  not_subject_sales: string;
  vat_amount: string;
  total_amount: string;
  row_version: number;
  prepared_by: string | null;
  review_comment: string | null;
  journal_entry_id: string | null;
  cancel_journal_entry_id: string | null;
  cancel_reason: string | null;
  intake_transaction_id: string | null;
  lines: {
    line_no: number;
    description: string;
    quantity: string;
    unit_price: string;
    discount_amount: string;
    tax_class: string;
    revenue_account_id: string | null;
    line_amount: string;
    net_amount: string;
    vat_amount: string;
  }[];
  credit_notes: {
    id: string;
    credit_note_no: string;
    credit_date: string;
    reason: string;
    status: string;
    total_amount: string;
    prepared_by: string | null;
  }[];
  payments: {
    receipt_id: string;
    receipt_no: string;
    receipt_date: string;
    status: string;
    amount: string;
  }[];
}

export async function getInvoice(clientId: string, id: string): Promise<InvoiceDetail | null> {
  const { data, error } = await (
    await sb()
  )
    .from("sales_invoices")
    .select(
      "id, counterparty_id, invoice_no, invoice_date, due_date, sale_type, prices_include_vat, memo, status, vat_rate::text, vat_rate_status, gross_amount::text, discount_amount::text, vatable_sales::text, zero_rated_sales::text, exempt_sales::text, not_subject_sales::text, vat_amount::text, total_amount::text, row_version, prepared_by, review_comment, journal_entry_id, cancel_journal_entry_id, cancel_reason, intake_transaction_id, counterparties(registered_name), sales_invoice_lines(line_no, description, quantity::text, unit_price::text, discount_amount::text, tax_class, revenue_account_id, line_amount::text, net_amount::text, vat_amount::text), sales_credit_notes(id, credit_note_no, credit_date, reason, status, total_amount::text, prepared_by), sales_receipt_allocations(amount::text, sales_receipts(id, receipt_no, receipt_date, status))",
    )
    .eq("client_id", clientId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromDbError(error, "select sales invoice");
  if (!data) return null;
  const d = data as Record<string, unknown>;
  type Alloc = {
    amount: string;
    sales_receipts: { id: string; receipt_no: string; receipt_date: string; status: string } | null;
  };
  return {
    ...(d as unknown as InvoiceDetail),
    customer: nameOf(d.counterparties as Named),
    lines: [...((d.sales_invoice_lines as InvoiceDetail["lines"]) ?? [])].sort(
      (a, b) => a.line_no - b.line_no,
    ),
    credit_notes: (d.sales_credit_notes as InvoiceDetail["credit_notes"]) ?? [],
    payments: ((d.sales_receipt_allocations as Alloc[]) ?? [])
      .filter((a) => a.sales_receipts)
      .map((a) => ({
        receipt_id: a.sales_receipts!.id,
        receipt_no: a.sales_receipts!.receipt_no,
        receipt_date: a.sales_receipts!.receipt_date,
        status: a.sales_receipts!.status,
        amount: a.amount,
      })),
  };
}

export interface BalanceRow {
  invoice_id: string;
  invoice_no: string;
  counterparty_id: string;
  customer_name: string;
  invoice_date: string;
  due_date: string;
  total: string;
  credited: string;
  paid: string;
  outstanding: string;
  days_overdue: number;
}
export async function getBalances(clientId: string, asOf: string): Promise<BalanceRow[]> {
  const { data, error } = await (
    await sb()
  ).rpc("sales_invoice_balances", { p_client_id: clientId, p_as_of: asOf });
  if (error) throw fromDbError(error, "sales_invoice_balances");
  return (data ?? []) as BalanceRow[];
}

export interface AgingRow {
  counterparty_id: string;
  customer_name: string;
  not_due: string;
  days_1_30: string;
  days_31_60: string;
  days_61_90: string;
  over_90: string;
  total: string;
}
export async function getAging(clientId: string, asOf: string): Promise<AgingRow[]> {
  const { data, error } = await (
    await sb()
  ).rpc("ar_aging", { p_client_id: clientId, p_as_of: asOf });
  if (error) throw fromDbError(error, "ar_aging");
  return (data ?? []) as AgingRow[];
}

export async function getReconciliation(
  clientId: string,
  asOf: string,
): Promise<{ subledger_total: string; ledger_balance: string; difference: string } | null> {
  const { data, error } = await (
    await sb()
  ).rpc("ar_reconciliation", { p_client_id: clientId, p_as_of: asOf });
  if (error) throw fromDbError(error, "ar_reconciliation");
  return (
    (
      (data ?? []) as { subledger_total: string; ledger_balance: string; difference: string }[]
    )[0] ?? null
  );
}

export interface ReceiptRow {
  id: string;
  receipt_no: string;
  receipt_date: string;
  status: string;
  amount_received: string;
  withholding_amount: string;
  customer: string;
}
export async function listReceipts(clientId: string): Promise<ReceiptRow[]> {
  const { data, error } = await (
    await sb()
  )
    .from("sales_receipts")
    .select(
      "id, receipt_no, receipt_date, status, amount_received::text, withholding_amount::text, counterparties(registered_name)",
    )
    .eq("client_id", clientId)
    .order("receipt_date", { ascending: false })
    .limit(300);
  if (error) throw fromDbError(error, "select receipts");
  return (data ?? []).map((r) => ({
    ...(r as unknown as ReceiptRow),
    customer: nameOf(r.counterparties as Named),
  }));
}

export interface ReceiptDetail {
  id: string;
  counterparty_id: string;
  customer: string;
  receipt_no: string;
  receipt_date: string;
  payment_method: string;
  deposit_account_id: string;
  amount_received: string;
  withholding_amount: string;
  reference: string | null;
  memo: string | null;
  status: string;
  row_version: number;
  prepared_by: string | null;
  review_comment: string | null;
  journal_entry_id: string | null;
  cancel_reason: string | null;
  allocations: { invoice_id: string; invoice_no: string; amount: string }[];
}
export async function getReceipt(clientId: string, id: string): Promise<ReceiptDetail | null> {
  const { data, error } = await (
    await sb()
  )
    .from("sales_receipts")
    .select(
      "id, counterparty_id, receipt_no, receipt_date, payment_method, deposit_account_id, amount_received::text, withholding_amount::text, reference, memo, status, row_version, prepared_by, review_comment, journal_entry_id, cancel_reason, counterparties(registered_name), sales_receipt_allocations(invoice_id, amount::text, sales_invoices(invoice_no))",
    )
    .eq("client_id", clientId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromDbError(error, "select receipt");
  if (!data) return null;
  const d = data as Record<string, unknown>;
  type A = {
    invoice_id: string;
    amount: string;
    sales_invoices: { invoice_no: string } | { invoice_no: string }[] | null;
  };
  return {
    ...(d as unknown as ReceiptDetail),
    customer: nameOf(d.counterparties as Named),
    allocations: ((d.sales_receipt_allocations as A[]) ?? []).map((a) => ({
      invoice_id: a.invoice_id,
      amount: a.amount,
      invoice_no:
        (Array.isArray(a.sales_invoices)
          ? a.sales_invoices[0]?.invoice_no
          : a.sales_invoices?.invoice_no) ?? "",
    })),
  };
}
