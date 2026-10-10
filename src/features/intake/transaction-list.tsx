import "server-only";

import Link from "next/link";

import { DataTable } from "@/components/ui/data-table";
import { LinkButton, Section } from "@/components/ui/primitives";
import { StatusBadge } from "@/features/intake/components/intake-ui";
import { labelOf, STATUS_LABELS, TXN_KINDS } from "@/lib/intake/rules";
import { formatAmount } from "@/lib/money/amount";
import { getIntakeSummary, listTransactions } from "@/server/data/intake";

const FILTERS = [
  "all",
  "draft",
  "submitted",
  "needs_correction",
  "reviewed",
  "approved",
  "posted",
  "rejected",
  "cancelled",
];

/** Transaction list with status filters (portal and staff). */
export async function TransactionList({
  clientId,
  status,
  basePath,
  itemHref,
  actions,
  title = "Transactions",
}: {
  clientId: string;
  status: string | undefined;
  basePath: string;
  itemHref: (id: string) => string;
  actions?: React.ReactNode;
  title?: string;
}) {
  const filter = status && FILTERS.includes(status) ? status : "all";
  const [summary, rows] = await Promise.all([
    getIntakeSummary(clientId),
    listTransactions(clientId, filter === "all" ? undefined : [filter]),
  ]);
  const counts = summary.transactions;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
          {FILTERS.filter((f) => f === "all" || (counts[f] ?? 0) > 0 || f === filter).map((f) => {
            const active = f === filter;
            const n = f === "all" ? total : (counts[f] ?? 0);
            return (
              <Link
                key={f}
                href={f === "all" ? basePath : `${basePath}?status=${f}`}
                aria-current={active ? "page" : undefined}
                className={`rounded-full border px-3 py-1 text-sm ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
                    : "border-[var(--border)] bg-[var(--surface-raised)]"
                }`}
              >
                {f === "all" ? "All" : STATUS_LABELS[f]}{" "}
                <span className="tabular-nums opacity-80">{n}</span>
              </Link>
            );
          })}
        </nav>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <Section title={title}>
        <DataTable
          caption="Transactions"
          rows={rows}
          rowKey={(r) => r.id}
          empty={filter === "all" ? "No transactions yet." : "No transactions with this status."}
          columns={[
            { header: "Date", kind: "nowrap", cell: (r) => r.txn_date ?? "—" },
            {
              header: "Transaction",
              cell: (r) => (
                <Link
                  href={itemHref(r.id)}
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  {labelOf(TXN_KINDS, r.kind)}
                  {r.document_ref ? ` ${r.document_ref}` : ""}
                </Link>
              ),
            },
            { header: "Customer / supplier", cell: (r) => r.counterparty_name ?? "" },
            {
              header: "Amount",
              kind: "num",
              cell: (r) => (r.gross_amount ? formatAmount(r.gross_amount) : ""),
            },
            { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            { header: "Source", hideOnMobile: true, cell: (r) => r.source },
          ]}
        />
      </Section>
    </>
  );
}

export function NewTransactionButtons({
  newHref,
  importHref,
}: {
  newHref?: string;
  importHref?: string;
}) {
  return (
    <>
      {importHref ? <LinkButton href={importHref}>Import from a file</LinkButton> : null}
      {newHref ? (
        <LinkButton href={newHref} variant="primary">
          + New transaction
        </LinkButton>
      ) : null}
    </>
  );
}
