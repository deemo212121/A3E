"use client";

import { useState } from "react";

import { ActionForm } from "@/components/ui/action-form";
import { payrollRunAction } from "@/features/payroll/actions";

type Item = { id: string; label: string; kind: string; unit: "amount" | "days" | "hours" };
interface Line {
  item_id: string;
  quantity: string;
  amount: string;
  description: string;
}
const input =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5";

/**
 * Edits one payslip's earnings and deductions. Days/hours are priced by the
 * database at the employee's rate in effect at the period end; nothing is
 * computed here.
 */
export function PayslipLinesForm({
  clientId,
  payslipId,
  items,
  initial,
}: {
  clientId: string;
  payslipId: string;
  items: Item[];
  initial: Line[];
}) {
  const [lines, setLines] = useState<Line[]>(
    initial.length ? initial : [{ item_id: "", quantity: "", amount: "", description: "" }],
  );
  const set = (n: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const unitOf = (id: string) => items.find((i) => i.id === id)?.unit ?? "amount";
  return (
    <ActionForm
      action={payrollRunAction}
      submitLabel="Save and recompute"
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="op" value="lines" />
      <input type="hidden" name="payslipId" value={payslipId} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          lines
            .filter((l) => l.item_id)
            .map((l) =>
              unitOf(l.item_id) !== "amount" && l.quantity
                ? { ...l, amount: "" }
                : { ...l, quantity: "" },
            ),
        )}
      />
      {lines.map((l, n) => {
        const unit = unitOf(l.item_id);
        return (
          <div key={n} className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <label className="col-span-2 flex flex-col gap-1">
              Item
              <select
                value={l.item_id}
                onChange={(e) => set(n, { item_id: e.target.value })}
                className={input}
              >
                <option value="">Choose…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
            {unit !== "amount" ? (
              <label className="flex flex-col gap-1">
                {unit === "days" ? "Days" : "Hours"}
                <input
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => set(n, { quantity: e.target.value })}
                  className={`${input} text-right tabular-nums`}
                />
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              Amount{unit !== "amount" ? " (or)" : ""}
              <input
                inputMode="decimal"
                value={l.amount}
                onChange={(e) => set(n, { amount: e.target.value })}
                className={`${input} text-right tabular-nums`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Note
              <input
                value={l.description}
                maxLength={200}
                onChange={(e) => set(n, { description: e.target.value })}
                className={input}
              />
            </label>
            <button
              type="button"
              className="self-end text-xs text-[var(--danger)] underline"
              onClick={() => setLines((ls) => ls.filter((_, i) => i !== n))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="self-start text-sm underline"
        onClick={() =>
          setLines((ls) => [...ls, { item_id: "", quantity: "", amount: "", description: "" }])
        }
      >
        + Add line
      </button>
    </ActionForm>
  );
}
