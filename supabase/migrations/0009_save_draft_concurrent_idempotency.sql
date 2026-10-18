-- Concurrency-safe idempotency for save_draft_entry: two simultaneous requests
-- with the same key now both receive the same entry (atomic insert-or-return)
-- instead of one receiving a unique-violation error. Duplicates were already
-- impossible (unique key); this makes replays return success under races.
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
    insert into public.journal_lines (client_id, entry_id, line_no, account_id, debit, credit, description)
    values (p_client_id, v_id, v_no, (v_line ->> 'account_id')::uuid,
            private.parse_amount(v_line ->> 'debit'), private.parse_amount(v_line ->> 'credit'),
            nullif(left(trim(coalesce(v_line ->> 'description', '')), 300), ''));
  end loop;
  return v_id;
end;
$$;
