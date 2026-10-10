import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/*
 * Intake read models. Every query runs as the signed-in user, so RLS decides
 * what is visible (client users never see internal notes or other tenants).
 * Amounts are selected as text: money never passes through floating point.
 */

export interface IntakeSummary {
  transactions: Record<string, number>;
  counterparties: Record<string, number>;
  documents: Record<string, number>;
  profile: { status: string; version: number } | null;
  imports_open: number;
}

export async function getIntakeSummary(clientId: string): Promise<IntakeSummary> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("intake_summary", { p_client_id: clientId });
  if (error) throw fromDbError(error, "intake_summary");
  return data as IntakeSummary;
}

export interface TxnListRow {
  id: string;
  kind: string;
  status: string;
  txn_date: string | null;
  document_ref: string | null;
  counterparty_name: string | null;
  gross_amount: string | null;
  source: string;
  updated_at: string;
}

export async function listTransactions(
  clientId: string,
  statuses?: string[],
): Promise<TxnListRow[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("intake_transactions")
    .select(
      "id, kind, status, txn_date, document_ref, counterparty_name, gross_amount::text, source, updated_at",
    )
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (statuses?.length) q = q.in("status", statuses);
  const { data, error } = await q;
  if (error) throw fromDbError(error, "select intake transactions");
  return (data ?? []) as TxnListRow[];
}

export interface TxnLine {
  line_no: number;
  description: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string;
  account_hint: string | null;
}
export interface TxnDocument {
  id: string;
  original_filename: string;
  category: string;
  size_bytes: number;
}
export type { TimelineItem } from "@/lib/intake/types";
import type { TimelineItem } from "@/lib/intake/types";
export interface TxnDetail {
  id: string;
  client_id: string;
  kind: string;
  status: string;
  txn_date: string | null;
  document_type: string | null;
  document_ref: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  counterparty_tin: string | null;
  description: string | null;
  gross_amount: string | null;
  vat_amount_stated: string | null;
  withholding_amount_stated: string | null;
  payment_method: string | null;
  source: string;
  row_version: number;
  created_by: string | null;
  submitted_by: string | null;
  reviewed_by: string | null;
  journal_entry_id: string | null;
  import_batch_id: string | null;
  import_row_no: number | null;
  lines: TxnLine[];
  documents: TxnDocument[];
}

type Person = { full_name: string | null; email: string | null } | null;
const personName = (p: Person | Person[]) => {
  const one = Array.isArray(p) ? p[0] : p;
  return one?.full_name || one?.email || "Firm staff";
};

export async function getTransaction(clientId: string, id: string): Promise<TxnDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("intake_transactions")
    .select(
      "id, client_id, kind, status, txn_date, document_type, document_ref, counterparty_id, counterparty_name, counterparty_tin, description, gross_amount::text, vat_amount_stated::text, withholding_amount_stated::text, payment_method, source, row_version, created_by, submitted_by, reviewed_by, journal_entry_id, import_batch_id, import_row_no, intake_transaction_lines(line_no, description, quantity::text, unit_price::text, amount::text, account_hint), intake_transaction_documents(documents(id, original_filename, category, size_bytes))",
    )
    .eq("client_id", clientId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromDbError(error, "select intake transaction");
  if (!data) return null;
  const {
    intake_transaction_lines: lines,
    intake_transaction_documents: links,
    ...rest
  } = data as Record<string, unknown> & {
    intake_transaction_lines: TxnLine[];
    intake_transaction_documents: { documents: TxnDocument | TxnDocument[] | null }[];
  };
  return {
    ...(rest as unknown as Omit<TxnDetail, "lines" | "documents">),
    lines: [...(lines ?? [])].sort((a, b) => a.line_no - b.line_no),
    documents: (links ?? [])
      .map((l) => (Array.isArray(l.documents) ? l.documents[0] : l.documents))
      .filter((d): d is TxnDocument => Boolean(d)),
  };
}

/** Status history and comments of one record, oldest first. */
export async function getTimeline(
  clientId: string,
  subject: string,
  subjectId: string,
): Promise<TimelineItem[]> {
  const supabase = await createSupabaseServerClient();
  const [events, comments] = await Promise.all([
    supabase
      .from("intake_events")
      .select(
        "occurred_at, from_status, to_status, comment, actor:profiles!intake_events_actor_id_fkey(full_name, email)",
      )
      .eq("client_id", clientId)
      .eq("subject_type", subject)
      .eq("subject_id", subjectId)
      .order("id"),
    supabase
      .from("intake_comments")
      .select(
        "created_at, body, visibility, author:profiles!intake_comments_author_id_fkey(full_name, email)",
      )
      .eq("client_id", clientId)
      .eq("subject_type", subject)
      .eq("subject_id", subjectId)
      .order("created_at"),
  ]);
  if (events.error) throw fromDbError(events.error, "select intake events");
  if (comments.error) throw fromDbError(comments.error, "select intake comments");
  const items: TimelineItem[] = [
    ...(events.data ?? []).map((e) => ({
      kind: "event" as const,
      at: e.occurred_at as string,
      actor: personName(e.actor as unknown as Person | Person[]),
      from: e.from_status as string | null,
      to: e.to_status as string,
      text: e.comment as string | null,
    })),
    ...(comments.data ?? []).map((c) => ({
      kind: "comment" as const,
      at: c.created_at as string,
      actor: personName(c.author as unknown as Person | Person[]),
      text: c.body as string,
      internal: c.visibility === "internal",
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export interface CounterpartyRow {
  id: string;
  kind: string;
  registered_name: string;
  tin: string | null;
  vat_status: string;
  address: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  source: string;
  row_version: number;
}

export async function listCounterparties(
  clientId: string,
  statuses?: string[],
): Promise<CounterpartyRow[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("counterparties")
    .select(
      "id, kind, registered_name, tin, vat_status, address, email, phone, status, source, row_version",
    )
    .eq("client_id", clientId)
    .order("registered_name")
    .limit(1000);
  if (statuses?.length) q = q.in("status", statuses);
  const { data, error } = await q;
  if (error) throw fromDbError(error, "select counterparties");
  return (data ?? []) as CounterpartyRow[];
}

export interface ProfileRow {
  id: string;
  version: number;
  status: string;
  registered_name: string | null;
  trade_name: string | null;
  tin: string | null;
  rdo_code: string | null;
  business_type: string | null;
  vat_status: string | null;
  registered_address: string | null;
  zip_code: string | null;
  line_of_business: string | null;
  fiscal_year_end_month: number | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  row_version: number;
  submitted_by: string | null;
  updated_at: string;
}

export async function listProfiles(clientId: string): Promise<ProfileRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("business_profiles")
    .select(
      "id, version, status, registered_name, trade_name, tin, rdo_code, business_type, vat_status, registered_address, zip_code, line_of_business, fiscal_year_end_month, contact_email, contact_phone, notes, row_version, submitted_by, updated_at",
    )
    .eq("client_id", clientId)
    .order("version", { ascending: false });
  if (error) throw fromDbError(error, "select business profiles");
  return (data ?? []) as ProfileRow[];
}

export interface DocumentRow {
  id: string;
  original_filename: string;
  extension: string;
  size_bytes: number;
  category: string;
  period_month: string | null;
  description: string | null;
  review_status: string;
  review_comment: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

export async function listDocuments(
  clientId: string,
  opts: { includeImports?: boolean } = {},
): Promise<DocumentRow[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("documents")
    .select(
      "id, original_filename, extension, size_bytes, category, period_month, description, review_status, review_comment, uploaded_by, uploaded_at",
    )
    .eq("client_id", clientId)
    .eq("upload_state", "complete")
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(500);
  if (!opts.includeImports) q = q.neq("category", "import_source");
  const { data, error } = await q;
  if (error) throw fromDbError(error, "select documents");
  return (data ?? []) as DocumentRow[];
}

export async function getDocumentForDownload(
  documentId: string,
): Promise<{ id: string; storage_path: string; original_filename: string } | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, storage_path, original_filename")
    .eq("id", documentId)
    .eq("upload_state", "complete")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw fromDbError(error, "select document");
  return data;
}

export interface ImportBatchRow {
  id: string;
  document_id: string;
  target: string;
  file_type: string;
  sheet_name: string | null;
  headers: string[];
  row_count: number;
  mapping: Record<string, unknown> | null;
  options: Record<string, unknown> | null;
  status: string;
  summary: Record<string, number> | null;
  created_at: string;
  committed_at: string | null;
  documents: { original_filename: string } | null;
}

const BATCH_COLUMNS =
  "id, document_id, target, file_type, sheet_name, headers, row_count, mapping, options, status, summary, created_at, committed_at, documents(original_filename)";

export async function listImports(clientId: string): Promise<ImportBatchRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select(BATCH_COLUMNS)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw fromDbError(error, "select import batches");
  return (data ?? []) as unknown as ImportBatchRow[];
}

export async function getImport(clientId: string, batchId: string): Promise<ImportBatchRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select(BATCH_COLUMNS)
    .eq("client_id", clientId)
    .eq("id", batchId)
    .maybeSingle();
  if (error) throw fromDbError(error, "select import batch");
  return data as unknown as ImportBatchRow | null;
}

export interface ImportRowView {
  row_no: number;
  raw: (string | number)[];
  normalized: Record<string, string | null> | null;
  errors: { field: string; message: string }[];
  outcome: string;
  duplicate_note: string | null;
  created_id: string | null;
}

/** All rows of a batch (paged, since the API returns at most 1000 rows per request). */
export async function getImportRows(
  batchId: string,
  outcomes?: string[],
): Promise<ImportRowView[]> {
  const supabase = await createSupabaseServerClient();
  const out: ImportRowView[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    let q = supabase
      .from("import_rows")
      .select("row_no, raw, normalized, errors, outcome, duplicate_note, created_id")
      .eq("batch_id", batchId)
      .order("row_no")
      .range(from, from + 999);
    if (outcomes?.length) q = q.in("outcome", outcomes);
    const { data, error } = await q;
    if (error) throw fromDbError(error, "select import rows");
    out.push(...((data ?? []) as ImportRowView[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export interface QueueItem {
  id: string;
  client_id: string;
  kind: string;
  status: string;
  txn_date: string | null;
  document_ref: string | null;
  counterparty_name: string | null;
  gross_amount: string | null;
}

/** Intake waiting for firm action, across all clients the caller may see. */
export async function listIntakeQueue(statuses: string[]): Promise<QueueItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("intake_transactions")
    .select(
      "id, client_id, kind, status, txn_date, document_ref, counterparty_name, gross_amount::text",
    )
    .in("status", statuses)
    .order("submitted_at", { ascending: true })
    .limit(300);
  if (error) throw fromDbError(error, "select intake queue");
  return (data ?? []) as QueueItem[];
}
