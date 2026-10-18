import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { DataTable } from "@/components/ui/data-table";
import { LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { sourceLink } from "@/features/reports/source-link";
import { pathFor } from "@/lib/access/route-policy";
import { todayManila } from "@/lib/dates";
import { formatAmount } from "@/lib/money/amount";
import { cents, toText } from "@/lib/reports/statements";
import { listAccounts } from "@/server/data/ledger";
import { accountLines } from "@/server/reports/build";

export const metadata: Metadata = { title: "Account detail" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Props = PageProps<"/staff/clients/[clientId]/reports/accounts/[itemId]">;

export default function AccountDrillPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AccountDrill params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function AccountDrill({ params, searchParams }: Props) {
  const { clientId, itemId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.report_account",
    { clientId },
    "Account detail",
    async ({ client }) => {
      if (!UUID.test(itemId)) return <NotFoundState />;
      const account = (await listAccounts(client.id)).find((a) => a.id === itemId.toLowerCase());
      if (!account) return <NotFoundState />;
      const to = typeof sp.to === "string" && DATE.test(sp.to) ? sp.to : todayManila();
      const from = typeof sp.from === "string" && DATE.test(sp.from) ? sp.from : null;
      const closing = sp.closing !== "0";
      const lines = await accountLines(client.id, account.id, from, to, closing);
      const total = lines.reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0n);
      return (
        <>
          <div className="mb-4">
            <LinkButton href={pathFor("staff.reports", { clientId: client.id })}>
              ← Reports
            </LinkButton>
          </div>
          <Section title={`${account.code} · ${account.name}`}>
            <p className="mb-3 text-sm">
              {from ? `${from} to ${to}` : `All posted entries up to ${to}`}
              {closing ? "" : " · year-end closing entries excluded"} · net movement (debit −
              credit): <strong className="tabular-nums">{formatAmount(toText(total))}</strong>
            </p>
            <DataTable
              caption="Posted lines"
              rows={lines}
              rowKey={(l) => `${l.entry_id}-${l.line_no}`}
              empty="No posted lines in this range."
              columns={[
                { header: "Date", kind: "nowrap", cell: (l) => l.entry_date },
                {
                  header: "Entry",
                  cell: (l) => (
                    <Link
                      className="underline"
                      href={pathFor("staff.entry", { clientId: client.id, entryId: l.entry_id })}
                    >
                      JE {l.entry_no}
                    </Link>
                  ),
                },
                { header: "Type", hideOnMobile: true, cell: (l) => l.entry_type },
                { header: "Memo", cell: (l) => l.description || l.memo },
                {
                  header: "Source",
                  cell: (l) => {
                    const s = sourceLink(client.id, l.source_type, l.source_ref);
                    if (!s) return "Manual entry";
                    return s.href ? (
                      <Link className="underline" href={s.href}>
                        {s.label}
                      </Link>
                    ) : (
                      s.label
                    );
                  },
                },
                {
                  header: "Debit",
                  kind: "num",
                  cell: (l) => (l.debit === "0.00" ? "" : formatAmount(l.debit)),
                },
                {
                  header: "Credit",
                  kind: "num",
                  cell: (l) => (l.credit === "0.00" ? "" : formatAmount(l.credit)),
                },
              ]}
            />
          </Section>
        </>
      );
    },
  );
}
