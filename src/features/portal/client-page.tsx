import "server-only";

import type { ReactNode } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { Badge, PageHeader } from "@/components/ui/primitives";
import { SubNav } from "@/components/ui/sub-nav";
import { roleLabel } from "@/lib/access/labels";
import { clientPortalTabs, type RouteKey } from "@/lib/access/route-policy";
import { guardRoute, type GuardResult } from "@/server/auth/route-guard";
import { getVisibleClient, type ClientRow } from "@/server/data/workspace";

/**
 * Guard + common frame for every /portal/[clientId]/* page. The membership
 * check uses the shared policy; the client row itself is loaded under RLS, so
 * both layers must agree before anything renders.
 */
export async function renderClientPortalPage(
  route: RouteKey,
  clientIdParam: string,
  title: string,
  body: (
    ctx: GuardResult & { client: ClientRow; clientId: string },
  ) => Promise<ReactNode> | ReactNode,
): Promise<ReactNode> {
  const guard = await guardRoute(route, { clientId: clientIdParam });
  if (!guard.decision.allowed) return <DeniedState reason={guard.decision.reason} />;
  const clientId = clientIdParam.toLowerCase();
  const client = await getVisibleClient(clientId);
  if (!client) return <DeniedState reason="not_found" />;

  const role = guard.access.client_memberships.find((m) => m.client_id === clientId)?.role;
  return (
    <div data-route={route}>
      <PageHeader
        title={title}
        breadcrumbs={[{ href: "/portal", label: "My businesses" }, { label: client.display_name }]}
        description={
          <>
            {client.display_name} ({client.code}) · your role:{" "}
            <Badge tone="info">{roleLabel(role)}</Badge>
          </>
        }
      />
      <SubNav label="Business sections" items={clientPortalTabs(guard.facts, clientId)} />
      {await body({ ...guard, client, clientId })}
    </div>
  );
}
