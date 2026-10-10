"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { FIRM_ROLES, requireActionAccess, requireFirmRole } from "@/server/auth/access";
import { deleteAllMfaFactors, sendInvitationEmail, setAuthBan } from "@/server/auth/admin-auth";
import { fromDbError } from "@/server/db/errors";

/*
 * Firm administration. Every action:
 *   1. checks the caller's role on the server (requireFirmRole), then
 *   2. calls a database function that checks AGAIN and writes the audit trail.
 */

type Result = ActionResult<string>;

const createClientSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/, "2–30 characters: letters, numbers, hyphen"),
  displayName: z.string().trim().min(1, "Required").max(200),
});

export async function createClientAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("admin.createClient", createClientSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin", "firm_manager"]);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("create_client", {
      p_code: input.code,
      p_display_name: input.displayName,
    });
    if (error) throw fromDbError(error, "create_client");
    refresh();
    return `Client ${input.code} created.`;
  });
}

const inviteStaffSchema = z.object({
  email: z.email("Enter a valid email address").max(320),
  role: z.enum(FIRM_ROLES),
});

export async function inviteStaffAction(_prev: Result | null, formData: FormData): Promise<Result> {
  return runAction("admin.inviteStaff", inviteStaffSchema, formData, async ({ email, role }) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin"]);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("create_invitation", {
      p_email: email,
      p_kind: "firm",
      p_firm_role: role,
    });
    if (error) throw fromDbError(error, "create_invitation(firm)");
    const delivery = await sendInvitationEmail(email);
    refresh();
    return delivery === "sent"
      ? `Invitation emailed to ${email}.`
      : `${email} already has an account; the invitation will appear on their dashboard.`;
  });
}

const setFirmRoleSchema = z.object({
  userId: z.uuid(),
  role: z.union([z.enum(FIRM_ROLES), z.literal("none")]),
});

export async function setFirmRoleAction(_prev: Result | null, formData: FormData): Promise<Result> {
  return runAction("admin.setFirmRole", setFirmRoleSchema, formData, async ({ userId, role }) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin"]);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_firm_role", {
      p_user_id: userId,
      p_role: role === "none" ? null : role,
    });
    if (error) throw fromDbError(error, "set_firm_role");
    refresh();
    return "Firm role updated.";
  });
}

const setActiveSchema = z.object({
  userId: z.uuid(),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
  reason: z.string().trim().max(500).optional(),
});

export async function setUserActiveAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("admin.setUserActive", setActiveSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin"]);
    const supabase = await createSupabaseServerClient();
    // Database first: it authorizes, takes effect immediately for all data
    // access, and audits. Then block/unblock sign-in at the Auth level.
    const { error } = await supabase.rpc("set_user_active", {
      p_user_id: input.userId,
      p_active: input.active,
      p_reason: input.reason || null,
    });
    if (error) throw fromDbError(error, "set_user_active");
    await setAuthBan(input.userId, !input.active);
    refresh();
    return input.active ? "Account enabled." : "Account disabled and signed-in sessions blocked.";
  });
}

const resetMfaSchema = z.object({
  userId: z.uuid(),
  reason: z.string().trim().min(3, "Enter a reason").max(500),
});

export async function resetUserMfaAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("admin.resetUserMfa", resetMfaSchema, formData, async ({ userId, reason }) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin"]);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("authorize_mfa_reset", {
      p_user_id: userId,
      p_reason: reason,
    });
    if (error) throw fromDbError(error, "authorize_mfa_reset");
    const removed = await deleteAllMfaFactors(userId);
    return `Two-step verification reset (${removed} factor(s) removed). The user must enroll again.`;
  });
}

const assignmentSchema = z.object({
  clientId: z.uuid(),
  userId: z.uuid(),
  assignmentRole: z.enum(["preparer", "reviewer"]),
  op: z.enum(["assign", "unassign"]),
});

export async function setAssignmentAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("admin.setAssignment", assignmentSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin", "firm_manager"]);
    const supabase = await createSupabaseServerClient();
    const fn = input.op === "assign" ? "assign_staff" : "unassign_staff";
    const { error } = await supabase.rpc(fn, {
      p_client_id: input.clientId,
      p_user_id: input.userId,
      p_assignment_role: input.assignmentRole,
    });
    if (error) throw fromDbError(error, fn);
    refresh();
    return input.op === "assign" ? "Staff assigned." : "Assignment removed.";
  });
}

const revokeSchema = z.object({ invitationId: z.uuid() });

export async function revokeInvitationAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("invitations.revoke", revokeSchema, formData, async ({ invitationId }) => {
    await requireActionAccess(); // authority depends on the invitation; the DB decides
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("revoke_invitation", { p_invitation_id: invitationId });
    if (error) throw fromDbError(error, "revoke_invitation");
    refresh();
    return "Invitation revoked.";
  });
}

const updateClientSchema = z.object({
  clientId: z.uuid(),
  displayName: z.string().trim().min(1, "Required").max(200),
  status: z.enum(["onboarding", "active", "archived"]),
});

export async function updateClientAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("admin.updateClient", updateClientSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireFirmRole(access, ["firm_admin", "firm_manager"]);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_client", {
      p_client_id: input.clientId,
      p_display_name: input.displayName,
      p_status: input.status,
    });
    if (error) throw fromDbError(error, "update_client");
    refresh();
    return "Client updated.";
  });
}
