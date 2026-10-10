import type { Metadata } from "next";
import { Suspense } from "react";

import { DeniedState } from "@/components/ui/access-states";
import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Badge, MoreActions, PageHeader, PageSkeleton, Section } from "@/components/ui/primitives";
import {
  inviteStaffAction,
  resetUserMfaAction,
  setFirmRoleAction,
  setUserActiveAction,
} from "@/features/admin/actions";
import { roleLabel } from "@/lib/access/labels";
import { FIRM_ROLES } from "@/lib/access/route-policy";
import { guardRoute } from "@/server/auth/route-guard";
import { listUsersWithFirmRoles } from "@/server/data/workspace";

export const metadata: Metadata = { title: "Users" };

const FIRM_ROLE_OPTIONS = FIRM_ROLES.map((r) => ({ value: r, label: roleLabel(r) }));

export default function AdminUsersPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AdminUsers />
    </Suspense>
  );
}

async function AdminUsers() {
  const { access, decision } = await guardRoute("admin.users");
  if (!decision.allowed) return <DeniedState reason={decision.reason} />;
  const users = await listUsersWithFirmRoles();

  return (
    <div data-route="admin.users">
      <PageHeader
        title="Users"
        breadcrumbs={[{ href: "/admin", label: "Firm administration" }, { label: "Users" }]}
        description="Firm roles, account status and two-step verification. All changes are audited."
      />
      <Section title="Accounts">
        <DataTable
          caption="User accounts"
          rows={users}
          rowKey={(u) => u.id}
          columns={[
            {
              header: "User",
              cell: (u) => (
                <div>
                  <p>{u.full_name || u.email}</p>
                  <p className="text-xs break-all text-[var(--muted)]">{u.email}</p>
                </div>
              ),
            },
            {
              header: "Status",
              cell: (u) =>
                u.is_active ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="danger">Disabled</Badge>
                ),
            },
            { header: "Firm role", cell: (u) => roleLabel(u.firm_role) },
            {
              header: "Manage",
              srOnlyHeader: true,
              cell: (u) =>
                u.id === access.user_id ? (
                  <span className="text-xs text-[var(--muted)]">
                    You (another admin manages your account)
                  </span>
                ) : (
                  <div className="flex min-w-64 flex-col gap-2">
                    <ActionForm
                      action={setFirmRoleAction}
                      submitLabel="Set role"
                      variant="secondary"
                      className="flex items-end gap-2"
                    >
                      <input type="hidden" name="userId" value={u.id} />
                      <Select
                        label={`Firm role for ${u.email}`}
                        hideLabel
                        name="role"
                        defaultValue={u.firm_role ?? "none"}
                        options={[{ value: "none", label: "No firm role" }, ...FIRM_ROLE_OPTIONS]}
                      />
                    </ActionForm>
                    <MoreActions>
                      <ActionForm
                        action={setUserActiveAction}
                        submitLabel={u.is_active ? "Disable account" : "Enable account"}
                        variant={u.is_active ? "danger" : "secondary"}
                        className="flex items-end gap-2"
                        confirmMessage={
                          u.is_active
                            ? `Disable ${u.email}? They lose access immediately.`
                            : undefined
                        }
                      >
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="active" value={u.is_active ? "false" : "true"} />
                        {u.is_active ? <Field label="Reason" name="reason" required /> : null}
                      </ActionForm>
                      <ActionForm
                        action={resetUserMfaAction}
                        submitLabel="Reset two-step verification"
                        variant="secondary"
                        className="flex items-end gap-2"
                        confirmMessage={`Reset two-step verification for ${u.email}? Verify their identity first.`}
                      >
                        <input type="hidden" name="userId" value={u.id} />
                        <Field label="Reason" name="reason" required />
                      </ActionForm>
                    </MoreActions>
                  </div>
                ),
            },
          ]}
        />
      </Section>
      <Section title="Invite firm staff">
        <ActionForm action={inviteStaffAction} submitLabel="Send invitation">
          <Field label="Email" name="email" type="email" required autoComplete="off" />
          <Select
            label="Firm role"
            name="role"
            options={FIRM_ROLE_OPTIONS}
            defaultValue="accountant"
          />
        </ActionForm>
      </Section>
    </div>
  );
}
