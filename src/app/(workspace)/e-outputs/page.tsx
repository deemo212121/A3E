import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { STATUS_TONE } from "@/features/tax/labels";
import { outputSpecAction } from "@/features/tax/output-actions";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { listRequirements, listSpecs } from "@/server/data/eoutputs";

export const metadata: Metadata = { title: "Electronic outputs" };

// Structure only: every field, length, code and rule comes from the official spec.
const TEMPLATE = JSON.stringify(
  {
    output_code: "OUTPUT_CODE",
    output_type: "dat",
    title: "Output title",
    spec_source: {
      citation: "Issuance and annex",
      spec_version: "",
      issued_on: "YYYY-MM-DD",
      url: "",
    },
    official_tool: "Official validation module name",
    official_tool_version: "",
    effective_from: "YYYY-MM-DD",
    dataset: "withholding_by_bill_line",
    layout: {
      format: "delimited",
      delimiter: ",",
      quote: "none",
      encoding: "ascii",
      line_end: "crlf",
      final_newline: true,
      filename: "{fact.tin:digits}{period.to:MMYYYY}.DAT",
      group_by: [],
      sums: [],
      order_by: [],
      unique_keys: [],
      records: [
        {
          record: "detail",
          fields: [{ name: "field", from: "row.payee_tin", length: 12, required: true }],
        },
      ],
    },
    limitations: "What the file does not cover.",
  },
  null,
  2,
);
const REQ_TEMPLATE = JSON.stringify(
  {
    code: "REQUIREMENT_CODE",
    category: "registration",
    title: "Requirement",
    description: "What must be in place, for whom",
    sources: [{ citation: "Issuance and section", issued_on: "YYYY-MM-DD", url: "" }],
  },
  null,
  2,
);

export default function EOutputsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EOutputs />
    </Suspense>
  );
}

async function EOutputs() {
  const { access, decision } = await guardRoute("eoutputs");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [specs, reqs] = await Promise.all([listSpecs(), listRequirements()]);
  const editor = hasFirmRole(access, ["firm_manager", "reviewer"]);
  return (
    <div data-route="eoutputs">
      <PageHeader
        title="Electronic outputs & e-invoicing"
        description="DAT files, alphalists, SLSP, QAP, SAWT and schedules, each a versioned specification."
      />
      <Alert
        tone="warning"
        title="No file layout is built in, and no file is valid until the official check passes"
      >
        Each output is transcribed from its official technical specification, verified by a second
        reviewer and signed off. A generated file is only <strong>generated</strong>; it becomes{" "}
        <strong>validated</strong> only when the official validation tool named in the specification
        passed for that exact file and our own validation and reconciliation passed.
      </Alert>
      <Section title="Output specifications">
        <DataTable
          caption="Specifications"
          rows={specs}
          rowKey={(s) => s.id}
          empty="No specifications yet."
          columns={[
            {
              header: "Output",
              cell: (s) => (
                <Link
                  className="font-medium text-[var(--accent)] hover:underline"
                  href={pathFor("eoutput", { itemId: s.id })}
                >
                  {s.output_code} v{s.version}
                </Link>
              ),
            },
            { header: "Type", cell: (s) => s.output_type.toUpperCase() },
            { header: "Title", hideOnMobile: true, cell: (s) => s.title },
            {
              header: "Validator",
              hideOnMobile: true,
              cell: (s) => `${s.official_tool ?? "—"} ${s.official_tool_version ?? ""}`,
            },
            {
              header: "Status",
              cell: (s) => (
                <Badge
                  tone={s.status === "enabled" ? "success" : (STATUS_TONE[s.status] ?? "neutral")}
                >
                  {s.status.replace("_", " ")}
                </Badge>
              ),
            },
          ]}
        />
        {editor ? (
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Enter a specification (draft)</summary>
            <div className="mt-3">
              <ActionForm action={outputSpecAction} submitLabel="Save draft specification">
                <input type="hidden" name="op" value="propose" />
                <TextArea
                  label="Specification (JSON)"
                  name="json"
                  rows={22}
                  defaultValue={TEMPLATE}
                />
              </ActionForm>
            </div>
          </details>
        ) : null}
      </Section>
      <Section title="E-invoicing compliance register">
        <Alert tone="info">
          The platform does not issue invoices (decision D-01). It records invoices issued
          elsewhere; a PDF or record here is never a compliant electronic invoice. Each
          registration, certification, approval, technical or transmission requirement is entered
          with its official source and verified by a second reviewer before clients are assessed
          against it.
        </Alert>
        <div className="mt-3">
          <DataTable
            caption="Requirements"
            rows={reqs}
            rowKey={(r) => r.id}
            empty="No requirements recorded yet."
            columns={[
              { header: "Code", kind: "nowrap", cell: (r) => r.code },
              { header: "Category", cell: (r) => r.category },
              {
                header: "Requirement",
                cell: (r) => (
                  <span className="flex flex-col">
                    <span>{r.title}</span>
                    <span className="text-xs text-[var(--muted)]">
                      {r.sources.map((s) => s.citation).join("; ") || "no source cited"}
                    </span>
                  </span>
                ),
              },
              {
                header: "Status",
                cell: (r) =>
                  r.status === "unverified" && editor && r.entered_by !== access.user_id ? (
                    <ActionForm action={outputSpecAction} submitLabel="Verify" variant="primary">
                      <input type="hidden" name="op" value="verify_requirement" />
                      <input type="hidden" name="id" value={r.id} />
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" name="attest" required /> I checked the official
                        source
                      </label>
                    </ActionForm>
                  ) : (
                    <Badge tone={r.status === "verified" ? "success" : "warning"}>{r.status}</Badge>
                  ),
              },
            ]}
          />
        </div>
        {editor ? (
          <details className="mt-3 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Record a requirement</summary>
            <div className="mt-3">
              <ActionForm action={outputSpecAction} submitLabel="Save requirement">
                <input type="hidden" name="op" value="propose_requirement" />
                <TextArea
                  label="Requirement (JSON)"
                  name="json"
                  rows={10}
                  defaultValue={REQ_TEMPLATE}
                />
              </ActionForm>
            </div>
          </details>
        ) : null}
      </Section>
    </div>
  );
}
