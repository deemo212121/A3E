import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DataTable } from "@/components/ui/data-table";
import {
  Alert,
  Badge,
  BUTTON_VARIANTS,
  LinkButton,
  PageSkeleton,
  Section,
} from "@/components/ui/primitives";
import { EntryForm } from "@/features/ledger/components/entry-form";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor } from "@/lib/access/route-policy";
import { todayManila } from "@/lib/dates";
import { formatAmount } from "@/lib/money/amount";
import { listAccounts, listEntries, listFiscalYears } from "@/server/data/ledger";

export const metadata: Metadata = { title: "Journal" };

const STATUS_TONE = {
  draft: "neutral",
  submitted: "warning",
  posted: "success",
  reversed: "info",
  void: "danger",
} as const;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "submitted", label: "Awaiting review" },
  { key: "posted", label: "Posted" },
  { key: "reversed", label: "Reversed" },
  { key: "void", label: "Void" },
] as const;

type Props = PageProps<"/staff/clients/[clientId]/journal">;

export default function JournalPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Journal params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Journal({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage("staff.journal", { clientId }, "Journal", async ({ client }) => {
    const [entries, accounts, years] = await Promise.all([
      listEntries(client.id),
      listAccounts(client.id),
      listFiscalYears(client.id),
    ]);
    const filter = FILTERS.some((f) => f.key === sp.status) ? (sp.status as string) : "all";
    const shown = filter === "all" ? entries : entries.filter((e) => e.status === filter);
    const count = (key: string) =>
      key === "all" ? entries.length : entries.filter((e) => e.status === key).length;
    const postable = accounts.filter((a) => a.is_postable && a.is_active);
    const base = pathFor("staff.journal", { clientId: client.id });

    return (
      <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Filter entries by status" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => {
              const active = f.key === filter;
              return (
                <Link
                  key={f.key}
                  href={f.key === "all" ? base : `${base}?status=${f.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
                      : "border-[var(--border)] bg-[var(--surface-raised)]"
                  }`}
                >
                  {f.label} <span className="tabular-nums opacity-80">{count(f.key)}</span>
                </Link>
              );
            })}
          </nav>
          {postable.length > 0 && years.length > 0 ? (
            <a href="#new-entry" className={BUTTON_VARIANTS.primary}>
              + New journal entry
            </a>
          ) : null}
        </div>

        <Section title="Entries">
          <DataTable
            caption="Journal entries"
            rows={shown}
            rowKey={(e) => e.id}
            empty={filter === "all" ? "No journal entries yet." : "No entries with this status."}
            columns={[
              {
                header: "No.",
                kind: "nowrap",
                cell: (e) => (e.entry_no ? `JE ${e.entry_no}` : "—"),
              },
              { header: "Date", kind: "nowrap", cell: (e) => e.entry_date },
              {
                header: "Memo",
                cell: (e) => (
                  <Link
                    href={pathFor("staff.entry", { clientId: client.id, entryId: e.id })}
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    {e.memo || "(no memo)"}
                  </Link>
                ),
              },
              { header: "Type", hideOnMobile: true, cell: (e) => e.entry_type },
              {
                header: "Source",
                hideOnMobile: true,
                cell: (e) =>
                  e.source_type === "reversal"
                    ? "Reversal"
                    : e.source_ref
                      ? `${e.source_type?.replace(/_/g, " ")} ${e.source_ref}`
                      : "—",
              },
              { header: "Amount", kind: "num", cell: (e) => formatAmount(e.total) },
              {
                header: "Status",
                cell: (e) => (
                  <Badge tone={STATUS_TONE[e.status as keyof typeof STATUS_TONE]}>{e.status}</Badge>
                ),
              },
            ]}
          />
        </Section>

        <section id="new-entry" className="scroll-mt-20">
          <Section title="New journal entry">
            {postable.length === 0 ? (
              <Alert tone="warning" title="No chart of accounts yet">
                Set up the chart of accounts first.{" "}
                <LinkButton href={pathFor("staff.accounts", { clientId: client.id })}>
                  Chart of accounts
                </LinkButton>
              </Alert>
            ) : years.length === 0 ? (
              <Alert tone="warning" title="No fiscal year open">
                A reviewer or manager must open a fiscal year first.{" "}
                <LinkButton href={pathFor("staff.periods", { clientId: client.id })}>
                  Periods
                </LinkButton>
              </Alert>
            ) : (
              <EntryForm
                clientId={client.id}
                accounts={postable.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                idempotencyKey={randomUUID()}
                defaultDate={todayManila()}
              />
            )}
          </Section>
        </section>
      </>
    );
  });
}
