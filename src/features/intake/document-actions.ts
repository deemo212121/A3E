"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { pathFor } from "@/lib/access/route-policy";
import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { MAX_IMPORT_BYTES } from "@/lib/intake/files";
import { applyMapping, fieldsFor, type ColumnMapping } from "@/lib/intake/mapping";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { requireActionAccess } from "@/server/auth/access";
import { getImport, getImportRows } from "@/server/data/intake";
import { fromDbError } from "@/server/db/errors";
import { isStaffOn, requireIntakeStaff, requireIntakeWriter } from "@/server/intake/access";
import { DOCUMENTS_BUCKET, storeDocument } from "@/server/intake/documents";
import { parseImportFile, toSheetRows } from "@/server/intake/imports";

type Result<T = string> = ActionResult<T>;
const key = z.string().min(8).max(200);
const fileField = z
  .instanceof(File, { message: "Choose a file" })
  .refine((f) => f.size > 0, "Choose a file");

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
const uploadSchema = z.object({
  clientId: z.uuid(),
  idempotencyKey: key,
  category: z.enum([
    "sales_invoice",
    "official_receipt",
    "purchase_invoice",
    "expense_receipt",
    "bank_statement",
    "certificate_2307",
    "payroll",
    "registration",
    "other",
  ]),
  periodMonth: z
    .union([z.literal(""), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month")])
    .optional()
    .default(""),
  description: z.string().trim().max(500).optional().default(""),
  file: fileField,
});

/** Uploads ONE file (the browser sends several files one request at a time). */
export async function uploadDocumentAction(
  _p: Result<{ documentId: string; name: string }> | null,
  fd: FormData,
): Promise<Result<{ documentId: string; name: string }>> {
  return runAction("intake.uploadDocument", uploadSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    const stored = await storeDocument({
      clientId: i.clientId,
      file: i.file,
      category: i.category,
      periodMonth: i.periodMonth ? `${i.periodMonth}-01` : null,
      description: i.description || null,
      idempotencyKey: i.idempotencyKey,
    });
    refresh();
    return { documentId: stored.documentId, name: i.file.name };
  });
}

const reviewSchema = z.object({
  clientId: z.uuid(),
  documentId: z.uuid(),
  status: z.enum(["pending", "accepted", "needs_correction", "rejected"]),
  comment: z.string().trim().max(1000).optional().default(""),
});

export async function reviewDocumentAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.reviewDocument", reviewSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeStaff(access, i.clientId);
    await rpc("set_document_review", {
      p_document_id: i.documentId,
      p_status: i.status,
      p_comment: i.comment || null,
    });
    refresh();
    return "Document review updated.";
  });
}

const deleteSchema = z.object({
  clientId: z.uuid(),
  documentId: z.uuid(),
  reason: z.string().trim().min(3, "Give a reason").max(500),
});

export async function deleteDocumentAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.deleteDocument", deleteSchema, fd, async (i) => {
    await requireActionAccess();
    await rpc("delete_document", { p_document_id: i.documentId, p_reason: i.reason });
    refresh();
    return "Document removed (kept in the audit trail).";
  });
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const importPath = (
  access: Awaited<ReturnType<typeof requireActionAccess>>,
  clientId: string,
  id: string,
) =>
  isStaffOn(access, clientId)
    ? pathFor("staff.import", { clientId, itemId: id })
    : pathFor("portal.import", { clientId, itemId: id });

const startSchema = z.object({
  clientId: z.uuid(),
  idempotencyKey: key,
  target: z.enum(["transactions", "counterparties"]),
  sheetName: z.string().trim().max(100).optional().default(""),
  headerRow: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,5}$/.test(v), "Row number")
    .optional()
    .default(""),
  file: fileField,
});

/** Stores the import file privately, reads it, and stages its rows. */
export async function startImportAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.startImport", startSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    const ext = i.file.name.split(".").pop()?.toLowerCase();
    if (ext !== "csv" && ext !== "xlsx") {
      throw new AppError("VALIDATION", "bad import type", {
        publicMessage: "Import files must be .csv or .xlsx.",
        fieldErrors: { file: ["Import files must be .csv or .xlsx."] },
      });
    }
    const stored = await storeDocument({
      clientId: i.clientId,
      file: i.file,
      category: "import_source",
      periodMonth: null,
      description: `Import (${i.target})`,
      idempotencyKey: i.idempotencyKey,
      maxBytes: MAX_IMPORT_BYTES,
    });
    const parsed = parseImportFile(stored.bytes, stored.extension, {
      sheetName: i.sheetName || null,
      headerRow: i.headerRow ? Number(i.headerRow) : null,
    });
    const batchId = await rpc<string>("create_import_batch", {
      p_client_id: i.clientId,
      p_idempotency_key: `${i.idempotencyKey}:batch`,
      p_document_id: stored.documentId,
      p_target: i.target,
      p_file_type: parsed.fileType,
      p_sheet_name: parsed.sheetName,
      p_headers: parsed.headers,
      p_rows: parsed.rows,
      p_row_numbers: parsed.rowNumbers,
    });
    redirect(importPath(access, i.clientId, batchId));
  });
}

const rereadSchema = z.object({
  clientId: z.uuid(),
  batchId: z.uuid(),
  sheetName: z.string().trim().max(100).optional().default(""),
  headerRow: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,5}$/.test(v), "Row number")
    .optional()
    .default(""),
});

/** Re-reads the same stored file with another sheet or header row (new batch). */
export async function rereadImportAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.rereadImport", rereadSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    const batch = await getImport(i.clientId, i.batchId);
    if (!batch) throw new AppError("NOT_FOUND", "batch not found");
    if (batch.status === "committed") {
      throw new AppError("VALIDATION", "committed", {
        publicMessage: "This import was already committed.",
      });
    }
    const supabase = await createSupabaseServerClient();
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("storage_path, extension")
      .eq("id", batch.document_id)
      .single();
    if (docError) throw fromDbError(docError, "select import document");
    const { data: blob, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .download(doc.storage_path);
    if (error || !blob) throw new AppError("UNAVAILABLE", `download failed: ${error?.message}`);
    const parsed = parseImportFile(new Uint8Array(await blob.arrayBuffer()), doc.extension, {
      sheetName: i.sheetName || null,
      headerRow: i.headerRow ? Number(i.headerRow) : null,
    });
    const batchId = await rpc<string>("create_import_batch", {
      p_client_id: i.clientId,
      p_idempotency_key: `reread:${i.batchId}:${parsed.sheetName ?? ""}:${parsed.headerRow}`,
      p_document_id: batch.document_id,
      p_target: batch.target,
      p_file_type: parsed.fileType,
      p_sheet_name: parsed.sheetName,
      p_headers: parsed.headers,
      p_rows: parsed.rows,
      p_row_numbers: parsed.rowNumbers,
    });
    if (batchId !== i.batchId) await rpc("cancel_import_batch", { p_batch_id: i.batchId });
    redirect(importPath(access, i.clientId, batchId));
  });
}

const mappingSchema = z
  .object({
    clientId: z.uuid(),
    batchId: z.uuid(),
    dateFormat: z.enum(["YMD", "MDY", "DMY"]).default("MDY"),
    defaultKind: z.string().trim().max(20).optional().default(""),
  })
  .catchall(z.string());

/** Applies the user's column mapping to every row; the database detects duplicates. */
export async function saveMappingAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.saveMapping", mappingSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    const batch = await getImport(i.clientId, i.batchId);
    if (!batch) throw new AppError("NOT_FOUND", "batch not found");
    const target = batch.target as "transactions" | "counterparties";
    const mapping: ColumnMapping = {};
    for (const f of fieldsFor(target)) {
      const v = (i as Record<string, string>)[`col_${f.key}`];
      const n = v === undefined || v === "" ? null : Number(v);
      mapping[f.key] =
        n !== null && Number.isInteger(n) && n >= 0 && n < batch.headers.length ? n : null;
    }
    const missing = fieldsFor(target).filter((f) => f.required && mapping[f.key] === null);
    if (missing.length) {
      throw new AppError("VALIDATION", "required columns", {
        publicMessage: `Choose a column for: ${missing.map((f) => f.label).join(", ")}.`,
      });
    }
    if (mapping.kind === null && !i.defaultKind) {
      throw new AppError("VALIDATION", "kind", {
        publicMessage: "Choose the type for these rows, or map a column that contains it.",
      });
    }
    const rows = await getImportRows(i.batchId);
    const results = applyMapping(target, toSheetRows(rows), mapping, {
      dateFormat: i.dateFormat,
      defaultKind: i.defaultKind || null,
    });
    const summary = await rpc<Record<string, number>>("save_import_mapping", {
      p_batch_id: i.batchId,
      p_mapping: mapping,
      p_options: { dateFormat: i.dateFormat, defaultKind: i.defaultKind || null },
      p_results: results,
    });
    refresh();
    return `Checked ${summary.total} rows: ${summary.valid} ready, ${summary.invalid} with errors, ${summary.duplicate} duplicates, ${summary.possible_duplicate} possible duplicates.`;
  });
}

const commitSchema = z.object({
  clientId: z.uuid(),
  batchId: z.uuid(),
  includePossible: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export async function commitImportAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.commitImport", commitSchema, fd, async (i) => {
    const access = await requireActionAccess();
    requireIntakeWriter(access, i.clientId);
    const s = await rpc<Record<string, number>>("commit_import_batch", {
      p_batch_id: i.batchId,
      p_include_possible_duplicates: i.includePossible,
    });
    refresh();
    return `Imported ${s.imported} of ${s.total} rows (${s.duplicate} duplicates, ${s.invalid} with errors, ${s.skipped} skipped). Imported records are submitted for review; nothing is posted.`;
  });
}

const batchOnly = z.object({ clientId: z.uuid(), batchId: z.uuid() });

export async function cancelImportAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("intake.cancelImport", batchOnly, fd, async (i) => {
    await requireActionAccess();
    await rpc("cancel_import_batch", { p_batch_id: i.batchId });
    refresh();
    return "Import cancelled.";
  });
}
