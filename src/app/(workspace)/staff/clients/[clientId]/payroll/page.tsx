import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import {
  employeeAction,
  payrollAccessAction,
  payrollRuleAction,
  payrollRunAction,
  payrollSetupAction,
} from "@/features/payroll/actions";
import { ACCESS_LABEL, RULE_KIND_LABEL, RULE_METHOD_LABEL } from "@/features/payroll/labels";
import { DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { formatAmount } from "@/lib/money/amount";
import { hasFirmRole } from "@/server/auth/access";
import { listAccounts } from "@/server/data/ledger";
import {
  getMonthSummary,
  getPayrollReconciliation,
  getPayrollSettings,
  listEmployees,
  listPayrollAccess,
  listPayrollItems,
  listRuleSets,
  listRuns,
} from "@/server/data/payroll";
import { listAssignableStaff, listAssignments, listMembers } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Payroll" };

const TABS = [
  { key: "runs", label: "Payroll runs", needsGrant: true },
  { key: "employees", label: "Employees", needsGrant: true },
  { key: "liabilities", label: "Liabilities & summary", needsGrant: true },
  { key: "setup", label: "Pay items & accounts", needsGrant: true },
  { key: "rules", label: "Statutory tables", needsGrant: false },
  { key: "access", label: "Access", needsGrant: false },
] as const;

type Props = PageProps<"/staff/clients/[clientId]/payroll">;

export default function PayrollPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Payroll params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Payroll({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.payroll",
    { clientId },
    "Payroll",
    async ({ access, client }) => {
      const granted = access.payroll_client_ids.includes(client.id);
      const manager = hasFirmRole(access, ["firm_manager"]);
      const reviewer = hasFirmRole(access, ["firm_manager", "reviewer"]);
      const tabs = TABS.filter(
        (t) => (granted || !t.needsGrant) && (t.key !== "access" || manager),
      );
      const tab = tabs.some((t) => t.key === sp.tab) ? (sp.tab as string) : tabs[0].key;
      const base = pathFor("staff.payroll", { clientId: client.id });
      const asOf =
        typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayPh();
      const hidden = (op: string, id = "") => (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="op" value={op} />
          <input type="hidden" name="id" value={id} />
        </>
      );
      let body: React.ReactNode = null;

      if (tab === "runs") {
        const [runs, settings] = await Promise.all([
          listRuns(client.id),
          getPayrollSettings(client.id),
        ]);
        body = (
          <>
            {!settings ? (
              <div className="mb-4">
                <Alert tone="warning" title="Payroll accounts are not set">
                  Payrolls cannot be posted yet.{" "}
                  <Link className="underline" href={`${base}?tab=setup`}>
                    Set up pay items and accounts
                  </Link>
                  .
                </Alert>
              </div>
            ) : null}
            <Section title="Payroll runs">
              <DataTable
                caption="Payroll runs"
                rows={runs}
                rowKey={(r) => r.id}
                empty="No payrolls yet."
                columns={[
                  {
                    header: "Period",
                    cell: (r) => (
                      <Link
                        className="font-medium text-[var(--accent)] hover:underline"
                        href={pathFor("staff.payroll_run", { clientId: client.id, itemId: r.id })}
                      >
                        {r.period_start} – {r.period_end}
                      </Link>
                    ),
                  },
                  {
                    header: "Pay date",
                    kind: "nowrap",
                    hideOnMobile: true,
                    cell: (r) => r.pay_date,
                  },
                  { header: "Gross", kind: "num", cell: (r) => formatAmount(r.gross_pay) },
                  { header: "Net pay", kind: "num", cell: (r) => formatAmount(r.net_pay) },
                  { header: "Status", cell: (r) => <DocStatus status={r.status} /> },
                ]}
              />
            </Section>
            <Section title="Start a payroll">
              <ActionForm action={payrollRunAction} submitLabel="Create payroll">
                {hidden("create")}
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Select
                    label="Frequency"
                    name="frequency"
                    options={[
                      { value: "semi_monthly", label: "Semi-monthly (1–15, 16–end)" },
                      { value: "monthly", label: "Monthly" },
                    ]}
                  />
                  <Field label="Period start" name="periodStart" type="date" />
                  <Field label="Period end" name="periodEnd" type="date" />
                  <Field label="Pay date" name="payDate" type="date" />
                </div>
                <p className="text-xs text-[var(--muted)]">
                  Employees on payroll in the period are added; monthly-paid employees employed for
                  the whole period get their basic pay filled in.
                </p>
              </ActionForm>
            </Section>
          </>
        );
      } else if (tab === "employees") {
        const employees = await listEmployees(client.id);
        body = (
          <>
            <Section title="Employees">
              <DataTable
                caption="Employees"
                rows={employees}
                rowKey={(e) => e.id}
                empty="No employees yet."
                columns={[
                  {
                    header: "No.",
                    kind: "nowrap",
                    cell: (e) => (
                      <Link
                        className="font-medium text-[var(--accent)] hover:underline"
                        href={pathFor("staff.payroll_employee", {
                          clientId: client.id,
                          itemId: e.id,
                        })}
                      >
                        {e.employee_no}
                      </Link>
                    ),
                  },
                  { header: "Name", cell: (e) => `${e.last_name}, ${e.first_name}` },
                  { header: "Position", hideOnMobile: true, cell: (e) => e.position ?? "" },
                  { header: "Hired", kind: "nowrap", hideOnMobile: true, cell: (e) => e.hire_date },
                  {
                    header: "Status",
                    cell: (e) =>
                      e.termination_date ? (
                        <Badge tone="neutral">separated {e.termination_date}</Badge>
                      ) : (
                        <Badge tone="success">active</Badge>
                      ),
                  },
                ]}
              />
            </Section>
            <Section title="Add an employee (sample/test data only until the system is verified)">
              <ActionForm action={employeeAction} submitLabel="Add employee">
                {hidden("save")}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Employee no." name="employeeNo" maxLength={20} />
                  <Field label="Last name" name="lastName" maxLength={100} />
                  <Field label="First name" name="firstName" maxLength={100} />
                  <Field label="Middle name" name="middleName" maxLength={100} />
                  <Field label="Position" name="position" maxLength={100} />
                  <Field label="Hire date" name="hireDate" type="date" />
                  <Field label="TIN" name="tin" maxLength={20} />
                  <Field label="SSS no." name="sssNo" maxLength={20} />
                  <Field label="PhilHealth no." name="philhealthNo" maxLength={20} />
                  <Field label="Pag-IBIG no." name="pagibigNo" maxLength={20} />
                </div>
                <p className="text-xs text-[var(--muted)]">
                  After saving, add the pay rate on the employee&apos;s page.
                </p>
              </ActionForm>
            </Section>
          </>
        );
      } else if (tab === "liabilities") {
        const month =
          typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month)
            ? sp.month
            : asOf.slice(0, 7);
        const [recon, summary] = await Promise.all([
          getPayrollReconciliation(client.id, asOf),
          getMonthSummary(client.id, `${month}-01`),
        ]);
        const off = recon.filter((r) => r.difference !== "0.00");
        body = (
          <>
            <form className="mb-4 flex flex-wrap items-end gap-2" action={base}>
              <input type="hidden" name="tab" value="liabilities" />
              <label className="flex flex-col gap-1 text-sm">
                <span>As of</span>
                <input
                  type="date"
                  name="asOf"
                  defaultValue={asOf}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>Month</span>
                <input
                  type="month"
                  name="month"
                  defaultValue={month}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                />
              </label>
              <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">
                Show
              </button>
            </form>
            <Section title={`Payroll liabilities vs general ledger as of ${asOf}`}>
              {recon.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Set up the payroll accounts first.</p>
              ) : off.length === 0 ? (
                <Alert tone="success" title="Payroll liabilities agree with the general ledger">
                  What posted payrolls still owe (net pay, contributions, withholding) equals the
                  ledger balance of each payroll liability account.
                </Alert>
              ) : (
                <Alert tone="warning" title="Differences found">
                  Something was posted to a payroll liability account outside payroll (e.g. a manual
                  entry or a remittance recorded elsewhere).
                </Alert>
              )}
              {recon.length > 0 ? (
                <div className="mt-3">
                  <DataTable
                    caption="Payroll reconciliation"
                    rows={recon}
                    rowKey={(r) => r.account_id}
                    columns={[
                      { header: "Liability", cell: (r) => r.liability },
                      { header: "Account", cell: (r) => r.account_code },
                      {
                        header: "Unpaid per payroll",
                        kind: "num",
                        cell: (r) => formatAmount(r.subledger_balance),
                      },
                      {
                        header: "Ledger balance",
                        kind: "num",
                        cell: (r) => formatAmount(r.ledger_balance),
                      },
                      {
                        header: "Difference",
                        kind: "num",
                        cell: (r) =>
                          r.difference === "0.00" ? (
                            "0.00"
                          ) : (
                            <strong className="text-[var(--danger)]">
                              {formatAmount(r.difference)}
                            </strong>
                          ),
                      },
                    ]}
                  />
                </div>
              ) : null}
            </Section>
            <Section title={`Contributions and withholding for ${month} (posted payrolls)`}>
              <DataTable
                caption="Month summary"
                rows={summary}
                rowKey={(r) => r.employee_id}
                empty="No posted payroll in this month."
                columns={[
                  { header: "Employee", cell: (r) => `${r.employee_no} · ${r.employee_name}` },
                  { header: "Gross", kind: "num", cell: (r) => formatAmount(r.gross_pay) },
                  {
                    header: "SSS EE/ER/EC",
                    kind: "num",
                    cell: (r) =>
                      `${formatAmount(r.sss_ee)} / ${formatAmount(r.sss_er)} / ${formatAmount(r.sss_ec)}`,
                  },
                  {
                    header: "PhilHealth EE/ER",
                    kind: "num",
                    hideOnMobile: true,
                    cell: (r) =>
                      `${formatAmount(r.philhealth_ee)} / ${formatAmount(r.philhealth_er)}`,
                  },
                  {
                    header: "Pag-IBIG EE/ER",
                    kind: "num",
                    hideOnMobile: true,
                    cell: (r) => `${formatAmount(r.pagibig_ee)} / ${formatAmount(r.pagibig_er)}`,
                  },
                  {
                    header: "Tax withheld",
                    kind: "num",
                    cell: (r) => formatAmount(r.withholding_tax),
                  },
                  { header: "Net pay", kind: "num", cell: (r) => formatAmount(r.net_pay) },
                ]}
              />
              <p className="mt-2 text-xs text-[var(--muted)]">
                Data for remittance reports. Agency forms and BIR returns are prepared in a later,
                reviewed phase.
              </p>
            </Section>
          </>
        );
      } else if (tab === "setup") {
        const [items, accounts, settings] = await Promise.all([
          listPayrollItems(client.id),
          listAccounts(client.id),
          getPayrollSettings(client.id),
        ]);
        const code = Object.fromEntries(accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));
        const opts = [
          { value: "", label: "Choose…" },
          ...accounts
            .filter((a) => a.is_postable && a.is_active)
            .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
        ];
        const flags = (i: (typeof items)[number]) =>
          [
            i.is_basic && "basic",
            i.is_taxable && "taxable",
            i.in_sss_base && "SSS base",
            i.in_philhealth_base && "PhilHealth base",
            i.in_pagibig_base && "Pag-IBIG base",
          ]
            .filter(Boolean)
            .join(", ");
        body = (
          <>
            <Section title="Pay items (earnings and deductions)">
              <Alert tone="info">
                Whether an earning is taxable or part of each contribution base is a legal and
                accounting judgement: it is set explicitly here and approved by a second person.
                Nothing is preset.
              </Alert>
              <div className="mt-3">
                <DataTable
                  caption="Pay items"
                  rows={items}
                  rowKey={(i) => i.id}
                  empty="No pay items yet."
                  columns={[
                    { header: "Code", kind: "nowrap", cell: (i) => i.code },
                    { header: "Name", cell: (i) => i.name },
                    { header: "Kind", cell: (i) => i.kind },
                    {
                      header: "Unit",
                      hideOnMobile: true,
                      cell: (i) => (i.unit === "amount" ? "amount" : `${i.unit} × ${i.multiplier}`),
                    },
                    { header: "Treatment", hideOnMobile: true, cell: flags },
                    {
                      header: "Account",
                      hideOnMobile: true,
                      cell: (i) => code[i.account_id] ?? "",
                    },
                    {
                      header: "Status",
                      cell: (i) => (
                        <Badge
                          tone={
                            i.status === "approved"
                              ? "success"
                              : i.status === "retired"
                                ? "neutral"
                                : "warning"
                          }
                        >
                          {i.status}
                        </Badge>
                      ),
                    },
                    {
                      header: "Actions",
                      srOnlyHeader: true,
                      cell: (i) =>
                        i.status === "proposed" && i.proposed_by !== access.user_id ? (
                          <ActionForm
                            action={payrollSetupAction}
                            submitLabel="Approve"
                            variant="primary"
                          >
                            {hidden("approve_item", i.id)}
                          </ActionForm>
                        ) : i.status === "approved" ? (
                          <ActionForm
                            action={payrollSetupAction}
                            submitLabel="Retire"
                            variant="secondary"
                          >
                            {hidden("retire_item", i.id)}
                          </ActionForm>
                        ) : null,
                    },
                  ]}
                />
              </div>
              <details className="mt-4 rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm">Propose a pay item</summary>
                <div className="mt-3">
                  <ActionForm action={payrollSetupAction} submitLabel="Propose">
                    {hidden("propose_item")}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Field label="Code (e.g. BASIC, OT)" name="code" maxLength={20} />
                      <Field label="Name" name="name" maxLength={100} />
                      <Select
                        label="Kind"
                        name="kind"
                        options={[
                          { value: "earning", label: "Earning" },
                          { value: "deduction", label: "Deduction" },
                        ]}
                      />
                      <Select label="Account" name="accountId" options={opts} />
                      <Select
                        label="Unit (earnings)"
                        name="unit"
                        options={[
                          { value: "amount", label: "Amount" },
                          { value: "days", label: "Days × daily rate" },
                          { value: "hours", label: "Hours × hourly rate" },
                        ]}
                      />
                      <Field
                        label="Rate multiplier (policy)"
                        name="multiplier"
                        hint="e.g. the overtime premium; default 1"
                      />
                    </div>
                    <fieldset className="flex flex-wrap gap-4 text-sm">
                      <legend className="mb-1 font-medium">
                        Treatment (earnings; confirm with the CPA)
                      </legend>
                      {[
                        ["isBasic", "Basic pay (prefilled)"],
                        ["isTaxable", "Taxable compensation"],
                        ["inSss", "SSS base"],
                        ["inPhilhealth", "PhilHealth base"],
                        ["inPagibig", "Pag-IBIG base"],
                      ].map(([n, l]) => (
                        <label key={n} className="flex items-center gap-2">
                          <input type="checkbox" name={n} /> {l}
                        </label>
                      ))}
                    </fieldset>
                  </ActionForm>
                </div>
              </details>
            </Section>
            <Section title="Posting accounts">
              <ActionForm
                action={payrollSetupAction}
                submitLabel="Use the starter-chart accounts"
                variant="primary"
              >
                {hidden("default_settings")}
                <p className="text-sm">
                  2030 Salaries payable · 6012 Employer contributions · 2120 SSS · 2130 PhilHealth ·
                  2140 Pag-IBIG · 2115 Withholding tax on compensation (added if missing)
                </p>
              </ActionForm>
              <details className="mt-3 rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm">Choose the accounts</summary>
                <div className="mt-3">
                  <ActionForm action={payrollSetupAction} submitLabel="Save">
                    {hidden("settings")}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["netPay", "Net pay payable", settings?.net_pay_account_id],
                          [
                            "employerExpense",
                            "Employer contributions expense",
                            settings?.employer_expense_account_id,
                          ],
                          ["sss", "SSS payable", settings?.sss_payable_account_id],
                          [
                            "philhealth",
                            "PhilHealth payable",
                            settings?.philhealth_payable_account_id,
                          ],
                          ["pagibig", "Pag-IBIG payable", settings?.pagibig_payable_account_id],
                          [
                            "withholding",
                            "Withholding tax on compensation payable",
                            settings?.withholding_payable_account_id,
                          ],
                        ] as const
                      ).map(([name, label, value]) => (
                        <Select
                          key={name}
                          label={label}
                          name={name}
                          options={opts}
                          defaultValue={value ?? ""}
                        />
                      ))}
                    </div>
                  </ActionForm>
                </div>
              </details>
            </Section>
          </>
        );
      } else if (tab === "rules") {
        const rules = await listRuleSets();
        body = (
          <>
            <Section title="Statutory tables (firm-wide)">
              <Alert tone="warning" title="No statutory rates are built in">
                SSS, PhilHealth, Pag-IBIG and withholding tables are entered from the official
                issuances with their legal basis and effective dates, and signed off by a different
                reviewer or manager. A payroll cannot be submitted without a signed-off table for
                each, in effect on the period end. Signed-off tables never change: a new table is a
                new version. Qualified payroll/accounting review is required before production use.
              </Alert>
              <div className="mt-3 flex flex-col gap-4">
                {rules.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No tables yet.</p>
                ) : null}
                {rules.map((r) => (
                  <details key={r.id} className="rounded-md border border-[var(--border)] p-3">
                    <summary className="cursor-pointer text-sm">
                      <strong>
                        {RULE_KIND_LABEL[r.kind]} v{r.version}
                      </strong>{" "}
                      · {r.effective_from} to {r.effective_to ?? "open"}
                      {r.frequency ? ` · ${r.frequency.replace("_", "-")}` : ""} ·{" "}
                      <Badge
                        tone={
                          r.status === "signed_off"
                            ? "success"
                            : r.status === "retired"
                              ? "neutral"
                              : "warning"
                        }
                      >
                        {r.status.replace("_", " ")}
                      </Badge>
                    </summary>
                    <div className="mt-2 flex flex-col gap-2 text-sm">
                      <p>
                        {r.description} · {RULE_METHOD_LABEL[r.method]}
                        {r.base_floor ? ` · floor ${formatAmount(r.base_floor)}` : ""}
                        {r.base_ceiling ? ` · ceiling ${formatAmount(r.base_ceiling)}` : ""}
                        {r.deduct_employee_contributions !== null
                          ? ` · employee contributions ${r.deduct_employee_contributions ? "deducted" : "not deducted"} first`
                          : ""}
                      </p>
                      <p className="text-xs text-[var(--muted)]">Legal basis: {r.legal_basis}</p>
                      <table className="w-full text-xs tabular-nums">
                        <tbody>
                          {r.brackets.map((b) => (
                            <tr key={b.seq} className="border-t border-[var(--border)]">
                              <td className="py-1">
                                {formatAmount(b.lower_bound)} –{" "}
                                {b.upper_bound ? formatAmount(b.upper_bound) : "and above"}
                              </td>
                              <td className="py-1 text-right">
                                {r.method === "fixed_table"
                                  ? `EE ${b.ee_amount} · ER ${b.er_amount} · EC ${b.ec_amount}`
                                  : r.method === "rate_table"
                                    ? `EE ${b.ee_rate} · ER ${b.er_rate}`
                                    : `${b.fixed_tax} + ${b.excess_rate} × excess`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {reviewer &&
                      r.status === "pending_signoff" &&
                      r.entered_by !== access.user_id ? (
                        <ActionForm
                          action={payrollRuleAction}
                          submitLabel="Sign off (I checked it against the official issuance)"
                          variant="primary"
                        >
                          <input type="hidden" name="op" value="sign_off" />
                          <input type="hidden" name="id" value={r.id} />
                        </ActionForm>
                      ) : null}
                      {reviewer && r.status === "signed_off" ? (
                        <ActionForm action={payrollRuleAction} submitLabel="Set end date">
                          <input type="hidden" name="op" value="end" />
                          <input type="hidden" name="id" value={r.id} />
                          <Field label="In effect until" name="effectiveTo" type="date" />
                        </ActionForm>
                      ) : null}
                    </div>
                  </details>
                ))}
              </div>
            </Section>
            {reviewer ? (
              <Section title="Enter a table">
                <ActionForm action={payrollRuleAction} submitLabel="Enter for sign-off">
                  <input type="hidden" name="op" value="propose" />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Select
                      label="Table"
                      name="kind"
                      options={Object.entries(RULE_KIND_LABEL).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                    />
                    <Select
                      label="Method"
                      name="method"
                      options={Object.entries(RULE_METHOD_LABEL).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                    />
                    <Field label="Description" name="description" maxLength={300} />
                    <Field label="Effective from" name="effectiveFrom" type="date" />
                    <Field label="Effective to (optional)" name="effectiveTo" type="date" />
                    <Field label="Base floor (rate tables)" name="baseFloor" />
                    <Field label="Base ceiling (rate tables)" name="baseCeiling" />
                    <Select
                      label="Pay frequency (tax tables)"
                      name="frequency"
                      options={[
                        { value: "", label: "—" },
                        { value: "semi_monthly", label: "Semi-monthly" },
                        { value: "monthly", label: "Monthly" },
                      ]}
                    />
                    <Select
                      label="Deduct employee contributions first (tax tables)"
                      name="deductContributions"
                      options={[
                        { value: "", label: "—" },
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" },
                      ]}
                    />
                  </div>
                  <TextArea
                    label="Legal basis (issuance, date, section)"
                    name="legalBasis"
                    rows={2}
                  />
                  <TextArea
                    label="Brackets, one per line: lower | upper (blank on the last) | values"
                    name="brackets"
                    rows={6}
                    hint="Fixed amounts: EE | ER | EC. Rates: EE rate | ER rate (decimals, e.g. 0.025). Tax table: fixed tax | rate on excess."
                  />
                </ActionForm>
              </Section>
            ) : null}
          </>
        );
      } else {
        const [grants, assignments, members, staff] = await Promise.all([
          listPayrollAccess(client.id),
          listAssignments(client.id),
          listMembers(client.id),
          listAssignableStaff(),
        ]);
        const people = new Map<string, string>();
        for (const s of staff.filter((s) => s.role === "firm_manager"))
          people.set(s.user_id, `${s.label} (manager)`);
        for (const a of assignments)
          people.set(a.user_id, `${a.name || a.email} (assigned ${a.assignment_role})`);
        for (const m of members)
          people.set(m.user_id, `${m.name || m.email} (client ${m.role.replace("client_", "")})`);
        body = (
          <Section title="Who can see this client's payroll">
            <Alert tone="info">
              Payroll is visible only to people granted access here. Being assigned to the client is
              not enough. View: read only. Prepare: firm staff who enter payroll. Approve: reviewers
              or managers who post it. Client users can be given view access only.
            </Alert>
            <div className="mt-3">
              <DataTable
                caption="Payroll access"
                rows={grants}
                rowKey={(g) => g.user_id}
                empty="Nobody has payroll access yet."
                columns={[
                  { header: "Person", cell: (g) => `${g.name} · ${g.email}` },
                  { header: "Access", cell: (g) => ACCESS_LABEL[g.access_level] },
                  { header: "Since", kind: "nowrap", cell: (g) => g.granted_at.slice(0, 10) },
                  {
                    header: "Actions",
                    srOnlyHeader: true,
                    cell: (g) => (
                      <ActionForm
                        action={payrollAccessAction}
                        submitLabel="Remove"
                        variant="danger"
                      >
                        <input type="hidden" name="clientId" value={client.id} />
                        <input type="hidden" name="op" value="revoke" />
                        <input type="hidden" name="userId" value={g.user_id} />
                      </ActionForm>
                    ),
                  },
                ]}
              />
            </div>
            <div className="mt-4">
              <ActionForm action={payrollAccessAction} submitLabel="Grant access">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="op" value="grant" />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select
                    label="Person"
                    name="userId"
                    options={[
                      { value: "", label: "Choose…" },
                      ...[...people.entries()].map(([value, label]) => ({ value, label })),
                    ]}
                  />
                  <Select
                    label="Access"
                    name="level"
                    options={Object.entries(ACCESS_LABEL).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                </div>
              </ActionForm>
            </div>
          </Section>
        );
      }

      return (
        <>
          {!granted ? (
            <div className="mb-4">
              <Alert tone="info" title="You do not have payroll access for this client">
                As a manager you can grant access (including to yourself) on the Access tab.
              </Alert>
            </div>
          ) : null}
          <nav aria-label="Payroll sections" className="mb-4 flex flex-wrap gap-2">
            {tabs.map((t) => (
              <Link
                key={t.key}
                href={`${base}?tab=${t.key}`}
                aria-current={tab === t.key ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-sm ${tab === t.key ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]" : "border-[var(--border)] bg-[var(--surface-raised)]"}`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {body}
        </>
      );
    },
  );
}
