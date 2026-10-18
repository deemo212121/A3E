-- Phase 3: authorization helpers and restrictive RLS policies.
--
-- Helpers are SECURITY DEFINER (they read membership tables without RLS
-- recursion), STABLE, with an empty search_path. They derive the caller ONLY
-- from auth.uid() / auth.jwt(); no helper accepts a user id from the caller.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.is_active
  );
$$;

-- True when the current session satisfies the staff MFA requirement.
create function private.staff_mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or coalesce((select (s.value)::text = 'false' from private.settings s
                   where s.key = 'require_staff_mfa'), false);
$$;

-- Effective firm role: null unless active AND (when required) on aal2.
create function private.firm_role() returns public.firm_role
language sql stable security definer set search_path = '' as $$
  select fm.role
  from public.firm_memberships fm
  join public.profiles p on p.id = fm.user_id
  where fm.user_id = auth.uid() and p.is_active and private.staff_mfa_ok();
$$;

create function private.is_firm_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.firm_role() = 'firm_admin', false);
$$;

create function private.is_firm_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.firm_role() = 'firm_manager', false);
$$;

-- Firm staff with operational access to a client's data.
-- Managers: all clients. Reviewer/accountant/bookkeeper: assigned clients only.
-- firm_admin: NO implicit access to client business data (SoD-5).
create function private.is_assigned(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.firm_role()
    when 'firm_manager' then true
    when 'reviewer' then exists (select 1 from public.client_assignments a
                                 where a.client_id = p_client_id and a.user_id = auth.uid())
    when 'accountant' then exists (select 1 from public.client_assignments a
                                   where a.client_id = p_client_id and a.user_id = auth.uid())
    when 'bookkeeper' then exists (select 1 from public.client_assignments a
                                   where a.client_id = p_client_id and a.user_id = auth.uid())
    else false
  end;
$$;

-- The caller's role in a client: only via an explicit, unexpired membership,
-- for an active user, on a non-archived client.
create function private.client_role(p_client_id uuid) returns public.client_role
language sql stable security definer set search_path = '' as $$
  select cm.role
  from public.client_memberships cm
  join public.profiles p on p.id = cm.user_id
  join public.clients c on c.id = cm.client_id
  where cm.client_id = p_client_id
    and cm.user_id = auth.uid()
    and p.is_active
    and c.status <> 'archived'
    and (cm.expires_at is null or cm.expires_at > now());
$$;

create function private.can_read_client(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client_id) or private.client_role(p_client_id) is not null;
$$;

-- Write access to client-owned business records (e.g. contacts).
create function private.can_write_client_records(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client_id)
      or coalesce(private.client_role(p_client_id) in ('client_owner', 'client_staff'), false);
$$;

-- Delete access to client-owned business records.
create function private.can_delete_client_records(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.is_assigned(p_client_id) and private.firm_role() in ('firm_manager', 'reviewer'))
      or coalesce(private.client_role(p_client_id) = 'client_owner', false);
$$;

-- Who may see a given profile: self, firm staff, or users sharing a readable client.
create function private.can_see_profile(p_profile_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_profile_id = auth.uid()
      or private.firm_role() is not null
      or exists (
        select 1 from public.client_memberships cm
        where cm.user_id = p_profile_id and private.can_read_client(cm.client_id)
      );
$$;

revoke execute on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function
  private.is_active_user(), private.staff_mfa_ok(), private.firm_role(),
  private.is_firm_admin(), private.is_firm_manager(), private.is_assigned(uuid),
  private.client_role(uuid), private.can_read_client(uuid),
  private.can_write_client_records(uuid), private.can_delete_client_records(uuid),
  private.can_see_profile(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges: start from nothing, grant the minimum.
-- (Supabase grants broad default privileges on new public tables.)
-- ---------------------------------------------------------------------------
revoke all on table
  public.profiles, public.firm_memberships, public.clients, public.client_memberships,
  public.client_assignments, public.client_contacts, public.invitations
from public, anon, authenticated;

grant select on table
  public.profiles, public.firm_memberships, public.clients, public.client_memberships,
  public.client_assignments, public.client_contacts, public.invitations
to authenticated;

grant update (full_name) on public.profiles to authenticated;
grant insert (client_id, full_name, position, email, phone) on public.client_contacts to authenticated;
grant update (full_name, position, email, phone) on public.client_contacts to authenticated;
grant delete on public.client_contacts to authenticated;
-- All other writes go through SECURITY DEFINER functions (next migration).

-- ---------------------------------------------------------------------------
-- RLS: enabled AND forced on every table; anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.firm_memberships enable row level security;
alter table public.firm_memberships force row level security;
alter table public.clients enable row level security;
alter table public.clients force row level security;
alter table public.client_memberships enable row level security;
alter table public.client_memberships force row level security;
alter table public.client_assignments enable row level security;
alter table public.client_assignments force row level security;
alter table public.client_contacts enable row level security;
alter table public.client_contacts force row level security;
alter table public.invitations enable row level security;
alter table public.invitations force row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (private.can_see_profile(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() and private.is_active_user())
  with check (id = auth.uid());

-- firm_memberships: visible to self and to active firm staff.
create policy firm_memberships_select on public.firm_memberships for select to authenticated
  using (user_id = auth.uid() or private.firm_role() is not null);

-- clients: firm_admin sees the roster (to administer it); others need access.
create policy clients_select on public.clients for select to authenticated
  using (private.is_firm_admin() or private.can_read_client(id));

-- client_memberships
create policy client_memberships_select on public.client_memberships for select to authenticated
  using (user_id = auth.uid() or private.is_firm_admin() or private.can_read_client(client_id));

-- client_assignments
create policy client_assignments_select on public.client_assignments for select to authenticated
  using (private.is_firm_admin() or private.can_read_client(client_id));

-- invitations: admin; manager (client invites); client owner (own client).
create policy invitations_select on public.invitations for select to authenticated
  using (
    private.is_firm_admin()
    or (kind = 'client' and (private.is_firm_manager()
        or coalesce(private.client_role(client_id) = 'client_owner', false)))
  );

-- client_contacts: full CRUD, strictly within the caller's clients.
create policy client_contacts_select on public.client_contacts for select to authenticated
  using (private.can_read_client(client_id));
create policy client_contacts_insert on public.client_contacts for insert to authenticated
  with check (private.can_write_client_records(client_id) and created_by = auth.uid());
create policy client_contacts_update on public.client_contacts for update to authenticated
  using (private.can_write_client_records(client_id))
  with check (private.can_write_client_records(client_id));
create policy client_contacts_delete on public.client_contacts for delete to authenticated
  using (private.can_delete_client_records(client_id));
