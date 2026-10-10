import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageSkeleton, Section } from "@/components/ui/primitives";
import { TransactionForm } from "@/features/intake/components/transaction-form";
import { CounterpartiesView } from "@/features/intake/counterparties-view";
import { DocumentsView } from "@/features/intake/documents-view";
import { ProfileView } from "@/features/intake/profile-view";
import { NewTransactionButtons, TransactionList } from "@/features/intake/transaction-list";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor } from "@/lib/access/route-policy";
import { todayPh } from "@/lib/intake/rules";
import { getIntakeSummary, listCounterparties, listDocuments } from "@/server/data/intake";

export const metadata: Metadata = { title: "Intake" };

const TABS = [
  { key: "transactions", label: "Transactions" },
  { key: "counterparties", label: "Customers & suppliers" },
  { key: "profile", label: "Business profile" },
  { key: "documents", label: "Documents" },
  { key: "new", label: "+ Record" },
] as const;

type Props = PageProps<"/staff/clients/[clientId]/intake">;

export default function IntakePage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Intake params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Intake({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage(
    "staff.intake",
    { clientId },
    "Intake",
    async ({ access, client }) => {
      const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as string) : "transactions";
      const base = pathFor("staff.intake", { clientId: client.id });
      const summary = await getIntakeSummary(client.id);
      const badge: Record<string, number> = {
        transactions: (summary.transactions.submitted ?? 0) + (summary.transactions.reviewed ?? 0),
        counterparties: summary.counterparties.submitted ?? 0,
        profile: summary.profile?.status === "submitted" ? 1 : 0,
        documents: summary.documents.pending ?? 0,
      };
      let body: React.ReactNode;
      if (tab === "counterparties")
        body = <CounterpartiesView access={access} clientId={client.id} />;
      else if (tab === "profile") body = <ProfileView access={access} clientId={client.id} />;
      else if (tab === "documents") body = <DocumentsView access={access} clientId={client.id} />;
      else if (tab === "new") {
        const [parties, docs] = await Promise.all([
          listCounterparties(client.id, ["approved", "submitted"]),
          listDocuments(client.id),
        ]);
        body = (
          <Section title="Record a transaction for this client">
            <TransactionForm
              clientId={client.id}
              idempotencyKey={randomUUID()}
              today={todayPh()}
              documentsHref={`${base}?tab=documents`}
              counterparties={parties.map((c) => ({
                id: c.id,
                name: c.registered_name,
                tin: c.tin,
                kind: c.kind,
              }))}
              documents={docs.map((d) => ({
                id: d.id,
                name: d.original_filename,
                category: d.category,
              }))}
            />
          </Section>
        );
      } else {
        body = (
          <TransactionList
            clientId={client.id}
            status={typeof sp.status === "string" ? sp.status : undefined}
            basePath={base}
            itemHref={(id) => pathFor("staff.intake_txn", { clientId: client.id, itemId: id })}
            actions={
              <NewTransactionButtons
                newHref={`${base}?tab=new`}
                importHref={pathFor("staff.imports", { clientId: client.id })}
              />
            }
          />
        );
      }
      return (
        <>
          <nav aria-label="Intake sections" className="mb-4 flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "transactions" ? base : `${base}?tab=${t.key}`}
                aria-current={tab === t.key ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  tab === t.key
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
                    : "border-[var(--border)] bg-[var(--surface-raised)]"
                }`}
              >
                {t.label}
                {badge[t.key] ? (
                  <span className="ml-1.5 rounded-full bg-[var(--warning-bg)] px-1.5 text-xs text-[var(--warning)]">
                    {badge[t.key]}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          {body}
        </>
      );
    },
  );
}
