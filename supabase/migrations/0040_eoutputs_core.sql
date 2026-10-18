-- Phase 14 (DAT files, alphalists, e-invoicing compliance), part 1 of 2:
-- tables, RLS. Docs: docs/tax/ELECTRONIC-OUTPUTS.md; register: doc 09.
--
-- NO FILE LAYOUT IS BUILT IN. Each electronic output (QAP, alphalists, SAWT,
-- SLSP, schedules...) is a separate, versioned specification entered from the
-- OFFICIAL technical specification (e.g. the issuance's file-structure annex),
-- verified by a second reviewer, then enabled with a documented accountant /
-- compliance sign-off.
--
-- A generated file is NEVER "valid" because it was produced or because our
-- own pre-checks passed. It is valid only when the result of the applicable
-- OFFICIAL validation (the BIR module named in the spec) is recorded as passed
-- AND our validation and reconciliation passed.

create table public.output_specs (
  id                    uuid primary key default gen_random_uuid(),
  output_code           text not null check (output_code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  version               integer not null check (version >= 1),
  output_type           text not null check (output_type in ('dat', 'alphalist', 'slsp', 'qap', 'sawt', 'schedule', 'other')),
  title                 text not null check (char_length(title) between 3 and 200),
  -- The official technical specification: issuance, annex, spec version, dates.
  spec_source           jsonb not null check (jsonb_typeof(spec_source) = 'object'),
  -- The official validator the file must pass (e.g. a BIR validation module) and its version.
  official_tool         text check (char_length(official_tool) <= 200),
  official_tool_version text check (char_length(official_tool_version) <= 50),
  effective_from        date not null,
  effective_to          date,
  -- Platform dataset the rows come from (approved/posted transactions only).
  dataset               text not null check (dataset in ('withholding_by_bill_line', 'sales_by_invoice',
                          'purchases_by_bill_line', 'withheld_by_customer_receipt')),
  -- {format, delimiter, quote, encoding, line_end, final_newline, filename, filter, group_by, sums,
  --  order_by, unique_keys, records: [{record: header|detail|control, fields: [...]}], reconcile_to}
  layout                jsonb not null check (jsonb_typeof(layout) = 'object'),
  limitations           text not null check (char_length(limitations) between 5 and 4000),
  status                text not null default 'draft'
                          check (status in ('draft', 'pending_review', 'approved', 'enabled', 'rejected', 'retired')),
  review_note           text check (char_length(review_note) <= 2000),
  entered_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at            timestamptz not null default now(),
  approved_by           uuid references public.profiles (id) on delete set null,
  approved_at           timestamptz,
  signoff_by            uuid references public.profiles (id) on delete set null,
  signoff_at            timestamptz,
  signoff_statement     text check (char_length(signoff_statement) <= 4000),
  signoff_evidence      text check (char_length(signoff_evidence) <= 1000),
  unique (output_code, version),
  check (effective_to is null or effective_to >= effective_from),
  check (approved_by is null or entered_by is null or approved_by <> entered_by),
  check (signoff_by is null or entered_by is null or signoff_by <> entered_by),
  check ((status = 'enabled') <= (signoff_by is not null and signoff_statement is not null and signoff_evidence is not null)),
  check ((status in ('approved', 'enabled')) <= (approved_by is not null)),
  -- A file can only ever be "validated" against a named official tool.
  check ((status in ('approved', 'enabled')) <= (official_tool is not null and official_tool_version is not null))
);

-- Fixtures: rows in, the EXACT expected file (and filename, messages) out.
create table public.output_spec_fixtures (
  id                uuid primary key default gen_random_uuid(),
  spec_id           uuid not null references public.output_specs (id),
  name              text not null check (char_length(name) between 3 and 200),
  kind              text not null check (kind in ('normal', 'boundary')),
  as_of             date not null,
  period_from       date not null,
  period_to         date not null,
  facts             jsonb not null default '{}'::jsonb,
  rows              jsonb not null check (jsonb_typeof(rows) = 'array'),
  expected_content  text,
  expected_filename text,
  expected_messages jsonb not null default '[]'::jsonb,
  basis             text not null check (char_length(basis) between 5 and 1000),
  created_by        uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  reviewed_by       uuid references public.profiles (id) on delete set null,
  reviewed_at       timestamptz,
  unique (spec_id, name),
  check (reviewed_by is null or created_by is null or reviewed_by <> created_by)
);

create function private.output_spec_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_flow text[] := array['status', 'effective_to', 'approved_by', 'approved_at', 'review_note', 'signoff_by', 'signoff_at',
                         'signoff_statement', 'signoff_evidence'];
begin
  if tg_table_name = 'output_specs' then
    if tg_op = 'DELETE' then
      raise exception 'specifications cannot be deleted; reject or retire them' using errcode = '42501';
    end if;
    if old.status <> 'draft' and (to_jsonb(new) - v_flow) is distinct from (to_jsonb(old) - v_flow) then
      raise exception 'a submitted specification cannot be edited; add a new version' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'fixtures cannot be deleted' using errcode = '42501';
  end if;
  select status into v_status from public.output_specs where id = new.spec_id;
  if tg_op = 'INSERT' then
    if v_status is distinct from 'draft' then
      raise exception 'fixtures can only be added to a draft specification' using errcode = '42501';
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
create trigger output_specs_guard before update or delete on public.output_specs
  for each row execute function private.output_spec_guard();
create trigger output_spec_fixtures_guard before insert or update or delete on public.output_spec_fixtures
  for each row execute function private.output_spec_guard();

-- ---------------------------------------------------------------------------
-- Generation runs (per client and period)
-- ---------------------------------------------------------------------------
create table public.output_runs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  output_code     text not null,
  spec_id         uuid references public.output_specs (id),
  period_from     date not null,
  period_to       date not null,
  status          text not null check (status in ('generated', 'validated', 'validation_failed', 'signed_off', 'superseded',
                    'unsupported', 'not_applicable')),
  reason          text check (char_length(reason) <= 1000),
  -- Preserved source data (the exact rows used) and its fingerprint.
  snapshot        jsonb not null default '[]'::jsonb,
  snapshot_sha256 text,
  facts           jsonb not null default '{}'::jsonb,
  filename        text,
  content         text,
  content_sha256  text,
  -- [{code, severity, record, row, field, message}]
  messages        jsonb not null default '[]'::jsonb,
  -- [{check, expected, actual, passed}]
  reconciliation  jsonb not null default '[]'::jsonb,
  precheck_passed boolean not null default false,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  generated_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  generated_at    timestamptz not null default now(),
  signed_off_by   uuid references public.profiles (id) on delete set null,
  signed_off_at   timestamptz,
  signoff_statement text check (char_length(signoff_statement) <= 2000),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (period_to >= period_from),
  check ((status in ('generated', 'validated', 'validation_failed', 'signed_off', 'superseded')) = (spec_id is not null)),
  check (signed_off_by is null or generated_by is null or signed_off_by <> generated_by)
);
create index output_runs_client_idx on public.output_runs (client_id, output_code, period_from);

-- Results of the OFFICIAL validation (and eSubmission replies), with the log.
create table public.output_validations (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null,
  run_id       uuid not null,
  kind         text not null check (kind in ('official_tool', 'esubmission_reply')),
  tool         text not null check (char_length(tool) between 2 and 200),
  tool_version text check (char_length(tool_version) <= 50),
  result       text not null check (result in ('passed', 'failed', 'accepted', 'rejected')),
  file_sha256  text not null,
  log          text not null check (char_length(log) between 20 and 20000),
  reference    text check (char_length(reference) <= 200),
  recorded_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  recorded_at  timestamptz not null default now(),
  foreign key (client_id, run_id) references public.output_runs (client_id, id)
);

create function private.output_run_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'output runs cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'signed_off_by', 'signed_off_at', 'signoff_statement'])
     is distinct from (to_jsonb(old) - array['status', 'signed_off_by', 'signed_off_at', 'signoff_statement']) then
    raise exception 'a generated file and its snapshot cannot be changed; generate again' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger output_runs_guard before update or delete on public.output_runs
  for each row execute function private.output_run_guard();
create trigger output_validations_append_only before update or delete on public.output_validations
  for each row execute function private.intake_append_only();

-- ---------------------------------------------------------------------------
-- Electronic invoicing compliance register (evidence, not assumptions)
-- ---------------------------------------------------------------------------
-- Firm-wide research items: registrations, certifications, approvals,
-- technical requirements, transmission mechanisms. Verified by a second person.
create table public.einvoice_requirements (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  category    text not null check (category in ('registration', 'certification', 'approval', 'technical', 'transmission', 'other')),
  title       text not null check (char_length(title) between 3 and 200),
  description text not null check (char_length(description) between 5 and 4000),
  -- [{citation, issued_on, url, section}]
  sources     jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  status      text not null default 'unverified' check (status in ('unverified', 'verified', 'superseded')),
  entered_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at  timestamptz not null default now(),
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  check (verified_by is null or entered_by is null or verified_by <> entered_by),
  check ((status = 'verified') <= (verified_by is not null))
);

-- Per client: does the requirement apply, and what evidence shows it is met?
create table public.client_einvoice_assessments (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id) on delete cascade,
  requirement_id uuid not null references public.einvoice_requirements (id),
  status         text not null check (status in ('not_assessed', 'not_applicable', 'required_not_met', 'in_progress', 'met')),
  evidence       text check (char_length(evidence) <= 2000),
  note           text check (char_length(note) <= 2000),
  assessed_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  assessed_at    timestamptz not null default now(),
  reviewed_by    uuid references public.profiles (id) on delete set null,
  reviewed_at    timestamptz,
  check (reviewed_by is null or assessed_by is null or reviewed_by <> assessed_by),
  -- "met" needs evidence; "not applicable" needs the reason.
  check (status <> 'met' or char_length(coalesce(evidence, '')) >= 10),
  check (status <> 'not_applicable' or char_length(coalesce(note, '')) >= 10)
);
create index client_einvoice_assessments_idx on public.client_einvoice_assessments (client_id, requirement_id, assessed_at);
create trigger client_einvoice_assessments_append_only before update or delete on public.client_einvoice_assessments
  for each row execute function private.intake_append_only();

create trigger audit_output_specs after insert or update or delete on public.output_specs
  for each row execute function audit.log_change();
create trigger audit_output_spec_fixtures after insert or update or delete on public.output_spec_fixtures
  for each row execute function audit.log_change();
create trigger audit_output_runs after insert or update or delete on public.output_runs
  for each row execute function audit.log_change();
create trigger audit_output_validations after insert or update or delete on public.output_validations
  for each row execute function audit.log_change();
create trigger audit_einvoice_requirements after insert or update or delete on public.einvoice_requirements
  for each row execute function audit.log_change();

revoke all on table public.output_specs, public.output_spec_fixtures, public.output_runs, public.output_validations,
  public.einvoice_requirements, public.client_einvoice_assessments from public, anon, authenticated;
grant select on table public.output_specs, public.output_spec_fixtures, public.output_runs, public.output_validations,
  public.einvoice_requirements, public.client_einvoice_assessments to authenticated;

alter table public.output_specs enable row level security;
alter table public.output_specs force row level security;
alter table public.output_spec_fixtures enable row level security;
alter table public.output_spec_fixtures force row level security;
alter table public.output_runs enable row level security;
alter table public.output_runs force row level security;
alter table public.output_validations enable row level security;
alter table public.output_validations force row level security;
alter table public.einvoice_requirements enable row level security;
alter table public.einvoice_requirements force row level security;
alter table public.client_einvoice_assessments enable row level security;
alter table public.client_einvoice_assessments force row level security;

create policy output_specs_select on public.output_specs for select to authenticated using (private.firm_role() is not null);
create policy output_spec_fixtures_select on public.output_spec_fixtures for select to authenticated
  using (private.firm_role() is not null);
create policy output_runs_select on public.output_runs for select to authenticated using (private.is_assigned(client_id));
create policy output_validations_select on public.output_validations for select to authenticated
  using (private.is_assigned(client_id));
create policy einvoice_requirements_select on public.einvoice_requirements for select to authenticated
  using (private.firm_role() is not null);
create policy client_einvoice_assessments_select on public.client_einvoice_assessments for select to authenticated
  using (private.is_assigned(client_id));

insert into supabase_migrations.schema_migrations (version, name)
values ('0040', 'eoutputs_core') on conflict (version) do nothing;
