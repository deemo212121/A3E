"use client";

import { useState } from "react";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { savePaymentAction } from "@/features/purchases/actions";
import { formatAmount, fromCentavos, isValidAmount, toCentavos } from "@/lib/money/amount";

const cents = (v: string) => {
  const t = v.replace(/,/g, "").trim();
  return t && isValidAmount(t) ? toCentavos(t) : 0n;
};
const money = (c: bigint) => formatAmount(fromCentavos(c < 0n ? -c : c));

/** Payment to a supplier or payee, applied to open bills; the rest becomes an advance. */
export function PaymentForm({
  clientId,
  idempotencyKey,
  today,
  payees,
  cashAccounts,
  openBills,
}: {
  clientId: string;
  idempotencyKey: string;
  today: string;
  payees: { id: string; name: string }[];
  cashAccounts: { id: string; label: string }[];
  openBills: {
    bill_id: string;
    bill_no: string;
    counterparty_id: string;
    due_date: string;
    outstanding: string;
  }[];
}) {
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [applied, setApplied] = useState<Record<string, string>>({});
  const bills = openBills.filter((b) => b.counterparty_id === payee);
  const appliedTotal = bills.reduce((s, b) => s + cents(applied[b.bill_id] ?? ""), 0n);
  const rest = cents(amount) - appliedTotal;
  return (
    <ActionForm
      action={savePaymentAction}
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
      <input type="hidden" name="counterpartyId" value={payee} />
      <input
        type="hidden"
        name="allocations"
        value={JSON.stringify(
          bills
            .map((b) => ({
              bill_id: b.bill_id,
              amount: (applied[b.bill_id] ?? "").replace(/,/g, ""),
            }))
            .filter((a) => a.amount),
        )}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="pay-payee">Supplier / payee *</label>
          <select
            id="pay-payee"
            value={payee}
            onChange={(e) => {
              setPayee(e.target.value);
              setApplied({});
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
          >
            <option value="">Choose…</option>
            {payees.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <Field label="Voucher / check no. *" name="paymentNo" maxLength={60} />
        <Field label="Payment date *" name="paymentDate" type="date" defaultValue={today} />
        <Select
          label="Paid by"
          name="paymentMethod"
          defaultValue="check"
          options={[
            { value: "check", label: "Check" },
            { value: "cash", label: "Cash" },
            { value: "bank_transfer", label: "Bank transfer" },
            { value: "e_wallet", label: "E-wallet" },
            { value: "credit_card", label: "Credit card" },
            { value: "other", label: "Other" },
          ]}
        />
        <Select
          label="Paid from *"
          name="paidFromAccountId"
          options={[
            { value: "", label: "Choose…" },
            ...cashAccounts.map((a) => ({ value: a.id, label: a.label })),
          ]}
        />
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="pay-amount">Amount paid (₱) *</label>
          <input
            id="pay-amount"
            name="amountPaid"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-right tabular-nums"
          />
        </div>
        <Field label="Reference" name="reference" maxLength={100} />
        <Field label="Memo" name="memo" maxLength={500} />
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Apply to open bills</legend>
        {!payee ? (
          <p className="text-sm text-[var(--muted)]">
            Choose the supplier to see their open bills.
          </p>
        ) : bills.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No open bills. The payment will be recorded as an advance to the supplier.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="py-1 font-medium">Bill</th>
                <th className="py-1 font-medium">Due</th>
                <th className="py-1 text-right font-medium">Outstanding</th>
                <th className="py-1 text-right font-medium">Apply</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.bill_id} className="border-t border-[var(--border)]">
                  <td className="py-1.5">{b.bill_no}</td>
                  <td className="py-1.5">{b.due_date}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatAmount(b.outstanding)}</td>
                  <td className="py-1.5 text-right">
                    <label className="sr-only" htmlFor={`ap-${b.bill_id}`}>
                      Apply to {b.bill_no}
                    </label>
                    <input
                      id={`ap-${b.bill_id}`}
                      inputMode="decimal"
                      value={applied[b.bill_id] ?? ""}
                      onChange={(e) => setApplied((a) => ({ ...a, [b.bill_id]: e.target.value }))}
                      className="w-28 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-right tabular-nums"
                    />
                    <button
                      type="button"
                      className="ml-2 text-xs underline"
                      onClick={() => setApplied((a) => ({ ...a, [b.bill_id]: b.outstanding }))}
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
          Paid {money(cents(amount))} · applied {money(appliedTotal)} ·{" "}
          {rest < 0n ? (
            <span className="text-[var(--danger)]">over-applied by {money(rest)}</span>
          ) : (
            <span>advance to supplier {money(rest)}</span>
          )}
        </p>
      </fieldset>
    </ActionForm>
  );
}
