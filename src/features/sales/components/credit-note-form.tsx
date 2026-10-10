"use client";

import { useState } from "react";

import { ActionForm, Field, FieldError, Select } from "@/components/ui/action-form";
import { saveCreditNoteAction } from "@/features/sales/actions";
import { formatAmount, fromCentavos } from "@/lib/money/amount";
import { computeLine, TAX_CLASSES, totals, type TaxClass } from "@/lib/sales/calc";

const INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-2";

/** Credit note against a posted invoice (returns, price adjustments, corrections). */
export function CreditNoteForm({
  clientId,
  invoiceId,
  idempotencyKey,
  today,
  taxClasses,
  pricesIncludeVat,
  vatRate,
  outstanding,
}: {
  clientId: string;
  invoiceId: string;
  idempotencyKey: string;
  today: string;
  taxClasses: TaxClass[];
  pricesIncludeVat: boolean;
  vatRate: string;
  outstanding: string;
}) {
  const [lines, setLines] = useState([
    { key: 0, description: "", amount: "", tax_class: taxClasses[0] },
  ]);
  const computed = lines.map((l) =>
    computeLine(
      { quantity: "1", unitPrice: l.amount, discount: "", taxClass: l.tax_class },
      pricesIncludeVat,
      vatRate,
    ),
  );
  const t = totals(computed);
  return (
    <ActionForm
      action={saveCreditNoteAction}
      submitLabel="Record and submit for posting"
      variant="primary"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(lines.map(({ key: _k, ...l }) => (void _k, l)))}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Credit note no. *" name="creditNoteNo" maxLength={60} />
        <Field label="Date *" name="creditDate" type="date" defaultValue={today} />
        <Select
          label="Reason"
          name="reasonType"
          options={[
            { value: "return", label: "Goods returned" },
            { value: "price_adjustment", label: "Price adjustment" },
            { value: "discount", label: "Discount after sale" },
            { value: "correction", label: "Correction" },
          ]}
        />
        <Field label="Explanation *" name="reason" maxLength={500} />
      </div>
      {lines.map((l, i) => (
        <div
          key={l.key}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1.3fr)_2.5rem]"
        >
          <label className="flex flex-col gap-1 text-xs">
            <span>Description</span>
            <input
              value={l.description}
              onChange={(e) =>
                setLines((ls) =>
                  ls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                )
              }
              className={INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>Amount ({pricesIncludeVat ? "VAT-inclusive" : "before VAT"})</span>
            <input
              inputMode="decimal"
              value={l.amount}
              onChange={(e) =>
                setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
              }
              className={`${INPUT} text-right tabular-nums`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span>Tax class</span>
            <select
              value={l.tax_class}
              onChange={(e) =>
                setLines((ls) =>
                  ls.map((x, j) => (j === i ? { ...x, tax_class: e.target.value as TaxClass } : x)),
                )
              }
              className={INPUT}
            >
              {TAX_CLASSES.filter((c) => taxClasses.includes(c.value)).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label={`Remove line ${i + 1}`}
            disabled={lines.length <= 1}
            onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
            className="self-end rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm disabled:opacity-40"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <button
          type="button"
          onClick={() =>
            setLines((ls) => [
              ...ls,
              { key: Date.now(), description: "", amount: "", tax_class: taxClasses[0] },
            ])
          }
          className="rounded-md border border-[var(--border)] px-3 py-1.5"
        >
          + Add line
        </button>
        <span className="tabular-nums">
          Credit {formatAmount(fromCentavos(t.total))} (VAT {formatAmount(fromCentavos(t.vat))}) ·
          invoice balance {formatAmount(outstanding)}
        </span>
      </div>
      <FieldError name="lines" />
    </ActionForm>
  );
}
