import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getAdminEnv } from "@/lib/env/server";
import { getPublicEnv } from "@/lib/env/public";

/**
 * PRIVILEGED Supabase client. It BYPASSES Row Level Security.
 *
 * Rules (enforced by ESLint `no-restricted-imports`, see eslint.config.mjs):
 * - Import only from `src/server/**`.
 * - Use only for narrowly scoped administrative tasks (e.g. inviting users,
 *   scheduled jobs) after the caller's authorization has been checked.
 * - Never pass this client, or data it returns unfiltered, to client code.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SECRET_KEY } = getAdminEnv();

  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
