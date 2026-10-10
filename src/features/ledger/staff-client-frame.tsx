import "server-only";

import type { ReactNode } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { PageHeader } from "@/components/ui/primitives";
import { SubNav } from "@/components/ui/sub-nav";
import { staffClientTabs, type RouteKey, type RouteParams } from "@/lib/access/route-policy";
import { guardRoute, type GuardResult } from "@/server/auth/route-guard";
import { getVisibleClient, type ClientRow } from "@/server/data/workspace";

/**
 * Guard + frame for every /staff/clients/[clientId]/* page. The shared policy
 * decides access; the client row is then loaded under RLS, so both layers must
 * agree before anything renders.
 */
export async function renderStaffClientPage(
  route: RouteKey,
  params: RouteParams & { clientId: string },
  title: string,
  body: (
    ctx: GuardResult & { client: ClientRow; clientId: string },
  ) => Promise<ReactNode> | ReactNode,
): Promise<ReactNode> {
  const guard = await guardRoute(route, params);
  if (!guard.decision.allowed) return <DeniedState reason={guard.decision.reason} />;
  const clientId = params.clientId.toLowerCase();
  const client = await getVisibleClient(clientId);
  if (!client) return <DeniedState reason="not_found" />;
  return (
    <div data-route={route}>
      <PageHeader
        title={title}
        breadcrumbs={[{ href: "/staff", label: "My clients" }, { label: client.display_name }]}
        description={`${client.display_name} (${client.code})`}
      />
      <SubNav label="Client workspace sections" items={staffClientTabs(guard.facts, clientId)} />
      {await body({ ...guard, client, clientId })}
    </div>
  );
}
