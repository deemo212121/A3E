import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";
import { z } from "zod";

import {
  CLIENT_ROLES,
  FIRM_ROLES,
  type AccessFacts,
  type ClientRole,
  type FirmRole,
} from "@/lib/access/route-policy";
import { AppError } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

export { CLIENT_ROLES, FIRM_ROLES, type ClientRole, type FirmRole };

const accessSchema = z.object({
  user_id: z.uuid(),
  email: z.string(),
  full_name: z.string(),
  is_active: z.boolean(),
  aal: z.string(),
  firm_role: z.enum(FIRM_ROLES).nullable(),
  firm_role_effective: z.enum(FIRM_ROLES).nullable(),
  mfa_required: z.boolean(),
  client_memberships: z.array(
    z.object({
      client_id: z.uuid(),
      code: z.string(),
      display_name: z.string(),
      status: z.string(),
      role: z.enum(CLIENT_ROLES),
    }),
  ),
  staff_client_ids: z.array(z.uuid()).default([]),
  payroll_client_ids: z.array(z.uuid()).default([]),
});
export type Access = z.infer<typeof accessSchema>;

/**
 * Loads the caller's identity and memberships FROM THE DATABASE (never from
 * client input or JWT metadata). Returns null when not signed in.
 * Memoized per request (React `cache`), so layout and page share one lookup.
 */
export const getCurrentAccess = cache(async (): Promise<Access | null> => {
  const supabase = await createSupabaseServerClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claims?.claims?.sub) return null;

  const { data, error } = await supabase.rpc("get_my_access");
  if (error) throw fromDbError(error, "get_my_access");
  return accessSchema.parse(data);
});

/** Converts the database access summary into policy facts. */
export function toFacts(access: Access): AccessFacts {
  return {
    firmRole: access.firm_role_effective,
    clientMemberships: access.client_memberships.map((m) => ({
      clientId: m.client_id,
      role: m.role,
      displayName: m.display_name,
      code: m.code,
    })),
    staffClientIds: access.staff_client_ids,
    payrollClientIds: access.payroll_client_ids,
  };
}

// ---------------------------------------------------------------------------
// Page guards (redirect)
// ---------------------------------------------------------------------------

/** For pages: signed in, active, and MFA satisfied for staff. */
export async function requirePageAccess(): Promise<Access> {
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  if (!access.is_active) redirect("/account-disabled");
  if (access.mfa_required) redirect("/mfa");
  return access;
}

// ---------------------------------------------------------------------------
// Action guards (throw AppError)
// ---------------------------------------------------------------------------

export async function requireActionAccess(): Promise<Access> {
  const access = await getCurrentAccess();
  if (!access) throw new AppError("UNAUTHENTICATED", "no session");
  if (!access.is_active) throw new AppError("FORBIDDEN", "account disabled");
  if (access.mfa_required) {
    throw new AppError("FORBIDDEN", "staff MFA not satisfied", {
      publicMessage: "Two-step verification is required for staff accounts.",
    });
  }
  return access;
}

export function hasFirmRole(access: Access, roles: readonly FirmRole[]): boolean {
  return access.firm_role_effective !== null && roles.includes(access.firm_role_effective);
}

export function requireFirmRole(access: Access, roles: readonly FirmRole[]): void {
  if (!hasFirmRole(access, roles)) {
    throw new AppError("FORBIDDEN", `requires firm role ${roles.join("|")}`);
  }
}

export function clientRoleOf(access: Access, clientId: string): ClientRole | null {
  return access.client_memberships.find((m) => m.client_id === clientId)?.role ?? null;
}

/**
 * Server-side pre-check that mirrors the database rules for managing client
 * members (the database re-checks; this rejects early and audibly).
 */
export function canManageClientMembers(access: Access, clientId: string): boolean {
  return (
    hasFirmRole(access, ["firm_admin", "firm_manager"]) ||
    clientRoleOf(access, clientId) === "client_owner"
  );
}
