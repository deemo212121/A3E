"use client";

import { useState } from "react";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { saveReceiptAction } from "@/features/sales/actions";
import { formatAmount, fromCentavos, isValidAmount, toCentavos } from "@/lib/money/amount";

const cents = (v: string) => {
  const t = v.replace(/,/g, "").trim();
  return t && isValidAmount(t) ? toCentavos(t) : 0n;
};
const money = (c: bigint) => formatAmount(fromCentavos(c < 0n ? -c : c));
const INPUT =
  "w-28 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-right tabular-nums";

/**
 * Customer receipt with allocation to open invoices. Unapplied money becomes
 * a customer advance when posted. Balances are re-checked by the database at
 * posting time (two receipts can never over-pay one invoice).
 */
export function ReceiptForm({
  clientId,
  idempotencyKey,
  today,
  customers,
  depositAccounts,
  openInvoices,
}: {
  clientId: string;
  idempotencyKey: string;
  today: string;
  customers: { id: string; name: string }[];
  depositAccounts: { id: string; label: string }[];
  openInvoices: {
    invoice_id: string;
    invoice_no: string;
    counterparty_id: string;
    due_date: string;
    outstanding: string;
  }[];
}) {
  const [customer, setCustomer] = useState("");
  const [received, setReceived] = useState("");
  const [withheld, setWithheld] = useState("");
  const [applied, setApplied] = useState<Record<string, string>>({});
  const invoices = openInvoices.filter((i) => i.counterparty_id === customer);
  const appliedTotal = invoices.reduce((s, i) => s + cents(applied[i.invoice_id] ?? ""), 0n);
  const available = cents(received) + cents(withheld);
  const rest = available - appliedTotal;

  return (
    <ActionForm
      action={saveReceiptAction}
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
      <input type="hidden" name="counterpartyId" value={customer} />
      <input
        type="hidden"
        name="allocations"
        value={JSON.stringify(
          invoices
            .map((i) => ({
              invoice_id: i.invoice_id,
              amount: (applied[i.invoice_id] ?? "").replace(/,/g, ""),
            }))
            .filter((a) => a.amount),
        )}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="rc-customer">Customer *</label>
          <select
            id="rc-customer"
            value={customer}
            onChange={(e) => {
              setCustomer(e.target.value);
              setApplied({});
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            <option value="">Choose…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Receipt no. *"
          name="receiptNo"
          maxLength={60}
          hint="The client's official/collection receipt number."
        />
        <Field label="Receipt date *" name="receiptDate" type="date" defaultValue={today} />
        <Select
          label="Paid by"
          name="paymentMethod"
          options={[
            { value: "cash", label: "Cash" },
            { value: "check", label: "Check" },
            { value: "bank_transfer", label: "Bank transfer" },
            { value: "e_wallet", label: "E-wallet" },
            { value: "credit_card", label: "Credit card" },
            { value: "other", label: "Other" },
          ]}
        />
        <Select
          label="Deposited to *"
          name="depositAccountId"
          options={[
            { value: "", label: "Choose…" },
            ...depositAccounts.map((a) => ({ value: a.id, label: a.label })),
          ]}
        />
        <Field label="Check / reference no." name="reference" maxLength={100} />
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="rc-amount">Amount received (₱) *</label>
          <input
            id="rc-amount"
            name="amountReceived"
            inputMode="decimal"
            value={received}
            onChange={(e) => setReceived(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-right tabular-nums"
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="rc-wht">Tax withheld by the customer (₱)</label>
          <input
            id="rc-wht"
            name="withholdingAmount"
            inputMode="decimal"
            value={withheld}
            onChange={(e) => setWithheld(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-right tabular-nums"
          />
          <p className="text-xs text-[var(--muted)]">
            As stated on the customer&apos;s certificate (BIR Form 2307). Not computed.
          </p>
        </div>
        <Field label="Memo" name="memo" maxLength={500} />
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Apply to open invoices</legend>
        {!customer ? (
          <p className="text-sm text-[var(--muted)]">
            Choose the customer to see their open invoices.
          </p>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No open invoices. The whole amount will be recorded as a customer advance.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="py-1 font-medium">Invoice</th>
                <th className="py-1 font-medium">Due</th>
                <th className="py-1 text-right font-medium">Outstanding</th>
                <th className="py-1 text-right font-medium">Apply</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.invoice_id} className="border-t border-[var(--border)]">
                  <td className="py-1.5">{i.invoice_no}</td>
                  <td className="py-1.5">{i.due_date}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatAmount(i.outstanding)}</td>
                  <td className="py-1.5 text-right">
                    <label className="sr-only" htmlFor={`ap-${i.invoice_id}`}>
                      Apply to {i.invoice_no}
                    </label>
                    <input
                      id={`ap-${i.invoice_id}`}
                      inputMode="decimal"
                      value={applied[i.invoice_id] ?? ""}
                      onChange={(e) =>
                        setApplied((a) => ({ ...a, [i.invoice_id]: e.target.value }))
                      }
                      className={INPUT}
                    />
                    <button
                      type="button"
                      className="ml-2 text-xs underline"
                      onClick={() => setApplied((a) => ({ ...a, [i.invoice_id]: i.outstanding }))}
                    >
                      Full
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p
          className="mt-3 rounded-lg bg-[var(--surface)] p-3 text-sm tabular-nums"
          aria-live="polite"
        >
          Received + withheld {money(available)} · applied {money(appliedTotal)} ·{" "}
          {rest < 0n ? (
            <span className="text-[var(--danger)]">over-applied by {money(rest)}</span>
          ) : (
            <span>unapplied (customer advance) {money(rest)}</span>
          )}
        </p>
      </fieldset>
    </ActionForm>
  );
}
