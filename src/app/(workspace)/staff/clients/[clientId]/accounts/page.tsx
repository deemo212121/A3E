import type { Metadata } from "next";
import { Suspense } from "react";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageSkeleton, Section } from "@/components/ui/primitives";
import {
  applyTemplateAction,
  createAccountAction,
  setAccountActiveAction,
} from "@/features/ledger/actions";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { hasFirmRole } from "@/server/auth/access";
import { listAccounts } from "@/server/data/ledger";

export const metadata: Metadata = { title: "Chart of accounts" };

export default function AccountsPage({ params }: PageProps<"/staff/clients/[clientId]/accounts">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Accounts params={params} />
    </Suspense>
  );
}

async function Accounts({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage(
    "staff.accounts",
    { clientId },
    "Chart of accounts",
    async ({ access, client }) => {
      const accounts = await listAccounts(client.id);
      const canMaintain = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
      const hidden = <input type="hidden" name="clientId" value={client.id} />;

      return (
        <>
          {accounts.length === 0 ? (
            <Section title="Start from a template">
              <Alert tone="warning" title="Template status: PROPOSED">
                The starter chart is a generic proposal pending the firm accountant&apos;s approval.
                It is not a BIR-prescribed chart. Accounts can be added or deactivated afterwards.
              </Alert>
              {canMaintain ? (
                <div className="mt-3">
                  <ActionForm action={applyTemplateAction} submitLabel="Create chart from template">
                    {hidden}
                    <input type="hidden" name="template" value="PH-SME-V0" />
                  </ActionForm>
                </div>
              ) : null}
            </Section>
          ) : null}
          <Section title="Accounts">
            <DataTable
              caption="Chart of accounts"
              rows={accounts}
              rowKey={(a) => a.id}
              empty="No accounts yet."
              columns={[
                { header: "Code", cell: (a) => a.code },
                {
                  header: "Name",
                  cell: (a) => (a.is_postable ? a.name : <strong>{a.name}</strong>),
                },
                { header: "Type", cell: (a) => a.account_type },
                { header: "Normal balance", cell: (a) => a.normal_balance },
                {
                  header: "Status",
                  cell: (a) => (
                    <>
                      {a.is_postable ? null : <Badge>header</Badge>}{" "}
                      {a.is_active ? (
                        <Badge tone="success">active</Badge>
                      ) : (
                        <Badge tone="danger">inactive</Badge>
                      )}
                    </>
                  ),
                },
                ...(canMaintain
                  ? [
                      {
                        header: "Actions",
                        srOnlyHeader: true,
                        cell: (a: (typeof accounts)[number]) => (
                          <ActionForm
                            action={setAccountActiveAction}
                            submitLabel={a.is_active ? "Deactivate" : "Activate"}
                            variant="secondary"
                            className="flex gap-2"
                          >
                            {hidden}
                            <input type="hidden" name="accountId" value={a.id} />
                            <input
                              type="hidden"
                              name="active"
                              value={a.is_active ? "false" : "true"}
                            />
                          </ActionForm>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Section>
          {canMaintain && accounts.length > 0 ? (
            <Section title="Add an account">
              <ActionForm action={createAccountAction} submitLabel="Add account">
                {hidden}
                <Field label="Code" name="code" required />
                <Field label="Name" name="name" required />
                <Select
                  label="Type"
                  name="accountType"
                  options={["asset", "liability", "equity", "revenue", "expense"].map((t) => ({
                    value: t,
                    label: t,
                  }))}
                />
                <Select
                  label="Normal balance"
                  name="normalBalance"
                  options={[
                    { value: "debit", label: "Debit" },
                    { value: "credit", label: "Credit" },
                  ]}
                />
                <Field label="Parent account code (optional)" name="parentCode" />
                <Select
                  label="Postable"
                  name="isPostable"
                  options={[
                    { value: "true", label: "Yes (accepts postings)" },
                    { value: "false", label: "No (header/group account)" },
                  ]}
                />
              </ActionForm>
            </Section>
          ) : null}
        </>
      );
    },
  );
}
