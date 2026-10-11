"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { pathFor } from "@/lib/access/route-policy";
import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { hasFirmRole, requireActionAccess } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";
import { requireIntakeStaff } from "@/server/intake/access";

/*
 * Payroll actions: Zod validation and a server pre-check (assigned firm
 * staff); the database then enforces the payroll grant (view / prepare /
 * approve), maker-checker, signed-off statutory rules, and computes every
 * amount. Nothing here computes pay.
 */

type Result = ActionResult<string>;
const uuidOrEmpty = z
  .union([z.literal(""), z.uuid()])
  .optional()
  .default("");
const text = (max: number) => z.string().trim().max(max).optional().default("");
const optDate = z
  .union([z.literal(""), z.iso.date("Choose a valid date")])
  .optional()
  .default("");
const decimal = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .refine((v) => v === "" || /^\d{1,14}(\.\d{1,6})?$/.test(v), "Use digits (up to 6 decimals)");

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}
async function staffOn(clientId: string) {
  const access = await requireActionAccess();
  requireIntakeStaff(access, clientId);
}

// ---------------------------------------------------------------------------
// Access grants (managers)
// ---------------------------------------------------------------------------
const accessSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["grant", "revoke"]),
  userId: z.uuid("Choose the person"),
  level: z.enum(["view", "prepare", "approve"]).optional().default("view"),
});
export async function payrollAccessAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("payroll.access", accessSchema, fd, async (i) => {
    await staffOn(i.clientId);
    if (i.op === "grant")
      await rpc("grant_payroll_access", {
        p_client_id: i.clientId,
        p_user_id: i.userId,
        p_level: i.level,
      });
    else await rpc("revoke_payroll_access", { p_client_id: i.clientId, p_user_id: i.userId });
    refresh();
    return i.op === "grant" ? "Access granted." : "Access removed.";
  });
}

// ---------------------------------------------------------------------------
// Statutory rules (firm-wide)
// ---------------------------------------------------------------------------
const BRACKET_COLUMNS = {
  fixed_table: ["ee_amount", "er_amount", "ec_amount"],
  rate_table: ["ee_rate", "er_rate"],
  graduated: ["fixed_tax", "excess_rate"],
} as const;

const ruleSchema = z.object({
  op: z.enum(["propose", "sign_off", "end"]),
  id: uuidOrEmpty,
  kind: z.enum(["", "sss", "philhealth", "pagibig", "withholding"]).optional().default(""),
  method: z.enum(["", "fixed_table", "rate_table", "graduated"]).optional().default(""),
  description: text(300),
  legalBasis: text(500),
  effectiveFrom: optDate,
  effectiveTo: optDate,
  baseFloor: decimal.optional().default(""),
  baseCeiling: decimal.optional().default(""),
  frequency: z.enum(["", "monthly", "semi_monthly"]).optional().default(""),
  deductContributions: z.enum(["", "true", "false"]).optional().default(""),
  brackets: text(20000),
});

/** One bracket per line: lower | upper (blank on the last) | values for the method. */
function parseBrackets(method: keyof typeof BRACKET_COLUMNS, raw: string) {
  const cols = BRACKET_COLUMNS[method];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, n) => {
      const parts = l.split("|").map((p) => p.trim().replace(/,/g, ""));
      if (parts.length !== 2 + cols.length)
        throw new AppError("VALIDATION", `bracket line ${n + 1}`, {
          publicMessage: `Bracket line ${n + 1}: expected lower | upper | ${cols.join(" | ")}`,
        });
      const row: Record<string, string> = { lower_bound: parts[0], upper_bound: parts[1] };
      cols.forEach((c, k) => (row[c] = parts[2 + k]));
      return row;
    });
}

export async function payrollRuleAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("payroll.rule", ruleSchema, fd, async (i) => {
    const access = await requireActionAccess();
    if (!hasFirmRole(access, ["firm_manager", "reviewer"]))
      throw new AppError("FORBIDDEN", "payroll rules need a reviewer or manager");
    if (i.op === "propose") {
      if (!i.method)
        throw new AppError("VALIDATION", "method", { publicMessage: "Choose the method." });
      await rpc("propose_payroll_rule", {
        p_rule: {
          kind: i.kind,
          method: i.method,
          description: i.description,
          legal_basis: i.legalBasis,
          effective_from: i.effectiveFrom,
          effective_to: i.effectiveTo,
          base_floor: i.baseFloor,
          base_ceiling: i.baseCeiling,
          frequency: i.method === "graduated" ? i.frequency : "",
          deduct_employee_contributions: i.method === "graduated" ? i.deductContributions : "",
          brackets: parseBrackets(i.method, i.brackets),
        },
      });
    } else if (i.op === "sign_off") await rpc("sign_off_payroll_rule", { p_id: i.id });
    else await rpc("end_payroll_rule", { p_id: i.id, p_effective_to: i.effectiveTo || null });
    refresh();
    return {
      propose: "Rule entered; another reviewer must sign it off.",
      sign_off: "Signed off.",
      end: "Saved.",
    }[i.op];
  });
}

// ---------------------------------------------------------------------------
// Settings and pay items
// ---------------------------------------------------------------------------
const setupSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["default_settings", "settings", "propose_item", "approve_item", "retire_item"]),
  id: uuidOrEmpty,
  netPay: uuidOrEmpty,
  employerExpense: uuidOrEmpty,
  sss: uuidOrEmpty,
  philhealth: uuidOrEmpty,
  pagibig: uuidOrEmpty,
  withholding: uuidOrEmpty,
  code: text(20),
  name: text(100),
  kind: z.enum(["", "earning", "deduction"]).optional().default(""),
  accountId: uuidOrEmpty,
  unit: z.enum(["amount", "days", "hours"]).optional().default("amount"),
  multiplier: decimal.optional().default(""),
  isBasic: z.literal("on").optional(),
  isTaxable: z.literal("on").optional(),
  inSss: z.literal("on").optional(),
  inPhilhealth: z.literal("on").optional(),
  inPagibig: z.literal("on").optional(),
});
export async function payrollSetupAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("payroll.setup", setupSchema, fd, async (i) => {
    await staffOn(i.clientId);
    switch (i.op) {
      case "default_settings":
        await rpc("apply_default_payroll_settings", { p_client_id: i.clientId });
        break;
      case "settings":
        await rpc("set_payroll_settings", {
          p_client_id: i.clientId,
          p_net_pay: i.netPay,
          p_employer_expense: i.employerExpense,
          p_sss: i.sss,
          p_philhealth: i.philhealth,
          p_pagibig: i.pagibig,
          p_withholding: i.withholding,
        });
        break;
      case "propose_item":
        await rpc("propose_payroll_item", {
          p_client_id: i.clientId,
          p_item: {
            code: i.code,
            name: i.name,
            kind: i.kind,
            account_id: i.accountId,
            unit: i.kind === "earning" ? i.unit : "amount",
            multiplier: i.multiplier,
            is_basic: !!i.isBasic,
            is_taxable: !!i.isTaxable,
            in_sss_base: !!i.inSss,
            in_philhealth_base: !!i.inPhilhealth,
            in_pagibig_base: !!i.inPagibig,
          },
        });
        break;
      case "approve_item":
        await rpc("approve_payroll_item", { p_id: i.id });
        break;
      case "retire_item":
        await rpc("retire_payroll_item", { p_id: i.id });
        break;
    }
    refresh();
    return "Saved.";
  });
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
const employeeSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["save", "rate", "terminate"]),
  id: uuidOrEmpty,
  employeeNo: text(20),
  lastName: text(100),
  firstName: text(100),
  middleName: text(100),
  tin: text(20),
  sssNo: text(20),
  philhealthNo: text(20),
  pagibigNo: text(20),
  position: text(100),
  hireDate: optDate,
  withholdingExempt: z.literal("on").optional(),
  exemptReason: text(500),
  effectiveFrom: optDate,
  payBasis: z.enum(["monthly", "daily"]).optional().default("monthly"),
  basicRate: decimal.optional().default(""),
  dailyRate: decimal.optional().default(""),
  hourlyRate: decimal.optional().default(""),
  terminationDate: optDate,
  reason: text(500),
});
export async function employeeAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("payroll.employee", employeeSchema, fd, async (i) => {
    await staffOn(i.clientId);
    if (i.op === "save") {
      const id = await rpc<string>("save_employee", {
        p_client_id: i.clientId,
        p_id: i.id || null,
        p_data: {
          employee_no: i.employeeNo,
          last_name: i.lastName,
          first_name: i.firstName,
          middle_name: i.middleName,
          tin: i.tin,
          sss_no: i.sssNo,
          philhealth_no: i.philhealthNo,
          pagibig_no: i.pagibigNo,
          position: i.position,
          hire_date: i.hireDate,
          withholding_exempt: !!i.withholdingExempt,
          exempt_reason: i.exemptReason,
        },
      });
      if (!i.id) redirect(pathFor("staff.payroll_employee", { clientId: i.clientId, itemId: id }));
    } else if (i.op === "rate") {
      await rpc("add_employee_rate", {
        p_employee_id: i.id,
        p_effective_from: i.effectiveFrom || null,
        p_basis: i.payBasis,
        p_basic: i.basicRate,
        p_daily: i.dailyRate,
        p_hourly: i.hourlyRate,
      });
    } else {
      await rpc("terminate_employee", {
        p_employee_id: i.id,
        p_date: i.terminationDate || null,
        p_reason: i.reason,
      });
    }
    refresh();
    return "Saved.";
  });
}

// ---------------------------------------------------------------------------
// Runs and payslips
// ---------------------------------------------------------------------------
const runSchema = z.object({
  clientId: z.uuid(),
  op: z.enum([
    "create",
    "add_employee",
    "remove_payslip",
    "lines",
    "submit",
    "return",
    "post",
    "cancel",
  ]),
  id: uuidOrEmpty,
  idempotencyKey: text(200),
  frequency: z.enum(["monthly", "semi_monthly"]).optional().default("semi_monthly"),
  periodStart: optDate,
  periodEnd: optDate,
  payDate: optDate,
  memo: text(500),
  employeeId: uuidOrEmpty,
  payslipId: uuidOrEmpty,
  lines: z
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
    .pipe(
      z
        .array(
          z.object({
            item_id: z.uuid("Choose a pay item on every line"),
            quantity: z.string().trim().max(20).optional().default(""),
            amount: z.string().trim().max(20).optional().default(""),
            description: z.string().trim().max(200).optional().default(""),
          }),
        )
        .max(200),
    ),
  comment: text(1000),
  reversalDate: optDate,
});
export async function payrollRunAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("payroll.run", runSchema, fd, async (i) => {
    await staffOn(i.clientId);
    switch (i.op) {
      case "create": {
        if (i.idempotencyKey.length < 8)
          throw new AppError("VALIDATION", "key", {
            publicMessage: "Reload the page and try again.",
          });
        const id = await rpc<string>("create_payroll_run", {
          p_client_id: i.clientId,
          p_frequency: i.frequency,
          p_period_start: i.periodStart || null,
          p_period_end: i.periodEnd || null,
          p_pay_date: i.payDate || null,
          p_memo: i.memo,
          p_idempotency_key: i.idempotencyKey,
        });
        redirect(pathFor("staff.payroll_run", { clientId: i.clientId, itemId: id }));
      }
      case "add_employee":
        await rpc("add_employee_to_run", { p_run_id: i.id, p_employee_id: i.employeeId });
        break;
      case "remove_payslip":
        await rpc("remove_payslip", { p_payslip_id: i.payslipId });
        break;
      case "lines":
        await rpc("set_payslip_lines", {
          p_payslip_id: i.payslipId,
          p_lines: i.lines.map((l) => ({
            ...l,
            quantity: l.quantity.replace(/,/g, ""),
            amount: l.amount.replace(/,/g, ""),
          })),
        });
        break;
      case "submit":
        await rpc("submit_payroll_run", { p_run_id: i.id });
        break;
      case "return":
        await rpc("return_payroll_run", { p_run_id: i.id, p_comment: i.comment });
        break;
      case "post":
        await rpc("post_payroll_run", { p_run_id: i.id });
        break;
      case "cancel":
        await rpc("cancel_payroll_run", {
          p_run_id: i.id,
          p_reason: i.comment,
          p_reversal_date: i.reversalDate || null,
        });
        break;
    }
    refresh();
    return {
      create: "Created.",
      add_employee: "Employee added.",
      remove_payslip: "Removed.",
      lines: "Payslip updated.",
      submit: "Submitted for approval.",
      return: "Returned to the preparer.",
      post: "Posted to the books.",
      cancel: "Cancelled.",
    }[i.op];
  });
}

// ---------------------------------------------------------------------------
// Payments and remittances
// ---------------------------------------------------------------------------
const paymentSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["record", "post", "cancel"]),
  id: uuidOrEmpty,
  runId: uuidOrEmpty,
  kind: z
    .enum(["net_pay", "sss", "philhealth", "pagibig", "withholding", "deduction"])
    .optional()
    .default("net_pay"),
  itemId: uuidOrEmpty,
  paymentDate: optDate,
  paidFrom: uuidOrEmpty,
  amount: z
    .string()
    .trim()
    .transform((v) => v.replace(/,/g, ""))
    .optional()
    .default(""),
  reference: text(100),
  idempotencyKey: text(200),
  comment: text(500),
});
export async function payrollPaymentAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("payroll.payment", paymentSchema, fd, async (i) => {
    await staffOn(i.clientId);
    if (i.op === "record")
      await rpc("record_payroll_payment", {
        p_run_id: i.runId,
        p_kind: i.kind,
        p_item_id: i.kind === "deduction" ? i.itemId || null : null,
        p_payment_date: i.paymentDate || null,
        p_paid_from: i.paidFrom || null,
        p_amount: i.amount,
        p_reference: i.reference,
        p_idempotency_key: i.idempotencyKey,
      });
    else if (i.op === "post") await rpc("post_payroll_payment", { p_payment_id: i.id });
    else await rpc("cancel_payroll_payment", { p_payment_id: i.id, p_reason: i.comment });
    refresh();
    return {
      record: "Recorded; another approver must post it.",
      post: "Posted.",
      cancel: "Cancelled.",
    }[i.op];
  });
}
