import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState, PageSkeleton, Section } from "@/components/ui/primitives";
import { respondRequestAction } from "@/features/operations/actions";
import { OpsBadge, OverdueBadge } from "@/features/operations/labels";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { pathFor } from "@/lib/access/route-policy";
import { listDocuments } from "@/server/data/intake";
import { listDocumentRequests } from "@/server/data/operations";

export const metadata: Metadata = { title: "Requests" };

export default function RequestsPage({ params }: PageProps<"/portal/[clientId]/requests">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Requests params={params} />
    </Suspense>
  );
}

async function Requests({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderClientPortalPage(
    "portal.requests",
    clientId,
    "Requests from your accountant",
    async ({ access, client }) => {
      const c = client.id;
      const [requests, docs] = await Promise.all([listDocumentRequests(c), listDocuments(c)]);
      const role = access.client_memberships.find((m) => m.client_id === c)?.role;
      const canRespond = role === "client_owner" || role === "client_staff";
      const docName = new Map(docs.map((d) => [d.id, d.original_filename]));
      const waiting = requests.filter((r) => ["open", "returned"].includes(r.status));
      const others = requests.filter((r) => !["open", "returned"].includes(r.status));

      if (requests.length === 0) {
        return (
          <EmptyState title="No requests yet">
            When your accounting firm needs documents from you, the request appears here with its
            due date.
          </EmptyState>
        );
      }
      return (
        <>
          <Section title={`Waiting for you (${waiting.length})`}>
            {waiting.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Nothing is waiting for you.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {waiting.map((r) => (
                  <li key={r.id} className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.title}</span>
                      <OpsBadge status={r.status === "returned" ? "returned" : "open"} />
                      <span className="text-sm">Due {r.due_on}</span>
                      <OverdueBadge due={r.due_on} closed={false} />
                    </div>
                    {r.details ? (
                      <p className="mt-1 text-sm whitespace-pre-wrap">{r.details}</p>
                    ) : null}
                    {r.period_from ? (
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        Period {r.period_from} to {r.period_to ?? "…"}
                        {r.category ? ` · ${r.category.replace(/_/g, " ")}` : ""}
                      </p>
                    ) : null}
                    {r.status === "returned" && r.decision_note ? (
                      <p className="mt-1 text-sm text-[var(--warning)]">
                        Still needed: {r.decision_note}
                      </p>
                    ) : null}
                    {canRespond ? (
                      <div className="mt-3">
                        <ActionForm
                          action={respondRequestAction}
                          submitLabel="Send to my accountant"
                        >
                          <input type="hidden" name="clientId" value={c} />
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="version" value={r.version} />
                          {docs.length > 0 ? (
                            <fieldset className="flex flex-col gap-1 text-sm">
                              <legend className="mb-1">Attach uploaded documents</legend>
                              {docs.slice(0, 50).map((d) => (
                                <label key={d.id} className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    name={`doc_${d.id}`}
                                    defaultChecked={r.document_ids.includes(d.id)}
                                  />
                                  {d.original_filename}{" "}
                                  <span className="text-xs text-[var(--muted)]">
                                    {d.uploaded_at.slice(0, 10)}
                                  </span>
                                </label>
                              ))}
                            </fieldset>
                          ) : null}
                          <p className="text-xs text-[var(--muted)]">
                            Upload files first on the{" "}
                            <Link
                              className="underline"
                              href={pathFor("portal.documents", { clientId: c })}
                            >
                              Documents
                            </Link>{" "}
                            page, then attach them here.
                          </p>
                          <Field
                            label="Note (required if you have no document to send)"
                            name="note"
                            maxLength={1000}
                          />
                        </ActionForm>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        Viewers can see requests; the owner or staff respond.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Sent and closed">
            <DataTable
              caption="Other requests"
              rows={others}
              rowKey={(r) => r.id}
              empty="None."
              columns={[
                { header: "Request", cell: (r) => r.title },
                { header: "Due", kind: "nowrap", cell: (r) => r.due_on },
                { header: "Status", cell: (r) => <OpsBadge status={r.status} /> },
                {
                  header: "Sent",
                  cell: (r) =>
                    r.document_ids.map((id) => docName.get(id) ?? "document").join(", ") ||
                    r.response_note ||
                    "—",
                },
                {
                  header: "Accountant's note",
                  hideOnMobile: true,
                  cell: (r) => r.decision_note ?? "",
                },
              ]}
            />
          </Section>
        </>
      );
    },
  );
}
