import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/errors/app-error";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Supabase Auth administration (requires SUPABASE_SECRET_KEY).
 * Callers MUST have performed the authorization check (and the matching
 * database function call) before invoking anything here.
 */

/** Sends a Supabase invitation email so a NEW person can set a password. */
export async function sendInvitationEmail(email: string): Promise<"sent" | "existing_account"> {
  const admin = createSupabaseAdminClient();
  const { APP_BASE_URL } = getServerEnv();
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${APP_BASE_URL}/auth/confirm?next=/auth/set-password`,
  });
  if (!error) return "sent";
  // Existing accounts simply see the invitation on their dashboard.
  if (error.code === "email_exists" || /already been registered/i.test(error.message)) {
    return "existing_account";
  }
  throw new AppError("UNAVAILABLE", `inviteUserByEmail failed: ${error.message}`, {
    publicMessage: "The invitation was saved, but the email could not be sent. Try again later.",
  });
}

/** Blocks or unblocks sign-in at the Auth level (complements is_active in the database). */
export async function setAuthBan(userId: string, banned: boolean): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: banned ? "876000h" : "none",
  });
  if (error) throw new AppError("UNAVAILABLE", `updateUserById(ban) failed: ${error.message}`);
}

/** Removes all MFA factors of a user (lost device). Returns the number removed. */
export async function deleteAllMfaFactors(userId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw new AppError("UNAVAILABLE", `listFactors failed: ${error.message}`);
  for (const factor of data.factors) {
    const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
      id: factor.id,
      userId,
    });
    if (deleteError) {
      throw new AppError("UNAVAILABLE", `deleteFactor failed: ${deleteError.message}`);
    }
  }
  return data.factors.length;
}
