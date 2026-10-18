import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { sourceLink } from "@/features/reports/source-link";
import { taxClientAction } from "@/features/tax/actions";
import { COMPUTATION_HELP, STATUS_TONE } from "@/features/tax/labels";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount } from "@/lib/money/amount";
import { hasFirmRole } from "@/server/auth/access";
import { getComputation } from "@/server/data/tax";

export const metadata: Metadata = { title: "Tax computation" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ComputationPage({
  params,
}: PageProps<"/staff/clients/[clientId]/tax/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Computation params={params} />
    </Suspense>
  );
}

async function Computation({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.tax_computation",
    { clientId },
    "Tax computation",
    async ({ access, client }) => {
      const c = UUID.test(itemId) ? await getComputation(client.id, itemId.toLowerCase()) : null;
      if (!c) return <NotFoundState />;
      const names = [
        ...new Set([
          ...Object.keys(c.ledger_inputs),
          ...Object.keys(c.adjustments),
          ...Object.keys(c.inputs),
        ]),
      ];
      const approver = hasFirmRole(access, ["firm_manager", "reviewer"]);
      return (
        <>
          <div className="mb-4">
            <LinkButton href={pathFor("staff.tax", { clientId: client.id })}>← Tax</LinkButton>
          </div>
          <Section title={`${c.rule_code} · ${c.period_from} to ${c.period_to}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status.replace("_", " ")}</Badge>
              <span>{COMPUTATION_HELP[c.status]}</span>
              {c.rule_id ? (
                <Link className="underline" href={pathFor("tax_rule", { itemId: c.rule_id })}>
                  Rule version used
                </Link>
              ) : null}
            </div>
            {c.reason ? (
              <Alert tone={c.status === "not_applicable" ? "info" : "warning"}>{c.reason}</Alert>
            ) : null}
            {c.outputs ? (
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                {Object.entries(c.outputs).map(([k, v]) => (
                  <div key={k} className="rounded-md bg-[var(--surface)] p-2">
                    <dt className="text-xs text-[var(--muted)]">{k.replace(/_/g, " ")}</dt>
                    <dd className="font-semibold tabular-nums">{formatAmount(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </Section>
          {names.length > 0 ? (
            <Section title="Inputs: from the books, plus tax adjustments (kept apart)">
              <DataTable
                caption="Inputs"
                rows={names}
                rowKey={(n) => n}
                columns={[
                  { header: "Input", cell: (n) => n },
                  {
                    header: "From posted entries",
                    kind: "num",
                    cell: (n) => (c.ledger_inputs[n] ? formatAmount(c.ledger_inputs[n]) : "—"),
                  },
                  {
                    header: "Adjustments",
                    kind: "num",
                    cell: (n) => (c.adjustments[n] ? formatAmount(c.adjustments[n]) : "—"),
                  },
                  {
                    header: "Used",
                    kind: "num",
                    cell: (n) => (c.inputs[n] ? formatAmount(c.inputs[n]) : "—"),
                  },
                ]}
              />
              {c.adjustmentRows.length > 0 ? (
                <ul className="mt-2 list-disc pl-5 text-sm">
                  {c.adjustmentRows.map((a) => (
                    <li key={a.id}>
                      {a.input_name}: {formatAmount(a.amount)}, {a.reason}
                      {a.reference ? ` (ref ${a.reference})` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
          ) : null}
          {c.lineage.length > 0 ? (
            <Section title="Lineage: posted entries behind each ledger input">
              <DataTable
                caption="Lineage"
                rows={c.lineage}
                rowKey={(l) => String(l.id)}
                columns={[
                  { header: "Input", cell: (l) => l.input_name },
                  { header: "Date", kind: "nowrap", cell: (l) => l.entry_date },
                  {
                    header: "Entry",
                    cell: (l) => (
                      <Link
                        className="underline"
                        href={pathFor("staff.entry", { clientId: client.id, entryId: l.entry_id })}
                      >
                        JE {l.entry_no}
                      </Link>
                    ),
                  },
                  {
                    header: "Source",
                    cell: (l) => {
                      const s = sourceLink(client.id, l.source_type, l.source_ref);
                      if (!s) return "Manual entry";
                      return s.href ? (
                        <Link className="underline" href={s.href}>
                          {s.label}
                        </Link>
                      ) : (
                        s.label
                      );
                    },
                  },
                  { header: "Amount", kind: "num", cell: (l) => formatAmount(l.amount) },
                ]}
              />
            </Section>
          ) : null}
          {c.status === "computed" && approver && c.prepared_by !== access.user_id ? (
            <Section title="Review">
              <ActionForm action={taxClientAction} submitLabel="Mark reviewed" variant="primary">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="op" value="review" />
                <input type="hidden" name="id" value={c.id} />
                <TextArea label="Review note" name="note" rows={2} />
              </ActionForm>
            </Section>
          ) : null}
          {c.review_note ? <p className="mt-2 text-sm">Review note: {c.review_note}</p> : null}
        </>
      );
    },
  );
}
