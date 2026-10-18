-- Fixes reported by `supabase db lint` (plpgsql_check) on the Phase 6
-- functions. Behaviour is unchanged:
--   * clean_profile_fields / clean_counterparty_fields: STABLE, not IMMUTABLE
--     (jsonb_build_object is STABLE);
--   * typed empty arrays in the completeness checks;
--   * the session check is a PERFORM instead of an unused variable.
-- Generated from 0016 / 0017 with only these edits.

create or replace function private.clean_profile_fields(p_fields jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
  v_month text := nullif(btrim(f ->> 'fiscal_year_end_month'), '');
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception 'invalid profile data' using errcode = '22023';
  end if;
  if v_month is not null and v_month !~ '^([1-9]|1[0-2])$' then
    raise exception 'fiscal year end month must be 1 to 12' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'registered_name', nullif(btrim(f ->> 'registered_name'), ''),
    'trade_name', nullif(btrim(f ->> 'trade_name'), ''),
    'tin', private.normalize_tin(f ->> 'tin'),
    'rdo_code', nullif(upper(btrim(f ->> 'rdo_code')), ''),
    'business_type', nullif(btrim(f ->> 'business_type'), ''),
    'vat_status', nullif(btrim(f ->> 'vat_status'), ''),
    'registered_address', nullif(btrim(f ->> 'registered_address'), ''),
    'zip_code', nullif(btrim(f ->> 'zip_code'), ''),
    'line_of_business', nullif(btrim(f ->> 'line_of_business'), ''),
    'fiscal_year_end_month', v_month::smallint,
    'contact_email', nullif(lower(btrim(f ->> 'contact_email')), ''),
    'contact_phone', nullif(btrim(f ->> 'contact_phone'), ''),
    'notes', nullif(btrim(f ->> 'notes'), ''));
end;
$$;

create or replace function private.clean_counterparty_fields(p_fields jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception 'invalid customer/supplier data' using errcode = '22023';
  end if;
  if nullif(btrim(f ->> 'registered_name'), '') is null then
    raise exception 'enter the customer/supplier name' using errcode = '22023';
  end if;
  if nullif(btrim(f ->> 'kind'), '') is null then
    raise exception 'choose customer, supplier or both' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'kind', btrim(f ->> 'kind'),
    'registered_name', btrim(f ->> 'registered_name'),
    'tin', private.normalize_tin(f ->> 'tin'),
    'vat_status', coalesce(nullif(btrim(f ->> 'vat_status'), ''), 'unknown'),
    'address', nullif(btrim(f ->> 'address'), ''),
    'email', nullif(lower(btrim(f ->> 'email')), ''),
    'phone', nullif(btrim(f ->> 'phone'), ''));
end;
$$;

create or replace function private.assert_profile_complete(p_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.business_profiles;
  v_missing text[] := '{}'::text[];
begin
  select * into p from public.business_profiles where id = p_id;
  if p.registered_name is null then v_missing := v_missing || 'registered name'::text; end if;
  if p.tin is null then v_missing := v_missing || 'TIN'::text; end if;
  if p.business_type is null then v_missing := v_missing || 'business type'::text; end if;
  if p.vat_status is null then v_missing := v_missing || 'VAT registration (as declared)'::text; end if;
  if p.registered_address is null then v_missing := v_missing || 'registered address'::text; end if;
  if p.zip_code is null then v_missing := v_missing || 'ZIP code'::text; end if;
  if p.line_of_business is null then v_missing := v_missing || 'line of business'::text; end if;
  if p.fiscal_year_end_month is null then v_missing := v_missing || 'fiscal year end month'::text; end if;
  if cardinality(v_missing) > 0 then
    raise exception 'complete these fields before submitting: %', array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;
end;
$$;

create or replace function private.assert_txn_complete(p_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.intake_transactions;
  v_missing text[] := '{}'::text[];
  v_lines integer;
  v_sum numeric;
begin
  select * into t from public.intake_transactions where id = p_id;
  if t.txn_date is null then v_missing := v_missing || 'date'::text; end if;
  if t.gross_amount is null then v_missing := v_missing || 'total amount'::text; end if;
  if t.kind in ('sale', 'purchase', 'expense', 'collection', 'payment') and t.counterparty_name is null then
    v_missing := v_missing || 'customer/supplier name'::text;
  end if;
  if t.kind in ('sale', 'purchase') and t.document_ref is null then
    v_missing := v_missing || 'invoice/receipt number'::text;
  end if;
  if t.kind in ('payroll', 'inventory', 'other') and t.description is null then
    v_missing := v_missing || 'description'::text;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception 'complete these fields before submitting: %', array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;
  if t.txn_date > private.today_ph() then
    raise exception 'the date cannot be in the future' using errcode = '22023';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_lines, v_sum
    from public.intake_transaction_lines where transaction_id = p_id;
  if v_lines = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  if v_sum <> t.gross_amount then
    raise exception 'the lines add up to % but the total is %', v_sum, t.gross_amount using errcode = '22023';
  end if;
end;
$$;

create or replace function public.log_document_access(p_document_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid;
begin
  perform private.require_active_user();
  select client_id into v_client from public.documents
   where id = p_document_id and deleted_at is null and upload_state = 'complete';
  if v_client is null or not private.can_read_client(v_client) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  perform audit.log_event('document.downloaded', v_client, jsonb_build_object('document_id', p_document_id));
end;
$$;

create or replace function public.save_business_profile(
  p_client_id uuid, p_profile_id uuid, p_expected_version integer, p_fields jsonb, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_clean jsonb;
  v_p public.business_profiles;
  v_id uuid;
  v_open integer;
begin
  perform private.require_active_user();
  if not private.can_propose_profile(p_client_id) then
    raise exception 'not allowed to change this business profile' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  v_clean := private.clean_profile_fields(p_fields);

  if p_profile_id is null then
    select id into v_id from public.business_profiles
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
    select version into v_open from public.business_profiles
     where client_id = p_client_id and status in ('draft', 'submitted', 'needs_correction');
    if found then
      raise exception 'a profile change is already in progress (version %); continue with that one', v_open
        using errcode = '23505';
    end if;
    begin
      insert into public.business_profiles
        (client_id, version, registered_name, trade_name, tin, rdo_code, business_type, vat_status,
         registered_address, zip_code, line_of_business, fiscal_year_end_month, contact_email,
         contact_phone, notes, idempotency_key)
      select p_client_id,
             coalesce((select max(version) from public.business_profiles where client_id = p_client_id), 0) + 1,
             r.registered_name, r.trade_name, r.tin, r.rdo_code, r.business_type, r.vat_status,
             r.registered_address, r.zip_code, r.line_of_business, r.fiscal_year_end_month,
             r.contact_email, r.contact_phone, r.notes, p_idempotency_key
        from jsonb_populate_record(null::public.business_profiles, v_clean) r
      returning id into v_id;
    exception when unique_violation then
      select id into v_id from public.business_profiles
       where client_id = p_client_id and idempotency_key = p_idempotency_key;
      if found then
        return v_id;
      end if;
      raise exception 'another profile change was started at the same time; reload the page'
        using errcode = '23505';
    end;
    perform private.record_intake_event(p_client_id, 'business_profile', v_id, null, 'draft', null);
    return v_id;
  end if;

  select * into v_p from public.business_profiles where id = p_profile_id for update;
  if not found or v_p.client_id <> p_client_id then
    raise exception 'business profile not found' using errcode = 'P0002';
  end if;
  if v_p.status not in ('draft', 'needs_correction') then
    raise exception 'only a draft or returned profile can be edited' using errcode = '22023';
  end if;
  if p_expected_version is distinct from v_p.row_version then
    raise exception 'this profile was changed by someone else; reload the page and try again'
      using errcode = '40001';
  end if;
  update public.business_profiles b
     set (registered_name, trade_name, tin, rdo_code, business_type, vat_status, registered_address,
          zip_code, line_of_business, fiscal_year_end_month, contact_email, contact_phone, notes) =
         (select r.registered_name, r.trade_name, r.tin, r.rdo_code, r.business_type, r.vat_status,
                 r.registered_address, r.zip_code, r.line_of_business, r.fiscal_year_end_month,
                 r.contact_email, r.contact_phone, r.notes
            from jsonb_populate_record(null::public.business_profiles, v_clean) r),
         row_version = b.row_version + 1
   where b.id = p_profile_id;
  return p_profile_id;
end;
$$;

create or replace function public.save_counterparty(
  p_client_id uuid, p_counterparty_id uuid, p_expected_version integer, p_fields jsonb, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_clean jsonb;
  v_c public.counterparties;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_submit_intake(p_client_id) then
    raise exception 'not allowed to maintain customers and suppliers for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  v_clean := private.clean_counterparty_fields(p_fields);
  if p_counterparty_id is null then
    select id into v_id from public.counterparties
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
    return private.insert_counterparty(p_client_id, v_clean, p_idempotency_key,
      case when private.is_assigned(p_client_id) then 'staff' else 'portal' end, null);
  end if;

  select * into v_c from public.counterparties where id = p_counterparty_id for update;
  if not found or v_c.client_id <> p_client_id then
    raise exception 'customer/supplier not found' using errcode = 'P0002';
  end if;
  -- Approved master data may be corrected by firm staff only (audited).
  if v_c.status not in ('draft', 'needs_correction')
     and not (v_c.status = 'approved' and private.can_review_intake(p_client_id)) then
    raise exception 'this customer/supplier can no longer be edited here' using errcode = '22023';
  end if;
  if p_expected_version is distinct from v_c.row_version then
    raise exception 'this record was changed by someone else; reload the page and try again'
      using errcode = '40001';
  end if;
  begin
    update public.counterparties c
       set (kind, registered_name, tin, vat_status, address, email, phone) =
           (select r.kind, r.registered_name, r.tin, r.vat_status, r.address, r.email, r.phone
              from jsonb_populate_record(null::public.counterparties, v_clean) r),
           row_version = c.row_version + 1
     where c.id = p_counterparty_id;
  exception when unique_violation then
    raise exception '%', private.counterparty_duplicate_message(p_client_id, v_clean) using errcode = '23505';
  end;
  return p_counterparty_id;
end;
$$;

create or replace function public.save_intake_transaction(
  p_client_id uuid, p_transaction_id uuid, p_expected_version integer,
  p_header jsonb, p_lines jsonb, p_document_ids uuid[], p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_clean jsonb;
  v_t public.intake_transactions;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_submit_intake(p_client_id) then
    raise exception 'not allowed to record transactions for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_transaction_id is null then
    select id into v_id from public.intake_transactions
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  v_clean := private.clean_txn_header(p_client_id, p_header);
  if v_clean ->> 'kind' is null then
    raise exception 'choose the transaction type' using errcode = '22023';
  end if;

  if p_transaction_id is null then
    return private.insert_intake_transaction(p_client_id, v_clean, p_lines, p_document_ids,
      p_idempotency_key, case when private.is_assigned(p_client_id) then 'staff' else 'portal' end,
      null, null);
  end if;

  select * into v_t from public.intake_transactions where id = p_transaction_id for update;
  if not found or v_t.client_id <> p_client_id then
    raise exception 'transaction not found' using errcode = 'P0002';
  end if;
  if v_t.status not in ('draft', 'needs_correction') then
    raise exception 'only draft or returned transactions can be edited' using errcode = '22023';
  end if;
  if p_expected_version is distinct from v_t.row_version then
    raise exception 'this transaction was changed by someone else; reload the page and try again'
      using errcode = '40001';
  end if;
  begin
    update public.intake_transactions t
       set (kind, txn_date, document_type, document_ref, counterparty_id, counterparty_name,
            counterparty_tin, description, gross_amount, vat_amount_stated, withholding_amount_stated,
            payment_method, attributes) =
           (select r.kind, r.txn_date, r.document_type, r.document_ref, r.counterparty_id,
                   r.counterparty_name, r.counterparty_tin, r.description, r.gross_amount,
                   r.vat_amount_stated, r.withholding_amount_stated, r.payment_method, r.attributes
              from jsonb_populate_record(null::public.intake_transactions, v_clean) r),
           row_version = t.row_version + 1
     where t.id = p_transaction_id;
  exception when unique_violation then
    raise exception '%', private.txn_duplicate_message(v_clean) using errcode = '23505';
  end;
  perform private.replace_txn_lines(p_client_id, p_transaction_id, p_lines);
  perform private.replace_txn_documents(p_client_id, p_transaction_id, p_document_ids);
  return p_transaction_id;
end;
$$;

create or replace function public.add_intake_comment(
  p_client_id uuid, p_subject public.intake_subject, p_subject_id uuid, p_body text,
  p_visibility text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_staff boolean := private.is_assigned(p_client_id);
begin
  perform private.require_active_user();
  perform private.require_key(p_idempotency_key);
  if private.intake_subject_client(p_subject, p_subject_id) is distinct from p_client_id
     or not private.can_read_client(p_client_id) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if not v_staff and not private.can_submit_intake(p_client_id) then
    raise exception 'you can view this record but not comment on it' using errcode = '42501';
  end if;
  if coalesce(p_visibility, 'client') not in ('client', 'internal') then
    raise exception 'invalid visibility' using errcode = '22023';
  end if;
  if p_visibility = 'internal' and not v_staff then
    raise exception 'only firm staff can write internal notes' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'write a comment of 1 to 2000 characters' using errcode = '22023';
  end if;
  insert into public.intake_comments (client_id, subject_type, subject_id, body, visibility, idempotency_key)
  values (p_client_id, p_subject, p_subject_id, btrim(p_body), coalesce(p_visibility, 'client'), p_idempotency_key)
  on conflict (client_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.intake_comments where client_id = p_client_id and idempotency_key = p_idempotency_key;
    return v_id;
  end if;
  perform audit.log_event('intake.comment', p_client_id,
    jsonb_build_object('id', v_id, 'subject', p_subject, 'subject_id', p_subject_id, 'visibility', p_visibility));
  return v_id;
end;
$$;

create or replace function public.begin_document_upload(
  p_client_id uuid, p_idempotency_key text, p_original_filename text, p_extension text,
  p_mime_type text, p_size_bytes bigint, p_sha256 text, p_category public.document_category,
  p_period_month date, p_description text
) returns table (document_id uuid, object_path text, state text)
language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.documents;
  v_dup public.documents;
  v_id uuid := gen_random_uuid();
  v_ext text := lower(btrim(coalesce(p_extension, '')));
begin
  perform private.require_active_user();
  if not private.can_submit_intake(p_client_id) then
    raise exception 'not allowed to upload documents for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select * into v_doc from public.documents where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    return query select v_doc.id, v_doc.storage_path, v_doc.upload_state;
    return;
  end if;
  if private.mime_for_extension(v_ext) is null or private.mime_for_extension(v_ext) <> p_mime_type then
    raise exception 'file type not allowed' using errcode = '22023';
  end if;
  select * into v_dup from public.documents
   where documents.client_id = p_client_id and documents.sha256 = lower(p_sha256)
     and documents.deleted_at is null and documents.upload_state = 'complete';
  if found then
    raise exception 'this exact file was already uploaded as "%" on %', v_dup.original_filename,
      to_char(v_dup.uploaded_at at time zone 'Asia/Manila', 'YYYY-MM-DD') using errcode = '23505';
  end if;
  insert into public.documents
    (id, client_id, storage_path, original_filename, extension, mime_type, size_bytes, sha256, category,
     period_month, description, idempotency_key)
  values
    (v_id, p_client_id,
     format('clients/%s/%s/%s.%s', p_client_id, to_char(private.today_ph(), 'YYYY/MM'), v_id, v_ext),
     left(btrim(p_original_filename), 255), v_ext, p_mime_type, p_size_bytes, lower(p_sha256), p_category,
     p_period_month, nullif(btrim(p_description), ''), p_idempotency_key)
  on conflict (client_id, idempotency_key) do nothing;
  return query select d.id, d.storage_path, d.upload_state from public.documents d
                where d.client_id = p_client_id and d.idempotency_key = p_idempotency_key;
end;
$$;

create or replace function public.cancel_import_batch(p_batch_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.import_batches;
begin
  perform private.require_active_user();
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

create or replace function public.create_import_batch(
  p_client_id uuid, p_idempotency_key text, p_document_id uuid, p_target text, p_file_type text,
  p_sheet_name text, p_headers text[], p_rows jsonb, p_row_numbers integer[] default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_count integer;
begin
  perform private.require_active_user();
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

create or replace function public.save_import_mapping(
  p_batch_id uuid, p_mapping jsonb, p_options jsonb, p_results jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.import_batches;
  v_summary jsonb;
begin
  perform private.require_active_user();
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

create or replace function public.approve_counterparties(p_client_id uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  perform private.require_active_user();
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
