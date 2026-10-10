import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { createClientAction } from "@/features/admin/actions";
import { pathFor } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Clients" };

export default function AdminClientsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AdminClients />
    </Suspense>
  );
}

const STATUS_TONE = { onboarding: "warning", active: "success", archived: "neutral" } as const;

async function AdminClients() {
  const { decision } = await guardRoute("admin.clients");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const clients = await listVisibleClients();

  return (
    <div data-route="admin.clients">
      <PageHeader
        title="Clients"
        breadcrumbs={[{ href: "/admin", label: "Firm administration" }, { label: "Clients" }]}
        description="The firm's client roster. Business records are visible only to assigned staff."
      />
      <Section title="Client roster">
        <DataTable
          caption="Client roster"
          rows={clients}
          rowKey={(c) => c.id}
          empty="No clients yet. Create the first one below."
          columns={[
            {
              header: "Client",
              cell: (c) => (
                <Link href={pathFor("admin.client", { clientId: c.id })} className="underline">
                  {c.display_name}
                </Link>
              ),
            },
            { header: "Code", cell: (c) => c.code },
            {
              header: "Status",
              cell: (c) => (
                <Badge tone={STATUS_TONE[c.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {c.status}
                </Badge>
              ),
            },
          ]}
        />
      </Section>
      <Section title="Create a client business">
        <ActionForm action={createClientAction} submitLabel="Create client">
          <Field
            label="Client code"
            name="code"
            required
            hint="2–30 characters: letters, numbers, hyphen (e.g. ACME-01)."
          />
          <Field label="Business name" name="displayName" required />
        </ActionForm>
      </Section>
    </div>
  );
}
