-- Phase 5: controlled accounting operations (SECURITY DEFINER, authority-checked,
-- audited) and read models (SECURITY INVOKER, so RLS applies).
-- Error codes: 42501 forbidden, P0002 not found, 23505 conflict, 22023 invalid.

-- Reversal lines must be able to reference accounts deactivated after the
-- original posting; all other entries require active, postable accounts.
create or replace function private.journal_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.entry_status;
  v_type public.entry_type;
  v_ok boolean;
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status, entry_type into v_status, v_type from public.journal_entries
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
  if v_type <> 'reversal' then
    select is_active and is_postable into v_ok from public.accounts where id = new.account_id;
    if not coalesce(v_ok, false) then
      raise exception 'account is inactive or not postable' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

-- Strict amount parser: digits with at most 2 decimals. Rejects signs,
-- separators, exponents and extra decimals instead of silently rounding.
create function private.parse_amount(p_text text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_text is null or p_text = '' then
    return 0;
  end if;
  if p_text !~ '^[0-9]{1,16}(\.[0-9]{1,2})?$' then
    raise exception 'invalid amount "%": use digits with up to 2 decimal places', left(p_text, 30)
      using errcode = '22023';
  end if;
  return p_text::numeric;
end;
$$;

-- Balance + period-status check shared by submit and post.
create function private.assert_entry_ready(p_entry_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_entry public.journal_entries;
  v_period public.period_status;
  v_debit numeric;
  v_credit numeric;
  v_lines integer;
begin
  select * into v_entry from public.journal_entries where id = p_entry_id;
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_debit, v_credit, v_lines
    from public.journal_lines where entry_id = p_entry_id;
  if v_lines < 2 then
    raise exception 'a journal entry needs at least two lines' using errcode = '22023';
  end if;
  if v_debit <> v_credit then
    raise exception 'journal entry does not balance: debits % vs credits %', v_debit, v_credit
      using errcode = '22023';
  end if;
  if v_debit <= 0 then
    raise exception 'journal entry total must be greater than zero' using errcode = '22023';
  end if;
  select status into v_period from public.accounting_periods where id = v_entry.period_id;
  if v_period = 'locked' then
    raise exception 'the accounting period is locked' using errcode = '22023';
  end if;
  if v_period = 'soft_closed' and v_entry.entry_type not in ('adjusting', 'reversal') then
    raise exception 'the period is soft-closed: only adjusting entries are allowed' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
create function public.create_account(
  p_client_id uuid, p_code text, p_name text, p_account_type public.account_type,
  p_normal_balance public.normal_balance, p_parent_code text default null,
  p_is_postable boolean default true
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_parent uuid;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to maintain this client''s chart of accounts' using errcode = '42501';
  end if;
  if p_parent_code is not null then
    select id into v_parent from public.accounts where client_id = p_client_id and code = p_parent_code;
    if v_parent is null then
      raise exception 'parent account % not found', p_parent_code using errcode = '22023';
    end if;
  end if;
  insert into public.accounts (client_id, code, name, account_type, normal_balance, parent_id, is_postable)
  values (p_client_id, trim(p_code), trim(p_name), p_account_type, p_normal_balance, v_parent,
          coalesce(p_is_postable, true))
  returning id into v_id;
  return v_id;
end;
$$;

create function public.update_account(p_account_id uuid, p_name text, p_is_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid;
begin
  perform private.require_active_user();
  select client_id into v_client from public.accounts where id = p_account_id;
  if v_client is null or not private.can_maintain_coa(v_client) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  update public.accounts
     set name = coalesce(nullif(trim(p_name), ''), name),
         is_active = coalesce(p_is_active, is_active)
   where id = p_account_id;
end;
$$;

create function public.apply_coa_template(p_client_id uuid, p_template_code text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to maintain this client''s chart of accounts' using errcode = '42501';
  end if;
  if not exists (select 1 from public.coa_templates where code = p_template_code and status <> 'retired') then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.accounts where client_id = p_client_id) then
    raise exception 'this client already has accounts; add accounts individually' using errcode = '23505';
  end if;
  insert into public.accounts (client_id, code, name, account_type, normal_balance, is_postable)
  select p_client_id, t.code, t.name, t.account_type, t.normal_balance, t.is_postable
    from public.coa_template_accounts t
   where t.template_code = p_template_code
   order by t.sort_order;
  get diagnostics v_count = row_count;
  update public.accounts a
     set parent_id = p.id
    from public.coa_template_accounts t
    join public.accounts p on p.client_id = p_client_id and p.code = t.parent_code
   where t.template_code = p_template_code and a.client_id = p_client_id and a.code = t.code
     and t.parent_code is not null;
  perform audit.log_event('coa.template_applied', p_client_id,
    jsonb_build_object('template', p_template_code, 'accounts', v_count));
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fiscal years and period controls
-- ---------------------------------------------------------------------------
create function public.create_fiscal_year(p_client_id uuid, p_start_date date, p_months integer default 12)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_fy uuid;
  v_end date;
  i integer;
begin
  perform private.require_active_user();
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only reviewers and managers can open fiscal years' using errcode = '42501';
  end if;
  if extract(day from p_start_date) <> 1 then
    raise exception 'a fiscal year must start on the first day of a month' using errcode = '22023';
  end if;
  if p_months is null or p_months < 1 or p_months > 12 then
    raise exception 'a fiscal year has 1 to 12 monthly periods' using errcode = '22023';
  end if;
  v_end := (p_start_date + make_interval(months => p_months))::date - 1;
  insert into public.fiscal_years (client_id, start_date, end_date)
  values (p_client_id, p_start_date, v_end) returning id into v_fy;
  for i in 1..p_months loop
    insert into public.accounting_periods (client_id, fiscal_year_id, period_no, start_date, end_date)
    values (p_client_id, v_fy, i,
            (p_start_date + make_interval(months => i - 1))::date,
            (p_start_date + make_interval(months => i))::date - 1);
  end loop;
  return v_fy;
end;
$$;

create function public.set_period_status(
  p_period_id uuid, p_status public.period_status, p_reason text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_period public.accounting_periods;
begin
  perform private.require_active_user();
  select * into v_period from public.accounting_periods where id = p_period_id for update;
  if not found or not private.can_read_client(v_period.client_id) then
    raise exception 'period not found' using errcode = 'P0002';
  end if;
  if v_period.status = p_status then
    return;
  end if;
  if p_status = 'locked' or v_period.status = 'locked' then
    -- Locking and unlocking: firm managers only (SoD-4); unlocking needs a reason.
    if not (private.is_assigned(v_period.client_id) and private.firm_role() = 'firm_manager') then
      raise exception 'only firm managers can lock or reopen a locked period' using errcode = '42501';
    end if;
    if v_period.status = 'locked' and (p_reason is null or char_length(trim(p_reason)) < 3) then
      raise exception 'a reason is required to reopen a locked period' using errcode = '22023';
    end if;
    if p_status = 'locked' and exists (
      select 1 from public.journal_entries
      where period_id = p_period_id and status in ('draft', 'submitted')
    ) then
      raise exception 'post, return or void all draft and submitted entries before locking'
        using errcode = '22023';
    end if;
  elsif not private.can_approve_entries(v_period.client_id) then
    raise exception 'only reviewers and managers can close or reopen periods' using errcode = '42501';
  end if;
  update public.accounting_periods
     set status = p_status, status_changed_at = now(), status_changed_by = auth.uid(),
         status_reason = nullif(left(trim(coalesce(p_reason, '')), 500), '')
   where id = p_period_id;
  perform audit.log_event('period.status_changed', v_period.client_id,
    jsonb_build_object('period_id', p_period_id, 'from', v_period.status, 'to', p_status,
                       'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Journal entry workflow: draft -> submitted -> posted (-> reversed) | void
-- ---------------------------------------------------------------------------
create function public.save_draft_entry(
  p_client_id uuid,
  p_entry_id uuid,
  p_entry_date date,
  p_entry_type public.entry_type,
  p_memo text,
  p_source_type text,
  p_source_ref text,
  p_idempotency_key text,
  p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_entry public.journal_entries;
  v_period public.accounting_periods;
  v_id uuid;
  v_line jsonb;
  v_no integer := 0;
begin
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to prepare journal entries for this client' using errcode = '42501';
  end if;
  if p_entry_type = 'reversal' then
    raise exception 'reversal entries are created only by reversing a posted entry' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500 then
    raise exception 'provide 1 to 500 journal lines' using errcode = '22023';
  end if;
  select * into v_period from public.accounting_periods
   where client_id = p_client_id and p_entry_date between start_date and end_date;
  if not found then
    raise exception 'no accounting period covers %; open the fiscal year first', p_entry_date
      using errcode = '22023';
  end if;
  if v_period.status = 'locked' then
    raise exception 'the accounting period for % is locked', p_entry_date using errcode = '22023';
  end if;

  if p_entry_id is null then
    -- Idempotent create: replaying the same key returns the same entry.
    select id into v_id from public.journal_entries
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
    insert into public.journal_entries
      (client_id, fiscal_year_id, period_id, entry_date, entry_type, memo,
       source_type, source_ref, idempotency_key, prepared_by)
    values
      (p_client_id, v_period.fiscal_year_id, v_period.id, p_entry_date, p_entry_type,
       coalesce(trim(p_memo), ''), nullif(trim(p_source_type), ''), nullif(trim(p_source_ref), ''),
       p_idempotency_key, v_uid)
    returning id into v_id;
  else
    select * into v_entry from public.journal_entries where id = p_entry_id for update;
    if not found or v_entry.client_id <> p_client_id then
      raise exception 'journal entry not found' using errcode = 'P0002';
    end if;
    if v_entry.status <> 'draft' then
      raise exception 'only draft entries can be edited' using errcode = '22023';
    end if;
    update public.journal_entries
       set fiscal_year_id = v_period.fiscal_year_id, period_id = v_period.id,
           entry_date = p_entry_date, entry_type = p_entry_type, memo = coalesce(trim(p_memo), ''),
           source_type = nullif(trim(p_source_type), ''), source_ref = nullif(trim(p_source_ref), ''),
           prepared_by = v_uid  -- whoever last edits is the preparer (maker-checker)
     where id = p_entry_id;
    delete from public.journal_lines where entry_id = p_entry_id;
    v_id := p_entry_id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    insert into public.journal_lines (client_id, entry_id, line_no, account_id, debit, credit, description)
    values (p_client_id, v_id, v_no, (v_line ->> 'account_id')::uuid,
            private.parse_amount(v_line ->> 'debit'), private.parse_amount(v_line ->> 'credit'),
            nullif(left(trim(coalesce(v_line ->> 'description', '')), 300), ''));
  end loop;
  return v_id;
end;
$$;

create function public.submit_entry(p_entry_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_entry public.journal_entries;
begin
  perform private.require_active_user();
  select * into v_entry from public.journal_entries where id = p_entry_id for update;
  if not found or not private.can_prepare_entries(v_entry.client_id) then
    raise exception 'journal entry not found' using errcode = 'P0002';
  end if;
  if v_entry.status <> 'draft' then
    raise exception 'only draft entries can be submitted' using errcode = '22023';
  end if;
  perform private.assert_entry_ready(p_entry_id);
  update public.journal_entries
     set status = 'submitted', submitted_at = now(), review_comment = null
   where id = p_entry_id;
  perform audit.log_event('journal.submitted', v_entry.client_id, jsonb_build_object('entry_id', p_entry_id));
end;
$$;

create function public.return_entry(p_entry_id uuid, p_comment text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_entry public.journal_entries;
begin
  perform private.require_active_user();
  select * into v_entry from public.journal_entries where id = p_entry_id for update;
  if not found or not private.can_approve_entries(v_entry.client_id) then
    raise exception 'journal entry not found' using errcode = 'P0002';
  end if;
  if v_entry.status <> 'submitted' then
    raise exception 'only submitted entries can be returned' using errcode = '22023';
  end if;
  if p_comment is null or char_length(trim(p_comment)) < 3 then
    raise exception 'a comment is required when returning an entry' using errcode = '22023';
  end if;
  update public.journal_entries
     set status = 'draft', submitted_at = null, review_comment = left(trim(p_comment), 1000)
   where id = p_entry_id;
  perform audit.log_event('journal.returned', v_entry.client_id,
    jsonb_build_object('entry_id', p_entry_id, 'comment', p_comment));
end;
$$;

create function public.approve_and_post(p_entry_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_entry public.journal_entries;
  v_no integer;
begin
  -- Row lock serializes concurrent approvals of the same entry.
  select * into v_entry from public.journal_entries where id = p_entry_id for update;
  if not found or not private.can_approve_entries(v_entry.client_id) then
    raise exception 'journal entry not found' using errcode = 'P0002';
  end if;
  if v_entry.status in ('posted', 'reversed') then
    return v_entry.entry_no;  -- idempotent: never posts twice
  end if;
  if v_entry.status <> 'submitted' then
    raise exception 'only submitted entries can be posted' using errcode = '22023';
  end if;
  if v_entry.prepared_by = v_uid then
    raise exception 'you cannot approve an entry you prepared' using errcode = '42501';
  end if;
  perform 1 from public.accounting_periods where id = v_entry.period_id for share;
  perform private.assert_entry_ready(p_entry_id);
  if exists (
    select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.entry_id = p_entry_id and not (a.is_active and a.is_postable)
  ) then
    raise exception 'an account on this entry is inactive or not postable' using errcode = '22023';
  end if;
  -- Gapless numbering: the fiscal-year counter row is locked until commit.
  update public.fiscal_years set next_entry_no = next_entry_no + 1
   where id = v_entry.fiscal_year_id
   returning next_entry_no - 1 into v_no;
  update public.journal_entries
     set status = 'posted', entry_no = v_no, approved_by = v_uid, posted_at = now()
   where id = p_entry_id;
  perform audit.log_event('journal.posted', v_entry.client_id,
    jsonb_build_object('entry_id', p_entry_id, 'entry_no', v_no));
  return v_no;
end;
$$;

create function public.void_entry(p_entry_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_entry public.journal_entries;
begin
  perform private.require_active_user();
  select * into v_entry from public.journal_entries where id = p_entry_id for update;
  if not found or not private.can_prepare_entries(v_entry.client_id) then
    raise exception 'journal entry not found' using errcode = 'P0002';
  end if;
  if v_entry.status not in ('draft', 'submitted') then
    raise exception 'only draft or submitted entries can be voided; reverse posted entries'
      using errcode = '22023';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'a reason is required to void an entry' using errcode = '22023';
  end if;
  update public.journal_entries set status = 'void', void_reason = left(trim(p_reason), 500)
   where id = p_entry_id;
  perform audit.log_event('journal.voided', v_entry.client_id,
    jsonb_build_object('entry_id', p_entry_id, 'reason', p_reason));
end;
$$;

-- Creates and posts the mirror entry in one controlled step (approvers only).
create function public.reverse_entry(
  p_entry_id uuid, p_reversal_date date, p_reason text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_orig public.journal_entries;
  v_period public.accounting_periods;
  v_date date;
  v_rev uuid;
  v_no integer;
begin
  select * into v_orig from public.journal_entries where id = p_entry_id for update;
  if not found or not private.can_approve_entries(v_orig.client_id) then
    raise exception 'journal entry not found' using errcode = 'P0002';
  end if;
  -- Idempotent replay returns the reversal created by the same request.
  select id into v_rev from public.journal_entries
   where client_id = v_orig.client_id and idempotency_key = p_idempotency_key;
  if found then
    return v_rev;
  end if;
  if v_orig.status = 'reversed' then
    raise exception 'this entry has already been reversed' using errcode = '23505';
  end if;
  if v_orig.status <> 'posted' then
    raise exception 'only posted entries can be reversed' using errcode = '22023';
  end if;
  if v_orig.entry_type = 'reversal' then
    raise exception 'a reversal cannot be reversed; post a new entry instead' using errcode = '22023';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'a reason is required to reverse an entry' using errcode = '22023';
  end if;
  v_date := coalesce(p_reversal_date, v_orig.entry_date);
  if v_date < v_orig.entry_date then
    raise exception 'the reversal date cannot be before the original entry date' using errcode = '22023';
  end if;
  select * into v_period from public.accounting_periods
   where client_id = v_orig.client_id and v_date between start_date and end_date;
  if not found then
    raise exception 'no accounting period covers %', v_date using errcode = '22023';
  end if;
  if v_period.status = 'locked' then
    raise exception 'the period for % is locked; choose a date in an open period', v_date
      using errcode = '22023';
  end if;
  perform 1 from public.accounting_periods where id = v_period.id for share;

  insert into public.journal_entries
    (client_id, fiscal_year_id, period_id, entry_date, entry_type, memo, source_type, source_ref,
     idempotency_key, prepared_by, submitted_at, reverses_entry_id)
  values
    (v_orig.client_id, v_period.fiscal_year_id, v_period.id, v_date, 'reversal',
     left(format('Reversal of JE %s: %s', v_orig.entry_no, trim(p_reason)), 500),
     'reversal', v_orig.id::text, p_idempotency_key, v_uid, now(), v_orig.id)
  returning id into v_rev;

  insert into public.journal_lines (client_id, entry_id, line_no, account_id, debit, credit, description)
  select client_id, v_rev, line_no, account_id, credit, debit, description
    from public.journal_lines where entry_id = v_orig.id order by line_no;

  update public.fiscal_years set next_entry_no = next_entry_no + 1
   where id = v_period.fiscal_year_id
   returning next_entry_no - 1 into v_no;
  update public.journal_entries
     set status = 'posted', entry_no = v_no, approved_by = v_uid, posted_at = now()
   where id = v_rev;
  update public.journal_entries set status = 'reversed', reversed_by_entry_id = v_rev
   where id = v_orig.id;
  perform audit.log_event('journal.reversed', v_orig.client_id,
    jsonb_build_object('entry_id', v_orig.id, 'reversal_id', v_rev, 'reason', p_reason));
  return v_rev;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read models (SECURITY INVOKER: RLS decides what the caller may see).
-- Posted AND reversed entries both count; a reversal nets its original to zero.
-- ---------------------------------------------------------------------------
create function public.trial_balance(p_client_id uuid, p_as_of date)
returns table (
  account_id uuid, code text, name text, account_type public.account_type,
  normal_balance public.normal_balance, total_debit numeric, total_credit numeric, balance numeric
)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.code, a.name, a.account_type, a.normal_balance,
         sum(l.debit), sum(l.credit),
         case when a.normal_balance = 'debit' then sum(l.debit) - sum(l.credit)
              else sum(l.credit) - sum(l.debit) end
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where l.client_id = p_client_id
     and e.status in ('posted', 'reversed')
     and e.entry_date <= p_as_of
   group by a.id, a.code, a.name, a.account_type, a.normal_balance
   order by a.code;
$$;

create function public.general_ledger(p_client_id uuid, p_account_id uuid, p_from date, p_to date)
returns table (
  entry_id uuid, entry_no integer, entry_date date, entry_type public.entry_type, memo text,
  line_no smallint, description text, debit numeric, credit numeric, running_balance numeric
)
language sql stable security invoker set search_path = '' as $$
  with acct as (
    select normal_balance from public.accounts where id = p_account_id and client_id = p_client_id
  ),
  opening as (
    select coalesce(sum(case when acct.normal_balance = 'debit' then l.debit - l.credit
                             else l.credit - l.debit end), 0) as bal
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      cross join acct
     where l.client_id = p_client_id and l.account_id = p_account_id
       and e.status in ('posted', 'reversed') and e.entry_date < p_from
  ),
  rows as (
    select e.id, e.entry_no, e.entry_date, e.entry_type, e.memo, l.line_no, l.description,
           l.debit, l.credit,
           case when acct.normal_balance = 'debit' then l.debit - l.credit
                else l.credit - l.debit end as delta
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      cross join acct
     where l.client_id = p_client_id and l.account_id = p_account_id
       and e.status in ('posted', 'reversed') and e.entry_date between p_from and p_to
  )
  select r.id, r.entry_no, r.entry_date, r.entry_type, r.memo, r.line_no, r.description,
         r.debit, r.credit,
         (select bal from opening)
           + sum(r.delta) over (order by r.entry_date, r.entry_no, r.line_no
                                rows between unbounded preceding and current row)
    from rows r
   order by r.entry_date, r.entry_no, r.line_no;
$$;

-- ---------------------------------------------------------------------------
-- Synthetic test-data purge (service role only; ZZTEST- clients only).
-- Production must set private.settings('allow_synthetic_purge') = false.
-- ---------------------------------------------------------------------------
insert into private.settings (key, value) values ('allow_synthetic_purge', 'true'::jsonb)
on conflict (key) do nothing;

create function public.purge_synthetic_client(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select (value)::text from private.settings where key = 'allow_synthetic_purge'), 'false')
     <> 'true' then
    raise exception 'synthetic purge is disabled in this environment' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id and code ~ '^ZZTEST-') then
    raise exception 'only synthetic ZZTEST- clients can be purged' using errcode = '42501';
  end if;
  perform set_config('app.purge', 'on', true);
  delete from public.clients where id = p_client_id;
  perform set_config('app.purge', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  private.parse_amount(text), private.assert_entry_ready(uuid)
from public, anon, authenticated;

revoke execute on function
  public.create_account(uuid, text, text, public.account_type, public.normal_balance, text, boolean),
  public.update_account(uuid, text, boolean),
  public.apply_coa_template(uuid, text),
  public.create_fiscal_year(uuid, date, integer),
  public.set_period_status(uuid, public.period_status, text),
  public.save_draft_entry(uuid, uuid, date, public.entry_type, text, text, text, text, jsonb),
  public.submit_entry(uuid),
  public.return_entry(uuid, text),
  public.approve_and_post(uuid),
  public.void_entry(uuid, text),
  public.reverse_entry(uuid, date, text, text),
  public.trial_balance(uuid, date),
  public.general_ledger(uuid, uuid, date, date),
  public.purge_synthetic_client(uuid)
from public, anon;

grant execute on function
  public.create_account(uuid, text, text, public.account_type, public.normal_balance, text, boolean),
  public.update_account(uuid, text, boolean),
  public.apply_coa_template(uuid, text),
  public.create_fiscal_year(uuid, date, integer),
  public.set_period_status(uuid, public.period_status, text),
  public.save_draft_entry(uuid, uuid, date, public.entry_type, text, text, text, text, jsonb),
  public.submit_entry(uuid),
  public.return_entry(uuid, text),
  public.approve_and_post(uuid),
  public.void_entry(uuid, text),
  public.reverse_entry(uuid, date, text, text),
  public.trial_balance(uuid, date),
  public.general_ledger(uuid, uuid, date, date)
to authenticated;

revoke execute on function public.purge_synthetic_client(uuid) from authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;
