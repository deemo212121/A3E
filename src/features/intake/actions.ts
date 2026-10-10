"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { pathFor } from "@/lib/access/route-policy";
import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { requiredForKind } from "@/lib/intake/rules";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { requireActionAccess } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";
import {
  canProposeProfile,
  isStaffOn,
  requireIntakeStaff,
  requireIntakeWriter,
} from "@/server/intake/access";

/*
 * Intake actions: (1) Zod validation with field-level messages, (2) server
 * pre-check of the caller's role on the client, (3) a database function that
 * re-checks everything, enforces the workflow and duplicate rules, and audits.
 * Creates carry an idempotency key fixed when the form was rendered, so a
 * double-click or a retried request records the record once.
 */

type Result = ActionResult<string>;

const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;
const TIN = /^\d{9}(\d{3,5})?$/;
const amountField = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .refine((v) => v === "" || AMOUNT.test(v), "Use digits with up to 2 decimals, e.g. 1250.50");
const tinField = z
  .string()
  .trim()
  .refine(
    (v) => v === "" || TIN.test(v.replace(/[\s-]/g, "")),
    "TIN: 9 digits plus an optional 3-5 digit branch code",
  );
const optionalText = (max: number) => z.string().trim().max(max).optional().default("");
const key = z.string().min(8).max(200);
const uuidOrEmpty = z
  .union([z.literal(""), z.uuid()])
  .optional()
  .default("");

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}

function jsonArray<T extends z.ZodType>(item: T, max: number, message: string) {
  return z
    .string()
    .optional()
    .default("[]")
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
    })
    .pipe(z.array(item).max(max));
}

/** Exact amount comparison in integer centavos (validated input only). */
function cents(v: string): bigint {
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole || "0") * 100n + BigInt((frac + "00").slice(0, 2));
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
const lineSchema = z.object({
  description: z.string().trim().max(300).optional().default(""),
  quantity: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,14}(\.\d{1,4})?$/.test(v), "Quantity: up to 4 decimals")
    .optional()
    .default(""),
  unit_price: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,14}(\.\d{1,4})?$/.test(v), "Unit price: up to 4 decimals")
    .optional()
    .default(""),
  amount: z
    .string()
    .trim()
    .refine((v) => AMOUNT.test(v.replace(/,/g, "")), "Each line needs an amount"),
  account_hint: z.string().trim().max(100).optional().default(""),
});

const txnSchema = z
  .object({
    clientId: z.uuid(),
    transactionId: uuidOrEmpty,
    expectedVersion: z.string().optional().default(""),
    idempotencyKey: key,
    intent: z.enum(["save", "submit"]).default("save"),
    kind: z.enum(
      ["sale", "purchase", "expense", "collection", "payment", "payroll", "inventory", "other"],
      {
        error: "Choose the transaction type",
      },
    ),
    txnDate: z.union([z.literal(""), z.iso.date("Choose a valid date")]).default(""),
    documentType: optionalText(40),
    documentRef: optionalText(100),
    counterpartyId: uuidOrEmpty,
    counterpartyName: optionalText(200),
    counterpartyTin: tinField.optional().default(""),
    description: optionalText(500),
    grossAmount: amountField.default(""),
    vatAmount: amountField.default(""),
    whtAmount: amountField.default(""),
    paymentMethod: optionalText(40),
    lines: jsonArray(lineSchema, 200, "Invalid lines"),
    documentIds: jsonArray(z.uuid(), 20, "Invalid attachments"),
  })
  .superRefine((v, ctx) => {
    const add = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (v.counterpartyTin && !v.counterpartyName && !v.counterpartyId) {
      add("counterpartyName", "Enter the name for this TIN");
    }
    if (v.grossAmount && v.vatAmount && cents(v.vatAmount) > cents(v.grossAmount)) {
      add("vatAmount", "VAT cannot be more than the total");
    }
    if (v.grossAmount && v.whtAmount && cents(v.whtAmount) > cents(v.grossAmount)) {
      add("whtAmount", "Withholding cannot be more than the total");
    }
    if (v.intent !== "submit") return;
    // Same rules as private.assert_txn_complete.
    const need = requiredForKind(v.kind);
    if (!v.txnDate) add("txnDate", "Required to submit");
    if (!v.grossAmount) add("grossAmount", "Required to submit");
    if (need.counterparty && !v.counterpartyName && !v.counterpartyId)
      add("counterpartyName", "Required to submit");
    if (need.documentRef && !v.documentRef) add("documentRef", "Required for sales and purchases");
    if (need.description && !v.description) add("description", "Required to submit");
    if (v.grossAmount && v.lines.length > 0) {
      const sum = v.lines.reduce((s, l) => s + cents(l.amount.replace(/,/g, "")), 0n);
      if (sum !== cents(v.grossAmount)) add("lines", "The line amounts must add up to the total");
    }
  });

function txnPath(
  access: Awaited<ReturnType<typeof requireActionAccess>>,
  clientId: string,
  id: string,
) {
  return isStaffOn(access, clientId)
    ? pathFor("staff.intake_txn", { clientId, itemId: id })
    : pathFor("portal.transaction", { clientId, itemId: id });
}

export async function saveTransactionAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.saveTransaction", txnSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    const id = await rpc<string>("save_intake_transaction", {
      p_client_id: i.clientId,
      p_transaction_id: i.transactionId || null,
      p_expected_version: i.expectedVersion ? Number(i.expectedVersion) : null,
      p_header: {
        kind: i.kind,
        txn_date: i.txnDate,
        document_type: i.documentType,
        document_ref: i.documentRef,
        counterparty_id: i.counterpartyId,
        counterparty_name: i.counterpartyName,
        counterparty_tin: i.counterpartyTin,
        description: i.description,
        gross_amount: i.grossAmount,
        vat_amount_stated: i.vatAmount,
        withholding_amount_stated: i.whtAmount,
        payment_method: i.paymentMethod,
      },
      p_lines: i.lines.map((l) => ({ ...l, amount: l.amount.replace(/,/g, "") })),
      p_document_ids: i.documentIds,
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit") {
      await rpc("transition_intake_transaction", {
        p_transaction_id: id,
        p_to: "submitted",
        p_comment: null,
      });
    }
    redirect(txnPath(access, i.clientId, id));
  });
}

const STATUSES = [
  "submitted",
  "needs_correction",
  "reviewed",
  "approved",
  "rejected",
  "cancelled",
] as const;
const transitionSchema = z.object({
  clientId: z.uuid(),
  id: z.uuid(),
  to: z.enum(STATUSES),
  comment: z.string().trim().max(2000).optional().default(""),
});

const DONE: Record<string, string> = {
  submitted: "Submitted for review.",
  needs_correction: "Returned for correction.",
  reviewed: "Marked as reviewed.",
  approved: "Approved.",
  rejected: "Rejected.",
  cancelled: "Cancelled.",
};

export async function transitionTransactionAction(
  _p: Result | null,
  fd: FormData,
): Promise<Result> {
  return runAction("intake.transitionTransaction", transitionSchema, fd, async (i) => {
    await requireActionAccess();
    await rpc("transition_intake_transaction", {
      p_transaction_id: i.id,
      p_to: i.to,
      p_comment: i.comment || null,
    });
    refresh();
    return DONE[i.to];
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
const commentSchema = z.object({
  clientId: z.uuid(),
  subject: z.enum(["business_profile", "counterparty", "transaction", "document", "import_batch"]),
  subjectId: z.uuid(),
  body: z.string().trim().min(1, "Write a comment").max(2000),
  visibility: z.enum(["client", "internal"]).default("client"),
  idempotencyKey: key,
});

export async function addCommentAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.comment", commentSchema, fd, async (i) => {
    await requireActionAccess();
    await rpc("add_intake_comment", {
      p_client_id: i.clientId,
      p_subject: i.subject,
      p_subject_id: i.subjectId,
      p_body: i.body,
      p_visibility: i.visibility,
      p_idempotency_key: i.idempotencyKey,
    });
    refresh();
    return i.visibility === "internal" ? "Internal note added." : "Comment added.";
  });
}

// ---------------------------------------------------------------------------
// Customers and suppliers
// ---------------------------------------------------------------------------
const counterpartySchema = z.object({
  clientId: z.uuid(),
  counterpartyId: uuidOrEmpty,
  expectedVersion: z.string().optional().default(""),
  idempotencyKey: key,
  intent: z.enum(["save", "submit", "approve"]).default("submit"),
  kind: z.enum(["customer", "supplier", "both"], { error: "Choose customer, supplier or both" }),
  registeredName: z.string().trim().min(1, "Enter the registered name").max(200),
  tin: tinField.optional().default(""),
  vatStatus: z.enum(["unknown", "vat_registered", "non_vat"]).default("unknown"),
  address: optionalText(500),
  email: z
    .union([z.literal(""), z.email("Enter a valid email")])
    .optional()
    .default(""),
  phone: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9+() -]{7,20}$/.test(v), "Enter a valid phone number")
    .optional()
    .default(""),
});

export async function saveCounterpartyAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.saveCounterparty", counterpartySchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    if (i.intent === "approve") requireIntakeStaff(access, i.clientId);
    const id = await rpc<string>("save_counterparty", {
      p_client_id: i.clientId,
      p_counterparty_id: i.counterpartyId || null,
      p_expected_version: i.expectedVersion ? Number(i.expectedVersion) : null,
      p_fields: {
        kind: i.kind,
        registered_name: i.registeredName,
        tin: i.tin,
        vat_status: i.vatStatus,
        address: i.address,
        email: i.email,
        phone: i.phone,
      },
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit" || i.intent === "approve") {
      await rpc("transition_counterparty", {
        p_counterparty_id: id,
        p_to: "submitted",
        p_comment: null,
      });
    }
    if (i.intent === "approve") {
      await rpc("transition_counterparty", {
        p_counterparty_id: id,
        p_to: "approved",
        p_comment: null,
      });
    }
    refresh();
    return i.intent === "approve"
      ? "Saved and approved."
      : i.intent === "submit"
        ? "Saved and submitted."
        : "Saved.";
  });
}

export async function transitionCounterpartyAction(
  _p: Result | null,
  fd: FormData,
): Promise<Result> {
  return runAction("intake.transitionCounterparty", transitionSchema, fd, async (i) => {
    await requireActionAccess();
    await rpc("transition_counterparty", {
      p_counterparty_id: i.id,
      p_to: i.to,
      p_comment: i.comment || null,
    });
    refresh();
    return DONE[i.to];
  });
}

const bulkSchema = z.object({
  clientId: z.uuid(),
  ids: jsonArray(z.uuid(), 5000, "Invalid selection"),
});

export async function approveCounterpartiesAction(
  _p: Result | null,
  fd: FormData,
): Promise<Result> {
  return runAction("intake.approveCounterparties", bulkSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeStaff(access, i.clientId);
    const n = await rpc<number>("approve_counterparties", {
      p_client_id: i.clientId,
      p_ids: i.ids,
    });
    refresh();
    return `${n} approved.`;
  });
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------
const profileSchema = z.object({
  clientId: z.uuid(),
  profileId: uuidOrEmpty,
  expectedVersion: z.string().optional().default(""),
  idempotencyKey: key,
  intent: z.enum(["save", "submit"]).default("save"),
  registeredName: optionalText(200),
  tradeName: optionalText(200),
  tin: tinField.optional().default(""),
  rdoCode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9]{2,3}[A-Za-z]?$/.test(v), "RDO code, e.g. 025 or 25A")
    .optional()
    .default(""),
  businessType: optionalText(40),
  vatStatus: optionalText(20),
  registeredAddress: optionalText(500),
  zipCode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{4}$/.test(v), "ZIP code: 4 digits")
    .optional()
    .default(""),
  lineOfBusiness: optionalText(200),
  fiscalYearEndMonth: z
    .string()
    .trim()
    .refine((v) => v === "" || /^([1-9]|1[0-2])$/.test(v), "Month 1 to 12")
    .optional()
    .default(""),
  contactEmail: z
    .union([z.literal(""), z.email("Enter a valid email")])
    .optional()
    .default(""),
  contactPhone: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9+() -]{7,20}$/.test(v), "Enter a valid phone number")
    .optional()
    .default(""),
  notes: optionalText(1000),
});

export async function saveProfileAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.saveProfile", profileSchema, fd, async (i) => {
    const access = await requireActionAccess();
    if (!canProposeProfile(access, i.clientId)) {
      throw new AppError("FORBIDDEN", "cannot propose profile", {
        publicMessage: "Only the business owner or the firm can change the business profile.",
      });
    }
    const id = await rpc<string>("save_business_profile", {
      p_client_id: i.clientId,
      p_profile_id: i.profileId || null,
      p_expected_version: i.expectedVersion ? Number(i.expectedVersion) : null,
      p_fields: {
        registered_name: i.registeredName,
        trade_name: i.tradeName,
        tin: i.tin,
        rdo_code: i.rdoCode,
        business_type: i.businessType,
        vat_status: i.vatStatus,
        registered_address: i.registeredAddress,
        zip_code: i.zipCode,
        line_of_business: i.lineOfBusiness,
        fiscal_year_end_month: i.fiscalYearEndMonth,
        contact_email: i.contactEmail,
        contact_phone: i.contactPhone,
        notes: i.notes,
      },
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit") {
      await rpc("transition_business_profile", {
        p_profile_id: id,
        p_to: "submitted",
        p_comment: null,
      });
    }
    refresh();
    return i.intent === "submit" ? "Submitted for review." : "Draft saved.";
  });
}

export async function transitionProfileAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.transitionProfile", transitionSchema, fd, async (i) => {
    await requireActionAccess();
    await rpc("transition_business_profile", {
      p_profile_id: i.id,
      p_to: i.to,
      p_comment: i.comment || null,
    });
    refresh();
    return DONE[i.to];
  });
}
