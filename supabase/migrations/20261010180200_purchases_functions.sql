-- Phase 8 (purchases, expenses, payables), part 3 of 3: configuration,
-- workflow, posting rules, balances, aging, reconciliation, withholding data.
-- Posting rules: docs/purchases/POSTING-RULES.md.

-- ---------------------------------------------------------------------------
-- Withholding codes: entered with a legal basis, signed off by someone else.
-- ---------------------------------------------------------------------------
create function private.is_tax_config_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.firm_role() in ('firm_manager', 'reviewer'), false);
$$;

create function public.propose_withholding_code(
  p_code text, p_description text, p_rate text, p_base text, p_legal_basis text,
  p_effective_from date, p_effective_to date default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_rate numeric;
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can enter withholding codes' using errcode = '42501';
  end if;
  if coalesce(p_rate, '') !~ '^0?\.[0-9]{1,6}$' then
    raise exception 'enter the rate as a decimal, e.g. 0.02 for 2%%' using errcode = '22023';
  end if;
  v_rate := p_rate::numeric;
  insert into public.withholding_codes (code, version, description, rate, base, legal_basis, effective_from, effective_to)
  values (v_code,
          coalesce((select max(version) from public.withholding_codes where code = v_code), 0) + 1,
          btrim(coalesce(p_description, '')), v_rate, p_base, btrim(coalesce(p_legal_basis, '')),
          p_effective_from, p_effective_to)
  returning id into v_id;
  perform audit.log_event('withholding_code.proposed', null, jsonb_build_object('id', v_id, 'code', v_code, 'rate', v_rate));
  return v_id;
end;
$$;

create function public.sign_off_withholding_code(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  w public.withholding_codes;
begin
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can sign off withholding codes' using errcode = '42501';
  end if;
  select * into w from public.withholding_codes where id = p_id for update;
  if not found then
    raise exception 'withholding code not found' using errcode = 'P0002';
  end if;
  if w.status = 'signed_off' then
    return;
  end if;
  if w.status <> 'pending_signoff' then
    raise exception 'this withholding code is retired' using errcode = '22023';
  end if;
  if w.entered_by = v_uid then
    raise exception 'you entered this code, so someone else must sign it off' using errcode = '42501';
  end if;
  update public.withholding_codes set status = 'signed_off', signed_off_by = v_uid, signed_off_at = now() where id = p_id;
  perform audit.log_event('withholding_code.signed_off', null, jsonb_build_object('id', p_id, 'code', w.code, 'version', w.version));
end;
$$;

create function public.retire_withholding_code(p_id uuid, p_effective_to date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can retire withholding codes' using errcode = '42501';
  end if;
  update public.withholding_codes set status = 'retired', effective_to = coalesce(p_effective_to, effective_to)
   where id = p_id;
  if not found then
    raise exception 'withholding code not found' using errcode = 'P0002';
  end if;
  perform audit.log_event('withholding_code.retired', null, jsonb_build_object('id', p_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchase categories (accountant policy) and posting accounts
-- ---------------------------------------------------------------------------
create function public.propose_purchase_category(p_client_id uuid, p_name text, p_kind public.purchase_kind, p_account_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s purchase categories' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where id = p_account_id and client_id = p_client_id and is_active and is_postable
                   and account_type in ('asset', 'expense')) then
    raise exception 'choose an active asset or expense account' using errcode = '22023';
  end if;
  begin
    insert into public.purchase_categories (client_id, name, kind, account_id)
    values (p_client_id, btrim(p_name), p_kind, p_account_id) returning id into v_id;
  exception when unique_violation then
    raise exception 'a category named "%" already exists', btrim(p_name) using errcode = '23505';
  end;
  perform private.record_intake_event(p_client_id, 'purchase_category', v_id, null, 'proposed', null);
  return v_id;
end;
$$;

create function public.approve_purchase_category(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  c public.purchase_categories;
begin
  select * into c from public.purchase_categories where id = p_id for update;
  if not found or not private.can_read_client(c.client_id) then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(c.client_id) then
    raise exception 'only a reviewer or manager can approve purchase categories' using errcode = '42501';
  end if;
  if c.status = 'approved' then
    return;
  end if;
  if c.status <> 'proposed' then
    raise exception 'this category is retired' using errcode = '22023';
  end if;
  if c.proposed_by = v_uid then
    raise exception 'you proposed this category, so another reviewer must approve it' using errcode = '42501';
  end if;
  update public.purchase_categories set status = 'approved', approved_by = v_uid, approved_at = now() where id = p_id;
  perform private.record_intake_event(c.client_id, 'purchase_category', p_id, 'proposed', 'approved', null);
end;
$$;

create function public.retire_purchase_category(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.purchase_categories;
begin
  perform private.require_active_user();
  select * into c from public.purchase_categories where id = p_id for update;
  if not found or not private.can_read_client(c.client_id) then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(c.client_id) then
    raise exception 'only a reviewer or manager can retire purchase categories' using errcode = '42501';
  end if;
  update public.purchase_categories set status = 'retired' where id = p_id;
  perform private.record_intake_event(c.client_id, 'purchase_category', p_id, c.status, 'retired', null);
end;
$$;

-- Proposes the usual categories mapped to the starter chart (still need approval).
create function public.propose_default_purchase_categories(p_client_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  v_acct uuid;
  v_n integer := 0;
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s purchase categories' using errcode = '42501';
  end if;
  for d in select * from (values
      ('Purchases for resale', 'inventory', '5020'), ('Raw materials', 'inventory', '1210'),
      ('Office and production supplies', 'expense', '6040'), ('Repairs and maintenance', 'expense', '6080'),
      ('Fuel and oil', 'expense', '6090'), ('Transportation and travel', 'expense', '6100'),
      ('Utilities', 'expense', '6030'), ('Rent', 'expense', '6020'), ('Professional fees', 'expense', '6060'),
      ('Communication', 'expense', '6110'), ('Meals', 'expense', '6130'), ('Representation', 'expense', '6140'),
      ('Taxes and licenses', 'expense', '6120'), ('Equipment', 'fixed_asset', '1500'),
      ('Prepaid expenses', 'prepayment', '1300')) as t(name, kind, code)
  loop
    select id into v_acct from public.accounts
     where client_id = p_client_id and code = d.code and is_active and is_postable;
    continue when v_acct is null;
    continue when exists (select 1 from public.purchase_categories
                           where client_id = p_client_id and lower(name) = lower(d.name) and status <> 'retired');
    perform public.propose_purchase_category(p_client_id, d.name, d.kind::public.purchase_kind, v_acct);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create function public.set_purchase_settings(
  p_client_id uuid, p_ap uuid, p_input_vat uuid, p_wht_payable uuid, p_advances uuid, p_threshold text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s posting accounts' using errcode = '42501';
  end if;
  insert into public.purchase_settings
    (client_id, ap_account_id, input_vat_account_id, withholding_payable_account_id, supplier_advances_account_id,
     capitalization_threshold)
  values (p_client_id, p_ap, p_input_vat, p_wht_payable, p_advances, private.parse_amount_opt(p_threshold))
  on conflict (client_id) do update
    set ap_account_id = excluded.ap_account_id, input_vat_account_id = excluded.input_vat_account_id,
        withholding_payable_account_id = excluded.withholding_payable_account_id,
        supplier_advances_account_id = excluded.supplier_advances_account_id,
        capitalization_threshold = excluded.capitalization_threshold, updated_by = auth.uid(), updated_at = now();
end;
$$;

-- Maps 2010 Accounts Payable, 1310 Input Tax, 2110 Withholding Taxes Payable,
-- 1130 Advances to Suppliers (added if missing). No capitalization threshold.
create function public.apply_default_purchase_settings(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_codes text[] := array['2010', '1310', '2110', '1130'];
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s posting accounts' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where client_id = p_client_id and code = '1130') then
    insert into public.accounts (client_id, code, name, account_type, normal_balance, is_postable)
    values (p_client_id, '1130', 'Advances to Suppliers', 'asset', 'debit', true);
  end if;
  select array_agg(a.id order by array_position(v_codes, a.code)) into v_ids
    from public.accounts a where a.client_id = p_client_id and a.code = any (v_codes);
  if coalesce(cardinality(v_ids), 0) <> 4 then
    raise exception 'the chart of accounts needs accounts 2010, 1310 and 2110; set the accounts manually'
      using errcode = '22023';
  end if;
  perform public.set_purchase_settings(p_client_id, v_ids[1], v_ids[2], v_ids[3], v_ids[4],
    (select capitalization_threshold::text from public.purchase_settings where client_id = p_client_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared workflow (extends the Phase 7 helpers to purchase documents)
-- ---------------------------------------------------------------------------
create or replace function private.sales_doc_table(p_subject public.intake_subject) returns text
language sql immutable set search_path = '' as $$
  select case p_subject when 'sales_invoice' then 'sales_invoices'
                        when 'credit_note' then 'sales_credit_notes'
                        when 'sales_receipt' then 'sales_receipts'
                        when 'purchase_bill' then 'purchase_bills'
                        when 'supplier_payment' then 'supplier_payments' end;
$$;

create or replace function public.submit_sales_document(p_subject public.intake_subject, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid;
  v_status public.sales_doc_status;
  v_total numeric;
begin
  perform private.require_active_user();
  if private.sales_doc_table(p_subject) is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  execute format('select client_id, status, %s from public.%I where id = $1 for update',
                 case p_subject when 'sales_receipt' then 'amount_received + withholding_amount'
                                when 'purchase_bill' then 'gross_amount'
                                when 'supplier_payment' then 'amount_paid'
                                else 'total_amount' end,
                 private.sales_doc_table(p_subject))
    into v_client, v_status, v_total using p_id;
  if v_client is null or not private.can_read_client(v_client) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if not private.can_prepare_entries(v_client) then
    raise exception 'not allowed to submit documents for this client' using errcode = '42501';
  end if;
  if v_status = 'submitted' then
    return;
  end if;
  if v_status <> 'draft' then
    raise exception 'only drafts can be submitted' using errcode = '22023';
  end if;
  if coalesce(v_total, 0) <= 0 then
    raise exception 'the document total must be greater than zero' using errcode = '22023';
  end if;
  execute format('update public.%I set status = ''submitted'', submitted_at = now(), review_comment = null,
                  row_version = row_version + 1 where id = $1', private.sales_doc_table(p_subject)) using p_id;
  perform private.record_intake_event(v_client, p_subject, p_id, 'draft', 'submitted', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------
create function private.replace_bill_lines(p_bill_id uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  b public.purchase_bills;
  v_line jsonb;
  v_no integer := 0;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_class public.sales_tax_class;
  v_cat public.purchase_categories;
  v_w public.withholding_codes;
  v_base numeric;
  v_wht numeric;
  v_threshold numeric;
  v_flags text[] := '{}'::text[];
  c record;
begin
  select * into b from public.purchase_bills where id = p_bill_id;
  select capitalization_threshold into v_threshold from public.purchase_settings where client_id = b.client_id;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500 then
    raise exception 'add 1 to 500 lines' using errcode = '22023';
  end if;
  delete from public.purchase_bill_lines where bill_id = p_bill_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    v_qty := private.parse_decimal4(v_line ->> 'quantity');
    v_price := private.parse_decimal4(v_line ->> 'unit_price');
    v_disc := coalesce(private.parse_amount_opt(v_line ->> 'discount_amount'), 0);
    if v_qty is null or v_qty <= 0 or v_price is null then
      raise exception 'line %: enter the quantity and unit price', v_no using errcode = '22023';
    end if;
    if nullif(v_line ->> 'tax_class', '') is null then
      raise exception 'line %: choose the tax classification', v_no using errcode = '22023';
    end if;
    v_class := (v_line ->> 'tax_class')::public.sales_tax_class;
    select * into v_cat from public.purchase_categories
     where id = nullif(v_line ->> 'category_id', '')::uuid and client_id = b.client_id and status = 'approved';
    if not found then
      raise exception 'line %: choose an approved purchase category', v_no using errcode = '22023';
    end if;
    select * into c from private.compute_sales_line(v_qty, v_price, v_disc, v_class, b.prices_include_vat, b.vat_rate);
    v_w := null;
    v_base := null;
    v_wht := 0;
    if nullif(v_line ->> 'withholding_code_id', '') is not null then
      select * into v_w from public.withholding_codes where id = (v_line ->> 'withholding_code_id')::uuid;
      if not found or v_w.status = 'retired' then
        raise exception 'line %: unknown or retired withholding code', v_no using errcode = '22023';
      end if;
      if b.bill_date < v_w.effective_from or (v_w.effective_to is not null and b.bill_date > v_w.effective_to) then
        raise exception 'line %: withholding code % (version %) is not in effect on %', v_no, v_w.code, v_w.version, b.bill_date
          using errcode = '22023';
      end if;
      v_base := case v_w.base when 'gross' then c.line_amount + case when b.prices_include_vat then 0 else c.vat_amount end
                              else c.net_amount end;
      v_wht := round(v_base * v_w.rate, 2);
    end if;
    if v_cat.kind = 'expense' and v_threshold is not null and v_price >= v_threshold then
      v_flags := v_flags || format('line %s: unit cost at or above the capitalization threshold; check if it is a fixed asset', v_no);
    end if;
    insert into public.purchase_bill_lines
      (client_id, bill_id, line_no, description, quantity, unit_price, discount_amount, tax_class, vat_category,
       category_id, kind, account_id, source_supplier_name, source_supplier_tin, source_document_ref,
       withholding_code_id, withholding_rate, withholding_base, withholding_amount, line_amount, net_amount, vat_amount)
    values (b.client_id, p_bill_id, v_no, coalesce(nullif(btrim(v_line ->> 'description'), ''), v_cat.name),
            v_qty, v_price, v_disc, v_class,
            case when v_class = 'vatable' then coalesce(nullif(v_line ->> 'vat_category', ''), 'goods') end,
            v_cat.id, v_cat.kind, v_cat.account_id,
            nullif(btrim(v_line ->> 'source_supplier_name'), ''), private.normalize_tin(v_line ->> 'source_supplier_tin'),
            nullif(btrim(v_line ->> 'source_document_ref'), ''),
            v_w.id, v_w.rate, v_base, v_wht, c.line_amount, c.net_amount, c.vat_amount);
  end loop;
  if (select sum(withholding_amount) > sum(net_amount + vat_amount) from public.purchase_bill_lines where bill_id = p_bill_id) then
    raise exception 'withholding cannot exceed the bill total' using errcode = '22023';
  end if;
  update public.purchase_bills p
     set (net_amount, vat_amount, gross_amount, withholding_amount, payable_amount) =
         (select coalesce(sum(net_amount), 0), coalesce(sum(vat_amount), 0), coalesce(sum(net_amount + vat_amount), 0),
                 coalesce(sum(withholding_amount), 0),
                 coalesce(sum(net_amount + vat_amount), 0) - coalesce(sum(withholding_amount), 0)
            from public.purchase_bill_lines where bill_id = p_bill_id),
         policy_flags = v_flags
   where p.id = p_bill_id;
end;
$$;

create function public.save_purchase_bill(
  p_client_id uuid, p_bill_id uuid, p_expected_version integer, p_header jsonb, p_lines jsonb,
  p_document_ids uuid[], p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  b public.purchase_bills;
  v_cp public.counterparties;
  v_rate public.tax_rates;
  v_id uuid;
  v_type text := coalesce(nullif(h ->> 'bill_type', ''), 'bill');
  v_no text := nullif(btrim(coalesce(h ->> 'bill_no', '')), '');
  v_date date := nullif(h ->> 'bill_date', '')::date;
  v_due date;
  v_paid_from uuid := nullif(h ->> 'paid_from_account_id', '')::uuid;
  v_incl boolean := coalesce(nullif(h ->> 'prices_include_vat', '')::boolean, false);
  v_intake uuid := nullif(h ->> 'intake_transaction_id', '')::uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to record purchases for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_bill_id is null then
    select id into v_id from public.purchase_bills where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  if v_type not in ('bill', 'cash_purchase', 'reimbursement') then
    raise exception 'unknown bill type' using errcode = '22023';
  end if;
  select * into v_cp from public.counterparties
   where client_id = p_client_id and id = nullif(h ->> 'counterparty_id', '')::uuid and status = 'approved';
  if not found or (v_type = 'reimbursement' and v_cp.kind::text not in ('employee', 'supplier', 'both'))
     or (v_type <> 'reimbursement' and v_cp.kind::text not in ('supplier', 'both')) then
    raise exception 'choose an approved % for this %', case when v_type = 'reimbursement' then 'payee' else 'supplier' end,
      replace(v_type, '_', ' ') using errcode = '22023';
  end if;
  if v_no is null then
    raise exception 'enter the supplier''s invoice/receipt number' using errcode = '22023';
  end if;
  if v_date is null or v_date > private.today_ph() then
    raise exception 'enter a bill date that is not in the future' using errcode = '22023';
  end if;
  v_due := case when v_type = 'cash_purchase' then v_date
                else coalesce(nullif(h ->> 'due_date', '')::date, v_date + v_cp.credit_terms_days, v_date) end;
  if v_due < v_date then
    raise exception 'the due date cannot be before the bill date' using errcode = '22023';
  end if;
  if v_type = 'cash_purchase' then
    if v_paid_from is null or not exists (select 1 from public.accounts where id = v_paid_from and client_id = p_client_id
                                            and account_type = 'asset' and is_active and is_postable) then
      raise exception 'choose the cash or bank account it was paid from' using errcode = '22023';
    end if;
  else
    v_paid_from := null;
  end if;
  if v_intake is not null and not exists (
    select 1 from public.intake_transactions
     where id = v_intake and client_id = p_client_id and kind in ('purchase', 'expense') and status = 'approved'
       and journal_entry_id is null) then
    raise exception 'the linked intake transaction must be an approved, unbooked purchase or expense' using errcode = '22023';
  end if;
  select * into v_rate from public.tax_rates where code = 'VAT_STANDARD';

  begin
    if p_bill_id is null then
      insert into public.purchase_bills
        (client_id, bill_type, counterparty_id, bill_no, bill_date, due_date, paid_from_account_id, prices_include_vat,
         memo, vat_rate_code, vat_rate, vat_rate_status, intake_transaction_id, idempotency_key)
      values (p_client_id, v_type, v_cp.id, v_no, v_date, v_due, v_paid_from, v_incl, nullif(btrim(h ->> 'memo'), ''),
              v_rate.code, v_rate.rate, v_rate.verification_status, v_intake, p_idempotency_key)
      on conflict (client_id, idempotency_key) do nothing
      returning id into v_id;
      if v_id is null then
        select id into v_id from public.purchase_bills where client_id = p_client_id and idempotency_key = p_idempotency_key;
        return v_id;
      end if;
      perform private.record_intake_event(p_client_id, 'purchase_bill', v_id, null, 'draft', null);
    else
      select * into b from public.purchase_bills where id = p_bill_id for update;
      if not found or b.client_id <> p_client_id then
        raise exception 'bill not found' using errcode = 'P0002';
      end if;
      if b.status <> 'draft' then
        raise exception 'only draft bills can be edited' using errcode = '22023';
      end if;
      if p_expected_version is distinct from b.row_version then
        raise exception 'this bill was changed by someone else; reload the page and try again' using errcode = '40001';
      end if;
      update public.purchase_bills
         set bill_type = v_type, counterparty_id = v_cp.id, bill_no = v_no, bill_date = v_date, due_date = v_due,
             paid_from_account_id = v_paid_from, prices_include_vat = v_incl, memo = nullif(btrim(h ->> 'memo'), ''),
             vat_rate_code = v_rate.code, vat_rate = v_rate.rate, vat_rate_status = v_rate.verification_status,
             intake_transaction_id = v_intake, row_version = row_version + 1
       where id = p_bill_id;
      v_id := p_bill_id;
    end if;
  exception when unique_violation then
    raise exception 'bill no. % from this supplier is already recorded (duplicate)', v_no using errcode = '23505';
  end;
  perform private.replace_bill_lines(v_id, p_lines);
  delete from public.purchase_bill_documents where bill_id = v_id;
  if p_document_ids is not null and cardinality(p_document_ids) > 0 then
    if exists (select 1 from unnest(p_document_ids) x(id)
                where not exists (select 1 from public.documents d where d.id = x.id and d.client_id = p_client_id
                                    and d.upload_state = 'complete' and d.deleted_at is null)) then
      raise exception 'an attached document was not found' using errcode = '22023';
    end if;
    insert into public.purchase_bill_documents (client_id, bill_id, document_id)
    select distinct p_client_id, v_id, x.id from unnest(p_document_ids) x(id);
  end if;
  return v_id;
end;
$$;

-- POSTING RULE (bill): Dr the category's account = net (per account);
-- Dr Input VAT = VAT; Cr Withholding tax payable = withholding;
-- Cr Accounts payable = gross - withholding (cash purchase: Cr cash/bank).
create function public.post_purchase_bill(p_bill_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  b public.purchase_bills;
  v_cp public.counterparties;
  s public.purchase_settings;
  v_bad text;
  v_lines jsonb;
  v_je uuid;
begin
  select * into b from public.purchase_bills where id = p_bill_id for update;
  if not found or not private.can_read_client(b.client_id) then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  if b.status = 'posted' then
    return b.journal_entry_id;
  end if;
  if not private.can_approve_entries(b.client_id) then
    raise exception 'only a reviewer or manager can post bills' using errcode = '42501';
  end if;
  if b.status <> 'submitted' then
    raise exception 'submit the bill before posting it' using errcode = '22023';
  end if;
  if b.prepared_by = v_uid then
    raise exception 'you prepared this bill, so another reviewer must post it' using errcode = '42501';
  end if;
  -- Verified configuration only: every withholding code must be signed off.
  select string_agg(distinct format('%s v%s', w.code, w.version), ', ') into v_bad
    from public.purchase_bill_lines l join public.withholding_codes w on w.id = l.withholding_code_id
   where l.bill_id = p_bill_id and w.status <> 'signed_off';
  if v_bad is not null then
    raise exception 'withholding code % is not signed off yet; it must be reviewed before posting', v_bad using errcode = '22023';
  end if;
  if exists (select 1 from public.purchase_bill_lines l join public.purchase_categories c on c.id = l.category_id
              where l.bill_id = p_bill_id and c.status <> 'approved') then
    raise exception 'a purchase category on this bill is no longer approved' using errcode = '22023';
  end if;
  select * into s from public.purchase_settings where client_id = b.client_id;
  if not found then
    raise exception 'set up the purchase posting accounts for this client first' using errcode = '22023';
  end if;
  select * into v_cp from public.counterparties where id = b.counterparty_id;
  v_lines := coalesce((select jsonb_agg(jsonb_build_object(
                 'account_id', acct, 'debit', amt, 'description', 'Purchase',
                 'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', b.bill_no)
                 order by code)
               from (select l.account_id as acct, a.code, sum(l.net_amount) as amt from public.purchase_bill_lines l
                       join public.accounts a on a.id = l.account_id
                      where l.bill_id = p_bill_id group by 1, 2) g), '[]'::jsonb)
    || jsonb_build_array(
      jsonb_build_object('account_id', s.input_vat_account_id, 'debit', b.vat_amount, 'description', 'Input VAT',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', b.bill_no),
      jsonb_build_object('account_id', s.withholding_payable_account_id, 'credit', b.withholding_amount,
        'description', 'Tax withheld', 'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin,
        'document_ref', b.bill_no),
      jsonb_build_object('account_id', coalesce(b.paid_from_account_id, s.ap_account_id), 'credit', b.payable_amount,
        'description', case when b.paid_from_account_id is null then 'Accounts payable' else 'Paid' end,
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', b.bill_no));
  v_je := private.post_generated_entry(b.client_id, b.bill_date,
    format('%s %s · %s', initcap(replace(b.bill_type, '_', ' ')), b.bill_no, v_cp.registered_name),
    'purchase_bill', b.id::text, 'purchase_bill:' || b.id, v_lines, b.prepared_by);
  update public.purchase_bills
     set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je, row_version = row_version + 1
   where id = p_bill_id;
  if b.intake_transaction_id is not null then
    update public.intake_transactions
       set status = 'posted', journal_entry_id = v_je, posted_at = now(), row_version = row_version + 1
     where id = b.intake_transaction_id and status = 'approved' and journal_entry_id is null;
    if not found then
      raise exception 'the linked intake transaction is no longer an approved, unbooked purchase' using errcode = '22023';
    end if;
    perform private.record_intake_event(b.client_id, 'transaction', b.intake_transaction_id, 'approved', 'posted',
      format('Recorded as bill %s', b.bill_no));
  end if;
  perform private.record_intake_event(b.client_id, 'purchase_bill', p_bill_id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

create function private.bill_outstanding(p_bill_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when b.bill_type = 'cash_purchase' then 0 else b.payable_amount end
       - coalesce((select sum(a.amount) from public.supplier_payment_allocations a
                     join public.supplier_payments p on p.id = a.payment_id
                    where a.bill_id = b.id and p.status = 'posted'), 0)
    from public.purchase_bills b where b.id = p_bill_id;
$$;

create function public.cancel_purchase_bill(p_bill_id uuid, p_reason text, p_reversal_date date default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  b public.purchase_bills;
  v_rev uuid;
  v_min date;
begin
  select * into b from public.purchase_bills where id = p_bill_id for update;
  if not found or not private.can_read_client(b.client_id) then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  if b.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if b.status = 'posted' then
    if not private.can_approve_entries(b.client_id) then
      raise exception 'only a reviewer or manager can cancel a posted bill' using errcode = '42501';
    end if;
    if exists (select 1 from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id
                where a.bill_id = p_bill_id and p.status = 'posted') then
      raise exception 'payments are applied to this bill; cancel those payments first' using errcode = '22023';
    end if;
    select greatest(b.bill_date, max(e.entry_date)) into v_min
      from public.journal_entries e
     where e.id in (select p.journal_entry_id from public.supplier_payments p
                      join public.supplier_payment_allocations a on a.payment_id = p.id where a.bill_id = p_bill_id
                    union select p.cancel_journal_entry_id from public.supplier_payments p
                      join public.supplier_payment_allocations a on a.payment_id = p.id where a.bill_id = p_bill_id);
    v_min := coalesce(v_min, b.bill_date);
    if p_reversal_date is not null and p_reversal_date < v_min then
      raise exception 'the cancellation date cannot be before % (the last related posting)', v_min using errcode = '22023';
    end if;
    v_rev := public.reverse_entry(b.journal_entry_id, coalesce(p_reversal_date, v_min),
      'Cancelled bill ' || b.bill_no || ': ' || btrim(p_reason), 'cancel:purchase_bill:' || p_bill_id);
    if b.intake_transaction_id is not null then
      update public.intake_transactions
         set status = 'approved', journal_entry_id = null, posted_at = null, row_version = row_version + 1
       where id = b.intake_transaction_id and journal_entry_id = b.journal_entry_id;
    end if;
  elsif not private.can_prepare_entries(b.client_id) then
    raise exception 'not allowed to cancel documents for this client' using errcode = '42501';
  end if;
  update public.purchase_bills
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = p_bill_id;
  perform private.record_intake_event(b.client_id, 'purchase_bill', p_bill_id, b.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Supplier payments
-- ---------------------------------------------------------------------------
create function public.save_supplier_payment(
  p_client_id uuid, p_payment_id uuid, p_expected_version integer, p_header jsonb, p_allocations jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  p public.supplier_payments;
  v_cp public.counterparties;
  v_id uuid;
  v_no text := nullif(btrim(coalesce(h ->> 'payment_no', '')), '');
  v_date date := nullif(h ->> 'payment_date', '')::date;
  v_amount numeric := coalesce(private.parse_amount_opt(h ->> 'amount_paid'), 0);
  v_from uuid := nullif(h ->> 'paid_from_account_id', '')::uuid;
  v_alloc jsonb;
  v_a numeric;
  v_total numeric := 0;
  v_bill uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to record payments for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_payment_id is null then
    select id into v_id from public.supplier_payments where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  select * into v_cp from public.counterparties
   where client_id = p_client_id and id = nullif(h ->> 'counterparty_id', '')::uuid and status = 'approved';
  if not found or v_cp.kind::text = 'customer' then
    raise exception 'choose an approved supplier or payee' using errcode = '22023';
  end if;
  if v_no is null then
    raise exception 'enter the voucher/check number' using errcode = '22023';
  end if;
  if v_date is null or v_date > private.today_ph() then
    raise exception 'enter a payment date that is not in the future' using errcode = '22023';
  end if;
  if v_amount <= 0 then
    raise exception 'enter the amount paid' using errcode = '22023';
  end if;
  if v_from is null or not exists (select 1 from public.accounts where id = v_from and client_id = p_client_id
                                     and account_type = 'asset' and is_active and is_postable) then
    raise exception 'choose the cash or bank account it was paid from' using errcode = '22023';
  end if;
  begin
    if p_payment_id is null then
      insert into public.supplier_payments
        (client_id, counterparty_id, payment_no, payment_date, payment_method, paid_from_account_id, amount_paid,
         reference, memo, idempotency_key)
      values (p_client_id, v_cp.id, v_no, v_date, coalesce(nullif(h ->> 'payment_method', ''), 'check'), v_from, v_amount,
              nullif(btrim(h ->> 'reference'), ''), nullif(btrim(h ->> 'memo'), ''), p_idempotency_key)
      on conflict (client_id, idempotency_key) do nothing
      returning id into v_id;
      if v_id is null then
        select id into v_id from public.supplier_payments where client_id = p_client_id and idempotency_key = p_idempotency_key;
        return v_id;
      end if;
      perform private.record_intake_event(p_client_id, 'supplier_payment', v_id, null, 'draft', null);
    else
      select * into p from public.supplier_payments where id = p_payment_id for update;
      if not found or p.client_id <> p_client_id then
        raise exception 'payment not found' using errcode = 'P0002';
      end if;
      if p.status <> 'draft' then
        raise exception 'only draft payments can be edited' using errcode = '22023';
      end if;
      if p_expected_version is distinct from p.row_version then
        raise exception 'this payment was changed by someone else; reload the page and try again' using errcode = '40001';
      end if;
      update public.supplier_payments
         set counterparty_id = v_cp.id, payment_no = v_no, payment_date = v_date,
             payment_method = coalesce(nullif(h ->> 'payment_method', ''), 'check'), paid_from_account_id = v_from,
             amount_paid = v_amount, reference = nullif(btrim(h ->> 'reference'), ''), memo = nullif(btrim(h ->> 'memo'), ''),
             row_version = row_version + 1
       where id = p_payment_id;
      v_id := p_payment_id;
    end if;
  exception when unique_violation then
    raise exception 'payment no. % is already recorded (duplicate)', v_no using errcode = '23505';
  end;
  delete from public.supplier_payment_allocations where payment_id = v_id;
  for v_alloc in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    v_bill := nullif(v_alloc ->> 'bill_id', '')::uuid;
    v_a := private.parse_amount_opt(v_alloc ->> 'amount');
    continue when v_a is null or v_a = 0;
    if not exists (select 1 from public.purchase_bills where id = v_bill and client_id = p_client_id
                     and counterparty_id = v_cp.id and status = 'posted' and bill_type <> 'cash_purchase') then
      raise exception 'payments can be applied only to this payee''s posted bills' using errcode = '22023';
    end if;
    begin
      insert into public.supplier_payment_allocations (client_id, payment_id, bill_id, amount)
      values (p_client_id, v_id, v_bill, v_a);
    exception when unique_violation then
      raise exception 'a bill is listed twice in the allocation' using errcode = '22023';
    end;
    v_total := v_total + v_a;
  end loop;
  if v_total > v_amount then
    raise exception 'the amounts applied (%) are more than the payment (%)', v_total, v_amount using errcode = '22023';
  end if;
  return v_id;
end;
$$;

-- POSTING RULE (payment): Dr Accounts payable = applied to bills;
-- Dr Advances to suppliers = unapplied rest; Cr cash/bank = amount paid.
create function public.post_supplier_payment(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  p public.supplier_payments;
  v_cp public.counterparties;
  s public.purchase_settings;
  a record;
  v_applied numeric := 0;
  v_refs text;
  v_outstanding numeric;
  v_je uuid;
begin
  select * into p from public.supplier_payments where id = p_payment_id for update;
  if not found or not private.can_read_client(p.client_id) then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if p.status = 'posted' then
    return p.journal_entry_id;
  end if;
  if not private.can_approve_entries(p.client_id) then
    raise exception 'only a reviewer or manager can post payments' using errcode = '42501';
  end if;
  if p.status <> 'submitted' then
    raise exception 'submit the payment before posting it' using errcode = '22023';
  end if;
  if p.prepared_by = v_uid then
    raise exception 'you prepared this payment, so another reviewer must post it' using errcode = '42501';
  end if;
  for a in
    select al.bill_id, al.amount, b.bill_no, b.status
      from public.supplier_payment_allocations al join public.purchase_bills b on b.id = al.bill_id
     where al.payment_id = p_payment_id
     order by al.bill_id
       for update of b
  loop
    if a.status <> 'posted' then
      raise exception 'bill % is no longer posted', a.bill_no using errcode = '22023';
    end if;
    v_outstanding := private.bill_outstanding(a.bill_id);
    if a.amount > v_outstanding then
      raise exception 'the payment applies % to bill % but only % is outstanding', a.amount, a.bill_no, v_outstanding
        using errcode = '22023';
    end if;
    v_applied := v_applied + a.amount;
  end loop;
  select string_agg(b.bill_no, ', ' order by b.bill_no) into v_refs
    from public.supplier_payment_allocations al join public.purchase_bills b on b.id = al.bill_id
   where al.payment_id = p_payment_id;
  select * into s from public.purchase_settings where client_id = p.client_id;
  if not found then
    raise exception 'set up the purchase posting accounts for this client first' using errcode = '22023';
  end if;
  select * into v_cp from public.counterparties where id = p.counterparty_id;
  v_je := private.post_generated_entry(p.client_id, p.payment_date,
    format('Payment %s · %s', p.payment_no, v_cp.registered_name), 'supplier_payment', p.id::text,
    'supplier_payment:' || p.id,
    jsonb_build_array(
      jsonb_build_object('account_id', s.ap_account_id, 'debit', v_applied, 'description', left('Paid ' || coalesce(v_refs, ''), 300),
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', p.payment_no),
      jsonb_build_object('account_id', s.supplier_advances_account_id, 'debit', p.amount_paid - v_applied,
        'description', 'Unapplied (advance to supplier)', 'counterparty_name', v_cp.registered_name,
        'counterparty_tin', v_cp.tin, 'document_ref', p.payment_no),
      jsonb_build_object('account_id', p.paid_from_account_id, 'credit', p.amount_paid, 'description', 'Payment',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', p.payment_no)),
    p.prepared_by);
  update public.supplier_payments
     set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je, row_version = row_version + 1
   where id = p_payment_id;
  perform private.record_intake_event(p.client_id, 'supplier_payment', p_payment_id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

create function public.cancel_supplier_payment(p_payment_id uuid, p_reason text, p_reversal_date date default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  p public.supplier_payments;
  v_rev uuid;
begin
  select * into p from public.supplier_payments where id = p_payment_id for update;
  if not found or not private.can_read_client(p.client_id) then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if p.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if p.status = 'posted' then
    if not private.can_approve_entries(p.client_id) then
      raise exception 'only a reviewer or manager can cancel a posted payment' using errcode = '42501';
    end if;
    v_rev := public.reverse_entry(p.journal_entry_id, coalesce(p_reversal_date, p.payment_date),
      'Cancelled payment ' || p.payment_no || ': ' || btrim(p_reason), 'cancel:supplier_payment:' || p_payment_id);
  elsif not private.can_prepare_entries(p.client_id) then
    raise exception 'not allowed to cancel documents for this client' using errcode = '42501';
  end if;
  update public.supplier_payments
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = p_payment_id;
  perform private.record_intake_event(p.client_id, 'supplier_payment', p_payment_id, p.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read models (SECURITY INVOKER; "as of" uses journal entry dates)
-- ---------------------------------------------------------------------------
create function public.purchase_bill_balances(p_client_id uuid, p_as_of date)
returns table (
  bill_id uuid, bill_no text, counterparty_id uuid, supplier_name text, bill_date date, due_date date,
  payable text, paid text, outstanding text, days_overdue integer
)
language sql stable security invoker set search_path = '' as $$
  with live as (
    select d.id
      from (select id, journal_entry_id, cancel_journal_entry_id from public.purchase_bills where client_id = p_client_id
            union all
            select id, journal_entry_id, cancel_journal_entry_id from public.supplier_payments where client_id = p_client_id) d
      join public.journal_entries je on je.id = d.journal_entry_id
     where je.entry_date <= p_as_of
       and (d.cancel_journal_entry_id is null
            or (select entry_date from public.journal_entries where id = d.cancel_journal_entry_id) > p_as_of)
  ),
  pay as (
    select a.bill_id, sum(a.amount) as amt from public.supplier_payment_allocations a join live on live.id = a.payment_id
     group by a.bill_id
  )
  select b.id, b.bill_no, b.counterparty_id, c.registered_name, b.bill_date, b.due_date,
         b.payable_amount::text, coalesce(pay.amt, 0)::numeric(18, 2)::text,
         (b.payable_amount - coalesce(pay.amt, 0))::numeric(18, 2)::text, greatest(p_as_of - b.due_date, 0)
    from public.purchase_bills b
    join live on live.id = b.id
    join public.counterparties c on c.id = b.counterparty_id
    left join pay on pay.bill_id = b.id
   where b.bill_type <> 'cash_purchase'
   order by c.registered_name, b.bill_date, b.bill_no;
$$;

create function public.ap_aging(p_client_id uuid, p_as_of date)
returns table (
  counterparty_id uuid, supplier_name text, not_due text, days_1_30 text, days_31_60 text, days_61_90 text,
  over_90 text, total text
)
language sql stable security invoker set search_path = '' as $$
  select b.counterparty_id, b.supplier_name,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue = 0), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue between 1 and 30), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue between 31 and 60), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue between 61 and 90), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue > 90), 0)::numeric(18, 2)::text,
         sum(b.outstanding::numeric)::numeric(18, 2)::text
    from public.purchase_bill_balances(p_client_id, p_as_of) b
   where b.outstanding::numeric <> 0
   group by b.counterparty_id, b.supplier_name
   order by b.supplier_name;
$$;

-- GATE: payables subledger vs the general ledger's payables account.
create function public.ap_reconciliation(p_client_id uuid, p_as_of date)
returns table (subledger_total text, ledger_balance text, difference text)
language sql stable security invoker set search_path = '' as $$
  with sub as (
    select coalesce(sum(outstanding::numeric), 0) as amt from public.purchase_bill_balances(p_client_id, p_as_of)
  ),
  gl as (
    select coalesce(sum(l.credit - l.debit), 0) as amt
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.purchase_settings s on s.client_id = l.client_id and s.ap_account_id = l.account_id
     where l.client_id = p_client_id and e.status in ('posted', 'reversed') and e.entry_date <= p_as_of
  )
  select sub.amt::numeric(18, 2)::text, gl.amt::numeric(18, 2)::text, (gl.amt - sub.amt)::numeric(18, 2)::text
    from sub, gl;
$$;

-- Withholding data captured on posted bills (by payee and code) for a period:
-- the raw material for certificates and returns in a later, CPA-approved phase.
create function public.withholding_summary(p_client_id uuid, p_from date, p_to date)
returns table (
  counterparty_id uuid, payee_name text, payee_tin text, code text, code_version integer, rate text,
  base_total text, withheld_total text, bill_count integer
)
language sql stable security invoker set search_path = '' as $$
  select b.counterparty_id, c.registered_name, c.tin, w.code, w.version, w.rate::text,
         sum(l.withholding_base)::numeric(18, 2)::text, sum(l.withholding_amount)::numeric(18, 2)::text,
         count(distinct b.id)::integer
    from public.purchase_bill_lines l
    join public.purchase_bills b on b.id = l.bill_id
    join public.counterparties c on c.id = b.counterparty_id
    join public.withholding_codes w on w.id = l.withholding_code_id
    join public.journal_entries e on e.id = b.journal_entry_id
   where b.client_id = p_client_id and e.entry_date between p_from and p_to
     and (b.cancel_journal_entry_id is null
          or (select entry_date from public.journal_entries where id = b.cancel_journal_entry_id) > p_to)
   group by b.counterparty_id, c.registered_name, c.tin, w.code, w.version, w.rate
   order by c.registered_name, w.code;
$$;

-- ---------------------------------------------------------------------------
-- Intake link (no double booking) and purge
-- ---------------------------------------------------------------------------
create or replace function private.intake_ledger_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_ref uuid;
  v_new_ref uuid;
  v_t public.intake_transactions;
begin
  if private.purge_allowed() then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.source_type = 'intake_transaction'
     and (new.source_type is distinct from old.source_type or new.source_ref is distinct from old.source_ref) then
    v_old_ref := old.source_ref::uuid;
    update public.intake_transactions set journal_entry_id = null
     where id = v_old_ref and journal_entry_id = old.id and status = 'approved';
  end if;
  if new.source_type is distinct from 'intake_transaction' then
    return null;
  end if;
  begin
    v_new_ref := new.source_ref::uuid;
  exception when invalid_text_representation then
    raise exception 'the source reference is not a valid intake transaction id' using errcode = '22023';
  end;
  select * into v_t from public.intake_transactions where id = v_new_ref for update;
  if not found or v_t.client_id <> new.client_id then
    raise exception 'intake transaction not found for this client' using errcode = '22023';
  end if;
  if exists (select 1 from public.sales_invoices where intake_transaction_id = v_t.id and status <> 'cancelled')
     or exists (select 1 from public.purchase_bills where intake_transaction_id = v_t.id and status <> 'cancelled') then
    raise exception 'this transaction is recorded as an invoice or bill; it is booked when that document is posted'
      using errcode = '22023';
  end if;

  if new.status = 'draft' or (tg_op = 'UPDATE' and new.status = 'submitted' and old.status = 'draft') then
    if v_t.status <> 'approved' then
      raise exception 'only APPROVED intake transactions can be booked (this one is %)',
        replace(v_t.status::text, '_', ' ') using errcode = '22023';
    end if;
    update public.intake_transactions set journal_entry_id = new.id where id = v_t.id;
  elsif new.status = 'posted' and (tg_op = 'INSERT' or old.status <> 'posted') then
    if v_t.status <> 'approved' then
      raise exception 'only APPROVED intake transactions can be booked (this one is %)',
        replace(v_t.status::text, '_', ' ') using errcode = '22023';
    end if;
    update public.intake_transactions
       set status = 'posted', journal_entry_id = new.id, posted_at = now(), row_version = row_version + 1
     where id = v_t.id;
    perform private.record_intake_event(v_t.client_id, 'transaction', v_t.id, 'approved', 'posted',
      format('Booked as journal entry %s', new.entry_no));
  elsif new.status = 'void' and tg_op = 'UPDATE' and old.status <> 'void' then
    update public.intake_transactions set journal_entry_id = null
     where id = v_t.id and journal_entry_id = new.id and status = 'approved';
  elsif new.status = 'reversed' and tg_op = 'UPDATE' and old.status = 'posted' then
    update public.intake_transactions
       set status = 'approved', journal_entry_id = null, posted_at = null, row_version = row_version + 1
     where id = v_t.id and journal_entry_id = new.id;
    perform private.record_intake_event(v_t.client_id, 'transaction', v_t.id, 'posted', 'approved',
      format('Journal entry %s was reversed; the transaction must be booked again', new.entry_no));
  end if;
  return null;
end;
$$;

create or replace function public.purge_synthetic_client(p_client_id uuid) returns void
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
  delete from public.supplier_payment_allocations where client_id = p_client_id;
  delete from public.supplier_payments where client_id = p_client_id;
  delete from public.purchase_bill_documents where client_id = p_client_id;
  delete from public.purchase_bill_lines where client_id = p_client_id;
  delete from public.purchase_bills where client_id = p_client_id;
  delete from public.purchase_categories where client_id = p_client_id;
  delete from public.purchase_settings where client_id = p_client_id;
  delete from public.sales_receipt_allocations where client_id = p_client_id;
  delete from public.sales_receipts where client_id = p_client_id;
  delete from public.sales_credit_note_lines where client_id = p_client_id;
  delete from public.sales_credit_notes where client_id = p_client_id;
  delete from public.sales_invoice_lines where client_id = p_client_id;
  delete from public.sales_invoices where client_id = p_client_id;
  delete from public.sales_settings where client_id = p_client_id;
  delete from public.intake_comments where client_id = p_client_id;
  delete from public.intake_events where client_id = p_client_id;
  delete from public.intake_transaction_documents where client_id = p_client_id;
  delete from public.intake_transaction_lines where client_id = p_client_id;
  delete from public.intake_transactions where client_id = p_client_id;
  delete from public.counterparties where client_id = p_client_id;
  delete from public.import_rows where client_id = p_client_id;
  delete from public.import_batches where client_id = p_client_id;
  delete from public.documents where client_id = p_client_id;
  delete from public.business_profiles where client_id = p_client_id;
  delete from public.journal_lines where client_id = p_client_id;
  delete from public.journal_entries where client_id = p_client_id;
  delete from public.accounting_periods where client_id = p_client_id;
  delete from public.fiscal_years where client_id = p_client_id;
  update public.accounts set parent_id = null where client_id = p_client_id;
  delete from public.accounts where client_id = p_client_id;
  delete from public.clients where id = p_client_id;
  perform set_config('app.purge', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon;
revoke execute on function
  private.replace_bill_lines(uuid, jsonb), private.bill_outstanding(uuid), private.intake_ledger_sync()
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.propose_withholding_code(text, text, text, text, text, date, date),
  public.sign_off_withholding_code(uuid),
  public.retire_withholding_code(uuid, date),
  public.propose_purchase_category(uuid, text, public.purchase_kind, uuid),
  public.approve_purchase_category(uuid),
  public.retire_purchase_category(uuid),
  public.propose_default_purchase_categories(uuid),
  public.set_purchase_settings(uuid, uuid, uuid, uuid, uuid, text),
  public.apply_default_purchase_settings(uuid),
  public.save_purchase_bill(uuid, uuid, integer, jsonb, jsonb, uuid[], text),
  public.post_purchase_bill(uuid),
  public.cancel_purchase_bill(uuid, text, date),
  public.save_supplier_payment(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_supplier_payment(uuid),
  public.cancel_supplier_payment(uuid, text, date),
  public.purchase_bill_balances(uuid, date),
  public.ap_aging(uuid, date),
  public.ap_reconciliation(uuid, date),
  public.withholding_summary(uuid, date, date)
from public, anon;
grant execute on function
  public.propose_withholding_code(text, text, text, text, text, date, date),
  public.sign_off_withholding_code(uuid),
  public.retire_withholding_code(uuid, date),
  public.propose_purchase_category(uuid, text, public.purchase_kind, uuid),
  public.approve_purchase_category(uuid),
  public.retire_purchase_category(uuid),
  public.propose_default_purchase_categories(uuid),
  public.set_purchase_settings(uuid, uuid, uuid, uuid, uuid, text),
  public.apply_default_purchase_settings(uuid),
  public.save_purchase_bill(uuid, uuid, integer, jsonb, jsonb, uuid[], text),
  public.post_purchase_bill(uuid),
  public.cancel_purchase_bill(uuid, text, date),
  public.save_supplier_payment(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_supplier_payment(uuid),
  public.cancel_supplier_payment(uuid, text, date),
  public.purchase_bill_balances(uuid, date),
  public.ap_aging(uuid, date),
  public.ap_reconciliation(uuid, date),
  public.withholding_summary(uuid, date, date)
to authenticated;
grant execute on function private.is_tax_config_editor() to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010180200', 'purchases_functions') on conflict (version) do nothing;
