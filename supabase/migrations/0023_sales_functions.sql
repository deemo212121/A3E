-- Phase 7 (sales and receivables), part 3 of 3: computation, workflow,
-- posting rules, balances, aging and ledger reconciliation.
-- Posting rules are documented in docs/sales/POSTING-RULES.md.
-- Error codes: 42501 forbidden, P0002 not found, 23505 duplicate,
-- 22023 invalid, 40001 changed by someone else.

-- ---------------------------------------------------------------------------
-- Line computation (single source of truth; the UI mirrors it for display).
-- Rounding: per line, to the centavo, half away from zero (numeric round()).
-- ---------------------------------------------------------------------------
create function private.compute_sales_line(
  p_qty numeric, p_price numeric, p_discount numeric, p_class public.sales_tax_class,
  p_inclusive boolean, p_rate numeric,
  out line_amount numeric, out net_amount numeric, out vat_amount numeric
)
language plpgsql immutable set search_path = '' as $$
begin
  line_amount := round(p_qty * p_price, 2) - coalesce(p_discount, 0);
  if line_amount <= 0 then
    raise exception 'each line must be more than zero after its discount' using errcode = '22023';
  end if;
  if p_class = 'vatable' then
    if p_inclusive then
      vat_amount := round(line_amount * p_rate / (1 + p_rate), 2);
      net_amount := line_amount - vat_amount;
    else
      net_amount := line_amount;
      vat_amount := round(line_amount * p_rate, 2);
    end if;
  else
    net_amount := line_amount;
    vat_amount := 0;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create function private.sales_settings_of(p_client_id uuid) returns public.sales_settings
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.sales_settings;
begin
  select * into s from public.sales_settings where client_id = p_client_id;
  if not found then
    raise exception 'set up the sales posting accounts for this client first' using errcode = '22023';
  end if;
  return s;
end;
$$;

create function public.set_sales_settings(
  p_client_id uuid, p_ar uuid, p_sales uuid, p_output_vat uuid, p_returns uuid, p_cwt uuid, p_advances uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s posting accounts' using errcode = '42501';
  end if;
  insert into public.sales_settings
    (client_id, ar_account_id, sales_account_id, output_vat_account_id, sales_returns_account_id,
     cwt_account_id, customer_advances_account_id)
  values (p_client_id, p_ar, p_sales, p_output_vat, p_returns, p_cwt, p_advances)
  on conflict (client_id) do update
    set ar_account_id = excluded.ar_account_id, sales_account_id = excluded.sales_account_id,
        output_vat_account_id = excluded.output_vat_account_id,
        sales_returns_account_id = excluded.sales_returns_account_id,
        cwt_account_id = excluded.cwt_account_id,
        customer_advances_account_id = excluded.customer_advances_account_id,
        updated_by = auth.uid(), updated_at = now();
end;
$$;

-- Maps the starter-chart accounts (1100, 4010, 2100, 4030, 1320, 2040);
-- adds 2040 Advances from Customers if the client's chart lacks it.
create function public.apply_default_sales_settings(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_codes text[] := array['1100', '4010', '2100', '4030', '1320', '2040'];
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s posting accounts' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where client_id = p_client_id and code = '2040') then
    insert into public.accounts (client_id, code, name, account_type, normal_balance, is_postable)
    values (p_client_id, '2040', 'Advances from Customers', 'liability', 'credit', true);
  end if;
  select array_agg(a.id order by array_position(v_codes, a.code)) into v_ids
    from public.accounts a where a.client_id = p_client_id and a.code = any (v_codes);
  if coalesce(cardinality(v_ids), 0) <> 6 then
    raise exception 'the chart of accounts needs accounts 1100, 4010, 2100, 4030 and 1320; set the accounts manually'
      using errcode = '22023';
  end if;
  perform public.set_sales_settings(p_client_id, v_ids[1], v_ids[2], v_ids[3], v_ids[4], v_ids[5], v_ids[6]);
end;
$$;

-- ---------------------------------------------------------------------------
-- Posting helper: creates and posts a balanced journal entry for a sales
-- document. The document's preparer is the entry's preparer; the caller (a
-- different person, checked by the caller function) approves it. Period
-- locks, numbering, account checks and the balance check all apply.
-- ---------------------------------------------------------------------------
create function private.post_generated_entry(
  p_client_id uuid, p_date date, p_memo text, p_source_type text, p_source_ref text,
  p_key text, p_lines jsonb, p_preparer uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_period public.accounting_periods;
  v_id uuid;
  v_no integer;
  v_line jsonb;
  v_n integer := 0;
begin
  select * into v_period from public.accounting_periods
   where client_id = p_client_id and p_date between start_date and end_date;
  if not found then
    raise exception 'no accounting period covers %; open the fiscal year first', p_date using errcode = '22023';
  end if;
  if v_period.status <> 'open' then
    raise exception 'the accounting period for % is %', p_date, replace(v_period.status::text, '_', ' ')
      using errcode = '22023';
  end if;
  perform 1 from public.accounting_periods where id = v_period.id for share;
  insert into public.journal_entries
    (client_id, fiscal_year_id, period_id, entry_date, entry_type, memo, source_type, source_ref,
     idempotency_key, prepared_by, submitted_at)
  values (p_client_id, v_period.fiscal_year_id, v_period.id, p_date, 'general', left(p_memo, 500),
          p_source_type, p_source_ref, p_key, p_preparer, now())
  returning id into v_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    continue when coalesce((v_line ->> 'debit')::numeric, 0) = 0 and coalesce((v_line ->> 'credit')::numeric, 0) = 0;
    v_n := v_n + 1;
    insert into public.journal_lines
      (client_id, entry_id, line_no, account_id, debit, credit, description, counterparty_name,
       counterparty_tin, document_ref)
    values (p_client_id, v_id, v_n, (v_line ->> 'account_id')::uuid,
            coalesce((v_line ->> 'debit')::numeric, 0), coalesce((v_line ->> 'credit')::numeric, 0),
            nullif(v_line ->> 'description', ''), nullif(v_line ->> 'counterparty_name', ''),
            nullif(v_line ->> 'counterparty_tin', ''), nullif(v_line ->> 'document_ref', ''));
  end loop;
  update public.fiscal_years set next_entry_no = next_entry_no + 1
   where id = v_period.fiscal_year_id
   returning next_entry_no - 1 into v_no;
  update public.journal_entries
     set status = 'posted', entry_no = v_no, approved_by = auth.uid(), posted_at = now()
   where id = v_id;
  perform audit.log_event('journal.posted', p_client_id,
    jsonb_build_object('entry_id', v_id, 'entry_no', v_no, 'source_type', p_source_type, 'source_ref', p_source_ref));
  return v_id;
end;
$$;

-- Outstanding balance of an invoice: total - posted credit notes - posted
-- receipt allocations (cancelled documents do not count).
create function private.invoice_outstanding(p_invoice_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select i.total_amount
       - coalesce((select sum(n.total_amount) from public.sales_credit_notes n
                    where n.invoice_id = i.id and n.status = 'posted'), 0)
       - coalesce((select sum(a.amount) from public.sales_receipt_allocations a
                     join public.sales_receipts r on r.id = a.receipt_id
                    where a.invoice_id = i.id and r.status = 'posted'), 0)
    from public.sales_invoices i where i.id = p_invoice_id;
$$;

-- ---------------------------------------------------------------------------
-- Sales invoices
-- ---------------------------------------------------------------------------
create function private.replace_sales_invoice_lines(p_invoice_id uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.sales_invoices;
  v_line jsonb;
  v_no integer := 0;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_class public.sales_tax_class;
  v_acct uuid;
  c record;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice_id;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'an invoice can have at most 500 lines' using errcode = '22023';
  end if;
  delete from public.sales_invoice_lines where invoice_id = p_invoice_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    v_qty := private.parse_decimal4(v_line ->> 'quantity');
    v_price := private.parse_decimal4(v_line ->> 'unit_price');
    v_disc := coalesce(private.parse_amount_opt(v_line ->> 'discount_amount'), 0);
    if v_qty is null or v_qty <= 0 then
      raise exception 'line %: enter a quantity greater than zero', v_no using errcode = '22023';
    end if;
    if v_price is null then
      raise exception 'line %: enter the unit price', v_no using errcode = '22023';
    end if;
    if nullif(v_line ->> 'tax_class', '') is null then
      raise exception 'line %: choose the tax classification', v_no using errcode = '22023';
    end if;
    v_class := (v_line ->> 'tax_class')::public.sales_tax_class;
    v_acct := nullif(v_line ->> 'revenue_account_id', '')::uuid;
    if v_acct is not null and not exists (
      select 1 from public.accounts where id = v_acct and client_id = v_inv.client_id
        and account_type = 'revenue' and is_active and is_postable) then
      raise exception 'line %: choose an active revenue account', v_no using errcode = '22023';
    end if;
    select * into c from private.compute_sales_line(v_qty, v_price, v_disc, v_class,
                                                     v_inv.prices_include_vat, v_inv.vat_rate);
    insert into public.sales_invoice_lines
      (client_id, invoice_id, line_no, description, quantity, unit_price, discount_amount, tax_class,
       revenue_account_id, line_amount, net_amount, vat_amount)
    values (v_inv.client_id, p_invoice_id, v_no, coalesce(nullif(btrim(v_line ->> 'description'), ''), 'Item'),
            v_qty, v_price, v_disc, v_class, v_acct, c.line_amount, c.net_amount, c.vat_amount);
  end loop;
  update public.sales_invoices i
     set (gross_amount, discount_amount, vatable_sales, zero_rated_sales, exempt_sales, not_subject_sales,
          vat_amount, total_amount) =
         (select coalesce(sum(round(l.quantity * l.unit_price, 2)), 0),
                 coalesce(sum(l.discount_amount), 0),
                 coalesce(sum(l.net_amount) filter (where l.tax_class = 'vatable'), 0),
                 coalesce(sum(l.net_amount) filter (where l.tax_class = 'zero_rated'), 0),
                 coalesce(sum(l.net_amount) filter (where l.tax_class = 'exempt'), 0),
                 coalesce(sum(l.net_amount) filter (where l.tax_class = 'not_subject'), 0),
                 coalesce(sum(l.vat_amount), 0),
                 coalesce(sum(l.net_amount + l.vat_amount), 0)
            from public.sales_invoice_lines l where l.invoice_id = p_invoice_id)
   where i.id = p_invoice_id;
end;
$$;

create function public.save_sales_invoice(
  p_client_id uuid, p_invoice_id uuid, p_expected_version integer, p_header jsonb, p_lines jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  v_inv public.sales_invoices;
  v_cp public.counterparties;
  v_rate public.tax_rates;
  v_id uuid;
  v_no text := nullif(btrim(coalesce(h ->> 'invoice_no', '')), '');
  v_date date;
  v_due date;
  v_type text := coalesce(nullif(h ->> 'sale_type', ''), 'credit');
  v_incl boolean := coalesce(nullif(h ->> 'prices_include_vat', '')::boolean, false);
  v_intake uuid := nullif(h ->> 'intake_transaction_id', '')::uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to record sales for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_invoice_id is null then
    select id into v_id from public.sales_invoices where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  select * into v_cp from public.counterparties
   where client_id = p_client_id and id = nullif(h ->> 'counterparty_id', '')::uuid;
  if not found then
    raise exception 'choose the customer' using errcode = '22023';
  end if;
  if v_cp.status <> 'approved' or v_cp.kind not in ('customer', 'both') then
    raise exception 'the customer must be an approved customer' using errcode = '22023';
  end if;
  if v_no is null then
    raise exception 'enter the invoice number' using errcode = '22023';
  end if;
  v_date := nullif(h ->> 'invoice_date', '')::date;
  if v_date is null then
    raise exception 'enter the invoice date' using errcode = '22023';
  end if;
  if v_date > private.today_ph() then
    raise exception 'the invoice date cannot be in the future' using errcode = '22023';
  end if;
  if v_type not in ('cash', 'credit') then
    raise exception 'sale type must be cash or credit' using errcode = '22023';
  end if;
  v_due := case when v_type = 'cash' then v_date
                else coalesce(nullif(h ->> 'due_date', '')::date,
                              v_date + v_cp.credit_terms_days) end;
  if v_due is null then
    raise exception 'enter the due date (or set the customer''s credit terms)' using errcode = '22023';
  end if;
  if v_due < v_date then
    raise exception 'the due date cannot be before the invoice date' using errcode = '22023';
  end if;
  if v_intake is not null and not exists (
    select 1 from public.intake_transactions
     where id = v_intake and client_id = p_client_id and kind = 'sale' and status = 'approved'
       and journal_entry_id is null) then
    raise exception 'the linked intake transaction must be an approved, unbooked sale' using errcode = '22023';
  end if;
  select * into v_rate from public.tax_rates where code = 'VAT_STANDARD';

  begin
    if p_invoice_id is null then
      insert into public.sales_invoices
        (client_id, counterparty_id, invoice_no, invoice_date, due_date, sale_type, prices_include_vat, memo,
         vat_rate_code, vat_rate, vat_rate_status, intake_transaction_id, idempotency_key)
      values (p_client_id, v_cp.id, v_no, v_date, v_due, v_type, v_incl, nullif(btrim(h ->> 'memo'), ''),
              v_rate.code, v_rate.rate, v_rate.verification_status, v_intake, p_idempotency_key)
      on conflict (client_id, idempotency_key) do nothing
      returning id into v_id;
      if v_id is null then
        select id into v_id from public.sales_invoices where client_id = p_client_id and idempotency_key = p_idempotency_key;
        return v_id;
      end if;
      perform private.record_intake_event(p_client_id, 'sales_invoice', v_id, null, 'draft', null);
    else
      select * into v_inv from public.sales_invoices where id = p_invoice_id for update;
      if not found or v_inv.client_id <> p_client_id then
        raise exception 'invoice not found' using errcode = 'P0002';
      end if;
      if v_inv.status <> 'draft' then
        raise exception 'only draft invoices can be edited' using errcode = '22023';
      end if;
      if p_expected_version is distinct from v_inv.row_version then
        raise exception 'this invoice was changed by someone else; reload the page and try again' using errcode = '40001';
      end if;
      update public.sales_invoices
         set counterparty_id = v_cp.id, invoice_no = v_no, invoice_date = v_date, due_date = v_due,
             sale_type = v_type, prices_include_vat = v_incl, memo = nullif(btrim(h ->> 'memo'), ''),
             vat_rate_code = v_rate.code, vat_rate = v_rate.rate, vat_rate_status = v_rate.verification_status,
             intake_transaction_id = v_intake, row_version = row_version + 1
       where id = p_invoice_id;
      v_id := p_invoice_id;
    end if;
  exception when unique_violation then
    raise exception 'invoice no. % (or its intake transaction) is already recorded', v_no using errcode = '23505';
  end;
  perform private.replace_sales_invoice_lines(v_id, p_lines);
  return v_id;
end;
$$;

-- Shared workflow steps for the three document types.
create function private.sales_doc_table(p_subject public.intake_subject) returns text
language sql immutable set search_path = '' as $$
  select case p_subject when 'sales_invoice' then 'sales_invoices'
                        when 'credit_note' then 'sales_credit_notes'
                        when 'sales_receipt' then 'sales_receipts' end;
$$;

create function public.submit_sales_document(p_subject public.intake_subject, p_id uuid) returns void
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
                 case when p_subject = 'sales_receipt' then 'amount_received + withholding_amount' else 'total_amount' end,
                 private.sales_doc_table(p_subject))
    into v_client, v_status, v_total using p_id;
  if v_client is null or not private.can_read_client(v_client) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if not private.can_prepare_entries(v_client) then
    raise exception 'not allowed to submit sales documents for this client' using errcode = '42501';
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

create function public.return_sales_document(p_subject public.intake_subject, p_id uuid, p_comment text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_client uuid;
  v_status public.sales_doc_status;
begin
  perform private.require_active_user();
  if private.sales_doc_table(p_subject) is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  execute format('select client_id, status from public.%I where id = $1 for update', private.sales_doc_table(p_subject))
    into v_client, v_status using p_id;
  if v_client is null or not private.can_read_client(v_client) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(v_client) then
    raise exception 'only a reviewer or manager can return documents' using errcode = '42501';
  end if;
  if v_status <> 'submitted' then
    raise exception 'only submitted documents can be returned' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'explain what needs to change (a comment is required)' using errcode = '22023';
  end if;
  execute format('update public.%I set status = ''draft'', review_comment = $2, row_version = row_version + 1
                  where id = $1', private.sales_doc_table(p_subject)) using p_id, btrim(p_comment);
  perform private.record_intake_event(v_client, p_subject, p_id, 'submitted', 'draft', p_comment);
end;
$$;

-- POSTING RULE (sales invoice): Dr Accounts receivable = total;
-- Cr revenue (line account, else Sales) = net per account; Cr Output VAT = VAT.
create function public.post_sales_invoice(p_invoice_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_inv public.sales_invoices;
  v_cp public.counterparties;
  s public.sales_settings;
  v_lines jsonb;
  v_je uuid;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice_id for update;
  if not found or not private.can_read_client(v_inv.client_id) then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status = 'posted' then
    return v_inv.journal_entry_id; -- retry
  end if;
  if not private.can_approve_entries(v_inv.client_id) then
    raise exception 'only a reviewer or manager can post invoices' using errcode = '42501';
  end if;
  if v_inv.status <> 'submitted' then
    raise exception 'submit the invoice before posting it' using errcode = '22023';
  end if;
  if v_inv.prepared_by = v_uid then
    raise exception 'you prepared this invoice, so another reviewer must post it' using errcode = '42501';
  end if;
  s := private.sales_settings_of(v_inv.client_id);
  select * into v_cp from public.counterparties where id = v_inv.counterparty_id;
  v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', s.ar_account_id, 'debit', v_inv.total_amount, 'description', 'Sales invoice',
      'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_inv.invoice_no))
    || coalesce((select jsonb_agg(jsonb_build_object(
           'account_id', acct, 'credit', amt, 'description', 'Sales',
           'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_inv.invoice_no)
           order by acct)
         from (select coalesce(l.revenue_account_id, s.sales_account_id) as acct, sum(l.net_amount) as amt
                 from public.sales_invoice_lines l where l.invoice_id = p_invoice_id group by 1) g), '[]'::jsonb)
    || jsonb_build_array(jsonb_build_object(
      'account_id', s.output_vat_account_id, 'credit', v_inv.vat_amount, 'description', 'Output VAT',
      'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_inv.invoice_no));
  v_je := private.post_generated_entry(v_inv.client_id, v_inv.invoice_date,
    format('Sales invoice %s · %s', v_inv.invoice_no, v_cp.registered_name),
    'sales_invoice', v_inv.id::text, 'sales_invoice:' || v_inv.id, v_lines, v_inv.prepared_by);
  update public.sales_invoices
     set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je, row_version = row_version + 1
   where id = p_invoice_id;
  if v_inv.intake_transaction_id is not null then
    update public.intake_transactions
       set status = 'posted', journal_entry_id = v_je, posted_at = now(), row_version = row_version + 1
     where id = v_inv.intake_transaction_id and status = 'approved' and journal_entry_id is null;
    if not found then
      raise exception 'the linked intake transaction is no longer an approved, unbooked sale' using errcode = '22023';
    end if;
    perform private.record_intake_event(v_inv.client_id, 'transaction', v_inv.intake_transaction_id, 'approved',
      'posted', format('Recorded as sales invoice %s', v_inv.invoice_no));
  end if;
  perform private.record_intake_event(v_inv.client_id, 'sales_invoice', p_invoice_id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

-- Controlled cancellation. Drafts/submitted: by a preparer. Posted: by a
-- reviewer/manager, only with no posted receipts or credit notes against it;
-- the journal entry is REVERSED (never deleted).
create function public.cancel_sales_invoice(p_invoice_id uuid, p_reason text, p_reversal_date date default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_inv public.sales_invoices;
  v_rev uuid;
  v_min date;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice_id for update;
  if not found or not private.can_read_client(v_inv.client_id) then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if v_inv.status = 'posted' then
    if not private.can_approve_entries(v_inv.client_id) then
      raise exception 'only a reviewer or manager can cancel a posted invoice' using errcode = '42501';
    end if;
    if exists (select 1 from public.sales_receipt_allocations a join public.sales_receipts r on r.id = a.receipt_id
                where a.invoice_id = p_invoice_id and r.status = 'posted') then
      raise exception 'payments are applied to this invoice; cancel those receipts first' using errcode = '22023';
    end if;
    if exists (select 1 from public.sales_credit_notes where invoice_id = p_invoice_id and status = 'posted') then
      raise exception 'credit notes are posted against this invoice; cancel them first' using errcode = '22023';
    end if;
    -- The cancellation may not predate any posting related to the invoice
    -- (receipts, credit notes and their own reversals); otherwise the
    -- receivables subledger and the ledger would disagree for those dates.
    select greatest(v_inv.invoice_date, max(e.entry_date)) into v_min
      from public.journal_entries e
     where e.id in (
       select r.journal_entry_id from public.sales_receipts r
         join public.sales_receipt_allocations a on a.receipt_id = r.id where a.invoice_id = p_invoice_id
       union select r.cancel_journal_entry_id from public.sales_receipts r
         join public.sales_receipt_allocations a on a.receipt_id = r.id where a.invoice_id = p_invoice_id
       union select n.journal_entry_id from public.sales_credit_notes n where n.invoice_id = p_invoice_id
       union select n.cancel_journal_entry_id from public.sales_credit_notes n where n.invoice_id = p_invoice_id);
    v_min := coalesce(v_min, v_inv.invoice_date);
    if p_reversal_date is not null and p_reversal_date < v_min then
      raise exception 'the cancellation date cannot be before % (the last related posting)', v_min using errcode = '22023';
    end if;
    v_rev := public.reverse_entry(v_inv.journal_entry_id, coalesce(p_reversal_date, v_min),
      'Cancelled sales invoice ' || v_inv.invoice_no || ': ' || btrim(p_reason), 'cancel:sales_invoice:' || p_invoice_id);
    if v_inv.intake_transaction_id is not null then
      update public.intake_transactions
         set status = 'approved', journal_entry_id = null, posted_at = null, row_version = row_version + 1
       where id = v_inv.intake_transaction_id and journal_entry_id = v_inv.journal_entry_id;
      perform private.record_intake_event(v_inv.client_id, 'transaction', v_inv.intake_transaction_id, 'posted',
        'approved', format('Sales invoice %s was cancelled', v_inv.invoice_no));
    end if;
  elsif not private.can_prepare_entries(v_inv.client_id) then
    raise exception 'not allowed to cancel sales documents for this client' using errcode = '42501';
  end if;
  update public.sales_invoices
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = p_invoice_id;
  perform private.record_intake_event(v_inv.client_id, 'sales_invoice', p_invoice_id, v_inv.status::text,
    'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Credit notes
-- ---------------------------------------------------------------------------
create function public.save_credit_note(
  p_client_id uuid, p_credit_note_id uuid, p_expected_version integer, p_header jsonb, p_lines jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  v_inv public.sales_invoices;
  v_cn public.sales_credit_notes;
  v_id uuid;
  v_no text := nullif(btrim(coalesce(h ->> 'credit_note_no', '')), '');
  v_date date := nullif(h ->> 'credit_date', '')::date;
  v_line jsonb;
  v_n integer := 0;
  v_class public.sales_tax_class;
  v_amount numeric;
  c record;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to record credit notes for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_credit_note_id is null then
    select id into v_id from public.sales_credit_notes where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  select * into v_inv from public.sales_invoices
   where client_id = p_client_id and id = nullif(h ->> 'invoice_id', '')::uuid;
  if not found or v_inv.status <> 'posted' then
    raise exception 'a credit note must refer to a posted invoice' using errcode = '22023';
  end if;
  if v_no is null then
    raise exception 'enter the credit note number' using errcode = '22023';
  end if;
  if v_date is null or v_date < v_inv.invoice_date or v_date > private.today_ph() then
    raise exception 'the credit note date must be between the invoice date and today' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  begin
    if p_credit_note_id is null then
      insert into public.sales_credit_notes
        (client_id, invoice_id, credit_note_no, credit_date, reason_type, reason, idempotency_key)
      values (p_client_id, v_inv.id, v_no, v_date, coalesce(nullif(h ->> 'reason_type', ''), 'return'),
              btrim(coalesce(h ->> 'reason', '')), p_idempotency_key)
      on conflict (client_id, idempotency_key) do nothing
      returning id into v_id;
      if v_id is null then
        select id into v_id from public.sales_credit_notes where client_id = p_client_id and idempotency_key = p_idempotency_key;
        return v_id;
      end if;
      perform private.record_intake_event(p_client_id, 'credit_note', v_id, null, 'draft', null);
    else
      select * into v_cn from public.sales_credit_notes where id = p_credit_note_id for update;
      if not found or v_cn.client_id <> p_client_id then
        raise exception 'credit note not found' using errcode = 'P0002';
      end if;
      if v_cn.status <> 'draft' then
        raise exception 'only draft credit notes can be edited' using errcode = '22023';
      end if;
      if p_expected_version is distinct from v_cn.row_version then
        raise exception 'this credit note was changed by someone else; reload the page and try again' using errcode = '40001';
      end if;
      update public.sales_credit_notes
         set invoice_id = v_inv.id, credit_note_no = v_no, credit_date = v_date,
             reason_type = coalesce(nullif(h ->> 'reason_type', ''), 'return'), reason = btrim(coalesce(h ->> 'reason', '')),
             row_version = row_version + 1
       where id = p_credit_note_id;
      v_id := p_credit_note_id;
    end if;
  exception when unique_violation then
    raise exception 'credit note no. % is already recorded', v_no using errcode = '23505';
  end;
  delete from public.sales_credit_note_lines where credit_note_id = v_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_amount := private.parse_amount_opt(v_line ->> 'amount');
    if v_amount is null or v_amount <= 0 then
      raise exception 'line %: enter an amount greater than zero', v_n using errcode = '22023';
    end if;
    v_class := nullif(v_line ->> 'tax_class', '')::public.sales_tax_class;
    if v_class is null or not exists (select 1 from public.sales_invoice_lines where invoice_id = v_inv.id and tax_class = v_class) then
      raise exception 'line %: the tax classification must match a line of the invoice', v_n using errcode = '22023';
    end if;
    select * into c from private.compute_sales_line(1, v_amount, 0, v_class, v_inv.prices_include_vat, v_inv.vat_rate);
    insert into public.sales_credit_note_lines
      (client_id, credit_note_id, line_no, description, tax_class, line_amount, net_amount, vat_amount)
    values (p_client_id, v_id, v_n, coalesce(nullif(btrim(v_line ->> 'description'), ''), 'Adjustment'),
            v_class, c.line_amount, c.net_amount, c.vat_amount);
  end loop;
  update public.sales_credit_notes n
     set (net_amount, vat_amount, total_amount) =
         (select coalesce(sum(net_amount), 0), coalesce(sum(vat_amount), 0), coalesce(sum(net_amount + vat_amount), 0)
            from public.sales_credit_note_lines where credit_note_id = v_id)
   where n.id = v_id;
  return v_id;
end;
$$;

-- POSTING RULE (credit note): Dr Sales returns and allowances = net;
-- Dr Output VAT = VAT; Cr Accounts receivable = total. Never more than the
-- invoice's outstanding balance.
create function public.post_credit_note(p_credit_note_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_cn public.sales_credit_notes;
  v_inv public.sales_invoices;
  v_cp public.counterparties;
  s public.sales_settings;
  v_outstanding numeric;
  v_je uuid;
begin
  select * into v_cn from public.sales_credit_notes where id = p_credit_note_id for update;
  if not found or not private.can_read_client(v_cn.client_id) then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if v_cn.status = 'posted' then
    return v_cn.journal_entry_id;
  end if;
  if not private.can_approve_entries(v_cn.client_id) then
    raise exception 'only a reviewer or manager can post credit notes' using errcode = '42501';
  end if;
  if v_cn.status <> 'submitted' then
    raise exception 'submit the credit note before posting it' using errcode = '22023';
  end if;
  if v_cn.prepared_by = v_uid then
    raise exception 'you prepared this credit note, so another reviewer must post it' using errcode = '42501';
  end if;
  select * into v_inv from public.sales_invoices where id = v_cn.invoice_id for update;
  if v_inv.status <> 'posted' then
    raise exception 'the invoice is no longer posted' using errcode = '22023';
  end if;
  v_outstanding := private.invoice_outstanding(v_inv.id);
  if v_cn.total_amount > v_outstanding then
    raise exception 'the credit note (%) is more than the invoice balance (%)', v_cn.total_amount, v_outstanding
      using errcode = '22023';
  end if;
  s := private.sales_settings_of(v_cn.client_id);
  select * into v_cp from public.counterparties where id = v_inv.counterparty_id;
  v_je := private.post_generated_entry(v_cn.client_id, v_cn.credit_date,
    format('Credit note %s on invoice %s · %s', v_cn.credit_note_no, v_inv.invoice_no, v_cp.registered_name),
    'credit_note', v_cn.id::text, 'credit_note:' || v_cn.id,
    jsonb_build_array(
      jsonb_build_object('account_id', s.sales_returns_account_id, 'debit', v_cn.net_amount, 'description', v_cn.reason_type,
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_cn.credit_note_no),
      jsonb_build_object('account_id', s.output_vat_account_id, 'debit', v_cn.vat_amount, 'description', 'Output VAT',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_cn.credit_note_no),
      jsonb_build_object('account_id', s.ar_account_id, 'credit', v_cn.total_amount, 'description', 'Credit note',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_inv.invoice_no)),
    v_cn.prepared_by);
  update public.sales_credit_notes
     set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je, row_version = row_version + 1
   where id = p_credit_note_id;
  perform private.record_intake_event(v_cn.client_id, 'credit_note', p_credit_note_id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

create function public.cancel_credit_note(p_credit_note_id uuid, p_reason text, p_reversal_date date default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_cn public.sales_credit_notes;
  v_rev uuid;
begin
  select * into v_cn from public.sales_credit_notes where id = p_credit_note_id for update;
  if not found or not private.can_read_client(v_cn.client_id) then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if v_cn.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if v_cn.status = 'posted' then
    if not private.can_approve_entries(v_cn.client_id) then
      raise exception 'only a reviewer or manager can cancel a posted credit note' using errcode = '42501';
    end if;
    v_rev := public.reverse_entry(v_cn.journal_entry_id, coalesce(p_reversal_date, v_cn.credit_date),
      'Cancelled credit note ' || v_cn.credit_note_no || ': ' || btrim(p_reason), 'cancel:credit_note:' || p_credit_note_id);
  elsif not private.can_prepare_entries(v_cn.client_id) then
    raise exception 'not allowed to cancel sales documents for this client' using errcode = '42501';
  end if;
  update public.sales_credit_notes
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = p_credit_note_id;
  perform private.record_intake_event(v_cn.client_id, 'credit_note', p_credit_note_id, v_cn.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer receipts and allocations
-- ---------------------------------------------------------------------------
create function public.save_sales_receipt(
  p_client_id uuid, p_receipt_id uuid, p_expected_version integer, p_header jsonb, p_allocations jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  v_r public.sales_receipts;
  v_cp public.counterparties;
  v_id uuid;
  v_no text := nullif(btrim(coalesce(h ->> 'receipt_no', '')), '');
  v_date date := nullif(h ->> 'receipt_date', '')::date;
  v_received numeric := coalesce(private.parse_amount_opt(h ->> 'amount_received'), 0);
  v_wht numeric := coalesce(private.parse_amount_opt(h ->> 'withholding_amount'), 0);
  v_deposit uuid := nullif(h ->> 'deposit_account_id', '')::uuid;
  v_alloc jsonb;
  v_amount numeric;
  v_total numeric := 0;
  v_inv uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to record receipts for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_receipt_id is null then
    select id into v_id from public.sales_receipts where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  select * into v_cp from public.counterparties
   where client_id = p_client_id and id = nullif(h ->> 'counterparty_id', '')::uuid;
  if not found or v_cp.status <> 'approved' or v_cp.kind not in ('customer', 'both') then
    raise exception 'choose an approved customer' using errcode = '22023';
  end if;
  if v_no is null then
    raise exception 'enter the receipt number' using errcode = '22023';
  end if;
  if v_date is null or v_date > private.today_ph() then
    raise exception 'enter a receipt date that is not in the future' using errcode = '22023';
  end if;
  if v_received + v_wht <= 0 then
    raise exception 'enter the amount received' using errcode = '22023';
  end if;
  if v_deposit is null or not exists (
    select 1 from public.accounts where id = v_deposit and client_id = p_client_id and account_type = 'asset'
      and is_active and is_postable) then
    raise exception 'choose the cash or bank account the money went to' using errcode = '22023';
  end if;
  if p_allocations is not null and jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'invalid allocations' using errcode = '22023';
  end if;
  begin
    if p_receipt_id is null then
      insert into public.sales_receipts
        (client_id, counterparty_id, receipt_no, receipt_date, payment_method, deposit_account_id, amount_received,
         withholding_amount, reference, memo, idempotency_key)
      values (p_client_id, v_cp.id, v_no, v_date, coalesce(nullif(h ->> 'payment_method', ''), 'cash'), v_deposit,
              v_received, v_wht, nullif(btrim(h ->> 'reference'), ''), nullif(btrim(h ->> 'memo'), ''), p_idempotency_key)
      on conflict (client_id, idempotency_key) do nothing
      returning id into v_id;
      if v_id is null then
        select id into v_id from public.sales_receipts where client_id = p_client_id and idempotency_key = p_idempotency_key;
        return v_id;
      end if;
      perform private.record_intake_event(p_client_id, 'sales_receipt', v_id, null, 'draft', null);
    else
      select * into v_r from public.sales_receipts where id = p_receipt_id for update;
      if not found or v_r.client_id <> p_client_id then
        raise exception 'receipt not found' using errcode = 'P0002';
      end if;
      if v_r.status <> 'draft' then
        raise exception 'only draft receipts can be edited' using errcode = '22023';
      end if;
      if p_expected_version is distinct from v_r.row_version then
        raise exception 'this receipt was changed by someone else; reload the page and try again' using errcode = '40001';
      end if;
      update public.sales_receipts
         set counterparty_id = v_cp.id, receipt_no = v_no, receipt_date = v_date,
             payment_method = coalesce(nullif(h ->> 'payment_method', ''), 'cash'), deposit_account_id = v_deposit,
             amount_received = v_received, withholding_amount = v_wht, reference = nullif(btrim(h ->> 'reference'), ''),
             memo = nullif(btrim(h ->> 'memo'), ''), row_version = row_version + 1
       where id = p_receipt_id;
      v_id := p_receipt_id;
    end if;
  exception when unique_violation then
    raise exception 'receipt no. % is already recorded (duplicate)', v_no using errcode = '23505';
  end;
  delete from public.sales_receipt_allocations where receipt_id = v_id;
  for v_alloc in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    v_inv := nullif(v_alloc ->> 'invoice_id', '')::uuid;
    v_amount := private.parse_amount_opt(v_alloc ->> 'amount');
    continue when v_amount is null or v_amount = 0;
    if not exists (select 1 from public.sales_invoices where id = v_inv and client_id = p_client_id
                     and counterparty_id = v_cp.id and status = 'posted') then
      raise exception 'payments can be applied only to this customer''s posted invoices' using errcode = '22023';
    end if;
    begin
      insert into public.sales_receipt_allocations (client_id, receipt_id, invoice_id, amount)
      values (p_client_id, v_id, v_inv, v_amount);
    exception when unique_violation then
      raise exception 'an invoice is listed twice in the allocation' using errcode = '22023';
    end;
    v_total := v_total + v_amount;
  end loop;
  if v_total > v_received + v_wht then
    raise exception 'the amounts applied (%) are more than the receipt (%)', v_total, v_received + v_wht
      using errcode = '22023';
  end if;
  return v_id;
end;
$$;

-- POSTING RULE (receipt): Dr cash/bank = amount received; Dr Creditable
-- withholding tax = tax withheld (as stated); Cr Accounts receivable = amount
-- applied to invoices; Cr Advances from customers = the unapplied rest.
create function public.post_sales_receipt(p_receipt_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_r public.sales_receipts;
  v_cp public.counterparties;
  s public.sales_settings;
  a record;
  v_applied numeric := 0;
  v_refs text;
  v_je uuid;
  v_outstanding numeric;
begin
  select * into v_r from public.sales_receipts where id = p_receipt_id for update;
  if not found or not private.can_read_client(v_r.client_id) then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;
  if v_r.status = 'posted' then
    return v_r.journal_entry_id;
  end if;
  if not private.can_approve_entries(v_r.client_id) then
    raise exception 'only a reviewer or manager can post receipts' using errcode = '42501';
  end if;
  if v_r.status <> 'submitted' then
    raise exception 'submit the receipt before posting it' using errcode = '22023';
  end if;
  if v_r.prepared_by = v_uid then
    raise exception 'you prepared this receipt, so another reviewer must post it' using errcode = '42501';
  end if;
  -- Lock the invoices (in a fixed order) and re-check balances: two receipts
  -- posted at the same time cannot over-apply one invoice.
  for a in
    select al.invoice_id, al.amount, i.invoice_no, i.status
      from public.sales_receipt_allocations al
      join public.sales_invoices i on i.id = al.invoice_id
     where al.receipt_id = p_receipt_id
     order by al.invoice_id
       for update of i
  loop
    if a.status <> 'posted' then
      raise exception 'invoice % is no longer posted', a.invoice_no using errcode = '22023';
    end if;
    v_outstanding := private.invoice_outstanding(a.invoice_id);
    if a.amount > v_outstanding then
      raise exception 'the receipt applies % to invoice % but only % is outstanding', a.amount, a.invoice_no, v_outstanding
        using errcode = '22023';
    end if;
    v_applied := v_applied + a.amount;
  end loop;
  select string_agg(i.invoice_no, ', ' order by i.invoice_no) into v_refs
    from public.sales_receipt_allocations al join public.sales_invoices i on i.id = al.invoice_id
   where al.receipt_id = p_receipt_id;
  s := private.sales_settings_of(v_r.client_id);
  select * into v_cp from public.counterparties where id = v_r.counterparty_id;
  v_je := private.post_generated_entry(v_r.client_id, v_r.receipt_date,
    format('Receipt %s · %s', v_r.receipt_no, v_cp.registered_name),
    'sales_receipt', v_r.id::text, 'sales_receipt:' || v_r.id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_r.deposit_account_id, 'debit', v_r.amount_received, 'description', 'Collection',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_r.receipt_no),
      jsonb_build_object('account_id', s.cwt_account_id, 'debit', v_r.withholding_amount, 'description', 'Tax withheld by customer',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_r.receipt_no),
      jsonb_build_object('account_id', s.ar_account_id, 'credit', v_applied, 'description', left('Applied to ' || coalesce(v_refs, ''), 300),
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_r.receipt_no),
      jsonb_build_object('account_id', s.customer_advances_account_id,
        'credit', v_r.amount_received + v_r.withholding_amount - v_applied, 'description', 'Unapplied (customer advance)',
        'counterparty_name', v_cp.registered_name, 'counterparty_tin', v_cp.tin, 'document_ref', v_r.receipt_no)),
    v_r.prepared_by);
  update public.sales_receipts
     set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je, row_version = row_version + 1
   where id = p_receipt_id;
  perform private.record_intake_event(v_r.client_id, 'sales_receipt', p_receipt_id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

-- E.g. a bounced check: the posted receipt is reversed and its allocations no
-- longer count, so the invoices are outstanding again.
create function public.cancel_sales_receipt(p_receipt_id uuid, p_reason text, p_reversal_date date default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_r public.sales_receipts;
  v_rev uuid;
begin
  select * into v_r from public.sales_receipts where id = p_receipt_id for update;
  if not found or not private.can_read_client(v_r.client_id) then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;
  if v_r.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if v_r.status = 'posted' then
    if not private.can_approve_entries(v_r.client_id) then
      raise exception 'only a reviewer or manager can cancel a posted receipt' using errcode = '42501';
    end if;
    v_rev := public.reverse_entry(v_r.journal_entry_id, coalesce(p_reversal_date, v_r.receipt_date),
      'Cancelled receipt ' || v_r.receipt_no || ': ' || btrim(p_reason), 'cancel:sales_receipt:' || p_receipt_id);
  elsif not private.can_prepare_entries(v_r.client_id) then
    raise exception 'not allowed to cancel sales documents for this client' using errcode = '42501';
  end if;
  update public.sales_receipts
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = p_receipt_id;
  perform private.record_intake_event(v_r.client_id, 'sales_receipt', p_receipt_id, v_r.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read models (SECURITY INVOKER: RLS applies). Amounts as exact text.
-- "As of" uses the dates of the journal entries, so the subledger and the
-- general ledger always describe the same moment.
-- ---------------------------------------------------------------------------
create function public.sales_invoice_balances(p_client_id uuid, p_as_of date)
returns table (
  invoice_id uuid, invoice_no text, counterparty_id uuid, customer_name text, invoice_date date, due_date date,
  total text, credited text, paid text, outstanding text, days_overdue integer
)
language sql stable security invoker set search_path = '' as $$
  with live as (
    -- a document counts if posted on/before the date and not cancelled on/before it
    select d.id, d.journal_entry_id, d.cancel_journal_entry_id
      from (select id, journal_entry_id, cancel_journal_entry_id from public.sales_invoices where client_id = p_client_id
            union all
            select id, journal_entry_id, cancel_journal_entry_id from public.sales_credit_notes where client_id = p_client_id
            union all
            select id, journal_entry_id, cancel_journal_entry_id from public.sales_receipts where client_id = p_client_id) d
      join public.journal_entries je on je.id = d.journal_entry_id
     where je.entry_date <= p_as_of
       and (d.cancel_journal_entry_id is null
            or (select entry_date from public.journal_entries where id = d.cancel_journal_entry_id) > p_as_of)
  ),
  cn as (
    select n.invoice_id, sum(n.total_amount) as amt from public.sales_credit_notes n join live on live.id = n.id
     group by n.invoice_id
  ),
  pay as (
    select a.invoice_id, sum(a.amount) as amt
      from public.sales_receipt_allocations a join live on live.id = a.receipt_id
     group by a.invoice_id
  )
  select i.id, i.invoice_no, i.counterparty_id, c.registered_name, i.invoice_date, i.due_date,
         i.total_amount::text, coalesce(cn.amt, 0)::numeric(18, 2)::text, coalesce(pay.amt, 0)::numeric(18, 2)::text,
         (i.total_amount - coalesce(cn.amt, 0) - coalesce(pay.amt, 0))::numeric(18, 2)::text,
         greatest(p_as_of - i.due_date, 0)
    from public.sales_invoices i
    join live on live.id = i.id
    join public.counterparties c on c.id = i.counterparty_id
    left join cn on cn.invoice_id = i.id
    left join pay on pay.invoice_id = i.id
   order by c.registered_name, i.invoice_date, i.invoice_no;
$$;

create function public.ar_aging(p_client_id uuid, p_as_of date)
returns table (
  counterparty_id uuid, customer_name text, not_due text, days_1_30 text, days_31_60 text, days_61_90 text,
  over_90 text, total text
)
language sql stable security invoker set search_path = '' as $$
  select b.counterparty_id, b.customer_name,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue = 0), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue between 1 and 30), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue between 31 and 60), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue between 61 and 90), 0)::numeric(18, 2)::text,
         coalesce(sum(b.outstanding::numeric) filter (where b.days_overdue > 90), 0)::numeric(18, 2)::text,
         sum(b.outstanding::numeric)::numeric(18, 2)::text
    from public.sales_invoice_balances(p_client_id, p_as_of) b
   where b.outstanding::numeric <> 0
   group by b.counterparty_id, b.customer_name
   order by b.customer_name;
$$;

-- Subledger (sum of invoice balances) vs the general ledger's receivables
-- account. A difference means something was posted to the receivables account
-- outside the sales module (e.g. a manual journal entry).
create function public.ar_reconciliation(p_client_id uuid, p_as_of date)
returns table (subledger_total text, ledger_balance text, difference text)
language sql stable security invoker set search_path = '' as $$
  with sub as (
    select coalesce(sum(outstanding::numeric), 0) as amt from public.sales_invoice_balances(p_client_id, p_as_of)
  ),
  gl as (
    select coalesce(sum(l.debit - l.credit), 0) as amt
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.sales_settings s on s.client_id = l.client_id and s.ar_account_id = l.account_id
     where l.client_id = p_client_id and e.status in ('posted', 'reversed') and e.entry_date <= p_as_of
  )
  select sub.amt::numeric(18, 2)::text, gl.amt::numeric(18, 2)::text, (gl.amt - sub.amt)::numeric(18, 2)::text
    from sub, gl;
$$;

-- ---------------------------------------------------------------------------
-- An intake transaction recorded as a sales invoice must not ALSO be booked
-- through a journal entry (and vice versa): same function as 0018 plus
-- that check.
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
  if exists (select 1 from public.sales_invoices where intake_transaction_id = v_t.id and status <> 'cancelled') then
    raise exception 'this transaction is recorded as a sales invoice; it is booked when the invoice is posted'
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

-- Synthetic-client purge: sales data first (it references journal entries).
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
  private.post_generated_entry(uuid, date, text, text, text, text, jsonb, uuid),
  private.replace_sales_invoice_lines(uuid, jsonb),
  private.sales_settings_of(uuid),
  private.invoice_outstanding(uuid),
  private.intake_ledger_sync()
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.set_sales_settings(uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  public.apply_default_sales_settings(uuid),
  public.save_sales_invoice(uuid, uuid, integer, jsonb, jsonb, text),
  public.submit_sales_document(public.intake_subject, uuid),
  public.return_sales_document(public.intake_subject, uuid, text),
  public.post_sales_invoice(uuid),
  public.cancel_sales_invoice(uuid, text, date),
  public.save_credit_note(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_credit_note(uuid),
  public.cancel_credit_note(uuid, text, date),
  public.save_sales_receipt(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_sales_receipt(uuid),
  public.cancel_sales_receipt(uuid, text, date),
  public.sales_invoice_balances(uuid, date),
  public.ar_aging(uuid, date),
  public.ar_reconciliation(uuid, date)
from public, anon;
grant execute on function
  public.set_sales_settings(uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  public.apply_default_sales_settings(uuid),
  public.save_sales_invoice(uuid, uuid, integer, jsonb, jsonb, text),
  public.submit_sales_document(public.intake_subject, uuid),
  public.return_sales_document(public.intake_subject, uuid, text),
  public.post_sales_invoice(uuid),
  public.cancel_sales_invoice(uuid, text, date),
  public.save_credit_note(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_credit_note(uuid),
  public.cancel_credit_note(uuid, text, date),
  public.save_sales_receipt(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_sales_receipt(uuid),
  public.cancel_sales_receipt(uuid, text, date),
  public.sales_invoice_balances(uuid, date),
  public.ar_aging(uuid, date),
  public.ar_reconciliation(uuid, date)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0023', 'sales_functions') on conflict (version) do nothing;
