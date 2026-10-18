import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
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
import { outputRunAction } from "@/features/tax/output-actions";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { getRun } from "@/server/data/eoutputs";

export const metadata: Metadata = { title: "Electronic output" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL: Record<string, [string, "neutral" | "warning" | "success" | "danger"]> = {
  generated: ["generated: NOT validated", "warning"],
  validated: ["validated (official check and our checks passed)", "success"],
  validation_failed: ["NOT valid", "danger"],
  signed_off: ["validated and signed off", "success"],
  superseded: ["superseded", "neutral"],
  unsupported: ["unsupported", "danger"],
  not_applicable: ["not applicable", "neutral"],
};

export default function OutputRunPage({
  params,
}: PageProps<"/staff/clients/[clientId]/tax/outputs/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OutputRun params={params} />
    </Suspense>
  );
}

async function OutputRun({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.output_run",
    { clientId },
    "Electronic output",
    async ({ access, client }) => {
      const r = UUID.test(itemId) ? await getRun(client.id, itemId.toLowerCase()) : null;
      if (!r) return <NotFoundState />;
      const [label, tone] = LABEL[r.status] ?? [r.status, "neutral"];
      const current = ["generated", "validated", "validation_failed"].includes(r.status);
      const hidden = (op: string) => (
        <>
          <input type="hidden" name="clientId" value={client.id} />
          <input type="hidden" name="op" value={op} />
          <input type="hidden" name="id" value={r.id} />
        </>
      );
      return (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <LinkButton href={pathFor("staff.tax", { clientId: client.id })}>← Tax</LinkButton>
            {r.content !== null ? (
              <a className={BUTTON_VARIANTS.secondary} href={`/api/outputs/${r.id}`}>
                Download file
              </a>
            ) : null}
          </div>
          <Section
            title={`${r.output_code}${r.spec ? ` v${r.spec.version}` : ""} · ${r.period_from} to ${r.period_to}`}
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={tone}>{label}</Badge>
              {r.filename ? <code>{r.filename}</code> : null}
            </div>
            {r.reason ? <Alert tone="warning">{r.reason}</Alert> : null}
            {r.content_sha256 ? (
              <p className="text-xs text-[var(--muted)]">
                File SHA-256 {r.content_sha256} · source snapshot of {r.snapshot.length} record(s),
                SHA-256 {r.snapshot_sha256}
              </p>
            ) : null}
            {r.spec ? (
              <p className="mt-1 text-sm">
                Must pass:{" "}
                <strong>
                  {r.spec.official_tool} {r.spec.official_tool_version}
                </strong>{" "}
                (specification {r.spec.spec_source.citation}, version{" "}
                {r.spec.spec_source.spec_version})
              </p>
            ) : null}
          </Section>
          {r.spec ? (
            <Section
              title={`Validation report: ${r.precheck_passed ? "our checks passed" : "our checks FAILED"}`}
            >
              <DataTable
                caption="Validation messages"
                rows={r.messages}
                rowKey={(m) => `${m.code}-${m.record}-${m.row}-${m.field}-${m.message}`}
                empty="No validation errors."
                columns={[
                  { header: "Code", kind: "nowrap", cell: (m) => m.code },
                  {
                    header: "Where",
                    cell: (m) => [m.record, m.row, m.field].filter(Boolean).join(" · "),
                  },
                  { header: "Message", cell: (m) => m.message },
                ]}
              />
              <div className="mt-3">
                <DataTable
                  caption="Reconciliation"
                  rows={r.reconciliation}
                  rowKey={(c) => c.check}
                  columns={[
                    { header: "Check", cell: (c) => c.check },
                    { header: "Source", kind: "num", cell: (c) => String(c.expected ?? "—") },
                    { header: "File", kind: "num", cell: (c) => String(c.actual ?? "—") },
                    {
                      header: "Result",
                      cell: (c) => (
                        <Badge tone={c.passed ? "success" : "danger"}>
                          {c.passed ? "agrees" : "differs"}
                        </Badge>
                      ),
                    },
                  ]}
                />
              </div>
            </Section>
          ) : null}
          {r.spec ? (
            <Section title="Official validation results">
              <DataTable
                caption="Official validation"
                rows={r.validations}
                rowKey={(v) => v.id}
                empty="No official validation recorded: the file is not valid."
                columns={[
                  {
                    header: "When",
                    kind: "nowrap",
                    cell: (v) => v.recorded_at.slice(0, 16).replace("T", " "),
                  },
                  { header: "Tool", cell: (v) => `${v.tool} ${v.tool_version ?? ""}` },
                  { header: "Result", cell: (v) => v.result },
                  {
                    header: "Log",
                    cell: (v) => (
                      <pre className="max-w-md whitespace-pre-wrap text-xs">{v.log}</pre>
                    ),
                  },
                ]}
              />
              {current ? (
                <details className="mt-3 rounded-md border border-[var(--border)] p-3">
                  <summary className="cursor-pointer text-sm">
                    Record a validation result for this file
                  </summary>
                  <div className="mt-3">
                    <ActionForm action={outputRunAction} submitLabel="Record result">
                      {hidden("record_validation")}
                      <input type="hidden" name="sha256" value={r.content_sha256 ?? ""} />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                        <Select
                          label="Kind"
                          name="kind"
                          options={[
                            { value: "official_tool", label: "Official validation tool" },
                            { value: "esubmission_reply", label: "eSubmission reply" },
                          ]}
                        />
                        <Field label="Tool" name="tool" defaultValue={r.spec.official_tool ?? ""} />
                        <Field
                          label="Version"
                          name="toolVersion"
                          defaultValue={r.spec.official_tool_version ?? ""}
                        />
                        <Select
                          label="Result"
                          name="result"
                          options={[
                            { value: "passed", label: "Passed" },
                            { value: "failed", label: "Failed" },
                            { value: "accepted", label: "Accepted (reply)" },
                            { value: "rejected", label: "Rejected (reply)" },
                          ]}
                        />
                      </div>
                      <TextArea
                        label="Paste the tool's output / reply (log)"
                        name="log"
                        rows={4}
                        required
                      />
                      <Field label="Reference" name="reference" maxLength={200} />
                    </ActionForm>
                  </div>
                </details>
              ) : null}
            </Section>
          ) : null}
          {r.status === "validated" &&
          hasFirmRole(access, ["firm_manager", "reviewer"]) &&
          r.generated_by !== access.user_id ? (
            <Section title="Sign-off">
              <ActionForm action={outputRunAction} submitLabel="Sign off" variant="primary">
                {hidden("sign_off")}
                <TextArea label="Sign-off statement" name="note" rows={3} required />
              </ActionForm>
            </Section>
          ) : null}
          {r.signoff_statement ? (
            <Alert tone="success" title="Signed off">
              {r.signoff_statement}
            </Alert>
          ) : null}
        </>
      );
    },
  );
}
