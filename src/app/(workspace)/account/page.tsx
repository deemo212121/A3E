import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field } from "@/components/ui/action-form";
import { Badge, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import { updateProfileAction } from "@/features/account/actions";
import { signOutAction } from "@/features/auth/actions";
import { roleLabel } from "@/lib/access/labels";
import { guardRoute } from "@/server/auth/route-guard";

export const metadata: Metadata = { title: "My account" };

export default function AccountPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Account />
    </Suspense>
  );
}

async function Account() {
  const { access, decision } = await guardRoute("account");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;

  return (
    <div data-route="account">
      <PageHeader title="My account" description={access.email} />
      <Section title="Profile">
        <ActionForm action={updateProfileAction} submitLabel="Save">
          <Field
            label="Full name"
            name="fullName"
            defaultValue={access.full_name}
            required
            autoComplete="name"
          />
        </ActionForm>
      </Section>
      <Section title="Access">
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            Firm role:{" "}
            {access.firm_role ? <Badge tone="info">{roleLabel(access.firm_role)}</Badge> : "none"}
          </li>
          <li>
            Two-step verification for this session:{" "}
            {access.aal === "aal2" ? (
              <Badge tone="success">verified</Badge>
            ) : (
              <Badge>not used</Badge>
            )}
          </li>
          <li>
            Client businesses:{" "}
            {access.client_memberships.length === 0
              ? "none"
              : access.client_memberships
                  .map((m) => `${m.display_name} (${roleLabel(m.role)})`)
                  .join(", ")}
          </li>
        </ul>
      </Section>
      <Section title="Session">
        <form action={signOutAction}>
          <button
            type="submit"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            Sign out
          </button>
        </form>
      </Section>
    </div>
  );
}
