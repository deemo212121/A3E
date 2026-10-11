import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { DocStatus } from "@/features/sales/doc-actions";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount } from "@/lib/money/amount";
import { getPayslip, listPayrollItems } from "@/server/data/payroll";

export const metadata: Metadata = { title: "Payslip" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PayslipPage({
  params,
}: PageProps<"/staff/clients/[clientId]/payroll/payslips/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Payslip params={params} />
    </Suspense>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="py-1.5">{strong ? <strong>{label}</strong> : label}</td>
      <td className="py-1.5 text-right tabular-nums">
        {strong ? <strong>{value}</strong> : value}
      </td>
    </tr>
  );
}

async function Payslip({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage("staff.payslip", { clientId }, "Payslip", async ({ client }) => {
    const p = UUID.test(itemId) ? await getPayslip(client.id, itemId.toLowerCase()) : null;
    if (!p) return <NotFoundState />;
    const items = Object.fromEntries((await listPayrollItems(client.id)).map((i) => [i.id, i]));
    const earnings = p.lines.filter((l) => items[l.item_id]?.kind === "earning");
    const deductions = p.lines.filter((l) => items[l.item_id]?.kind === "deduction");
    const label = (l: (typeof p.lines)[number]) =>
      `${l.description ?? items[l.item_id]?.name ?? ""}${
        l.quantity
          ? ` (${l.quantity.replace(/\.?0+$/, "")} × ${formatAmount(l.rate ?? "0")}${
              items[l.item_id]?.multiplier !== "1.0000" ? ` × ${items[l.item_id]?.multiplier}` : ""
            })`
          : ""
      }`;
    return (
      <>
        <div className="mb-4 print:hidden">
          <LinkButton
            href={pathFor("staff.payroll_run", { clientId: client.id, itemId: p.run.id })}
          >
            ← Payroll {p.run.period_start} – {p.run.period_end}
          </LinkButton>
        </div>
        <Section title={`Payslip · ${p.employee_no} · ${p.employee_name}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <DocStatus status={p.run.status} />
            <span>
              {client.display_name} · period {p.run.period_start} to {p.run.period_end} · pay date{" "}
              {p.run.pay_date}
            </span>
          </div>
          {p.run.status !== "posted" ? (
            <div className="mb-3">
              <Alert tone="warning">Not final: the payroll is not posted.</Alert>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <table className="w-full text-sm">
              <caption className="mb-1 text-left font-semibold">Earnings</caption>
              <tbody>
                {earnings.map((l) => (
                  <Row key={l.line_no} label={label(l)} value={formatAmount(l.amount)} />
                ))}
                <Row label="Gross pay" value={formatAmount(p.gross_pay)} strong />
              </tbody>
            </table>
            <table className="w-full text-sm">
              <caption className="mb-1 text-left font-semibold">Deductions</caption>
              <tbody>
                <Row label="SSS (employee share)" value={formatAmount(p.sss_ee)} />
                <Row label="PhilHealth (employee share)" value={formatAmount(p.philhealth_ee)} />
                <Row label="Pag-IBIG (employee share)" value={formatAmount(p.pagibig_ee)} />
                <Row label="Withholding tax" value={formatAmount(p.withholding_tax)} />
                {deductions.map((l) => (
                  <Row key={l.line_no} label={label(l)} value={formatAmount(l.amount)} />
                ))}
                <Row label="Net pay" value={formatAmount(p.net_pay)} strong />
              </tbody>
            </table>
          </div>
          <table className="mt-6 w-full text-xs text-[var(--muted)]">
            <caption className="mb-1 text-left font-semibold">
              Employer share (not deducted from pay)
            </caption>
            <tbody>
              <Row
                label="SSS employer share + EC"
                value={`${formatAmount(p.sss_er)} + ${formatAmount(p.sss_ec)}`}
              />
              <Row label="PhilHealth employer share" value={formatAmount(p.philhealth_er)} />
              <Row label="Pag-IBIG employer share" value={formatAmount(p.pagibig_er)} />
              <Row
                label="Taxable compensation (this payroll)"
                value={formatAmount(p.taxable_pay)}
              />
            </tbody>
          </table>
          {p.notes ? <p className="mt-3 text-sm">Notes: {p.notes}</p> : null}
          <p className="mt-3 text-xs text-[var(--muted)]">
            Contributions are computed on the month-to-date base (true-up across the month&apos;s
            payrolls) from signed-off tables. Computation PENDING VERIFICATION by a qualified
            payroll/accounting reviewer.
          </p>
        </Section>
      </>
    );
  });
}
