import type { Metadata } from "next";
import { Suspense } from "react";

import { DataTable } from "@/components/ui/data-table";
import { Alert, BUTTON_VARIANTS, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { isIsoDate, todayManila } from "@/lib/dates";
import { formatAmount, fromCentavos, toCentavos } from "@/lib/money/amount";
import { getTrialBalance } from "@/server/data/ledger";

export const metadata: Metadata = { title: "Trial balance" };

type Props = PageProps<"/staff/clients/[clientId]/trial-balance">;

export default function TrialBalancePage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TrialBalance params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function TrialBalance({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.trial_balance",
    { clientId },
    "Trial balance",
    async ({ client }) => {
      const asOf = isIsoDate(sp.asOf) ? sp.asOf : todayManila();
      const rows = await getTrialBalance(client.id, asOf);
      const totalDebit = rows.reduce((s, r) => s + toCentavos(r.total_debit), 0n);
      const totalCredit = rows.reduce((s, r) => s + toCentavos(r.total_credit), 0n);
      // Present each account's balance in the debit or credit column (sign-aware).
      const presented = rows.map((r) => {
        const bal = toCentavos(r.balance.replace("-", ""));
        const negative = r.balance.startsWith("-");
        const onDebitSide = (r.normal_balance === "debit") !== negative;
        return { ...r, dr: onDebitSide ? bal : 0n, cr: onDebitSide ? 0n : bal };
      });
      const sumDr = presented.reduce((s, r) => s + r.dr, 0n);
      const sumCr = presented.reduce((s, r) => s + r.cr, 0n);
      const balanced = totalDebit === totalCredit && sumDr === sumCr;

      return (
        <>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>As of</span>
              <input
                type="date"
                name="asOf"
                defaultValue={asOf}
                className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
              />
            </label>
            <button type="submit" className={BUTTON_VARIANTS.secondary}>
              Show
            </button>
          </form>
          <Section title={`Trial balance as of ${asOf}`}>
            <div className="mb-3">
              {rows.length === 0 ? null : balanced ? (
                <Alert tone="success">
                  Debits equal credits: {formatAmount(fromCentavos(sumDr))}.
                </Alert>
              ) : (
                <Alert tone="danger" title="Out of balance">
                  This should never happen; the database enforces balanced postings. Report it
                  immediately.
                </Alert>
              )}
            </div>
            <DataTable
              caption={`Trial balance as of ${asOf}`}
              rows={presented}
              rowKey={(r) => r.account_id}
              empty="No posted entries up to this date."
              columns={[
                { header: "Code", cell: (r) => r.code },
                { header: "Account", cell: (r) => r.name },
                {
                  header: "Debit",
                  cell: (r) => (r.dr ? formatAmount(fromCentavos(r.dr)) : ""),
                  kind: "num",
                },
                {
                  header: "Credit",
                  cell: (r) => (r.cr ? formatAmount(fromCentavos(r.cr)) : ""),
                  kind: "num",
                },
              ]}
            />
            {rows.length > 0 ? (
              <p
                className="mt-2 text-right text-sm font-medium"
                data-tb-totals={`${fromCentavos(sumDr)}|${fromCentavos(sumCr)}`}
              >
                Totals: {formatAmount(fromCentavos(sumDr))} / {formatAmount(fromCentavos(sumCr))}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-[var(--muted)]">
              Includes posted and reversed entries (a reversal nets its original to zero). Drafts
              and submitted entries are excluded.
            </p>
          </Section>
        </>
      );
    },
  );
}
