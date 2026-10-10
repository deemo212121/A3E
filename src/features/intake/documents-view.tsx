import "server-only";

import { ActionForm, Select, TextArea } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { MoreActions, Section } from "@/components/ui/primitives";
import { deleteDocumentAction, reviewDocumentAction } from "@/features/intake/document-actions";
import { DocumentUploader } from "@/features/intake/components/document-uploader";
import { StatusBadge } from "@/features/intake/components/intake-ui";
import { DOCUMENT_CATEGORIES, labelOf } from "@/lib/intake/rules";
import type { Access } from "@/server/auth/access";
import { listDocuments } from "@/server/data/intake";
import { canApproveIntake, canWriteIntake, isStaffOn } from "@/server/intake/access";

const kb = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Document vault: upload, list, download, review (staff), soft delete. */
export async function DocumentsView({
  access,
  clientId,
  reviewOnly = false,
}: {
  access: Access;
  clientId: string;
  /** Staff queue: only documents waiting for review. */
  reviewOnly?: boolean;
}) {
  const staff = isStaffOn(access, clientId);
  const writer = canWriteIntake(access, clientId);
  const approver = canApproveIntake(access, clientId);
  const all = await listDocuments(clientId, { includeImports: staff });
  const docs = reviewOnly
    ? all.filter((d) => d.review_status === "pending" && d.category !== "import_source")
    : all;

  return (
    <>
      {writer && !reviewOnly ? (
        <Section title="Upload documents">
          <DocumentUploader clientId={clientId} />
        </Section>
      ) : null}
      <Section title={reviewOnly ? "Documents waiting for review" : "Documents"}>
        <DataTable
          caption="Documents"
          rows={docs}
          rowKey={(d) => d.id}
          empty={reviewOnly ? "No documents are waiting for review." : "No documents uploaded yet."}
          columns={[
            {
              header: "File",
              cell: (d) => (
                <span className="flex flex-col">
                  <a
                    className="font-medium break-all text-[var(--accent)] hover:underline"
                    href={`/api/documents/${d.id}`}
                  >
                    {d.original_filename}
                  </a>
                  {d.description ? (
                    <span className="text-xs text-[var(--muted)]">{d.description}</span>
                  ) : null}
                </span>
              ),
            },
            { header: "Type", cell: (d) => labelOf(DOCUMENT_CATEGORIES, d.category) },
            {
              header: "Month",
              kind: "nowrap",
              hideOnMobile: true,
              cell: (d) => d.period_month?.slice(0, 7) ?? "",
            },
            { header: "Size", kind: "num", hideOnMobile: true, cell: (d) => kb(d.size_bytes) },
            {
              header: "Uploaded",
              kind: "nowrap",
              hideOnMobile: true,
              cell: (d) => d.uploaded_at.slice(0, 10),
            },
            {
              header: "Review",
              cell: (d) => (
                <span className="flex flex-col gap-1">
                  <StatusBadge status={d.review_status} />
                  {d.review_comment ? (
                    <span className="text-xs text-[var(--muted)]">{d.review_comment}</span>
                  ) : null}
                </span>
              ),
            },
            {
              header: "Actions",
              srOnlyHeader: true,
              cell: (d) => {
                const canDelete =
                  approver ||
                  (writer && d.uploaded_by === access.user_id && d.review_status === "pending");
                if (!staff && !canDelete) return null;
                return (
                  <MoreActions label={`Actions for ${d.original_filename}`}>
                    {staff ? (
                      <ActionForm
                        action={reviewDocumentAction}
                        submitLabel="Save review"
                        variant="secondary"
                      >
                        <input type="hidden" name="clientId" value={clientId} />
                        <input type="hidden" name="documentId" value={d.id} />
                        <Select
                          label="Review"
                          name="status"
                          defaultValue={
                            d.review_status === "pending" ? "accepted" : d.review_status
                          }
                          options={[
                            { value: "accepted", label: "Accepted" },
                            { value: "needs_correction", label: "Needs correction" },
                            { value: "rejected", label: "Rejected" },
                            { value: "pending", label: "Pending" },
                          ]}
                        />
                        <TextArea
                          label="Comment (required to ask for a correction)"
                          name="comment"
                          rows={2}
                          maxLength={1000}
                        />
                      </ActionForm>
                    ) : null}
                    {canDelete ? (
                      <ActionForm
                        action={deleteDocumentAction}
                        submitLabel="Remove document"
                        variant="danger"
                        confirmMessage="Remove this document? It stays in the audit trail."
                      >
                        <input type="hidden" name="clientId" value={clientId} />
                        <input type="hidden" name="documentId" value={d.id} />
                        <TextArea label="Reason" name="reason" rows={1} required maxLength={500} />
                      </ActionForm>
                    ) : null}
                  </MoreActions>
                );
              },
            },
          ]}
        />
      </Section>
    </>
  );
}
