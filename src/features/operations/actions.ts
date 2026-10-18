"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { pathFor, REVIEW_ROLES, STAFF_ROLES } from "@/lib/access/route-policy";
import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { clientRoleOf, hasFirmRole, requireActionAccess } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";
import { requireIntakeStaff } from "@/server/intake/access";

/*
 * Firm operations actions (Phase 15). Pre-checks here only give early, clear
 * errors; the database functions enforce every rule (roles, assignment,
 * maker-checker, the filing steps, version checks) and record who and when.
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
const optInt = z
  .union([z.literal(""), z.coerce.number().int()])
  .optional()
  .default("");
const nul = (v: string) => (v === "" ? null : v);
const nulInt = (v: number | "") => (v === "" ? null : v);

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}
const intList = (raw: string) =>
  raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n)) {
        throw new AppError("VALIDATION", "list", {
          publicMessage: "Use whole numbers, e.g. 7, 3, 1.",
        });
      }
      return n;
    });

// ---------------------------------------------------------------------------
// Client-scoped staff actions
// ---------------------------------------------------------------------------
const clientSchema = z.object({
  clientId: z.uuid(),
  op: z.enum([
    "generate_calendar",
    "add_filing",
    "set_client_deadline",
    "end_client_deadline",
    "filing",
    "assign_filing",
    "amend_filing",
    "create_work",
    "work_transition",
    "assign_work",
    "create_request",
    "decide_request",
    "service_status",
    "request_exception",
  ]),
  id: uuidOrEmpty,
  version: optInt,
  // filing / calendar
  from: optDate,
  to: optDate,
  dueOn: optDate,
  formCode: text(40),
  title: text(200),
  details: text(2000),
  reason: text(2000),
  note: text(2000),
  step: z
    .enum([
      "",
      "start",
      "prepared",
      "submit",
      "return",
      "approve",
      "export",
      "confirm_filed",
      "not_required",
    ])
    .optional()
    .default(""),
  workpaperId: uuidOrEmpty,
  method: z
    .enum(["", "validated_file", "official_form_tool", "manual_form"])
    .optional()
    .default(""),
  outputRunId: uuidOrEmpty,
  reference: text(300),
  filedOn: optDate,
  channel: text(100),
  evidence: text(1000),
  // deadlines
  ruleId: uuidOrEmpty,
  startsOn: optDate,
  endsOn: optDate,
  anchorMonth: optInt,
  preparerId: uuidOrEmpty,
  reviewerId: uuidOrEmpty,
  // work
  kind: text(40),
  priority: z.enum(["", "low", "normal", "high", "urgent"]).optional().default(""),
  assigneeId: uuidOrEmpty,
  requiresReview: z.literal("on").optional(),
  linkType: text(40),
  linkId: uuidOrEmpty,
  to_status: text(40),
  idempotencyKey: text(200),
  // requests
  category: text(40),
  periodFrom: optDate,
  periodTo: optDate,
  decision: z.enum(["", "accept", "return", "cancel"]).optional().default(""),
  // service status / exceptions
  status: text(40),
  periodId: uuidOrEmpty,
  targetStatus: z.enum(["", "open", "soft_closed"]).optional().default(""),
  filingId: uuidOrEmpty,
  newDueOn: optDate,
});

export async function opsClientAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ops.client", clientSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeStaff(access, i.clientId);
    const c = i.clientId;
    switch (i.op) {
      case "generate_calendar": {
        const n = await rpc<number>("generate_filing_calendar", {
          p_client_id: c,
          p_from: nul(i.from),
          p_to: nul(i.to),
        });
        refresh();
        return n === 0 ? "Calendar is up to date." : `Added ${n} filing${n === 1 ? "" : "s"}.`;
      }
      case "add_filing": {
        const id = await rpc<string>("add_filing", {
          p_client_id: c,
          p_form_code: i.formCode,
          p_title: i.title,
          p_period_from: nul(i.from),
          p_period_to: nul(i.to),
          p_due_on: nul(i.dueOn),
          p_reason: i.reason,
        });
        redirect(pathFor("staff.filing", { clientId: c, itemId: id }));
      }
      case "set_client_deadline":
        await rpc("set_client_deadline", {
          p_client_id: c,
          p_rule_id: nul(i.ruleId),
          p_starts_on: nul(i.startsOn),
          p_anchor_month: nulInt(i.anchorMonth) ?? 12,
          p_preparer_id: nul(i.preparerId),
          p_reviewer_id: nul(i.reviewerId),
        });
        break;
      case "end_client_deadline":
        await rpc("end_client_deadline", { p_id: i.id, p_ends_on: nul(i.endsOn) });
        break;
      case "filing": {
        const data: Record<string, string> = {};
        if (i.note) data.note = i.note;
        if (i.workpaperId) data.workpaper_id = i.workpaperId;
        if (i.method) data.method = i.method;
        if (i.outputRunId) data.output_run_id = i.outputRunId;
        if (i.reference) data.reference = i.reference;
        if (i.filedOn) data.filed_on = i.filedOn;
        if (i.channel) data.channel = i.channel;
        if (i.evidence) data.evidence = i.evidence;
        const status = await rpc<string>("advance_filing", {
          p_id: i.id,
          p_action: i.step,
          p_data: data,
          p_version: nulInt(i.version),
        });
        refresh();
        return `Saved. Status: ${status.replace(/_/g, " ")}.`;
      }
      case "assign_filing":
        await rpc("assign_filing", {
          p_id: i.id,
          p_preparer_id: nul(i.preparerId),
          p_reviewer_id: nul(i.reviewerId),
          p_reason: nul(i.reason),
          p_version: nulInt(i.version),
        });
        break;
      case "amend_filing": {
        const id = await rpc<string>("amend_filing", { p_id: i.id, p_reason: i.reason });
        redirect(pathFor("staff.filing", { clientId: c, itemId: id }));
      }
      case "create_work": {
        const id = await rpc<string>("create_work_item", {
          p_client_id: c,
          p_item: {
            kind: i.kind || "task",
            title: i.title,
            details: i.details,
            priority: i.priority || "normal",
            assignee_id: i.assigneeId,
            reviewer_id: i.reviewerId,
            requires_review: !!i.requiresReview,
            due_on: i.dueOn,
            link_type: i.linkType,
            link_id: i.linkId,
          },
          p_idempotency_key: i.idempotencyKey,
        });
        redirect(pathFor("staff.work_item", { clientId: c, itemId: id }));
      }
      case "work_transition": {
        const status = await rpc<string>("transition_work_item", {
          p_id: i.id,
          p_to: i.to_status,
          p_note: nul(i.note),
          p_version: nulInt(i.version),
        });
        refresh();
        return `Saved. Status: ${status.replace(/_/g, " ")}.`;
      }
      case "assign_work":
        await rpc("assign_work_item", {
          p_id: i.id,
          p_assignee_id: nul(i.assigneeId),
          p_reviewer_id: nul(i.reviewerId),
          p_reason: nul(i.reason),
          p_version: nulInt(i.version),
        });
        break;
      case "create_request":
        await rpc("create_document_request", {
          p_client_id: c,
          p_req: {
            title: i.title,
            details: i.details,
            category: i.category,
            period_from: i.periodFrom,
            period_to: i.periodTo,
            due_on: i.dueOn,
          },
          p_idempotency_key: i.idempotencyKey,
        });
        break;
      case "decide_request":
        await rpc("decide_document_request", {
          p_id: i.id,
          p_decision: i.decision,
          p_note: nul(i.note),
          p_version: nulInt(i.version),
        });
        break;
      case "service_status":
        await rpc("set_client_service_status", {
          p_client_id: c,
          p_status: i.status,
          p_reason: i.reason,
        });
        break;
      case "request_exception":
        await rpc("request_exception", {
          p_client_id: c,
          p_kind: i.kind,
          p_data: {
            period_id: i.periodId,
            target_status: i.targetStatus,
            filing_id: i.filingId,
            new_due_on: i.newDueOn,
          },
          p_reason: i.reason,
        });
        refresh();
        return "Requested. A firm manager other than you decides it.";
    }
    refresh();
    return "Saved.";
  });
}

// ---------------------------------------------------------------------------
// Firm-wide actions (deadline rules, exceptions, reminders, notifications)
// ---------------------------------------------------------------------------
const firmSchema = z.object({
  op: z.enum([
    "propose_rule",
    "verify_rule",
    "retire_rule",
    "decide_exception",
    "cancel_exception",
    "run_reminders",
    "mark_read",
    "mark_all_read",
  ]),
  id: uuidOrEmpty,
  note: text(1000),
  attest: z.literal("on").optional(),
  decision: z.enum(["", "approve", "reject"]).optional().default(""),
  code: text(40),
  title: text(200),
  kind: z.enum(["", "tax_return", "document_submission", "internal"]).optional().default(""),
  formCode: text(40),
  frequency: z.enum(["", "monthly", "quarterly", "annual"]).optional().default(""),
  dueMonthsAfter: optInt,
  dueDay: optInt,
  weekendRule: z.enum(["", "none", "next_weekday"]).optional().default(""),
  skipPeriods: text(100),
  reminderDays: text(100),
  citation: text(500),
  issuedOn: optDate,
  url: text(500),
});

export async function opsFirmAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("ops.firm", firmSchema, fd, async (i) => {
    const access = await requireActionAccess();
    if (i.op === "mark_read" || i.op === "mark_all_read") {
      const n = await rpc<number>("mark_notifications_read", {
        p_ids: i.op === "mark_read" ? [i.id] : null,
      });
      refresh();
      return n === 0 ? "Nothing to clear." : "Marked as read.";
    }
    if (!hasFirmRole(access, STAFF_ROLES)) {
      throw new AppError("FORBIDDEN", "firm operations need firm staff");
    }
    switch (i.op) {
      case "propose_rule":
        await rpc("propose_deadline_rule", {
          p_rule: {
            code: i.code,
            title: i.title,
            kind: i.kind,
            form_code: i.formCode,
            frequency: i.frequency,
            due_months_after: nulInt(i.dueMonthsAfter),
            due_day: nulInt(i.dueDay),
            weekend_rule: i.weekendRule || "none",
            skip_periods: intList(i.skipPeriods),
            reminder_days: i.reminderDays ? intList(i.reminderDays) : [7, 3, 1],
            source: i.citation
              ? { citation: i.citation, issued_on: i.issuedOn, ...(i.url ? { url: i.url } : {}) }
              : {},
            notes: i.note,
          },
        });
        break;
      case "verify_rule":
        await rpc("verify_deadline_rule", {
          p_id: i.id,
          p_source_checked: !!i.attest,
          p_note: i.note,
        });
        break;
      case "retire_rule":
        await rpc("retire_deadline_rule", { p_id: i.id, p_note: i.note });
        break;
      case "decide_exception": {
        if (!hasFirmRole(access, REVIEW_ROLES)) throw new AppError("FORBIDDEN", "not a reviewer");
        const s = await rpc<string>("decide_exception", {
          p_id: i.id,
          p_approve: i.decision === "approve",
          p_note: i.note,
        });
        refresh();
        return s === "approved" ? "Approved and carried out." : "Rejected.";
      }
      case "cancel_exception":
        await rpc("cancel_exception", { p_id: i.id });
        break;
      case "run_reminders": {
        const r = await rpc<{ filings: number; requests: number; work: number }>(
          "run_reminders",
          {},
        );
        refresh();
        return `Reminders sent: ${r.filings} filing, ${r.requests} client request, ${r.work} work item. Re-running today sends nothing twice.`;
      }
    }
    refresh();
    return "Saved.";
  });
}

// ---------------------------------------------------------------------------
// Client portal: respond to a document request
// ---------------------------------------------------------------------------
const respondSchema = z.object({
  clientId: z.uuid(),
  id: z.uuid(),
  version: optInt,
  note: text(1000),
});

export async function respondRequestAction(_p: Result | null, fd: FormData): Promise<Result> {
  // Each attached document is a checkbox named doc_<uuid>.
  const docIds = [...fd.keys()]
    .filter((k) => k.startsWith("doc_"))
    .map((k) => k.slice(4))
    .filter((v) => z.uuid().safeParse(v).success);
  return runAction("ops.respond", respondSchema, fd, async (i) => {
    const access = await requireActionAccess();
    const role = clientRoleOf(access, i.clientId);
    if (role !== "client_owner" && role !== "client_staff") {
      throw new AppError("FORBIDDEN", "not a client writer", {
        publicMessage: "Only the business owner or its staff can respond.",
      });
    }
    await rpc("respond_document_request", {
      p_id: i.id,
      p_document_ids: docIds,
      p_note: nul(i.note),
      p_version: nulInt(i.version),
    });
    refresh();
    return "Sent to your accountant.";
  });
}
