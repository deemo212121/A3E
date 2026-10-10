-- Phase 3: identity, firm/client tenancy and audit (core objects).
-- Authorization helpers and RLS policies: 20261010120100_*.sql
-- Membership/invitation functions:           20261010120200_*.sql

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
create schema if not exists private; -- helpers; NOT exposed through the Data API
create schema if not exists audit;   -- append-only audit trail; NOT exposed

revoke all on schema private from public;
revoke all on schema audit from public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.firm_role as enum ('firm_admin', 'firm_manager', 'reviewer', 'accountant', 'bookkeeper');
create type public.client_role as enum ('client_owner', 'client_staff', 'client_viewer');
create type public.client_status as enum ('onboarding', 'active', 'archived');
create type public.assignment_role as enum ('preparer', 'reviewer');
create type public.invitation_kind as enum ('firm', 'client');

-- ---------------------------------------------------------------------------
-- Settings (private)
-- ---------------------------------------------------------------------------
create table private.settings (
  key   text primary key,
  value jsonb not null
);
-- Staff (firm roles) must use MFA (aal2) to exercise firm permissions (doc 07 §3).
insert into private.settings (key, value) values ('require_staff_mfa', 'true'::jsonb);

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null,
  full_name       text not null default '' check (char_length(full_name) <= 200),
  is_active       boolean not null default true,
  disabled_at     timestamptz,
  disabled_by     uuid references public.profiles (id) on delete set null,
  disabled_reason text check (char_length(disabled_reason) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint profiles_disabled_consistency check (
    (is_active and disabled_at is null) or (not is_active and disabled_at is not null)
  )
);
create unique index profiles_email_lower_key on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- Firm membership (exactly one firm; a user has at most one firm role)
-- ---------------------------------------------------------------------------
create table public.firm_memberships (
  user_id               uuid primary key references public.profiles (id) on delete cascade,
  role                  public.firm_role not null,
  is_tax_rule_signatory boolean not null default false,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.profiles (id) on delete set null,
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Client businesses (the tenant / data-ownership boundary)
-- ---------------------------------------------------------------------------
create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,29}$'),
  display_name text not null check (char_length(display_name) between 1 and 200),
  status       public.client_status not null default 'onboarding',
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now()
);

-- A user belongs to a client ONLY through an explicit membership row.
create table public.client_memberships (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       public.client_role not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (client_id, user_id)
);
create index client_memberships_user_idx on public.client_memberships (user_id);

-- Firm staff are scoped to clients through explicit assignments.
create table public.client_assignments (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  assignment_role public.assignment_role not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id) on delete set null,
  unique (client_id, user_id, assignment_role)
);
create index client_assignments_user_idx on public.client_assignments (user_id);

-- Tenant-owned business record (contact persons of a client business).
-- Not accounting data; used to prove CRUD isolation between tenants.
create table public.client_contacts (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  full_name  text not null check (char_length(full_name) between 1 and 200),
  position   text check (char_length(position) <= 100),
  email      text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone      text check (char_length(phone) <= 40),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index client_contacts_client_idx on public.client_contacts (client_id);

-- Invitations are bound to an email address. They are accepted only by the
-- signed-in user whose CONFIRMED email matches (no bearer tokens).
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  kind        public.invitation_kind not null,
  firm_role   public.firm_role,
  client_id   uuid references public.clients (id) on delete cascade,
  client_role public.client_role,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  constraint invitations_target_shape check (
    (kind = 'firm' and firm_role is not null and client_id is null and client_role is null)
    or (kind = 'client' and firm_role is null and client_id is not null and client_role is not null)
  ),
  constraint invitations_single_outcome check (accepted_at is null or revoked_at is null)
);
create unique index invitations_one_pending_per_target
  on public.invitations (lower(email), kind, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where accepted_at is null and revoked_at is null;
create index invitations_client_idx on public.invitations (client_id);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger firm_memberships_touch before update on public.firm_memberships
  for each row execute function private.touch_updated_at();
create trigger clients_touch before update on public.clients
  for each row execute function private.touch_updated_at();
create trigger client_memberships_touch before update on public.client_memberships
  for each row execute function private.touch_updated_at();
create trigger client_contacts_touch before update on public.client_contacts
  for each row execute function private.touch_updated_at();

-- client_id of a tenant row can never be changed (no moving data across tenants).
create function private.forbid_client_id_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.client_id is distinct from old.client_id then
    raise exception 'client_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger client_memberships_client_immutable before update on public.client_memberships
  for each row execute function private.forbid_client_id_change();
create trigger client_assignments_client_immutable before update on public.client_assignments
  for each row execute function private.forbid_client_id_change();
create trigger client_contacts_client_immutable before update on public.client_contacts
  for each row execute function private.forbid_client_id_change();
create trigger invitations_client_immutable before update on public.invitations
  for each row execute function private.forbid_client_id_change();

-- Assignments are for firm staff only (not admins-only, not client users).
create function private.check_assignment_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.firm_role;
begin
  select role into v_role from public.firm_memberships where user_id = new.user_id;
  if v_role is null or v_role = 'firm_admin' then
    raise exception 'only firm staff can be assigned to clients' using errcode = '22023';
  end if;
  if new.assignment_role = 'reviewer' and v_role not in ('reviewer', 'firm_manager') then
    raise exception 'reviewer assignments require the reviewer or firm_manager role' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger client_assignments_check_user before insert or update on public.client_assignments
  for each row execute function private.check_assignment_user();

-- ---------------------------------------------------------------------------
-- Profile provisioning from Supabase Auth
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200)
  );
  return new;
end;
$$;

create function private.handle_auth_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(coalesce(new.email, '')) where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_auth_user();
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function private.handle_auth_user_email_change();

-- ---------------------------------------------------------------------------
-- Audit trail (append-only)
-- ---------------------------------------------------------------------------
create table audit.events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,          -- auth.uid(); null for system/service actions
  client_id   uuid,
  action      text not null, -- e.g. 'insert:client_memberships', 'invitation.accepted'
  table_name  text,
  row_id      text,
  old_data    jsonb,
  new_data    jsonb,
  details     jsonb
);
create index audit_events_client_idx on audit.events (client_id, occurred_at desc);
create index audit_events_actor_idx on audit.events (actor_id, occurred_at desc);

create function audit.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit.events is append-only' using errcode = '42501';
end;
$$;

create trigger audit_events_no_update before update or delete on audit.events
  for each row execute function audit.forbid_mutation();
create trigger audit_events_no_truncate before truncate on audit.events
  for each statement execute function audit.forbid_mutation();

create function audit.log_event(
  p_action text, p_client_id uuid default null, p_details jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into audit.events (actor_id, client_id, action, details)
  values (auth.uid(), p_client_id, p_action, p_details);
end;
$$;

create function audit.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_client uuid;
begin
  v_client := case
    when tg_table_name = 'clients' then (v_row ->> 'id')::uuid
    else (v_row ->> 'client_id')::uuid
  end;
  insert into audit.events (actor_id, client_id, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(), v_client, lower(tg_op) || ':' || tg_table_name, tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id'), v_old, v_new
  );
  return null;
end;
$$;

create trigger audit_profiles after insert or update or delete on public.profiles
  for each row execute function audit.log_change();
create trigger audit_firm_memberships after insert or update or delete on public.firm_memberships
  for each row execute function audit.log_change();
create trigger audit_clients after insert or update or delete on public.clients
  for each row execute function audit.log_change();
create trigger audit_client_memberships after insert or update or delete on public.client_memberships
  for each row execute function audit.log_change();
create trigger audit_client_assignments after insert or update or delete on public.client_assignments
  for each row execute function audit.log_change();
create trigger audit_client_contacts after insert or update or delete on public.client_contacts
  for each row execute function audit.log_change();
create trigger audit_invitations after insert or update or delete on public.invitations
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- Privileges on objects in private/audit: nothing for API roles.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all tables in schema audit from public, anon, authenticated;
revoke all on all functions in schema audit from public, anon, authenticated;
revoke execute on function private.touch_updated_at() from public, anon, authenticated;
revoke execute on function private.forbid_client_id_change() from public, anon, authenticated;
revoke execute on function private.check_assignment_user() from public, anon, authenticated;
revoke execute on function private.handle_new_auth_user() from public, anon, authenticated;
revoke execute on function private.handle_auth_user_email_change() from public, anon, authenticated;
