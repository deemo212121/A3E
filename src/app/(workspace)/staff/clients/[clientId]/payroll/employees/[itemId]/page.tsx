import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { employeeAction } from "@/features/payroll/actions";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount } from "@/lib/money/amount";
import { getEmployee } from "@/server/data/payroll";

export const metadata: Metadata = { title: "Employee" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function EmployeePage({
  params,
}: PageProps<"/staff/clients/[clientId]/payroll/employees/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Employee params={params} />
    </Suspense>
  );
}

async function Employee({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.payroll_employee",
    { clientId },
    "Employee",
    async ({ client }) => {
      const e = UUID.test(itemId) ? await getEmployee(client.id, itemId.toLowerCase()) : null;
      if (!e) return <NotFoundState />;
      const hidden = (op: string) => (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="op" value={op} />
          <input type="hidden" name="id" value={e.id} />
        </>
      );
      return (
        <>
          <div className="mb-4">
            <LinkButton href={`${pathFor("staff.payroll", { clientId: client.id })}?tab=employees`}>
              ← Employees
            </LinkButton>
          </div>
          <Section title={`${e.employee_no} · ${e.last_name}, ${e.first_name}`}>
            {e.termination_date ? (
              <div className="mb-3">
                <Alert tone="info" title={`Separated on ${e.termination_date}`}>
                  {e.termination_reason}. Not added to payrolls after this date.
                </Alert>
              </div>
            ) : null}
            <ActionForm action={employeeAction} submitLabel="Save details">
              {hidden("save")}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field
                  label="Employee no."
                  name="employeeNo"
                  defaultValue={e.employee_no}
                  maxLength={20}
                />
                <Field
                  label="Last name"
                  name="lastName"
                  defaultValue={e.last_name}
                  maxLength={100}
                />
                <Field
                  label="First name"
                  name="firstName"
                  defaultValue={e.first_name}
                  maxLength={100}
                />
                <Field
                  label="Middle name"
                  name="middleName"
                  defaultValue={e.middle_name ?? ""}
                  maxLength={100}
                />
                <Field
                  label="Position"
                  name="position"
                  defaultValue={e.position ?? ""}
                  maxLength={100}
                />
                <Field label="Hire date" name="hireDate" type="date" defaultValue={e.hire_date} />
                <Field label="TIN" name="tin" defaultValue={e.tin ?? ""} maxLength={20} />
                <Field label="SSS no." name="sssNo" defaultValue={e.sss_no ?? ""} maxLength={20} />
                <Field
                  label="PhilHealth no."
                  name="philhealthNo"
                  defaultValue={e.philhealth_no ?? ""}
                  maxLength={20}
                />
                <Field
                  label="Pag-IBIG no."
                  name="pagibigNo"
                  defaultValue={e.pagibig_no ?? ""}
                  maxLength={20}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="withholdingExempt"
                  defaultChecked={e.withholding_exempt}
                />
                Exempt from withholding tax on compensation (accountant&apos;s decision)
              </label>
              <TextArea
                label="Reason for the exemption (required if exempt)"
                name="exemptReason"
                rows={2}
                defaultValue={e.exempt_reason ?? ""}
              />
            </ActionForm>
          </Section>
          <Section title="Pay rates (effective-dated)">
            <DataTable
              caption="Pay rates"
              rows={e.rates}
              rowKey={(r) => r.id}
              empty="No pay rate yet: payroll cannot price days or hours."
              columns={[
                { header: "From", kind: "nowrap", cell: (r) => r.effective_from },
                { header: "Basis", cell: (r) => r.pay_basis },
                { header: "Basic rate", kind: "num", cell: (r) => formatAmount(r.basic_rate) },
                { header: "Daily rate", kind: "num", cell: (r) => formatAmount(r.daily_rate) },
                { header: "Hourly rate", kind: "num", cell: (r) => formatAmount(r.hourly_rate) },
              ]}
            />
            <p className="mt-2 text-xs text-[var(--muted)]">
              A payroll uses the rate in effect on its period end. Daily and hourly rates follow the
              client&apos;s policy (divisors are not assumed); they price days and hours entered on
              payslips.
            </p>
            <div className="mt-3">
              <ActionForm action={employeeAction} submitLabel="Add rate">
                {hidden("rate")}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
                  <Field label="Effective from" name="effectiveFrom" type="date" />
                  <Select
                    label="Basis"
                    name="payBasis"
                    options={[
                      { value: "monthly", label: "Monthly salary" },
                      { value: "daily", label: "Daily rate" },
                    ]}
                  />
                  <Field label="Basic rate" name="basicRate" />
                  <Field label="Daily rate" name="dailyRate" />
                  <Field label="Hourly rate" name="hourlyRate" />
                </div>
              </ActionForm>
            </div>
          </Section>
          {!e.termination_date ? (
            <Section title="Separation">
              <details className="rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm text-[var(--danger)]">
                  Record separation
                </summary>
                <div className="mt-3">
                  <ActionForm
                    action={employeeAction}
                    submitLabel="Record separation"
                    variant="danger"
                    confirmMessage="Record this employee's separation?"
                  >
                    {hidden("terminate")}
                    <Field label="Last day" name="terminationDate" type="date" />
                    <TextArea label="Reason" name="reason" rows={2} required />
                    <p className="text-xs text-[var(--muted)]">
                      Final pay (prorated pay, unused leave, 13th month, etc.) is entered as lines
                      on the last payroll; its tax treatment needs CPA review.
                    </p>
                  </ActionForm>
                </div>
              </details>
            </Section>
          ) : null}
        </>
      );
    },
  );
}
