import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { taxRuleAction } from "@/features/tax/actions";
import { STATUS_TONE } from "@/features/tax/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { listTaxRules } from "@/server/data/tax";

export const metadata: Metadata = { title: "Tax rules registry" };

// Structure only: every value must come from the cited official issuance.
const TEMPLATE = JSON.stringify(
  {
    code: "RULE_CODE",
    name: "Name of the computation",
    tax_type: "other",
    effective_from: "YYYY-MM-DD",
    effective_to: null,
    eligibility: [{ fact: "vat_status", op: "eq", value: "vat_registered" }],
    inputs: [{ name: "base_amount", label: "Base amount", source: "ledger" }],
    params: { rate: "0" },
    formula: {
      steps: [
        {
          name: "tax_due",
          expr: {
            round: { op: "mul", args: [{ input: "base_amount" }, { param: "rate" }] },
            places: 2,
          },
        },
      ],
      outputs: ["tax_due"],
    },
    rounding: { places: 2, mode: "half_away_from_zero" },
    sources: [
      { citation: "Issuance number and section", title: "", url: "", issued_on: "YYYY-MM-DD" },
    ],
  },
  null,
  2,
);

export default function TaxRulesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TaxRules />
    </Suspense>
  );
}

async function TaxRules() {
  const { access, decision } = await guardRoute("tax_rules");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const rules = await listTaxRules();
  const editor = hasFirmRole(access, ["firm_manager", "reviewer"]);
  return (
    <div data-route="tax_rules">
      <PageHeader
        title="Tax rules registry"
        description="Versioned, source-cited tax computations. Only approved rules ever compute."
      />
      <Alert tone="warning" title="No tax rules are built in">
        A rule computes only after: its official sources are cited; worked expected results
        (including boundary cases) are reviewed by an accountant other than their author; every
        expected result passes; and a reviewer or manager other than the rule&apos;s author approves
        it, confirming they checked the sources. Anything else is reported as unsupported or as
        needing professional review. Computed figures are working papers, not filed returns.
      </Alert>
      <Section title="Rules">
        <DataTable
          caption="Tax rules"
          rows={rules}
          rowKey={(r) => r.id}
          empty="No tax rules yet."
          columns={[
            {
              header: "Rule",
              cell: (r) => (
                <Link
                  className="font-medium text-[var(--accent)] hover:underline"
                  href={pathFor("tax_rule", { itemId: r.id })}
                >
                  {r.code} v{r.version}
                </Link>
              ),
            },
            { header: "Name", cell: (r) => r.name },
            { header: "Type", hideOnMobile: true, cell: (r) => r.tax_type.replace(/_/g, " ") },
            {
              header: "In effect",
              kind: "nowrap",
              cell: (r) => `${r.effective_from} – ${r.effective_to ?? "open"}`,
            },
            {
              header: "Status",
              cell: (r) => (
                <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                  {r.status.replace("_", " ")}
                </Badge>
              ),
            },
          ]}
        />
      </Section>
      {editor ? (
        <Section title="Enter a rule (draft)">
          <p className="mb-2 text-sm text-[var(--muted)]">
            Formula language and fields: docs/tax/TAX-ENGINE.md. Replace every placeholder with
            values from the cited issuance. A new version of an existing code is created
            automatically.
          </p>
          <ActionForm action={taxRuleAction} submitLabel="Save draft rule">
            <input type="hidden" name="op" value="propose" />
            <TextArea label="Rule (JSON)" name="json" rows={24} defaultValue={TEMPLATE} />
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
