-- Phase 10 (payroll and statutory contributions), part 2 of 3: tables, RLS.
--
-- PRIVACY: payroll data (employees, rates, runs, payslips, payments) is
-- readable ONLY by users with an explicit payroll grant for the client.
-- Being assigned to the client, or being a client user, is NOT enough.
-- The general ledger receives aggregate amounts only (no employee names).
--
-- STATUTORY RULES: SSS, PhilHealth, Pag-IBIG and withholding tables ship
-- EMPTY. Each version is entered with its legal basis and effective dates
-- and signed off by a different reviewer/manager; signed-off versions never
-- change. Rules: docs/payroll/PAYROLL-RULES.md (PENDING VERIFICATION).

-- ---------------------------------------------------------------------------
-- Access grants
-- ---------------------------------------------------------------------------
create table public.payroll_access (
  client_id    uuid not null references public.clients (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  access_level public.payroll_access_level not null,
  granted_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  granted_at   timestamptz not null default now(),
  primary key (client_id, user_id)
);

-- The caller's payroll level for a client: the grant AND current access to
-- the client; prepare/approve also need the matching firm role.
create function private.payroll_level(p_client_id uuid) returns public.payroll_access_level
language sql stable security definer set search_path = '' as $$
  select a.access_level from public.payroll_access a
   where a.client_id = p_client_id and a.user_id = auth.uid() and private.can_read_client(p_client_id);
$$;
create function private.can_view_payroll(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.payroll_level(p_client_id) is not null;
$$;
create function private.can_prepare_payroll(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.payroll_level(p_client_id) in ('prepare', 'approve'), false)
     and private.can_prepare_entries(p_client_id);
$$;
create function private.can_approve_payroll(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.payroll_level(p_client_id) = 'approve', false) and private.can_approve_entries(p_client_id);
$$;

-- ---------------------------------------------------------------------------
-- Statutory rule tables (firm-wide, versioned, signed off)
-- ---------------------------------------------------------------------------
create table public.payroll_rule_sets (
  id                     uuid primary key default gen_random_uuid(),
  kind                   public.payroll_rule_kind not null,
  version                integer not null check (version >= 1),
  method                 public.payroll_rule_method not null,
  description            text not null check (char_length(description) between 3 and 300),
  legal_basis            text not null check (char_length(legal_basis) between 5 and 500),
  effective_from         date not null,
  effective_to           date,
  -- rate_table: the base is clamped to [floor, ceiling] (when compensation > 0)
  base_floor             numeric(18, 2) check (base_floor >= 0),
  base_ceiling           numeric(18, 2) check (base_ceiling > 0),
  -- graduated (withholding): the pay frequency the table is for, and whether
  -- employee contributions are deducted before applying it.
  frequency              public.payroll_frequency,
  deduct_employee_contributions boolean,
  status                 text not null default 'pending_signoff' check (status in ('pending_signoff', 'signed_off', 'retired')),
  entered_by             uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at             timestamptz not null default now(),
  signed_off_by          uuid references public.profiles (id) on delete set null,
  signed_off_at          timestamptz,
  unique (kind, version),
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'signed_off') <= (signed_off_by is not null)),
  check (signed_off_by is null or entered_by is null or signed_off_by <> entered_by),
  check ((kind = 'withholding') = (method = 'graduated')),
  check ((method = 'graduated') = (frequency is not null and deduct_employee_contributions is not null)),
  check (base_floor is null or base_ceiling is null or base_floor <= base_ceiling)
);

create table public.payroll_rule_brackets (
  rule_set_id  uuid not null references public.payroll_rule_sets (id) on delete cascade,
  seq          smallint not null check (seq between 1 and 200),
  lower_bound  numeric(18, 2) not null check (lower_bound >= 0),
  upper_bound  numeric(18, 2),
  ee_amount    numeric(18, 2) check (ee_amount >= 0),
  er_amount    numeric(18, 2) check (er_amount >= 0),
  ec_amount    numeric(18, 2) check (ec_amount >= 0),
  ee_rate      numeric(9, 6) check (ee_rate >= 0 and ee_rate < 1),
  er_rate      numeric(9, 6) check (er_rate >= 0 and er_rate < 1),
  fixed_tax    numeric(18, 2) check (fixed_tax >= 0),
  excess_rate  numeric(9, 6) check (excess_rate >= 0 and excess_rate < 1),
  primary key (rule_set_id, seq),
  check (upper_bound is null or upper_bound >= lower_bound)
);

create function private.payroll_rule_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  if tg_table_name = 'payroll_rule_sets' then
    if tg_op = 'DELETE' then
      raise exception 'payroll rules cannot be deleted; retire them' using errcode = '42501';
    end if;
    if old.status <> 'pending_signoff'
       and (to_jsonb(new) - array['status', 'effective_to']) is distinct from (to_jsonb(old) - array['status', 'effective_to']) then
      raise exception 'a signed-off payroll rule cannot be changed; add a new version' using errcode = '42501';
    end if;
    return new;
  end if;
  select status into v_status from public.payroll_rule_sets
   where id = (case when tg_op = 'DELETE' then old.rule_set_id else new.rule_set_id end);
  if v_status is distinct from 'pending_signoff' then
    raise exception 'brackets of a signed-off payroll rule cannot be changed' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger payroll_rule_sets_guard before update or delete on public.payroll_rule_sets
  for each row execute function private.payroll_rule_guard();
create trigger payroll_rule_brackets_guard before insert or update or delete on public.payroll_rule_brackets
  for each row execute function private.payroll_rule_guard();

-- ---------------------------------------------------------------------------
-- Per-client settings and pay items
-- ---------------------------------------------------------------------------
insert into public.coa_template_accounts
  (template_code, code, name, account_type, normal_balance, parent_code, is_postable, sort_order)
values ('PH-SME-V0', '2115', 'Withholding Tax on Compensation Payable', 'liability', 'credit', '2000', true, 215)
on conflict do nothing;

create table public.payroll_settings (
  client_id                 uuid primary key references public.clients (id) on delete cascade,
  net_pay_account_id        uuid not null,
  employer_expense_account_id uuid not null,
  sss_payable_account_id    uuid not null,
  philhealth_payable_account_id uuid not null,
  pagibig_payable_account_id uuid not null,
  withholding_payable_account_id uuid not null,
  updated_by                uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at                timestamptz not null default now(),
  foreign key (client_id, net_pay_account_id) references public.accounts (client_id, id),
  foreign key (client_id, employer_expense_account_id) references public.accounts (client_id, id),
  foreign key (client_id, sss_payable_account_id) references public.accounts (client_id, id),
  foreign key (client_id, philhealth_payable_account_id) references public.accounts (client_id, id),
  foreign key (client_id, pagibig_payable_account_id) references public.accounts (client_id, id),
  foreign key (client_id, withholding_payable_account_id) references public.accounts (client_id, id)
);

-- Earnings and deductions. Whether an earning is taxable or part of each
-- contribution base is an accounting/legal judgement: it is set explicitly
-- and approved by a second person (nothing is preset).
create table public.payroll_items (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  code              text not null check (code ~ '^[A-Z0-9_]{2,20}$'),
  name              text not null check (char_length(name) between 2 and 100),
  kind              public.payroll_item_kind not null,
  account_id        uuid not null,
  unit              public.payroll_item_unit not null default 'amount',
  multiplier        numeric(9, 4) not null default 1 check (multiplier > 0 and multiplier <= 10),
  is_basic          boolean not null default false,
  is_taxable        boolean not null default false,
  in_sss_base       boolean not null default false,
  in_philhealth_base boolean not null default false,
  in_pagibig_base   boolean not null default false,
  status            text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  proposed_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  approved_by       uuid references public.profiles (id) on delete set null,
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (client_id, account_id) references public.accounts (client_id, id),
  unique (client_id, id),
  check (approved_by is null or proposed_by is null or approved_by <> proposed_by),
  check (kind = 'earning' or not (is_basic or is_taxable or in_sss_base or in_philhealth_base or in_pagibig_base)),
  check (kind = 'earning' or unit = 'amount')
);
create unique index payroll_items_unique_code on public.payroll_items (client_id, code);
create unique index payroll_items_one_basic on public.payroll_items (client_id) where is_basic and status <> 'retired';

-- Approved items are frozen (a change is a new item; retire the old one).
create function private.payroll_item_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'pay items cannot be deleted; retire them' using errcode = '42501';
  end if;
  if old.status <> 'proposed' and (to_jsonb(new) - array['status', 'approved_by', 'approved_at'])
                               is distinct from (to_jsonb(old) - array['status', 'approved_by', 'approved_at']) then
    raise exception 'an approved pay item cannot be changed; add a new one' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger payroll_items_guard before update or delete on public.payroll_items
  for each row execute function private.payroll_item_guard();

-- ---------------------------------------------------------------------------
-- Employees and their effective-dated pay rates
-- ---------------------------------------------------------------------------
create table public.employees (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients (id) on delete cascade,
  employee_no        text not null check (employee_no ~ '^[A-Za-z0-9._-]{1,20}$'),
  last_name          text not null check (char_length(last_name) between 1 and 100),
  first_name         text not null check (char_length(first_name) between 1 and 100),
  middle_name        text check (char_length(middle_name) <= 100),
  tin                text check (tin ~ '^[0-9]{9}([0-9]{3,5})?$'),
  sss_no             text check (char_length(sss_no) <= 20),
  philhealth_no      text check (char_length(philhealth_no) <= 20),
  pagibig_no         text check (char_length(pagibig_no) <= 20),
  position           text check (char_length(position) <= 100),
  hire_date          date not null,
  termination_date   date,
  termination_reason text check (char_length(termination_reason) <= 500),
  -- Exemption from compensation withholding is an accountant's decision
  -- with a recorded reason (e.g. minimum wage earner; PENDING VERIFICATION).
  withholding_exempt boolean not null default false,
  exempt_reason      text check (char_length(exempt_reason) <= 500),
  created_by         uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (client_id, id),
  check (termination_date is null or termination_date >= hire_date),
  check ((termination_date is null) = (termination_reason is null)),
  check (not withholding_exempt or exempt_reason is not null)
);
create unique index employees_unique_no on public.employees (client_id, lower(employee_no));

create table public.employee_rates (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  employee_id    uuid not null,
  effective_from date not null,
  pay_basis      public.pay_basis not null,
  -- monthly basis: the monthly salary; daily basis: the daily rate
  basic_rate     numeric(18, 4) not null check (basic_rate > 0),
  daily_rate     numeric(18, 4) not null check (daily_rate > 0),
  hourly_rate    numeric(18, 4) not null check (hourly_rate > 0),
  created_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (client_id, employee_id) references public.employees (client_id, id) on delete cascade,
  unique (employee_id, effective_from)
);

-- ---------------------------------------------------------------------------
-- Payroll runs, payslips, lines
-- ---------------------------------------------------------------------------
create table public.payroll_runs (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.clients (id) on delete cascade,
  frequency               public.payroll_frequency not null,
  period_start            date not null check (period_start >= date '2000-01-01'),
  period_end              date not null,
  pay_date                date not null,
  status                  public.sales_doc_status not null default 'draft',
  memo                    text check (char_length(memo) <= 500),
  gross_pay               numeric(18, 2) not null default 0,
  employee_contributions  numeric(18, 2) not null default 0,
  employer_contributions  numeric(18, 2) not null default 0,
  withholding_tax         numeric(18, 2) not null default 0,
  other_deductions        numeric(18, 2) not null default 0,
  net_pay                 numeric(18, 2) not null default 0,
  row_version             integer not null default 1,
  idempotency_key         text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by             uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_at            timestamptz,
  review_comment          text check (char_length(review_comment) <= 1000),
  posted_by               uuid references public.profiles (id) on delete set null,
  posted_at               timestamptz,
  journal_entry_id        uuid,
  cancelled_by            uuid references public.profiles (id) on delete set null,
  cancelled_at            timestamptz,
  cancel_reason           text check (char_length(cancel_reason) <= 500),
  cancel_journal_entry_id uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (period_end >= period_start),
  check (date_trunc('month', period_start) = date_trunc('month', period_end)),
  check (pay_date >= period_start),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
-- One active run per client and period: the duplicate-payroll guard.
create unique index payroll_runs_one_per_period on public.payroll_runs (client_id, period_start, period_end)
  where status <> 'cancelled';

-- One payslip per employee per run, with the computed amounts.
create table public.payroll_payslips (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null,
  run_id            uuid not null,
  employee_id       uuid not null,
  gross_pay         numeric(18, 2) not null default 0,
  taxable_pay       numeric(18, 2) not null default 0,
  sss_base          numeric(18, 2) not null default 0,
  philhealth_base   numeric(18, 2) not null default 0,
  pagibig_base      numeric(18, 2) not null default 0,
  sss_ee            numeric(18, 2) not null default 0,
  sss_er            numeric(18, 2) not null default 0,
  sss_ec            numeric(18, 2) not null default 0,
  philhealth_ee     numeric(18, 2) not null default 0,
  philhealth_er     numeric(18, 2) not null default 0,
  pagibig_ee        numeric(18, 2) not null default 0,
  pagibig_er        numeric(18, 2) not null default 0,
  withholding_tax   numeric(18, 2) not null default 0,
  other_deductions  numeric(18, 2) not null default 0,
  net_pay           numeric(18, 2) not null default 0,
  sss_rule_id       uuid references public.payroll_rule_sets (id),
  philhealth_rule_id uuid references public.payroll_rule_sets (id),
  pagibig_rule_id   uuid references public.payroll_rule_sets (id),
  withholding_rule_id uuid references public.payroll_rule_sets (id),
  notes             text check (char_length(notes) <= 500),
  foreign key (client_id, run_id) references public.payroll_runs (client_id, id) on delete cascade,
  foreign key (client_id, employee_id) references public.employees (client_id, id),
  unique (run_id, employee_id),
  unique (client_id, id)
);

create table public.payroll_lines (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null,
  payslip_id  uuid not null,
  line_no     smallint not null check (line_no between 1 and 200),
  item_id     uuid not null,
  description text check (char_length(description) <= 200),
  quantity    numeric(18, 4),
  rate        numeric(18, 4),
  amount      numeric(18, 2) not null,
  foreign key (client_id, payslip_id) references public.payroll_payslips (client_id, id) on delete cascade,
  foreign key (client_id, item_id) references public.payroll_items (client_id, id),
  unique (payslip_id, line_no)
);

-- Payments of net pay and remittances of withheld amounts, per run.
create table public.payroll_payments (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id) on delete cascade,
  run_id               uuid not null,
  kind                 public.payroll_payment_kind not null,
  item_id              uuid,
  payment_date         date not null,
  paid_from_account_id uuid not null,
  amount               numeric(18, 2) not null check (amount > 0),
  reference            text check (char_length(reference) <= 100),
  status               public.sales_doc_status not null default 'submitted',
  idempotency_key      text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by          uuid default auth.uid() references public.profiles (id) on delete set null,
  posted_by            uuid references public.profiles (id) on delete set null,
  posted_at            timestamptz,
  journal_entry_id     uuid,
  cancelled_by         uuid references public.profiles (id) on delete set null,
  cancelled_at         timestamptz,
  cancel_reason        text check (char_length(cancel_reason) <= 500),
  cancel_journal_entry_id uuid,
  created_at           timestamptz not null default now(),
  foreign key (client_id, run_id) references public.payroll_runs (client_id, id),
  foreign key (client_id, item_id) references public.payroll_items (client_id, id),
  foreign key (client_id, paid_from_account_id) references public.accounts (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  check ((kind = 'deduction') = (item_id is not null)),
  check (status in ('submitted', 'posted', 'cancelled')),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

-- Payroll history (kept apart from intake events, which are not payroll-restricted).
create table public.payroll_events (
  id           bigint generated always as identity primary key,
  client_id    uuid not null references public.clients (id) on delete cascade,
  subject      text not null check (subject in ('run', 'payment', 'employee', 'item', 'settings', 'access')),
  subject_id   uuid not null,
  from_status  text,
  to_status    text not null,
  actor_id     uuid default auth.uid() references public.profiles (id) on delete set null,
  comment      text check (char_length(comment) <= 2000),
  occurred_at  timestamptz not null default now()
);
create index payroll_events_subject_idx on public.payroll_events (client_id, subject, subject_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Guards: posted runs and payments are frozen; nothing is deleted.
-- ---------------------------------------------------------------------------
create function private.payroll_run_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- Totals are refreshed when a submitted run is posted.
  v_workflow text[] := array['status', 'row_version', 'submitted_at', 'review_comment', 'posted_by', 'posted_at',
    'journal_entry_id', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'cancel_journal_entry_id', 'updated_at',
    'gross_pay', 'employee_contributions', 'employer_contributions', 'withholding_tax', 'other_deductions', 'net_pay'];
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'payroll runs cannot be deleted; cancel them instead' using errcode = '42501';
  end if;
  if new.client_id <> old.client_id then
    raise exception 'client_id cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'cancelled' then
    raise exception 'a cancelled payroll cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'posted' and new.status = 'posted'
     and (to_jsonb(new) - array['updated_at', 'row_version']) is distinct from (to_jsonb(old) - array['updated_at', 'row_version']) then
    raise exception 'a posted payroll cannot be edited' using errcode = '42501';
  end if;
  if old.status <> 'draft' and (to_jsonb(new) - v_workflow) is distinct from (to_jsonb(old) - v_workflow) then
    raise exception 'a % payroll cannot be edited', old.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger payroll_runs_guard before update or delete on public.payroll_runs
  for each row execute function private.payroll_run_guard();
create trigger payroll_payments_guard before update or delete on public.payroll_payments
  for each row execute function private.sales_doc_guard();

-- Payslips and lines change only while their run is a draft.
create function private.payroll_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_status public.sales_doc_status;
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_status := case tg_table_name
    when 'payroll_payslips' then (select status from public.payroll_runs where id = (v_row ->> 'run_id')::uuid)
    when 'payroll_lines' then (select r.status from public.payroll_runs r join public.payroll_payslips p on p.run_id = r.id
                                where p.id = (v_row ->> 'payslip_id')::uuid)
  end;
  -- The amounts on payslips are refreshed when a submitted run is posted.
  if v_status = 'draft' or (tg_table_name = 'payroll_payslips' and tg_op = 'UPDATE' and v_status = 'submitted'
                            and current_setting('app.payroll_compute', true) = 'on') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'payslips of a % payroll cannot be changed', coalesce(v_status::text, 'missing') using errcode = '42501';
end;
$$;
create trigger payroll_payslips_guard before insert or update or delete on public.payroll_payslips
  for each row execute function private.payroll_child_guard();
create trigger payroll_lines_guard before insert or update or delete on public.payroll_lines
  for each row execute function private.payroll_child_guard();

create function private.payroll_no_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return old;
  end if;
  raise exception '% rows cannot be deleted', tg_table_name using errcode = '42501';
end;
$$;
create trigger employees_no_delete before delete on public.employees
  for each row execute function private.payroll_no_delete();
create trigger employee_rates_no_delete before delete on public.employee_rates
  for each row execute function private.payroll_no_delete();
create trigger payroll_events_append_only before update or delete on public.payroll_events
  for each row execute function private.intake_append_only();

create trigger payroll_runs_touch before update on public.payroll_runs
  for each row execute function private.touch_updated_at();
create trigger employees_touch before update on public.employees
  for each row execute function private.touch_updated_at();

create trigger audit_payroll_access after insert or update or delete on public.payroll_access
  for each row execute function audit.log_change();
create trigger audit_payroll_rule_sets after insert or update or delete on public.payroll_rule_sets
  for each row execute function audit.log_change();
create trigger audit_payroll_settings after insert or update or delete on public.payroll_settings
  for each row execute function audit.log_change();
create trigger audit_payroll_items after insert or update or delete on public.payroll_items
  for each row execute function audit.log_change();
create trigger audit_employees after insert or update or delete on public.employees
  for each row execute function audit.log_change();
create trigger audit_employee_rates after insert or update or delete on public.employee_rates
  for each row execute function audit.log_change();
create trigger audit_payroll_runs after insert or update or delete on public.payroll_runs
  for each row execute function audit.log_change();
create trigger audit_payroll_payments after insert or update or delete on public.payroll_payments
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- RLS: SELECT only, and only with a payroll grant. Rule tables (not personal
-- data) are readable by firm staff.
-- ---------------------------------------------------------------------------
revoke all on table public.payroll_access, public.payroll_rule_sets, public.payroll_rule_brackets,
  public.payroll_settings, public.payroll_items, public.employees, public.employee_rates, public.payroll_runs,
  public.payroll_payslips, public.payroll_lines, public.payroll_payments, public.payroll_events
from public, anon, authenticated;
grant select on table public.payroll_access, public.payroll_rule_sets, public.payroll_rule_brackets,
  public.payroll_settings, public.payroll_items, public.employees, public.employee_rates, public.payroll_runs,
  public.payroll_payslips, public.payroll_lines, public.payroll_payments, public.payroll_events
to authenticated;

alter table public.payroll_access enable row level security;
alter table public.payroll_access force row level security;
alter table public.payroll_rule_sets enable row level security;
alter table public.payroll_rule_sets force row level security;
alter table public.payroll_rule_brackets enable row level security;
alter table public.payroll_rule_brackets force row level security;
alter table public.payroll_settings enable row level security;
alter table public.payroll_settings force row level security;
alter table public.payroll_items enable row level security;
alter table public.payroll_items force row level security;
alter table public.employees enable row level security;
alter table public.employees force row level security;
alter table public.employee_rates enable row level security;
alter table public.employee_rates force row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_runs force row level security;
alter table public.payroll_payslips enable row level security;
alter table public.payroll_payslips force row level security;
alter table public.payroll_lines enable row level security;
alter table public.payroll_lines force row level security;
alter table public.payroll_payments enable row level security;
alter table public.payroll_payments force row level security;
alter table public.payroll_events enable row level security;
alter table public.payroll_events force row level security;

-- Grants: the grantee sees their own; firm managers on the client see all.
create policy payroll_access_select on public.payroll_access for select to authenticated
  using (user_id = auth.uid() or (private.is_firm_manager() and private.is_assigned(client_id)));
create policy payroll_rule_sets_select on public.payroll_rule_sets for select to authenticated
  using (private.firm_role() is not null);
create policy payroll_rule_brackets_select on public.payroll_rule_brackets for select to authenticated
  using (private.firm_role() is not null);
create policy payroll_settings_select on public.payroll_settings for select to authenticated using (private.can_view_payroll(client_id));
create policy payroll_items_select on public.payroll_items for select to authenticated using (private.can_view_payroll(client_id));
create policy employees_select on public.employees for select to authenticated using (private.can_view_payroll(client_id));
create policy employee_rates_select on public.employee_rates for select to authenticated using (private.can_view_payroll(client_id));
create policy payroll_runs_select on public.payroll_runs for select to authenticated using (private.can_view_payroll(client_id));
create policy payroll_payslips_select on public.payroll_payslips for select to authenticated using (private.can_view_payroll(client_id));
create policy payroll_lines_select on public.payroll_lines for select to authenticated using (private.can_view_payroll(client_id));
create policy payroll_payments_select on public.payroll_payments for select to authenticated using (private.can_view_payroll(client_id));
create policy payroll_events_select on public.payroll_events for select to authenticated using (private.can_view_payroll(client_id));

grant execute on function private.payroll_level(uuid), private.can_view_payroll(uuid),
  private.can_prepare_payroll(uuid), private.can_approve_payroll(uuid) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010200100', 'payroll_core') on conflict (version) do nothing;
