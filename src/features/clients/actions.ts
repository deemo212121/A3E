"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import {
  CLIENT_ROLES,
  canManageClientMembers,
  clientRoleOf,
  hasFirmRole,
  requireActionAccess,
  type Access,
} from "@/server/auth/access";
import { sendInvitationEmail } from "@/server/auth/admin-auth";
import { fromDbError } from "@/server/db/errors";

type Result = ActionResult<string>;

function requireMemberManager(access: Access, clientId: string): void {
  if (!canManageClientMembers(access, clientId)) {
    throw new AppError("FORBIDDEN", "cannot manage members of this client");
  }
}

// ---------------------------------------------------------------------------
// Members and invitations
// ---------------------------------------------------------------------------
const inviteMemberSchema = z.object({
  clientId: z.uuid(),
  email: z.email("Enter a valid email address").max(320),
  role: z.enum(CLIENT_ROLES),
});

export async function inviteClientMemberAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("clients.inviteMember", inviteMemberSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireMemberManager(access, input.clientId);
    if (input.role === "client_owner" && !hasFirmRole(access, ["firm_admin", "firm_manager"])) {
      throw new AppError("FORBIDDEN", "only the firm can add owners", {
        publicMessage: "Only the accounting firm can add another owner.",
      });
    }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("create_invitation", {
      p_email: input.email,
      p_kind: "client",
      p_client_id: input.clientId,
      p_client_role: input.role,
    });
    if (error) throw fromDbError(error, "create_invitation(client)");
    const delivery = await sendInvitationEmail(input.email);
    refresh();
    return delivery === "sent"
      ? `Invitation emailed to ${input.email}.`
      : `${input.email} already has an account; the invitation will appear on their dashboard.`;
  });
}

const memberRoleSchema = z.object({
  clientId: z.uuid(),
  userId: z.uuid(),
  role: z.union([z.enum(CLIENT_ROLES), z.literal("remove")]),
});

export async function setClientMemberRoleAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("clients.setMemberRole", memberRoleSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireMemberManager(access, input.clientId);
    const supabase = await createSupabaseServerClient();
    const { error } =
      input.role === "remove"
        ? await supabase.rpc("remove_client_member", {
            p_client_id: input.clientId,
            p_user_id: input.userId,
          })
        : await supabase.rpc("set_client_member_role", {
            p_client_id: input.clientId,
            p_user_id: input.userId,
            p_role: input.role,
          });
    if (error) throw fromDbError(error, "client member change");
    refresh();
    return input.role === "remove" ? "Member removed." : "Member role updated.";
  });
}

const acceptSchema = z.object({ invitationId: z.uuid() });

export async function acceptInvitationAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("invitations.accept", acceptSchema, formData, async ({ invitationId }) => {
    await requireActionAccess();
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("accept_invitation", { p_invitation_id: invitationId });
    if (error) throw fromDbError(error, "accept_invitation");
    redirect("/app");
  });
}

// ---------------------------------------------------------------------------
// Client contacts (tenant-owned records; RLS is the final authority)
// ---------------------------------------------------------------------------
function requireRecordWriter(access: Access, clientId: string): void {
  const role = clientRoleOf(access, clientId);
  const isClientWriter = role === "client_owner" || role === "client_staff";
  // Staff assignment is verified by RLS; the server pre-check requires a staff role.
  const isStaff = hasFirmRole(access, ["firm_manager", "reviewer", "accountant", "bookkeeper"]);
  if (!isClientWriter && !isStaff) {
    throw new AppError("FORBIDDEN", "no write access to client records");
  }
}

const contactSchema = z.object({
  clientId: z.uuid(),
  fullName: z.string().trim().min(1, "Required").max(200),
  position: z.string().trim().max(100).optional(),
  email: z.union([z.literal(""), z.email("Enter a valid email address").max(320)]).optional(),
  phone: z.string().trim().max(40).optional(),
});

export async function createContactAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("contacts.create", contactSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireRecordWriter(access, input.clientId);
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.from("client_contacts").insert({
      client_id: input.clientId,
      full_name: input.fullName,
      position: input.position || null,
      email: input.email || null,
      phone: input.phone || null,
    });
    if (error) throw fromDbError(error, "insert client_contacts");
    refresh();
    return "Contact added.";
  });
}

const deleteContactSchema = z.object({ clientId: z.uuid(), contactId: z.uuid() });

export async function deleteContactAction(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  return runAction("contacts.delete", deleteContactSchema, formData, async (input) => {
    const access = await requireActionAccess();
    requireRecordWriter(access, input.clientId);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("client_contacts")
      .delete()
      .eq("id", input.contactId)
      .eq("client_id", input.clientId)
      .select("id");
    if (error) throw fromDbError(error, "delete client_contacts");
    if (!data || data.length === 0) {
      // RLS filtered the row: either it does not exist or the caller may not delete it.
      throw new AppError("FORBIDDEN", "delete affected no rows", {
        publicMessage: "You do not have permission to delete this contact.",
      });
    }
    refresh();
    return "Contact deleted.";
  });
}
