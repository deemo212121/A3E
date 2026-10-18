import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";

import { getPublicEnv } from "@/lib/env/public";

import { hardenSessionCookie } from "./cookies";

/**
 * Supabase client for Server Components, Server Functions and Route Handlers.
 *
 * Acts as the signed-in user (their session cookie), so Row Level Security
 * applies to every query. Create a new client per request; never share one.
 *
 * `connection()` first: per-user data must only load for a real request, never
 * during prerendering (including runtime prefetch). It also keeps Supabase's
 * session-expiry clock reads (Date.now) out of prerendering, which Next.js
 * Cache Components rejects ("unstable value Date.now()").
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  await connection();
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, hardenSessionCookie(options));
            }
          } catch {
            // Server Components cannot set cookies. Session refresh is handled
            // by the proxy (src/proxy.ts), so this is safe to ignore here.
          }
        },
      },
    },
  );
}
