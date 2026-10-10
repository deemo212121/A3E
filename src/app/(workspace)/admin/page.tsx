import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { LinkButton, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { evaluateRoute, pathFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";
import {
  listPendingInvitations,
  listUsersWithFirmRoles,
  listVisibleClients,
} from "@/server/data/workspace";

export const metadata: Metadata = { title: "Firm administration" };

export default function AdminHomePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AdminHome />
    </Suspense>
  );
}

async function AdminHome() {
  const { facts, decision } = await guardRoute("admin");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const canUsers = evaluateRoute("admin.users", facts).allowed;
  const [clients, invitations, users] = await Promise.all([
    listVisibleClients(),
    listPendingInvitations(),
    canUsers ? listUsersWithFirmRoles() : Promise.resolve([]),
  ]);

  const stats = [
    { label: "Client businesses", value: clients.length, href: pathFor("admin.clients") },
    { label: "Pending invitations", value: invitations.length, href: pathFor("admin.invitations") },
    ...(canUsers
      ? [{ label: "User accounts", value: users.length, href: pathFor("admin.users") }]
      : []),
    ...(canUsers
      ? [
          {
            label: "Disabled accounts",
            value: users.filter((u) => !u.is_active).length,
            href: pathFor("admin.users"),
          },
        ]
      : []),
  ];

  return (
    <div data-route="admin">
      <PageHeader
        title="Firm administration"
        description="Manage the client roster, invitations and user accounts."
      />
      <Section title="Overview">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <li key={s.label} className="rounded-md border border-[var(--border)] p-4">
              <p className="text-sm text-[var(--muted)]">{s.label}</p>
              <p className="text-2xl font-semibold">{s.value}</p>
              <div className="mt-2">
                <LinkButton href={s.href}>View</LinkButton>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
