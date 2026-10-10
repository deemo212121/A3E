-- Phase 6: intake workflow functions (SECURITY DEFINER, authority-checked,
-- audited). Error codes: 42501 forbidden, P0002 not found, 23505 duplicate,
-- 22023 invalid, 40001 changed by someone else (reload).
--
-- Retry safety: every create takes an idempotency key (unique per client), so a
-- replayed request returns the record the first attempt created; status
-- changes to the state a record is already in are no-ops.

-- ---------------------------------------------------------------------------
-- Workflow rules (single source of truth for every intake subject)
-- ---------------------------------------------------------------------------
create function private.intake_transition_allowed(
  p_subject public.intake_subject, p_from public.intake_status, p_to public.intake_status
) returns boolean
language sql immutable set search_path = '' as $$
  select (p_from::text, p_to::text) in (
      ('draft', 'submitted'), ('draft', 'cancelled'),
      ('submitted', 'needs_correction'), ('submitted', 'rejected'),
      ('needs_correction', 'submitted'), ('needs_correction', 'cancelled'),
      ('reviewed', 'approved'), ('reviewed', 'needs_correction'), ('reviewed', 'rejected'))
    or (p_subject = 'transaction' and p_from = 'submitted' and p_to = 'reviewed')
    or (p_subject in ('business_profile', 'counterparty') and p_from = 'submitted' and p_to = 'approved');
$$;

create function private.assert_intake_actor(
  p_subject public.intake_subject, p_client_id uuid, p_to public.intake_status, p_comment text
) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  v_ok := case
    when p_to in ('submitted', 'cancelled') then
      case when p_subject = 'business_profile' then private.can_propose_profile(p_client_id)
           else private.can_submit_intake(p_client_id) end
    when p_to in ('needs_correction', 'reviewed') then private.can_review_intake(p_client_id)
    when p_to in ('approved', 'rejected') then
      case when p_subject = 'counterparty' then private.can_review_intake(p_client_id)
           else private.can_approve_intake(p_client_id) end
    else false
  end;
  if not coalesce(v_ok, false) then
    raise exception 'you are not allowed to change this record to "%"', replace(p_to::text, '_', ' ')
      using errcode = '42501';
  end if;
  if p_to in ('needs_correction', 'rejected') and char_length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'explain what needs to change (a comment is required)' using errcode = '22023';
  end if;
end;
$$;

create function private.record_intake_event(
  p_client_id uuid, p_subject public.intake_subject, p_subject_id uuid,
  p_from text, p_to text, p_comment text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.intake_events (client_id, subject_type, subject_id, from_status, to_status, comment)
  values (p_client_id, p_subject, p_subject_id, p_from, p_to,
          nullif(left(btrim(coalesce(p_comment, '')), 2000), ''));
  perform audit.log_event('intake.' || p_subject::text || '.' || p_to, p_client_id,
    jsonb_build_object('id', p_subject_id, 'from', p_from, 'to', p_to));
end;
$$;

-- Amount parser that keeps "blank" as NULL (private.parse_amount maps it to 0).
create function private.parse_amount_opt(p_text text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  return private.parse_amount(btrim(p_text));
end;
$$;

-- TIN normalization that returns NULL instead of raising (for matching only).
create function private.try_normalize_tin(p_text text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  return private.normalize_tin(p_text);
exception when others then
  return null;
end;
$$;

create function private.require_key(p_key text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or char_length(p_key) not between 8 and 200 then
    raise exception 'a request key of 8-200 characters is required' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Business profile
-- ---------------------------------------------------------------------------
create function private.clean_profile_fields(p_fields jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
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

create function public.save_business_profile(
  p_client_id uuid, p_profile_id uuid, p_expected_version integer, p_fields jsonb, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_clean jsonb;
  v_p public.business_profiles;
  v_id uuid;
  v_open integer;
begin
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

create function private.assert_profile_complete(p_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.business_profiles;
  v_missing text[] := '{}';
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

create function public.transition_business_profile(
  p_profile_id uuid, p_to public.intake_status, p_comment text default null
) returns public.intake_status
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_p public.business_profiles;
begin
  select * into v_p from public.business_profiles where id = p_profile_id for update;
  if not found or not private.can_read_client(v_p.client_id) then
    raise exception 'business profile not found' using errcode = 'P0002';
  end if;
  if v_p.status = p_to then
    return p_to; -- retry of a change that already happened
  end if;
  if not private.intake_transition_allowed('business_profile', v_p.status, p_to) then
    raise exception 'a % profile cannot be changed to %', replace(v_p.status::text, '_', ' '),
      replace(p_to::text, '_', ' ') using errcode = '22023';
  end if;
  perform private.assert_intake_actor('business_profile', v_p.client_id, p_to, p_comment);
  if p_to = 'submitted' then
    perform private.assert_profile_complete(p_profile_id);
  end if;
  if p_to = 'approved' and v_p.submitted_by = v_uid then
    raise exception 'you submitted this profile change, so another reviewer must approve it'
      using errcode = '42501';
  end if;
  update public.business_profiles
     set status = p_to,
         submitted_by = case when p_to = 'submitted' then v_uid else submitted_by end,
         submitted_at = case when p_to = 'submitted' then now() else submitted_at end,
         decided_by = case when p_to = 'submitted' then null else v_uid end,
         decided_at = case when p_to = 'submitted' then null else now() end,
         row_version = row_version + 1
   where id = p_profile_id;
  perform private.record_intake_event(v_p.client_id, 'business_profile', p_profile_id,
    v_p.status::text, p_to::text, p_comment);
  return p_to;
end;
$$;

-- ---------------------------------------------------------------------------
-- Counterparties
-- ---------------------------------------------------------------------------
create function private.clean_counterparty_fields(p_fields jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
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

create function private.counterparty_duplicate_message(p_client_id uuid, p_clean jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_clean ->> 'tin' is not null then
      format('a customer/supplier with TIN %s is already recorded', p_clean ->> 'tin')
    else format('a customer/supplier named "%s" (without TIN) is already recorded', p_clean ->> 'registered_name')
  end;
$$;

-- Shared by the form and the importer (callers check authority).
create function private.insert_counterparty(
  p_client_id uuid, p_clean jsonb, p_key text, p_source text, p_batch uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into public.counterparties
    (client_id, kind, registered_name, tin, vat_status, address, email, phone, source,
     import_batch_id, idempotency_key)
  select p_client_id, r.kind, r.registered_name, r.tin, r.vat_status, r.address, r.email, r.phone,
         p_source, p_batch, p_key
    from jsonb_populate_record(null::public.counterparties, p_clean) r
  on conflict (client_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.counterparties where client_id = p_client_id and idempotency_key = p_key;
    return v_id;
  end if;
  perform private.record_intake_event(p_client_id, 'counterparty', v_id, null, 'draft', null);
  return v_id;
exception when unique_violation then
  raise exception '%', private.counterparty_duplicate_message(p_client_id, p_clean) using errcode = '23505';
end;
$$;

create function public.save_counterparty(
  p_client_id uuid, p_counterparty_id uuid, p_expected_version integer, p_fields jsonb, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_clean jsonb;
  v_c public.counterparties;
  v_id uuid;
begin
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

create function public.transition_counterparty(
  p_counterparty_id uuid, p_to public.intake_status, p_comment text default null
) returns public.intake_status
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_c public.counterparties;
begin
  select * into v_c from public.counterparties where id = p_counterparty_id for update;
  if not found or not private.can_read_client(v_c.client_id) then
    raise exception 'customer/supplier not found' using errcode = 'P0002';
  end if;
  if v_c.status = p_to then
    return p_to;
  end if;
  if not private.intake_transition_allowed('counterparty', v_c.status, p_to) then
    raise exception 'a % customer/supplier cannot be changed to %', replace(v_c.status::text, '_', ' '),
      replace(p_to::text, '_', ' ') using errcode = '22023';
  end if;
  perform private.assert_intake_actor('counterparty', v_c.client_id, p_to, p_comment);
  update public.counterparties
     set status = p_to,
         submitted_by = case when p_to = 'submitted' then v_uid else submitted_by end,
         submitted_at = case when p_to = 'submitted' then now() else submitted_at end,
         decided_by = case when p_to = 'submitted' then null else v_uid end,
         decided_at = case when p_to = 'submitted' then null else now() end,
         row_version = row_version + 1
   where id = p_counterparty_id;
  perform private.record_intake_event(v_c.client_id, 'counterparty', p_counterparty_id,
    v_c.status::text, p_to::text, p_comment);
  return p_to;
end;
$$;

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------
create function private.clean_txn_header(p_client_id uuid, p_header jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  v_cp public.counterparties;
  v_name text;
  v_tin text;
  v_attrs jsonb;
  v_date text;
begin
  if jsonb_typeof(h) <> 'object' then
    raise exception 'invalid transaction data' using errcode = '22023';
  end if;
  v_name := nullif(btrim(h ->> 'counterparty_name'), '');
  v_tin := private.normalize_tin(h ->> 'counterparty_tin');
  v_attrs := coalesce(h -> 'attributes', '{}'::jsonb);
  v_date := nullif(btrim(h ->> 'txn_date'), '');
  if v_date is not null and v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid date "%": use YYYY-MM-DD', left(v_date, 20) using errcode = '22023';
  end if;
  if nullif(h ->> 'counterparty_id', '') is not null then
    select * into v_cp from public.counterparties
     where client_id = p_client_id and id = (h ->> 'counterparty_id')::uuid
       and status not in ('rejected', 'cancelled');
    if not found then
      raise exception 'the selected customer/supplier was not found' using errcode = '22023';
    end if;
    v_name := coalesce(v_name, v_cp.registered_name);
    v_tin := coalesce(v_tin, v_cp.tin);
  end if;
  if v_tin is not null and v_name is null then
    raise exception 'enter the customer/supplier name for TIN %', v_tin using errcode = '22023';
  end if;
  if jsonb_typeof(v_attrs) <> 'object' then
    raise exception 'attributes must be an object' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'kind', nullif(btrim(h ->> 'kind'), ''),
    'txn_date', v_date,
    'document_type', nullif(btrim(h ->> 'document_type'), ''),
    'document_ref', nullif(btrim(h ->> 'document_ref'), ''),
    'counterparty_id', v_cp.id,
    'counterparty_name', v_name,
    'counterparty_tin', v_tin,
    'description', nullif(btrim(h ->> 'description'), ''),
    'gross_amount', private.parse_amount_opt(h ->> 'gross_amount'),
    'vat_amount_stated', private.parse_amount_opt(h ->> 'vat_amount_stated'),
    'withholding_amount_stated', private.parse_amount_opt(h ->> 'withholding_amount_stated'),
    'payment_method', nullif(btrim(h ->> 'payment_method'), ''),
    'attributes', v_attrs);
end;
$$;

create function private.txn_duplicate_message(p_clean jsonb) returns text
language sql immutable set search_path = '' as $$
  select format('%s no. %s from %s is already recorded (duplicate)',
    initcap(replace(coalesce(p_clean ->> 'kind', 'transaction'), '_', ' ')),
    p_clean ->> 'document_ref',
    coalesce(p_clean ->> 'counterparty_tin', p_clean ->> 'counterparty_name'));
$$;

create function private.replace_txn_lines(p_client_id uuid, p_txn_id uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_t public.intake_transactions;
  v_line jsonb;
  v_no integer := 0;
  v_amount numeric;
begin
  select * into v_t from public.intake_transactions where id = p_txn_id;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid lines' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_lines), 0) > 200 then
    raise exception 'a transaction can have at most 200 lines' using errcode = '22023';
  end if;
  delete from public.intake_transaction_lines where transaction_id = p_txn_id;
  if coalesce(jsonb_array_length(p_lines), 0) = 0 then
    -- Simple transactions: one line equal to the total.
    if v_t.gross_amount is not null then
      insert into public.intake_transaction_lines (client_id, transaction_id, line_no, description, amount)
      values (p_client_id, p_txn_id, 1,
              coalesce(left(v_t.description, 300), initcap(v_t.kind::text)), v_t.gross_amount);
    end if;
    return;
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid data', v_no using errcode = '22023';
    end if;
    v_amount := private.parse_amount_opt(v_line ->> 'amount');
    if v_amount is null or v_amount <= 0 then
      raise exception 'line %: enter an amount greater than zero', v_no using errcode = '22023';
    end if;
    insert into public.intake_transaction_lines
      (client_id, transaction_id, line_no, description, quantity, unit_price, amount, account_hint)
    values (p_client_id, p_txn_id, v_no, nullif(btrim(v_line ->> 'description'), ''),
            private.parse_decimal4(v_line ->> 'quantity'), private.parse_decimal4(v_line ->> 'unit_price'),
            v_amount, nullif(btrim(v_line ->> 'account_hint'), ''));
  end loop;
end;
$$;

create function private.replace_txn_documents(p_client_id uuid, p_txn_id uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.intake_transaction_documents where transaction_id = p_txn_id;
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  if cardinality(p_ids) > 20 then
    raise exception 'attach at most 20 documents' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_ids) as x(id)
    where not exists (select 1 from public.documents d
                      where d.client_id = p_client_id and d.id = x.id
                        and d.upload_state = 'complete' and d.deleted_at is null)
  ) then
    raise exception 'an attached document was not found' using errcode = '22023';
  end if;
  insert into public.intake_transaction_documents (client_id, transaction_id, document_id)
  select distinct p_client_id, p_txn_id, x.id from unnest(p_ids) as x(id);
end;
$$;

-- Shared by the form and the importer (callers check authority). Returns the
-- existing id when the key was already used (retry), without changing it.
create function private.insert_intake_transaction(
  p_client_id uuid, p_clean jsonb, p_lines jsonb, p_document_ids uuid[], p_key text,
  p_source text, p_batch uuid, p_row integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_clean ->> 'kind' is null then
    raise exception 'choose the transaction type' using errcode = '22023';
  end if;
  insert into public.intake_transactions
    (client_id, kind, txn_date, document_type, document_ref, counterparty_id, counterparty_name,
     counterparty_tin, description, gross_amount, vat_amount_stated, withholding_amount_stated,
     payment_method, attributes, source, import_batch_id, import_row_no, idempotency_key)
  select p_client_id, r.kind, r.txn_date, r.document_type, r.document_ref, r.counterparty_id,
         r.counterparty_name, r.counterparty_tin, r.description, r.gross_amount, r.vat_amount_stated,
         r.withholding_amount_stated, r.payment_method, r.attributes, p_source, p_batch, p_row, p_key
    from jsonb_populate_record(null::public.intake_transactions, p_clean) r
  on conflict (client_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.intake_transactions where client_id = p_client_id and idempotency_key = p_key;
    return v_id;
  end if;
  perform private.replace_txn_lines(p_client_id, v_id, p_lines);
  perform private.replace_txn_documents(p_client_id, v_id, p_document_ids);
  perform private.record_intake_event(p_client_id, 'transaction', v_id, null, 'draft', null);
  return v_id;
exception when unique_violation then
  raise exception '%', private.txn_duplicate_message(p_clean) using errcode = '23505';
end;
$$;

create function public.save_intake_transaction(
  p_client_id uuid, p_transaction_id uuid, p_expected_version integer,
  p_header jsonb, p_lines jsonb, p_document_ids uuid[], p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_clean jsonb;
  v_t public.intake_transactions;
  v_id uuid;
begin
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

-- Required fields for submission. The UI checks the same rules first; this is
-- the authority.
create function private.assert_txn_complete(p_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.intake_transactions;
  v_missing text[] := '{}';
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

create function public.transition_intake_transaction(
  p_transaction_id uuid, p_to public.intake_status, p_comment text default null
) returns public.intake_status
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_t public.intake_transactions;
begin
  select * into v_t from public.intake_transactions where id = p_transaction_id for update;
  if not found or not private.can_read_client(v_t.client_id) then
    raise exception 'transaction not found' using errcode = 'P0002';
  end if;
  if v_t.status = p_to then
    return p_to; -- retry of a change that already happened
  end if;
  if not private.intake_transition_allowed('transaction', v_t.status, p_to) then
    raise exception 'a % transaction cannot be changed to %', replace(v_t.status::text, '_', ' '),
      replace(p_to::text, '_', ' ') using errcode = '22023';
  end if;
  perform private.assert_intake_actor('transaction', v_t.client_id, p_to, p_comment);
  if p_to = 'submitted' then
    perform private.assert_txn_complete(p_transaction_id);
  end if;
  if p_to = 'approved' and v_t.reviewed_by = v_uid then
    raise exception 'you reviewed this transaction, so another reviewer must approve it'
      using errcode = '42501';
  end if;
  update public.intake_transactions
     set status = p_to,
         submitted_by = case when p_to = 'submitted' then v_uid else submitted_by end,
         submitted_at = case when p_to = 'submitted' then now() else submitted_at end,
         -- A resubmission needs a fresh review.
         reviewed_by = case when p_to = 'reviewed' then v_uid when p_to = 'submitted' then null else reviewed_by end,
         reviewed_at = case when p_to = 'reviewed' then now() when p_to = 'submitted' then null else reviewed_at end,
         approved_by = case when p_to = 'approved' then v_uid else approved_by end,
         approved_at = case when p_to = 'approved' then now() else approved_at end,
         decided_by = case when p_to in ('needs_correction', 'rejected', 'cancelled') then v_uid else decided_by end,
         decided_at = case when p_to in ('needs_correction', 'rejected', 'cancelled') then now() else decided_at end,
         row_version = row_version + 1
   where id = p_transaction_id;
  perform private.record_intake_event(v_t.client_id, 'transaction', p_transaction_id,
    v_t.status::text, p_to::text, p_comment);
  return p_to;
end;
$$;

-- ---------------------------------------------------------------------------
-- Comments (feedback and replies)
-- ---------------------------------------------------------------------------
create function private.intake_subject_client(p_subject public.intake_subject, p_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case p_subject
    when 'business_profile' then (select client_id from public.business_profiles where id = p_id)
    when 'counterparty' then (select client_id from public.counterparties where id = p_id)
    when 'transaction' then (select client_id from public.intake_transactions where id = p_id)
    when 'document' then (select client_id from public.documents where id = p_id)
    when 'import_batch' then null -- defined with the import tables (20261010160200)
  end;
$$;

create function public.add_intake_comment(
  p_client_id uuid, p_subject public.intake_subject, p_subject_id uuid, p_body text,
  p_visibility text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_id uuid;
  v_staff boolean := private.is_assigned(p_client_id);
begin
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

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create function private.mime_for_extension(p_ext text) returns text
language sql immutable set search_path = '' as $$
  select case p_ext
    when 'pdf' then 'application/pdf'
    when 'png' then 'image/png'
    when 'jpg' then 'image/jpeg'
    when 'jpeg' then 'image/jpeg'
    when 'webp' then 'image/webp'
    when 'heic' then 'image/heic'
    when 'csv' then 'text/csv'
    when 'txt' then 'text/plain'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  end;
$$;

-- Step 1 of an upload (the server has already verified the bytes). Creates the
-- pending row and returns the only path the server may write the bytes to.
create function public.begin_document_upload(
  p_client_id uuid, p_idempotency_key text, p_original_filename text, p_extension text,
  p_mime_type text, p_size_bytes bigint, p_sha256 text, p_category public.document_category,
  p_period_month date, p_description text
) returns table (document_id uuid, object_path text, state text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_doc public.documents;
  v_dup public.documents;
  v_id uuid := gen_random_uuid();
  v_ext text := lower(btrim(coalesce(p_extension, '')));
begin
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

-- Step 3 of an upload: confirms the object exists with the declared size.
create function public.complete_document_upload(p_document_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_doc public.documents;
  v_dup public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found or v_doc.uploaded_by is distinct from v_uid then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if v_doc.upload_state = 'complete' then
    return;
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'client-documents' and o.name = v_doc.storage_path
      and coalesce((o.metadata ->> 'size')::bigint, -1) = v_doc.size_bytes
  ) then
    raise exception 'the file has not been stored completely; upload it again' using errcode = '22023';
  end if;
  select * into v_dup from public.documents
   where client_id = v_doc.client_id and sha256 = v_doc.sha256 and deleted_at is null
     and upload_state = 'complete' and id <> v_doc.id;
  if found then
    raise exception 'this exact file was already uploaded as "%"', v_dup.original_filename using errcode = '23505';
  end if;
  update public.documents set upload_state = 'complete', completed_at = now() where id = p_document_id;
  perform private.record_intake_event(v_doc.client_id, 'document', p_document_id, null, 'uploaded', null);
end;
$$;

create function public.set_document_review(
  p_document_id uuid, p_status public.document_review, p_comment text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found or v_doc.deleted_at is not null or v_doc.upload_state <> 'complete'
     or not private.can_read_client(v_doc.client_id) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if not private.can_review_intake(v_doc.client_id) then
    raise exception 'only assigned firm staff can review documents' using errcode = '42501';
  end if;
  if v_doc.review_status = p_status then
    return;
  end if;
  if p_status in ('needs_correction', 'rejected') and char_length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'explain what needs to change (a comment is required)' using errcode = '22023';
  end if;
  update public.documents
     set review_status = p_status, review_comment = nullif(btrim(coalesce(p_comment, '')), ''),
         reviewed_by = v_uid, reviewed_at = now()
   where id = p_document_id;
  perform private.record_intake_event(v_doc.client_id, 'document', p_document_id,
    v_doc.review_status::text, p_status::text, p_comment);
end;
$$;

-- Soft delete (doc 02): the uploader for their own unreviewed upload, or a
-- manager/reviewer; never while a live transaction or import uses the file.
create function public.delete_document(p_document_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found or not private.can_read_client(v_doc.client_id) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if v_doc.deleted_at is not null then
    return;
  end if;
  if not (private.can_approve_intake(v_doc.client_id)
          or (v_doc.uploaded_by = v_uid and v_doc.review_status = 'pending'
              and private.can_submit_intake(v_doc.client_id))) then
    raise exception 'you cannot delete this document' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to delete a document' using errcode = '22023';
  end if;
  if exists (select 1 from public.intake_transaction_documents l
               join public.intake_transactions t on t.id = l.transaction_id
              where l.document_id = p_document_id and t.status not in ('cancelled', 'rejected')) then
    raise exception 'this document is attached to a transaction; detach it or cancel the transaction first'
      using errcode = '22023';
  end if;
  update public.documents
     set deleted_at = now(), deleted_by = v_uid, delete_reason = btrim(p_reason)
   where id = p_document_id;
  perform private.record_intake_event(v_doc.client_id, 'document', p_document_id,
    v_doc.review_status::text, 'deleted', p_reason);
end;
$$;

-- Called by the download route before it issues a short-lived signed URL.
create function public.log_document_access(p_document_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_client uuid;
begin
  select client_id into v_client from public.documents
   where id = p_document_id and deleted_at is null and upload_state = 'complete';
  if v_client is null or not private.can_read_client(v_client) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  perform audit.log_event('document.downloaded', v_client, jsonb_build_object('document_id', p_document_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon;
revoke execute on function
  private.record_intake_event(uuid, public.intake_subject, uuid, text, text, text),
  private.insert_intake_transaction(uuid, jsonb, jsonb, uuid[], text, text, uuid, integer),
  private.insert_counterparty(uuid, jsonb, text, text, uuid),
  private.replace_txn_lines(uuid, uuid, jsonb),
  private.replace_txn_documents(uuid, uuid, uuid[]),
  private.clean_txn_header(uuid, jsonb)
from authenticated;

revoke execute on function
  public.save_business_profile(uuid, uuid, integer, jsonb, text),
  public.transition_business_profile(uuid, public.intake_status, text),
  public.save_counterparty(uuid, uuid, integer, jsonb, text),
  public.transition_counterparty(uuid, public.intake_status, text),
  public.save_intake_transaction(uuid, uuid, integer, jsonb, jsonb, uuid[], text),
  public.transition_intake_transaction(uuid, public.intake_status, text),
  public.add_intake_comment(uuid, public.intake_subject, uuid, text, text, text),
  public.begin_document_upload(uuid, text, text, text, text, bigint, text, public.document_category, date, text),
  public.complete_document_upload(uuid),
  public.set_document_review(uuid, public.document_review, text),
  public.delete_document(uuid, text),
  public.log_document_access(uuid)
from public, anon;

grant execute on function
  public.save_business_profile(uuid, uuid, integer, jsonb, text),
  public.transition_business_profile(uuid, public.intake_status, text),
  public.save_counterparty(uuid, uuid, integer, jsonb, text),
  public.transition_counterparty(uuid, public.intake_status, text),
  public.save_intake_transaction(uuid, uuid, integer, jsonb, jsonb, uuid[], text),
  public.transition_intake_transaction(uuid, public.intake_status, text),
  public.add_intake_comment(uuid, public.intake_subject, uuid, text, text, text),
  public.begin_document_upload(uuid, text, text, text, text, bigint, text, public.document_category, date, text),
  public.complete_document_upload(uuid),
  public.set_document_review(uuid, public.document_review, text),
  public.delete_document(uuid, text),
  public.log_document_access(uuid)
to authenticated;
