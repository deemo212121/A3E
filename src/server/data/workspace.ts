import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/*
 * Read models for the workspace pages. Every query uses the USER-scoped client,
 * so Row Level Security decides what is returned — these functions add no
 * privileges of their own.
 */

export interface ClientRow {
  id: string;
  code: string;
  display_name: string;
  status: string;
}

export async function listVisibleClients(): Promise<ClientRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, code, display_name, status")
    .order("display_name");
  if (error) throw fromDbError(error, "select clients");
  return data ?? [];
}

/** Returns null when the client does not exist OR is not visible to the caller. */
export async function getVisibleClient(clientId: string): Promise<ClientRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, code, display_name, status")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw fromDbError(error, "select client");
  return data;
}

export interface ContactRow {
  id: string;
  full_name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
}

export async function listContacts(clientId: string): Promise<ContactRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("client_contacts")
    .select("id, full_name, position, email, phone")
    .eq("client_id", clientId)
    .order("full_name");
  if (error) throw fromDbError(error, "select contacts");
  return data ?? [];
}

export interface MemberRow {
  user_id: string;
  role: string;
  name: string;
  email: string;
}

function one<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export async function listMembers(clientId: string): Promise<MemberRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("client_memberships")
    .select("user_id, role, profiles!client_memberships_user_id_fkey(full_name, email)")
    .eq("client_id", clientId);
  if (error) throw fromDbError(error, "select members");
  return (data ?? []).map((m) => {
    const p = one(
      m.profiles as { full_name: string; email: string } | { full_name: string; email: string }[],
    );
    return { user_id: m.user_id, role: m.role, name: p?.full_name ?? "", email: p?.email ?? "" };
  });
}

export interface AssignmentRow {
  client_id: string;
  user_id: string;
  assignment_role: string;
  name: string;
  email: string;
}

export async function listAssignments(clientId?: string): Promise<AssignmentRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("client_assignments")
    .select(
      "client_id, user_id, assignment_role, profiles!client_assignments_user_id_fkey(full_name, email)",
    );
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  if (error) throw fromDbError(error, "select assignments");
  return (data ?? []).map((a) => {
    const p = one(
      a.profiles as { full_name: string; email: string } | { full_name: string; email: string }[],
    );
    return {
      client_id: a.client_id,
      user_id: a.user_id,
      assignment_role: a.assignment_role,
      name: p?.full_name ?? "",
      email: p?.email ?? "",
    };
  });
}

export interface StaffOption {
  user_id: string;
  role: string;
  label: string;
}

export async function listAssignableStaff(): Promise<StaffOption[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("firm_memberships")
    .select("user_id, role, profiles!firm_memberships_user_id_fkey(full_name, email)")
    .in("role", ["firm_manager", "reviewer", "accountant", "bookkeeper"]);
  if (error) throw fromDbError(error, "select staff");
  return (data ?? []).map((s) => {
    const p = one(
      s.profiles as { full_name: string; email: string } | { full_name: string; email: string }[],
    );
    return { user_id: s.user_id, role: s.role, label: `${p?.full_name || p?.email} (${s.role})` };
  });
}

export interface InvitationRow {
  id: string;
  email: string;
  kind: string;
  firm_role: string | null;
  client_role: string | null;
  client_id: string | null;
  expires_at: string;
}

export async function listPendingInvitations(clientId?: string): Promise<InvitationRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("invitations")
    .select("id, email, kind, firm_role, client_role, client_id, expires_at")
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  if (error) throw fromDbError(error, "select invitations");
  return data ?? [];
}

export interface MyInvitation {
  id: string;
  kind: "firm" | "client";
  firm_role: string | null;
  client_id: string | null;
  client_name: string | null;
  client_role: string | null;
  expires_at: string;
}

export async function listMyInvitations(): Promise<MyInvitation[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_invitations");
  if (error) throw fromDbError(error, "list_my_invitations");
  return (data ?? []) as MyInvitation[];
}

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  firm_role: string | null;
}

export async function listUsersWithFirmRoles(): Promise<UserRow[]> {
  const supabase = await createSupabaseServerClient();
  const [{ data: profiles, error: pErr }, { data: roles, error: rErr }] = await Promise.all([
    supabase.from("profiles").select("id, email, full_name, is_active").order("email"),
    supabase.from("firm_memberships").select("user_id, role"),
  ]);
  if (pErr) throw fromDbError(pErr, "select profiles");
  if (rErr) throw fromDbError(rErr, "select firm roles");
  const roleOf = new Map((roles ?? []).map((r) => [r.user_id as string, r.role as string]));
  return (profiles ?? []).map((p) => ({ ...p, firm_role: roleOf.get(p.id) ?? null }));
}
