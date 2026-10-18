import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/primitives";

type Tone = "neutral" | "info" | "warning" | "success" | "danger";

/** Filing steps in order. "filed" only ever comes from a filing confirmation. */
export const FILING_STEPS: [string, string][] = [
  ["not_started", "Not started"],
  ["in_preparation", "In preparation"],
  ["prepared", "Prepared"],
  ["in_review", "In review"],
  ["approved", "Approved"],
  ["exported", "Exported (not yet filed)"],
  ["filed", "Filed (confirmed)"],
];

const LABELS: Record<string, [string, Tone]> = {
  // filings
  not_started: ["not started", "neutral"],
  in_preparation: ["in preparation", "info"],
  prepared: ["prepared", "info"],
  approved: ["approved, not filed", "warning"],
  exported: ["exported, not filed", "warning"],
  filed: ["filed (confirmed)", "success"],
  not_required: ["not required", "neutral"],
  // work
  open: ["open", "neutral"],
  in_progress: ["in progress", "info"],
  waiting_client: ["waiting for client", "warning"],
  in_review: ["in review", "info"],
  done: ["done", "success"],
  cancelled: ["cancelled", "neutral"],
  // requests
  submitted: ["submitted by client", "info"],
  accepted: ["accepted", "success"],
  returned: ["returned to client", "warning"],
  // exceptions
  pending: ["pending decision", "warning"],
  rejected: ["rejected", "danger"],
  // rules
  pending_verification: ["PENDING VERIFICATION", "warning"],
  verified: ["verified", "success"],
  retired: ["retired", "neutral"],
  // service status
  active: ["active", "success"],
  awaiting_client: ["awaiting client", "warning"],
  on_hold: ["on hold", "warning"],
  suspended: ["suspended", "danger"],
  offboarding: ["offboarding", "warning"],
  ended: ["ended", "neutral"],
};

export function OpsBadge({ status }: { status: string }) {
  const [label, tone] = LABELS[status] ?? [status.replace(/_/g, " "), "neutral" as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

export function OverdueBadge({ due, closed }: { due: string | null; closed: boolean }) {
  if (!due || closed) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (due < today) return <Badge tone="danger">overdue</Badge>;
  if (due === today) return <Badge tone="warning">due today</Badge>;
  return null;
}

export const SERVICE_STATUSES = [
  "active",
  "awaiting_client",
  "on_hold",
  "suspended",
  "offboarding",
  "ended",
] as const;

export const EXCEPTION_KINDS: Record<string, string> = {
  reopen_locked_period: "Reopen a locked period",
  change_due_date: "Change a filing due date",
  withdraw_filing_confirmation: "Withdraw a filing confirmation",
  other: "Other exceptional action",
};

export const WORK_KINDS: Record<string, string> = {
  task: "Task",
  document_follow_up: "Document follow-up",
  correction: "Correction",
  review: "Review",
  exception: "Exception",
};

/** Accountability trail: every status change with who and when. */
export function EventTrail({
  events,
  names,
}: {
  events: {
    id: number;
    event: string;
    from_status: string | null;
    to_status: string | null;
    note: string | null;
    actor_id: string | null;
    occurred_at: string;
  }[];
  names: Map<string, string>;
}) {
  return (
    <DataTable
      caption="History"
      rows={events}
      rowKey={(e) => String(e.id)}
      empty="No history yet."
      columns={[
        {
          header: "When",
          kind: "nowrap",
          cell: (e) => e.occurred_at.slice(0, 16).replace("T", " "),
        },
        {
          header: "Who",
          cell: (e) => (e.actor_id ? (names.get(e.actor_id) ?? "client user") : "system"),
        },
        { header: "What", cell: (e) => e.event.replace(/_/g, " ") },
        {
          header: "Status",
          cell: (e) =>
            e.from_status && e.from_status !== e.to_status
              ? `${e.from_status.replace(/_/g, " ")} → ${(e.to_status ?? "").replace(/_/g, " ")}`
              : (e.to_status ?? "").replace(/_/g, " "),
        },
        { header: "Note", cell: (e) => e.note ?? "" },
      ]}
    />
  );
}

export const who = (names: Map<string, string>, id: string | null) =>
  id ? (names.get(id) ?? "—") : "unassigned";
