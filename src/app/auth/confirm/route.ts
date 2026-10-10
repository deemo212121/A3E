import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { safeNextPath } from "@/features/auth/schemas";
import { getLogger } from "@/lib/logging/server";
import { resolveRequestId } from "@/lib/logging/request-id";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const ALLOWED_TYPES: readonly EmailOtpType[] = ["invite", "recovery", "email", "email_change"];

/**
 * Landing point for Supabase Auth email links (invitation, password recovery).
 * Supports the token_hash link format (configured in the Supabase email
 * templates) and the PKCE `code` format. Redirects only to same-site paths.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");
  let next = safeNextPath(url.searchParams.get("next"));

  const supabase = await createSupabaseServerClient();
  let ok = false;

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    ok = !error;
    if (ok && (type === "invite" || type === "recovery")) next = "/auth/set-password";
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }

  if (!ok) {
    getLogger().warn("auth link verification failed", { requestId, type });
    return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
