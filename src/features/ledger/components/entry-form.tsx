"use client";

import { useMemo, useState } from "react";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { saveDraftAction } from "@/features/ledger/actions";
import { formatAmount, fromCentavos, isValidAmount, toCentavos } from "@/lib/money/amount";

interface AccountOption {
  id: string;
  code: string;
  name: string;
}

interface LineState {
  key: number;
  account_id: string;
  debit: string;
  credit: string;
  description: string;
  counterparty_name: string;
  counterparty_tin: string;
  document_ref: string;
}

const EMPTY_LINE = {
  account_id: "",
  debit: "",
  credit: "",
  description: "",
  counterparty_name: "",
  counterparty_tin: "",
  document_ref: "",
};

const hasDetails = (l: Omit<LineState, "key">) =>
  Boolean(l.counterparty_name || l.counterparty_tin || l.document_ref);

const INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-2";

const cents = (v: string) => (v !== "" && isValidAmount(v) ? toCentavos(v) : 0n);

/**
 * Journal entry editor. Totals are computed in integer centavos for display;
 * the DATABASE re-validates and enforces balancing. The idempotency key is
 * fixed for this form instance, so double-submits create one entry.
 */
export function EntryForm({
  clientId,
  accounts,
  idempotencyKey,
  defaultDate,
  initial,
  prefill,
}: {
  clientId: string;
  accounts: AccountOption[];
  idempotencyKey: string;
  defaultDate: string;
  initial?: {
    entryId: string;
    entryDate: string;
    entryType: string;
    memo: string;
    sourceType: string;
    sourceRef: string;
    lines: Omit<LineState, "key">[];
  };
  /** Defaults for a NEW entry (e.g. booking an approved intake transaction). */
  prefill?: {
    entryDate: string;
    memo: string;
    sourceType: string;
    sourceRef: string;
    lines: Omit<LineState, "key">[];
  };
}) {
  const seed = initial ?? prefill;
  const [lines, setLines] = useState<LineState[]>(() =>
    (seed?.lines.length ? seed.lines : [EMPTY_LINE, EMPTY_LINE]).map((l, i) => ({
      ...l,
      key: i,
    })),
  );
  const [nextKey, setNextKey] = useState(lines.length);
  const anyDetails = lines.some(hasDetails);
  const [showDetails, setShowDetails] = useState(anyDetails);

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + cents(l.debit), 0n);
    const credit = lines.reduce((s, l) => s + cents(l.credit), 0n);
    return { debit, credit, diff: debit - credit };
  }, [lines]);

  const update = (key: number, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const payload = JSON.stringify(
    lines.map((l) => ({
      account_id: l.account_id,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
      counterparty_name: l.counterparty_name,
      counterparty_tin: l.counterparty_tin,
      document_ref: l.document_ref,
    })),
  );

  return (
    <ActionForm
      action={saveDraftAction}
      submitLabel={initial ? "Save draft" : "Create draft"}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="entryId" value={initial?.entryId ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="lines" value={payload} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Entry date"
          name="entryDate"
          type="date"
          required
          defaultValue={seed?.entryDate ?? defaultDate}
        />
        <Select
          label="Entry type"
          name="entryType"
          defaultValue={initial?.entryType ?? "general"}
          options={[
            { value: "general", label: "General" },
            { value: "adjusting", label: "Adjusting" },
            { value: "opening", label: "Opening balances" },
            { value: "closing", label: "Closing" },
          ]}
        />
        <Field label="Memo" name="memo" defaultValue={seed?.memo ?? ""} />
        <Field
          label="Source type (optional)"
          name="sourceType"
          defaultValue={seed?.sourceType ?? ""}
          hint="e.g. sales_invoice, official_receipt"
        />
        <Field
          label="Source reference (optional)"
          name="sourceRef"
          defaultValue={seed?.sourceRef ?? ""}
          hint="e.g. SI-0001. A source can have only one live entry."
        />
      </div>

      <fieldset className="mt-2">
        <legend className="mb-2 text-sm font-medium">Lines</legend>
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={showDetails || anyDetails}
            disabled={anyDetails}
            onChange={(e) => setShowDetails(e.target.checked)}
          />
          <span>
            Record supplier/customer, TIN and receipt or invoice no. per line
            <span className="block text-xs text-[var(--muted)]">
              As in the cash disbursement and cash receipts books. Optional; frozen once posted.
            </span>
          </span>
        </label>
        {/* Header row (desktop only); on phones each line is a labelled card. */}
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_2.5rem] gap-2 px-1 pb-1 text-xs font-medium text-[var(--muted)] md:grid"
        >
          <span>Account</span>
          <span className="text-right">Debit</span>
          <span className="text-right">Credit</span>
          <span>Description</span>
          <span />
        </div>
        <ol className="flex flex-col gap-2">
          {lines.map((l, i) => (
            <li
              key={l.key}
              className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_2.5rem] md:rounded-none md:border-0 md:p-0"
            >
              <label className="col-span-2 flex flex-col gap-1 text-xs md:col-span-1">
                <span className="md:sr-only">Account, line {i + 1}</span>
                <select
                  value={l.account_id}
                  onChange={(e) => update(l.key, { account_id: e.target.value })}
                  className={INPUT}
                >
                  <option value="">Choose an account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </label>
              {(["debit", "credit"] as const).map((side) => (
                <label key={side} className="flex flex-col gap-1 text-xs">
                  <span className="md:sr-only">
                    {side === "debit" ? "Debit" : "Credit"}, line {i + 1}
                  </span>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={l[side]}
                    aria-invalid={l[side] !== "" && !isValidAmount(l[side]) ? true : undefined}
                    onChange={(e) => update(l.key, { [side]: e.target.value.trim() })}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-2 text-right tabular-nums aria-[invalid=true]:border-[var(--danger)]"
                  />
                </label>
              ))}
              <label className="col-span-2 flex flex-col gap-1 text-xs md:col-span-1">
                <span className="md:sr-only">Description, line {i + 1}</span>
                <input
                  value={l.description}
                  onChange={(e) => update(l.key, { description: e.target.value })}
                  className={INPUT}
                />
              </label>
              {showDetails || anyDetails ? (
                <div className="col-span-2 grid grid-cols-1 gap-2 rounded-md bg-[var(--surface)] p-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] md:order-last md:col-span-5">
                  {(
                    [
                      ["counterparty_name", "Supplier / customer", "e.g. ABC Hardware Inc."],
                      ["counterparty_tin", "TIN", "000-000-000-00000"],
                      ["document_ref", "Receipt / invoice no.", "e.g. OR-1234, SI-0451"],
                    ] as const
                  ).map(([field, label, placeholder]) => (
                    <label key={field} className="flex flex-col gap-1 text-xs">
                      <span>
                        {label}
                        <span className="sr-only">, line {i + 1}</span>
                      </span>
                      <input
                        value={l[field]}
                        placeholder={placeholder}
                        inputMode={field === "counterparty_tin" ? "numeric" : undefined}
                        maxLength={field === "counterparty_name" ? 200 : 100}
                        onChange={(e) => update(l.key, { [field]: e.target.value })}
                        className={INPUT}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="col-span-2 flex justify-end md:col-span-1 md:items-center">
                <button
                  type="button"
                  aria-label={`Remove line ${i + 1}`}
                  disabled={lines.length <= 2}
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm disabled:opacity-40"
                >
                  <span className="md:hidden">Remove line</span>
                  <span aria-hidden className="hidden md:inline">
                    ×
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--surface)] p-3 text-sm">
          <button
            type="button"
            onClick={() => {
              setLines((ls) => [...ls, { ...EMPTY_LINE, key: nextKey }]);
              setNextKey((k) => k + 1);
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5"
          >
            + Add line
          </button>
          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 tabular-nums">
            <div className="flex gap-2">
              <dt className="text-[var(--muted)]">Debits</dt>
              <dd className="font-medium">{formatAmount(fromCentavos(totals.debit))}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--muted)]">Credits</dt>
              <dd className="font-medium">{formatAmount(fromCentavos(totals.credit))}</dd>
            </div>
            <div aria-live="polite">
              {totals.diff === 0n && totals.debit > 0n ? (
                <span className="rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-[var(--success)]">
                  ✓ Balanced
                </span>
              ) : (
                <span className="rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-[var(--warning)]">
                  Off by {formatAmount(fromCentavos(totals.diff < 0n ? -totals.diff : totals.diff))}
                </span>
              )}
            </div>
          </dl>
        </div>
      </fieldset>
      <p className="text-xs text-[var(--muted)]">
        Drafts may be unbalanced. Submitting for review requires a balanced entry, which the server
        and database verify again.
      </p>
    </ActionForm>
  );
}
