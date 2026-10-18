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
 * Tax actions. The database decides everything that matters: who may enter,
 * review and approve rules; that only approved rules compute; eligibility;
 * and every amount. These actions only validate shape and forward.
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

// ---------------------------------------------------------------------------
// Registry (firm-wide)
// ---------------------------------------------------------------------------
const ruleSchema = z.object({
  op: z.enum(["propose", "add_fixture", "review_fixture", "submit", "approve", "reject", "end"]),
  id: uuidOrEmpty,
  json: text(100_000),
  note: text(2000),
  attest: z.literal("on").optional(),
  effectiveTo: optDate,
});
export async function taxRuleAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("tax.rule", ruleSchema, fd, async (i) => {
    const access = await requireActionAccess();
    if (!hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]))
      throw new AppError("FORBIDDEN", "tax registry needs firm accounting staff");
    switch (i.op) {
      case "propose": {
        const id = await rpc<string>("propose_tax_rule", { p_rule: parseJson(i.json, "The rule") });
        redirect(pathFor("tax_rule", { itemId: id }));
      }
      case "add_fixture":
        await rpc("add_tax_fixture", {
          p_rule_id: i.id,
          p_fixture: parseJson(i.json, "The fixture"),
        });
        break;
      case "review_fixture":
        await rpc("review_tax_fixture", { p_fixture_id: i.id, p_note: i.note });
        break;
      case "submit":
        await rpc("submit_tax_rule", { p_rule_id: i.id });
        break;
      case "approve":
        await rpc("approve_tax_rule", {
          p_rule_id: i.id,
          p_sources_verified: !!i.attest,
          p_note: i.note,
        });
        break;
      case "reject":
        await rpc("reject_tax_rule", { p_rule_id: i.id, p_note: i.note });
        break;
      case "end":
        await rpc("end_tax_rule", { p_rule_id: i.id, p_effective_to: i.effectiveTo || null });
        break;
    }
    refresh();
    return "Saved.";
  });
}

// ---------------------------------------------------------------------------
// Client tax setup and computations
// ---------------------------------------------------------------------------
const clientSchema = z.object({
  clientId: z.uuid(),
  op: z.enum([
    "profile",
    "confirm_profile",
    "add_obligation",
    "end_obligation",
    "mapping",
    "compute",
    "review",
  ]),
  id: uuidOrEmpty,
  json: text(20_000),
  code: text(40),
  input: text(40),
  sign: z
    .enum(["credit_minus_debit", "debit_minus_credit"])
    .optional()
    .default("credit_minus_debit"),
  startsOn: optDate,
  endsOn: optDate,
  notes: text(500),
  from: optDate,
  to: optDate,
  adjustments: text(20_000),
  idempotencyKey: text(200),
  note: text(1000),
});

/** Adjustment lines: input | amount | reason | reference (optional). */
function parseAdjustments(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, n) => {
      const [input, amount, reason, reference] = l.split("|").map((p) => p.trim());
      if (!input || !amount || !reason)
        throw new AppError("VALIDATION", "adjustment", {
          publicMessage: `Adjustment line ${n + 1}: use input | amount | reason | reference`,
        });
      return { input, amount: amount.replace(/,/g, ""), reason, reference: reference ?? "" };
    });
}

export async function taxClientAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("tax.client", clientSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeStaff(access, i.clientId);
    // multi-select: read every chosen account (the DB checks they belong to the client)
    const ids = fd
      .getAll("accountIds")
      .map(String)
      .filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    switch (i.op) {
      case "profile":
        await rpc("set_tax_profile", {
          p_client_id: i.clientId,
          p_attributes: parseJson(i.json || "{}", "The profile facts"),
        });
        break;
      case "confirm_profile":
        await rpc("confirm_tax_profile", { p_client_id: i.clientId });
        break;
      case "add_obligation":
        await rpc("add_tax_obligation", {
          p_client_id: i.clientId,
          p_code: i.code,
          p_starts_on: i.startsOn || null,
          p_ends_on: i.endsOn || null,
          p_notes: i.notes,
        });
        break;
      case "end_obligation":
        await rpc("end_tax_obligation", { p_id: i.id, p_ends_on: i.endsOn || null });
        break;
      case "mapping":
        if (ids.length === 0)
          throw new AppError("VALIDATION", "accounts", {
            publicMessage: "Choose at least one account.",
          });
        await rpc("set_tax_input_mapping", {
          p_client_id: i.clientId,
          p_code: i.code,
          p_input: i.input,
          p_account_ids: ids,
          p_sign: i.sign,
        });
        break;
      case "compute": {
        const r = await rpc<{ computation_id: string }>("compute_tax", {
          p_client_id: i.clientId,
          p_code: i.code,
          p_period_from: i.from || null,
          p_period_to: i.to || null,
          p_adjustments: parseAdjustments(i.adjustments),
          p_idempotency_key: i.idempotencyKey,
        });
        redirect(
          pathFor("staff.tax_computation", { clientId: i.clientId, itemId: r.computation_id }),
        );
      }
      case "review":
        await rpc("review_tax_computation", { p_id: i.id, p_note: i.note });
        break;
    }
    refresh();
    return "Saved.";
  });
}
