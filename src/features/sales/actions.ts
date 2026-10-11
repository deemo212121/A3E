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
 * Sales actions: Zod validation, a server pre-check (assigned firm staff),
 * then a database function that re-checks roles, maker-checker, balances and
 * duplicates, computes all amounts, and posts through the accounting engine.
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
  return access;
}

// ---------------------------------------------------------------------------
const invoiceLine = z.object({
  description: z.string().trim().min(1, "Describe each line").max(300),
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,14}(\.\d{1,4})?$/, "Quantity: up to 4 decimals"),
  unit_price: z
    .string()
    .trim()
    .transform((v) => v.replace(/,/g, ""))
    .pipe(z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "Unit price: up to 4 decimals")),
  discount_amount: amount.optional().default(""),
  tax_class: z.enum(["vatable", "zero_rated", "exempt", "not_subject"]),
  revenue_account_id: uuidOrEmpty,
});

const invoiceSchema = z.object({
  clientId: z.uuid(),
  invoiceId: uuidOrEmpty,
  expectedVersion: z.string().optional().default(""),
  idempotencyKey: key,
  intent: z.enum(["save", "submit"]).default("save"),
  counterpartyId: z.uuid("Choose the customer"),
  invoiceNo: z.string().trim().min(1, "Enter the invoice number").max(60),
  invoiceDate: date,
  dueDate: optDate,
  saleType: z.enum(["cash", "credit"]),
  pricesIncludeVat: z.enum(["true", "false"]).default("false"),
  memo: text(500),
  intakeTransactionId: uuidOrEmpty,
  lines: jsonArray(invoiceLine, 500).refine((a) => a.length > 0, "Add at least one line"),
});

export async function saveInvoiceAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("sales.saveInvoice", invoiceSchema, fd, async (i) => {
    await staffOn(i.clientId);
    const id = await rpc<string>("save_sales_invoice", {
      p_client_id: i.clientId,
      p_invoice_id: i.invoiceId || null,
      p_expected_version: i.expectedVersion ? Number(i.expectedVersion) : null,
      p_header: {
        counterparty_id: i.counterpartyId,
        invoice_no: i.invoiceNo,
        invoice_date: i.invoiceDate,
        due_date: i.dueDate,
        sale_type: i.saleType,
        prices_include_vat: i.pricesIncludeVat === "true",
        memo: i.memo,
        intake_transaction_id: i.intakeTransactionId,
      },
      p_lines: i.lines,
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit")
      await rpc("submit_sales_document", { p_subject: "sales_invoice", p_id: id });
    redirect(pathFor("staff.sales_invoice", { clientId: i.clientId, itemId: id }));
  });
}

// ---------------------------------------------------------------------------
const docSchema = z.object({
  clientId: z.uuid(),
  subject: z.enum([
    "sales_invoice",
    "credit_note",
    "sales_receipt",
    "purchase_bill",
    "supplier_payment",
    "inventory_movement",
  ]),
  id: z.uuid(),
  op: z.enum(["submit", "post", "return", "cancel"]),
  comment: text(1000),
  reversalDate: optDate,
});

const POST_FN = {
  sales_invoice: "post_sales_invoice",
  credit_note: "post_credit_note",
  sales_receipt: "post_sales_receipt",
  purchase_bill: "post_purchase_bill",
  supplier_payment: "post_supplier_payment",
  inventory_movement: "post_inventory_movement",
};
const CANCEL_FN = {
  sales_invoice: ["cancel_sales_invoice", "p_invoice_id"],
  credit_note: ["cancel_credit_note", "p_credit_note_id"],
  sales_receipt: ["cancel_sales_receipt", "p_receipt_id"],
  purchase_bill: ["cancel_purchase_bill", "p_bill_id"],
  supplier_payment: ["cancel_supplier_payment", "p_payment_id"],
  inventory_movement: ["cancel_inventory_movement", "p_movement_id"],
} as const;
const ID_PARAM = {
  sales_invoice: "p_invoice_id",
  credit_note: "p_credit_note_id",
  sales_receipt: "p_receipt_id",
  purchase_bill: "p_bill_id",
  supplier_payment: "p_payment_id",
  inventory_movement: "p_movement_id",
};

export async function documentAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("sales.document", docSchema, fd, async (i) => {
    await staffOn(i.clientId);
    if (i.op === "submit") await rpc("submit_sales_document", { p_subject: i.subject, p_id: i.id });
    if (i.op === "return")
      await rpc("return_sales_document", {
        p_subject: i.subject,
        p_id: i.id,
        p_comment: i.comment,
      });
    if (i.op === "post") await rpc(POST_FN[i.subject], { [ID_PARAM[i.subject]]: i.id });
    if (i.op === "cancel") {
      const [fn, param] = CANCEL_FN[i.subject];
      await rpc(fn, {
        [param]: i.id,
        p_reason: i.comment,
        // stock movements reverse on their own date (moving-average order)
        ...(i.subject === "inventory_movement" ? {} : { p_reversal_date: i.reversalDate || null }),
      });
    }
    refresh();
    return {
      submit: "Submitted for posting.",
      post: "Posted to the books.",
      return: "Returned to the preparer.",
      cancel: "Cancelled.",
    }[i.op];
  });
}

// ---------------------------------------------------------------------------
const creditLine = z.object({
  description: z.string().trim().min(1, "Describe each line").max(300),
  amount: amount.refine((v) => v !== "", "Enter an amount"),
  tax_class: z.enum(["vatable", "zero_rated", "exempt", "not_subject"]),
});
const creditSchema = z.object({
  clientId: z.uuid(),
  invoiceId: z.uuid(),
  idempotencyKey: key,
  creditNoteNo: z.string().trim().min(1, "Enter the credit note number").max(60),
  creditDate: date,
  reasonType: z.enum(["return", "price_adjustment", "discount", "correction"]),
  reason: z.string().trim().min(3, "Give a reason").max(500),
  lines: jsonArray(creditLine, 100).refine((a) => a.length > 0, "Add at least one line"),
});

export async function saveCreditNoteAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("sales.saveCreditNote", creditSchema, fd, async (i) => {
    await staffOn(i.clientId);
    const id = await rpc<string>("save_credit_note", {
      p_client_id: i.clientId,
      p_credit_note_id: null,
      p_expected_version: null,
      p_header: {
        invoice_id: i.invoiceId,
        credit_note_no: i.creditNoteNo,
        credit_date: i.creditDate,
        reason_type: i.reasonType,
        reason: i.reason,
      },
      p_lines: i.lines,
      p_idempotency_key: i.idempotencyKey,
    });
    await rpc("submit_sales_document", { p_subject: "credit_note", p_id: id });
    refresh();
    return "Credit note recorded and submitted for posting.";
  });
}

// ---------------------------------------------------------------------------
const allocation = z.object({ invoice_id: z.uuid(), amount });
const receiptSchema = z.object({
  clientId: z.uuid(),
  receiptId: uuidOrEmpty,
  expectedVersion: z.string().optional().default(""),
  idempotencyKey: key,
  intent: z.enum(["save", "submit"]).default("save"),
  counterpartyId: z.uuid("Choose the customer"),
  receiptNo: z.string().trim().min(1, "Enter the receipt number").max(60),
  receiptDate: date,
  paymentMethod: z.enum(["cash", "check", "bank_transfer", "e_wallet", "credit_card", "other"]),
  depositAccountId: z.uuid("Choose where the money went"),
  amountReceived: amount,
  withholdingAmount: amount.optional().default(""),
  reference: text(100),
  memo: text(500),
  allocations: jsonArray(allocation, 500),
});

export async function saveReceiptAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("sales.saveReceipt", receiptSchema, fd, async (i) => {
    await staffOn(i.clientId);
    const id = await rpc<string>("save_sales_receipt", {
      p_client_id: i.clientId,
      p_receipt_id: i.receiptId || null,
      p_expected_version: i.expectedVersion ? Number(i.expectedVersion) : null,
      p_header: {
        counterparty_id: i.counterpartyId,
        receipt_no: i.receiptNo,
        receipt_date: i.receiptDate,
        payment_method: i.paymentMethod,
        deposit_account_id: i.depositAccountId,
        amount_received: i.amountReceived,
        withholding_amount: i.withholdingAmount,
        reference: i.reference,
        memo: i.memo,
      },
      p_allocations: i.allocations.filter((a) => a.amount !== "" && a.amount !== "0"),
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit")
      await rpc("submit_sales_document", { p_subject: "sales_receipt", p_id: id });
    redirect(pathFor("staff.sales_receipt", { clientId: i.clientId, itemId: id }));
  });
}

// ---------------------------------------------------------------------------
const settingsSchema = z.object({
  clientId: z.uuid(),
  mode: z.enum(["defaults", "custom"]),
  ar: uuidOrEmpty,
  sales: uuidOrEmpty,
  outputVat: uuidOrEmpty,
  returns: uuidOrEmpty,
  cwt: uuidOrEmpty,
  advances: uuidOrEmpty,
});

export async function salesSettingsAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("sales.settings", settingsSchema, fd, async (i) => {
    await staffOn(i.clientId);
    if (i.mode === "defaults") {
      await rpc("apply_default_sales_settings", { p_client_id: i.clientId });
    } else {
      await rpc("set_sales_settings", {
        p_client_id: i.clientId,
        p_ar: i.ar,
        p_sales: i.sales,
        p_output_vat: i.outputVat,
        p_returns: i.returns,
        p_cwt: i.cwt,
        p_advances: i.advances,
      });
    }
    refresh();
    return "Posting accounts saved.";
  });
}
