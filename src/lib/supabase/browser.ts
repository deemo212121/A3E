import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";

let browserClient: SupabaseClient | undefined;

/**
 * Supabase client for Client Components.
 *
 * Uses only the public URL and publishable key; all data access is governed by
 * Row Level Security. Never import the admin client or server env here.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const env = getPublicEnv();
    browserClient = createBrowserClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
  }
  return browserClient;
}
