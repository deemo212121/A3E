import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { Alert, PageHeader, PageSkeleton } from "@/components/ui/primitives";
import { TourGuide } from "@/features/tour/tour-guide";
import { buildTour, ROLE_LABELS, tourRolesOf } from "@/lib/tour/steps";
import { guardRoute } from "@/server/auth/route-guard";

export const metadata: Metadata = { title: "System tour" };

export default function TourPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Tour />
    </Suspense>
  );
}

async function Tour() {
  const { facts, decision } = await guardRoute("tour");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const steps = buildTour(facts);
  const roles = tourRolesOf(facts).map((r) => ROLE_LABELS[r]);

  return (
    <div data-route="tour">
      <PageHeader
        title="System tour"
        description={
          roles.length
            ? `How the whole process works, from a client's records to a filed return. Your role: ${roles.join(", ")}.`
            : "How the whole process works, from a client's records to a filed return."
        }
      />
      <Alert tone="info">
        Steps marked <strong>Your part</strong> involve your role. The buttons open the real pages
        you have access to; nothing in the tour changes any data.
      </Alert>
      <div className="mt-4">
        <TourGuide steps={steps} roleLabels={ROLE_LABELS} />
      </div>
    </div>
  );
}
