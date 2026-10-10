"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { ActionForm, Field, FieldError, Select, TextArea } from "@/components/ui/action-form";
import { saveTransactionAction } from "@/features/intake/actions";
import { formatAmount, fromCentavos, isValidAmount, toCentavos } from "@/lib/money/amount";
import { DOCUMENT_TYPES, PAYMENT_METHODS, requiredForKind, TXN_KINDS } from "@/lib/intake/rules";

interface Line {
  key: number;
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
  account_hint: string;
}

export interface TxnFormInitial {
  id: string;
  rowVersion: number;
  kind: string;
  txnDate: string;
  documentType: string;
  documentRef: string;
  counterpartyId: string;
  counterpartyName: string;
  counterpartyTin: string;
  description: string;
  grossAmount: string;
  vatAmount: string;
  whtAmount: string;
  paymentMethod: string;
  lines: Omit<Line, "key">[];
  documentIds: string[];
}

const INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-2";
const cents = (v: string) =>
  v && isValidAmount(v.replace(/,/g, "")) ? toCentavos(v.replace(/,/g, "")) : 0n;

/**
 * Generic transaction intake form (sales, purchases, expenses, collections,
 * payments, payroll, inventory). Two buttons: save a draft, or save and
 * submit for review. The idempotency key is fixed for this form instance, so
 * a double-click records one transaction. The server and database re-check
 * every rule shown here.
 */
export function TransactionForm({
  clientId,
  idempotencyKey,
  today,
  counterparties,
  documents,
  documentsHref,
  initial,
}: {
  clientId: string;
  idempotencyKey: string;
  today: string;
  counterparties: { id: string; name: string; tin: string | null; kind: string }[];
  documents: { id: string; name: string; category: string }[];
  documentsHref: string;
  initial?: TxnFormInitial;
}) {
  const [kind, setKind] = useState(initial?.kind ?? "purchase");
  const [counterpartyId, setCounterpartyId] = useState(initial?.counterpartyId ?? "");
  const [gross, setGross] = useState(initial?.grossAmount ?? "");
  const [itemize, setItemize] = useState((initial?.lines.length ?? 0) > 1);
  const [lines, setLines] = useState<Line[]>(() =>
    (initial?.lines.length
      ? initial.lines
      : [{ description: "", quantity: "", unit_price: "", amount: "", account_hint: "" }]
    ).map((l, i) => ({ ...l, key: i })),
  );
  const [nextKey, setNextKey] = useState(lines.length);
  const [docIds, setDocIds] = useState<string[]>(initial?.documentIds ?? []);
  const need = requiredForKind(kind);

  const lineTotal = useMemo(() => lines.reduce((s, l) => s + cents(l.amount), 0n), [lines]);
  const diff = cents(gross) - lineTotal;
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const partyOptions = [
    { value: "", label: "— Type a new name below —" },
    ...counterparties
      .filter(
        (c) =>
          kind === "other" ||
          c.kind === "both" ||
          c.kind === (["sale", "collection"].includes(kind) ? "customer" : "supplier"),
      )
      .map((c) => ({ value: c.id, label: c.tin ? `${c.name} (TIN ${c.tin})` : c.name })),
  ];

  return (
    <ActionForm
      action={saveTransactionAction}
      submitLabel="Save"
      className="flex flex-col gap-5"
      buttons={[
        { label: "Save draft", name: "intent", value: "save", variant: "secondary" },
        {
          label: "Save and submit for review",
          name: "intent",
          value: "submit",
          variant: "primary",
        },
      ]}
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="transactionId" value={initial?.id ?? ""} />
      <input type="hidden" name="expectedVersion" value={initial?.rowVersion ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="counterpartyId" value={counterpartyId} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          itemize
            ? lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unit_price: l.unit_price,
                amount: l.amount,
                account_hint: l.account_hint,
              }))
            : [],
        )}
      />
      <input type="hidden" name="documentIds" value={JSON.stringify(docIds)} />

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">1. What is it?</legend>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="txn-kind">
            Type
            <span aria-hidden className="text-[var(--danger)]">
              {" "}
              *
            </span>
          </label>
          <select
            id="txn-kind"
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            {TXN_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Date"
          name="txnDate"
          type="date"
          required
          defaultValue={initial?.txnDate ?? today}
        />
        <Select
          label="Document type"
          name="documentType"
          options={DOCUMENT_TYPES}
          defaultValue={initial?.documentType ?? ""}
        />
        <Field
          label={need.documentRef ? "Invoice / receipt no. *" : "Invoice / receipt no."}
          name="documentRef"
          defaultValue={initial?.documentRef}
          placeholder="e.g. SI-0451, OR-1001"
          maxLength={100}
          hint="Used to catch duplicates: the same number from the same customer/supplier is recorded once."
        />
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">
          2. {["sale", "collection"].includes(kind) ? "Customer" : "Supplier / payee"}
          {need.counterparty ? <span className="text-[var(--danger)]"> *</span> : null}
        </legend>
        {partyOptions.length > 1 ? (
          <div className="flex flex-col gap-1 text-sm sm:col-span-2">
            <label htmlFor="txn-party">Choose a saved customer/supplier</label>
            <select
              id="txn-party"
              value={counterpartyId}
              onChange={(e) => setCounterpartyId(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
            >
              {partyOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {counterpartyId ? null : (
          <>
            <Field
              label="Name"
              name="counterpartyName"
              defaultValue={initial?.counterpartyName}
              maxLength={200}
            />
            <Field
              label="TIN (optional)"
              name="counterpartyTin"
              defaultValue={initial?.counterpartyTin}
              placeholder="000-000-000-00000"
              inputMode="numeric"
            />
          </>
        )}
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">
          3. Amounts (as printed on the document)
        </legend>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="txn-gross">
            Total amount (₱)
            <span aria-hidden className="text-[var(--danger)]">
              {" "}
              *
            </span>
          </label>
          <input
            id="txn-gross"
            name="grossAmount"
            inputMode="decimal"
            placeholder="0.00"
            value={gross}
            onChange={(e) => setGross(e.target.value.trim())}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-right tabular-nums"
          />
          <FieldError name="grossAmount" />
        </div>
        <Select
          label="Payment method"
          name="paymentMethod"
          options={PAYMENT_METHODS}
          defaultValue={initial?.paymentMethod ?? ""}
        />
        <Field
          label="VAT shown on the document (optional)"
          name="vatAmount"
          defaultValue={initial?.vatAmount}
          inputMode="decimal"
          placeholder="0.00"
          hint="Copy it from the receipt. The platform does not compute tax."
        />
        <Field
          label="Tax withheld shown on the document (optional)"
          name="whtAmount"
          defaultValue={initial?.whtAmount}
          inputMode="decimal"
          placeholder="0.00"
        />
        <div className="sm:col-span-2">
          <TextArea
            label={need.description ? "Description *" : "Description"}
            name="description"
            defaultValue={initial?.description}
            maxLength={500}
            rows={2}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">4. Items (optional)</legend>
        <label className="mb-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={itemize} onChange={(e) => setItemize(e.target.checked)} />
          List the items separately (otherwise one line equal to the total is recorded)
        </label>
        {itemize ? (
          <div className="flex flex-col gap-2">
            {lines.map((l, i) => (
              <div
                key={l.key}
                className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_2.5rem]"
              >
                {(
                  [
                    ["description", "Item", "text"],
                    ["quantity", "Qty", "decimal"],
                    ["unit_price", "Unit price", "decimal"],
                    ["amount", "Amount", "decimal"],
                    ["account_hint", "Category (optional)", "text"],
                  ] as const
                ).map(([field, label, mode]) => (
                  <label
                    key={field}
                    className={`flex flex-col gap-1 text-xs ${field === "description" ? "col-span-2 md:col-span-1" : ""}`}
                  >
                    <span>
                      {label}
                      <span className="sr-only">, item {i + 1}</span>
                    </span>
                    <input
                      value={l[field]}
                      inputMode={mode === "decimal" ? "decimal" : undefined}
                      onChange={(e) => update(l.key, { [field]: e.target.value })}
                      className={`${INPUT} ${mode === "decimal" ? "text-right tabular-nums" : ""}`}
                    />
                  </label>
                ))}
                <div className="col-span-2 flex justify-end md:col-span-1 md:items-end">
                  <button
                    type="button"
                    aria-label={`Remove item ${i + 1}`}
                    disabled={lines.length <= 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface)] p-3 text-sm">
              <button
                type="button"
                onClick={() => {
                  setLines((ls) => [
                    ...ls,
                    {
                      key: nextKey,
                      description: "",
                      quantity: "",
                      unit_price: "",
                      amount: "",
                      account_hint: "",
                    },
                  ]);
                  setNextKey((k) => k + 1);
                }}
                className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5"
              >
                + Add item
              </button>
              <span aria-live="polite" className="tabular-nums">
                Items total {formatAmount(fromCentavos(lineTotal))}
                {gross && diff !== 0n ? (
                  <span className="ml-2 rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-[var(--warning)]">
                    differs from the total by {formatAmount(fromCentavos(diff < 0n ? -diff : diff))}
                  </span>
                ) : gross ? (
                  <span className="ml-2 rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-[var(--success)]">
                    ✓ matches
                  </span>
                ) : null}
              </span>
            </div>
            <FieldError name="lines" />
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">5. Supporting documents</legend>
        {documents.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No documents uploaded yet.{" "}
            <Link className="underline" href={documentsHref}>
              Upload receipts or invoices
            </Link>{" "}
            first, then attach them here.
          </p>
        ) : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-[var(--border)] p-2 text-sm">
            {documents.map((d) => (
              <li key={d.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={docIds.includes(d.id)}
                    onChange={(e) =>
                      setDocIds((ids) =>
                        e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id),
                      )
                    }
                  />
                  <span className="break-all">{d.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <p className="text-xs text-[var(--muted)]">
        Fields marked * are needed to submit; drafts can be incomplete. Submitted transactions are
        reviewed by the firm before anything is recorded in the books.
      </p>
    </ActionForm>
  );
}
