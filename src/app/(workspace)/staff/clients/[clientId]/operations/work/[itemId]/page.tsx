import type { Metadata } from "next";
import { Suspense } from "react";

import { NotFoundState } from "@/components/ui/access-states";
import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { LinkButton, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { opsClientAction } from "@/features/operations/actions";
import { EventTrail, OpsBadge, OverdueBadge, WORK_KINDS, who } from "@/features/operations/labels";
import { pathFor } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { eligibleStaff, getWorkItem, staffNames } from "@/server/data/operations";

export const metadata: Metadata = { title: "Work item" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function WorkItemPage({
  params,
}: PageProps<"/staff/clients/[clientId]/operations/work/[itemId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorkItem params={params} />
    </Suspense>
  );
}

async function WorkItem({ params }: { params: Promise<{ clientId: string; itemId: string }> }) {
  const { clientId, itemId } = await params;
  return renderStaffClientPage(
    "staff.work_item",
    { clientId },
    "Work item",
    async ({ access, client }) => {
      const c = client.id;
      const w = UUID.test(itemId) ? await getWorkItem(c, itemId.toLowerCase()) : null;
      if (!w) return <NotFoundState />;
      const [names, staff] = await Promise.all([staffNames(), eligibleStaff(c)]);
      const me = access.user_id;
      const manager = hasFirmRole(access, ["firm_manager"]);
      const closed = ["done", "cancelled"].includes(w.status);
      const doer = w.assignee_id === me || manager || (!w.assignee_id && w.reviewer_id !== me);
      const reviewerTurn =
        w.status === "in_review" && w.assignee_id !== me && (w.reviewer_id === me || manager);

      const moves: { label: string; value: string }[] = [];
      if (doer && ["open", "waiting_client"].includes(w.status))
        moves.push({ label: "Start / resume", value: "in_progress" });
      if (doer && ["open", "in_progress"].includes(w.status))
        moves.push({ label: "Waiting for client", value: "waiting_client" });
      if (doer && w.status === "in_progress") {
        moves.push(
          w.requires_review
            ? { label: "Submit for review", value: "in_review" }
            : { label: "Mark done", value: "done" },
        );
      }
      if (reviewerTurn) {
        moves.push(
          { label: "Approve (done)", value: "done" },
          { label: "Return", value: "in_progress" },
        );
      }
      if (!closed && (w.created_by === me || manager))
        moves.push({ label: "Cancel item", value: "cancelled" });

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

      return (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <LinkButton href={pathFor("staff.operations", { clientId: c })}>
              ← Operations
            </LinkButton>
            {w.link_type === "filing" && w.link_id ? (
              <LinkButton href={pathFor("staff.filing", { clientId: c, itemId: w.link_id })}>
                Linked filing
              </LinkButton>
            ) : null}
            {w.link_type === "journal_entry" && w.link_id ? (
              <LinkButton href={pathFor("staff.entry", { clientId: c, entryId: w.link_id })}>
                Linked entry
              </LinkButton>
            ) : null}
            {w.link_type === "intake_transaction" && w.link_id ? (
              <LinkButton href={pathFor("staff.intake_txn", { clientId: c, itemId: w.link_id })}>
                Linked submission
              </LinkButton>
            ) : null}
          </div>
          <Section title={w.title}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <OpsBadge status={w.status} />
              <span>{WORK_KINDS[w.kind] ?? w.kind}</span>
              <span>· priority {w.priority}</span>
              {w.due_on ? <span>· due {w.due_on}</span> : null}
              <OverdueBadge due={w.due_on} closed={closed} />
            </div>
            {w.details ? <p className="mb-3 text-sm whitespace-pre-wrap">{w.details}</p> : null}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <dt className="text-[var(--muted)]">Assignee</dt>
              <dd>{who(names, w.assignee_id)}</dd>
              <dt className="text-[var(--muted)]">Reviewer</dt>
              <dd>{w.requires_review ? who(names, w.reviewer_id) : "no review required"}</dd>
              <dt className="text-[var(--muted)]">Created by</dt>
              <dd>{who(names, w.created_by)}</dd>
              <dt className="text-[var(--muted)]">Completed</dt>
              <dd>
                {w.completed_by
                  ? `${who(names, w.completed_by)} · ${w.completed_at?.slice(0, 10)}`
                  : "—"}
              </dd>
            </dl>
          </Section>

          {moves.length > 0 ? (
            <Section title="Update status">
              <ActionForm
                action={opsClientAction}
                submitLabel=""
                buttons={moves.map((m) => ({
                  label: m.label,
                  name: "to_status",
                  value: m.value,
                  variant: m.value === "cancelled" ? ("danger" as const) : ("secondary" as const),
                }))}
              >
                <input type="hidden" name="clientId" value={c} />
                <input type="hidden" name="op" value="work_transition" />
                <input type="hidden" name="id" value={w.id} />
                <input type="hidden" name="version" value={w.version} />
                <Field label="Note (required to return or cancel)" name="note" maxLength={2000} />
              </ActionForm>
              {w.assignee_id === me && w.status === "in_review" ? (
                <p className="mt-2 text-xs text-[var(--muted)]">
                  You did this work, so another person must review it.
                </p>
              ) : null}
            </Section>
          ) : null}

          {!closed && (manager || !w.assignee_id) ? (
            <Section title={manager ? "Reassign" : "Claim this item"}>
              <ActionForm
                action={opsClientAction}
                submitLabel={manager ? "Save assignment" : "Claim"}
              >
                <input type="hidden" name="clientId" value={c} />
                <input type="hidden" name="op" value="assign_work" />
                <input type="hidden" name="id" value={w.id} />
                <input type="hidden" name="version" value={w.version} />
                {manager ? (
                  <>
                    <Select
                      label="Assignee"
                      name="assigneeId"
                      options={staffOptions}
                      defaultValue={w.assignee_id ?? ""}
                    />
                    <Select
                      label="Reviewer"
                      name="reviewerId"
                      options={reviewerOptions}
                      defaultValue={w.reviewer_id ?? ""}
                    />
                    <Field
                      label="Reason (required when replacing someone)"
                      name="reason"
                      maxLength={500}
                    />
                  </>
                ) : (
                  <>
                    <input type="hidden" name="assigneeId" value={me} />
                    <input type="hidden" name="reviewerId" value={w.reviewer_id ?? ""} />
                  </>
                )}
              </ActionForm>
            </Section>
          ) : null}

          <Section title="History">
            <EventTrail events={w.events} names={names} />
          </Section>
        </>
      );
    },
  );
}
