"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { requireActionAccess } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";

const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name").max(200),
});

/** Updates the caller's own display name (RLS + column grant allow only this). */
export async function updateProfileAction(
  _prev: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  return runAction("account.updateProfile", profileSchema, formData, async ({ fullName }) => {
    const access = await requireActionAccess();
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("profiles")
      .update({ full_name: fullName })
      .eq("id", access.user_id)
      .select("id");
    if (error) throw fromDbError(error, "update profile");
    if (!data || data.length !== 1) throw fromDbError({ code: "42501" }, "update profile");
    refresh();
    return "Profile updated.";
  });
}
