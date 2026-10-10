"use client";

import { useMemo, useState } from "react";

import { ActionForm, Field, FieldError, Select } from "@/components/ui/action-form";
import { saveInvoiceAction } from "@/features/sales/actions";
import { formatAmount, fromCentavos } from "@/lib/money/amount";
import { computeLine, TAX_CLASSES, totals, type TaxClass } from "@/lib/sales/calc";

interface Line {
  key: number;
  description: string;
  quantity: string;
  unit_price: string;
  discount_amount: string;
  tax_class: TaxClass;
  revenue_account_id: string;
}
export type InvoiceLineInput = Omit<Line, "key">;

const INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-2";
const EMPTY: InvoiceLineInput = {
  description: "",
  quantity: "1",
  unit_price: "",
  discount_amount: "",
  tax_class: "vatable",
  revenue_account_id: "",
};
const money = (c: bigint) => formatAmount(fromCentavos(c));

/**
 * Records a sales invoice the client ISSUED (the platform does not issue
 * invoices; decision D-01). Totals shown here are a preview: the database
 * computes and stores the real amounts with the same rules.
 */
export function InvoiceForm({
  clientId,
  idempotencyKey,
  today,
  customers,
  revenueAccounts,
  vatRate,
  initial,
}: {
  clientId: string;
  idempotencyKey: string;
  today: string;
  customers: { id: string; name: string; terms: number | null }[];
  revenueAccounts: { id: string; label: string }[];
  vatRate: { rate: string; status: string };
  initial?: {
    invoiceId?: string;
    rowVersion?: number;
    counterpartyId: string;
    invoiceNo: string;
    invoiceDate: string;
    dueDate: string;
    saleType: string;
    pricesIncludeVat: boolean;
    memo: string;
    intakeTransactionId?: string;
    lines: InvoiceLineInput[];
  };
}) {
  const [inclusive, setInclusive] = useState(initial?.pricesIncludeVat ?? false);
  const [saleType, setSaleType] = useState(initial?.saleType ?? "credit");
  const [lines, setLines] = useState<Line[]>(() =>
    (initial?.lines.length ? initial.lines : [EMPTY]).map((l, i) => ({ ...l, key: i })),
  );
  const [nextKey, setNextKey] = useState(lines.length);
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const computed = useMemo(
    () =>
      lines.map((l) =>
        computeLine(
          {
            quantity: l.quantity,
            unitPrice: l.unit_price,
            discount: l.discount_amount,
            taxClass: l.tax_class,
          },
          inclusive,
          vatRate.rate,
        ),
      ),
    [lines, inclusive, vatRate.rate],
  );
  const t = totals(computed);
  const pct = `${(Number(vatRate.rate) * 100).toFixed(2).replace(/\.?0+$/, "")}%`;

  return (
    <ActionForm
      action={saveInvoiceAction}
      submitLabel="Save"
      className="flex flex-col gap-5"
      buttons={[
        { label: "Save draft", name: "intent", value: "save" },
        {
          label: "Save and submit for posting",
          name: "intent",
          value: "submit",
          variant: "primary",
        },
      ]}
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="invoiceId" value={initial?.invoiceId ?? ""} />
      <input type="hidden" name="expectedVersion" value={initial?.rowVersion ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="intakeTransactionId" value={initial?.intakeTransactionId ?? ""} />
      <input type="hidden" name="pricesIncludeVat" value={String(inclusive)} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(lines.map(({ key: _k, ...l }) => (void _k, l)))}
      />

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Invoice (as issued by the client)</legend>
        <Select
          label="Customer *"
          name="counterpartyId"
          defaultValue={initial?.counterpartyId ?? ""}
          options={[
            { value: "", label: "Choose…" },
            ...customers.map((c) => ({
              value: c.id,
              label: c.terms ? `${c.name} (${c.terms}-day terms)` : c.name,
            })),
          ]}
        />
        <Field
          label="Invoice no. *"
          name="invoiceNo"
          defaultValue={initial?.invoiceNo}
          maxLength={60}
          hint="The number printed on the client's invoice."
        />
        <Field
          label="Invoice date *"
          name="invoiceDate"
          type="date"
          defaultValue={initial?.invoiceDate ?? today}
        />
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="sale-type">Sale type</label>
          <select
            id="sale-type"
            name="saleType"
            value={saleType}
            onChange={(e) => setSaleType(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            <option value="credit">Credit (on account)</option>
            <option value="cash">Cash (due on the invoice date)</option>
          </select>
        </div>
        {saleType === "credit" ? (
          <Field
            label="Due date"
            name="dueDate"
            type="date"
            defaultValue={initial?.dueDate ?? ""}
            hint="Leave blank to use the customer's credit terms."
          />
        ) : null}
        <Field label="Memo" name="memo" defaultValue={initial?.memo} maxLength={500} />
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Lines</legend>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
          />
          Prices on the invoice already include VAT
        </label>
        <div className="flex flex-col gap-2">
          {lines.map((l, i) => {
            const c = computed[i];
            return (
              <div
                key={l.key}
                className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 md:grid-cols-[minmax(0,3fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_2.5rem]"
              >
                {(
                  [
                    ["description", "Description", "text"],
                    ["quantity", "Qty", "decimal"],
                    ["unit_price", "Unit price", "decimal"],
                    ["discount_amount", "Discount", "decimal"],
                  ] as const
                ).map(([f, label, mode]) => (
                  <label
                    key={f}
                    className={`flex flex-col gap-1 text-xs ${f === "description" ? "col-span-2 md:col-span-1" : ""}`}
                  >
                    <span>
                      {label}
                      <span className="sr-only">, line {i + 1}</span>
                    </span>
                    <input
                      value={l[f]}
                      inputMode={mode === "decimal" ? "decimal" : undefined}
                      onChange={(e) => update(l.key, { [f]: e.target.value })}
                      className={`${INPUT} ${mode === "decimal" ? "text-right tabular-nums" : ""}`}
                    />
                  </label>
                ))}
                <label className="flex flex-col gap-1 text-xs">
                  <span>
                    Tax class<span className="sr-only">, line {i + 1}</span>
                  </span>
                  <select
                    value={l.tax_class}
                    onChange={(e) => update(l.key, { tax_class: e.target.value as TaxClass })}
                    className={INPUT}
                  >
                    {TAX_CLASSES.map((tc) => (
                      <option key={tc.value} value={tc.value}>
                        {tc.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span>
                    Revenue account<span className="sr-only">, line {i + 1}</span>
                  </span>
                  <select
                    value={l.revenue_account_id}
                    onChange={(e) => update(l.key, { revenue_account_id: e.target.value })}
                    className={INPUT}
                  >
                    <option value="">Default (Sales)</option>
                    {revenueAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div
                  className="flex flex-col justify-end text-right text-xs tabular-nums"
                  aria-live="polite"
                >
                  {c ? (
                    <>
                      <span>Net {money(c.net)}</span>
                      <span className="text-[var(--muted)]">VAT {money(c.vat)}</span>
                    </>
                  ) : (
                    <span className="text-[var(--danger)]">Check the numbers</span>
                  )}
                </div>
                <div className="col-span-2 flex justify-end md:col-span-1 md:items-end">
                  <button
                    type="button"
                    aria-label={`Remove line ${i + 1}`}
                    disabled={lines.length <= 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--surface)] p-3 text-sm">
          <button
            type="button"
            onClick={() => {
              setLines((ls) => [...ls, { ...EMPTY, key: nextKey }]);
              setNextKey((k) => k + 1);
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5"
          >
            + Add line
          </button>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
            <div className="flex gap-2">
              <dt className="text-[var(--muted)]">Net of VAT</dt>
              <dd>{money(t.net)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--muted)]">VAT ({pct})</dt>
              <dd>{money(t.vat)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--muted)]">Amount due</dt>
              <dd className="font-semibold">{money(t.total)}</dd>
            </div>
          </dl>
        </div>
        <FieldError name="lines" />
        <p className="mt-2 text-xs text-[var(--muted)]">
          VAT rate {pct} from the tax-rate table (
          {vatRate.status === "signed_off" ? "signed off" : "pending CPA sign-off"}). VAT is
          computed per line and rounded to the centavo. Compare the totals with the printed invoice
          before submitting.
        </p>
      </fieldset>
    </ActionForm>
  );
}
