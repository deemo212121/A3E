import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell, ShellSkeleton } from "@/components/shell/app-shell";
import { PageSkeleton } from "@/components/ui/primitives";
import { buildNavigation } from "@/lib/access/route-policy";
import { roleLabel } from "@/lib/access/labels";
import { getCurrentAccess, toFacts } from "@/server/auth/access";
import { countUnreadNotifications } from "@/server/data/operations";
import { listMyInvitations } from "@/server/data/workspace";

/**
 * Shell for all signed-in areas. The navigation comes from the same policy the
 * page guards use. NOTE: this layout is NOT the security boundary — every page
 * runs guardRoute() itself on every request, and RLS protects the data.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <ShellSkeleton>
          <PageSkeleton />
        </ShellSkeleton>
      }
    >
      <Shell>{children}</Shell>
    </Suspense>
  );
}

async function Shell({ children }: { children: React.ReactNode }) {
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  if (!access.is_active) redirect("/account-disabled");
  if (access.mfa_required) redirect("/mfa");

  const [invitations, unread] = await Promise.all([
    listMyInvitations(),
    countUnreadNotifications().catch(() => 0),
  ]);
  const facts = toFacts(access);
  const roleText = access.firm_role
    ? roleLabel(access.firm_role)
    : access.client_memberships.length > 0
      ? "Client portal user"
      : null;

  return (
    <AppShell
      sections={buildNavigation(facts)}
      user={{ name: access.full_name, email: access.email, roleLabel: roleText }}
      notificationCount={invitations.length + unread}
    >
      {children}
    </AppShell>
  );
}
