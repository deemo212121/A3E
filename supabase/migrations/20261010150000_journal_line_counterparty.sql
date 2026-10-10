-- Optional per-line supplier/customer and source document number.
--
-- Why: the Firm's books (cash disbursement and cash receipts journals) record,
-- for every row, the counterparty's name and TIN and the receipt/invoice
-- number. Later registers (purchases, sales) group by these. Capturing them on
-- the line now avoids reshaping posted data later.
--
-- These columns are RECORDING fields only. Nothing here computes or validates
-- any tax. The TIN check is a format sanity check (9-digit TIN plus an optional
-- 3-5 digit branch code, as written in the Firm's own books); it does not
-- verify that a TIN is registered.
--
-- Immutability is inherited: journal_line_guard already rejects any change to
-- lines of a non-draft entry, so these fields freeze on posting.

alter table public.journal_lines
  add column counterparty_name text check (char_length(counterparty_name) between 1 and 200),
  add column counterparty_tin  text check (counterparty_tin ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}(-[0-9]{3,5})?$'),
  add column document_ref      text check (char_length(document_ref) between 1 and 100),
  add constraint journal_lines_tin_needs_name
    check (counterparty_tin is null or counterparty_name is not null);

create index journal_lines_counterparty_tin_idx
  on public.journal_lines (client_id, counterparty_tin) where counterparty_tin is not null;

-- Accepts "004984946000", "004-984-946-000", "004 984 946 00000" and similar.
-- Returns the canonical dashed form, or NULL for blank input.
create function private.normalize_tin(p_text text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_digits text := regexp_replace(coalesce(p_text, ''), '[\s-]', '', 'g');
begin
  if v_digits = '' then
    return null;
  end if;
  if v_digits !~ '^[0-9]{9}([0-9]{3,5})?$' then
    raise exception 'invalid TIN "%": use 9 digits plus an optional 3-5 digit branch code', left(p_text, 30)
      using errcode = '22023';
  end if;
  return substr(v_digits, 1, 3) || '-' || substr(v_digits, 4, 3) || '-' || substr(v_digits, 7, 3)
    || case when length(v_digits) > 9 then '-' || substr(v_digits, 10) else '' end;
end;
$$;
revoke execute on function private.normalize_tin(text) from public, anon, authenticated;

-- save_draft_entry: identical to 20261010140400 except the line insert, which
-- now also stores counterparty_name, counterparty_tin and document_ref.
create or replace function public.save_draft_entry(
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
  v_name text;
  v_tin text;
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
    on conflict (client_id, idempotency_key) do nothing
    returning id into v_id;
    if v_id is null then
      -- A concurrent request with the same key won the race: return its entry.
      select id into v_id from public.journal_entries
       where client_id = p_client_id and idempotency_key = p_idempotency_key;
      return v_id;
    end if;
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
    v_name := nullif(left(trim(coalesce(v_line ->> 'counterparty_name', '')), 200), '');
    v_tin := private.normalize_tin(v_line ->> 'counterparty_tin');
    if v_tin is not null and v_name is null then
      raise exception 'line %: enter the supplier/customer name for TIN %', v_no, v_tin
        using errcode = '22023';
    end if;
    insert into public.journal_lines
      (client_id, entry_id, line_no, account_id, debit, credit, description,
       counterparty_name, counterparty_tin, document_ref)
    values (p_client_id, v_id, v_no, (v_line ->> 'account_id')::uuid,
            private.parse_amount(v_line ->> 'debit'), private.parse_amount(v_line ->> 'credit'),
            nullif(left(trim(coalesce(v_line ->> 'description', '')), 300), ''),
            v_name, v_tin,
            nullif(left(trim(coalesce(v_line ->> 'document_ref', '')), 100), ''));
  end loop;
  return v_id;
end;
$$;

-- reverse_entry: identical to 20261010140100 except the reversal lines now
-- carry the original lines' counterparty and document fields.
create or replace function public.reverse_entry(
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

  insert into public.journal_lines
    (client_id, entry_id, line_no, account_id, debit, credit, description,
     counterparty_name, counterparty_tin, document_ref)
  select client_id, v_rev, line_no, account_id, credit, debit, description,
         counterparty_name, counterparty_tin, document_ref
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

-- general_ledger: same as 20261010140700 plus the line's counterparty and
-- document number, so the ledger shows "who" and "which receipt".
drop function public.general_ledger(uuid, uuid, date, date);

create function public.general_ledger(p_client_id uuid, p_account_id uuid, p_from date, p_to date)
returns table (
  entry_id uuid, entry_no integer, entry_date date, entry_type public.entry_type, memo text,
  line_no smallint, description text, counterparty_name text, counterparty_tin text,
  document_ref text, debit text, credit text, running_balance text
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
           l.counterparty_name, l.counterparty_tin, l.document_ref, l.debit, l.credit,
           case when acct.normal_balance = 'debit' then l.debit - l.credit
                else l.credit - l.debit end as delta
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      cross join acct
     where l.client_id = p_client_id and l.account_id = p_account_id
       and e.status in ('posted', 'reversed') and e.entry_date between p_from and p_to
  )
  select r.id, r.entry_no, r.entry_date, r.entry_type, r.memo, r.line_no, r.description,
         r.counterparty_name, r.counterparty_tin, r.document_ref,
         r.debit::text, r.credit::text,
         ((select bal from opening)
           + sum(r.delta) over (order by r.entry_date, r.entry_no, r.line_no
                                rows between unbounded preceding and current row))::numeric(18, 2)::text
    from rows r
   order by r.entry_date, r.entry_no, r.line_no;
$$;

revoke execute on function public.general_ledger(uuid, uuid, date, date) from public, anon;
grant execute on function public.general_ledger(uuid, uuid, date, date) to authenticated;
