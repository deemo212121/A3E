import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, Field, Select, TextArea } from "@/components/ui/action-form";
import { Alert, LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { opsClientAction } from "@/features/operations/actions";
import {
  EventTrail,
  FILING_STEPS,
  OpsBadge,
  OverdueBadge,
  who,
} from "@/features/operations/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { listRuns } from "@/server/data/eoutputs";
import { listWorkpapers } from "@/server/data/forms";
import { eligibleStaff, getFiling, staffNames } from "@/server/data/operations";

export const metadata: Metadata = { title: "Filing" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (t: string | null) => (t ? t.slice(0, 16).replace("T", " ") : "");

export default function FilingPage({
  params,
}: PageProps<"/staff/clients/[clientId]/operations/filings/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Filing params={params} />
    </Suspense>
  );
}

async function Filing({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.filing",
    { clientId },
    "Filing",
    async ({ access, client }) => {
      const c = client.id;
      const f = UUID.test(itemId) ? await getFiling(c, itemId.toLowerCase()) : null;
      if (!f) return <NotFoundState />;
      const [names, staff, workpapers, runs] = await Promise.all([
        staffNames(),
        eligibleStaff(c),
        listWorkpapers(c),
        listRuns(c),
      ]);
      const me = access.user_id;
      const manager = hasFirmRole(access, ["firm_manager"]);
      const reviewerRole = hasFirmRole(access, ["firm_manager", "reviewer"]);
      const preparerRole = hasFirmRole(access, ["firm_manager", "reviewer", "accountant"]);
      const closed = ["filed", "not_required"].includes(f.status);
      const stepIndex = FILING_STEPS.findIndex(([s]) => s === f.status);
      const matchingWps = workpapers.filter(
        (w) =>
          w.form_code === f.form_code &&
          w.period_from === f.period_from &&
          w.period_to === f.period_to &&
          ["prepared", "signed_off"].includes(w.status),
      );
      const validRuns = runs.filter((r) => ["validated", "signed_off"].includes(r.status));
      const step = (
        s: string,
        label: string,
        children?: React.ReactNode,
        buttons?: { label: string; value: string }[],
      ) => (
        <ActionForm
          action={opsClientAction}
          submitLabel={label}
          buttons={buttons?.map((b) => ({ label: b.label, name: "step", value: b.value }))}
        >
          <input type="hidden" name="clientId" value={c} />
          <input type="hidden" name="op" value="filing" />
          <input type="hidden" name="id" value={f.id} />
          <input type="hidden" name="version" value={f.version} />
          {buttons ? null : <input type="hidden" name="step" value={s} />}
          {children}
        </ActionForm>
      );
      const staffOptions = [
        { value: "", label: "— none —" },
        ...staff.map((s) => ({ value: s.user_id, label: s.label })),
      ];
      const reviewerOptions = [
        { value: "", label: "— none —" },
        ...staff
          .filter((s) => s.role === "firm_manager" || s.role === "reviewer")
          .map((s) => ({ value: s.user_id, label: s.label })),
      ];

      let next: React.ReactNode = null;
      if (
        f.status === "not_started" &&
        preparerRole &&
        (!f.preparer_id || f.preparer_id === me || manager)
      ) {
        next = step("start", "Start preparation");
      } else if (f.status === "in_preparation" && f.preparer_id === me) {
        next = step(
          "prepared",
          "Mark prepared",
          <>
            <Select
              label="Workpaper (same form and period)"
              name="workpaperId"
              options={[
                { value: "", label: "— none (describe below) —" },
                ...matchingWps.map((w) => ({
                  value: w.id,
                  label: `${w.status} · ${when(w.prepared_at)}`,
                })),
              ]}
            />
            <TextArea
              label="How it was prepared (required without a workpaper)"
              name="note"
              maxLength={2000}
            />
          </>,
        );
      } else if (f.status === "prepared" && (f.prepared_by === me || manager)) {
        next = f.reviewer_id ? (
          step("submit", "Submit for review")
        ) : (
          <Alert tone="warning">Assign a reviewer before submitting for review.</Alert>
        );
      } else if (
        f.status === "in_review" &&
        reviewerRole &&
        f.prepared_by !== me &&
        (f.reviewer_id === me || manager)
      ) {
        next = step(
          "approve",
          "",
          <TextArea
            label="Review note (what you checked, or what must change)"
            name="note"
            required
            maxLength={2000}
          />,
          [
            { label: "Approve", value: "approve" },
            { label: "Return to preparer", value: "return" },
          ],
        );
      } else if (f.status === "approved" && preparerRole) {
        next = step(
          "export",
          "Record export",
          <>
            <Select
              label="How the return was produced"
              name="method"
              options={[
                { value: "official_form_tool", label: "Entered in the official form tool" },
                { value: "manual_form", label: "Manual form" },
                {
                  value: "validated_file",
                  label: "Validated electronic output (from the Tax tab)",
                },
              ]}
            />
            <Select
              label="Validated output (only for a validated file)"
              name="outputRunId"
              options={[
                { value: "", label: "—" },
                ...validRuns.map((r) => ({
                  value: r.id,
                  label: `${r.output_code} ${r.period_from} – ${r.period_to} (${r.status})`,
                })),
              ]}
            />
            <Field
              label="Where the exported return is kept (file name or reference)"
              name="reference"
              maxLength={300}
            />
            <p className="text-xs text-[var(--muted)]">
              Exporting is not filing. Confirm the filing after it is actually submitted.
            </p>
          </>,
        );
      } else if (f.status === "exported" && preparerRole) {
        next = step(
          "confirm_filed",
          "Confirm actual filing",
          <>
            <Field label="Filed on" name="filedOn" type="date" required />
            <Field
              label="Filing channel"
              name="channel"
              required
              maxLength={100}
              hint="Where it was submitted, as the firm records it"
            />
            <Field
              label="Confirmation / reference number"
              name="reference"
              required
              maxLength={200}
            />
            <TextArea
              label="Where the proof is kept (e.g. the uploaded confirmation)"
              name="evidence"
              required
              maxLength={1000}
            />
          </>,
        );
      }

      return (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <LinkButton href={pathFor("staff.operations", { clientId: c })}>
              ← Operations
            </LinkButton>
            {f.workpaper_id ? (
              <LinkButton
                href={pathFor("staff.workpaper", { clientId: c, itemId: f.workpaper_id })}
              >
                Workpaper
              </LinkButton>
            ) : null}
            {f.amends_id ? (
              <LinkButton href={pathFor("staff.filing", { clientId: c, itemId: f.amends_id })}>
                Original return
              </LinkButton>
            ) : null}
          </div>
          <Section title={`${f.form_code} · ${f.period_from} to ${f.period_to}`}>
            <p className="mb-2 text-sm">{f.title}</p>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <OpsBadge status={f.status} />
              <span>
                Due {f.due_on} ({f.due_basis.replace(/_/g, " ")})
              </span>
              <OverdueBadge due={f.due_on} closed={closed} />
            </div>
            <ol className="mb-4 flex flex-wrap gap-2 text-xs" aria-label="Filing steps">
              {FILING_STEPS.map(([s, label], i) => (
                <li
                  key={s}
                  aria-current={s === f.status ? "step" : undefined}
                  className={`rounded-full border px-2 py-0.5 ${
                    s === f.status
                      ? "border-[var(--accent)] font-semibold"
                      : i < stepIndex
                        ? "border-[var(--success)] text-[var(--success)]"
                        : "border-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {i + 1}. {label}
                </li>
              ))}
            </ol>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <dt className="text-[var(--muted)]">Preparer / reviewer</dt>
              <dd>
                {who(names, f.preparer_id)} / {who(names, f.reviewer_id)}
              </dd>
              <dt className="text-[var(--muted)]">Prepared</dt>
              <dd>
                {f.prepared_by ? `${who(names, f.prepared_by)} · ${when(f.prepared_at)}` : "—"}
              </dd>
              <dt className="text-[var(--muted)]">Approved</dt>
              <dd>
                {f.approved_by
                  ? `${who(names, f.approved_by)} · ${when(f.approved_at)} · ${f.approval_note}`
                  : "—"}
              </dd>
              <dt className="text-[var(--muted)]">Exported</dt>
              <dd>
                {f.exported_by
                  ? `${who(names, f.exported_by)} · ${when(f.exported_at)} · ${(f.export_method ?? "").replace(/_/g, " ")}${f.export_reference ? ` · ${f.export_reference}` : ""}`
                  : "—"}
              </dd>
              <dt className="text-[var(--muted)]">Filed (confirmed)</dt>
              <dd>
                {f.filed_confirmed_by
                  ? `${f.filed_on} via ${f.filing_channel} · ref ${f.filing_reference} · proof: ${f.filing_evidence} · confirmed by ${who(names, f.filed_confirmed_by)} ${when(f.filed_confirmed_at)}`
                  : "not filed"}
              </dd>
              {f.not_required_reason ? (
                <>
                  <dt className="text-[var(--muted)]">Not required</dt>
                  <dd>{f.not_required_reason}</dd>
                </>
              ) : null}
            </dl>
          </Section>

          {next ? <Section title="Next step">{next}</Section> : null}

          {!closed && (manager || (!f.preparer_id && preparerRole)) ? (
            <Section title={manager ? "Assign" : "Claim this filing"}>
              <ActionForm
                action={opsClientAction}
                submitLabel={manager ? "Save assignment" : "Claim"}
              >
                <input type="hidden" name="clientId" value={c} />
                <input type="hidden" name="op" value="assign_filing" />
                <input type="hidden" name="id" value={f.id} />
                <input type="hidden" name="version" value={f.version} />
                {manager ? (
                  <>
                    <Select
                      label="Preparer"
                      name="preparerId"
                      options={staffOptions}
                      defaultValue={f.preparer_id ?? ""}
                    />
                    <Select
                      label="Reviewer"
                      name="reviewerId"
                      options={reviewerOptions}
                      defaultValue={f.reviewer_id ?? ""}
                    />
                    <Field
                      label="Reason (required when replacing someone)"
                      name="reason"
                      maxLength={500}
                    />
                  </>
                ) : (
                  <>
                    <input type="hidden" name="preparerId" value={me} />
                    <input type="hidden" name="reviewerId" value={f.reviewer_id ?? ""} />
                  </>
                )}
              </ActionForm>
            </Section>
          ) : null}

          {manager && ["not_started", "in_preparation"].includes(f.status) ? (
            <Section title="No filing required">
              <ActionForm action={opsClientAction} submitLabel="Mark not required" variant="danger">
                <input type="hidden" name="clientId" value={c} />
                <input type="hidden" name="op" value="filing" />
                <input type="hidden" name="step" value="not_required" />
                <input type="hidden" name="id" value={f.id} />
                <input type="hidden" name="version" value={f.version} />
                <TextArea label="Why no filing is required" name="note" required maxLength={1000} />
              </ActionForm>
            </Section>
          ) : null}

          {f.status === "filed" && reviewerRole ? (
            <Section title="Corrections">
              <p className="mb-2 text-sm text-[var(--muted)]">
                A filed return is never edited. File an amended return, or, if the confirmation was
                recorded in error, request an exception from the Operations page.
              </p>
              <ActionForm action={opsClientAction} submitLabel="Start an amended return">
                <input type="hidden" name="clientId" value={c} />
                <input type="hidden" name="op" value="amend_filing" />
                <input type="hidden" name="id" value={f.id} />
                <TextArea
                  label="Why the return is amended"
                  name="reason"
                  required
                  maxLength={1000}
                />
              </ActionForm>
            </Section>
          ) : null}

          <Section title="History">
            <EventTrail events={f.events} names={names} />
          </Section>
        </>
      );
    },
  );
}
