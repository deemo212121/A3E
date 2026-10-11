import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { Timeline } from "@/features/intake/components/intake-ui";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { payrollPaymentAction, payrollRunAction } from "@/features/payroll/actions";
import { PayslipLinesForm } from "@/features/payroll/components/payslip-lines-form";
import { PAYMENT_KIND_LABEL } from "@/features/payroll/labels";
import { DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { formatAmount, fromCentavos, toCentavos } from "@/lib/money/amount";
import { hasFirmRole } from "@/server/auth/access";
import { listAccounts } from "@/server/data/ledger";
import { getPayrollEvents, getRun, listEmployees, listPayrollItems } from "@/server/data/payroll";

export const metadata: Metadata = { title: "Payroll run" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function RunPage({
  params,
}: PageProps<"/staff/clients/[clientId]/payroll/runs/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Run params={params} />
    </Suspense>
  );
}

async function Run({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.payroll_run",
    { clientId },
    "Payroll run",
    async ({ access, client }) => {
      const r = UUID.test(itemId) ? await getRun(client.id, itemId.toLowerCase()) : null;
      if (!r) return <NotFoundState />;
      const [items, employees, accounts, events] = await Promise.all([
        listPayrollItems(client.id),
        listEmployees(client.id),
        listAccounts(client.id),
        getPayrollEvents(client.id, "run", r.id),
      ]);
      const approver = hasFirmRole(access, ["firm_manager", "reviewer"]);
      const draft = r.status === "draft";
      const hidden = (op: string) => (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="op" value={op} />
          <input type="hidden" name="id" value={r.id} />
        </>
      );
      const approved = items.filter((i) => i.status === "approved");
      const itemOptions = approved.map((i) => ({
        id: i.id,
        kind: i.kind,
        unit: i.unit,
        label: `${i.kind === "deduction" ? "− " : ""}${i.code} · ${i.name}`,
      }));
      const itemName = Object.fromEntries(items.map((i) => [i.id, i.name]));
      const onRun = new Set(r.payslips.map((p) => p.employee_id));
      const addable = employees.filter((e) => !onRun.has(e.id));
      const totals: [string, string][] = [
        ["Gross pay", r.gross_pay],
        ["Employee contributions", r.employee_contributions],
        ["Withholding tax", r.withholding_tax],
        ["Other deductions", r.other_deductions],
        ["Net pay", r.net_pay],
        ["Employer contributions (expense)", r.employer_contributions],
      ];
      return (
        <>
          <div className="mb-4">
            <LinkButton href={pathFor("staff.payroll", { clientId: client.id })}>
              ← Payroll runs
            </LinkButton>
          </div>
          <Section title={`Payroll ${r.period_start} to ${r.period_end}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <DocStatus status={r.status} />
              <span>
                {r.frequency.replace("_", "-")} · pay date {r.pay_date}
              </span>
              {r.journal_entry_id ? (
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: r.journal_entry_id,
                  })}
                >
                  Journal entry
                </Link>
              ) : null}
            </div>
            {r.review_comment && draft ? (
              <div className="mb-3">
                <Alert tone="warning" title="Returned by the approver">
                  {r.review_comment}
                </Alert>
              </div>
            ) : null}
            {r.cancel_reason ? <p className="mb-3 text-sm">Cancelled: {r.cancel_reason}</p> : null}
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {totals.map(([k, v]) => (
                <div key={k} className="rounded-md bg-[var(--surface)] p-2">
                  <dt className="text-xs text-[var(--muted)]">{k}</dt>
                  <dd className="tabular-nums">{formatAmount(v)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-[var(--muted)]">
              Computed by the database from the signed-off statutory tables (PENDING VERIFICATION).
              Draft amounts are recomputed when the payroll is submitted and again when it is
              posted.
            </p>
          </Section>

          <Section title="Payslips">
            <DataTable
              caption="Payslips"
              rows={r.payslips}
              rowKey={(p) => p.id}
              empty="No employees on this payroll."
              columns={[
                {
                  header: "Employee",
                  cell: (p) => (
                    <Link
                      className="font-medium text-[var(--accent)] hover:underline"
                      href={pathFor("staff.payslip", { clientId: client.id, itemId: p.id })}
                    >
                      {p.employee_no} · {p.employee_name}
                    </Link>
                  ),
                },
                { header: "Gross", kind: "num", cell: (p) => formatAmount(p.gross_pay) },
                {
                  header: "Contributions (EE)",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (p) =>
                    formatAmount(
                      fromCentavos(
                        toCentavos(p.sss_ee) +
                          toCentavos(p.philhealth_ee) +
                          toCentavos(p.pagibig_ee),
                      ),
                    ),
                },
                {
                  header: "Tax",
                  kind: "num",
                  hideOnMobile: true,
                  cell: (p) => formatAmount(p.withholding_tax),
                },
                { header: "Net", kind: "num", cell: (p) => formatAmount(p.net_pay) },
                { header: "Notes", hideOnMobile: true, cell: (p) => p.notes ?? "" },
              ]}
            />
          </Section>

          {draft ? (
            <Section title="Enter pay (draft)">
              <div className="flex flex-col gap-3">
                {r.payslips.map((p) => (
                  <details key={p.id} className="rounded-md border border-[var(--border)] p-3">
                    <summary className="cursor-pointer text-sm">
                      {p.employee_no} · {p.employee_name} — {p.lines.length} line(s)
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      <PayslipLinesForm
                        key={p.lines.map((l) => `${l.item_id}${l.amount}`).join("|")}
                        clientId={client.id}
                        payslipId={p.id}
                        items={itemOptions}
                        initial={p.lines.map((l) => ({
                          item_id: l.item_id,
                          quantity: l.quantity ?? "",
                          amount: l.quantity ? "" : l.amount,
                          description: l.description ?? itemName[l.item_id] ?? "",
                        }))}
                      />
                      <ActionForm
                        action={payrollRunAction}
                        submitLabel="Remove from this payroll"
                        variant="danger"
                      >
                        <input type="hidden" name="clientId" value={client.id} />
                        <input type="hidden" name="op" value="remove_payslip" />
                        <input type="hidden" name="payslipId" value={p.id} />
                      </ActionForm>
                    </div>
                  </details>
                ))}
                {addable.length > 0 ? (
                  <ActionForm action={payrollRunAction} submitLabel="Add employee">
                    {hidden("add_employee")}
                    <Select
                      label="Employee"
                      name="employeeId"
                      options={addable.map((e) => ({
                        value: e.id,
                        label: `${e.employee_no} · ${e.last_name}, ${e.first_name}`,
                      }))}
                    />
                  </ActionForm>
                ) : null}
              </div>
            </Section>
          ) : null}

          <Section title="Workflow">
            <div className="flex flex-col gap-3">
              {draft ? (
                <ActionForm
                  action={payrollRunAction}
                  submitLabel="Submit for approval"
                  variant="primary"
                >
                  {hidden("submit")}
                </ActionForm>
              ) : null}
              {r.status === "submitted" && approver && r.prepared_by !== access.user_id ? (
                <>
                  <ActionForm
                    action={payrollRunAction}
                    submitLabel="Approve and post"
                    variant="primary"
                    confirmMessage="Post this payroll? It creates the payroll journal entry."
                  >
                    {hidden("post")}
                  </ActionForm>
                  <details className="rounded-md border border-[var(--border)] p-3">
                    <summary className="cursor-pointer text-sm">Return to the preparer</summary>
                    <div className="mt-3">
                      <ActionForm action={payrollRunAction} submitLabel="Return">
                        {hidden("return")}
                        <TextArea label="What needs to change?" name="comment" rows={2} required />
                      </ActionForm>
                    </div>
                  </details>
                </>
              ) : null}
              {r.status === "submitted" && r.prepared_by === access.user_id ? (
                <Alert tone="info">
                  You prepared this payroll, so another approver must post it.
                </Alert>
              ) : null}
              {r.status !== "cancelled" ? (
                <details className="rounded-md border border-[var(--border)] p-3">
                  <summary className="cursor-pointer text-sm text-[var(--danger)]">
                    Cancel this payroll
                  </summary>
                  <div className="mt-3">
                    <ActionForm
                      action={payrollRunAction}
                      submitLabel="Cancel payroll"
                      variant="danger"
                      confirmMessage="Cancel this payroll?"
                    >
                      {hidden("cancel")}
                      <TextArea label="Reason" name="comment" rows={2} required />
                      {r.status === "posted" ? (
                        <Field
                          label="Reversal date (optional)"
                          name="reversalDate"
                          type="date"
                          hint="Default: the period end. Payments must be cancelled first; later payrolls of the month too."
                        />
                      ) : null}
                    </ActionForm>
                  </div>
                </details>
              ) : null}
            </div>
          </Section>

          {r.status === "posted" || r.payments.length > 0 ? (
            <Section title="Payments and remittances">
              <DataTable
                caption="Payments"
                rows={r.payments}
                rowKey={(p) => p.id}
                empty="Nothing paid yet."
                columns={[
                  { header: "Date", kind: "nowrap", cell: (p) => p.payment_date },
                  {
                    header: "What",
                    cell: (p) =>
                      PAYMENT_KIND_LABEL[p.kind] + (p.item_id ? ` (${itemName[p.item_id]})` : ""),
                  },
                  { header: "Amount", kind: "num", cell: (p) => formatAmount(p.amount) },
                  { header: "Status", cell: (p) => <DocStatus status={p.status} /> },
                  {
                    header: "Actions",
                    srOnlyHeader: true,
                    cell: (p) => (
                      <div className="flex gap-2">
                        {p.status === "submitted" &&
                        approver &&
                        p.prepared_by !== access.user_id ? (
                          <ActionForm
                            action={payrollPaymentAction}
                            submitLabel="Post"
                            variant="primary"
                          >
                            <input type="hidden" name="clientId" value={client.id} />
                            <input type="hidden" name="op" value="post" />
                            <input type="hidden" name="id" value={p.id} />
                          </ActionForm>
                        ) : null}
                        {p.status !== "cancelled" ? (
                          <ActionForm
                            action={payrollPaymentAction}
                            submitLabel="Cancel"
                            variant="danger"
                            confirmMessage="Cancel this payment?"
                          >
                            <input type="hidden" name="clientId" value={client.id} />
                            <input type="hidden" name="op" value="cancel" />
                            <input type="hidden" name="id" value={p.id} />
                            <input
                              type="hidden"
                              name="comment"
                              value="Cancelled from the payroll page"
                            />
                          </ActionForm>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
              />
              {r.status === "posted" ? (
                <div className="mt-4">
                  <ActionForm action={payrollPaymentAction} submitLabel="Record payment">
                    <input type="hidden" name="clientId" value={client.id} />
                    <input type="hidden" name="op" value="record" />
                    <input type="hidden" name="runId" value={r.id} />
                    <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Select
                        label="What is paid"
                        name="kind"
                        options={Object.entries(PAYMENT_KIND_LABEL).map(([value, label]) => ({
                          value,
                          label,
                        }))}
                      />
                      <Select
                        label="Deduction (for other deductions)"
                        name="itemId"
                        options={[
                          { value: "", label: "—" },
                          ...approved
                            .filter((i) => i.kind === "deduction")
                            .map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` })),
                        ]}
                      />
                      <Field label="Date" name="paymentDate" type="date" defaultValue={todayPh()} />
                      <Select
                        label="Paid from"
                        name="paidFrom"
                        options={[
                          { value: "", label: "Choose…" },
                          ...accounts
                            .filter(
                              (a) => a.account_type === "asset" && a.is_postable && a.is_active,
                            )
                            .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
                        ]}
                      />
                      <Field label="Amount" name="amount" />
                      <Field label="Reference" name="reference" maxLength={100} />
                    </div>
                  </ActionForm>
                </div>
              ) : null}
            </Section>
          ) : null}

          <Section title="History">
            <Timeline
              items={events.map((e) => ({
                kind: "event" as const,
                at: e.occurred_at,
                actor: "",
                from: e.from_status,
                to: e.to_status,
                text: e.comment,
              }))}
            />
          </Section>
        </>
      );
    },
  );
}
