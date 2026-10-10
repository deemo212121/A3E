import "server-only";

import { randomUUID } from "node:crypto";

import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { Alert, Section } from "@/components/ui/primitives";
import { saveProfileAction, transitionProfileAction } from "@/features/intake/actions";
import { CommentForm, StatusBadge, Timeline } from "@/features/intake/components/intake-ui";
import { BUSINESS_TYPES, labelOf, VAT_STATUSES } from "@/lib/intake/rules";
import type { Access } from "@/server/auth/access";
import { getTimeline, listProfiles, type ProfileRow } from "@/server/data/intake";
import { canApproveIntake, canProposeProfile, isStaffOn } from "@/server/intake/access";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function ProfileFacts({ p }: { p: ProfileRow }) {
  const row = (label: string, value: string | number | null) => (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {row("Registered name", p.registered_name)}
      {row("Trade name", p.trade_name)}
      {row("TIN", p.tin)}
      {row("RDO code", p.rdo_code)}
      {row("Business type", p.business_type ? labelOf(BUSINESS_TYPES, p.business_type) : null)}
      {row(
        "VAT registration (as declared)",
        p.vat_status ? labelOf(VAT_STATUSES, p.vat_status) : null,
      )}
      {row("Registered address", p.registered_address)}
      {row("ZIP code", p.zip_code)}
      {row("Line of business", p.line_of_business)}
      {row(
        "Fiscal year ends",
        p.fiscal_year_end_month ? MONTHS[p.fiscal_year_end_month - 1] : null,
      )}
      {row("Contact email", p.contact_email)}
      {row("Contact phone", p.contact_phone)}
    </dl>
  );
}

function ProfileForm({ clientId, base }: { clientId: string; base?: ProfileRow }) {
  const editing = base && ["draft", "needs_correction"].includes(base.status) ? base : undefined;
  return (
    <ActionForm
      action={saveProfileAction}
      submitLabel="Save"
      className="flex flex-col gap-3"
      buttons={[
        { label: "Save draft", name: "intent", value: "save" },
        {
          label: "Save and submit for review",
          name: "intent",
          value: "submit",
          variant: "primary",
        },
      ]}
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="profileId" value={editing?.id ?? ""} />
      <input type="hidden" name="expectedVersion" value={editing?.row_version ?? ""} />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Registered name *"
          name="registeredName"
          defaultValue={base?.registered_name ?? ""}
          maxLength={200}
        />
        <Field
          label="Trade name"
          name="tradeName"
          defaultValue={base?.trade_name ?? ""}
          maxLength={200}
        />
        <Field
          label="TIN *"
          name="tin"
          defaultValue={base?.tin ?? ""}
          placeholder="000-000-000-00000"
          inputMode="numeric"
        />
        <Field
          label="RDO code"
          name="rdoCode"
          defaultValue={base?.rdo_code ?? ""}
          placeholder="e.g. 025"
        />
        <Select
          label="Business type *"
          name="businessType"
          options={[{ value: "", label: "—" }, ...BUSINESS_TYPES]}
          defaultValue={base?.business_type ?? ""}
        />
        <Select
          label="VAT registration (as declared) *"
          name="vatStatus"
          options={[{ value: "", label: "—" }, ...VAT_STATUSES]}
          defaultValue={base?.vat_status ?? ""}
        />
        <div className="sm:col-span-2">
          <TextArea
            label="Registered address *"
            name="registeredAddress"
            rows={2}
            maxLength={500}
            defaultValue={base?.registered_address ?? ""}
          />
        </div>
        <Field
          label="ZIP code *"
          name="zipCode"
          defaultValue={base?.zip_code ?? ""}
          inputMode="numeric"
        />
        <Field
          label="Line of business *"
          name="lineOfBusiness"
          defaultValue={base?.line_of_business ?? ""}
          maxLength={200}
        />
        <Select
          label="Fiscal year ends in *"
          name="fiscalYearEndMonth"
          options={[
            { value: "", label: "—" },
            ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m })),
          ]}
          defaultValue={base?.fiscal_year_end_month ? String(base.fiscal_year_end_month) : ""}
        />
        <Field
          label="Contact email"
          name="contactEmail"
          type="email"
          defaultValue={base?.contact_email ?? ""}
        />
        <Field
          label="Contact phone"
          name="contactPhone"
          type="tel"
          defaultValue={base?.contact_phone ?? ""}
        />
        <div className="sm:col-span-2">
          <TextArea
            label="Notes for the accountant"
            name="notes"
            rows={2}
            maxLength={1000}
            defaultValue={base?.notes ?? ""}
          />
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">
        * needed to submit. Registration details are recorded as you declare them; the firm verifies
        them against your registration documents.
      </p>
    </ActionForm>
  );
}

/** Business profile: current approved version, the change in progress, history. */
export async function ProfileView({ access, clientId }: { access: Access; clientId: string }) {
  const profiles = await listProfiles(clientId);
  const current = profiles.find((p) => p.status === "approved");
  const open = profiles.find((p) => ["draft", "submitted", "needs_correction"].includes(p.status));
  const staff = isStaffOn(access, clientId);
  const proposer = canProposeProfile(access, clientId);
  const approver = canApproveIntake(access, clientId);
  const timeline = open ? await getTimeline(clientId, "business_profile", open.id) : [];
  const hidden = (to: string) => (
    <>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="id" value={open?.id ?? ""} />
      <input type="hidden" name="to" value={to} />
    </>
  );

  return (
    <>
      <Section title={current ? `Current profile (version ${current.version})` : "Current profile"}>
        {current ? (
          <ProfileFacts p={current} />
        ) : (
          <p className="text-sm text-[var(--muted)]">No approved profile yet.</p>
        )}
      </Section>

      {open ? (
        <Section title={`Change in progress (version ${open.version})`}>
          <div className="mb-3 flex items-center gap-2">
            <StatusBadge status={open.status} />
          </div>
          <ProfileFacts p={open} />
          <div className="mt-4 flex flex-col gap-3">
            {open.status === "submitted" && approver && open.submitted_by !== access.user_id ? (
              <div className="flex flex-wrap gap-2">
                <ActionForm
                  action={transitionProfileAction}
                  submitLabel="Approve"
                  variant="primary"
                >
                  {hidden("approved")}
                </ActionForm>
              </div>
            ) : null}
            {open.status === "submitted" && approver && open.submitted_by === access.user_id ? (
              <Alert tone="info">
                You submitted this change, so another reviewer or manager must approve it.
              </Alert>
            ) : null}
            {open.status === "submitted" && staff ? (
              <details className="rounded-md border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Return for correction
                </summary>
                <div className="mt-3">
                  <ActionForm action={transitionProfileAction} submitLabel="Return for correction">
                    {hidden("needs_correction")}
                    <TextArea label="What needs to change?" name="comment" rows={2} required />
                  </ActionForm>
                </div>
              </details>
            ) : null}
            {proposer && ["draft", "needs_correction"].includes(open.status) ? (
              <ActionForm
                action={transitionProfileAction}
                submitLabel="Discard this change"
                variant="danger"
                confirmMessage="Discard this profile change?"
              >
                {hidden("cancelled")}
              </ActionForm>
            ) : null}
          </div>
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium">History</h3>
            <Timeline items={timeline} />
            {proposer || staff ? (
              <div className="mt-3">
                <CommentForm
                  clientId={clientId}
                  subject="business_profile"
                  subjectId={open.id}
                  staff={staff}
                />
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {proposer && (!open || ["draft", "needs_correction"].includes(open.status)) ? (
        <Section
          title={
            open ? "Edit the change" : current ? "Propose a change" : "Set up the business profile"
          }
        >
          <ProfileForm clientId={clientId} base={open ?? current} />
        </Section>
      ) : !proposer ? (
        <Alert tone="info">
          Only the business owner or the firm can propose changes to the business profile.
        </Alert>
      ) : null}
    </>
  );
}
