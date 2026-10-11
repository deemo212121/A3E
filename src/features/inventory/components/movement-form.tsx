"use client";

import { useState } from "react";

import { ActionForm, Field } from "@/components/ui/action-form";
import { saveMovementAction } from "@/features/inventory/actions";
import { MOVEMENT_HELP, MOVEMENT_LABEL, type MovementType } from "@/features/inventory/labels";

type Option = { id: string; label: string };
interface Line {
  item_id: string;
  location_id: string;
  to_location_id: string;
  quantity: string;
  unit_cost: string;
  bill_line_no: string;
  invoice_line_no: string;
}
const blank = (location = ""): Line => ({
  item_id: "",
  location_id: location,
  to_location_id: "",
  quantity: "",
  unit_cost: "",
  bill_line_no: "",
  invoice_line_no: "",
});
const input =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5";

/**
 * Stock movement entry. Values are never entered here except the unit cost of
 * stock that has no purchase bill (opening balances, count surplus): the
 * database computes every cost at the moving average or from the bill.
 */
export function MovementForm({
  clientId,
  idempotencyKey,
  today,
  items,
  locations,
  accounts,
  billLines,
  invoiceLines,
}: {
  clientId: string;
  idempotencyKey: string;
  today: string;
  items: Option[];
  locations: Option[];
  accounts: Option[];
  billLines: {
    bill_id: string;
    bill_no: string;
    line_no: number;
    description: string;
    quantity: string;
  }[];
  invoiceLines: {
    invoice_id: string;
    invoice_no: string;
    line_no: number;
    description: string;
    quantity: string;
  }[];
}) {
  const [type, setType] = useState<MovementType>("receipt");
  const [bill, setBill] = useState("");
  const [invoice, setInvoice] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(locations[0]?.id)]);
  const set = (n: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));

  const bills = [...new Map(billLines.map((b) => [b.bill_id, b.bill_no])).entries()];
  const invoices = [...new Map(invoiceLines.map((b) => [b.invoice_id, b.invoice_no])).entries()];
  const linksBill = type === "receipt" && bill !== "";
  const linksInvoice = (type === "issue" || type === "customer_return") && invoice !== "";
  const needsCost = (type === "receipt" && !bill) || type === "adjustment";
  const needsOffset =
    (type === "receipt" && !bill) || type === "supplier_return" || type === "adjustment";

  const payload = lines.map((l) => ({
    ...l,
    to_location_id: type === "transfer" ? l.to_location_id : "",
    unit_cost: needsCost ? l.unit_cost.replace(/,/g, "") : "",
    bill_line_no: linksBill ? l.bill_line_no : "",
    invoice_line_no: linksInvoice ? l.invoice_line_no : "",
    quantity: l.quantity.replace(/,/g, ""),
  }));

  return (
    <ActionForm
      action={saveMovementAction}
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
      <input type="hidden" name="movementType" value={type} />
      <input type="hidden" name="purchaseBillId" value={type === "receipt" ? bill : ""} />
      <input
        type="hidden"
        name="salesInvoiceId"
        value={type === "issue" || type === "customer_return" ? invoice : ""}
      />
      <input type="hidden" name="lines" value={JSON.stringify(payload)} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="mv-type">Movement *</label>
          <select
            id="mv-type"
            value={type}
            onChange={(e) => setType(e.target.value as MovementType)}
            className={input}
          >
            {Object.entries(MOVEMENT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <Field label="Date *" name="movementDate" type="date" defaultValue={today} />
        {type === "receipt" ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="mv-bill">Purchase bill</label>
            <select
              id="mv-bill"
              value={bill}
              onChange={(e) => setBill(e.target.value)}
              className={input}
            >
              <option value="">None (opening stock or other source)</option>
              {bills.map(([id, no]) => (
                <option key={id} value={id}>
                  {no}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {type === "issue" || type === "customer_return" ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="mv-invoice">
              Sales invoice{type === "customer_return" ? " *" : ""}
            </label>
            <select
              id="mv-invoice"
              value={invoice}
              onChange={(e) => setInvoice(e.target.value)}
              className={input}
            >
              <option value="">{type === "issue" ? "None (samples, own use…)" : "Choose…"}</option>
              {invoices.map(([id, no]) => (
                <option key={id} value={id}>
                  {no}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {needsOffset ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="mv-offset">
              {type === "receipt" ? "Credit account *" : "Charge account (optional)"}
            </label>
            <select id="mv-offset" name="offsetAccountId" defaultValue="" className={input}>
              <option value="">{type === "receipt" ? "Choose…" : "Default from settings"}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Field label="Reason" name="reason" maxLength={500} />
        <Field label="Memo" name="memo" maxLength={500} />
      </div>
      <p className="text-sm text-[var(--muted)]">{MOVEMENT_HELP[type]}</p>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Lines</legend>
        {lines.map((l, n) => (
          <div
            key={n}
            className="grid grid-cols-2 gap-2 rounded-md border border-[var(--border)] p-2 text-sm sm:grid-cols-6"
          >
            <label className="col-span-2 flex flex-col gap-1">
              Item *
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
            <label className="flex flex-col gap-1">
              {type === "transfer" ? "From *" : "Location *"}
              <select
                value={l.location_id}
                onChange={(e) => set(n, { location_id: e.target.value })}
                className={input}
              >
                {locations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {type === "transfer" ? (
              <label className="flex flex-col gap-1">
                To *
                <select
                  value={l.to_location_id}
                  onChange={(e) => set(n, { to_location_id: e.target.value })}
                  className={input}
                >
                  <option value="">Choose…</option>
                  {locations
                    .filter((o) => o.id !== l.location_id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              {type === "adjustment" ? "Qty (+/−) *" : "Quantity *"}
              <input
                inputMode="decimal"
                value={l.quantity}
                onChange={(e) => set(n, { quantity: e.target.value })}
                className={`${input} text-right tabular-nums`}
              />
            </label>
            {needsCost ? (
              <label className="flex flex-col gap-1">
                Unit cost{type === "adjustment" ? " (increases)" : " *"}
                <input
                  inputMode="decimal"
                  value={l.unit_cost}
                  onChange={(e) => set(n, { unit_cost: e.target.value })}
                  className={`${input} text-right tabular-nums`}
                />
              </label>
            ) : null}
            {linksBill ? (
              <label className="flex flex-col gap-1">
                Bill line *
                <select
                  value={l.bill_line_no}
                  onChange={(e) => set(n, { bill_line_no: e.target.value })}
                  className={input}
                >
                  <option value="">Choose…</option>
                  {billLines
                    .filter((b) => b.bill_id === bill)
                    .map((b) => (
                      <option key={b.line_no} value={b.line_no}>
                        {b.line_no}. {b.description} ({b.quantity})
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {linksInvoice ? (
              <label className="flex flex-col gap-1">
                Invoice line *
                <select
                  value={l.invoice_line_no}
                  onChange={(e) => set(n, { invoice_line_no: e.target.value })}
                  className={input}
                >
                  <option value="">Choose…</option>
                  {invoiceLines
                    .filter((b) => b.invoice_id === invoice)
                    .map((b) => (
                      <option key={b.line_no} value={b.line_no}>
                        {b.line_no}. {b.description} ({b.quantity})
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {lines.length > 1 ? (
              <button
                type="button"
                className="self-end text-xs text-[var(--danger)] underline"
                onClick={() => setLines((ls) => ls.filter((_, i) => i !== n))}
              >
                Remove line
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          className="self-start text-sm underline"
          onClick={() => setLines((ls) => [...ls, blank(locations[0]?.id)])}
        >
          + Add line
        </button>
      </fieldset>
    </ActionForm>
  );
}
