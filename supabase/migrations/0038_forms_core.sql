-- Phase 13 (BIR forms and supporting schedules), part 1 of 2: tables, RLS.
--
-- NO BIR FORM IS DEFINED. A form definition is entered from the official form
-- and its instructions, then:
--   APPROVED  only with cited sources (official form version and effective
--             date), regression fixtures (normal + boundary) reviewed by an
--             accountant other than their author and all passing, by a
--             reviewer/manager other than the author;
--   ENABLED   for production only with a DOCUMENTED accountant sign-off
--             (statement + evidence reference) by a firm manager other than
--             the author.
-- Workpapers are produced only from enabled forms, only for clients with the
-- form configured as an obligation. No filing integration exists.
-- Docs: docs/tax/FORMS.md.

create table public.tax_forms (
  id               uuid primary key default gen_random_uuid(),
  form_code        text not null check (form_code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  version          integer not null check (version >= 1),
  title            text not null check (char_length(title) between 3 and 200),
  -- The official form version as printed by the BIR (e.g. its revision date).
  official_version text not null check (char_length(official_version) between 2 and 100),
  frequency        text not null check (frequency in ('monthly', 'quarterly', 'annual', 'other')),
  effective_from   date not null,
  effective_to     date,
  eligibility      jsonb not null default '[]'::jsonb check (jsonb_typeof(eligibility) = 'array'),
  -- {lines: [...], schedules: [...], validations: [...]} (see 0039)
  definition       jsonb not null check (jsonb_typeof(definition) = 'object'),
  rounding         jsonb not null default '{"places": 2, "mode": "half_away_from_zero"}'::jsonb,
  sources          jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  export_format    text not null default 'csv' check (export_format in ('csv')),
  limitations      text not null check (char_length(limitations) between 5 and 4000),
  status           text not null default 'draft'
                     check (status in ('draft', 'pending_review', 'approved', 'enabled', 'rejected', 'retired')),
  review_note      text check (char_length(review_note) <= 2000),
  entered_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at       timestamptz not null default now(),
  approved_by      uuid references public.profiles (id) on delete set null,
  approved_at      timestamptz,
  -- Documented accountant sign-off for production use.
  signoff_by       uuid references public.profiles (id) on delete set null,
  signoff_at       timestamptz,
  signoff_statement text check (char_length(signoff_statement) <= 4000),
  signoff_evidence text check (char_length(signoff_evidence) <= 1000),
  unique (form_code, version),
  check (effective_to is null or effective_to >= effective_from),
  check (approved_by is null or entered_by is null or approved_by <> entered_by),
  check (signoff_by is null or entered_by is null or signoff_by <> entered_by),
  check ((status = 'enabled') <= (signoff_by is not null and signoff_statement is not null and signoff_evidence is not null)),
  check ((status in ('approved', 'enabled')) <= (approved_by is not null))
);

create table public.tax_form_fixtures (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references public.tax_forms (id),
  name        text not null check (char_length(name) between 3 and 200),
  kind        text not null check (kind in ('normal', 'boundary')),
  as_of       date not null,
  facts       jsonb not null default '{}'::jsonb,
  -- values for every non-formula line (rule outputs/inputs, manual lines, facts)
  given       jsonb not null check (jsonb_typeof(given) = 'object'),
  -- expected values of lines and validation codes: {"lines": {...}, "messages": [...]}
  expected    jsonb not null check (jsonb_typeof(expected) = 'object'),
  basis       text not null check (char_length(basis) between 5 and 1000),
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  unique (form_id, name),
  check (reviewed_by is null or created_by is null or reviewed_by <> created_by)
);

create function private.tax_form_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_flow text[] := array['status', 'effective_to', 'approved_by', 'approved_at', 'review_note', 'signoff_by', 'signoff_at',
                         'signoff_statement', 'signoff_evidence'];
begin
  if tg_table_name = 'tax_forms' then
    if tg_op = 'DELETE' then
      raise exception 'form definitions cannot be deleted; reject or retire them' using errcode = '42501';
    end if;
    if old.status <> 'draft' and (to_jsonb(new) - v_flow) is distinct from (to_jsonb(old) - v_flow) then
      raise exception 'a submitted form definition cannot be edited; add a new version' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'fixtures cannot be deleted' using errcode = '42501';
  end if;
  select status into v_status from public.tax_forms where id = new.form_id;
  if tg_op = 'INSERT' then
    if v_status is distinct from 'draft' then
      raise exception 'fixtures can only be added to a draft form' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.reviewed_by is not null or v_status not in ('draft', 'pending_review')
     or (to_jsonb(new) - array['reviewed_by', 'reviewed_at']) is distinct from (to_jsonb(old) - array['reviewed_by', 'reviewed_at']) then
    raise exception 'fixtures cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tax_forms_guard before update or delete on public.tax_forms
  for each row execute function private.tax_form_guard();
create trigger tax_form_fixtures_guard before insert or update or delete on public.tax_form_fixtures
  for each row execute function private.tax_form_guard();

-- ---------------------------------------------------------------------------
-- Workpapers (per client and period), overrides, history
-- ---------------------------------------------------------------------------
create table public.tax_workpapers (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  form_code       text not null,
  form_id         uuid references public.tax_forms (id),
  period_from     date not null,
  period_to       date not null,
  status          text not null check (status in ('prepared', 'signed_off', 'superseded', 'unsupported', 'not_applicable')),
  reason          text check (char_length(reason) <= 1000),
  facts           jsonb not null default '{}'::jsonb,
  -- {line_code: value-as-text}
  lines           jsonb not null default '{}'::jsonb,
  -- {line_code: {kind, computation_id?, rule_code?, depends_on?, override_id?}}
  line_sources    jsonb not null default '{}'::jsonb,
  -- [{code, severity: error|warning, message}]
  messages        jsonb not null default '[]'::jsonb,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  prepared_at     timestamptz not null default now(),
  signed_off_by   uuid references public.profiles (id) on delete set null,
  signed_off_at   timestamptz,
  signoff_statement text check (char_length(signoff_statement) <= 2000),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (period_to >= period_from),
  check ((status in ('prepared', 'signed_off', 'superseded')) = (form_id is not null)),
  check ((status = 'signed_off') <= (signed_off_by is not null and signoff_statement is not null)),
  check (signed_off_by is null or prepared_by is null or signed_off_by <> prepared_by)
);
create index tax_workpapers_client_idx on public.tax_workpapers (client_id, form_code, period_from);

-- Manual values and authorized overrides, each with its reason.
create table public.tax_workpaper_entries (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null,
  workpaper_id uuid not null,
  line_code    text not null,
  kind         text not null check (kind in ('manual', 'override')),
  value        numeric(18, 2) not null,
  computed     numeric(18, 2),
  reason       text not null check (char_length(reason) between 5 and 1000),
  reference    text check (char_length(reference) <= 200),
  created_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (client_id, workpaper_id) references public.tax_workpapers (client_id, id)
);

create table public.tax_workpaper_events (
  id           bigint generated always as identity primary key,
  client_id    uuid not null,
  workpaper_id uuid not null,
  event        text not null,
  detail       text check (char_length(detail) <= 2000),
  actor_id     uuid default auth.uid() references public.profiles (id) on delete set null,
  occurred_at  timestamptz not null default now(),
  foreign key (client_id, workpaper_id) references public.tax_workpapers (client_id, id)
);

create function private.tax_workpaper_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'workpapers cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'signed_off_by', 'signed_off_at', 'signoff_statement'])
     is distinct from (to_jsonb(old) - array['status', 'signed_off_by', 'signed_off_at', 'signoff_statement']) then
    raise exception 'a workpaper cannot be edited; prepare it again' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tax_workpapers_guard before update or delete on public.tax_workpapers
  for each row execute function private.tax_workpaper_guard();
create trigger tax_workpaper_entries_append_only before update or delete on public.tax_workpaper_entries
  for each row execute function private.intake_append_only();
create trigger tax_workpaper_events_append_only before update or delete on public.tax_workpaper_events
  for each row execute function private.intake_append_only();

create trigger audit_tax_forms after insert or update or delete on public.tax_forms
  for each row execute function audit.log_change();
create trigger audit_tax_form_fixtures after insert or update or delete on public.tax_form_fixtures
  for each row execute function audit.log_change();
create trigger audit_tax_workpapers after insert or update or delete on public.tax_workpapers
  for each row execute function audit.log_change();

revoke all on table public.tax_forms, public.tax_form_fixtures, public.tax_workpapers, public.tax_workpaper_entries,
  public.tax_workpaper_events from public, anon, authenticated;
grant select on table public.tax_forms, public.tax_form_fixtures, public.tax_workpapers, public.tax_workpaper_entries,
  public.tax_workpaper_events to authenticated;

alter table public.tax_forms enable row level security;
alter table public.tax_forms force row level security;
alter table public.tax_form_fixtures enable row level security;
alter table public.tax_form_fixtures force row level security;
alter table public.tax_workpapers enable row level security;
alter table public.tax_workpapers force row level security;
alter table public.tax_workpaper_entries enable row level security;
alter table public.tax_workpaper_entries force row level security;
alter table public.tax_workpaper_events enable row level security;
alter table public.tax_workpaper_events force row level security;

create policy tax_forms_select on public.tax_forms for select to authenticated using (private.firm_role() is not null);
create policy tax_form_fixtures_select on public.tax_form_fixtures for select to authenticated
  using (private.firm_role() is not null);
create policy tax_workpapers_select on public.tax_workpapers for select to authenticated using (private.is_assigned(client_id));
create policy tax_workpaper_entries_select on public.tax_workpaper_entries for select to authenticated
  using (private.is_assigned(client_id));
create policy tax_workpaper_events_select on public.tax_workpaper_events for select to authenticated
  using (private.is_assigned(client_id));

insert into supabase_migrations.schema_migrations (version, name)
values ('0038', 'forms_core') on conflict (version) do nothing;
