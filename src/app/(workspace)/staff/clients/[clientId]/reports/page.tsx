import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, BUTTON_VARIANTS, PageSkeleton, Section } from "@/components/ui/primitives";
import { renderStaffClientPage } from "@/features/ledger/staff-client-frame";
import { exportQuery, ReportFilters, ReportView } from "@/features/reports/report-view";
import { pathFor } from "@/lib/access/route-policy";
import { toPublicError } from "@/lib/errors/app-error";
import { todayManila } from "@/lib/dates";
import { buildReport, parseOptions, REPORTS, type ReportKey } from "@/server/reports/build";

export const metadata: Metadata = { title: "Reports" };

type Props = PageProps<"/staff/clients/[clientId]/reports">;

export default function ReportsPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Reports params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Reports({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderStaffClientPage("staff.reports", { clientId }, "Reports", async ({ client }) => {
    const options = parseOptions(sp, todayManila());
    let body: React.ReactNode;
    try {
      const report = await buildReport(client.id, options);
      const drill = (accountId: string) =>
        `${pathFor("staff.report_account", { clientId: client.id, itemId: accountId })}?${new URLSearchParams(
          {
            ...(report.drill.from ? { from: report.drill.from } : {}),
            to: report.drill.to,
            closing: report.drill.closing ? "1" : "0",
          },
        )}`;
      body = <ReportView report={report} options={options} drillHref={drill} />;
    } catch (error) {
      body = (
        <Alert tone="danger" title="This report could not be produced">
          {toPublicError(error, "").message}
        </Alert>
      );
    }
    return (
      <>
        <ReportFilters options={options} reports={Object.keys(REPORTS) as ReportKey[]} />
        <Section
          title={REPORTS[options.report]}
          actions={
            <a
              className={BUTTON_VARIANTS.secondary}
              href={`/api/reports/${client.id}?${exportQuery(options)}`}
            >
              Download CSV
            </a>
          }
        >
          {body}
        </Section>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Statement layout and classifications are PROPOSED and pending CPA review
          (docs/reports/ACCOUNTING-POLICIES.md). Click an account to see its entries and their
          source documents.
        </p>
      </>
    );
  });
}
