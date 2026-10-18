import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { opsFirmAction } from "@/features/operations/actions";
import { OpsBadge, who } from "@/features/operations/labels";
import { hasFirmRole } from "@/server/auth/access";
import { guardRoute } from "@/server/auth/route-guard";
import { listDeadlineRules, staffNames } from "@/server/data/operations";

export const metadata: Metadata = { title: "Deadline rules" };

export default function DeadlinesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Deadlines />
    </Suspense>
  );
}

async function Deadlines() {
  const { access, decision } = await guardRoute("deadlines");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const [rules, names] = await Promise.all([listDeadlineRules(), staffNames()]);
  const me = access.user_id;
  const verifier = hasFirmRole(access, ["firm_manager", "reviewer"]);
  const proposer = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
  const manager = hasFirmRole(access, ["firm_manager"]);

  return (
    <div data-route="deadlines">
      <PageHeader
        title="Deadline rules"
        description="How the firm computes due dates for returns, client submissions and internal steps."
      />
      <Alert tone="warning" title="No statutory deadline is built in">
        Every rule is entered by the firm with its source (issuance and date) and stays{" "}
        <strong>PENDING VERIFICATION</strong> until a reviewer or manager other than the author
        checks it against that source. Holidays are not known to the system.
      </Alert>
      <Section title="Rules">
        <DataTable
          caption="Deadline rules"
          rows={rules}
          rowKey={(r) => r.id}
          empty="No rules yet."
          columns={[
            { header: "Code", cell: (r) => r.code },
            { header: "Title", cell: (r) => `${r.title}${r.form_code ? ` (${r.form_code})` : ""}` },
            {
              header: "Due",
              cell: (r) =>
                `${r.frequency}: day ${r.due_day}, ${r.due_months_after} month(s) after period end${
                  r.weekend_rule === "next_weekday" ? ", weekend → Monday" : ""
                }${r.skip_periods.length ? `; no filing for period(s) ${r.skip_periods.join(", ")}` : ""}`,
            },
            {
              header: "Source",
              hideOnMobile: true,
              cell: (r) =>
                r.source.citation
                  ? `${r.source.citation}${r.source.issued_on ? ` (${r.source.issued_on})` : ""}`
                  : "—",
            },
            { header: "Status", cell: (r) => <OpsBadge status={r.status} /> },
            {
              header: "By",
              hideOnMobile: true,
              cell: (r) =>
                `${who(names, r.entered_by)}${r.verified_by ? ` / verified ${who(names, r.verified_by)}` : ""}`,
            },
            {
              header: "Actions",
              srOnlyHeader: true,
              cell: (r) =>
                r.status === "pending_verification" && verifier && r.entered_by !== me ? (
                  <ActionForm
                    action={opsFirmAction}
                    submitLabel="Verify"
                    className="flex flex-col gap-2"
                  >
                    <input type="hidden" name="op" value="verify_rule" />
                    <input type="hidden" name="id" value={r.id} />
                    <Field label="What you checked" name="note" required maxLength={1000} />
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="attest" /> I checked this rule against its source
                    </label>
                  </ActionForm>
                ) : r.status !== "retired" && manager ? (
                  <ActionForm
                    action={opsFirmAction}
                    submitLabel="Retire"
                    variant="danger"
                    className="flex flex-col gap-2"
                  >
                    <input type="hidden" name="op" value="retire_rule" />
                    <input type="hidden" name="id" value={r.id} />
                    <Field label="Why" name="note" required maxLength={500} />
                  </ActionForm>
                ) : null,
            },
          ]}
        />
      </Section>
      {proposer ? (
        <Section title="Propose a rule">
          <ActionForm action={opsFirmAction} submitLabel="Propose">
            <input type="hidden" name="op" value="propose_rule" />
            <Field
              label="Code"
              name="code"
              required
              maxLength={40}
              hint="Capital letters, digits, - or _"
            />
            <Field label="Title" name="title" required maxLength={200} />
            <Select
              label="Kind"
              name="kind"
              options={[
                { value: "tax_return", label: "Tax return (source required)" },
                { value: "document_submission", label: "Client document submission" },
                { value: "internal", label: "Internal firm deadline" },
              ]}
            />
            <Field label="Form code (optional)" name="formCode" maxLength={40} />
            <Select
              label="Frequency"
              name="frequency"
              options={["monthly", "quarterly", "annual"].map((v) => ({ value: v, label: v }))}
            />
            <Field
              label="Months after the period ends"
              name="dueMonthsAfter"
              required
              inputMode="numeric"
            />
            <Field
              label="Day of that month (1-31; clamped to month end)"
              name="dueDay"
              required
              inputMode="numeric"
            />
            <Select
              label="Weekend"
              name="weekendRule"
              options={[
                { value: "none", label: "Keep the date" },
                { value: "next_weekday", label: "Move Saturday/Sunday to Monday" },
              ]}
            />
            <Field
              label="Periods with no filing (comma list, fiscal months 1-12 or quarters 1-4)"
              name="skipPeriods"
            />
            <Field
              label="Reminder days before due (comma list)"
              name="reminderDays"
              defaultValue="7, 3, 1"
            />
            <Field label="Source citation (issuance and section)" name="citation" maxLength={500} />
            <Field label="Source issue date" name="issuedOn" type="date" />
            <Field label="Source URL" name="url" maxLength={500} />
            <TextArea label="Notes" name="note" maxLength={1000} />
          </ActionForm>
        </Section>
      ) : null}
    </div>
  );
}
