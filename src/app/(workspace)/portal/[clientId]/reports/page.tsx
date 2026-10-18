import type { Metadata } from "next";
import { Suspense } from "react";

import {
  Alert,
  BUTTON_VARIANTS,
  EmptyState,
  PageSkeleton,
  Section,
} from "@/components/ui/primitives";
import { renderClientPortalPage } from "@/features/portal/client-page";
import { exportQuery, ReportFilters, ReportView } from "@/features/reports/report-view";
import { toPublicError } from "@/lib/errors/app-error";
import { buildReport, closedThrough, parseOptions, PORTAL_REPORTS } from "@/server/reports/build";

export const metadata: Metadata = { title: "Financial statements" };

type Props = PageProps<"/portal/[clientId]/reports">;

export default function PortalReportsPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PortalReports params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/**
 * Client view: statements only for periods the firm has CLOSED (enforced in
 * the database). No drill-down to journal entries.
 */
async function PortalReports({ params, searchParams }: Props) {
  const { clientId } = await params;
  const sp = await searchParams;
  return renderClientPortalPage(
    "portal.reports",
    clientId,
    "Financial statements",
    async ({ client }) => {
      const through = await closedThrough(client.id);
      if (!through) {
        return (
          <EmptyState title="No closed periods yet">
            Your accountant has not closed any accounting period yet. Statements appear here once a
            period is reviewed and closed.
          </EmptyState>
        );
      }
      const options = parseOptions(sp, through, PORTAL_REPORTS);
      if (options.to > through) options.to = through;
      if (options.from > options.to) options.from = `${options.to.slice(0, 4)}-01-01`;
      let body: React.ReactNode;
      try {
        body = (
          <ReportView
            report={await buildReport(client.id, options)}
            options={options}
            drillHref={null}
          />
        );
      } catch (error) {
        body = (
          <Alert tone="warning" title="This statement is not available">
            {toPublicError(error, "").message}
          </Alert>
        );
      }
      return (
        <>
          <p className="mb-3 text-sm">
            Available through <strong>{through}</strong> (the last period your accountant closed).
          </p>
          <ReportFilters options={options} reports={PORTAL_REPORTS} maxDate={through} />
          <Section
            title="Statement"
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
        </>
      );
    },
  );
}
