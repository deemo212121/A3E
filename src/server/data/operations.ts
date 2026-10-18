import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/*
 * Firm operations read models (Phase 15). User-scoped client: RLS decides
 * (filings, work, exceptions: assigned staff; requests: also the client's
 * members; notifications: the recipient only).
 */

async function q<T>(
  label: string,
  run: (
    sb: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
) {
  const { data, error } = await run(await createSupabaseServerClient());
  if (error) throw fromDbError(error, label);
  return data as T;
}

export interface DeadlineRule {
  id: string;
  code: string;
  title: string;
  kind: string;
  form_code: string | null;
  frequency: string;
  due_months_after: number;
  due_day: number;
  weekend_rule: string;
  skip_periods: number[];
  reminder_days: number[];
  source: { citation?: string; issued_on?: string; url?: string };
  notes: string | null;
  status: string;
  entered_by: string | null;
  verified_by: string | null;
  verify_note: string | null;
}
export const listDeadlineRules = () =>
  q<DeadlineRule[]>("deadline rules", (sb) =>
    sb.from("deadline_rules").select("*").order("status").order("code"),
  );

export interface ClientDeadline {
  id: string;
  rule_id: string;
  starts_on: string;
  ends_on: string | null;
  anchor_month: number;
  preparer_id: string | null;
  reviewer_id: string | null;
}
export const listClientDeadlines = (clientId: string) =>
  q<ClientDeadline[]>("client deadlines", (sb) =>
    sb
      .from("client_deadlines")
      .select("id, rule_id, starts_on, ends_on, anchor_month, preparer_id, reviewer_id")
      .eq("client_id", clientId)
      .order("starts_on"),
  );

export interface FilingRow {
  id: string;
  client_id: string;
  rule_id: string | null;
  form_code: string;
  title: string;
  period_from: string;
  period_to: string;
  due_on: string;
  due_basis: string;
  status: string;
  preparer_id: string | null;
  reviewer_id: string | null;
  amends_id: string | null;
  version: number;
}
const FILING_COLS =
  "id, client_id, rule_id, form_code, title, period_from, period_to, due_on, due_basis, status, preparer_id, reviewer_id, amends_id, version";

export const listFilings = (opts: {
  clientId?: string;
  from?: string;
  to?: string;
  open?: boolean;
}) =>
  q<FilingRow[]>("filings", (sb) => {
    let query = sb.from("filings").select(FILING_COLS);
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    if (opts.from) query = query.gte("due_on", opts.from);
    if (opts.to) query = query.lte("due_on", opts.to);
    if (opts.open) query = query.not("status", "in", "(filed,not_required)");
    return query.order("due_on").order("form_code").limit(1000);
  });

export interface FilingDetail extends FilingRow {
  workpaper_id: string | null;
  prepared_by: string | null;
  prepared_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  output_run_id: string | null;
  export_method: string | null;
  export_reference: string | null;
  exported_by: string | null;
  exported_at: string | null;
  filed_on: string | null;
  filing_channel: string | null;
  filing_reference: string | null;
  filing_evidence: string | null;
  filed_confirmed_by: string | null;
  filed_confirmed_at: string | null;
  not_required_reason: string | null;
  created_at: string;
}
export interface EventRow {
  id: number;
  from_status: string | null;
  to_status: string | null;
  event: string;
  note: string | null;
  actor_id: string | null;
  occurred_at: string;
}
export async function getFiling(clientId: string, id: string) {
  const f = await q<FilingDetail | null>("filing", (sb) =>
    sb.from("filings").select("*").eq("client_id", clientId).eq("id", id).maybeSingle(),
  );
  if (!f) return null;
  const events = await q<EventRow[]>("filing events", (sb) =>
    sb
      .from("filing_events")
      .select("id, from_status, to_status, event, note, actor_id, occurred_at")
      .eq("filing_id", id)
      .order("id"),
  );
  return { ...f, events };
}

export interface WorkItemRow {
  id: string;
  client_id: string;
  kind: string;
  title: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  reviewer_id: string | null;
  requires_review: boolean;
  due_on: string | null;
  created_by: string | null;
  version: number;
}
const WORK_COLS =
  "id, client_id, kind, title, status, priority, assignee_id, reviewer_id, requires_review, due_on, created_by, version";
export const listWorkItems = (opts: { clientId?: string; open?: boolean }) =>
  q<WorkItemRow[]>("work items", (sb) => {
    let query = sb.from("work_items").select(WORK_COLS);
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    if (opts.open) query = query.not("status", "in", "(done,cancelled)");
    return query.order("due_on", { nullsFirst: false }).order("created_at").limit(1000);
  });

export interface WorkItemDetail extends WorkItemRow {
  details: string | null;
  link_type: string | null;
  link_id: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
}
export async function getWorkItem(clientId: string, id: string) {
  const w = await q<WorkItemDetail | null>("work item", (sb) =>
    sb.from("work_items").select("*").eq("client_id", clientId).eq("id", id).maybeSingle(),
  );
  if (!w) return null;
  const events = await q<EventRow[]>("work item events", (sb) =>
    sb
      .from("work_item_events")
      .select("id, from_status, to_status, event, note, actor_id, occurred_at")
      .eq("item_id", id)
      .order("id"),
  );
  return { ...w, events };
}

export interface DocumentRequestRow {
  id: string;
  title: string;
  details: string | null;
  category: string | null;
  period_from: string | null;
  period_to: string | null;
  due_on: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
  document_ids: string[];
  response_note: string | null;
  responded_by: string | null;
  responded_at: string | null;
  decision_note: string | null;
  decided_by: string | null;
  reminder_count: number;
  version: number;
}
export const listDocumentRequests = (clientId: string) =>
  q<DocumentRequestRow[]>("document requests", (sb) =>
    sb
      .from("document_requests")
      .select(
        "id, title, details, category, period_from, period_to, due_on, status, requested_by, requested_at, document_ids, response_note, responded_by, responded_at, decision_note, decided_by, reminder_count, version",
      )
      .eq("client_id", clientId)
      .order("due_on", { ascending: false })
      .limit(500),
  );

export interface NotificationRow {
  id: string;
  client_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
}
export const listNotifications = () =>
  q<NotificationRow[]>("notifications", (sb) =>
    sb
      .from("notifications")
      .select("id, client_id, kind, title, body, link, created_at, read_at")
      .order("created_at", { ascending: false })
      .limit(200),
  );
export async function countUnreadNotifications(): Promise<number> {
  const sb = await createSupabaseServerClient();
  const { count, error } = await sb
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error) throw fromDbError(error, "count notifications");
  return count ?? 0;
}

export interface ServiceStatusRow {
  id: number;
  status: string;
  reason: string;
  set_by: string | null;
  set_at: string;
}
export const listServiceStatus = (clientId: string) =>
  q<ServiceStatusRow[]>("service status", (sb) =>
    sb
      .from("client_service_status")
      .select("id, status, reason, set_by, set_at")
      .eq("client_id", clientId)
      .order("id", { ascending: false })
      .limit(50),
  );
export const listCurrentServiceStatuses = async () => {
  const rows = await q<(ServiceStatusRow & { client_id: string })[]>("service status", (sb) =>
    sb
      .from("client_service_status")
      .select("id, client_id, status, reason, set_by, set_at")
      .order("id", { ascending: false })
      .limit(2000),
  );
  const current = new Map<string, ServiceStatusRow>();
  for (const r of rows) if (!current.has(r.client_id)) current.set(r.client_id, r);
  return current;
};

export interface ExceptionRow {
  id: string;
  client_id: string;
  kind: string;
  period_id: string | null;
  target_status: string | null;
  filing_id: string | null;
  new_due_on: string | null;
  reason: string;
  status: string;
  executed_at: string | null;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}
export const listExceptions = (opts: { clientId?: string; pending?: boolean }) =>
  q<ExceptionRow[]>("exceptions", (sb) => {
    let query = sb.from("ops_exceptions").select("*");
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    if (opts.pending) query = query.eq("status", "pending");
    return query.order("requested_at", { ascending: false }).limit(500);
  });

export interface ActivityRow {
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  client_id: string | null;
  client_code: string | null;
  action: string;
  table_name: string | null;
  row_id: string | null;
  changed_fields: string[] | null;
}
export const activityReport = (clientId: string | null, from: string, to: string) =>
  q<ActivityRow[]>("ops_activity_report", (sb) =>
    sb.rpc("ops_activity_report", { p_client_id: clientId, p_from: from, p_to: to }),
  );

/** Staff names (firm staff can read firm profiles under RLS). */
export async function staffNames(): Promise<Map<string, string>> {
  const rows = await q<
    { user_id: string; role: string; profiles: { full_name: string; email: string } | null }[]
  >("staff names", (sb) =>
    sb
      .from("firm_memberships")
      .select("user_id, role, profiles!firm_memberships_user_id_fkey(full_name, email)"),
  );
  return new Map(
    rows.map((r) => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      return [r.user_id, p?.full_name || p?.email || r.user_id];
    }),
  );
}

/** People who may be assigned work on a client: its assigned staff plus firm managers. */
export async function eligibleStaff(clientId: string) {
  const rows = await q<
    {
      user_id: string;
      role: string;
      profiles: { full_name: string; email: string; is_active: boolean } | null;
    }[]
  >("eligible staff", (sb) =>
    sb
      .from("firm_memberships")
      .select("user_id, role, profiles!firm_memberships_user_id_fkey(full_name, email, is_active)")
      .in("role", ["firm_manager", "reviewer", "accountant", "bookkeeper"]),
  );
  const assigned = await q<{ user_id: string }[]>("assignments", (sb) =>
    sb.from("client_assignments").select("user_id").eq("client_id", clientId),
  );
  const ids = new Set(assigned.map((a) => a.user_id));
  return rows
    .filter((r) => r.role === "firm_manager" || ids.has(r.user_id))
    .map((r) => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      return {
        user_id: r.user_id,
        role: r.role,
        active: p?.is_active ?? false,
        label: `${p?.full_name || p?.email} (${r.role.replace("firm_", "")})`,
      };
    })
    .filter((r) => r.active);
}

/** Client responses waiting for the firm (across the caller's clients). */
export const listSubmittedRequests = () =>
  q<
    {
      id: string;
      client_id: string;
      title: string;
      due_on: string;
      requested_by: string | null;
      responded_at: string | null;
    }[]
  >("submitted requests", (sb) =>
    sb
      .from("document_requests")
      .select("id, client_id, title, due_on, requested_by, responded_at")
      .eq("status", "submitted")
      .order("responded_at")
      .limit(500),
  );
