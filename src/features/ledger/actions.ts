"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { pathFor, REVIEW_ROLES, STAFF_ROLES } from "@/lib/access/route-policy";
import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { hasFirmRole, requireActionAccess, type Access } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";

/*
 * Ledger actions. Each one: (1) server pre-check of role + client assignment,
 * (2) a database function that re-checks everything, enforces the accounting
 * invariants atomically, and audits. The database is the final authority.
 */

type Result = ActionResult<string>;

const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;
// Format sanity check only (9-digit TIN + optional 3-5 digit branch code); the DB normalizes.
const TIN = /^\d{9}(\d{3,5})?$/;

function requireStaffOn(access: Access, clientId: string, roles: readonly string[] = STAFF_ROLES) {
  if (
    !hasFirmRole(access, roles as never) ||
    !access.staff_client_ids.includes(clientId.toLowerCase())
  ) {
    throw new AppError("FORBIDDEN", "not assigned to this client with the required role");
  }
}

async function call(fn: string, args: Record<string, unknown>) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------
const clientOnly = z.object({ clientId: z.uuid() });

export async function applyTemplateAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction(
    "ledger.applyTemplate",
    clientOnly.extend({ template: z.string().min(2).max(40) }),
    fd,
    async (i) => {
      const access = await requireActionAccess();
      requireStaffOn(access, i.clientId, ["firm_manager", "reviewer", "accountant"]);
      const n = await call("apply_coa_template", {
        p_client_id: i.clientId,
        p_template_code: i.template,
      });
      refresh();
      return `Chart of accounts created (${n} accounts).`;
    },
  );
}

const accountSchema = clientOnly.extend({
  code: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/, "1–20 letters, digits, dot or hyphen"),
  name: z.string().trim().min(1, "Required").max(200),
  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  normalBalance: z.enum(["debit", "credit"]),
  parentCode: z.string().trim().max(20).optional(),
  isPostable: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function createAccountAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.createAccount", accountSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, ["firm_manager", "reviewer", "accountant"]);
    await call("create_account", {
      p_client_id: i.clientId,
      p_code: i.code,
      p_name: i.name,
      p_account_type: i.accountType,
      p_normal_balance: i.normalBalance,
      p_parent_code: i.parentCode || null,
      p_is_postable: i.isPostable,
    });
    refresh();
    return `Account ${i.code} created.`;
  });
}

const accountActiveSchema = clientOnly.extend({
  accountId: z.uuid(),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function setAccountActiveAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.setAccountActive", accountActiveSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, ["firm_manager", "reviewer", "accountant"]);
    await call("update_account", {
      p_account_id: i.accountId,
      p_name: null,
      p_is_active: i.active,
    });
    refresh();
    return i.active ? "Account activated." : "Account deactivated.";
  });
}

// ---------------------------------------------------------------------------
// Fiscal years and periods
// ---------------------------------------------------------------------------
const fySchema = clientOnly.extend({
  startMonth: z.string().regex(/^\d{4}-\d{2}$/, "Choose a start month"),
  months: z.coerce.number().int().min(1).max(12).default(12),
});

export async function createFiscalYearAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.createFiscalYear", fySchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, REVIEW_ROLES);
    await call("create_fiscal_year", {
      p_client_id: i.clientId,
      p_start_date: `${i.startMonth}-01`,
      p_months: i.months,
    });
    refresh();
    return "Fiscal year opened.";
  });
}

const periodSchema = clientOnly.extend({
  periodId: z.uuid(),
  status: z.enum(["open", "soft_closed", "locked"]),
  reason: z.string().trim().max(500).optional(),
});

export async function setPeriodStatusAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.setPeriodStatus", periodSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, REVIEW_ROLES);
    await call("set_period_status", {
      p_period_id: i.periodId,
      p_status: i.status,
      p_reason: i.reason || null,
    });
    refresh();
    return "Period status updated.";
  });
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------
const lineSchema = z
  .object({
    account_id: z.uuid("Choose an account on every line"),
    debit: z.string().refine((v) => v === "" || AMOUNT.test(v), "Use digits with up to 2 decimals"),
    credit: z
      .string()
      .refine((v) => v === "" || AMOUNT.test(v), "Use digits with up to 2 decimals"),
    description: z.string().max(300).optional(),
    counterparty_name: z.string().trim().max(200).optional(),
    counterparty_tin: z
      .string()
      .trim()
      .refine(
        (v) => v === "" || TIN.test(v.replace(/[\s-]/g, "")),
        "TIN: 9 digits plus an optional 3-5 digit branch code",
      )
      .optional(),
    document_ref: z.string().trim().max(100).optional(),
  })
  .refine((l) => (l.debit === "") !== (l.credit === ""), "Each line needs a debit OR a credit")
  .refine(
    (l) => !l.counterparty_tin || Boolean(l.counterparty_name),
    "Enter the supplier/customer name for every TIN",
  );

const draftSchema = clientOnly.extend({
  entryId: z.union([z.literal(""), z.uuid()]).optional(),
  entryDate: z.iso.date("Choose a valid date"),
  entryType: z.enum(["general", "opening", "adjusting", "closing"]),
  memo: z.string().trim().max(500).optional(),
  sourceType: z
    .string()
    .trim()
    .regex(/^([a-z][a-z0-9_]{1,39})?$/, "lowercase letters, digits, underscore")
    .optional(),
  sourceRef: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().min(8).max(200),
  lines: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid lines" });
        return z.NEVER;
      }
    })
    .pipe(z.array(lineSchema).min(2, "Add at least two lines").max(500)),
});

export async function saveDraftAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.saveDraft", draftSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId);
    if (Boolean(i.sourceType) !== Boolean(i.sourceRef)) {
      throw new AppError("VALIDATION", "source type/ref mismatch", {
        fieldErrors: {
          sourceRef: ["Enter both the source type and the source reference, or neither."],
        },
      });
    }
    const id = (await call("save_draft_entry", {
      p_client_id: i.clientId,
      p_entry_id: i.entryId || null,
      p_entry_date: i.entryDate,
      p_entry_type: i.entryType,
      p_memo: i.memo ?? "",
      p_source_type: i.sourceType || null,
      p_source_ref: i.sourceRef || null,
      p_idempotency_key: i.idempotencyKey,
      p_lines: i.lines.map((l) => ({
        ...l,
        description: l.description ?? "",
        counterparty_name: l.counterparty_name ?? "",
        counterparty_tin: l.counterparty_tin ?? "",
        document_ref: l.document_ref ?? "",
      })),
    })) as string;
    redirect(pathFor("staff.entry", { clientId: i.clientId, entryId: id }));
  });
}

const entryOnly = clientOnly.extend({ entryId: z.uuid() });

export async function submitEntryAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.submit", entryOnly, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId);
    await call("submit_entry", { p_entry_id: i.entryId });
    refresh();
    return "Submitted for review.";
  });
}

export async function approveEntryAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.approve", entryOnly, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, REVIEW_ROLES);
    const no = await call("approve_and_post", { p_entry_id: i.entryId });
    refresh();
    return `Posted as JE ${no}.`;
  });
}

const withReason = entryOnly.extend({
  reason: z.string().trim().min(3, "Enter a reason").max(500),
});

export async function returnEntryAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.return", withReason, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, REVIEW_ROLES);
    await call("return_entry", { p_entry_id: i.entryId, p_comment: i.reason });
    refresh();
    return "Returned to the preparer.";
  });
}

export async function voidEntryAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.void", withReason, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId);
    await call("void_entry", { p_entry_id: i.entryId, p_reason: i.reason });
    refresh();
    return "Entry voided.";
  });
}

const reverseSchema = withReason.extend({
  reversalDate: z.iso.date("Choose a valid date"),
  idempotencyKey: z.string().min(8).max(200),
});

export async function reverseEntryAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ledger.reverse", reverseSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireStaffOn(access, i.clientId, REVIEW_ROLES);
    const reversalId = (await call("reverse_entry", {
      p_entry_id: i.entryId,
      p_reversal_date: i.reversalDate,
      p_reason: i.reason,
      p_idempotency_key: i.idempotencyKey,
    })) as string;
    redirect(pathFor("staff.entry", { clientId: i.clientId, entryId: reversalId }));
  });
}
