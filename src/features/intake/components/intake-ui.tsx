import { randomUUID } from "node:crypto";

import { ActionForm, Select, TextArea } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/primitives";
import { addCommentAction } from "@/features/intake/actions";
import { STATUS_LABELS, STATUS_TONES } from "@/lib/intake/rules";
import type { TimelineItem } from "@/lib/intake/types";

/* Shared, server-rendered pieces of the intake screens. */

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

/** Submission tracking: status changes and comments, oldest first. */
export function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) return <p className="text-sm text-[var(--muted)]">No activity yet.</p>;
  return (
    <ol className="flex flex-col gap-3 border-l-2 border-[var(--border)] pl-4">
      {items.map((t, i) => (
        <li key={i} className="relative text-sm">
          <span
            aria-hidden
            className={`absolute -left-[1.42rem] top-1.5 h-2.5 w-2.5 rounded-full ${
              t.kind === "comment" ? "bg-[var(--accent)]" : "bg-[var(--muted)]"
            }`}
          />
          <p className="text-xs text-[var(--muted)]">
            {when(t.at)} · {t.actor}
          </p>
          {t.kind === "event" ? (
            <p>
              {t.from ? (
                <>
                  <StatusBadge status={t.from} /> →{" "}
                </>
              ) : null}
              <StatusBadge status={t.to ?? ""} />
              {t.to === "uploaded" ? " Uploaded" : null}
              {t.to === "deleted" ? " Removed" : null}
            </p>
          ) : null}
          {t.text ? (
            <p
              className={`mt-1 rounded-md px-3 py-2 whitespace-pre-wrap ${
                t.internal
                  ? "border border-dashed border-[var(--warning)] bg-[var(--warning-bg)]"
                  : "bg-[var(--surface)]"
              }`}
            >
              {t.internal ? <strong className="mr-1 text-xs">Internal note:</strong> : null}
              {t.text}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Comment box. Staff may also write internal notes (hidden from the client). */
export function CommentForm({
  clientId,
  subject,
  subjectId,
  staff,
}: {
  clientId: string;
  subject: string;
  subjectId: string;
  staff: boolean;
}) {
  return (
    <ActionForm action={addCommentAction} submitLabel="Add comment" variant="secondary">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <TextArea label="Comment" name="body" rows={2} maxLength={2000} required />
      {staff ? (
        <Select
          label="Who can see it"
          name="visibility"
          options={[
            { value: "client", label: "The client and the firm" },
            { value: "internal", label: "Firm staff only (internal note)" },
          ]}
        />
      ) : null}
    </ActionForm>
  );
}

export function SummaryCounts({
  counts,
  order,
}: {
  counts: Record<string, number>;
  order: string[];
}) {
  const shown = order.filter((s) => (counts[s] ?? 0) > 0);
  if (shown.length === 0) return <span className="text-sm text-[var(--muted)]">None yet</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {shown.map((s) => (
        <Badge key={s} tone={STATUS_TONES[s] ?? "neutral"}>
          {STATUS_LABELS[s] ?? s}: {counts[s]}
        </Badge>
      ))}
    </span>
  );
}
