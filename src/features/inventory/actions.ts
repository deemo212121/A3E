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
 * Inventory actions: Zod validation, a server pre-check (assigned firm staff),
 * then database functions that re-check roles, stock levels, links to bills
 * and invoices, periods and maker-checker, and compute every value.
 */

type Result = ActionResult<string>;
const uuidOrEmpty = z
  .union([z.literal(""), z.uuid()])
  .optional()
  .default("");
const text = (max: number) => z.string().trim().max(max).optional().default("");
const qty = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .pipe(z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/, "Quantity: up to 4 decimals"));
const cost = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .refine((v) => v === "" || /^\d{1,14}(\.\d{1,4})?$/.test(v), "Unit cost: up to 4 decimals");
const lineNo = z.union([z.literal(""), z.coerce.number().int().min(1).max(500)]).optional();

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
const movementLine = z.object({
  item_id: z.uuid("Choose an item on every line"),
  location_id: z.uuid("Choose a location on every line"),
  to_location_id: uuidOrEmpty,
  quantity: qty,
  unit_cost: cost.optional().default(""),
  bill_line_no: lineNo,
  invoice_line_no: lineNo,
});
const movementSchema = z.object({
  clientId: z.uuid(),
  idempotencyKey: z.string().min(8).max(200),
  intent: z.enum(["save", "submit"]).default("save"),
  movementType: z.enum([
    "receipt",
    "issue",
    "customer_return",
    "supplier_return",
    "transfer",
    "adjustment",
  ]),
  movementDate: z.iso.date("Choose a valid date"),
  purchaseBillId: uuidOrEmpty,
  salesInvoiceId: uuidOrEmpty,
  offsetAccountId: uuidOrEmpty,
  reason: text(500),
  memo: text(500),
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
    .pipe(z.array(movementLine).max(500))
    .refine((a) => a.length > 0, "Add at least one line"),
});

export async function saveMovementAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("inventory.saveMovement", movementSchema, fd, async (i) => {
    await staffOn(i.clientId);
    const id = await rpc<string>("save_inventory_movement", {
      p_client_id: i.clientId,
      p_movement_id: null,
      p_expected_version: null,
      p_header: {
        movement_type: i.movementType,
        movement_date: i.movementDate,
        purchase_bill_id: i.purchaseBillId,
        sales_invoice_id: i.salesInvoiceId,
        offset_account_id: i.offsetAccountId,
        reason: i.reason,
        memo: i.memo,
      },
      p_lines: i.lines,
      p_idempotency_key: i.idempotencyKey,
    });
    if (i.intent === "submit")
      await rpc("submit_sales_document", { p_subject: "inventory_movement", p_id: id });
    redirect(pathFor("staff.inventory_movement", { clientId: i.clientId, itemId: id }));
  });
}

// ---------------------------------------------------------------------------
const configSchema = z.object({
  clientId: z.uuid(),
  op: z.enum(["default_settings", "settings", "policy", "location", "item"]),
  id: uuidOrEmpty,
  cogs: uuidOrEmpty,
  adjustment: uuidOrEmpty,
  supplierReturn: uuidOrEmpty,
  allow: z.enum(["true", "false"]).optional().default("false"),
  reason: text(500),
  code: text(40),
  name: text(200),
  unit: text(20),
  accountId: uuidOrEmpty,
  active: z.enum(["true", "false"]).optional().default("true"),
});

export async function inventoryConfigAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("inventory.config", configSchema, fd, async (i) => {
    await staffOn(i.clientId);
    switch (i.op) {
      case "default_settings":
        await rpc("apply_default_inventory_settings", { p_client_id: i.clientId });
        break;
      case "settings":
        await rpc("set_inventory_settings", {
          p_client_id: i.clientId,
          p_cogs: i.cogs,
          p_adjustment: i.adjustment,
          p_supplier_return: i.supplierReturn,
        });
        break;
      case "policy":
        await rpc("set_negative_stock_policy", {
          p_client_id: i.clientId,
          p_allow: i.allow === "true",
          p_reason: i.reason || null,
        });
        break;
      case "location":
        await rpc("save_inventory_location", {
          p_client_id: i.clientId,
          p_id: i.id || null,
          p_code: i.code,
          p_name: i.name,
          p_active: i.active === "true",
        });
        break;
      case "item":
        await rpc("save_inventory_item", {
          p_client_id: i.clientId,
          p_id: i.id || null,
          p_sku: i.code,
          p_name: i.name,
          p_unit: i.unit,
          p_inventory_account_id: i.accountId,
          p_active: i.active === "true",
        });
        break;
    }
    refresh();
    return "Saved.";
  });
}
