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
 * Electronic outputs and e-invoicing register actions. The database enforces
 * the specification gates, that a file is valid only after the official
 * validation of that exact file passed together with our own checks, and the
 * evidence rules of the e-invoicing register.
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

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}
function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION", "json", { publicMessage: `${what} is not valid JSON.` });
  }
}

const specSchema = z.object({
  op: z.enum([
    "propose",
    "add_fixture",
    "review_fixture",
    "submit",
    "approve",
    "enable",
    "reject",
    "propose_requirement",
    "verify_requirement",
  ]),
  id: uuidOrEmpty,
  json: text(200_000),
  note: text(4000),
  evidence: text(1000),
  attest: z.literal("on").optional(),
});
export async function outputSpecAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("eoutputs.spec", specSchema, fd, async (i) => {
    const access = await requireActionAccess();
    if (!hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]))
      throw new AppError("FORBIDDEN", "electronic outputs need firm accounting staff");
    switch (i.op) {
      case "propose": {
        const id = await rpc<string>("propose_output_spec", {
          p_spec: parseJson(i.json, "The specification"),
        });
        redirect(pathFor("eoutput", { itemId: id }));
      }
      case "add_fixture":
        await rpc("add_output_fixture", {
          p_spec_id: i.id,
          p_fixture: parseJson(i.json, "The fixture"),
        });
        break;
      case "review_fixture":
        await rpc("review_output_fixture", { p_fixture_id: i.id });
        break;
      case "submit":
        await rpc("submit_output_spec", { p_spec_id: i.id });
        break;
      case "approve":
        await rpc("approve_output_spec", {
          p_spec_id: i.id,
          p_spec_verified: !!i.attest,
          p_note: i.note,
        });
        break;
      case "enable":
        await rpc("enable_output_spec", {
          p_spec_id: i.id,
          p_statement: i.note,
          p_evidence: i.evidence,
        });
        break;
      case "reject":
        await rpc("reject_output_spec", { p_spec_id: i.id, p_note: i.note });
        break;
      case "propose_requirement":
        await rpc("propose_einvoice_requirement", {
          p_req: parseJson(i.json, "The requirement"),
        });
        break;
      case "verify_requirement":
        await rpc("verify_einvoice_requirement", { p_id: i.id, p_source_checked: !!i.attest });
        break;
    }
    refresh();
    return "Saved.";
  });
}

const runSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["generate", "record_validation", "sign_off", "assess"]),
  id: uuidOrEmpty,
  code: text(40),
  from: optDate,
  to: optDate,
  idempotencyKey: text(200),
  kind: z.enum(["official_tool", "esubmission_reply"]).optional().default("official_tool"),
  tool: text(200),
  toolVersion: text(50),
  result: z.enum(["", "passed", "failed", "accepted", "rejected"]).optional().default(""),
  sha256: text(64),
  log: text(20_000),
  reference: text(200),
  note: text(2000),
  requirementId: uuidOrEmpty,
  status: z
    .enum(["", "not_assessed", "not_applicable", "required_not_met", "in_progress", "met"])
    .optional()
    .default(""),
  evidence: text(2000),
});
export async function outputRunAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("eoutputs.run", runSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeStaff(access, i.clientId);
    switch (i.op) {
      case "generate": {
        const r = await rpc<{ run_id: string }>("generate_output", {
          p_client_id: i.clientId,
          p_code: i.code,
          p_period_from: i.from || null,
          p_period_to: i.to || null,
          p_idempotency_key: i.idempotencyKey,
        });
        redirect(pathFor("staff.output_run", { clientId: i.clientId, itemId: r.run_id }));
      }
      case "record_validation": {
        const status = await rpc<string>("record_output_validation", {
          p_run_id: i.id,
          p_kind: i.kind,
          p_tool: i.tool,
          p_tool_version: i.toolVersion,
          p_result: i.result,
          p_file_sha256: i.sha256,
          p_log: i.log,
          p_reference: i.reference,
        });
        refresh();
        return status === "validated"
          ? "Recorded: the file is validated."
          : "Recorded: the file is NOT valid.";
      }
      case "sign_off":
        await rpc("sign_off_output", { p_run_id: i.id, p_statement: i.note });
        break;
      case "assess":
        await rpc("assess_client_einvoice", {
          p_client_id: i.clientId,
          p_requirement_id: i.requirementId,
          p_status: i.status,
          p_evidence: i.evidence,
          p_note: i.note,
        });
        break;
    }
    refresh();
    return "Saved.";
  });
}
