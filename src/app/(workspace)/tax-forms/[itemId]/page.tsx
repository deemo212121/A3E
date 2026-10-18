import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState, NotFoundState } from "@/components/ui/access-states";
import { ActionForm, Field, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import {
  Alert,
  Badge,
  LinkButton,
  PageHeader,
  PageSkeleton,
  Section,
} from "@/components/ui/primitives";
import { taxFormAction } from "@/features/tax/form-actions";
import { STATUS_TONE } from "@/features/tax/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import {
  getForm,
  getFormFixtureResults,
  getFormRegression,
  listFormFixtures,
} from "@/server/data/forms";

export const metadata: Metadata = { title: "Tax form" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TaxFormPage({ params }: PageProps<"/tax-forms/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TaxForm params={params} />
    </Suspense>
  );
}

async function TaxForm({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const { access, decision } = await guardRoute("tax_form");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const f = UUID.test(itemId) ? await getForm(itemId.toLowerCase()) : null;
  if (!f) return <NotFoundState />;
  const [results, fixtures, regression] = await Promise.all([
    getFormFixtureResults(f.id),
    listFormFixtures(f.id),
    ["approved", "enabled", "retired"].includes(f.status)
      ? getFormRegression(f.form_code)
      : Promise.resolve([]),
  ]);
  const editor = hasFirmRole(access, ["firm_manager", "reviewer"]);
  const manager = hasFirmRole(access, ["firm_manager"]);
  const accountant = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
  const author = Object.fromEntries(fixtures.map((x) => [x.id, x.created_by]));
  const hidden = (op: string, id = f.id) => (
    <>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="id" value={id} />
    </>
  );
  const given = Object.fromEntries(
    f.definition.lines.filter((l) => l.kind !== "formula").map((l) => [l.code, "0"]),
  );
  const fixtureTemplate = JSON.stringify(
    {
      name: "Describe the case",
      kind: "normal",
      as_of: f.effective_from,
      basis: "Where the expected values come from",
      facts: {},
      given,
      expected: { lines: {}, messages: [] },
    },
    null,
    2,
  );
  return (
    <div data-route="tax_form">
      <div className="mb-4">
        <LinkButton href={pathFor("tax_forms")}>← Tax forms</LinkButton>
      </div>
      <PageHeader
        title={`${f.form_code} v${f.version}`}
        description={`${f.title} · official version ${f.official_version} · ${f.frequency} · ${f.effective_from} to ${f.effective_to ?? "open"}`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={f.status === "enabled" ? "success" : (STATUS_TONE[f.status] ?? "neutral")}>
          {f.status.replace("_", " ")}
        </Badge>
        {f.status !== "enabled" ? (
          <span className="text-sm">Not enabled for production use.</span>
        ) : null}
      </div>
      {f.signoff_statement ? (
        <Alert tone="success" title={`Accountant sign-off ${f.signoff_at?.slice(0, 10) ?? ""}`}>
          {f.signoff_statement} (evidence: {f.signoff_evidence})
        </Alert>
      ) : null}
      <Section title="Sources and limitations">
        <ul className="list-disc pl-5 text-sm">
          {f.sources.map((s, i) => (
            <li key={i}>
              {s.citation}
              {s.issued_on ? ` (issued ${s.issued_on})` : ""}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm">Limitations: {f.limitations}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Export: {f.export_format.toUpperCase()} workpaper only · rounding {f.rounding.places}{" "}
          places, {f.rounding.mode.replace(/_/g, " ")} on formula lines
        </p>
      </Section>
      <Section title="Lines">
        <DataTable
          caption="Lines"
          rows={f.definition.lines}
          rowKey={(l) => l.code}
          columns={[
            { header: "Line", kind: "nowrap", cell: (l) => l.code },
            { header: "Label", cell: (l) => l.label },
            {
              header: "Source",
              cell: (l) =>
                l.kind === "tax_output" ? (
                  `${l.rule_code} output ${l.output}`
                ) : l.kind === "tax_input" ? (
                  `${l.rule_code} input ${l.input}`
                ) : l.kind === "fact" ? (
                  `taxpayer fact ${l.fact}`
                ) : l.kind === "manual" ? (
                  "entered with a reason"
                ) : (
                  <code className="text-xs">{JSON.stringify(l.expr)}</code>
                ),
            },
          ]}
        />
        {f.definition.validations?.length ? (
          <ul className="mt-2 list-disc pl-5 text-sm">
            {f.definition.validations.map((v) => (
              <li key={v.code}>
                {v.severity}: {v.message} ({v.code})
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
      <Section title="Regression fixtures">
        <DataTable
          caption="Fixtures"
          rows={results}
          rowKey={(x) => x.fixture_id}
          empty="No fixtures yet."
          columns={[
            { header: "Case", cell: (x) => x.name },
            { header: "Kind", cell: (x) => x.kind },
            { header: "As of", kind: "nowrap", cell: (x) => x.as_of },
            {
              header: "Result",
              cell: (x) => (
                <Badge tone={x.passed ? "success" : "danger"}>
                  {x.passed ? "pass" : (x.error ?? "fail")}
                </Badge>
              ),
            },
            {
              header: "Accountant review",
              cell: (x) =>
                x.reviewed ? (
                  <Badge tone="success">reviewed</Badge>
                ) : accountant && author[x.fixture_id] !== access.user_id ? (
                  <ActionForm action={taxFormAction} submitLabel="Mark reviewed" variant="primary">
                    {hidden("review_fixture", x.fixture_id)}
                  </ActionForm>
                ) : (
                  <Badge tone="warning">awaiting review</Badge>
                ),
            },
          ]}
        />
        {f.status === "draft" && accountant ? (
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Add a fixture</summary>
            <div className="mt-3">
              <ActionForm action={taxFormAction} submitLabel="Add fixture">
                {hidden("add_fixture")}
                <TextArea
                  label="Fixture (JSON)"
                  name="json"
                  rows={14}
                  defaultValue={fixtureTemplate}
                />
              </ActionForm>
            </div>
          </details>
        ) : null}
        {regression.length > 0 ? (
          <p className="mt-2 text-sm">
            Regression across versions: {regression.filter((r) => r.passed).length}/
            {regression.length} pass.
          </p>
        ) : null}
      </Section>
      {editor ? (
        <Section title="Workflow">
          <div className="flex flex-col gap-3">
            {f.status === "draft" ? (
              <ActionForm
                action={taxFormAction}
                submitLabel="Submit for approval"
                variant="primary"
              >
                {hidden("submit")}
              </ActionForm>
            ) : null}
            {f.status === "pending_review" && f.entered_by !== access.user_id ? (
              <ActionForm action={taxFormAction} submitLabel="Approve (verified)" variant="primary">
                {hidden("approve")}
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="attest" required /> I checked the definition against
                  the official form, its instructions and the cited issuances.
                </label>
                <TextArea label="Note" name="note" rows={2} />
              </ActionForm>
            ) : null}
            {f.status === "approved" && manager && f.entered_by !== access.user_id ? (
              <ActionForm
                action={taxFormAction}
                submitLabel="Enable for production (accountant sign-off)"
                variant="primary"
                confirmMessage="Record the accountant sign-off and enable this form for client workpapers?"
              >
                {hidden("enable")}
                <TextArea
                  label="Sign-off statement (who reviewed what, and the conclusion)"
                  name="note"
                  rows={3}
                  required
                />
                <Field label="Where the evidence is kept" name="evidence" maxLength={1000} />
              </ActionForm>
            ) : null}
            {["draft", "pending_review", "approved"].includes(f.status) ? (
              <details className="rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm text-[var(--danger)]">Reject</summary>
                <div className="mt-3">
                  <ActionForm action={taxFormAction} submitLabel="Reject form" variant="danger">
                    {hidden("reject")}
                    <TextArea label="Why" name="note" rows={2} required />
                  </ActionForm>
                </div>
              </details>
            ) : null}
            {["approved", "enabled"].includes(f.status) ? (
              <ActionForm
                action={taxFormAction}
                submitLabel="Set end date (or leave blank to retire)"
              >
                {hidden("end")}
                <Field label="In effect until" name="effectiveTo" type="date" />
              </ActionForm>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
