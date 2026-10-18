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
import { STATUS_TONE } from "@/features/tax/labels";
import { outputSpecAction } from "@/features/tax/output-actions";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { getSpec, getSpecFixtureResults, listSpecFixtures } from "@/server/data/eoutputs";

export const metadata: Metadata = { title: "Output specification" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function SpecPage({ params }: PageProps<"/e-outputs/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Spec params={params} />
    </Suspense>
  );
}

async function Spec({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const { access, decision } = await guardRoute("eoutput");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const s = UUID.test(itemId) ? await getSpec(itemId.toLowerCase()) : null;
  if (!s) return <NotFoundState />;
  const [results, fixtures] = await Promise.all([
    getSpecFixtureResults(s.id),
    listSpecFixtures(s.id),
  ]);
  const editor = hasFirmRole(access, ["firm_manager", "reviewer"]);
  const manager = hasFirmRole(access, ["firm_manager"]);
  const accountant = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
  const author = Object.fromEntries(fixtures.map((x) => [x.id, x.created_by]));
  const hidden = (op: string, id = s.id) => (
    <>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="id" value={id} />
    </>
  );
  const fixtureTemplate = JSON.stringify(
    {
      name: "Describe the case",
      kind: "normal",
      as_of: s.effective_from,
      period_from: s.effective_from,
      period_to: s.effective_from,
      basis: "Where the expected file comes from (e.g. the specification's sample)",
      facts: {},
      rows: [],
      expected_content: "",
      expected_filename: "",
      expected_messages: [],
    },
    null,
    2,
  );
  return (
    <div data-route="eoutput">
      <div className="mb-4">
        <LinkButton href={pathFor("eoutputs")}>← Electronic outputs</LinkButton>
      </div>
      <PageHeader
        title={`${s.output_code} v${s.version}`}
        description={`${s.title} · ${s.output_type.toUpperCase()} · dataset ${s.dataset.replace(/_/g, " ")} · ${s.effective_from} to ${s.effective_to ?? "open"}`}
      />
      <div className="mb-4">
        <Badge tone={s.status === "enabled" ? "success" : (STATUS_TONE[s.status] ?? "neutral")}>
          {s.status.replace("_", " ")}
        </Badge>
      </div>
      {s.signoff_statement ? (
        <Alert tone="success" title="Accountant / compliance sign-off">
          {s.signoff_statement} (evidence: {s.signoff_evidence})
        </Alert>
      ) : null}
      <Section title="Official specification">
        <p className="text-sm">
          {s.spec_source.citation} · spec version {s.spec_source.spec_version || "—"} · issued{" "}
          {s.spec_source.issued_on || "—"}
        </p>
        <p className="text-sm">
          Validates with:{" "}
          <strong>
            {s.official_tool ?? "not set"} {s.official_tool_version ?? ""}
          </strong>
        </p>
        <p className="mt-1 text-sm">Limitations: {s.limitations}</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-sm">Layout (JSON)</summary>
          <pre className="overflow-x-auto rounded-md bg-[var(--surface)] p-3 text-xs">
            {JSON.stringify(s.layout, null, 2)}
          </pre>
        </details>
      </Section>
      <Section title="Fixtures (exact expected files)">
        <DataTable
          caption="Fixtures"
          rows={results}
          rowKey={(x) => x.fixture_id}
          empty="No fixtures yet."
          columns={[
            { header: "Case", cell: (x) => x.name },
            { header: "Kind", cell: (x) => x.kind },
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
                  <ActionForm
                    action={outputSpecAction}
                    submitLabel="Mark reviewed"
                    variant="primary"
                  >
                    {hidden("review_fixture", x.fixture_id)}
                  </ActionForm>
                ) : (
                  <Badge tone="warning">awaiting review</Badge>
                ),
            },
          ]}
        />
        {s.status === "draft" && accountant ? (
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Add a fixture</summary>
            <div className="mt-3">
              <ActionForm action={outputSpecAction} submitLabel="Add fixture">
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
      </Section>
      {editor ? (
        <Section title="Workflow">
          <div className="flex flex-col gap-3">
            {s.status === "draft" ? (
              <ActionForm
                action={outputSpecAction}
                submitLabel="Submit for approval"
                variant="primary"
              >
                {hidden("submit")}
              </ActionForm>
            ) : null}
            {s.status === "pending_review" && s.entered_by !== access.user_id ? (
              <ActionForm
                action={outputSpecAction}
                submitLabel="Approve (verified)"
                variant="primary"
              >
                {hidden("approve")}
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="attest" required /> I compared every field, length,
                  code, ordering, encoding and file-name rule with the official specification.
                </label>
                <TextArea label="Note" name="note" rows={2} />
              </ActionForm>
            ) : null}
            {s.status === "approved" && manager && s.entered_by !== access.user_id ? (
              <ActionForm
                action={outputSpecAction}
                submitLabel="Enable for production (sign-off)"
                variant="primary"
              >
                {hidden("enable")}
                <TextArea
                  label="Accountant / compliance sign-off statement"
                  name="note"
                  rows={3}
                  required
                />
                <Field label="Where the evidence is kept" name="evidence" maxLength={1000} />
              </ActionForm>
            ) : null}
            {["draft", "pending_review", "approved"].includes(s.status) ? (
              <ActionForm action={outputSpecAction} submitLabel="Reject" variant="danger">
                {hidden("reject")}
                <Field label="Why" name="note" maxLength={2000} />
              </ActionForm>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
