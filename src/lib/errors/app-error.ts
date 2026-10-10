/**
 * Application error model.
 *
 * Every error that crosses a server boundary (server action, route handler) is
 * converted to a `PublicError` so internal details, SQL messages and stack
 * traces never reach the browser.
 */

export const ERROR_CODES = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const DEFAULT_PUBLIC_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION: "Some of the information provided is invalid.",
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested item was not found.",
  CONFLICT: "This action conflicts with the current state of the record.",
  RATE_LIMITED: "Too many requests. Please try again shortly.",
  INTERNAL: "Something went wrong. Please try again or contact support.",
  UNAVAILABLE: "The service is temporarily unavailable.",
};

export interface AppErrorOptions {
  /** Message safe to show to users. Defaults to a generic message per code. */
  publicMessage?: string;
  /** Field-level validation messages, safe to show to users. */
  fieldErrors?: Record<string, string[]>;
  /** Internal context for logs only. Never sent to the client. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly fieldErrors?: Record<string, string[]>;
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.publicMessage = options.publicMessage ?? DEFAULT_PUBLIC_MESSAGES[code];
    this.fieldErrors = options.fieldErrors;
    this.context = options.context;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Shape returned to the browser. */
export interface PublicError {
  code: ErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
  /** Correlates a user report with server logs. */
  requestId?: string;
}

/** Converts any thrown value into a safe public error. Unknown errors become INTERNAL. */
export function toPublicError(error: unknown, requestId?: string): PublicError {
  if (isAppError(error)) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
  return {
    code: "INTERNAL",
    message: DEFAULT_PUBLIC_MESSAGES.INTERNAL,
    ...(requestId ? { requestId } : {}),
  };
}

/** Result type for server actions: never throw across the client boundary. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: PublicError };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(error: unknown, requestId?: string): ActionResult<never> {
  return { ok: false, error: toPublicError(error, requestId) };
}
