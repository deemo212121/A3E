import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { opsFirmAction } from "@/features/operations/actions";
import { EXCEPTION_KINDS, OpsBadge, who } from "@/features/operations/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { listExceptions, staffNames, type ExceptionRow } from "@/server/data/operations";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Exception requests" };

export default function ExceptionsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Exceptions />
    </Suspense>
  );
}

function target(e: ExceptionRow) {
  if (e.kind === "reopen_locked_period")
    return `period → ${(e.target_status ?? "").replace("_", " ")}`;
  if (e.kind === "change_due_date") return `new due date ${e.new_due_on}`;
  return "";
}

async function Exceptions() {
  const { access, decision } = await guardRoute("review.exceptions");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [rows, names, clients] = await Promise.all([
    listExceptions({}),
    staffNames(),
    listVisibleClients(),
  ]);
  const me = access.user_id;
  const manager = hasFirmRole(access, ["firm_manager"]);
  const code = new Map(clients.map((c) => [c.id, c.code]));
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  const base = [
    {
      header: "Client",
      cell: (e: ExceptionRow) => (
        <Link className="underline" href={pathFor("staff.operations", { clientId: e.client_id })}>
          {code.get(e.client_id) ?? "—"}
        </Link>
      ),
    },
    {
      header: "Request",
      cell: (e: ExceptionRow) => `${EXCEPTION_KINDS[e.kind] ?? e.kind} ${target(e)}`,
    },
    { header: "Reason", cell: (e: ExceptionRow) => e.reason },
    {
      header: "Requested by",
      cell: (e: ExceptionRow) => `${who(names, e.requested_by)} · ${e.requested_at.slice(0, 10)}`,
    },
  ];

  return (
    <div data-route="review.exceptions">
      <PageHeader
        title="Exception requests"
        description="Actions outside the normal workflow: reopening locked periods, due-date changes, withdrawn filing confirmations."
      />
      <Alert tone="info">
        A firm manager other than the requester decides. An approval is carried out immediately and
        recorded with both names; it cannot be replayed.
      </Alert>
      <Section title="Waiting for a decision">
        <DataTable
          caption="Pending exception requests"
          rows={pending}
          rowKey={(e) => e.id}
          empty="Nothing waiting."
          columns={[
            ...base,
            {
              header: "Decision",
              cell: (e: ExceptionRow) =>
                manager && e.requested_by !== me ? (
                  <ActionForm
                    action={opsFirmAction}
                    submitLabel=""
                    className="flex flex-col gap-2"
                    buttons={[
                      { label: "Approve", name: "decision", value: "approve", variant: "primary" },
                      { label: "Reject", name: "decision", value: "reject", variant: "danger" },
                    ]}
                  >
                    <input type="hidden" name="op" value="decide_exception" />
                    <input type="hidden" name="id" value={e.id} />
                    <Field label="Reason for the decision" name="note" required maxLength={1000} />
                  </ActionForm>
                ) : e.requested_by === me ? (
                  <ActionForm
                    action={opsFirmAction}
                    submitLabel="Withdraw my request"
                    variant="secondary"
                  >
                    <input type="hidden" name="op" value="cancel_exception" />
                    <input type="hidden" name="id" value={e.id} />
                  </ActionForm>
                ) : (
                  "A firm manager decides"
                ),
            },
          ]}
        />
      </Section>
      <Section title="Decided">
        <DataTable
          caption="Decided exception requests"
          rows={decided}
          rowKey={(e) => e.id}
          empty="None yet."
          columns={[
            ...base,
            { header: "Status", cell: (e: ExceptionRow) => <OpsBadge status={e.status} /> },
            {
              header: "Decided by",
              cell: (e: ExceptionRow) =>
                e.decided_by ? `${who(names, e.decided_by)} · ${e.decision_note ?? ""}` : "—",
            },
          ]}
        />
      </Section>
    </div>
  );
}
