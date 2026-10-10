-- Phase 6: CSV/XLSX import staging.
--
-- Flow: the server parses an uploaded file (stored as a document) ->
-- create_import_batch stores the raw rows -> the user maps columns; the server
-- converts each row to the canonical shape and save_import_mapping stores the
-- result and runs DUPLICATE DETECTION here, in the database -> the user reviews
-- the preview -> commit_import_batch creates SUBMITTED records (never posted).
--
-- Retry safety: commit locks the batch and is a no-op once committed; every
-- created record also carries the key "import:<batch>:<row>", so a row can
-- never be created twice.

create table public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  document_id     uuid not null,
  target          text not null check (target in ('transactions', 'counterparties')),
  file_type       text not null check (file_type in ('csv', 'xlsx')),
  sheet_name      text check (char_length(sheet_name) <= 100),
  headers         text[] not null check (cardinality(headers) between 1 and 100),
  row_count       integer not null check (row_count between 1 and 5000),
  mapping         jsonb check (mapping is null or jsonb_typeof(mapping) = 'object'),
  options         jsonb check (options is null or jsonb_typeof(options) = 'object'),
  status          text not null default 'uploaded' check (status in ('uploaded', 'mapped', 'committed', 'cancelled')),
  summary         jsonb,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  mapped_at       timestamptz,
  committed_by    uuid references public.profiles (id) on delete set null,
  committed_at    timestamptz,
  foreign key (client_id, document_id) references public.documents (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check ((status = 'committed') = (committed_at is not null))
);
create index import_batches_client_idx on public.import_batches (client_id, created_at desc);

create table public.import_rows (
  client_id      uuid not null,
  batch_id       uuid not null,
  row_no         integer not null check (row_no >= 1),
  raw            jsonb not null check (jsonb_typeof(raw) = 'array'),
  normalized     jsonb check (normalized is null or jsonb_typeof(normalized) = 'object'),
  errors         jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  outcome        text not null default 'pending'
                   check (outcome in ('pending', 'valid', 'invalid', 'duplicate', 'possible_duplicate', 'imported', 'skipped')),
  duplicate_note text,
  created_id     uuid,
  primary key (batch_id, row_no),
  foreign key (client_id, batch_id) references public.import_batches (client_id, id) on delete cascade
);

alter table public.intake_transactions
  add foreign key (client_id, import_batch_id) references public.import_batches (client_id, id);
alter table public.counterparties
  add foreign key (client_id, import_batch_id) references public.import_batches (client_id, id);

-- import_rows are staging data: audited at batch level (events), not per row.
create trigger audit_import_batches after insert or update or delete on public.import_batches
  for each row execute function audit.log_change();

revoke all on table public.import_batches, public.import_rows from public, anon, authenticated;
grant select on table public.import_batches, public.import_rows to authenticated;
alter table public.import_batches enable row level security;
alter table public.import_batches force row level security;
alter table public.import_rows enable row level security;
alter table public.import_rows force row level security;
create policy import_batches_select on public.import_batches for select to authenticated
  using (private.can_read_client(client_id));
create policy import_rows_select on public.import_rows for select to authenticated
  using (private.can_read_client(client_id));

-- Comments may now also be attached to import batches.
create or replace function private.intake_subject_client(p_subject public.intake_subject, p_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case p_subject
    when 'business_profile' then (select client_id from public.business_profiles where id = p_id)
    when 'counterparty' then (select client_id from public.counterparties where id = p_id)
    when 'transaction' then (select client_id from public.intake_transactions where id = p_id)
    when 'document' then (select client_id from public.documents where id = p_id)
    when 'import_batch' then (select client_id from public.import_batches where id = p_id)
  end;
$$;

-- ---------------------------------------------------------------------------
-- p_row_numbers: the rows' numbers in the original sheet (so errors point to
-- the row the user sees in Excel); defaults to 1..n.
create function public.create_import_batch(
  p_client_id uuid, p_idempotency_key text, p_document_id uuid, p_target text, p_file_type text,
  p_sheet_name text, p_headers text[], p_rows jsonb, p_row_numbers integer[] default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_id uuid;
  v_count integer;
begin
  if not private.can_submit_intake(p_client_id) then
    raise exception 'not allowed to import data for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select id into v_id from public.import_batches where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    return v_id;
  end if;
  if not exists (select 1 from public.documents d
                  where d.client_id = p_client_id and d.id = p_document_id and d.upload_state = 'complete'
                    and d.deleted_at is null and d.category = 'import_source') then
    raise exception 'the import file was not found' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count = 0 then
    raise exception 'the file has no data rows' using errcode = '22023';
  end if;
  if v_count > 5000 then
    raise exception 'the file has % rows; import at most 5000 rows at a time', v_count using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'array') then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  if p_row_numbers is not null and (
       cardinality(p_row_numbers) <> v_count
       or exists (select 1 from unnest(p_row_numbers) with ordinality n(v, i)
                   where n.v is null or n.v < 1
                      or n.v <= coalesce((p_row_numbers)[n.i - 1], 0))) then
    raise exception 'row numbers must be increasing and match the rows' using errcode = '22023';
  end if;
  insert into public.import_batches
    (client_id, document_id, target, file_type, sheet_name, headers, row_count, idempotency_key)
  values (p_client_id, p_document_id, p_target, p_file_type, nullif(btrim(p_sheet_name), ''), p_headers,
          v_count, p_idempotency_key)
  on conflict (client_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.import_batches where client_id = p_client_id and idempotency_key = p_idempotency_key;
    return v_id;
  end if;
  insert into public.import_rows (client_id, batch_id, row_no, raw)
  select p_client_id, v_id, coalesce((p_row_numbers)[r.ordinality], r.ordinality::integer), r.value
    from jsonb_array_elements(p_rows) with ordinality r;
  perform private.record_intake_event(p_client_id, 'import_batch', v_id, null, 'uploaded', null);
  return v_id;
end;
$$;

-- Stores the server's row conversion results and detects duplicates.
-- p_results: [{ "row_no": n, "normalized": {...} | null, "errors": [{field, message}] }]
create function public.save_import_mapping(
  p_batch_id uuid, p_mapping jsonb, p_options jsonb, p_results jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_b public.import_batches;
  v_summary jsonb;
begin
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if not found or not private.can_read_client(v_b.client_id) then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if not private.can_submit_intake(v_b.client_id) then
    raise exception 'not allowed to import data for this client' using errcode = '42501';
  end if;
  if v_b.status not in ('uploaded', 'mapped') then
    raise exception 'this import was already %', v_b.status using errcode = '22023';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) <> v_b.row_count then
    raise exception 'results must cover all % rows', v_b.row_count using errcode = '22023';
  end if;

  update public.import_rows set outcome = 'pending', normalized = null, errors = '[]'::jsonb
   where batch_id = p_batch_id;
  update public.import_rows r
     set normalized = x.normalized,
         errors = coalesce(x.errors, '[]'::jsonb),
         outcome = case when x.normalized is null or jsonb_array_length(coalesce(x.errors, '[]'::jsonb)) > 0
                        then 'invalid' else 'valid' end,
         duplicate_note = null
    from jsonb_to_recordset(p_results) as x(row_no integer, normalized jsonb, errors jsonb)
   where r.batch_id = p_batch_id and r.row_no = x.row_no;
  if exists (select 1 from public.import_rows where batch_id = p_batch_id
               and outcome = 'pending') then
    raise exception 'results must cover every row of the import' using errcode = '22023';
  end if;

  if v_b.target = 'transactions' then
    -- Hard duplicate: same kind + document number + customer/supplier already recorded.
    update public.import_rows r
       set outcome = 'duplicate', duplicate_note = 'already recorded'
      from public.intake_transactions t
     where r.batch_id = p_batch_id and r.outcome = 'valid'
       and nullif(btrim(r.normalized ->> 'document_ref'), '') is not null
       and t.client_id = v_b.client_id and t.status not in ('rejected', 'cancelled')
       and t.document_ref is not null
       and t.kind::text = r.normalized ->> 'kind'
       and lower(t.document_ref) = lower(btrim(r.normalized ->> 'document_ref'))
       and t.party_key = coalesce(private.try_normalize_tin(r.normalized ->> 'counterparty_tin'),
                                  private.name_key(r.normalized ->> 'counterparty_name'));
    -- Hard duplicate inside the file: a later row repeating an earlier one.
    with keyed as (
      select row_no, normalized ->> 'kind' as k, lower(btrim(normalized ->> 'document_ref')) as d,
             coalesce(private.try_normalize_tin(normalized ->> 'counterparty_tin'),
                      private.name_key(normalized ->> 'counterparty_name')) as p
        from public.import_rows
       where batch_id = p_batch_id and outcome = 'valid'
         and nullif(btrim(normalized ->> 'document_ref'), '') is not null
    ), ranked as (
      select row_no, min(row_no) over (partition by k, d, p) as first_row from keyed where p is not null
    )
    update public.import_rows r
       set outcome = 'duplicate', duplicate_note = 'same as row ' || ranked.first_row
      from ranked
     where r.batch_id = p_batch_id and r.row_no = ranked.row_no and ranked.first_row <> ranked.row_no;
    -- Possible duplicate (no document number): same kind, date, amount and party.
    update public.import_rows r
       set outcome = 'possible_duplicate', duplicate_note = 'same date, amount and customer/supplier already recorded'
      from public.intake_transactions t
     where r.batch_id = p_batch_id and r.outcome = 'valid'
       and nullif(btrim(r.normalized ->> 'document_ref'), '') is null
       and t.client_id = v_b.client_id and t.status not in ('rejected', 'cancelled')
       and t.kind::text = r.normalized ->> 'kind'
       and t.txn_date::text = r.normalized ->> 'txn_date'
       and t.gross_amount::text = r.normalized ->> 'gross_amount'
       and t.party_key is not distinct from coalesce(private.try_normalize_tin(r.normalized ->> 'counterparty_tin'),
                                                     private.name_key(r.normalized ->> 'counterparty_name'));
    with keyed as (
      select row_no, normalized ->> 'kind' as k, normalized ->> 'txn_date' as dt,
             normalized ->> 'gross_amount' as amt,
             coalesce(private.try_normalize_tin(normalized ->> 'counterparty_tin'),
                      private.name_key(normalized ->> 'counterparty_name')) as p
        from public.import_rows
       where batch_id = p_batch_id and outcome = 'valid'
         and nullif(btrim(normalized ->> 'document_ref'), '') is null
    ), ranked as (
      select row_no, min(row_no) over (partition by k, dt, amt, p) as first_row from keyed
    )
    update public.import_rows r
       set outcome = 'possible_duplicate', duplicate_note = 'same date, amount and party as row ' || ranked.first_row
      from ranked
     where r.batch_id = p_batch_id and r.row_no = ranked.row_no and ranked.first_row <> ranked.row_no;
  else
    update public.import_rows r
       set outcome = 'duplicate', duplicate_note = 'already recorded'
      from public.counterparties c
     where r.batch_id = p_batch_id and r.outcome = 'valid'
       and c.client_id = v_b.client_id and c.status not in ('rejected', 'cancelled')
       and ((c.tin is not null and c.tin = private.try_normalize_tin(r.normalized ->> 'tin'))
            or (c.tin is null and private.try_normalize_tin(r.normalized ->> 'tin') is null
                and c.name_key = private.name_key(r.normalized ->> 'registered_name')));
    with keyed as (
      select row_no,
             coalesce(private.try_normalize_tin(normalized ->> 'tin'),
                      'name:' || private.name_key(normalized ->> 'registered_name')) as p
        from public.import_rows where batch_id = p_batch_id and outcome = 'valid'
    ), ranked as (
      select row_no, min(row_no) over (partition by p) as first_row from keyed where p is not null
    )
    update public.import_rows r
       set outcome = 'duplicate', duplicate_note = 'same as row ' || ranked.first_row
      from ranked
     where r.batch_id = p_batch_id and r.row_no = ranked.row_no and ranked.first_row <> ranked.row_no;
  end if;

  select jsonb_build_object(
      'total', count(*),
      'valid', count(*) filter (where outcome = 'valid'),
      'invalid', count(*) filter (where outcome = 'invalid'),
      'duplicate', count(*) filter (where outcome = 'duplicate'),
      'possible_duplicate', count(*) filter (where outcome = 'possible_duplicate'))
    into v_summary
    from public.import_rows where batch_id = p_batch_id;
  update public.import_batches
     set mapping = p_mapping, options = p_options, status = 'mapped', summary = v_summary, mapped_at = now()
   where id = p_batch_id;
  if v_b.status = 'uploaded' then
    perform private.record_intake_event(v_b.client_id, 'import_batch', p_batch_id, 'uploaded', 'mapped', null);
  end if;
  return v_summary;
end;
$$;

-- Creates one SUBMITTED record per valid row. Safe to retry and to call
-- concurrently: the batch row lock serializes callers, and a committed batch
-- simply returns its summary.
create function public.commit_import_batch(p_batch_id uuid, p_include_possible_duplicates boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_b public.import_batches;
  v_row public.import_rows;
  v_clean jsonb;
  v_id uuid;
  v_key text;
  v_summary jsonb;
begin
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if not found or not private.can_read_client(v_b.client_id) then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if not private.can_submit_intake(v_b.client_id) then
    raise exception 'not allowed to import data for this client' using errcode = '42501';
  end if;
  if v_b.status = 'committed' then
    return v_b.summary;
  end if;
  if v_b.status <> 'mapped' then
    raise exception 'map the columns and review the preview before importing' using errcode = '22023';
  end if;

  for v_row in
    select * from public.import_rows
     where batch_id = p_batch_id
       and (outcome = 'valid' or (p_include_possible_duplicates and outcome = 'possible_duplicate'))
     order by row_no
  loop
    v_key := format('import:%s:%s', p_batch_id, v_row.row_no);
    begin
      if v_b.target = 'transactions' then
        v_clean := private.clean_txn_header(v_b.client_id, v_row.normalized);
        v_id := private.insert_intake_transaction(v_b.client_id, v_clean, '[]'::jsonb, null, v_key,
          'import', p_batch_id, v_row.row_no);
        perform private.assert_txn_complete(v_id);
        update public.intake_transactions
           set status = 'submitted', submitted_by = v_uid, submitted_at = now(), row_version = row_version + 1
         where id = v_id and status = 'draft';
        perform private.record_intake_event(v_b.client_id, 'transaction', v_id, 'draft', 'submitted',
          format('Imported (row %s)', v_row.row_no));
      else
        v_clean := private.clean_counterparty_fields(v_row.normalized);
        v_id := private.insert_counterparty(v_b.client_id, v_clean, v_key, 'import', p_batch_id);
        update public.counterparties
           set status = 'submitted', submitted_by = v_uid, submitted_at = now(), row_version = row_version + 1
         where id = v_id and status = 'draft';
        perform private.record_intake_event(v_b.client_id, 'counterparty', v_id, 'draft', 'submitted',
          format('Imported (row %s)', v_row.row_no));
      end if;
      update public.import_rows set outcome = 'imported', created_id = v_id
       where batch_id = p_batch_id and row_no = v_row.row_no;
    exception
      when unique_violation then
        update public.import_rows set outcome = 'duplicate', duplicate_note = 'already recorded'
         where batch_id = p_batch_id and row_no = v_row.row_no;
      when sqlstate '22023' or sqlstate '23514' or sqlstate '22P02' or sqlstate '22007' or sqlstate '22008' then
        update public.import_rows
           set outcome = 'invalid',
               errors = jsonb_build_array(jsonb_build_object('field', 'row', 'message',
                          case when sqlstate = '22023' then sqlerrm else 'a value is not valid' end))
         where batch_id = p_batch_id and row_no = v_row.row_no;
    end;
  end loop;

  update public.import_rows set outcome = 'skipped'
   where batch_id = p_batch_id and outcome in ('valid', 'possible_duplicate');

  select jsonb_build_object(
      'total', count(*),
      'imported', count(*) filter (where outcome = 'imported'),
      'invalid', count(*) filter (where outcome = 'invalid'),
      'duplicate', count(*) filter (where outcome = 'duplicate'),
      'skipped', count(*) filter (where outcome = 'skipped'))
    into v_summary
    from public.import_rows where batch_id = p_batch_id;
  update public.import_batches
     set status = 'committed', summary = v_summary, committed_by = v_uid, committed_at = now()
   where id = p_batch_id;
  perform private.record_intake_event(v_b.client_id, 'import_batch', p_batch_id, 'mapped', 'committed',
    format('%s imported, %s duplicates, %s invalid, %s skipped', v_summary ->> 'imported',
           v_summary ->> 'duplicate', v_summary ->> 'invalid', v_summary ->> 'skipped'));
  return v_summary;
end;
$$;

create function public.cancel_import_batch(p_batch_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_b public.import_batches;
begin
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if not found or not private.can_read_client(v_b.client_id) then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if not private.can_submit_intake(v_b.client_id) then
    raise exception 'not allowed to import data for this client' using errcode = '42501';
  end if;
  if v_b.status = 'cancelled' then
    return;
  end if;
  if v_b.status = 'committed' then
    raise exception 'a committed import cannot be cancelled; cancel or reject its records instead'
      using errcode = '22023';
  end if;
  update public.import_batches set status = 'cancelled' where id = p_batch_id;
  perform private.record_intake_event(v_b.client_id, 'import_batch', p_batch_id, v_b.status, 'cancelled', null);
end;
$$;

-- Staff convenience: approve many submitted customers/suppliers at once
-- (e.g. a supplier list import). Each one goes through the normal transition.
create function public.approve_counterparties(p_client_id uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_id uuid;
  v_n integer := 0;
begin
  if not private.can_review_intake(p_client_id) then
    raise exception 'only assigned firm staff can approve customers and suppliers' using errcode = '42501';
  end if;
  if cardinality(p_ids) > 5000 then
    raise exception 'too many records' using errcode = '22023';
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    if exists (select 1 from public.counterparties where id = v_id and client_id = p_client_id and status = 'submitted') then
      perform public.transition_counterparty(v_id, 'approved', null);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke execute on all functions in schema private from public, anon;
revoke execute on function
  public.create_import_batch(uuid, text, uuid, text, text, text, text[], jsonb, integer[]),
  public.save_import_mapping(uuid, jsonb, jsonb, jsonb),
  public.commit_import_batch(uuid, boolean),
  public.cancel_import_batch(uuid),
  public.approve_counterparties(uuid, uuid[])
from public, anon;
grant execute on function
  public.create_import_batch(uuid, text, uuid, text, text, text, text[], jsonb, integer[]),
  public.save_import_mapping(uuid, jsonb, jsonb, jsonb),
  public.commit_import_batch(uuid, boolean),
  public.cancel_import_batch(uuid),
  public.approve_counterparties(uuid, uuid[])
to authenticated;
