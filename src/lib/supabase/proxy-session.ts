import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicEnv } from "@/lib/env/public";
import { EnvValidationError } from "@/lib/env/schema";
import { createLogger } from "@/lib/logging/logger";

const log = createLogger({ bindings: { service: "a3e-web", component: "proxy" } });
let warnedMissingEnv = false;

/**
 * Refreshes the Supabase auth session cookie on each matched request.
 *
 * This only keeps sessions fresh. It is NOT an authorization check; access
 * control is enforced server-side and by Row Level Security.
 */
export async function updateSupabaseSession(
  request: NextRequest,
  requestId: string,
): Promise<{ response: NextResponse; hasUser: boolean }> {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  let env;
  try {
    env = getPublicEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Unconfigured environment (e.g. fresh checkout): serve pages without a
      // session rather than failing every request. No access is granted.
      if (!warnedMissingEnv) {
        log.warn("Supabase env not configured; skipping session refresh", { issues: error.issues });
        warnedMissingEnv = true;
      }
      return { response, hasUser: false };
    }
    throw error;
  }

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          // Cache headers supplied by @supabase/ssr so CDNs never cache a
          // response carrying one user's session cookie.
          for (const [key, value] of Object.entries(headers ?? {})) {
            response.headers.set(key, value);
          }
        },
      },
    },
  );

  // Must run before the response is returned so refreshed tokens are written.
  const { data } = await supabase.auth.getClaims();

  return { response, hasUser: Boolean(data?.claims?.sub) };
}
