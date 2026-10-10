"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";

export interface TotpEnrollment {
  factorId: string;
  qrCode: string; // SVG data URL
  secret: string;
}

async function requireSession() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) throw new AppError("UNAUTHENTICATED", "no session");
  return supabase;
}

export async function startTotpEnrollmentAction(
  _prev: ActionResult<TotpEnrollment> | null,
  formData: FormData,
): Promise<ActionResult<TotpEnrollment>> {
  return runAction("mfa.enroll", z.object({}), formData, async () => {
    const supabase = await requireSession();
    // Remove abandoned, never-verified factors so enrollment can restart cleanly.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const factor of factors?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 19)}`,
    });
    if (error || !data) {
      throw new AppError("UNAVAILABLE", `mfa.enroll failed: ${error?.message}`, {
        publicMessage: "Two-step verification setup is unavailable. Try again later.",
      });
    }
    return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
  });
}

const verifySchema = z.object({
  factorId: z.uuid(),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
});

export async function verifyTotpAction(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  return runAction("mfa.verify", verifySchema, formData, async ({ factorId, code }) => {
    const supabase = await requireSession();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      throw new AppError("VALIDATION", `mfa.verify failed: ${error.code ?? error.message}`, {
        publicMessage: "That code is not valid. Check your authenticator app and try again.",
      });
    }
    redirect("/app");
  });
}
