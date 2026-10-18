import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { opsFirmAction } from "@/features/operations/actions";
import { matchRoute, pathFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";
import { listNotifications } from "@/server/data/operations";
import { listMyInvitations } from "@/server/data/workspace";
import { DeniedState } from "@/components/ui/access-states";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Notifications />
    </Suspense>
  );
}

async function Notifications() {
  const { decision } = await guardRoute("notifications");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [rows, invitations] = await Promise.all([listNotifications(), listMyInvitations()]);
  const unread = rows.filter((r) => !r.read_at).length;

  return (
    <div data-route="notifications">
      <PageHeader
        title="Notifications"
        description="Assignments, reviews, requests and reminders. Details stay inside the app."
      />
      {invitations.length > 0 ? (
        <Section title="Invitations">
          <p className="text-sm">
            You have {invitations.length} pending invitation{invitations.length === 1 ? "" : "s"}.{" "}
            <Link className="underline" href={pathFor("invitations")}>
              Open invitations
            </Link>
          </p>
        </Section>
      ) : null}
      <Section
        title={`Inbox${unread ? ` (${unread} unread)` : ""}`}
        actions={
          unread ? (
            <ActionForm
              action={opsFirmAction}
              submitLabel="Mark all read"
              variant="secondary"
              className="flex"
            >
              <input type="hidden" name="op" value="mark_all_read" />
            </ActionForm>
          ) : null
        }
      >
        <DataTable
          caption="Notifications"
          rows={rows}
          rowKey={(n) => n.id}
          empty="No notifications."
          columns={[
            {
              header: "When",
              kind: "nowrap",
              cell: (n) => n.created_at.slice(0, 16).replace("T", " "),
            },
            {
              header: "Notification",
              cell: (n) => (
                <span className="flex flex-col">
                  <span className={n.read_at ? "" : "font-semibold"}>
                    {/* Only links that map to a known route are rendered. */}
                    {n.link && matchRoute(n.link) ? (
                      <Link className="underline" href={n.link}>
                        {n.title}
                      </Link>
                    ) : (
                      n.title
                    )}
                  </span>
                  {n.body ? <span className="text-xs text-[var(--muted)]">{n.body}</span> : null}
                </span>
              ),
            },
            {
              header: "",
              srOnlyHeader: true,
              cell: (n) => (n.read_at ? null : <Badge tone="info">new</Badge>),
            },
            {
              header: "Actions",
              srOnlyHeader: true,
              cell: (n) =>
                n.read_at ? null : (
                  <ActionForm
                    action={opsFirmAction}
                    submitLabel="Mark read"
                    variant="secondary"
                    className="flex"
                    toastOnSuccess={false}
                  >
                    <input type="hidden" name="op" value="mark_read" />
                    <input type="hidden" name="id" value={n.id} />
                  </ActionForm>
                ),
            },
          ]}
        />
      </Section>
    </div>
  );
}
