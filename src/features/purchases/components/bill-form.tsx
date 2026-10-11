"use client";

import { useState } from "react";

import { ActionForm, Field, FieldError } from "@/components/ui/action-form";
import { savePurchaseBillLabel } from "@/features/purchases/labels";
import { saveBillAction } from "@/features/purchases/actions";
import { formatAmount, fromCentavos } from "@/lib/money/amount";
import { computeLine, TAX_CLASSES, type TaxClass } from "@/lib/sales/calc";

interface Line {
  key: number;
  description: string;
  quantity: string;
  unit_price: string;
  discount_amount: string;
  tax_class: TaxClass;
  vat_category: string;
  category_id: string;
  withholding_code_id: string;
  source_supplier_name: string;
  source_supplier_tin: string;
  source_document_ref: string;
}
const EMPTY: Omit<Line, "key"> = {
  description: "",
  quantity: "1",
  unit_price: "",
  discount_amount: "",
  tax_class: "vatable",
  vat_category: "goods",
  category_id: "",
  withholding_code_id: "",
  source_supplier_name: "",
  source_supplier_tin: "",
  source_document_ref: "",
};
const INPUT =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-2";
const money = (c: bigint) => formatAmount(fromCentavos(c));
const rateScaled = (r: string) => {
  const [w, f = ""] = r.split(".");
  return BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};

export interface CodeOption {
  id: string;
  label: string;
  rate: string;
  base: string;
  signedOff: boolean;
}

/**
 * Records a supplier bill, a cash purchase or a reimbursement from the
 * documents received. Totals and withholding shown here are a preview; the
 * database computes and stores the real amounts with the same rules.
 */
export function BillForm({
  clientId,
  idempotencyKey,
  today,
  payees,
  categories,
  codes,
  cashAccounts,
  documents,
  vatRate,
  intake,
}: {
  clientId: string;
  idempotencyKey: string;
  today: string;
  payees: { id: string; name: string; kind: string }[];
  categories: { id: string; label: string }[];
  codes: CodeOption[];
  cashAccounts: { id: string; label: string }[];
  documents: { id: string; name: string }[];
  vatRate: { rate: string; status: string };
  intake?: {
    id: string;
    counterpartyId: string;
    billNo: string;
    date: string;
    lines: Omit<Line, "key">[];
  };
}) {
  const [type, setType] = useState("bill");
  const [inclusive, setInclusive] = useState(Boolean(intake));
  const [lines, setLines] = useState<Line[]>(() =>
    (intake?.lines.length ? intake.lines : [EMPTY]).map((l, i) => ({ ...l, key: i })),
  );
  const [nextKey, setNextKey] = useState(lines.length);
  const [docIds, setDocIds] = useState<string[]>([]);
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const rows = lines.map((l) => {
    const c = computeLine(
      {
        quantity: l.quantity,
        unitPrice: l.unit_price,
        discount: l.discount_amount,
        taxClass: l.tax_class,
      },
      inclusive,
      vatRate.rate,
    );
    const code = codes.find((x) => x.id === l.withholding_code_id);
    let wht = 0n;
    if (c && code) {
      const base = code.base === "gross" ? c.net + c.vat : c.net;
      wht = (2n * base * rateScaled(code.rate) + 1_000_000n) / 2_000_000n;
    }
    return { c, wht };
  });
  const net = rows.reduce((s, r) => s + (r.c?.net ?? 0n), 0n);
  const vat = rows.reduce((s, r) => s + (r.c?.vat ?? 0n), 0n);
  const wht = rows.reduce((s, r) => s + r.wht, 0n);
  const payeeList = payees.filter((p) =>
    type === "reimbursement" ? p.kind !== "customer" : p.kind === "supplier" || p.kind === "both",
  );

  return (
    <ActionForm
      action={saveBillAction}
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
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="pricesIncludeVat" value={String(inclusive)} />
      <input type="hidden" name="intakeTransactionId" value={intake?.id ?? ""} />
      <input type="hidden" name="documentIds" value={JSON.stringify(docIds)} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          lines.map(
            ({ key: _k, ...l }) => (
              void _k,
              { ...l, vat_category: l.tax_class === "vatable" ? l.vat_category : "" }
            ),
          ),
        )}
      />

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Document received</legend>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="bill-type">Type</label>
          <select
            id="bill-type"
            name="billType"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            <option value="bill">Supplier bill (pay later)</option>
            <option value="cash_purchase">Cash purchase (already paid)</option>
            <option value="reimbursement">Reimbursement (employee/payee)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="bill-payee">{type === "reimbursement" ? "Payee *" : "Supplier *"}</label>
          <select
            id="bill-payee"
            name="counterpartyId"
            defaultValue={intake?.counterpartyId ?? ""}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            <option value="">Choose…</option>
            {payeeList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={type === "reimbursement" ? "Claim no. *" : "Supplier invoice / OR no. *"}
          name="billNo"
          defaultValue={intake?.billNo}
          maxLength={60}
          hint="Duplicates from the same supplier are refused."
        />
        <Field label="Date *" name="billDate" type="date" defaultValue={intake?.date ?? today} />
        {type === "cash_purchase" ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="bill-paid">Paid from *</label>
            <select
              id="bill-paid"
              name="paidFromAccountId"
              className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
            >
              <option value="">Choose…</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <Field
            label="Due date"
            name="dueDate"
            type="date"
            hint="Blank = supplier's terms, or the bill date."
          />
        )}
        <Field label="Memo" name="memo" maxLength={500} />
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Lines</legend>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
          />
          Amounts on the document include VAT
        </label>
        <div className="flex flex-col gap-2">
          {lines.map((l, i) => {
            const r = rows[i];
            return (
              <div
                key={l.key}
                className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 md:grid-cols-6"
              >
                <label className="col-span-2 flex flex-col gap-1 text-xs">
                  <span>
                    Category *<span className="sr-only">, line {i + 1}</span>
                  </span>
                  <select
                    value={l.category_id}
                    onChange={(e) => update(l.key, { category_id: e.target.value })}
                    className={INPUT}
                  >
                    <option value="">Choose…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="col-span-2 flex flex-col gap-1 text-xs">
                  <span>Description</span>
                  <input
                    value={l.description}
                    onChange={(e) => update(l.key, { description: e.target.value })}
                    className={INPUT}
                  />
                </label>
                {(["quantity", "unit_price"] as const).map((f) => (
                  <label key={f} className="flex flex-col gap-1 text-xs">
                    <span>{f === "quantity" ? "Qty" : "Unit price"}</span>
                    <input
                      inputMode="decimal"
                      value={l[f]}
                      onChange={(e) => update(l.key, { [f]: e.target.value })}
                      className={`${INPUT} text-right tabular-nums`}
                    />
                  </label>
                ))}
                <label className="flex flex-col gap-1 text-xs">
                  <span>Discount</span>
                  <input
                    inputMode="decimal"
                    value={l.discount_amount}
                    onChange={(e) => update(l.key, { discount_amount: e.target.value })}
                    className={`${INPUT} text-right tabular-nums`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span>Tax class</span>
                  <select
                    value={l.tax_class}
                    onChange={(e) => update(l.key, { tax_class: e.target.value as TaxClass })}
                    className={INPUT}
                  >
                    {TAX_CLASSES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                {l.tax_class === "vatable" ? (
                  <label className="flex flex-col gap-1 text-xs">
                    <span>VAT on</span>
                    <select
                      value={l.vat_category}
                      onChange={(e) => update(l.key, { vat_category: e.target.value })}
                      className={INPUT}
                    >
                      <option value="goods">Goods</option>
                      <option value="services">Services</option>
                      <option value="capital_goods">Capital goods</option>
                    </select>
                  </label>
                ) : null}
                <label className="col-span-2 flex flex-col gap-1 text-xs">
                  <span>Withholding code</span>
                  <select
                    value={l.withholding_code_id}
                    onChange={(e) => update(l.key, { withholding_code_id: e.target.value })}
                    className={INPUT}
                  >
                    <option value="">None</option>
                    {codes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                        {c.signedOff ? "" : " (NOT signed off)"}
                      </option>
                    ))}
                  </select>
                </label>
                {type === "reimbursement" ? (
                  <>
                    <label className="col-span-2 flex flex-col gap-1 text-xs">
                      <span>Receipt from (supplier)</span>
                      <input
                        value={l.source_supplier_name}
                        onChange={(e) => update(l.key, { source_supplier_name: e.target.value })}
                        className={INPUT}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span>Supplier TIN</span>
                      <input
                        value={l.source_supplier_tin}
                        onChange={(e) => update(l.key, { source_supplier_tin: e.target.value })}
                        className={INPUT}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span>Receipt no.</span>
                      <input
                        value={l.source_document_ref}
                        onChange={(e) => update(l.key, { source_document_ref: e.target.value })}
                        className={INPUT}
                      />
                    </label>
                  </>
                ) : null}
                <div className="col-span-2 flex items-end justify-between gap-2 text-xs tabular-nums md:col-span-6">
                  <span aria-live="polite">
                    {r.c ? (
                      `Net ${money(r.c.net)} · VAT ${money(r.c.vat)}${r.wht ? ` · withholding ${money(r.wht)}` : ""}`
                    ) : (
                      <span className="text-[var(--danger)]">Check the numbers</span>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove line ${i + 1}`}
                    disabled={lines.length <= 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="rounded-md border border-[var(--border)] px-2.5 py-1 disabled:opacity-40"
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
          <span className="tabular-nums">
            Net {money(net)} · VAT {money(vat)} · total {money(net + vat)} · withheld {money(wht)} ·{" "}
            <strong>
              {savePurchaseBillLabel(type)} {money(net + vat - wht)}
            </strong>
          </span>
        </div>
        <FieldError name="lines" />
        <p className="mt-2 text-xs text-[var(--muted)]">
          Withholding codes and rates come from the firm&apos;s signed-off configuration; a bill
          using a code that is not signed off cannot be posted. VAT rate from the tax-rate table (
          {vatRate.status === "signed_off" ? "signed off" : "pending CPA sign-off"}).
        </p>
      </fieldset>

      {documents.length > 0 ? (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Supporting documents</legend>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-[var(--border)] p-2 text-sm">
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
        </fieldset>
      ) : null}
    </ActionForm>
  );
}
