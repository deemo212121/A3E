import "server-only";

import { createHash } from "node:crypto";

import { AppError } from "@/lib/errors/app-error";
import { checkFile, MAX_DOCUMENT_BYTES } from "@/lib/intake/files";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

export const DOCUMENTS_BUCKET = "client-documents";

export interface StoreInput {
  clientId: string;
  file: File;
  category: string;
  periodMonth: string | null;
  description: string | null;
  idempotencyKey: string;
  maxBytes?: number;
}

export interface StoredDocument {
  documentId: string;
  bytes: Uint8Array;
  extension: string;
}

/**
 * Stores one uploaded file:
 *   1. checks the actual bytes (type, size, macros, zip bombs) and hashes them;
 *   2. begin_document_upload AS THE USER: the database checks the user's right
 *      to upload for this client, rejects duplicates, and returns the ONLY
 *      path the bytes may be written to;
 *   3. writes the bytes to that path with the server-only key (API users have
 *      no write access to the bucket at all);
 *   4. complete_document_upload AS THE USER confirms the stored size.
 * A retry with the same idempotency key reuses the same document.
 */
export async function storeDocument(input: StoreInput): Promise<StoredDocument> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const check = checkFile(input.file.name, bytes, input.maxBytes ?? MAX_DOCUMENT_BYTES);
  if (!check.ok) {
    throw new AppError("VALIDATION", `file rejected: ${check.reason}`, {
      publicMessage: check.reason,
      fieldErrors: { file: [check.reason] },
    });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc("begin_document_upload", {
    p_client_id: input.clientId,
    p_idempotency_key: input.idempotencyKey,
    p_original_filename: check.safeName,
    p_extension: check.extension,
    p_mime_type: check.mimeType,
    p_size_bytes: bytes.length,
    p_sha256: sha256,
    p_category: input.category,
    p_period_month: input.periodMonth,
    p_description: input.description,
  });
  if (error) throw fromDbError(error, "begin_document_upload");
  const row = (data as { document_id: string; object_path: string; state: string }[])[0];
  if (!row) throw new AppError("INTERNAL", "begin_document_upload returned nothing");

  if (row.state === "pending") {
    const admin = createSupabaseAdminClient();
    const { error: uploadError } = await admin.storage
      .from(DOCUMENTS_BUCKET)
      .upload(row.object_path, bytes, { contentType: check.mimeType, upsert: false });
    // A retry after a partial failure finds the object already there; the
    // completion step verifies its size.
    if (uploadError && !/exists|duplicate/i.test(uploadError.message)) {
      throw new AppError("UNAVAILABLE", `storage upload failed: ${uploadError.message}`, {
        publicMessage: "The file could not be stored. Please try again.",
      });
    }
    const { error: completeError } = await supabase.rpc("complete_document_upload", {
      p_document_id: row.document_id,
    });
    if (completeError) throw fromDbError(completeError, "complete_document_upload");
  }
  return { documentId: row.document_id, bytes, extension: check.extension };
}
