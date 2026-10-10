import "server-only";

import { randomUUID } from "node:crypto";

import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, MoreActions, Section } from "@/components/ui/primitives";
import {
  approveCounterpartiesAction,
  saveCounterpartyAction,
  transitionCounterpartyAction,
} from "@/features/intake/actions";
import { StatusBadge } from "@/features/intake/components/intake-ui";
import { COUNTERPARTY_KINDS, labelOf, VAT_STATUSES } from "@/lib/intake/rules";
import type { Access } from "@/server/auth/access";
import { listCounterparties, type CounterpartyRow } from "@/server/data/intake";
import { canWriteIntake, isStaffOn } from "@/server/intake/access";

function CounterpartyFields({ c }: { c?: CounterpartyRow }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Select
        label="This is a"
        name="kind"
        options={COUNTERPARTY_KINDS}
        defaultValue={c?.kind ?? "supplier"}
      />
      <Field
        label="Registered name"
        name="registeredName"
        required
        defaultValue={c?.registered_name}
        maxLength={200}
      />
      <Field
        label="TIN"
        name="tin"
        defaultValue={c?.tin ?? ""}
        placeholder="000-000-000-00000"
        inputMode="numeric"
      />
      <Select
        label="VAT registration (as you know it)"
        name="vatStatus"
        options={VAT_STATUSES}
        defaultValue={c?.vat_status ?? "unknown"}
      />
      <div className="sm:col-span-2">
        <TextArea
          label="Address"
          name="address"
          rows={2}
          maxLength={500}
          defaultValue={c?.address ?? ""}
        />
      </div>
      <Field label="Email" name="email" type="email" defaultValue={c?.email ?? ""} />
      <Field label="Phone" name="phone" type="tel" defaultValue={c?.phone ?? ""} />
    </div>
  );
}

/** Customers and suppliers: list, add, edit, submit; staff approve. */
export async function CounterpartiesView({
  access,
  clientId,
}: {
  access: Access;
  clientId: string;
}) {
  const staff = isStaffOn(access, clientId);
  const writer = canWriteIntake(access, clientId);
  const rows = await listCounterparties(clientId);
  const submitted = rows.filter((r) => r.status === "submitted");
  const hidden = (c: CounterpartyRow, to: string) => (
    <>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="id" value={c.id} />
      <input type="hidden" name="to" value={to} />
    </>
  );

  return (
    <>
      {staff && submitted.length > 0 ? (
        <Section title={`Waiting for approval (${submitted.length})`}>
          <ActionForm
            action={approveCounterpartiesAction}
            submitLabel={`Approve all ${submitted.length}`}
            variant="primary"
            confirmMessage={`Approve ${submitted.length} customers/suppliers?`}
          >
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="ids" value={JSON.stringify(submitted.map((s) => s.id))} />
            <p className="text-sm text-[var(--muted)]">
              Check the list below first. Each approval is recorded in the history.
            </p>
          </ActionForm>
        </Section>
      ) : null}

      <Section title="Customers and suppliers">
        <DataTable
          caption="Customers and suppliers"
          rows={rows}
          rowKey={(r) => r.id}
          empty="None yet. Add the customers and suppliers you deal with, or import a list."
          columns={[
            {
              header: "Name",
              cell: (r) => (
                <span className="flex flex-col">
                  <span className="font-medium">{r.registered_name}</span>
                  {r.address ? (
                    <span className="text-xs text-[var(--muted)]">{r.address}</span>
                  ) : null}
                </span>
              ),
            },
            { header: "Type", cell: (r) => labelOf(COUNTERPARTY_KINDS, r.kind) },
            { header: "TIN", kind: "nowrap", cell: (r) => r.tin ?? "" },
            { header: "VAT", hideOnMobile: true, cell: (r) => labelOf(VAT_STATUSES, r.vat_status) },
            { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            {
              header: "Actions",
              srOnlyHeader: true,
              cell: (r) => {
                const editable =
                  writer &&
                  (["draft", "needs_correction"].includes(r.status) ||
                    (staff && r.status === "approved"));
                const forStaff = staff && r.status === "submitted";
                const canSubmit = writer && ["draft", "needs_correction"].includes(r.status);
                if (!editable && !forStaff && !canSubmit) return null;
                return (
                  <MoreActions label={`Actions for ${r.registered_name}`}>
                    {canSubmit ? (
                      <ActionForm
                        action={transitionCounterpartyAction}
                        submitLabel="Submit for approval"
                        variant="primary"
                      >
                        {hidden(r, "submitted")}
                      </ActionForm>
                    ) : null}
                    {forStaff ? (
                      <>
                        <ActionForm
                          action={transitionCounterpartyAction}
                          submitLabel="Approve"
                          variant="primary"
                        >
                          {hidden(r, "approved")}
                        </ActionForm>
                        <ActionForm
                          action={transitionCounterpartyAction}
                          submitLabel="Return for correction"
                        >
                          {hidden(r, "needs_correction")}
                          <TextArea
                            label="What needs to change?"
                            name="comment"
                            rows={2}
                            required
                          />
                        </ActionForm>
                        <ActionForm
                          action={transitionCounterpartyAction}
                          submitLabel="Reject"
                          variant="danger"
                        >
                          {hidden(r, "rejected")}
                          <TextArea label="Reason" name="comment" rows={2} required />
                        </ActionForm>
                      </>
                    ) : null}
                    {editable ? (
                      <ActionForm
                        action={saveCounterpartyAction}
                        submitLabel="Save changes"
                        variant="secondary"
                      >
                        <input type="hidden" name="clientId" value={clientId} />
                        <input type="hidden" name="counterpartyId" value={r.id} />
                        <input type="hidden" name="expectedVersion" value={r.row_version} />
                        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                        <input type="hidden" name="intent" value="save" />
                        <CounterpartyFields c={r} />
                      </ActionForm>
                    ) : null}
                  </MoreActions>
                );
              },
            },
          ]}
        />
      </Section>

      {writer ? (
        <Section title="Add a customer or supplier">
          {!staff ? (
            <div className="mb-3">
              <Alert tone="info">New entries are submitted to your accountant for approval.</Alert>
            </div>
          ) : null}
          <ActionForm
            action={saveCounterpartyAction}
            submitLabel="Add"
            buttons={
              staff
                ? [
                    {
                      label: "Save and approve",
                      name: "intent",
                      value: "approve",
                      variant: "primary",
                    },
                    { label: "Save as draft", name: "intent", value: "save" },
                  ]
                : [
                    {
                      label: "Add and submit",
                      name: "intent",
                      value: "submit",
                      variant: "primary",
                    },
                    { label: "Save as draft", name: "intent", value: "save" },
                  ]
            }
          >
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <CounterpartyFields />
          </ActionForm>
        </Section>
      ) : null}
    </>
  );
}
