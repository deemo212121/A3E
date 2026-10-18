import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm } from "@/components/ui/action-form";
import { Alert, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { tourSandboxAction } from "@/features/tour/actions";
import { StartGuidedTourButton } from "@/features/tour/guided-tour";
import { TourGuide } from "@/features/tour/tour-guide";
import { buildGuidedTour } from "@/lib/tour/guided";
import { buildTour, ROLE_LABELS, tourRolesOf } from "@/lib/tour/steps";
import { guardRoute } from "@/server/auth/route-guard";
import { demoEnabled } from "@/server/demo/demo-data";
import { listVisibleClients } from "@/server/data/workspace";

export const metadata: Metadata = { title: "System tour" };

export default function TourPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Tour />
    </Suspense>
  );
}

async function Tour() {
  const { access, facts, decision } = await guardRoute("tour");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const steps = buildTour(facts);
  const roles = tourRolesOf(facts).map((r) => ROLE_LABELS[r]);
  const sandboxOn = demoEnabled();
  const firmUser = Boolean(access.firm_role_effective);
  // Sample clients this user can see (newest first; the code carries the time).
  const sandboxes = sandboxOn
    ? (await listVisibleClients())
        .filter((c) => c.code.startsWith("ZZTEST-TOUR-"))
        .sort((a, b) => b.code.localeCompare(a.code))
    : [];
  const sandbox = sandboxes[0];
  const guided = sandbox ? buildGuidedTour(facts, sandbox.id) : null;

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

      {sandboxOn ? (
        <Section title="Guided tour with sample data">
          <p className="mb-3 text-sm">
            The guided tour takes you through the real pages using a sample client,{" "}
            <strong>DEMO Tour Sample Co.</strong> Its data was created through the same workflows
            production uses, each step done by the right demo person: the owner submitted, the
            accountant prepared, the reviewer approved and posted, the manager approved. Some items
            are left half-way so you can do the next step yourself.
          </p>
          <Alert tone="warning" title="Sample data only">
            Everything in the sample client is synthetic. Its tax rule, form, file layout and
            deadline are marked <strong>TOUR ONLY</strong> and are not BIR rules, forms or layouts.
            Sample data can never be created in production.
          </Alert>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {guided ? (
              <StartGuidedTourButton steps={guided} />
            ) : (
              <p className="text-sm text-[var(--muted)]">
                {firmUser
                  ? "No sample data yet. Create it first (takes a few seconds)."
                  : "No sample data yet. A firm user (for example demo.manager@example.com) creates it; then the sample business appears here for the demo client owner."}
              </p>
            )}
            {firmUser ? (
              <ActionForm
                action={tourSandboxAction}
                submitLabel={guided ? "Create fresh sample data" : "Create sample data"}
                variant={guided ? "secondary" : "primary"}
                className="flex"
              >
                <input type="hidden" name="op" value="create" />
              </ActionForm>
            ) : null}
          </div>
          {firmUser && sandboxes.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium">Sample clients</p>
              <ul className="flex flex-col gap-2 text-sm">
                {sandboxes.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3">
                    <span>
                      {s.display_name} <code className="text-xs">{s.code}</code>
                    </span>
                    <ActionForm
                      action={tourSandboxAction}
                      submitLabel="Remove sample data"
                      variant="danger"
                      className="flex"
                      confirmMessage={`Remove ${s.code} and all its sample records?`}
                    >
                      <input type="hidden" name="op" value="remove" />
                      <input type="hidden" name="clientId" value={s.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-[var(--muted)]">
            Tip: take the tour once as each demo person (owner, accountant, reviewer, manager) to
            see the same records from every side, and to do each person&apos;s next step.
          </p>
        </Section>
      ) : null}

      <Section title="The process, step by step">
        <p className="mb-3 text-sm">
          Steps marked <strong>Your part</strong> involve your role. The buttons open the real pages
          you have access to.
        </p>
        <TourGuide steps={steps} roleLabels={ROLE_LABELS} />
      </Section>
    </div>
  );
}
