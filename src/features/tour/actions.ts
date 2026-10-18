"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { AppError, type ActionResult } from "@/lib/errors/app-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runAction } from "@/server/actions/run-action";
import { requireActionAccess } from "@/server/auth/access";
import { fromDbError } from "@/server/db/errors";
import { demoEnabled } from "@/server/demo/demo-data";

/*
 * Tour sample data (development and staging only). The database refuses too
 * when its allow_tour_sandbox switch is off, as it must be in production.
 */
type Result = ActionResult<string>;

const schema = z.object({
  op: z.enum(["create", "remove"]),
  clientId: z
    .union([z.literal(""), z.uuid()])
    .optional()
    .default(""),
});

export async function tourSandboxAction(_p: Result | null, fd: FormData): Promise<Result> {
  return runAction("tour.sandbox", schema, fd, async (i) => {
    if (!demoEnabled()) {
      throw new AppError("FORBIDDEN", "tour sandbox in production", {
        publicMessage: "Sample data is not available in production.",
      });
    }
    const access = await requireActionAccess();
    if (!access.firm_role_effective) {
      throw new AppError("FORBIDDEN", "not a firm user", {
        publicMessage:
          "Sign in as a firm user (for example the demo manager) to create or remove sample data.",
      });
    }
    const supabase = await createSupabaseServerClient();
    const { error } =
      i.op === "create"
        ? await supabase.rpc("tour_seed_sandbox")
        : await supabase.rpc("tour_remove_sandbox", { p_client_id: i.clientId });
    if (error) throw fromDbError(error, "tour sandbox");
    refresh();
    return i.op === "create"
      ? "Sample data created. Start the guided tour below."
      : "Sample data removed.";
  });
}
