import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Badge, PageSkeleton, Section } from "@/components/ui/primitives";
import { createFiscalYearAction, setPeriodStatusAction } from "@/features/ledger/actions";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { pathFor, REVIEW_ROLES } from "@/lib/access/route-policy";
import { hasFirmRole } from "@/server/auth/access";
import { listFiscalYears } from "@/server/data/ledger";

export const metadata: Metadata = { title: "Periods" };

const TONE = { open: "success", soft_closed: "warning", locked: "danger" } as const;

export default function PeriodsPage({ params }: PageProps<"/staff/clients/[clientId]/periods">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Periods params={params} />
    </Suspense>
  );
}

async function Periods({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return renderStaffClientPage(
    "staff.periods",
    { clientId },
    "Fiscal years and periods",
    async ({ access, client }) => {
      const years = await listFiscalYears(client.id);
      const canManage = hasFirmRole(access, REVIEW_ROLES);
      const isManager = hasFirmRole(access, ["firm_manager"]);
      const statusOptions = [
        { value: "open", label: "Open" },
        { value: "soft_closed", label: "Soft-closed (adjustments only)" },
        ...(isManager ? [{ value: "locked", label: "Locked (no postings)" }] : []),
      ];

      return (
        <>
          {years.map((y) => (
            <Section key={y.id} title={`Fiscal year ${y.start_date} to ${y.end_date}`}>
              <p className="mb-2 text-sm text-[var(--muted)]">
                Next entry number: {y.next_entry_no}
              </p>
              <DataTable
                caption={`Periods of fiscal year starting ${y.start_date}`}
                rows={y.periods}
                rowKey={(p) => p.id}
                columns={[
                  { header: "Period", cell: (p) => p.period_no },
                  {
                    header: "Dates",
                    kind: "nowrap",
                    cell: (p) => `${p.start_date} – ${p.end_date}`,
                  },
                  {
                    header: "Status",
                    cell: (p) => (
                      <>
                        <Badge tone={TONE[p.status]}>{p.status}</Badge>
                        {p.status_reason ? (
                          <span className="ml-2 text-xs">{p.status_reason}</span>
                        ) : null}
                      </>
                    ),
                  },
                  ...(canManage
                    ? [
                        {
                          header: "Change",
                          srOnlyHeader: true,
                          cell: (p: (typeof y.periods)[number]) =>
                            p.status === "locked" ? (
                              <span className="text-xs">
                                Locked. Reopening needs an approved{" "}
                                <Link
                                  className="underline"
                                  href={pathFor("staff.operations", { clientId: client.id })}
                                >
                                  exception request
                                </Link>
                                .
                              </span>
                            ) : (
                              <ActionForm
                                action={setPeriodStatusAction}
                                submitLabel="Apply"
                                variant="secondary"
                                className="flex flex-wrap items-end gap-2"
                              >
                                <input type="hidden" name="clientId" value={client.id} />
                                <input type="hidden" name="periodId" value={p.id} />
                                <Select
                                  label={`Status for period ${p.period_no}`}
                                  name="status"
                                  defaultValue={p.status}
                                  options={statusOptions}
                                />
                                <Field label="Reason" name="reason" />
                              </ActionForm>
                            ),
                        },
                      ]
                    : []),
                ]}
              />
            </Section>
          ))}
          {canManage ? (
            <Section title="Open a fiscal year">
              <ActionForm action={createFiscalYearAction} submitLabel="Open fiscal year">
                <input type="hidden" name="clientId" value={client.id} />
                <Field label="First month" name="startMonth" type="month" required />
                <Field
                  label="Number of monthly periods"
                  name="months"
                  type="number"
                  defaultValue="12"
                />
              </ActionForm>
            </Section>
          ) : years.length === 0 ? (
            <p className="text-sm">No fiscal year yet. A reviewer or manager must open one.</p>
          ) : null}
        </>
      );
    },
  );
}
