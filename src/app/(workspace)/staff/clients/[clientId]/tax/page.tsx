import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { taxClientAction } from "@/features/tax/actions";
import { workpaperAction } from "@/features/tax/form-actions";
import { outputRunAction } from "@/features/tax/output-actions";
import { STATUS_TONE } from "@/features/tax/labels";
import { pathFor } from "@/lib/access/route-policy";
import { listAccounts } from "@/server/data/ledger";
import {
  getTaxProfile,
  listComputations,
  listMappings,
  listObligations,
  listTaxRules,
} from "@/server/data/tax";
import { getTaxRule } from "@/server/data/tax";
import { listWorkpapers } from "@/server/data/forms";
import { listAssessments, listRequirements, listRuns } from "@/server/data/eoutputs";

export const metadata: Metadata = { title: "Tax" };

type Props = PageProps<"/staff/clients/[clientId]/tax">;

export default function TaxPage({ params }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Tax params={params} />
    </Suspense>
  );
}

async function Tax({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage("staff.tax", { clientId }, "Tax", async ({ access, client }) => {
    const [profile, obligations, mappings, computations, rules, accounts] = await Promise.all([
      getTaxProfile(client.id),
      listObligations(client.id),
      listMappings(client.id),
      listComputations(client.id),
      listTaxRules(),
      listAccounts(client.id),
    ]);
    const [workpapers, outputRuns, requirements, assessments] = await Promise.all([
      listWorkpapers(client.id),
      listRuns(client.id),
      listRequirements(),
      listAssessments(client.id),
    ]);
    const latest = (reqId: string) => assessments.find((a) => a.requirement_id === reqId);
    const hidden = (op: string, id = "") => (
      <>
        <input type="hidden" name="clientId" value={client.id} />
        <input type="hidden" name="op" value={op} />
        <input type="hidden" name="id" value={id} />
      </>
    );
    // Ledger inputs of the approved rules behind this client's obligations.
    const codes = [...new Set(obligations.map((o) => o.rule_code))];
    const approved = rules.filter((r) => r.status === "approved" && codes.includes(r.code));
    const details = (await Promise.all(approved.map((r) => getTaxRule(r.id)))).filter(Boolean);
    const ledgerInputs = details.flatMap((d) =>
      d!.inputs.filter((i) => i.source === "ledger").map((i) => ({ code: d!.code, ...i })),
    );
    const uniqueInputs = [...new Map(ledgerInputs.map((x) => [`${x.code}:${x.name}`, x])).values()];
    const accountLabel = Object.fromEntries(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
    const postable = accounts.filter((a) => a.is_postable && a.is_active);
    const input =
      "rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm";

    return (
      <>
        <Alert tone="warning" title="Working papers, not returns">
          Computations use only rules that were verified and approved in the tax rules registry,
          from posted entries plus adjustments recorded here. Adjustments never change the books,
          and accounting profit is never treated as taxable income. Anything not covered is marked
          unsupported or as needing professional review.{" "}
          <Link className="underline" href={pathFor("tax_rules")}>
            Tax rules registry
          </Link>
        </Alert>

        <Section title="Tax profile (facts used by rule eligibility)">
          {profile ? (
            <p className="mb-2 text-sm">
              <Badge tone={profile.status === "confirmed" ? "success" : "warning"}>
                {profile.status}
              </Badge>{" "}
              <code className="text-xs">{JSON.stringify(profile.attributes)}</code>
            </p>
          ) : (
            <p className="mb-2 text-sm text-[var(--muted)]">No tax profile yet.</p>
          )}
          <p className="mb-2 text-xs text-[var(--muted)]">
            The approved business profile adds business type, VAT status and fiscal year end, and
            takes precedence. A reviewer other than the proposer confirms the profile.
          </p>
          <div className="flex flex-col gap-3">
            <ActionForm action={taxClientAction} submitLabel="Propose profile facts">
              {hidden("profile")}
              <TextArea
                label="Facts (JSON name/value pairs)"
                name="json"
                rows={4}
                defaultValue={JSON.stringify(profile?.attributes ?? {}, null, 2)}
              />
            </ActionForm>
            {profile?.status === "proposed" && profile.proposed_by !== access.user_id ? (
              <ActionForm action={taxClientAction} submitLabel="Confirm profile" variant="primary">
                {hidden("confirm_profile")}
              </ActionForm>
            ) : null}
          </div>
        </Section>

        <Section title="Obligations (which rules apply to this client)">
          <DataTable
            caption="Obligations"
            rows={obligations}
            rowKey={(o) => o.id}
            empty="None configured: nothing is assumed."
            columns={[
              { header: "Rule code", cell: (o) => o.rule_code },
              { header: "From", kind: "nowrap", cell: (o) => o.starts_on },
              { header: "To", kind: "nowrap", cell: (o) => o.ends_on ?? "open" },
              {
                header: "Approved rule?",
                cell: (o) =>
                  rules.some((r) => r.code === o.rule_code && r.status === "approved") ? (
                    <Badge tone="success">yes</Badge>
                  ) : (
                    <Badge tone="danger">none: unsupported</Badge>
                  ),
              },
              { header: "Notes", hideOnMobile: true, cell: (o) => o.notes ?? "" },
            ]}
          />
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Add an obligation</summary>
            <div className="mt-3">
              <ActionForm action={taxClientAction} submitLabel="Add">
                {hidden("add_obligation")}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Field label="Rule code" name="code" maxLength={40} />
                  <Field label="From" name="startsOn" type="date" />
                  <Field label="To (optional)" name="endsOn" type="date" />
                  <Field label="Notes" name="notes" maxLength={500} />
                </div>
              </ActionForm>
            </div>
          </details>
        </Section>

        <Section title="Ledger inputs → accounts">
          {uniqueInputs.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              No approved rule with ledger inputs is configured for this client.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {uniqueInputs.map((x) => {
                const m = mappings.find((y) => y.rule_code === x.code && y.input_name === x.name);
                return (
                  <ActionForm
                    key={`${x.code}:${x.name}`}
                    action={taxClientAction}
                    submitLabel="Save mapping"
                    className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3"
                  >
                    {hidden("mapping")}
                    <input type="hidden" name="code" value={x.code} />
                    <input type="hidden" name="input" value={x.name} />
                    <p className="text-sm">
                      <strong>
                        {x.code} · {x.label ?? x.name}
                      </strong>{" "}
                      {m
                        ? `→ ${m.account_ids.map((a) => accountLabel[a]).join(", ")}`
                        : "(not mapped)"}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <select
                        name="accountIds"
                        multiple
                        defaultValue={m?.account_ids ?? []}
                        className={`${input} h-28 min-w-64`}
                        aria-label={`Accounts for ${x.name}`}
                      >
                        {postable.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                      <select
                        name="sign"
                        defaultValue={m?.sign ?? "credit_minus_debit"}
                        className={input}
                      >
                        <option value="credit_minus_debit">Credits − debits</option>
                        <option value="debit_minus_credit">Debits − credits</option>
                      </select>
                    </div>
                  </ActionForm>
                );
              })}
            </div>
          )}
        </Section>

        <Section title="Computations">
          <DataTable
            caption="Computations"
            rows={computations}
            rowKey={(c) => c.id}
            empty="No computations yet."
            columns={[
              {
                header: "Rule / period",
                cell: (c) => (
                  <Link
                    className="font-medium text-[var(--accent)] hover:underline"
                    href={pathFor("staff.tax_computation", { clientId: client.id, itemId: c.id })}
                  >
                    {c.rule_code} · {c.period_from} – {c.period_to}
                  </Link>
                ),
              },
              {
                header: "Status",
                cell: (c) => (
                  <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>
                    {c.status.replace("_", " ")}
                  </Badge>
                ),
              },
              {
                header: "Result",
                cell: (c) =>
                  c.outputs
                    ? Object.entries(c.outputs)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")
                    : (c.reason ?? ""),
              },
            ]}
          />
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Compute</summary>
            <div className="mt-3">
              <ActionForm action={taxClientAction} submitLabel="Compute">
                {hidden("compute")}
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Rule code" name="code" maxLength={40} />
                  <Field label="Period from" name="from" type="date" />
                  <Field label="Period to" name="to" type="date" />
                </div>
                <TextArea
                  label="Adjustments and manual inputs (one per line: input | amount | reason | reference)"
                  name="adjustments"
                  rows={3}
                  hint="Kept separate from the books, with the reason and reference shown on the computation."
                />
              </ActionForm>
            </div>
          </details>
        </Section>

        <Section title="Form workpapers">
          <DataTable
            caption="Workpapers"
            rows={workpapers}
            rowKey={(w) => w.id}
            empty="No workpapers yet."
            columns={[
              {
                header: "Form / period",
                cell: (w) => (
                  <Link
                    className="font-medium text-[var(--accent)] hover:underline"
                    href={pathFor("staff.workpaper", { clientId: client.id, itemId: w.id })}
                  >
                    {w.form_code} · {w.period_from} – {w.period_to}
                  </Link>
                ),
              },
              { header: "Status", cell: (w) => w.status.replace("_", " ") },
              { header: "Note", hideOnMobile: true, cell: (w) => w.reason ?? "" },
            ]}
          />
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Prepare a workpaper</summary>
            <div className="mt-3">
              <ActionForm action={workpaperAction} submitLabel="Prepare">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="op" value="prepare" />
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Form code" name="code" maxLength={40} />
                  <Field label="Period from" name="from" type="date" />
                  <Field label="Period to" name="to" type="date" />
                </div>
                <TextArea
                  label="Manual lines (line | value | reason | reference)"
                  name="manual"
                  rows={3}
                />
                <TextArea
                  label="Overrides of source lines (line | value | reason | reference)"
                  name="overrides"
                  rows={2}
                  hint="Recorded with the computed value and flagged on the workpaper."
                />
              </ActionForm>
            </div>
          </details>
        </Section>

        <Section title="Electronic outputs (DAT, alphalists, SLSP, QAP, SAWT)">
          <DataTable
            caption="Electronic outputs"
            rows={outputRuns}
            rowKey={(r) => r.id}
            empty="No files generated yet."
            columns={[
              {
                header: "Output / period",
                cell: (r) => (
                  <Link
                    className="font-medium text-[var(--accent)] hover:underline"
                    href={pathFor("staff.output_run", { clientId: client.id, itemId: r.id })}
                  >
                    {r.output_code} · {r.period_from} – {r.period_to}
                  </Link>
                ),
              },
              {
                header: "Status",
                cell: (r) => (
                  <Badge
                    tone={
                      r.status === "validated" || r.status === "signed_off"
                        ? "success"
                        : r.status === "generated"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {r.status === "generated"
                      ? "generated: not validated"
                      : r.status.replace("_", " ")}
                  </Badge>
                ),
              },
              { header: "Note", hideOnMobile: true, cell: (r) => r.reason ?? "" },
            ]}
          />
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Generate a file</summary>
            <div className="mt-3">
              <ActionForm action={outputRunAction} submitLabel="Generate">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="op" value="generate" />
                <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Output code" name="code" maxLength={40} />
                  <Field label="Period from" name="from" type="date" />
                  <Field label="Period to" name="to" type="date" />
                </div>
              </ActionForm>
            </div>
          </details>
        </Section>

        <Section title="E-invoicing compliance (evidence per requirement)">
          <DataTable
            caption="E-invoicing"
            rows={requirements}
            rowKey={(r) => r.id}
            empty="No e-invoicing requirements recorded in the register yet."
            columns={[
              { header: "Requirement", cell: (r) => `${r.code} · ${r.title}` },
              { header: "Verified", cell: (r) => (r.status === "verified" ? "yes" : "no") },
              {
                header: "This client",
                cell: (r) => {
                  const a = latest(r.id);
                  return a
                    ? `${a.status.replace(/_/g, " ")}${a.evidence ? ` (evidence: ${a.evidence})` : ""}`
                    : "not assessed";
                },
              },
            ]}
          />
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">
              Record an assessment (reviewer or manager)
            </summary>
            <div className="mt-3">
              <ActionForm action={outputRunAction} submitLabel="Record">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="op" value="assess" />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    Requirement
                    <select
                      name="requirementId"
                      className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                    >
                      {requirements.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Status
                    <select
                      name="status"
                      className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5"
                    >
                      <option value="not_assessed">Not assessed</option>
                      <option value="not_applicable">Not applicable (give the reason)</option>
                      <option value="required_not_met">Required, not met</option>
                      <option value="in_progress">In progress</option>
                      <option value="met">Met (give the evidence)</option>
                    </select>
                  </label>
                </div>
                <Field
                  label="Evidence (certificate, registration, approval reference)"
                  name="evidence"
                  maxLength={2000}
                />
                <Field label="Note / reason" name="note" maxLength={2000} />
              </ActionForm>
            </div>
          </details>
        </Section>
      </>
    );
  });
}
