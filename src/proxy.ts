import { NextResponse, type NextRequest } from "next/server";

import { PROTECTED_PREFIXES } from "@/lib/access/route-policy";
import { resolveRequestId } from "@/lib/logging/request-id";
import { updateSupabaseSession } from "@/lib/supabase/proxy-session";

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const { response, hasUser } = await updateSupabaseSession(request, requestId);

  // Optimistic check only (fast redirect for direct URLs / new tabs without a
  // session). The authoritative checks are the page guards and RLS.
  let result = response;
  if (!hasUser && isProtected(request.nextUrl.pathname)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    result = NextResponse.redirect(login);
  }

  result.headers.set("x-request-id", requestId);
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}

export const config = {
  // Skip static assets and image optimization; run on pages and API routes.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
