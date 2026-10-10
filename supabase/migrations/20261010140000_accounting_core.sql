-- Phase 5: core double-entry accounting engine.
--
-- Invariants enforced IN THE DATABASE (doc 05):
--   I-1  posted entries balance (sum debit = sum credit > 0, >= 2 lines) — deferred constraint trigger
--   I-2  each line is one-sided and non-negative                          — CHECK
--   I-3  posted/reversed/void entries and their lines are immutable      — triggers
--   I-4  no posting into locked periods; soft-closed accepts adjustments — functions + trigger
--   I-5  idempotent drafting/reversal; one live entry per source ref     — UNIQUE
--   I-6  gapless entry numbers per client fiscal year, assigned at post  — locked counter
--   I-7  lines, accounts, periods belong to the entry's client            — composite FKs
--   I-8  only active, postable accounts                                   — trigger
--   I-9  maker-checker (approver <> preparer)                             — CHECK + function
--   I-10 an entry can be reversed at most once                            — UNIQUE
-- No tax computations are implemented here.

create type public.account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type public.normal_balance as enum ('debit', 'credit');
create type public.period_status as enum ('open', 'soft_closed', 'locked');
create type public.entry_status as enum ('draft', 'submitted', 'posted', 'reversed', 'void');
create type public.entry_type as enum ('general', 'opening', 'adjusting', 'closing', 'reversal');

-- ---------------------------------------------------------------------------
-- Chart-of-accounts templates (firm level, read-only to staff)
-- ---------------------------------------------------------------------------
create table public.coa_templates (
  code       text primary key check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name       text not null,
  status     text not null check (status in ('proposed', 'approved', 'retired')),
  notes      text,
  created_at timestamptz not null default now()
);

create table public.coa_template_accounts (
  template_code  text not null references public.coa_templates (code) on delete cascade,
  code           text not null,
  name           text not null,
  account_type   public.account_type not null,
  normal_balance public.normal_balance not null,
  parent_code    text,
  is_postable    boolean not null default true,
  sort_order     integer not null,
  primary key (template_code, code)
);

-- ---------------------------------------------------------------------------
-- Chart of accounts (per client)
-- ---------------------------------------------------------------------------
create table public.accounts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id) on delete cascade,
  code           text not null check (code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'),
  name           text not null check (char_length(name) between 1 and 200),
  account_type   public.account_type not null,
  normal_balance public.normal_balance not null,
  parent_id      uuid,
  is_postable    boolean not null default true,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (client_id, code),
  unique (client_id, id),
  foreign key (client_id, parent_id) references public.accounts (client_id, id)
);

-- ---------------------------------------------------------------------------
-- Fiscal years and periods
-- ---------------------------------------------------------------------------
create table public.fiscal_years (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  start_date    date not null,
  end_date      date not null,
  next_entry_no integer not null default 1 check (next_entry_no >= 1),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  check (end_date > start_date),
  check (end_date < start_date + 400),
  unique (client_id, start_date),
  unique (client_id, id)
);

create table public.accounting_periods (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null,
  fiscal_year_id    uuid not null,
  period_no         smallint not null check (period_no between 1 and 13),
  start_date        date not null,
  end_date          date not null,
  status            public.period_status not null default 'open',
  status_changed_at timestamptz,
  status_changed_by uuid references public.profiles (id) on delete set null,
  status_reason     text check (char_length(status_reason) <= 500),
  foreign key (client_id, fiscal_year_id) references public.fiscal_years (client_id, id) on delete cascade,
  check (end_date >= start_date),
  unique (client_id, start_date),
  unique (fiscal_year_id, period_no),
  unique (client_id, id)
);

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
create table public.journal_entries (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id) on delete cascade,
  fiscal_year_id       uuid not null,
  period_id            uuid not null,
  entry_no             integer,
  entry_date           date not null,
  entry_type           public.entry_type not null default 'general',
  status               public.entry_status not null default 'draft',
  memo                 text not null default '' check (char_length(memo) <= 500),
  -- Stable link to the originating source transaction/document.
  source_type          text check (source_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  source_ref           text check (char_length(source_ref) between 1 and 200),
  idempotency_key      text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by          uuid references public.profiles (id) on delete set null,
  submitted_at         timestamptz,
  approved_by          uuid references public.profiles (id) on delete set null,
  posted_at            timestamptz,
  review_comment       text check (char_length(review_comment) <= 1000),
  void_reason          text check (char_length(void_reason) <= 500),
  reverses_entry_id    uuid,
  reversed_by_entry_id uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (client_id, fiscal_year_id) references public.fiscal_years (client_id, id),
  foreign key (client_id, period_id) references public.accounting_periods (client_id, id),
  foreign key (client_id, reverses_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, reversed_by_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, id),
  unique (client_id, idempotency_key),
  unique (fiscal_year_id, entry_no),
  unique (reverses_entry_id),
  check ((source_type is null) = (source_ref is null)),
  -- Maker-checker. Reversals are a single controlled approver action (see reverse_entry).
  check (entry_type = 'reversal' or approved_by is null or prepared_by is null or approved_by <> prepared_by),
  check ((status in ('posted', 'reversed')) = (entry_no is not null and posted_at is not null)),
  check ((entry_type = 'reversal') = (reverses_entry_id is not null)),
  check ((status = 'reversed') = (reversed_by_entry_id is not null))
);
-- One LIVE entry per source document (a reversed entry frees the source for a corrected entry).
create unique index journal_entries_one_live_per_source
  on public.journal_entries (client_id, source_type, source_ref)
  where source_ref is not null and status in ('draft', 'submitted', 'posted');
create index journal_entries_client_date_idx on public.journal_entries (client_id, entry_date);
create index journal_entries_period_idx on public.journal_entries (period_id, status);

create table public.journal_lines (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null,
  entry_id    uuid not null,
  line_no     smallint not null check (line_no between 1 and 500),
  account_id  uuid not null,
  debit       numeric(18, 2) not null default 0 check (debit >= 0),
  credit      numeric(18, 2) not null default 0 check (credit >= 0),
  description text check (char_length(description) <= 300),
  foreign key (client_id, entry_id) references public.journal_entries (client_id, id) on delete cascade,
  foreign key (client_id, account_id) references public.accounts (client_id, id),
  unique (entry_id, line_no),
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index journal_lines_account_idx on public.journal_lines (client_id, account_id);
create index journal_lines_entry_idx on public.journal_lines (entry_id);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------
-- Controlled purge of SYNTHETIC test clients only (see purge_synthetic_client).
create function private.purge_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(current_setting('app.purge', true), '') = 'on';
$$;

create function private.fiscal_year_no_overlap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.fiscal_years f
    where f.client_id = new.client_id and f.id <> new.id
      and f.start_date <= new.end_date and new.start_date <= f.end_date
  ) then
    raise exception 'fiscal years of a client cannot overlap' using errcode = '23P01';
  end if;
  return new;
end;
$$;
create trigger fiscal_years_no_overlap before insert or update on public.fiscal_years
  for each row execute function private.fiscal_year_no_overlap();

create function private.journal_entry_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ignore text[] := array['status', 'reversed_by_entry_id', 'updated_at'];
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'journal entries cannot be deleted; void a draft or reverse a posted entry'
      using errcode = '42501';
  end if;
  if new.client_id <> old.client_id then
    raise exception 'client_id cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'posted' then
    if new.status = 'reversed' and new.reversed_by_entry_id is not null
       and (to_jsonb(new) - v_ignore) = (to_jsonb(old) - v_ignore) then
      return new;
    end if;
    raise exception 'posted journal entries are immutable; use a reversal' using errcode = '42501';
  end if;
  if old.status in ('reversed', 'void') then
    raise exception 'this journal entry is closed and immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger journal_entries_guard before update or delete on public.journal_entries
  for each row execute function private.journal_entry_guard();

-- The entry's date must lie inside its period, and the period inside its fiscal year.
create function private.journal_entry_period_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_period public.accounting_periods;
begin
  select * into v_period from public.accounting_periods where id = new.period_id;
  if v_period.fiscal_year_id <> new.fiscal_year_id
     or new.entry_date not between v_period.start_date and v_period.end_date then
    raise exception 'entry date does not belong to the entry''s accounting period' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger journal_entries_period_check before insert or update of entry_date, period_id, fiscal_year_id
  on public.journal_entries for each row execute function private.journal_entry_period_check();

-- Lines may only change while the entry is a draft; accounts must be active and postable.
create function private.journal_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.entry_status;
  v_ok boolean;
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into v_status from public.journal_entries
   where id = case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % journal entry cannot be changed', coalesce(v_status::text, 'missing')
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.entry_id <> old.entry_id or new.client_id <> old.client_id) then
    raise exception 'lines cannot move between entries' using errcode = '42501';
  end if;
  select is_active and is_postable into v_ok from public.accounts where id = new.account_id;
  if not coalesce(v_ok, false) then
    raise exception 'account is inactive or not postable' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger journal_lines_guard before insert or update or delete on public.journal_lines
  for each row execute function private.journal_line_guard();

-- I-1: checked at COMMIT for every entry that is (or becomes) posted/reversed.
create function private.assert_entry_balanced() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_debit numeric;
  v_credit numeric;
  v_lines integer;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_debit, v_credit, v_lines
    from public.journal_lines where entry_id = new.id;
  if v_lines < 2 or v_debit <> v_credit or v_debit <= 0 then
    raise exception 'journal entry % does not balance (debit %, credit %, lines %)',
      new.id, v_debit, v_credit, v_lines using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger journal_entries_balanced
  after insert or update on public.journal_entries
  deferrable initially deferred
  for each row when (new.status in ('posted', 'reversed'))
  execute function private.assert_entry_balanced();

-- Accounts used in any line cannot be deleted; type/normal balance fixed once used.
create function private.account_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'accounts cannot be deleted; deactivate instead' using errcode = '42501';
  end if;
  if new.client_id <> old.client_id then
    raise exception 'client_id cannot be changed' using errcode = '42501';
  end if;
  if (new.account_type <> old.account_type or new.normal_balance <> old.normal_balance
      or new.code <> old.code)
     and exists (select 1 from public.journal_lines where account_id = old.id) then
    raise exception 'code, type and normal balance cannot change after an account is used'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger accounts_guard before update or delete on public.accounts
  for each row execute function private.account_guard();

create trigger accounts_touch before update on public.accounts
  for each row execute function private.touch_updated_at();
create trigger journal_entries_touch before update on public.journal_entries
  for each row execute function private.touch_updated_at();

-- Audit (append-only, from Phase 3)
create trigger audit_accounts after insert or update or delete on public.accounts
  for each row execute function audit.log_change();
create trigger audit_fiscal_years after insert or update or delete on public.fiscal_years
  for each row execute function audit.log_change();
create trigger audit_accounting_periods after insert or update or delete on public.accounting_periods
  for each row execute function audit.log_change();
create trigger audit_journal_entries after insert or update or delete on public.journal_entries
  for each row execute function audit.log_change();
create trigger audit_journal_lines after insert or update or delete on public.journal_lines
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
create function private.can_prepare_entries(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client_id)
     and private.firm_role() in ('firm_manager', 'reviewer', 'accountant', 'bookkeeper');
$$;

create function private.can_approve_entries(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client_id) and private.firm_role() in ('firm_manager', 'reviewer');
$$;

create function private.can_maintain_coa(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client_id)
     and private.firm_role() in ('firm_manager', 'reviewer', 'accountant');
$$;

-- Client users see only posted/reversed entries; assigned staff see everything.
create function private.can_read_entry(p_client_id uuid, p_status public.entry_status) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client_id)
      or (private.client_role(p_client_id) is not null and p_status in ('posted', 'reversed'));
$$;

create function private.can_read_line(p_entry_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.journal_entries e
    where e.id = p_entry_id and private.can_read_entry(e.client_id, e.status)
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS: read-only to API roles; all writes via functions.
-- ---------------------------------------------------------------------------
revoke all on table
  public.coa_templates, public.coa_template_accounts, public.accounts, public.fiscal_years,
  public.accounting_periods, public.journal_entries, public.journal_lines
from public, anon, authenticated;
grant select on table
  public.coa_templates, public.coa_template_accounts, public.accounts, public.fiscal_years,
  public.accounting_periods, public.journal_entries, public.journal_lines
to authenticated;

alter table public.coa_templates enable row level security;
alter table public.coa_templates force row level security;
alter table public.coa_template_accounts enable row level security;
alter table public.coa_template_accounts force row level security;
alter table public.accounts enable row level security;
alter table public.accounts force row level security;
alter table public.fiscal_years enable row level security;
alter table public.fiscal_years force row level security;
alter table public.accounting_periods enable row level security;
alter table public.accounting_periods force row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_entries force row level security;
alter table public.journal_lines enable row level security;
alter table public.journal_lines force row level security;

create policy coa_templates_select on public.coa_templates for select to authenticated
  using (private.firm_role() is not null);
create policy coa_template_accounts_select on public.coa_template_accounts for select to authenticated
  using (private.firm_role() is not null);
create policy accounts_select on public.accounts for select to authenticated
  using (private.can_read_client(client_id));
create policy fiscal_years_select on public.fiscal_years for select to authenticated
  using (private.can_read_client(client_id));
create policy accounting_periods_select on public.accounting_periods for select to authenticated
  using (private.can_read_client(client_id));
create policy journal_entries_select on public.journal_entries for select to authenticated
  using (private.can_read_entry(client_id, status));
create policy journal_lines_select on public.journal_lines for select to authenticated
  using (private.can_read_line(entry_id));

revoke execute on function
  private.purge_allowed(), private.fiscal_year_no_overlap(), private.journal_entry_guard(),
  private.journal_entry_period_check(), private.journal_line_guard(),
  private.assert_entry_balanced(), private.account_guard()
from public, anon, authenticated;
revoke execute on function
  private.can_prepare_entries(uuid), private.can_approve_entries(uuid),
  private.can_maintain_coa(uuid), private.can_read_entry(uuid, public.entry_status),
  private.can_read_line(uuid)
from public, anon;
grant execute on function
  private.can_prepare_entries(uuid), private.can_approve_entries(uuid),
  private.can_maintain_coa(uuid), private.can_read_entry(uuid, public.entry_status),
  private.can_read_line(uuid)
to authenticated;
