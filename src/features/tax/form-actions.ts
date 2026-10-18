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
 * Forms registry and workpaper actions. The database enforces both gates
 * (verified computations; documented accountant sign-off), eligibility,
 * obligations, traceability and validations.
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

const formSchema = z.object({
  op: z.enum([
    "propose",
    "add_fixture",
    "review_fixture",
    "submit",
    "approve",
    "enable",
    "reject",
    "end",
  ]),
  id: uuidOrEmpty,
  json: text(200_000),
  note: text(4000),
  evidence: text(1000),
  attest: z.literal("on").optional(),
  effectiveTo: optDate,
});
export async function taxFormAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("tax.form", formSchema, fd, async (i) => {
    const access = await requireActionAccess();
    if (!hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]))
      throw new AppError("FORBIDDEN", "forms registry needs firm accounting staff");
    switch (i.op) {
      case "propose": {
        const id = await rpc<string>("propose_tax_form", { p_form: parseJson(i.json, "The form") });
        redirect(pathFor("tax_form", { itemId: id }));
      }
      case "add_fixture":
        await rpc("add_form_fixture", {
          p_form_id: i.id,
          p_fixture: parseJson(i.json, "The fixture"),
        });
        break;
      case "review_fixture":
        await rpc("review_form_fixture", { p_fixture_id: i.id });
        break;
      case "submit":
        await rpc("submit_tax_form", { p_form_id: i.id });
        break;
      case "approve":
        await rpc("approve_tax_form", {
          p_form_id: i.id,
          p_sources_verified: !!i.attest,
          p_note: i.note,
        });
        break;
      case "enable":
        await rpc("enable_tax_form", {
          p_form_id: i.id,
          p_statement: i.note,
          p_evidence: i.evidence,
        });
        break;
      case "reject":
        await rpc("reject_tax_form", { p_form_id: i.id, p_note: i.note });
        break;
      case "end":
        await rpc("end_tax_form", { p_form_id: i.id, p_effective_to: i.effectiveTo || null });
        break;
    }
    refresh();
    return "Saved.";
  });
}

const workpaperSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["prepare", "sign_off"]),
  id: uuidOrEmpty,
  code: text(40),
  from: optDate,
  to: optDate,
  manual: text(20_000),
  overrides: text(20_000),
  idempotencyKey: text(200),
  note: text(2000),
});

/** One per line: line | value | reason | reference (optional). */
function parseLineEntries(raw: string, what: string) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, n) => {
      const [line, value, reason, reference] = l.split("|").map((p) => p.trim());
      if (!line || !value || !reason)
        throw new AppError("VALIDATION", what, {
          publicMessage: `${what} line ${n + 1}: use line | value | reason | reference`,
        });
      return { line, value: value.replace(/,/g, ""), reason, reference: reference ?? "" };
    });
}

export async function workpaperAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("tax.workpaper", workpaperSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeStaff(access, i.clientId);
    if (i.op === "prepare") {
      const r = await rpc<{ workpaper_id: string }>("prepare_workpaper", {
        p_client_id: i.clientId,
        p_form_code: i.code,
        p_period_from: i.from || null,
        p_period_to: i.to || null,
        p_manual: parseLineEntries(i.manual, "Manual value"),
        p_overrides: parseLineEntries(i.overrides, "Override"),
        p_idempotency_key: i.idempotencyKey,
      });
      redirect(pathFor("staff.workpaper", { clientId: i.clientId, itemId: r.workpaper_id }));
    }
    await rpc("sign_off_workpaper", { p_id: i.id, p_statement: i.note });
    refresh();
    return "Signed off.";
  });
}
