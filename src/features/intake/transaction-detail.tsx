import "server-only";

import { randomUUID } from "node:crypto";

import Link from "next/link";

import { ActionForm, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, LinkButton, Section } from "@/components/ui/primitives";
import { transitionTransactionAction } from "@/features/intake/actions";
import { CommentForm, StatusBadge, Timeline } from "@/features/intake/components/intake-ui";
import { TransactionForm } from "@/features/intake/components/transaction-form";
import { EntryForm } from "@/features/ledger/components/entry-form";
import { pathFor } from "@/lib/access/route-policy";
import { DOCUMENT_TYPES, labelOf, PAYMENT_METHODS, todayPh, TXN_KINDS } from "@/lib/intake/rules";
import { formatAmount } from "@/lib/money/amount";
import type { Access } from "@/server/auth/access";
import {
  getTimeline,
  getTransaction,
  listCounterparties,
  listDocuments,
} from "@/server/data/intake";
import { listAccounts } from "@/server/data/ledger";
import { canApproveIntake, canWriteIntake, isStaffOn } from "@/server/intake/access";

function TransitionForm({
  clientId,
  id,
  to,
  label,
  variant = "secondary",
  needsComment,
  confirm,
}: {
  clientId: string;
  id: string;
  to: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  needsComment?: boolean;
  confirm?: string;
}) {
  return (
    <ActionForm
      action={transitionTransactionAction}
      submitLabel={label}
      variant={variant}
      confirmMessage={confirm}
      className={needsComment ? "flex max-w-xl flex-col gap-2" : "inline-flex"}
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="to" value={to} />
      {needsComment ? (
        <TextArea
          label="What needs to change? (the client will see this)"
          name="comment"
          rows={2}
          required
        />
      ) : null}
    </ActionForm>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="text-sm">{children || "—"}</dd>
    </div>
  );
}

/** Transaction page body, for the client portal and the staff workspace. */
export async function TransactionDetail({
  access,
  clientId,
  id,
}: {
  access: Access;
  clientId: string;
  id: string;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const txn = await getTransaction(clientId, id);
  if (!txn) return null;
  const staff = isStaffOn(access, clientId);
  const writer = canWriteIntake(access, clientId);
  const approver = canApproveIntake(access, clientId);
  const editable = writer && ["draft", "needs_correction"].includes(txn.status);
  const timeline = await getTimeline(clientId, "transaction", id);
  const documentsHref = staff
    ? pathFor("staff.intake", { clientId }) + "?tab=documents"
    : pathFor("portal.documents", { clientId });

  return (
    <>
      <Section title="Summary">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusBadge status={txn.status} />
          <span className="text-sm text-[var(--muted)]">
            {labelOf(TXN_KINDS, txn.kind)} · entered via{" "}
            {txn.source === "import" ? `import (row ${txn.import_row_no})` : txn.source}
          </span>
        </div>
        {txn.status === "needs_correction" ? (
          <div className="mb-3">
            <Alert tone="warning" title="The firm asked for a correction">
              See the comment in the history below, edit the transaction, then submit it again.
            </Alert>
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Detail label="Date">{txn.txn_date}</Detail>
          <Detail label="Document">
            {[labelOf(DOCUMENT_TYPES, txn.document_type ?? ""), txn.document_ref]
              .filter((x) => x && x !== "—")
              .join(" ")}
          </Detail>
          <Detail label="Customer / supplier">
            {txn.counterparty_name}
            {txn.counterparty_tin ? (
              <span className="block text-xs text-[var(--muted)]">TIN {txn.counterparty_tin}</span>
            ) : null}
          </Detail>
          <Detail label="Total">
            {txn.gross_amount ? `₱ ${formatAmount(txn.gross_amount)}` : null}
          </Detail>
          <Detail label="VAT as stated">
            {txn.vat_amount_stated ? formatAmount(txn.vat_amount_stated) : null}
          </Detail>
          <Detail label="Withholding as stated">
            {txn.withholding_amount_stated ? formatAmount(txn.withholding_amount_stated) : null}
          </Detail>
          <Detail label="Payment">
            {txn.payment_method ? labelOf(PAYMENT_METHODS, txn.payment_method) : null}
          </Detail>
          <div className="col-span-2">
            <Detail label="Description">{txn.description}</Detail>
          </div>
        </dl>
      </Section>

      <Section title="Items">
        <DataTable
          caption="Transaction items"
          rows={txn.lines}
          rowKey={(l) => String(l.line_no)}
          empty="No items yet (they are created when an amount is entered)."
          columns={[
            { header: "Item", cell: (l) => l.description ?? "" },
            { header: "Qty", kind: "num", hideOnMobile: true, cell: (l) => l.quantity ?? "" },
            {
              header: "Unit price",
              kind: "num",
              hideOnMobile: true,
              cell: (l) => l.unit_price ?? "",
            },
            { header: "Amount", kind: "num", cell: (l) => formatAmount(l.amount) },
            { header: "Category", hideOnMobile: true, cell: (l) => l.account_hint ?? "" },
          ]}
        />
      </Section>

      <Section title="Supporting documents">
        {txn.documents.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None attached.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {txn.documents.map((d) => (
              <li key={d.id}>
                <a className="text-[var(--accent)] underline" href={`/api/documents/${d.id}`}>
                  {d.original_filename}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {writer && ["draft", "needs_correction"].includes(txn.status) ? (
        <Section title="Ready?">
          <div className="flex flex-wrap gap-2">
            <TransitionForm
              clientId={clientId}
              id={id}
              to="submitted"
              label="Submit for review"
              variant="primary"
            />
            <TransitionForm
              clientId={clientId}
              id={id}
              to="cancelled"
              label="Cancel this transaction"
              confirm="Cancel this transaction? It stays in the history but will not be processed."
            />
          </div>
        </Section>
      ) : null}

      {staff && ["submitted", "reviewed"].includes(txn.status) ? (
        <Section title="Review">
          <div className="flex flex-col gap-4">
            {txn.status === "submitted" ? (
              <div className="flex flex-wrap gap-2">
                <TransitionForm
                  clientId={clientId}
                  id={id}
                  to="reviewed"
                  label="Mark as reviewed"
                  variant="primary"
                />
              </div>
            ) : approver && txn.reviewed_by !== access.user_id ? (
              <TransitionForm
                clientId={clientId}
                id={id}
                to="approved"
                label="Approve"
                variant="primary"
              />
            ) : (
              <Alert tone="info">
                {txn.reviewed_by === access.user_id
                  ? "You reviewed this transaction, so another reviewer or manager must approve it."
                  : "A reviewer or manager approves reviewed transactions."}
              </Alert>
            )}
            <details className="rounded-md border border-[var(--border)] p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Return to the client for correction
              </summary>
              <div className="mt-3">
                <TransitionForm
                  clientId={clientId}
                  id={id}
                  to="needs_correction"
                  label="Return for correction"
                  needsComment
                />
              </div>
            </details>
            {approver ? (
              <details className="rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm font-medium text-[var(--danger)]">
                  Reject
                </summary>
                <div className="mt-3">
                  <TransitionForm
                    clientId={clientId}
                    id={id}
                    to="rejected"
                    label="Reject"
                    variant="danger"
                    needsComment
                  />
                </div>
              </details>
            ) : null}
          </div>
        </Section>
      ) : null}

      {staff && txn.status === "approved" ? (
        <Section title="Book in the journal">
          {txn.journal_entry_id ? (
            <Alert tone="info" title="A journal entry is in progress">
              <Link
                className="underline"
                href={pathFor("staff.entry", { clientId, entryId: txn.journal_entry_id })}
              >
                Open the journal entry
              </Link>
              . This transaction becomes &quot;Posted&quot; when that entry is approved and posted.
            </Alert>
          ) : (
            <>
              {txn.kind === "sale" ? (
                <div className="mb-3">
                  <Alert tone="info" title="This is a sale">
                    Record it as a sales invoice so it appears in receivables, aging and payments:{" "}
                    <Link
                      className="underline"
                      href={`${pathFor("staff.sales_invoice_new", { clientId })}?intake=${txn.id}`}
                    >
                      Record as a sales invoice
                    </Link>
                    . Or book it directly below (not both; the system prevents double booking).
                  </Alert>
                </div>
              ) : null}
              <p className="mb-3 text-sm text-[var(--muted)]">
                Choose the accounts. The entry goes through the normal review and approval before it
                is posted; nothing is posted automatically. A transaction can be booked only once.
              </p>
              <EntryForm
                clientId={clientId}
                accounts={(await listAccounts(clientId))
                  .filter((a) => a.is_postable && a.is_active)
                  .map((a) => ({ id: a.id, code: a.code, name: a.name }))}
                idempotencyKey={randomUUID()}
                defaultDate={txn.txn_date ?? todayPh()}
                prefill={{
                  entryDate: txn.txn_date ?? todayPh(),
                  memo: [labelOf(TXN_KINDS, txn.kind), txn.document_ref, txn.counterparty_name]
                    .filter(Boolean)
                    .join(" · ")
                    .slice(0, 500),
                  sourceType: "intake_transaction",
                  sourceRef: txn.id,
                  lines: [{ side: "debit" as const }, { side: "credit" as const }].map((l) => ({
                    account_id: "",
                    debit: l.side === "debit" ? (txn.gross_amount ?? "") : "",
                    credit: l.side === "credit" ? (txn.gross_amount ?? "") : "",
                    description: txn.description ?? "",
                    counterparty_name: txn.counterparty_name ?? "",
                    counterparty_tin: txn.counterparty_tin ?? "",
                    document_ref: txn.document_ref ?? "",
                  })),
                }}
              />
            </>
          )}
        </Section>
      ) : null}

      {staff && txn.status === "posted" && txn.journal_entry_id ? (
        <Section title="Books">
          <LinkButton href={pathFor("staff.entry", { clientId, entryId: txn.journal_entry_id })}>
            View the posted journal entry
          </LinkButton>
        </Section>
      ) : null}

      <Section title="History and comments">
        <Timeline items={timeline} />
        {writer || staff ? (
          <div className="mt-4">
            <CommentForm clientId={clientId} subject="transaction" subjectId={id} staff={staff} />
          </div>
        ) : null}
      </Section>

      {editable ? (
        <section id="edit" className="scroll-mt-20">
          <Section
            title={txn.status === "needs_correction" ? "Correct and resubmit" : "Edit draft"}
          >
            <TransactionForm
              clientId={clientId}
              idempotencyKey={randomUUID()}
              today={todayPh()}
              documentsHref={documentsHref}
              counterparties={(await listCounterparties(clientId, ["approved", "submitted"])).map(
                (c) => ({
                  id: c.id,
                  name: c.registered_name,
                  tin: c.tin,
                  kind: c.kind,
                }),
              )}
              documents={(await listDocuments(clientId)).map((d) => ({
                id: d.id,
                name: d.original_filename,
                category: d.category,
              }))}
              initial={{
                id: txn.id,
                rowVersion: txn.row_version,
                kind: txn.kind,
                txnDate: txn.txn_date ?? "",
                documentType: txn.document_type ?? "",
                documentRef: txn.document_ref ?? "",
                counterpartyId: txn.counterparty_id ?? "",
                counterpartyName: txn.counterparty_name ?? "",
                counterpartyTin: txn.counterparty_tin ?? "",
                description: txn.description ?? "",
                grossAmount: txn.gross_amount ?? "",
                vatAmount: txn.vat_amount_stated ?? "",
                whtAmount: txn.withholding_amount_stated ?? "",
                paymentMethod: txn.payment_method ?? "",
                lines: txn.lines.map((l) => ({
                  description: l.description ?? "",
                  quantity: l.quantity ?? "",
                  unit_price: l.unit_price ?? "",
                  amount: l.amount,
                  account_hint: l.account_hint ?? "",
                })),
                documentIds: txn.documents.map((d) => d.id),
              }}
            />
          </Section>
        </section>
      ) : null}
    </>
  );
}
