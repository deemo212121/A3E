/**
 * Canonical intake vocabulary and required-field rules, shared by the forms,
 * the importer and the tests. The DATABASE enforces the same rules
 * (private.assert_txn_complete); these copies give earlier, field-level
 * messages. Keep them in sync.
 */

export const TXN_KINDS = [
  { value: "sale", label: "Sale" },
  { value: "purchase", label: "Purchase" },
  { value: "expense", label: "Expense" },
  { value: "collection", label: "Collection (cash received)" },
  { value: "payment", label: "Payment (cash paid out)" },
  { value: "payroll", label: "Payroll" },
  { value: "inventory", label: "Inventory movement" },
  { value: "other", label: "Other" },
] as const;
export type TxnKind = (typeof TXN_KINDS)[number]["value"];

export const DOCUMENT_TYPES = [
  { value: "", label: "—" },
  { value: "sales_invoice", label: "Sales invoice" },
  { value: "official_receipt", label: "Official receipt" },
  { value: "billing_statement", label: "Billing statement" },
  { value: "delivery_receipt", label: "Delivery receipt" },
  { value: "cash_voucher", label: "Cash voucher" },
  { value: "payroll_register", label: "Payroll register" },
  { value: "bank_record", label: "Bank record" },
  { value: "other", label: "Other" },
] as const;

export const PAYMENT_METHODS = [
  { value: "", label: "—" },
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "e_wallet", label: "E-wallet" },
  { value: "credit_card", label: "Credit card" },
  { value: "on_account", label: "On account (not yet paid)" },
  { value: "other", label: "Other" },
] as const;

export const DOCUMENT_CATEGORIES = [
  { value: "sales_invoice", label: "Sales invoice" },
  { value: "official_receipt", label: "Official receipt" },
  { value: "purchase_invoice", label: "Purchase invoice" },
  { value: "expense_receipt", label: "Expense receipt" },
  { value: "bank_statement", label: "Bank statement" },
  { value: "certificate_2307", label: "Certificate (BIR Form 2307)" },
  { value: "payroll", label: "Payroll" },
  { value: "registration", label: "Registration document" },
  { value: "import_source", label: "Import file" },
  { value: "other", label: "Other" },
] as const;

export const COUNTERPARTY_KINDS = [
  { value: "supplier", label: "Supplier" },
  { value: "customer", label: "Customer" },
  { value: "both", label: "Customer and supplier" },
] as const;

export const VAT_STATUSES = [
  { value: "unknown", label: "Not sure" },
  { value: "vat_registered", label: "VAT-registered" },
  { value: "non_vat", label: "Non-VAT" },
] as const;

export const BUSINESS_TYPES = [
  { value: "sole_proprietorship", label: "Sole proprietorship" },
  { value: "partnership", label: "Partnership" },
  { value: "corporation", label: "Corporation" },
  { value: "one_person_corporation", label: "One Person Corporation" },
  { value: "cooperative", label: "Cooperative" },
  { value: "other", label: "Other" },
] as const;

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  needs_correction: "Needs correction",
  reviewed: "Reviewed",
  approved: "Approved",
  rejected: "Rejected",
  posted: "Posted",
  cancelled: "Cancelled",
  pending: "Pending review",
  accepted: "Accepted",
};

export const STATUS_TONES: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  submitted: "info",
  needs_correction: "warning",
  reviewed: "info",
  approved: "success",
  rejected: "danger",
  posted: "success",
  cancelled: "neutral",
  pending: "neutral",
  accepted: "success",
};

export function labelOf(
  list: readonly { value: string; label: string }[],
  value: string | null | undefined,
) {
  return list.find((i) => i.value === value)?.label ?? value ?? "—";
}

/** Fields required to SUBMIT a transaction of a given kind (drafts may be incomplete). */
export function requiredForKind(kind: string): {
  counterparty: boolean;
  documentRef: boolean;
  description: boolean;
} {
  return {
    counterparty: ["sale", "purchase", "expense", "collection", "payment"].includes(kind),
    documentRef: ["sale", "purchase"].includes(kind),
    description: ["payroll", "inventory", "other"].includes(kind),
  };
}

/** Today's date in the Philippines (YYYY-MM-DD). */
export function todayPh(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
}
