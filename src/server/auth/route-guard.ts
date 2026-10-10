import "server-only";

import { redirect } from "next/navigation";

import {
  evaluateRoute,
  pathFor,
  type AccessFacts,
  type Decision,
  type RouteKey,
  type RouteParams,
} from "@/lib/access/route-policy";
import { getLogger } from "@/lib/logging/server";

import { getCurrentAccess, toFacts, type Access } from "./access";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GuardResult {
  access: Access;
  facts: AccessFacts;
  decision: Decision;
}

/**
 * Server-side route guard. Called by EVERY protected page on EVERY request
 * (direct URL, reload, new tab, client navigation). Uses the same policy as the
 * navigation. Unauthenticated -> /login; disabled -> /account-disabled;
 * staff without MFA -> /mfa. Otherwise returns the decision; the page renders
 * <AccessDenied/> or <NotFoundState/> when not allowed.
 *
 * Layouts are NOT used as a security boundary (they do not re-run on every
 * navigation). Data queries remain protected by RLS regardless.
 */
export async function guardRoute(route: RouteKey, params: RouteParams = {}): Promise<GuardResult> {
  const normalized: RouteParams = params.clientId
    ? { clientId: params.clientId.toLowerCase() }
    : {};
  const access = await getCurrentAccess();
  if (!access) {
    const next =
      UUID_RE.test(normalized.clientId ?? "x") || !normalized.clientId
        ? pathFor(route, normalized)
        : "/app";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!access.is_active) redirect("/account-disabled");
  if (access.mfa_required) redirect("/mfa");

  const facts = toFacts(access);
  const decision: Decision =
    normalized.clientId !== undefined && !UUID_RE.test(normalized.clientId)
      ? { allowed: false, reason: "not_found" }
      : evaluateRoute(route, facts, normalized);

  if (!decision.allowed) {
    getLogger().info("route access denied", {
      userId: access.user_id,
      route,
      reason: decision.reason,
      clientId: normalized.clientId,
    });
  }
  return { access, facts, decision };
}
