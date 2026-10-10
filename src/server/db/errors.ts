import "server-only";

import { AppError, type ErrorCode } from "@/lib/errors/app-error";

interface DbErrorLike {
  code?: string;
  message?: string;
}

const CODE_MAP: Record<string, ErrorCode> = {
  "42501": "FORBIDDEN", // insufficient_privilege (RLS / grants / our checks)
  P0002: "NOT_FOUND",
  "23505": "CONFLICT",
  "22023": "VALIDATION",
  "23514": "VALIDATION", // check_violation
  "22P02": "VALIDATION", // invalid_text_representation (e.g. bad uuid)
  "23503": "VALIDATION", // foreign key violation
  PGRST116: "NOT_FOUND", // PostgREST: no rows for .single()
};

/** Messages raised by our own SQL functions are written to be user-safe. */
function isOwnFunctionMessage(message: string): boolean {
  return !/row-level security|permission denied|duplicate key|violates|syntax|relation|column/i.test(
    message,
  );
}

/** Converts a Supabase/Postgres error into an AppError with a safe public message. */
export function fromDbError(error: DbErrorLike, operation: string): AppError {
  const code = CODE_MAP[error.code ?? ""] ?? "INTERNAL";
  const message = error.message ?? "database error";
  const publicMessage =
    code !== "INTERNAL" && ["FORBIDDEN", "NOT_FOUND", "CONFLICT", "VALIDATION"].includes(code)
      ? isOwnFunctionMessage(message)
        ? capitalize(message)
        : undefined
      : undefined;
  return new AppError(code, `${operation}: ${message}`, {
    publicMessage,
    context: { operation, dbCode: error.code },
  });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith(".") ? "" : ".");
}
