import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/* Purchases read models (RLS applies; amounts as exact text). */

type Named = { registered_name: string } | { registered_name: string }[] | null;
const nameOf = (c: Named) => (Array.isArray(c) ? c[0]?.registered_name : c?.registered_name) ?? "";

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

export interface PurchaseSettings {
  ap_account_id: string;
  input_vat_account_id: string;
  withholding_payable_account_id: string;
  supplier_advances_account_id: string;
  capitalization_threshold: string | null;
}
export const getPurchaseSettings = (clientId: string) =>
  q<PurchaseSettings | null>("purchase settings", (sb) =>
    sb
      .from("purchase_settings")
      .select(
        "ap_account_id, input_vat_account_id, withholding_payable_account_id, supplier_advances_account_id, capitalization_threshold::text",
      )
      .eq("client_id", clientId)
      .maybeSingle(),
  );

export interface CategoryRow {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  status: string;
  proposed_by: string | null;
  accounts: { code: string; name: string } | null;
}
export const listCategories = (clientId: string) =>
  q<CategoryRow[]>("purchase categories", (sb) =>
    sb
      .from("purchase_categories")
      .select(
        "id, name, kind, account_id, status, proposed_by, accounts!purchase_categories_client_id_account_id_fkey(code, name)",
      )
      .eq("client_id", clientId)
      .neq("status", "retired")
      .order("name"),
  );

export interface WithholdingCodeRow {
  id: string;
  code: string;
  version: number;
  description: string;
  rate: string;
  base: string;
  legal_basis: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  entered_by: string | null;
}
export const listWithholdingCodes = () =>
  q<WithholdingCodeRow[]>("withholding codes", (sb) =>
    sb
      .from("withholding_codes")
      .select(
        "id, code, version, description, rate::text, base, legal_basis, effective_from, effective_to, status, entered_by",
      )
      .order("code")
      .order("version", { ascending: false }),
  );

export interface BillRow {
  id: string;
  bill_type: string;
  bill_no: string;
  bill_date: string;
  status: string;
  gross_amount: string;
  withholding_amount: string;
  payable_amount: string;
  supplier: string;
}
export async function listBills(clientId: string): Promise<BillRow[]> {
  const rows = await q<Record<string, unknown>[]>("bills", (sb) =>
    sb
      .from("purchase_bills")
      .select(
        "id, bill_type, bill_no, bill_date, status, gross_amount::text, withholding_amount::text, payable_amount::text, counterparties(registered_name)",
      )
      .eq("client_id", clientId)
      .order("bill_date", { ascending: false })
      .limit(300),
  );
  return rows.map((r) => ({
    ...(r as unknown as BillRow),
    supplier: nameOf(r.counterparties as Named),
  }));
}

export interface BillDetail extends BillRow {
  counterparty_id: string;
  due_date: string;
  paid_from_account_id: string | null;
  prices_include_vat: boolean;
  memo: string | null;
  vat_rate: string;
  vat_rate_status: string;
  net_amount: string;
  vat_amount: string;
  policy_flags: string[];
  row_version: number;
  prepared_by: string | null;
  review_comment: string | null;
  journal_entry_id: string | null;
  cancel_journal_entry_id: string | null;
  cancel_reason: string | null;
  lines: {
    line_no: number;
    description: string;
    quantity: string;
    unit_price: string;
    discount_amount: string;
    tax_class: string;
    vat_category: string | null;
    category_id: string;
    kind: string;
    source_supplier_name: string | null;
    source_supplier_tin: string | null;
    source_document_ref: string | null;
    withholding_code_id: string | null;
    withholding_amount: string;
    net_amount: string;
    vat_amount: string;
  }[];
  payments: {
    payment_id: string;
    payment_no: string;
    payment_date: string;
    status: string;
    amount: string;
  }[];
  documents: { id: string; original_filename: string }[];
}

export async function getBill(clientId: string, id: string): Promise<BillDetail | null> {
  const d = await q<Record<string, unknown> | null>("bill", (sb) =>
    sb
      .from("purchase_bills")
      .select(
        "id, bill_type, counterparty_id, bill_no, bill_date, due_date, paid_from_account_id, prices_include_vat, memo, status, vat_rate::text, vat_rate_status, net_amount::text, vat_amount::text, gross_amount::text, withholding_amount::text, payable_amount::text, policy_flags, row_version, prepared_by, review_comment, journal_entry_id, cancel_journal_entry_id, cancel_reason, counterparties(registered_name), purchase_bill_lines(line_no, description, quantity::text, unit_price::text, discount_amount::text, tax_class, vat_category, category_id, kind, source_supplier_name, source_supplier_tin, source_document_ref, withholding_code_id, withholding_amount::text, net_amount::text, vat_amount::text), supplier_payment_allocations(amount::text, supplier_payments(id, payment_no, payment_date, status)), purchase_bill_documents(documents(id, original_filename))",
      )
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!d) return null;
  type Alloc = {
    amount: string;
    supplier_payments: {
      id: string;
      payment_no: string;
      payment_date: string;
      status: string;
    } | null;
  };
  type Doc = { documents: { id: string; original_filename: string } | null };
  return {
    ...(d as unknown as BillDetail),
    supplier: nameOf(d.counterparties as Named),
    lines: [...((d.purchase_bill_lines as BillDetail["lines"]) ?? [])].sort(
      (a, b) => a.line_no - b.line_no,
    ),
    payments: ((d.supplier_payment_allocations as Alloc[]) ?? [])
      .filter((a) => a.supplier_payments)
      .map((a) => ({
        payment_id: a.supplier_payments!.id,
        payment_no: a.supplier_payments!.payment_no,
        payment_date: a.supplier_payments!.payment_date,
        status: a.supplier_payments!.status,
        amount: a.amount,
      })),
    documents: ((d.purchase_bill_documents as Doc[]) ?? [])
      .map((x) => x.documents!)
      .filter(Boolean),
  };
}

export interface PayableRow {
  bill_id: string;
  bill_no: string;
  counterparty_id: string;
  supplier_name: string;
  bill_date: string;
  due_date: string;
  payable: string;
  paid: string;
  outstanding: string;
  days_overdue: number;
}
export const getPayables = (clientId: string, asOf: string) =>
  q<PayableRow[]>("purchase_bill_balances", (sb) =>
    sb.rpc("purchase_bill_balances", { p_client_id: clientId, p_as_of: asOf }),
  );

export interface ApAgingRow {
  counterparty_id: string;
  supplier_name: string;
  not_due: string;
  days_1_30: string;
  days_31_60: string;
  days_61_90: string;
  over_90: string;
  total: string;
}
export const getApAging = (clientId: string, asOf: string) =>
  q<ApAgingRow[]>("ap_aging", (sb) => sb.rpc("ap_aging", { p_client_id: clientId, p_as_of: asOf }));

export async function getApReconciliation(clientId: string, asOf: string) {
  const rows = await q<{ subledger_total: string; ledger_balance: string; difference: string }[]>(
    "ap_reconciliation",
    (sb) => sb.rpc("ap_reconciliation", { p_client_id: clientId, p_as_of: asOf }),
  );
  return rows[0] ?? null;
}

export interface WithholdingSummaryRow {
  counterparty_id: string;
  payee_name: string;
  payee_tin: string | null;
  code: string;
  code_version: number;
  rate: string;
  base_total: string;
  withheld_total: string;
  bill_count: number;
}
export const getWithholdingSummary = (clientId: string, from: string, to: string) =>
  q<WithholdingSummaryRow[]>("withholding_summary", (sb) =>
    sb.rpc("withholding_summary", { p_client_id: clientId, p_from: from, p_to: to }),
  );

export interface PaymentRow {
  id: string;
  payment_no: string;
  payment_date: string;
  status: string;
  amount_paid: string;
  supplier: string;
}
export async function listPayments(clientId: string): Promise<PaymentRow[]> {
  const rows = await q<Record<string, unknown>[]>("payments", (sb) =>
    sb
      .from("supplier_payments")
      .select(
        "id, payment_no, payment_date, status, amount_paid::text, counterparties(registered_name)",
      )
      .eq("client_id", clientId)
      .order("payment_date", { ascending: false })
      .limit(300),
  );
  return rows.map((r) => ({
    ...(r as unknown as PaymentRow),
    supplier: nameOf(r.counterparties as Named),
  }));
}

export interface PaymentDetail extends PaymentRow {
  payment_method: string;
  reference: string | null;
  memo: string | null;
  prepared_by: string | null;
  review_comment: string | null;
  journal_entry_id: string | null;
  cancel_reason: string | null;
  allocations: { bill_id: string; bill_no: string; amount: string }[];
}
export async function getPayment(clientId: string, id: string): Promise<PaymentDetail | null> {
  const d = await q<Record<string, unknown> | null>("payment", (sb) =>
    sb
      .from("supplier_payments")
      .select(
        "id, payment_no, payment_date, payment_method, status, amount_paid::text, reference, memo, prepared_by, review_comment, journal_entry_id, cancel_reason, counterparties(registered_name), supplier_payment_allocations(bill_id, amount::text, purchase_bills(bill_no))",
      )
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!d) return null;
  type A = {
    bill_id: string;
    amount: string;
    purchase_bills: { bill_no: string } | { bill_no: string }[] | null;
  };
  return {
    ...(d as unknown as PaymentDetail),
    supplier: nameOf(d.counterparties as Named),
    allocations: ((d.supplier_payment_allocations as A[]) ?? []).map((a) => ({
      bill_id: a.bill_id,
      amount: a.amount,
      bill_no:
        (Array.isArray(a.purchase_bills)
          ? a.purchase_bills[0]?.bill_no
          : a.purchase_bills?.bill_no) ?? "",
    })),
  };
}
