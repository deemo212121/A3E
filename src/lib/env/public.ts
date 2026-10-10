import { assertNoSecretInPublicEnv, parseEnv, publicEnvSchema, type PublicEnv } from "./schema";

let cached: PublicEnv | undefined;

/**
 * Public (browser-safe) environment.
 *
 * Each variable is referenced literally so Next.js can inline it at build time;
 * dynamic `process.env[name]` lookups are NOT inlined into browser bundles.
 */
export function getPublicEnv(): PublicEnv {
  if (cached) return cached;
  const raw = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
  assertNoSecretInPublicEnv(raw);
  cached = parseEnv(publicEnvSchema, raw, "public");
  return cached;
}
