import "server-only";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { AppError, fail, isAppError, ok, type ActionResult } from "@/lib/errors/app-error";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";

/**
 * Standard wrapper for Server Functions:
 *   - validates FormData with a Zod schema (field errors returned to the form),
 *   - converts thrown errors to safe public errors (never leaks internals),
 *   - logs failures with the request id,
 *   - lets Next.js redirect()/notFound() propagate.
 */
export async function runAction<S extends z.ZodType, T>(
  name: string,
  schema: S,
  formData: FormData,
  handler: (input: z.infer<S>) => Promise<T>,
): Promise<ActionResult<T>> {
  const requestId = resolveRequestId((await headers()).get("x-request-id"));
  const log = getLogger().child({ action: name, requestId });

  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return fail(new AppError("VALIDATION", "invalid input", { fieldErrors }), requestId);
  }

  try {
    return ok(await handler(parsed.data));
  } catch (error) {
    unstable_rethrow(error); // redirect(), notFound(), etc.
    if (isAppError(error) && error.status < 500) {
      log.warn("action rejected", { code: error.code, error, context: error.context });
    } else {
      log.error("action failed", { error });
    }
    return fail(error, requestId);
  }
}
