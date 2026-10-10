import { z } from "zod";

/**
 * Environment variable schemas.
 *
 * This module is pure (no `server-only`, no `process.env` access) so it can be
 * unit-tested and shared by the server and browser env loaders.
 */

export const APP_ENVS = ["development", "test", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Values safe to expose to the browser (inlined at build time by Next.js). */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ message: "must be a valid URL" }),
  // Supabase publishable key (sb_publishable_...) or legacy anon key.
  // Protected by Row Level Security; never a privileged key.
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "is required"),
});
export type PublicEnv = z.infer<typeof publicEnvSchema>;

/** Server-only values. Never prefix these with NEXT_PUBLIC_. */
export const serverEnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).default("development"),
  // Public base URL of this app; used to build auth email redirect links.
  APP_BASE_URL: z.url({ message: "must be a valid URL" }).default("http://localhost:3000"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Privileged Supabase key. Validated only where the admin client is created,
 * so the app can run without it in environments that do not need it.
 */
export const adminEnvSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1, "is required"),
});
export type AdminEnv = z.infer<typeof adminEnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(scope: string, issues: string[]) {
    super(`Invalid ${scope} environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Parses `input` with `schema`. On failure, throws an error that names the
 * offending variables but never includes their values.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  input: Record<string, string | undefined>,
  scope: string,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`,
    );
    throw new EnvValidationError(scope, issues);
  }
  return result.data;
}

/** Guards against privileged keys being exposed through public variables. */
export function assertNoSecretInPublicEnv(input: Record<string, string | undefined>): void {
  const offenders = Object.entries(input)
    .filter(([name]) => name.startsWith("NEXT_PUBLIC_"))
    .filter(
      ([name, value]) =>
        /SECRET|SERVICE_ROLE|PASSWORD/i.test(name) ||
        (typeof value === "string" && value.startsWith("sb_secret_")),
    )
    .map(([name]) => name);

  if (offenders.length > 0) {
    throw new EnvValidationError("public", [
      ...offenders.map((name) => `${name} looks like a privileged secret and must not be public`),
    ]);
  }
}
