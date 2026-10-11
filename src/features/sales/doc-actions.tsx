import "server-only";

import { ActionForm, Field, TextArea } from "@/components/ui/action-form";
import { Alert, Badge } from "@/components/ui/primitives";
import { documentAction } from "@/features/sales/actions";
import type { Access } from "@/server/auth/access";
import { canApproveIntake } from "@/server/intake/access";

export const DOC_TONE = {
  draft: "neutral",
  submitted: "warning",
  posted: "success",
  cancelled: "danger",
} as const;
export function DocStatus({ status }: { status: string }) {
  return <Badge tone={DOC_TONE[status as keyof typeof DOC_TONE] ?? "neutral"}>{status}</Badge>;
}

/** Workflow controls for a sales document; the database enforces every rule again. */
export function DocActions({
  access,
  clientId,
  subject,
  id,
  status,
  preparedBy,
  label,
}: {
  access: Access;
  clientId: string;
  subject:
    | "sales_invoice"
    | "credit_note"
    | "sales_receipt"
    | "purchase_bill"
    | "supplier_payment"
    | "inventory_movement";
  id: string;
  status: string;
  preparedBy: string | null;
  label: string;
}) {
  const approver = canApproveIntake(access, clientId);
  const hidden = (op: string) => (
    <>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
    </>
  );
  if (status === "cancelled") return null;
  return (
    <div className="flex flex-col gap-3">
      {status === "draft" ? (
        <ActionForm action={documentAction} submitLabel="Submit for posting" variant="primary">
          {hidden("submit")}
        </ActionForm>
      ) : null}
      {status === "submitted" && approver && preparedBy !== access.user_id ? (
        <div className="flex flex-wrap gap-2">
          <ActionForm
            action={documentAction}
            submitLabel="Post to the books"
            variant="primary"
            confirmMessage={`Post this ${label}? It creates a journal entry.`}
          >
            {hidden("post")}
          </ActionForm>
        </div>
      ) : null}
      {status === "submitted" && approver && preparedBy === access.user_id ? (
        <Alert tone="info">
          You prepared this {label}, so another reviewer or manager must post it.
        </Alert>
      ) : null}
      {status === "submitted" && !approver ? (
        <Alert tone="info">Waiting for a reviewer or manager to post it.</Alert>
      ) : null}
      {status === "submitted" && approver ? (
        <details className="rounded-md border border-[var(--border)] p-3">
          <summary className="cursor-pointer text-sm">Return to the preparer</summary>
          <div className="mt-3">
            <ActionForm action={documentAction} submitLabel="Return">
              {hidden("return")}
              <TextArea label="What needs to change?" name="comment" rows={2} required />
            </ActionForm>
          </div>
        </details>
      ) : null}
      {status !== "posted" || approver ? (
        <details className="rounded-md border border-[var(--border)] p-3">
          <summary className="cursor-pointer text-sm text-[var(--danger)]">
            Cancel this {label}
          </summary>
          <div className="mt-3">
            <ActionForm
              action={documentAction}
              submitLabel={`Cancel ${label}`}
              variant="danger"
              confirmMessage={`Cancel this ${label}?`}
            >
              {hidden("cancel")}
              <TextArea label="Reason" name="comment" rows={2} required />
              {status === "posted" && subject !== "inventory_movement" ? (
                <Field
                  label="Cancellation date (optional)"
                  name="reversalDate"
                  type="date"
                  hint="A reversing journal entry is posted on this date (default: the earliest allowed date)."
                />
              ) : null}
            </ActionForm>
          </div>
        </details>
      ) : null}
    </div>
  );
}
