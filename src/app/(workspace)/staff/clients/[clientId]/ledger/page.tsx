import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DataTable } from "@/components/ui/data-table";
import { BUTTON_VARIANTS, EmptyState, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor } from "@/lib/access/route-policy";
import { isIsoDate, todayManila } from "@/lib/dates";
import { formatAmount } from "@/lib/money/amount";
import { getGeneralLedger, listAccounts } from "@/server/data/ledger";

export const metadata: Metadata = { title: "General ledger" };

type Props = PageProps<"/staff/clients/[clientId]/ledger">;

export default function LedgerPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Ledger params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Ledger({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.ledger",
    { clientId },
    "General ledger",
    async ({ client }) => {
      const accounts = (await listAccounts(client.id)).filter((a) => a.is_postable);
      const today = todayManila();
      const from = isIsoDate(sp.from) ? sp.from : `${today.slice(0, 4)}-01-01`;
      const to = isIsoDate(sp.to) ? sp.to : today;
      const accountId =
        typeof sp.account === "string" && accounts.some((a) => a.id === sp.account)
          ? sp.account
          : accounts[0]?.id;
      const rows = accountId ? await getGeneralLedger(client.id, accountId, from, to) : [];
      const account = accounts.find((a) => a.id === accountId);

      return (
        <>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>Account</span>
              <select
                name="account"
                defaultValue={accountId}
                className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            {(["from", "to"] as const).map((k) => (
              <label key={k} className="flex flex-col gap-1 text-sm">
                <span>{k === "from" ? "From" : "To"}</span>
                <input
                  type="date"
                  name={k}
                  defaultValue={k === "from" ? from : to}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                />
              </label>
            ))}
            <button type="submit" className={BUTTON_VARIANTS.secondary}>
              Show
            </button>
          </form>
          {account ? (
            <Section title={`${account.code} · ${account.name} (${from} to ${to})`}>
              <DataTable
                caption="General ledger"
                rows={rows}
                rowKey={(r) => `${r.entry_id}-${r.line_no}`}
                empty="No postings in this range."
                columns={[
                  { header: "Date", kind: "nowrap", cell: (r) => r.entry_date },
                  {
                    header: "Entry",
                    cell: (r) => (
                      <Link
                        className="underline"
                        href={pathFor("staff.entry", { clientId: client.id, entryId: r.entry_id })}
                      >
                        JE {r.entry_no}
                      </Link>
                    ),
                  },
                  { header: "Memo", cell: (r) => r.description || r.memo },
                  {
                    header: "Supplier / customer",
                    hideOnMobile: true,
                    cell: (r) => r.counterparty_name ?? "",
                  },
                  {
                    header: "Receipt / invoice",
                    kind: "nowrap",
                    cell: (r) => r.document_ref ?? "",
                  },
                  {
                    header: "Debit",
                    cell: (r) => (r.debit === "0.00" ? "" : formatAmount(r.debit)),
                    kind: "num",
                  },
                  {
                    header: "Credit",
                    cell: (r) => (r.credit === "0.00" ? "" : formatAmount(r.credit)),
                    kind: "num",
                  },
                  {
                    header: "Balance",
                    cell: (r) => formatAmount(r.running_balance),
                    kind: "num",
                  },
                ]}
              />
            </Section>
          ) : (
            <EmptyState title="No accounts yet">Set up the chart of accounts first.</EmptyState>
          )}
        </>
      );
    },
  );
}
