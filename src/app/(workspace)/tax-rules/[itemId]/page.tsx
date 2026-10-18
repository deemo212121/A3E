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
import { taxRuleAction } from "@/features/tax/actions";
import { STATUS_TONE } from "@/features/tax/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { getFixtureResults, getRegression, getTaxRule, listFixtures } from "@/server/data/tax";

export const metadata: Metadata = { title: "Tax rule" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pre = "overflow-x-auto rounded-md bg-[var(--surface)] p-3 text-xs";

export default function TaxRulePage({ params }: PageProps<"/tax-rules/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TaxRule params={params} />
    </Suspense>
  );
}

async function TaxRule({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const { access, decision } = await guardRoute("tax_rule");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const r = UUID.test(itemId) ? await getTaxRule(itemId.toLowerCase()) : null;
  if (!r) return <NotFoundState />;
  const [results, fixtures, regression] = await Promise.all([
    getFixtureResults(r.id),
    listFixtures(r.id),
    r.status === "approved" || r.status === "retired" ? getRegression(r.code) : Promise.resolve([]),
  ]);
  const editor = hasFirmRole(access, ["firm_manager", "reviewer"]);
  const accountant = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
  const byId = Object.fromEntries(fixtures.map((f) => [f.id, f]));
  const hidden = (op: string, id = r.id) => (
    <>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="id" value={id} />
    </>
  );
  const fixtureTemplate = JSON.stringify(
    {
      name: "Describe the case",
      kind: "normal",
      as_of: r.effective_from,
      basis:
        "Where the expected result comes from (e.g. the issuance's example, CPA working paper)",
      facts: Object.fromEntries(
        (r.eligibility as { fact: string; value: unknown }[]).map((c) => [c.fact, c.value]),
      ),
      inputs: Object.fromEntries(r.inputs.map((i) => [i.name, "0"])),
      expected: Object.fromEntries(r.formula.outputs.map((o) => [o, "0.00"])),
    },
    null,
    2,
  );
  return (
    <div data-route="tax_rule">
      <div className="mb-4">
        <LinkButton href={pathFor("tax_rules")}>← Tax rules</LinkButton>
      </div>
      <PageHeader
        title={`${r.code} v${r.version}`}
        description={`${r.name} · ${r.effective_from} to ${r.effective_to ?? "open"}`}
      />
      <div className="mb-4">
        <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status.replace("_", " ")}</Badge>
        {r.review_note ? <span className="ml-2 text-sm">Note: {r.review_note}</span> : null}
      </div>
      <Section title="Authoritative sources">
        {r.sources.length === 0 ? (
          <Alert tone="warning">No sources cited: this rule cannot be submitted.</Alert>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {r.sources.map((s, i) => (
              <li key={i}>
                {s.citation}
                {s.section ? `, ${s.section}` : ""}
                {s.issued_on ? ` (issued ${s.issued_on})` : ""}
                {s.url ? (
                  <>
                    {" · "}
                    <a className="underline" href={s.url} rel="noreferrer noopener" target="_blank">
                      link
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Definition">
        <p className="mb-2 text-sm">
          Inputs: {r.inputs.map((i) => `${i.name} (${i.source})`).join(", ")} · outputs:{" "}
          {r.formula.outputs.join(", ")} · output rounding: {r.rounding.places} places,{" "}
          {r.rounding.mode.replace(/_/g, " ")}
        </p>
        <details>
          <summary className="cursor-pointer text-sm">
            Eligibility, parameters and formula (JSON)
          </summary>
          <pre className={pre}>
            {JSON.stringify(
              { eligibility: r.eligibility, params: r.params, formula: r.formula },
              null,
              2,
            )}
          </pre>
        </details>
      </Section>
      <Section title="Expected-result fixtures">
        <DataTable
          caption="Fixtures"
          rows={results}
          rowKey={(f) => f.fixture_id}
          empty="No fixtures yet: add worked examples, including boundary cases."
          columns={[
            { header: "Case", cell: (f) => f.name },
            { header: "Kind", cell: (f) => f.kind },
            { header: "As of", kind: "nowrap", cell: (f) => f.as_of },
            {
              header: "Expected → actual",
              cell: (f) => (
                <code className="text-xs">
                  {JSON.stringify(f.expected)} → {f.error ?? JSON.stringify(f.actual)}
                </code>
              ),
            },
            {
              header: "Result",
              cell: (f) => (
                <Badge tone={f.passed ? "success" : "danger"}>{f.passed ? "pass" : "fail"}</Badge>
              ),
            },
            {
              header: "Accountant review",
              cell: (f) =>
                f.reviewed ? (
                  <Badge tone="success">reviewed</Badge>
                ) : accountant && byId[f.fixture_id]?.created_by !== access.user_id ? (
                  <ActionForm action={taxRuleAction} submitLabel="Mark reviewed" variant="primary">
                    {hidden("review_fixture", f.fixture_id)}
                    <input
                      type="hidden"
                      name="note"
                      value="Expected results checked against the source"
                    />
                  </ActionForm>
                ) : (
                  <Badge tone="warning">awaiting review</Badge>
                ),
            },
          ]}
        />
        {r.status === "draft" && accountant ? (
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Add a fixture</summary>
            <div className="mt-3">
              <ActionForm action={taxRuleAction} submitLabel="Add fixture">
                {hidden("add_fixture")}
                <TextArea
                  label="Fixture (JSON)"
                  name="json"
                  rows={16}
                  defaultValue={fixtureTemplate}
                />
              </ActionForm>
            </div>
          </details>
        ) : null}
      </Section>
      {regression.length > 0 ? (
        <Section title={`Regression across effective dates (${r.code})`}>
          <DataTable
            caption="Regression"
            rows={regression}
            rowKey={(x) => x.fixture_id}
            columns={[
              { header: "Case", cell: (x) => x.fixture_name },
              { header: "As of", kind: "nowrap", cell: (x) => x.as_of },
              { header: "Written for", cell: (x) => `v${x.written_for}` },
              { header: "Ran with", cell: (x) => (x.ran_with ? `v${x.ran_with}` : "—") },
              {
                header: "Result",
                cell: (x) => (
                  <Badge tone={x.passed ? "success" : "danger"}>
                    {x.passed ? "pass" : (x.error ?? "fail")}
                  </Badge>
                ),
              },
            ]}
          />
        </Section>
      ) : null}
      {editor ? (
        <Section title="Workflow">
          <div className="flex flex-col gap-3">
            {r.status === "draft" ? (
              <ActionForm
                action={taxRuleAction}
                submitLabel="Submit for approval"
                variant="primary"
              >
                {hidden("submit")}
              </ActionForm>
            ) : null}
            {r.status === "pending_review" && r.entered_by !== access.user_id ? (
              <ActionForm
                action={taxRuleAction}
                submitLabel="Approve"
                variant="primary"
                confirmMessage="Approve this rule? It will be used for computations from its effective date."
              >
                {hidden("approve")}
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="attest" required /> I checked this rule, its
                  parameters and its fixtures against the cited official sources.
                </label>
                <TextArea label="Approval note" name="note" rows={2} />
              </ActionForm>
            ) : null}
            {r.status === "pending_review" && r.entered_by === access.user_id ? (
              <Alert tone="info">
                You entered this rule, so another reviewer or manager must approve it.
              </Alert>
            ) : null}
            {r.status === "draft" || r.status === "pending_review" ? (
              <details className="rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm text-[var(--danger)]">Reject</summary>
                <div className="mt-3">
                  <ActionForm action={taxRuleAction} submitLabel="Reject rule" variant="danger">
                    {hidden("reject")}
                    <TextArea label="Why" name="note" rows={2} required />
                  </ActionForm>
                </div>
              </details>
            ) : null}
            {r.status === "approved" ? (
              <ActionForm
                action={taxRuleAction}
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
