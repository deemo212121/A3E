"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getServerEnv } from "@/lib/env/server";
import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";

import { passwordSchema, safeNextPath } from "./schemas";

const signInSchema = z.object({
  email: z.email("Enter a valid email address").max(320),
  password: z.string().min(1, "Enter your password").max(200),
  next: z.string().max(500).optional(),
});

export async function signInAction(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  return runAction("auth.signIn", signInSchema, formData, async ({ email, password, next }) => {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Same message for unknown email, wrong password or banned account.
      throw new AppError("UNAUTHENTICATED", `sign-in failed: ${error.code ?? error.message}`, {
        publicMessage: "Invalid email or password.",
      });
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") redirect("/mfa");
    redirect(safeNextPath(next));
  });
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const resetRequestSchema = z.object({ email: z.email("Enter a valid email address").max(320) });

export async function requestPasswordResetAction(
  _prev: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction("auth.requestPasswordReset", resetRequestSchema, formData, async ({ email }) => {
    const supabase = await createSupabaseServerClient();
    const { APP_BASE_URL } = getServerEnv();
    // Errors are deliberately not revealed: the response is identical whether
    // or not the account exists (prevents account enumeration).
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${APP_BASE_URL}/auth/confirm?next=/auth/set-password`,
    });
    return "If an account exists for that email, a reset link has been sent.";
  });
}

const setPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

export async function setPasswordAction(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  return runAction("auth.setPassword", setPasswordSchema, formData, async ({ password }) => {
    const supabase = await createSupabaseServerClient();
    const { data: claims } = await supabase.auth.getClaims();
    if (!claims?.claims?.sub) throw new AppError("UNAUTHENTICATED", "no session");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      throw new AppError("VALIDATION", `updateUser(password) failed: ${error.message}`, {
        publicMessage: "The password could not be set. Use a stronger password and try again.",
      });
    }
    redirect("/app");
  });
}
