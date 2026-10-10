import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageSkeleton, Section } from "@/components/ui/primitives";
import {
  approveEntryAction,
  returnEntryAction,
  reverseEntryAction,
  submitEntryAction,
  voidEntryAction,
} from "@/features/ledger/actions";
import { EntryForm } from "@/features/ledger/components/entry-form";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor, REVIEW_ROLES } from "@/lib/access/route-policy";
import { todayManila } from "@/lib/dates";
import { formatAmount, sumAmounts } from "@/lib/money/amount";
import { hasFirmRole } from "@/server/auth/access";
import { getEntry, listAccounts } from "@/server/data/ledger";

export const metadata: Metadata = { title: "Journal entry" };

const STATUS_TONE = {
  draft: "neutral",
  submitted: "warning",
  posted: "success",
  reversed: "info",
  void: "danger",
} as const;

export default function EntryPage({
  params,
}: PageProps<"/staff/clients/[clientId]/journal/[entryId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Entry params={params} />
    </Suspense>
  );
}

async function Entry({ params }: { params: Promise<{ clientId: string; entryId: string }> }) {
  const { clientId, entryId } = await params;
  return renderStaffClientPage(
    "staff.entry",
    { clientId, entryId },
    "Journal entry",
    async ({ access, client }) => {
      if (!/^[0-9a-f-]{36}$/i.test(entryId)) return <DeniedState reason="not_found" />;
      const entry = await getEntry(client.id, entryId.toLowerCase());
      if (!entry) return <DeniedState reason="not_found" />;

      const canApprove = hasFirmRole(access, REVIEW_ROLES);
      const isPreparer = entry.prepared_by === access.user_id;
      const ids = { clientId: client.id, entryId: entry.id };
      const hidden = (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="entryId" value={entry.id} />
        </>
      );
      const totalDebit = sumAmounts(entry.lines.map((l) => l.debit));
      const totalCredit = sumAmounts(entry.lines.map((l) => l.credit));

      return (
        <div data-entry-status={entry.status}>
          <Section
            title={entry.entry_no ? `JE ${entry.entry_no}` : "Unposted entry"}
            actions={
              <Badge tone={STATUS_TONE[entry.status as keyof typeof STATUS_TONE]}>
                {entry.status}
              </Badge>
            }
          >
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[var(--muted)]">Date</dt>
                <dd>{entry.entry_date}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Type</dt>
                <dd>{entry.entry_type}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Memo</dt>
                <dd>{entry.memo || "—"}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Source</dt>
                <dd>{entry.source_ref ? `${entry.source_type}: ${entry.source_ref}` : "—"}</dd>
              </div>
            </dl>
            {entry.reverses_entry_id ? (
              <p className="mt-2 text-sm">
                Reverses{" "}
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: entry.reverses_entry_id,
                  })}
                >
                  the original entry
                </Link>
                .
              </p>
            ) : null}
            {entry.reversed_by_entry_id ? (
              <p className="mt-2 text-sm">
                Reversed by{" "}
                <Link
                  className="underline"
                  href={pathFor("staff.entry", {
                    clientId: client.id,
                    entryId: entry.reversed_by_entry_id,
                  })}
                >
                  the reversal entry
                </Link>
                .
              </p>
            ) : null}
            {entry.review_comment ? (
              <div className="mt-3">
                <Alert tone="warning" title="Returned by reviewer">
                  {entry.review_comment}
                </Alert>
              </div>
            ) : null}
            {entry.void_reason ? (
              <p className="mt-2 text-sm">Void reason: {entry.void_reason}</p>
            ) : null}
          </Section>

          <Section title="Lines">
            <DataTable
              caption="Journal lines"
              rows={[
                ...entry.lines,
                {
                  line_no: 0,
                  account_id: "",
                  code: "",
                  name: "Totals",
                  debit: totalDebit,
                  credit: totalCredit,
                  description: null,
                },
              ]}
              rowKey={(l) => String(l.line_no)}
              columns={[
                {
                  header: "Account",
                  cell: (l) =>
                    l.line_no === 0 ? <strong>Totals</strong> : `${l.code} · ${l.name}`,
                },
                { header: "Description", cell: (l) => l.description ?? "" },
                {
                  header: "Debit",
                  cell: (l) => formatAmount(l.debit === "0.00" ? "" : l.debit),
                  kind: "num",
                },
                {
                  header: "Credit",
                  cell: (l) => formatAmount(l.credit === "0.00" ? "" : l.credit),
                  kind: "num",
                },
              ]}
            />
          </Section>

          {entry.status === "draft" ? (
            <>
              <Section title="Submit for review">
                <ActionForm action={submitEntryAction} submitLabel="Submit for review">
                  {hidden}
                </ActionForm>
              </Section>
              <Section title="Edit draft">
                <EntryForm
                  clientId={client.id}
                  accounts={(await listAccounts(client.id))
                    .filter((a) => a.is_postable && a.is_active)
                    .map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                  idempotencyKey={randomUUID()}
                  defaultDate={entry.entry_date}
                  initial={{
                    entryId: entry.id,
                    entryDate: entry.entry_date,
                    entryType: entry.entry_type,
                    memo: entry.memo,
                    sourceType: entry.source_type ?? "",
                    sourceRef: entry.source_ref ?? "",
                    lines: entry.lines.map((l) => ({
                      account_id: l.account_id,
                      debit: l.debit === "0.00" ? "" : l.debit,
                      credit: l.credit === "0.00" ? "" : l.credit,
                      description: l.description ?? "",
                    })),
                  }}
                />
              </Section>
            </>
          ) : null}

          {entry.status === "submitted" && canApprove ? (
            <Section title="Review">
              {isPreparer ? (
                <Alert tone="info">
                  You prepared this entry, so another reviewer must approve it.
                </Alert>
              ) : (
                <div className="flex flex-col gap-4">
                  <ActionForm
                    action={approveEntryAction}
                    submitLabel="Approve and post"
                    confirmMessage="Post this entry? Posted entries cannot be edited, only reversed."
                  >
                    {hidden}
                  </ActionForm>
                  <ActionForm
                    action={returnEntryAction}
                    submitLabel="Return to preparer"
                    variant="secondary"
                  >
                    {hidden}
                    <Field label="Comment for the preparer" name="reason" required />
                  </ActionForm>
                </div>
              )}
            </Section>
          ) : null}

          {entry.status === "draft" || entry.status === "submitted" ? (
            <Section title="Void">
              <ActionForm
                action={voidEntryAction}
                submitLabel="Void entry"
                variant="danger"
                confirmMessage="Void this entry?"
              >
                {hidden}
                <Field label="Reason" name="reason" required />
              </ActionForm>
            </Section>
          ) : null}

          {entry.status === "posted" && entry.entry_type !== "reversal" && canApprove ? (
            <Section title="Reverse this entry">
              <ActionForm
                action={reverseEntryAction}
                submitLabel="Post reversal"
                variant="danger"
                confirmMessage="Post a reversing entry? This creates a new posted entry with debits and credits swapped."
              >
                {hidden}
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <Field
                  label="Reversal date"
                  name="reversalDate"
                  type="date"
                  required
                  defaultValue={todayManila() < entry.entry_date ? entry.entry_date : todayManila()}
                />
                <Field label="Reason" name="reason" required />
              </ActionForm>
            </Section>
          ) : null}
          <p className="text-sm">
            <Link className="underline" href={pathFor("staff.journal", ids)}>
              ← Back to journal
            </Link>
          </p>
        </div>
      );
    },
  );
}
