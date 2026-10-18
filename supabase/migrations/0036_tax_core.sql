-- Phase 12 (tax rules and computation framework), part 1 of 2: tables, RLS.
--
-- NO TAX RULES SHIP WITH THE PLATFORM. A rule computes only after it is
-- APPROVED, and approval requires (enforced in 0037): a cited source the
-- approver attests to have verified, expected-result fixtures (including
-- boundary cases) reviewed by an accountant other than their author, every
-- fixture passing, and an approver other than the rule's author.
-- Anything else is reported as unsupported or as needing professional review.
-- Docs: docs/tax/TAX-ENGINE.md.

-- ---------------------------------------------------------------------------
-- Rules registry (firm-wide, versioned)
-- ---------------------------------------------------------------------------
create table public.tax_rules (
  id             uuid primary key default gen_random_uuid(),
  code           text not null check (code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  version        integer not null check (version >= 1),
  name           text not null check (char_length(name) between 3 and 200),
  tax_type       text not null check (tax_type in ('vat', 'percentage', 'income', 'expanded_withholding',
                   'compensation_withholding', 'final_withholding', 'excise', 'documentary_stamp', 'other')),
  description    text check (char_length(description) <= 2000),
  effective_from date not null,
  effective_to   date,
  -- Who the rule applies to: all conditions must hold on the taxpayer's facts.
  eligibility    jsonb not null default '[]'::jsonb check (jsonb_typeof(eligibility) = 'array'),
  -- Declared inputs: [{name, label, source: 'ledger' | 'manual'}]
  inputs         jsonb not null check (jsonb_typeof(inputs) = 'array'),
  -- Named constants (rates, thresholds, graduated tables) taken from the source.
  params         jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  -- {steps: [{name, expr}], outputs: [step names]} in the safe expression language.
  formula        jsonb not null check (jsonb_typeof(formula) = 'object'),
  -- Rounding of every output: {places, mode: half_away_from_zero | down | up}
  rounding       jsonb not null default '{"places": 2, "mode": "half_away_from_zero"}'::jsonb,
  -- Authoritative sources: [{citation, title, url, issued_on, section}]
  sources        jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  status         text not null default 'draft'
                   check (status in ('draft', 'pending_review', 'approved', 'rejected', 'retired')),
  review_note    text check (char_length(review_note) <= 2000),
  entered_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  approved_by    uuid references public.profiles (id) on delete set null,
  approved_at    timestamptz,
  -- The approver attests that the sources were checked against the official issuance.
  sources_verified_by uuid references public.profiles (id) on delete set null,
  unique (code, version),
  check (effective_to is null or effective_to >= effective_from),
  check (approved_by is null or entered_by is null or approved_by <> entered_by),
  check ((status = 'approved') <= (approved_by is not null and sources_verified_by is not null))
);

-- Expected-result fixtures: worked examples an accountant reviews.
create table public.tax_rule_fixtures (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid not null references public.tax_rules (id),
  name        text not null check (char_length(name) between 3 and 200),
  kind        text not null check (kind in ('normal', 'boundary')),
  as_of       date not null,
  facts       jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  inputs      jsonb not null check (jsonb_typeof(inputs) = 'object'),
  expected    jsonb not null check (jsonb_typeof(expected) = 'object'),
  -- Where the expected result comes from (e.g. the issuance's own example, CPA working paper).
  basis       text not null check (char_length(basis) between 5 and 1000),
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 1000),
  unique (rule_id, name),
  check (reviewed_by is null or created_by is null or reviewed_by <> created_by)
);

create function private.tax_rule_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  if tg_table_name = 'tax_rules' then
    if tg_op = 'DELETE' then
      raise exception 'tax rules cannot be deleted; reject or retire them' using errcode = '42501';
    end if;
    if old.status <> 'draft'
       and (to_jsonb(new) - array['status', 'effective_to', 'submitted_at', 'approved_by', 'approved_at', 'review_note',
                                  'sources_verified_by'])
           is distinct from
           (to_jsonb(old) - array['status', 'effective_to', 'submitted_at', 'approved_by', 'approved_at', 'review_note',
                                  'sources_verified_by']) then
      raise exception 'a submitted or approved tax rule cannot be edited; add a new version' using errcode = '42501';
    end if;
    if old.status in ('approved', 'rejected', 'retired') and new.status not in ('approved', 'retired') then
      raise exception 'invalid status change for a % tax rule', old.status using errcode = '42501';
    end if;
    return new;
  end if;
  -- fixtures: frozen once reviewed or once the rule leaves draft
  if tg_op = 'DELETE' then
    raise exception 'fixtures cannot be deleted' using errcode = '42501';
  end if;
  select status into v_status from public.tax_rules where id = new.rule_id;
  if tg_op = 'INSERT' then
    if v_status is distinct from 'draft' then
      raise exception 'fixtures can only be added to a draft rule' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Only the one-time review stamp may be added (also after submission).
  if old.reviewed_by is not null or v_status not in ('draft', 'pending_review') then
    raise exception 'a reviewed fixture cannot be changed' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['reviewed_by', 'reviewed_at', 'review_note'])
     is distinct from (to_jsonb(old) - array['reviewed_by', 'reviewed_at', 'review_note']) then
    raise exception 'fixtures cannot be edited; add a new one' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tax_rules_guard before update or delete on public.tax_rules
  for each row execute function private.tax_rule_guard();
create trigger tax_rule_fixtures_guard before insert or update or delete on public.tax_rule_fixtures
  for each row execute function private.tax_rule_guard();

-- ---------------------------------------------------------------------------
-- Per-client: profile facts, obligations, input mappings
-- ---------------------------------------------------------------------------
-- Extra taxpayer facts used by rule eligibility (the approved business profile
-- supplies business_type, vat_status and fiscal_year_end_month). A reviewer
-- other than the proposer confirms them.
create table public.tax_profiles (
  client_id    uuid primary key references public.clients (id) on delete cascade,
  attributes   jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  status       text not null default 'proposed' check (status in ('proposed', 'confirmed')),
  proposed_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  proposed_at  timestamptz not null default now(),
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz,
  check (confirmed_by is null or proposed_by is null or confirmed_by <> proposed_by),
  check ((status = 'confirmed') = (confirmed_by is not null))
);

-- Which rule codes apply to the client, and from when (configurable, not assumed).
create table public.tax_obligations (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  rule_code  text not null check (rule_code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  starts_on  date not null,
  ends_on    date,
  notes      text check (char_length(notes) <= 500),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
create index tax_obligations_client_idx on public.tax_obligations (client_id, rule_code);

-- Which ledger accounts feed a rule's ledger input for this client.
create table public.tax_input_mappings (
  client_id   uuid not null references public.clients (id) on delete cascade,
  rule_code   text not null,
  input_name  text not null check (input_name ~ '^[a-z][a-z0-9_]{0,39}$'),
  account_ids uuid[] not null check (cardinality(account_ids) between 1 and 50),
  sign        text not null check (sign in ('credit_minus_debit', 'debit_minus_credit')),
  updated_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (client_id, rule_code, input_name)
);

-- ---------------------------------------------------------------------------
-- Computations, adjustments (kept apart from accounting), lineage
-- ---------------------------------------------------------------------------
create table public.tax_computations (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  rule_code       text not null,
  rule_id         uuid references public.tax_rules (id),
  period_from     date not null,
  period_to       date not null,
  status          text not null check (status in ('computed', 'reviewed', 'superseded', 'unsupported',
                    'not_applicable', 'manual_review')),
  reason          text check (char_length(reason) <= 1000),
  facts           jsonb not null default '{}'::jsonb,
  ledger_inputs   jsonb not null default '{}'::jsonb,
  adjustments     jsonb not null default '{}'::jsonb,
  inputs          jsonb not null default '{}'::jsonb,
  outputs         jsonb,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  prepared_at     timestamptz not null default now(),
  reviewed_by     uuid references public.profiles (id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text check (char_length(review_note) <= 1000),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (period_to >= period_from),
  check ((status in ('computed', 'reviewed', 'superseded')) = (rule_id is not null and outputs is not null)),
  check (reviewed_by is null or prepared_by is null or reviewed_by <> prepared_by)
);
create index tax_computations_client_idx on public.tax_computations (client_id, rule_code, period_from);

-- Tax adjustments: entered on the computation only. They never change the books.
create table public.tax_adjustments (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  computation_id uuid not null,
  input_name     text not null,
  amount         numeric(18, 2) not null check (amount <> 0),
  reason         text not null check (char_length(reason) between 5 and 1000),
  reference      text check (char_length(reference) <= 200),
  created_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (client_id, computation_id) references public.tax_computations (client_id, id)
);

-- Lineage: every posted journal line behind a ledger input, with its source.
create table public.tax_lineage (
  id              bigint generated always as identity primary key,
  client_id       uuid not null,
  computation_id  uuid not null,
  input_name      text not null,
  journal_line_id uuid not null,
  entry_id        uuid not null,
  entry_no        integer,
  entry_date      date not null,
  source_type     text,
  source_ref      text,
  amount          numeric(18, 2) not null,
  foreign key (client_id, computation_id) references public.tax_computations (client_id, id)
);
create index tax_lineage_computation_idx on public.tax_lineage (computation_id, input_name);

create function private.tax_computation_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'tax computations cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'review_note'])
     is distinct from (to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'review_note']) then
    raise exception 'a tax computation cannot be edited; compute again' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tax_computations_guard before update or delete on public.tax_computations
  for each row execute function private.tax_computation_guard();
create trigger tax_adjustments_append_only before update or delete on public.tax_adjustments
  for each row execute function private.intake_append_only();
create trigger tax_lineage_append_only before update or delete on public.tax_lineage
  for each row execute function private.intake_append_only();

create trigger audit_tax_rules after insert or update or delete on public.tax_rules
  for each row execute function audit.log_change();
create trigger audit_tax_rule_fixtures after insert or update or delete on public.tax_rule_fixtures
  for each row execute function audit.log_change();
create trigger audit_tax_profiles after insert or update or delete on public.tax_profiles
  for each row execute function audit.log_change();
create trigger audit_tax_obligations after insert or update or delete on public.tax_obligations
  for each row execute function audit.log_change();
create trigger audit_tax_input_mappings after insert or update or delete on public.tax_input_mappings
  for each row execute function audit.log_change();
create trigger audit_tax_computations after insert or update or delete on public.tax_computations
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- RLS: SELECT only. Rules: firm staff. Client tax data: assigned staff only
-- (clients do not see unreviewed tax figures).
-- ---------------------------------------------------------------------------
revoke all on table public.tax_rules, public.tax_rule_fixtures, public.tax_profiles, public.tax_obligations,
  public.tax_input_mappings, public.tax_computations, public.tax_adjustments, public.tax_lineage
from public, anon, authenticated;
grant select on table public.tax_rules, public.tax_rule_fixtures, public.tax_profiles, public.tax_obligations,
  public.tax_input_mappings, public.tax_computations, public.tax_adjustments, public.tax_lineage
to authenticated;

alter table public.tax_rules enable row level security;
alter table public.tax_rules force row level security;
alter table public.tax_rule_fixtures enable row level security;
alter table public.tax_rule_fixtures force row level security;
alter table public.tax_profiles enable row level security;
alter table public.tax_profiles force row level security;
alter table public.tax_obligations enable row level security;
alter table public.tax_obligations force row level security;
alter table public.tax_input_mappings enable row level security;
alter table public.tax_input_mappings force row level security;
alter table public.tax_computations enable row level security;
alter table public.tax_computations force row level security;
alter table public.tax_adjustments enable row level security;
alter table public.tax_adjustments force row level security;
alter table public.tax_lineage enable row level security;
alter table public.tax_lineage force row level security;

create policy tax_rules_select on public.tax_rules for select to authenticated using (private.firm_role() is not null);
create policy tax_rule_fixtures_select on public.tax_rule_fixtures for select to authenticated
  using (private.firm_role() is not null);
create policy tax_profiles_select on public.tax_profiles for select to authenticated using (private.is_assigned(client_id));
create policy tax_obligations_select on public.tax_obligations for select to authenticated using (private.is_assigned(client_id));
create policy tax_input_mappings_select on public.tax_input_mappings for select to authenticated
  using (private.is_assigned(client_id));
create policy tax_computations_select on public.tax_computations for select to authenticated
  using (private.is_assigned(client_id));
create policy tax_adjustments_select on public.tax_adjustments for select to authenticated using (private.is_assigned(client_id));
create policy tax_lineage_select on public.tax_lineage for select to authenticated using (private.is_assigned(client_id));

insert into supabase_migrations.schema_migrations (version, name)
values ('0036', 'tax_core') on conflict (version) do nothing;
