import "server-only";

import { REVIEW_ROLES, STAFF_ROLES } from "@/lib/access/route-policy";
import { AppError } from "@/lib/errors/app-error";
import { clientRoleOf, hasFirmRole, type Access } from "@/server/auth/access";

/*
 * Server-side pre-checks for intake actions. They mirror the database helpers
 * (private.can_submit_intake etc.), which remain the final authority.
 */

export function isStaffOn(access: Access, clientId: string): boolean {
  return (
    hasFirmRole(access, STAFF_ROLES) && access.staff_client_ids.includes(clientId.toLowerCase())
  );
}

/** Create, edit and submit intake records. */
export function canWriteIntake(access: Access, clientId: string): boolean {
  const role = clientRoleOf(access, clientId.toLowerCase());
  return isStaffOn(access, clientId) || role === "client_owner" || role === "client_staff";
}

export function canApproveIntake(access: Access, clientId: string): boolean {
  return (
    hasFirmRole(access, REVIEW_ROLES) && access.staff_client_ids.includes(clientId.toLowerCase())
  );
}

export function canProposeProfile(access: Access, clientId: string): boolean {
  return (
    (hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]) &&
      access.staff_client_ids.includes(clientId.toLowerCase())) ||
    clientRoleOf(access, clientId.toLowerCase()) === "client_owner"
  );
}

export function requireIntakeWriter(access: Access, clientId: string): void {
  if (!canWriteIntake(access, clientId)) {
    throw new AppError("FORBIDDEN", "not an intake writer for this client", {
      publicMessage: "You can view this business's records but not change them.",
    });
  }
}

export function requireIntakeStaff(access: Access, clientId: string): void {
  if (!isStaffOn(access, clientId)) {
    throw new AppError("FORBIDDEN", "not assigned firm staff for this client");
  }
}
