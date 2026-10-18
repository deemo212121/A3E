import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { taxFormAction } from "@/features/tax/form-actions";
import { STATUS_TONE } from "@/features/tax/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { listForms } from "@/server/data/forms";

export const metadata: Metadata = { title: "Tax forms registry" };

// Structure only: every line, version and source must come from the official form.
const TEMPLATE = JSON.stringify(
  {
    form_code: "FORM_CODE",
    title: "Form title",
    official_version: "Official form version as printed",
    frequency: "monthly",
    effective_from: "YYYY-MM-DD",
    effective_to: null,
    eligibility: [],
    definition: {
      lines: [
        {
          code: "1",
          label: "Line label",
          kind: "tax_output",
          rule_code: "RULE_CODE",
          output: "tax_due",
        },
        { code: "2", label: "Manual line", kind: "manual" },
        {
          code: "3",
          label: "Total",
          kind: "formula",
          expr: { op: "add", args: [{ input: "1" }, { input: "2" }] },
        },
      ],
      schedules: [
        { code: "S1", title: "Supporting schedule", rule_code: "RULE_CODE", input: "base_amount" },
      ],
      validations: [
        {
          code: "NEGATIVE",
          severity: "error",
          message: "Total cannot be negative",
          when: { cmp: "lt", args: [{ input: "3" }, "0"] },
        },
      ],
    },
    rounding: { places: 2, mode: "half_away_from_zero" },
    sources: [{ citation: "Official form and instructions", issued_on: "YYYY-MM-DD", url: "" }],
    limitations: "What this workpaper does not cover; no filing integration.",
  },
  null,
  2,
);

export default function TaxFormsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TaxForms />
    </Suspense>
  );
}

async function TaxForms() {
  const { access, decision } = await guardRoute("tax_forms");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const forms = await listForms();
  const editor = hasFirmRole(access, ["firm_manager", "reviewer"]);
  return (
    <div data-route="tax_forms">
      <PageHeader
        title="Tax forms registry"
        description="Form definitions with sources, lines, schedules and validations."
      />
      <Alert tone="warning" title="No BIR forms are defined">
        A form is used only after (1) it is verified: official form version and sources cited,
        accountant-reviewed normal and boundary fixtures all passing, approved by someone other than
        its author; and (2) a firm manager records a documented accountant sign-off for production.
        Workpapers are exported as CSV; there is no filing integration.
      </Alert>
      <Section title="Forms">
        <DataTable
          caption="Tax forms"
          rows={forms}
          rowKey={(f) => f.id}
          empty="No form definitions yet."
          columns={[
            {
              header: "Form",
              cell: (f) => (
                <Link
                  className="font-medium text-[var(--accent)] hover:underline"
                  href={pathFor("tax_form", { itemId: f.id })}
                >
                  {f.form_code} v{f.version}
                </Link>
              ),
            },
            { header: "Title", cell: (f) => f.title },
            { header: "Official version", hideOnMobile: true, cell: (f) => f.official_version },
            {
              header: "In effect",
              kind: "nowrap",
              cell: (f) => `${f.effective_from} – ${f.effective_to ?? "open"}`,
            },
            {
              header: "Status",
              cell: (f) => (
                <Badge
                  tone={f.status === "enabled" ? "success" : (STATUS_TONE[f.status] ?? "neutral")}
                >
                  {f.status.replace("_", " ")}
                </Badge>
              ),
            },
          ]}
        />
      </Section>
      {editor ? (
        <Section title="Enter a form definition (draft)">
          <p className="mb-2 text-sm text-[var(--muted)]">
            Fields and line kinds: docs/tax/FORMS.md. Replace every placeholder from the official
            form.
          </p>
          <ActionForm action={taxFormAction} submitLabel="Save draft form">
            <input type="hidden" name="op" value="propose" />
            <TextArea
              label="Form definition (JSON)"
              name="json"
              rows={24}
              defaultValue={TEMPLATE}
            />
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
