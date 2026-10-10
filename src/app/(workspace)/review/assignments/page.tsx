import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { setAssignmentAction } from "@/features/admin/actions";
import { roleLabel } from "@/lib/access/labels";
import { guardRoute } from "@/server/auth/route-guard";
import { listAssignableStaff, listAssignments, listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Staff assignments" };

export default function AssignmentsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Assignments />
    </Suspense>
  );
}

async function Assignments() {
  const { decision } = await guardRoute("review.assignments");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [clients, assignments, staff] = await Promise.all([
    listVisibleClients(),
    listAssignments(),
    listAssignableStaff(),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.display_name]));

  return (
    <div data-route="review.assignments">
      <PageHeader
        title="Staff assignments"
        description="Which firm staff may work on which client. Staff see only assigned clients."
      />
      <Section title="Current assignments">
        <DataTable
          caption="Current staff assignments"
          rows={assignments}
          rowKey={(a) => `${a.client_id}-${a.user_id}-${a.assignment_role}`}
          empty="No assignments yet."
          columns={[
            { header: "Client", cell: (a) => clientName.get(a.client_id) ?? a.client_id },
            { header: "Staff member", cell: (a) => a.name || a.email },
            { header: "As", cell: (a) => roleLabel(a.assignment_role) },
            {
              header: "Actions",
              srOnlyHeader: true,
              cell: (a) => (
                <ActionForm
                  action={setAssignmentAction}
                  submitLabel="Unassign"
                  variant="danger"
                  className="flex gap-2"
                >
                  <input type="hidden" name="clientId" value={a.client_id} />
                  <input type="hidden" name="userId" value={a.user_id} />
                  <input type="hidden" name="assignmentRole" value={a.assignment_role} />
                  <input type="hidden" name="op" value="unassign" />
                </ActionForm>
              ),
            },
          ]}
        />
      </Section>
      {clients.length > 0 && staff.length > 0 ? (
        <Section title="Assign staff to a client">
          <ActionForm action={setAssignmentAction} submitLabel="Assign">
            <input type="hidden" name="op" value="assign" />
            <Select
              label="Client"
              name="clientId"
              options={clients.map((c) => ({
                value: c.id,
                label: `${c.display_name} (${c.code})`,
              }))}
            />
            <Select
              label="Staff member"
              name="userId"
              options={staff.map((s) => ({ value: s.user_id, label: s.label }))}
            />
            <Select
              label="As"
              name="assignmentRole"
              options={[
                { value: "preparer", label: "Preparer" },
                { value: "reviewer", label: "Reviewer" },
              ]}
            />
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
