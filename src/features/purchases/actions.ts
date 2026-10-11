"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { pathFor } from "@/lib/access/route-policy";
import type { ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { requireActionAccess } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";
import { requireIntakeStaff } from "@/server/intake/access";

/*
 * Purchases actions: Zod validation, a server pre-check (assigned firm staff),
 * then database functions that re-check roles, sign-offs, maker-checker,
 * duplicates and balances, compute every amount, and post.
 */

type Result = ActionResult<string>;
const key = z.string().min(8).max(200);
const uuidOrEmpty = z
  .union([z.literal(""), z.uuid()])
  .optional()
  .default("");
const text = (max: number) => z.string().trim().max(max).optional().default("");
const date = z.iso.date("Choose a valid date");
const optDate = z
  .union([z.literal(""), z.iso.date("Choose a valid date")])
  .optional()
  .default("");
const amount = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .refine((v) => v === "" || /^\d{1,16}(\.\d{1,2})?$/.test(v), "Use digits with up to 2 decimals");
const decimal4 = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .pipe(z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "Up to 4 decimals"));

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}
function jsonArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .string()
    .optional()
    .default("[]")
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid lines" });
        return z.NEVER;
      }
    })
    .pipe(z.array(item).max(max));
}
async function staffOn(clientId: string) {
  const access = await requireActionAccess();
  requireIntakeStaff(access, clientId);
}

// ---------------------------------------------------------------------------
const billLine = z.object({
  description: z.string().trim().max(300).optional().default(""),
  quantity: decimal4,
  unit_price: decimal4,
  discount_amount: amount.optional().default(""),
  tax_class: z.enum(["vatable", "zero_rated", "exempt", "not_subject"]),
  vat_category: z.enum(["", "goods", "services", "capital_goods"]).optional().default(""),
  category_id: z.uuid("Choose a category on every line"),
  withholding_code_id: uuidOrEmpty,
  source_supplier_name: text(200),
  source_supplier_tin: text(30),
  source_document_ref: text(100),
});
const billSchema = z.object({
  clientId: z.uuid(),
  idempotencyKey: key,
  intent: z.enum(["save", "submit"]).default("save"),
  billType: z.enum(["bill", "cash_purchase", "reimbursement"]),
  counterpartyId: z.uuid("Choose the supplier or payee"),
  billNo: z.string().trim().min(1, "Enter the supplier's invoice/receipt number").max(60),
  billDate: date,
  dueDate: optDate,
  paidFromAccountId: uuidOrEmpty,
  pricesIncludeVat: z.enum(["true", "false"]).default("false"),
  memo: text(500),
  intakeTransactionId: uuidOrEmpty,
  lines: jsonArray(billLine, 500).refine((a) => a.length > 0, "Add at least one line"),
  documentIds: jsonArray(z.uuid(), 20),
});

export async function saveBillAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("purchases.saveBill", billSchema, fd, async (i) => {
    await staffOn(i.clientId);
    const id = await rpc<string>("save_purchase_bill", {
      p_client_id: i.clientId,
      p_bill_id: null,
      p_expected_version: null,
      p_header: {
        bill_type: i.billType,
        counterparty_id: i.counterpartyId,
        bill_no: i.billNo,
        bill_date: i.billDate,
        due_date: i.dueDate,
        paid_from_account_id: i.paidFromAccountId,
        prices_include_vat: i.pricesIncludeVat === "true",
        memo: i.memo,
        intake_transaction_id: i.intakeTransactionId,
      },
      p_lines: i.lines,
      p_document_ids: i.documentIds,
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit")
      await rpc("submit_sales_document", { p_subject: "purchase_bill", p_id: id });
    redirect(pathFor("staff.purchase_bill", { clientId: i.clientId, itemId: id }));
  });
}

// ---------------------------------------------------------------------------
const paymentSchema = z.object({
  clientId: z.uuid(),
  idempotencyKey: key,
  intent: z.enum(["save", "submit"]).default("save"),
  counterpartyId: z.uuid("Choose the supplier or payee"),
  paymentNo: z.string().trim().min(1, "Enter the voucher/check number").max(60),
  paymentDate: date,
  paymentMethod: z.enum(["cash", "check", "bank_transfer", "e_wallet", "credit_card", "other"]),
  paidFromAccountId: z.uuid("Choose the account it was paid from"),
  amountPaid: amount.refine((v) => v !== "", "Enter the amount"),
  reference: text(100),
  memo: text(500),
  allocations: jsonArray(z.object({ bill_id: z.uuid(), amount }), 500),
});

export async function savePaymentAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("purchases.savePayment", paymentSchema, fd, async (i) => {
    await staffOn(i.clientId);
    const id = await rpc<string>("save_supplier_payment", {
      p_client_id: i.clientId,
      p_payment_id: null,
      p_expected_version: null,
      p_header: {
        counterparty_id: i.counterpartyId,
        payment_no: i.paymentNo,
        payment_date: i.paymentDate,
        payment_method: i.paymentMethod,
        paid_from_account_id: i.paidFromAccountId,
        amount_paid: i.amountPaid,
        reference: i.reference,
        memo: i.memo,
      },
      p_allocations: i.allocations.filter((a) => a.amount && a.amount !== "0"),
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit")
      await rpc("submit_sales_document", { p_subject: "supplier_payment", p_id: id });
    redirect(pathFor("staff.supplier_payment", { clientId: i.clientId, itemId: id }));
  });
}

// ---------------------------------------------------------------------------
const configSchema = z.object({
  clientId: z.uuid(),
  op: z.enum([
    "propose_code",
    "sign_off_code",
    "retire_code",
    "propose_category",
    "approve_category",
    "retire_category",
    "default_categories",
    "default_settings",
    "settings",
  ]),
  id: uuidOrEmpty,
  code: text(12),
  description: text(300),
  rate: text(12),
  base: z.enum(["", "net_of_vat", "gross"]).optional().default(""),
  legalBasis: text(500),
  effectiveFrom: optDate,
  effectiveTo: optDate,
  name: text(100),
  kind: z.enum(["", "inventory", "fixed_asset", "prepayment", "expense"]).optional().default(""),
  accountId: uuidOrEmpty,
  ap: uuidOrEmpty,
  inputVat: uuidOrEmpty,
  whtPayable: uuidOrEmpty,
  advances: uuidOrEmpty,
  threshold: amount.optional().default(""),
});

export async function purchaseConfigAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("purchases.config", configSchema, fd, async (i) => {
    await staffOn(i.clientId);
    switch (i.op) {
      case "propose_code":
        await rpc("propose_withholding_code", {
          p_code: i.code,
          p_description: i.description,
          p_rate: i.rate,
          p_base: i.base,
          p_legal_basis: i.legalBasis,
          p_effective_from: i.effectiveFrom || null,
          p_effective_to: i.effectiveTo || null,
        });
        break;
      case "sign_off_code":
        await rpc("sign_off_withholding_code", { p_id: i.id });
        break;
      case "retire_code":
        await rpc("retire_withholding_code", { p_id: i.id, p_effective_to: i.effectiveTo || null });
        break;
      case "propose_category":
        await rpc("propose_purchase_category", {
          p_client_id: i.clientId,
          p_name: i.name,
          p_kind: i.kind,
          p_account_id: i.accountId,
        });
        break;
      case "approve_category":
        await rpc("approve_purchase_category", { p_id: i.id });
        break;
      case "retire_category":
        await rpc("retire_purchase_category", { p_id: i.id });
        break;
      case "default_categories":
        await rpc("propose_default_purchase_categories", { p_client_id: i.clientId });
        break;
      case "default_settings":
        await rpc("apply_default_purchase_settings", { p_client_id: i.clientId });
        break;
      case "settings":
        await rpc("set_purchase_settings", {
          p_client_id: i.clientId,
          p_ap: i.ap,
          p_input_vat: i.inputVat,
          p_wht_payable: i.whtPayable,
          p_advances: i.advances,
          p_threshold: i.threshold,
        });
        break;
    }
    refresh();
    return "Saved.";
  });
}
