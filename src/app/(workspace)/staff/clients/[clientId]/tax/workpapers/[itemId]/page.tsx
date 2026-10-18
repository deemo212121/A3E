import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import {
  Alert,
  Badge,
  BUTTON_VARIANTS,
  LinkButton,
  PageSkeleton,
  Section,
} from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { sourceLink } from "@/features/reports/source-link";
import { workpaperAction } from "@/features/tax/form-actions";
import { pathFor } from "@/lib/access/route-policy";
import { formatAmount } from "@/lib/money/amount";
import { hasFirmRole } from "@/server/auth/access";
import { getWorkpaper } from "@/server/data/forms";

export const metadata: Metadata = { title: "Tax workpaper" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONE = {
  prepared: "warning",
  signed_off: "success",
  superseded: "neutral",
  unsupported: "danger",
  not_applicable: "neutral",
} as const;

export default function WorkpaperPage({
  params,
}: PageProps<"/staff/clients/[clientId]/tax/workpapers/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Workpaper params={params} />
    </Suspense>
  );
}

async function Workpaper({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.workpaper",
    { clientId },
    "Tax workpaper",
    async ({ access, client }) => {
      const w = UUID.test(itemId) ? await getWorkpaper(client.id, itemId.toLowerCase()) : null;
      if (!w) return <NotFoundState />;
      const errors = w.messages.filter((m) => m.severity === "error");
      const entry = (code: string) => w.entries.filter((e) => e.line_code === code);
      const trace = (code: string) => {
        const s = w.line_sources[code] ?? {};
        if (s.kind === "tax_output" || s.kind === "tax_input") {
          return s.computation_id ? (
            <Link
              className="underline"
              href={pathFor("staff.tax_computation", {
                clientId: client.id,
                itemId: String(s.computation_id),
              })}
            >
              {String(s.rule_code)} computation ({String(s.computation_status)})
            </Link>
          ) : (
            `${String(s.rule_code)}: no computation for this period`
          );
        }
        if (s.kind === "formula")
          return `formula of ${(s.depends_on as string[] | undefined)?.join(", ") || "constants"}`;
        if (s.kind === "fact") return `taxpayer fact ${String(s.fact)}`;
        return "manual";
      };
      return (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <LinkButton href={pathFor("staff.tax", { clientId: client.id })}>← Tax</LinkButton>
            {w.form ? (
              <a className={BUTTON_VARIANTS.secondary} href={`/api/workpapers/${w.id}`}>
                Download CSV
              </a>
            ) : null}
          </div>
          <Section
            title={`${w.form_code}${w.form ? ` v${w.form.version} (${w.form.official_version})` : ""} · ${w.period_from} to ${w.period_to}`}
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={TONE[w.status as keyof typeof TONE] ?? "neutral"}>
                {w.status.replace("_", " ")}
              </Badge>
              <span>Workpaper preview: not a filed return; no filing integration.</span>
            </div>
            {w.reason ? <Alert tone="warning">{w.reason}</Alert> : null}
            {w.messages.map((m) => (
              <Alert key={m.code} tone={m.severity === "error" ? "danger" : "warning"}>
                {m.message}
              </Alert>
            ))}
            {w.form ? (
              <div className="mt-3">
                <DataTable
                  caption="Lines"
                  rows={w.form.definition.lines}
                  rowKey={(l) => l.code}
                  columns={[
                    { header: "Line", kind: "nowrap", cell: (l) => l.code },
                    { header: "Label", cell: (l) => l.label },
                    {
                      header: "Value",
                      kind: "num",
                      cell: (l) =>
                        w.lines[l.code] === undefined
                          ? "—"
                          : l.kind === "fact"
                            ? w.lines[l.code]
                            : formatAmount(w.lines[l.code]),
                    },
                    {
                      header: "Traced to",
                      cell: (l) => (
                        <span className="text-xs">
                          {trace(l.code)}
                          {entry(l.code).map((e) => (
                            <span key={e.id} className="block">
                              {e.kind}
                              {e.computed ? ` (computed ${formatAmount(e.computed)})` : ""}:{" "}
                              {e.reason}
                              {e.reference ? `, ref ${e.reference}` : ""}
                            </span>
                          ))}
                        </span>
                      ),
                    },
                  ]}
                />
              </div>
            ) : null}
          </Section>
          {w.schedule.length > 0 ? (
            <Section title="Supporting schedules">
              <DataTable
                caption="Schedules"
                rows={w.schedule}
                rowKey={(r) => `${r.schedule_code}-${r.entry_id}-${r.amount}`}
                columns={[
                  { header: "Schedule", cell: (r) => r.schedule_title },
                  { header: "Date", kind: "nowrap", cell: (r) => r.entry_date },
                  {
                    header: "Entry",
                    cell: (r) => (
                      <Link
                        className="underline"
                        href={pathFor("staff.entry", { clientId: client.id, entryId: r.entry_id })}
                      >
                        JE {r.entry_no}
                      </Link>
                    ),
                  },
                  {
                    header: "Source",
                    cell: (r) => {
                      const s = sourceLink(client.id, r.source_type, r.source_ref);
                      return s?.href ? (
                        <Link className="underline" href={s.href}>
                          {s.label}
                        </Link>
                      ) : (
                        (s?.label ?? "Manual entry")
                      );
                    },
                  },
                  { header: "Amount", kind: "num", cell: (r) => formatAmount(r.amount) },
                ]}
              />
            </Section>
          ) : null}
          {w.status === "prepared" &&
          hasFirmRole(access, ["firm_manager", "reviewer"]) &&
          w.prepared_by !== access.user_id ? (
            <Section title="Accountant sign-off">
              {errors.length > 0 ? (
                <Alert tone="danger">
                  Resolve the validation errors (prepare again) before signing off.
                </Alert>
              ) : (
                <ActionForm action={workpaperAction} submitLabel="Sign off" variant="primary">
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="hidden" name="op" value="sign_off" />
                  <input type="hidden" name="id" value={w.id} />
                  <TextArea label="Sign-off statement" name="note" rows={3} required />
                </ActionForm>
              )}
            </Section>
          ) : null}
          {w.signoff_statement ? (
            <Alert tone="success" title={`Signed off ${w.signed_off_at?.slice(0, 10) ?? ""}`}>
              {w.signoff_statement}
            </Alert>
          ) : null}
          <Section title="History">
            <ul className="text-sm">
              {w.events.map((e) => (
                <li key={e.id}>
                  {e.occurred_at.slice(0, 16).replace("T", " ")} · {e.event}
                  {e.detail ? `: ${e.detail}` : ""}
                </li>
              ))}
            </ul>
          </Section>
        </>
      );
    },
  );
}
