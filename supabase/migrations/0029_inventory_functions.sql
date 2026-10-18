-- Phase 9 (inventory and cost of goods sold), part 3 of 3: master data,
-- movements, moving-average costing, posting, cancellation, reports.
-- Posting rules: docs/inventory/COSTING-METHOD.md.

-- ---------------------------------------------------------------------------
-- Settings, locations, items
-- ---------------------------------------------------------------------------
create function public.set_inventory_settings(p_client_id uuid, p_cogs uuid, p_adjustment uuid, p_supplier_return uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s inventory accounts' using errcode = '42501';
  end if;
  insert into public.inventory_settings (client_id, cogs_account_id, adjustment_account_id, supplier_return_account_id)
  values (p_client_id, p_cogs, p_adjustment, p_supplier_return)
  on conflict (client_id) do update
    set cogs_account_id = excluded.cogs_account_id, adjustment_account_id = excluded.adjustment_account_id,
        supplier_return_account_id = excluded.supplier_return_account_id, updated_by = auth.uid(), updated_at = now();
end;
$$;

-- 5010 Cost of Goods Sold, 6900 Miscellaneous (count differences), 1130
-- Advances to Suppliers (goods returned to suppliers; added if missing).
create function public.apply_default_inventory_settings(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_codes text[] := array['5010', '6900', '1130'];
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s inventory accounts' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where client_id = p_client_id and code = '1130') then
    insert into public.accounts (client_id, code, name, account_type, normal_balance, is_postable)
    values (p_client_id, '1130', 'Advances to Suppliers', 'asset', 'debit', true);
  end if;
  select array_agg(a.id order by array_position(v_codes, a.code)) into v_ids
    from public.accounts a where a.client_id = p_client_id and a.code = any (v_codes);
  if coalesce(cardinality(v_ids), 0) <> 3 then
    raise exception 'the chart of accounts needs accounts 5010 and 6900; set the accounts manually' using errcode = '22023';
  end if;
  perform public.set_inventory_settings(p_client_id, v_ids[1], v_ids[2], v_ids[3]);
end;
$$;

-- Negative stock: an explicit, reasoned policy decision by a reviewer/manager.
create function public.set_negative_stock_policy(p_client_id uuid, p_allow boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
begin
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only a reviewer or manager can change the negative-stock policy' using errcode = '42501';
  end if;
  if p_allow and char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'give the approved business reason for allowing negative stock' using errcode = '22023';
  end if;
  update public.inventory_settings
     set allow_negative_stock = p_allow,
         negative_stock_reason = case when p_allow then btrim(p_reason) end,
         negative_stock_approved_by = case when p_allow then v_uid end,
         negative_stock_approved_at = case when p_allow then now() end,
         updated_by = v_uid, updated_at = now()
   where client_id = p_client_id;
  if not found then
    raise exception 'set up the inventory accounts first' using errcode = '22023';
  end if;
  perform private.record_intake_event(p_client_id, 'inventory_policy', p_client_id, null,
    case when p_allow then 'negative_stock_allowed' else 'negative_stock_refused' end, p_reason);
end;
$$;

create function public.save_inventory_location(p_client_id uuid, p_id uuid, p_code text, p_name text, p_active boolean)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to maintain this client''s locations' using errcode = '42501';
  end if;
  begin
    if p_id is null then
      insert into public.inventory_locations (client_id, code, name) values (p_client_id, btrim(p_code), btrim(p_name))
      returning id into v_id;
    else
      update public.inventory_locations set code = btrim(p_code), name = btrim(p_name), is_active = coalesce(p_active, true)
       where id = p_id and client_id = p_client_id returning id into v_id;
      if v_id is null then
        raise exception 'location not found' using errcode = 'P0002';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'location code % is already used', btrim(p_code) using errcode = '23505';
  end;
  return v_id;
end;
$$;

create function public.save_inventory_item(
  p_client_id uuid, p_id uuid, p_sku text, p_name text, p_unit text, p_inventory_account_id uuid, p_active boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to maintain this client''s items' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where id = p_inventory_account_id and client_id = p_client_id
                   and account_type = 'asset' and is_active and is_postable) then
    raise exception 'choose an active asset account for the inventory' using errcode = '22023';
  end if;
  begin
    if p_id is null then
      insert into public.inventory_items (client_id, sku, name, unit, inventory_account_id)
      values (p_client_id, btrim(p_sku), btrim(p_name), btrim(p_unit), p_inventory_account_id)
      returning id into v_id;
    else
      update public.inventory_items
         set sku = btrim(p_sku), name = btrim(p_name), unit = btrim(p_unit),
             inventory_account_id = p_inventory_account_id, is_active = coalesce(p_active, true)
       where id = p_id and client_id = p_client_id returning id into v_id;
      if v_id is null then
        raise exception 'item not found' using errcode = 'P0002';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'SKU % is already used', btrim(p_sku) using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Movements (draft -> submitted -> posted; cancel = reversal)
-- ---------------------------------------------------------------------------
create function public.save_inventory_movement(
  p_client_id uuid, p_movement_id uuid, p_expected_version integer, p_header jsonb, p_lines jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  h jsonb := coalesce(p_header, '{}'::jsonb);
  m public.inventory_movements;
  v_id uuid;
  v_type public.inventory_movement_type;
  v_date date := nullif(h ->> 'movement_date', '')::date;
  v_bill uuid := nullif(h ->> 'purchase_bill_id', '')::uuid;
  v_inv uuid := nullif(h ->> 'sales_invoice_id', '')::uuid;
  v_offset uuid := nullif(h ->> 'offset_account_id', '')::uuid;
  v_line jsonb;
  v_n integer := 0;
  v_qty numeric;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to record stock movements for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  if p_movement_id is null then
    select id into v_id from public.inventory_movements where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  if nullif(h ->> 'movement_type', '') is null then
    raise exception 'choose the movement type' using errcode = '22023';
  end if;
  v_type := (h ->> 'movement_type')::public.inventory_movement_type;
  if v_date is null or v_date > private.today_ph() then
    raise exception 'enter a date that is not in the future' using errcode = '22023';
  end if;
  if v_type = 'receipt' and v_bill is null and v_offset is null then
    raise exception 'a receipt without a purchase bill needs the account it is credited to (e.g. opening balances)'
      using errcode = '22023';
  end if;
  if v_type <> 'receipt' then
    v_bill := null;
  end if;
  if v_type not in ('issue', 'customer_return') then
    v_inv := null;
  end if;
  if v_type = 'customer_return' and v_inv is null then
    raise exception 'a customer return must refer to the sales invoice' using errcode = '22023';
  end if;
  if v_offset is not null and not exists (select 1 from public.accounts where id = v_offset and client_id = p_client_id
                                            and is_active and is_postable) then
    raise exception 'choose an active offset account' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500 then
    raise exception 'add 1 to 500 lines' using errcode = '22023';
  end if;

  if p_movement_id is null then
    insert into public.inventory_movements
      (client_id, movement_type, movement_date, purchase_bill_id, sales_invoice_id, offset_account_id, reason, memo,
       idempotency_key)
    values (p_client_id, v_type, v_date, v_bill, v_inv, v_offset, nullif(btrim(h ->> 'reason'), ''),
            nullif(btrim(h ->> 'memo'), ''), p_idempotency_key)
    on conflict (client_id, idempotency_key) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.inventory_movements where client_id = p_client_id and idempotency_key = p_idempotency_key;
      return v_id;
    end if;
    perform private.record_intake_event(p_client_id, 'inventory_movement', v_id, null, 'draft', null);
  else
    select * into m from public.inventory_movements where id = p_movement_id for update;
    if not found or m.client_id <> p_client_id then
      raise exception 'movement not found' using errcode = 'P0002';
    end if;
    if m.status <> 'draft' then
      raise exception 'only draft movements can be edited' using errcode = '22023';
    end if;
    if p_expected_version is distinct from m.row_version then
      raise exception 'this movement was changed by someone else; reload the page and try again' using errcode = '40001';
    end if;
    update public.inventory_movements
       set movement_type = v_type, movement_date = v_date, purchase_bill_id = v_bill, sales_invoice_id = v_inv,
           offset_account_id = v_offset, reason = nullif(btrim(h ->> 'reason'), ''), memo = nullif(btrim(h ->> 'memo'), ''),
           row_version = row_version + 1
     where id = p_movement_id;
    v_id := p_movement_id;
  end if;

  delete from public.inventory_movement_lines where movement_id = v_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if coalesce(v_line ->> 'quantity', '') !~ '^-?[0-9]{1,14}(\.[0-9]{1,4})?$' then
      raise exception 'line %: enter a quantity (up to 4 decimals)', v_n using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty = 0 or (v_type <> 'adjustment' and v_qty < 0) then
      raise exception 'line %: the quantity must be % ', v_n,
        case when v_type = 'adjustment' then 'non-zero (negative to reduce stock)' else 'greater than zero' end
        using errcode = '22023';
    end if;
    if not exists (select 1 from public.inventory_items where id = nullif(v_line ->> 'item_id', '')::uuid
                     and client_id = p_client_id and is_active) then
      raise exception 'line %: choose an active item', v_n using errcode = '22023';
    end if;
    if not exists (select 1 from public.inventory_locations where id = nullif(v_line ->> 'location_id', '')::uuid
                     and client_id = p_client_id and is_active) then
      raise exception 'line %: choose an active location', v_n using errcode = '22023';
    end if;
    if v_type = 'transfer' and (nullif(v_line ->> 'to_location_id', '') is null
                                or v_line ->> 'to_location_id' = v_line ->> 'location_id') then
      raise exception 'line %: choose a different destination location', v_n using errcode = '22023';
    end if;
    if v_type = 'receipt' and v_bill is not null and nullif(v_line ->> 'bill_line_no', '') is null then
      raise exception 'line %: choose the bill line received', v_n using errcode = '22023';
    end if;
    if v_type = 'receipt' and v_bill is null and nullif(v_line ->> 'unit_cost', '') is null then
      raise exception 'line %: enter the unit cost', v_n using errcode = '22023';
    end if;
    if v_inv is not null and nullif(v_line ->> 'invoice_line_no', '') is null then
      raise exception 'line %: choose the invoice line', v_n using errcode = '22023';
    end if;
    insert into public.inventory_movement_lines
      (client_id, movement_id, line_no, item_id, location_id, to_location_id, quantity, unit_cost, bill_line_no,
       invoice_line_no)
    values (p_client_id, v_id, v_n, (v_line ->> 'item_id')::uuid, (v_line ->> 'location_id')::uuid,
            case when v_type = 'transfer' then (v_line ->> 'to_location_id')::uuid end, v_qty,
            private.parse_decimal4(v_line ->> 'unit_cost'),
            case when v_bill is not null then (v_line ->> 'bill_line_no')::smallint end,
            case when v_inv is not null then (v_line ->> 'invoice_line_no')::smallint end);
  end loop;
  return v_id;
end;
$$;

-- Workflow helpers know about inventory movements.
create or replace function private.sales_doc_table(p_subject public.intake_subject) returns text
language sql immutable set search_path = '' as $$
  select case p_subject when 'sales_invoice' then 'sales_invoices'
                        when 'credit_note' then 'sales_credit_notes'
                        when 'sales_receipt' then 'sales_receipts'
                        when 'purchase_bill' then 'purchase_bills'
                        when 'supplier_payment' then 'supplier_payments'
                        when 'inventory_movement' then 'inventory_movements' end;
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
                                when 'inventory_movement' then '1'
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

-- Value of taking p_qty out of an item at its moving average cost. Taking all
-- that remains returns the exact remaining value (no rounding residue).
create function private.inventory_out_value(p_item public.inventory_items, p_qty numeric) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_item.qty_on_hand > 0 and p_qty <= p_item.qty_on_hand then
    if p_qty = p_item.qty_on_hand then
      return p_item.value_on_hand;
    end if;
    return round(p_item.value_on_hand * p_qty / p_item.qty_on_hand, 2);
  end if;
  -- Only reachable under an approved negative-stock policy.
  return greatest(p_item.value_on_hand, 0)
       + round((p_qty - greatest(p_item.qty_on_hand, 0)) * coalesce(p_item.last_unit_cost, 0), 2);
end;
$$;

-- Applies one stock change: ledger row + location and item balances.
create function private.apply_stock_change(
  p_movement public.inventory_movements, p_line_no smallint, p_item_id uuid, p_location_id uuid,
  p_qty numeric, p_value numeric, p_reversal boolean, p_bill_line smallint, p_invoice_line smallint,
  p_allow_negative boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_loc_qty numeric;
  i public.inventory_items;
begin
  insert into public.inventory_stock (client_id, item_id, location_id, quantity)
  values (p_movement.client_id, p_item_id, p_location_id, p_qty)
  on conflict (item_id, location_id) do update set quantity = public.inventory_stock.quantity + excluded.quantity
  returning quantity into v_loc_qty;
  update public.inventory_items
     set qty_on_hand = qty_on_hand + p_qty, value_on_hand = value_on_hand + p_value,
         last_unit_cost = case when qty_on_hand + p_qty > 0 then round((value_on_hand + p_value) / (qty_on_hand + p_qty), 6)
                               else last_unit_cost end,
         last_movement_date = greatest(coalesce(last_movement_date, p_movement.movement_date), p_movement.movement_date)
   where id = p_item_id
  returning * into i;
  if not p_allow_negative and (v_loc_qty < 0 or i.qty_on_hand < 0) then
    raise exception 'not enough stock of % at this location (would become %); negative stock is not allowed',
      i.sku, least(v_loc_qty, i.qty_on_hand) using errcode = '22023';
  end if;
  if i.qty_on_hand = 0 and i.value_on_hand <> 0 and not p_allow_negative then
    raise exception 'internal: % has no quantity but a value of %', i.sku, i.value_on_hand using errcode = 'XX000';
  end if;
  insert into public.inventory_ledger
    (client_id, item_id, location_id, movement_id, line_no, entry_date, movement_type, is_reversal, qty_change,
     value_change, unit_cost, purchase_bill_id, bill_line_no, sales_invoice_id, invoice_line_no)
  values (p_movement.client_id, p_item_id, p_location_id, p_movement.id, p_line_no, p_movement.movement_date,
          p_movement.movement_type, p_reversal, p_qty, p_value,
          case when p_qty <> 0 then round(abs(p_value / p_qty), 6) end,
          p_movement.purchase_bill_id, p_bill_line, p_movement.sales_invoice_id, p_invoice_line);
end;
$$;

-- POSTING RULES (moving weighted average, perpetual):
--   receipt linked to a posted bill line: value = the bill line's net cost
--     share; NO journal entry (the bill already debited inventory);
--   receipt without a bill: value = qty x unit cost; Dr inventory / Cr offset;
--   issue (sale or other): value = qty x average; Dr COGS / Cr inventory;
--   customer return: value = the cost at which that invoice line was issued;
--     Dr inventory / Cr COGS;
--   supplier return: value = qty x average; Dr supplier-return account / Cr inventory;
--   transfer: moves quantity and its average value between locations; no entry;
--   adjustment: decrease at average (Dr adjustment account / Cr inventory),
--     increase at the given unit cost or the average (reverse entry).
create function public.post_inventory_movement(p_movement_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  m public.inventory_movements;
  s public.inventory_settings;
  l public.inventory_movement_lines;
  i public.inventory_items;
  b public.purchase_bills;
  bl public.purchase_bill_lines;
  inv public.sales_invoices;
  il public.sales_invoice_lines;
  v_period public.accounting_periods;
  v_value numeric;
  v_done_qty numeric;
  v_done_value numeric;
  v_ret_qty numeric;
  v_ret_value numeric;
  v_acc jsonb := '[]'::jsonb;
  v_lines jsonb;
  v_total numeric := 0;
  v_je uuid;
  v_later date;
begin
  select * into m from public.inventory_movements where id = p_movement_id for update;
  if not found or not private.can_read_client(m.client_id) then
    raise exception 'movement not found' using errcode = 'P0002';
  end if;
  if m.status = 'posted' then
    return m.journal_entry_id;
  end if;
  if not private.can_approve_entries(m.client_id) then
    raise exception 'only a reviewer or manager can post stock movements' using errcode = '42501';
  end if;
  if m.status <> 'submitted' then
    raise exception 'submit the movement before posting it' using errcode = '22023';
  end if;
  if m.prepared_by = v_uid then
    raise exception 'you prepared this movement, so another reviewer must post it' using errcode = '42501';
  end if;
  select * into s from public.inventory_settings where client_id = m.client_id;
  if not found then
    raise exception 'set up the inventory accounts for this client first' using errcode = '22023';
  end if;
  select * into v_period from public.accounting_periods
   where client_id = m.client_id and m.movement_date between start_date and end_date;
  if not found or v_period.status <> 'open' then
    raise exception 'the accounting period for % is not open', m.movement_date using errcode = '22023';
  end if;
  -- Lock the items in a fixed order; refuse backdating before a later movement.
  perform 1 from public.inventory_items
   where id in (select item_id from public.inventory_movement_lines where movement_id = p_movement_id)
   order by id for update;
  select max(it.last_movement_date) into v_later from public.inventory_items it
   where it.id in (select item_id from public.inventory_movement_lines where movement_id = p_movement_id);
  if v_later is not null and m.movement_date < v_later then
    raise exception 'a later stock movement exists (%); record this on or after that date, or cancel the later movements first', v_later
      using errcode = '22023';
  end if;
  if m.purchase_bill_id is not null then
    select * into b from public.purchase_bills where id = m.purchase_bill_id;
    if b.status <> 'posted' then
      raise exception 'the purchase bill must be posted before its goods are received' using errcode = '22023';
    end if;
    if m.movement_date < b.bill_date then
      raise exception 'goods cannot be received before the bill date (%)', b.bill_date using errcode = '22023';
    end if;
  end if;
  if m.sales_invoice_id is not null then
    select * into inv from public.sales_invoices where id = m.sales_invoice_id;
    if inv.status <> 'posted' then
      raise exception 'the sales invoice must be posted' using errcode = '22023';
    end if;
    if m.movement_date < inv.invoice_date then
      raise exception 'the movement cannot be dated before the invoice (%)', inv.invoice_date using errcode = '22023';
    end if;
  end if;

  for l in select * from public.inventory_movement_lines where movement_id = p_movement_id order by line_no loop
    select * into i from public.inventory_items where id = l.item_id;
    if m.movement_type = 'receipt' then
      if m.purchase_bill_id is not null then
        select * into bl from public.purchase_bill_lines where bill_id = m.purchase_bill_id and line_no = l.bill_line_no;
        if not found then
          raise exception 'line %: bill line % does not exist', l.line_no, l.bill_line_no using errcode = '22023';
        end if;
        if bl.kind <> 'inventory' or bl.account_id <> i.inventory_account_id then
          raise exception 'line %: bill line % was not booked to %''s inventory account', l.line_no, l.bill_line_no, i.sku
            using errcode = '22023';
        end if;
        select coalesce(sum(qty_change), 0), coalesce(sum(value_change), 0) into v_done_qty, v_done_value
          from public.inventory_ledger where purchase_bill_id = m.purchase_bill_id and bill_line_no = l.bill_line_no;
        if l.quantity > bl.quantity - v_done_qty then
          raise exception 'line %: receiving % but only % remain on bill line %', l.line_no, l.quantity,
            bl.quantity - v_done_qty, l.bill_line_no using errcode = '22023';
        end if;
        v_value := case when l.quantity = bl.quantity - v_done_qty then bl.net_amount - v_done_value
                        else round(bl.net_amount * l.quantity / bl.quantity, 2) end;
      else
        v_value := round(l.quantity * l.unit_cost, 2);
        v_acc := v_acc || jsonb_build_array(jsonb_build_object('account_id', i.inventory_account_id, 'debit', v_value),
                                            jsonb_build_object('account_id', m.offset_account_id, 'credit', v_value));
      end if;
      perform private.apply_stock_change(m, l.line_no, l.item_id, l.location_id, l.quantity, v_value, false,
        l.bill_line_no, null, s.allow_negative_stock);
    elsif m.movement_type in ('issue', 'supplier_return') or (m.movement_type = 'adjustment' and l.quantity < 0) then
      if m.sales_invoice_id is not null then
        select * into il from public.sales_invoice_lines where invoice_id = m.sales_invoice_id and line_no = l.invoice_line_no;
        if not found then
          raise exception 'line %: invoice line % does not exist', l.line_no, l.invoice_line_no using errcode = '22023';
        end if;
        select coalesce(-sum(qty_change), 0) into v_done_qty from public.inventory_ledger
         where sales_invoice_id = m.sales_invoice_id and invoice_line_no = l.invoice_line_no and movement_type = 'issue';
        if l.quantity > il.quantity - v_done_qty then
          raise exception 'line %: issuing % but only % remain on invoice line %', l.line_no, l.quantity,
            il.quantity - v_done_qty, l.invoice_line_no using errcode = '22023';
        end if;
      end if;
      v_value := private.inventory_out_value(i, abs(l.quantity));
      v_acc := v_acc || jsonb_build_array(
        jsonb_build_object('account_id', case m.movement_type when 'issue' then s.cogs_account_id
                                                              when 'supplier_return' then coalesce(m.offset_account_id, s.supplier_return_account_id)
                                                              else coalesce(m.offset_account_id, s.adjustment_account_id) end,
                           'debit', v_value),
        jsonb_build_object('account_id', i.inventory_account_id, 'credit', v_value));
      perform private.apply_stock_change(m, l.line_no, l.item_id, l.location_id, -abs(l.quantity), -v_value, false,
        null, l.invoice_line_no, s.allow_negative_stock);
    elsif m.movement_type = 'customer_return' then
      select coalesce(-sum(qty_change), 0), coalesce(-sum(value_change), 0) into v_done_qty, v_done_value
        from public.inventory_ledger
       where sales_invoice_id = m.sales_invoice_id and invoice_line_no = l.invoice_line_no and movement_type = 'issue';
      select coalesce(sum(qty_change), 0), coalesce(sum(value_change), 0) into v_ret_qty, v_ret_value
        from public.inventory_ledger
       where sales_invoice_id = m.sales_invoice_id and invoice_line_no = l.invoice_line_no and movement_type = 'customer_return';
      if v_done_qty <= 0 or l.quantity > v_done_qty - v_ret_qty then
        raise exception 'line %: returning % but only % were issued and not yet returned', l.line_no, l.quantity,
          greatest(v_done_qty - v_ret_qty, 0) using errcode = '22023';
      end if;
      v_value := case when l.quantity = v_done_qty - v_ret_qty then v_done_value - v_ret_value
                      else round(v_done_value * l.quantity / v_done_qty, 2) end;
      v_acc := v_acc || jsonb_build_array(jsonb_build_object('account_id', i.inventory_account_id, 'debit', v_value),
                                          jsonb_build_object('account_id', s.cogs_account_id, 'credit', v_value));
      perform private.apply_stock_change(m, l.line_no, l.item_id, l.location_id, l.quantity, v_value, false,
        null, l.invoice_line_no, s.allow_negative_stock);
    elsif m.movement_type = 'transfer' then
      v_value := private.inventory_out_value(i, l.quantity);
      perform private.apply_stock_change(m, l.line_no, l.item_id, l.location_id, -l.quantity, -v_value, false,
        null, null, s.allow_negative_stock);
      perform private.apply_stock_change(m, l.line_no, l.item_id, l.to_location_id, l.quantity, v_value, false,
        null, null, s.allow_negative_stock);
      v_value := 0;
    else -- adjustment up
      v_value := round(l.quantity * coalesce(l.unit_cost, i.last_unit_cost, 0), 2);
      v_acc := v_acc || jsonb_build_array(
        jsonb_build_object('account_id', i.inventory_account_id, 'debit', v_value),
        jsonb_build_object('account_id', coalesce(m.offset_account_id, s.adjustment_account_id), 'credit', v_value));
      perform private.apply_stock_change(m, l.line_no, l.item_id, l.location_id, l.quantity, v_value, false,
        null, null, s.allow_negative_stock);
    end if;
    v_total := v_total + v_value;
  end loop;

  -- One balanced entry, netted per account (none for transfers and bill receipts).
  select coalesce(jsonb_agg(jsonb_build_object('account_id', acct, 'debit', greatest(d - c, 0), 'credit', greatest(c - d, 0),
                                               'description', initcap(replace(m.movement_type::text, '_', ' ')))), '[]'::jsonb)
    into v_lines
    from (select e ->> 'account_id' as acct, sum(coalesce((e ->> 'debit')::numeric, 0)) as d,
                 sum(coalesce((e ->> 'credit')::numeric, 0)) as c
            from jsonb_array_elements(v_acc) e group by 1) g
   where d <> c;
  if jsonb_array_length(v_lines) > 0 then
    v_je := private.post_generated_entry(m.client_id, m.movement_date,
      format('Stock %s%s', replace(m.movement_type::text, '_', ' '), coalesce(' · ' || m.reason, '')),
      'inventory_movement', m.id::text, 'inventory_movement:' || m.id, v_lines, m.prepared_by);
  end if;
  update public.inventory_movements
     set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je, total_value = v_total,
         row_version = row_version + 1
   where id = p_movement_id;
  perform private.record_intake_event(m.client_id, 'inventory_movement', p_movement_id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

-- Cancellation of a posted movement: only when no LATER stock movement exists
-- for its items (moving average makes later costs depend on it). The stock
-- changes are reversed on the same date and the journal entry is reversed.
create function public.cancel_inventory_movement(p_movement_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  m public.inventory_movements;
  s public.inventory_settings;
  r public.inventory_ledger;
  v_rev uuid;
  v_max bigint;
begin
  select * into m from public.inventory_movements where id = p_movement_id for update;
  if not found or not private.can_read_client(m.client_id) then
    raise exception 'movement not found' using errcode = 'P0002';
  end if;
  if m.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if m.status = 'posted' then
    if not private.can_approve_entries(m.client_id) then
      raise exception 'only a reviewer or manager can cancel a posted movement' using errcode = '42501';
    end if;
    if not exists (select 1 from public.accounting_periods where client_id = m.client_id
                     and m.movement_date between start_date and end_date and status = 'open') then
      raise exception 'the accounting period for % is not open', m.movement_date using errcode = '22023';
    end if;
    perform 1 from public.inventory_items
     where id in (select item_id from public.inventory_ledger where movement_id = p_movement_id) order by id for update;
    select max(id) into v_max from public.inventory_ledger where movement_id = p_movement_id;
    if exists (select 1 from public.inventory_ledger g
                where g.item_id in (select item_id from public.inventory_ledger where movement_id = p_movement_id)
                  and g.id > v_max) then
      raise exception 'later stock movements exist for these items; cancel them first (newest first)' using errcode = '22023';
    end if;
    select * into s from public.inventory_settings where client_id = m.client_id;
    for r in select * from public.inventory_ledger where movement_id = p_movement_id order by id desc loop
      perform private.apply_stock_change(m, r.line_no, r.item_id, r.location_id, -r.qty_change, -r.value_change, true,
        r.bill_line_no, r.invoice_line_no, s.allow_negative_stock);
    end loop;
    if m.journal_entry_id is not null then
      v_rev := public.reverse_entry(m.journal_entry_id, m.movement_date,
        'Cancelled stock movement: ' || btrim(p_reason), 'cancel:inventory_movement:' || p_movement_id);
    end if;
  elsif not private.can_prepare_entries(m.client_id) then
    raise exception 'not allowed to cancel documents for this client' using errcode = '42501';
  end if;
  update public.inventory_movements
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = p_movement_id;
  perform private.record_intake_event(m.client_id, 'inventory_movement', p_movement_id, m.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (SECURITY INVOKER). Quantities/values from the stock ledger.
-- ---------------------------------------------------------------------------
create function public.inventory_valuation(p_client_id uuid, p_as_of date)
returns table (item_id uuid, sku text, name text, unit text, quantity text, value text, average_cost text)
language sql stable security invoker set search_path = '' as $$
  select i.id, i.sku, i.name, i.unit,
         coalesce(sum(g.qty_change), 0)::numeric(18, 4)::text,
         coalesce(sum(g.value_change), 0)::numeric(18, 2)::text,
         case when coalesce(sum(g.qty_change), 0) > 0
              then round(sum(g.value_change) / sum(g.qty_change), 4)::text end
    from public.inventory_items i
    left join public.inventory_ledger g on g.item_id = i.id and g.entry_date <= p_as_of
   where i.client_id = p_client_id
   group by i.id, i.sku, i.name, i.unit
   order by i.sku;
$$;

create function public.inventory_stock_by_location(p_client_id uuid, p_as_of date)
returns table (item_id uuid, sku text, location_id uuid, location_code text, quantity text)
language sql stable security invoker set search_path = '' as $$
  select g.item_id, i.sku, g.location_id, loc.code, sum(g.qty_change)::numeric(18, 4)::text
    from public.inventory_ledger g
    join public.inventory_items i on i.id = g.item_id
    join public.inventory_locations loc on loc.id = g.location_id
   where g.client_id = p_client_id and g.entry_date <= p_as_of
   group by g.item_id, i.sku, g.location_id, loc.code
  having sum(g.qty_change) <> 0
   order by i.sku, loc.code;
$$;

-- GATE: stock ledger value (+ goods billed but not yet received) vs the
-- general ledger balance of each inventory account.
create function public.inventory_reconciliation(p_client_id uuid, p_as_of date)
returns table (account_id uuid, account_code text, stock_value text, billed_not_received text, ledger_balance text, difference text)
language sql stable security invoker set search_path = '' as $$
  with accts as (
    select distinct i.inventory_account_id as id from public.inventory_items i where i.client_id = p_client_id
  ),
  stock as (
    select i.inventory_account_id as id, sum(g.value_change) as amt
      from public.inventory_ledger g join public.inventory_items i on i.id = g.item_id
     where g.client_id = p_client_id and g.entry_date <= p_as_of
     group by 1
  ),
  billed as (
    -- inventory bill lines posted by the date, less what was received by the date
    select bl.account_id as id,
           sum(bl.net_amount - coalesce((select sum(g.value_change) from public.inventory_ledger g
                                          where g.purchase_bill_id = b.id and g.bill_line_no = bl.line_no
                                            and g.entry_date <= p_as_of), 0)) as amt
      from public.purchase_bill_lines bl
      join public.purchase_bills b on b.id = bl.bill_id
      join public.journal_entries e on e.id = b.journal_entry_id
     where b.client_id = p_client_id and bl.kind = 'inventory' and e.entry_date <= p_as_of
       and bl.account_id in (select id from accts)
       and (b.cancel_journal_entry_id is null
            or (select entry_date from public.journal_entries where id = b.cancel_journal_entry_id) > p_as_of)
     group by 1
  ),
  gl as (
    select l.account_id as id, sum(l.debit - l.credit) as amt
      from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
     where l.client_id = p_client_id and e.status in ('posted', 'reversed') and e.entry_date <= p_as_of
       and l.account_id in (select id from accts)
     group by 1
  )
  select a.id, ac.code, coalesce(stock.amt, 0)::numeric(18, 2)::text, coalesce(billed.amt, 0)::numeric(18, 2)::text,
         coalesce(gl.amt, 0)::numeric(18, 2)::text,
         (coalesce(gl.amt, 0) - coalesce(stock.amt, 0) - coalesce(billed.amt, 0))::numeric(18, 2)::text
    from accts a
    join public.accounts ac on ac.id = a.id
    left join stock on stock.id = a.id
    left join billed on billed.id = a.id
    left join gl on gl.id = a.id
   order by ac.code;
$$;

-- Quantity check: maintained balances must equal the stock ledger (should
-- always return no rows).
create function public.inventory_quantity_check(p_client_id uuid)
returns table (item_id uuid, sku text, location_id uuid, balance_qty text, ledger_qty text)
language sql stable security invoker set search_path = '' as $$
  with led as (
    select item_id, location_id, sum(qty_change) as q from public.inventory_ledger where client_id = p_client_id
     group by 1, 2
  )
  select s.item_id, i.sku, s.location_id, s.quantity::text, coalesce(led.q, 0)::text
    from public.inventory_stock s
    join public.inventory_items i on i.id = s.item_id
    left join led on led.item_id = s.item_id and led.location_id = s.location_id
   where s.client_id = p_client_id and s.quantity <> coalesce(led.q, 0)
  union all
  select i.id, i.sku, null, i.qty_on_hand::text, coalesce((select sum(qty_change) from public.inventory_ledger g where g.item_id = i.id), 0)::text
    from public.inventory_items i
   where i.client_id = p_client_id
     and (i.qty_on_hand <> coalesce((select sum(qty_change) from public.inventory_ledger g where g.item_id = i.id), 0)
       or i.value_on_hand <> coalesce((select sum(value_change) from public.inventory_ledger g where g.item_id = i.id), 0));
$$;

-- ---------------------------------------------------------------------------
-- Purge (synthetic clients) and privileges
-- ---------------------------------------------------------------------------
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
  delete from public.inventory_ledger where client_id = p_client_id;
  delete from public.inventory_movement_lines where client_id = p_client_id;
  delete from public.inventory_movements where client_id = p_client_id;
  delete from public.inventory_stock where client_id = p_client_id;
  delete from public.inventory_items where client_id = p_client_id;
  delete from public.inventory_locations where client_id = p_client_id;
  delete from public.inventory_settings where client_id = p_client_id;
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

revoke execute on all functions in schema private from public, anon;
revoke execute on function
  private.apply_stock_change(public.inventory_movements, smallint, uuid, uuid, numeric, numeric, boolean, smallint, smallint, boolean),
  private.inventory_out_value(public.inventory_items, numeric)
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.set_inventory_settings(uuid, uuid, uuid, uuid),
  public.apply_default_inventory_settings(uuid),
  public.set_negative_stock_policy(uuid, boolean, text),
  public.save_inventory_location(uuid, uuid, text, text, boolean),
  public.save_inventory_item(uuid, uuid, text, text, text, uuid, boolean),
  public.save_inventory_movement(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_inventory_movement(uuid),
  public.cancel_inventory_movement(uuid, text),
  public.inventory_valuation(uuid, date),
  public.inventory_stock_by_location(uuid, date),
  public.inventory_reconciliation(uuid, date),
  public.inventory_quantity_check(uuid)
from public, anon;
grant execute on function
  public.set_inventory_settings(uuid, uuid, uuid, uuid),
  public.apply_default_inventory_settings(uuid),
  public.set_negative_stock_policy(uuid, boolean, text),
  public.save_inventory_location(uuid, uuid, text, text, boolean),
  public.save_inventory_item(uuid, uuid, text, text, text, uuid, boolean),
  public.save_inventory_movement(uuid, uuid, integer, jsonb, jsonb, text),
  public.post_inventory_movement(uuid),
  public.cancel_inventory_movement(uuid, text),
  public.inventory_valuation(uuid, date),
  public.inventory_stock_by_location(uuid, date),
  public.inventory_reconciliation(uuid, date),
  public.inventory_quantity_check(uuid)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0029', 'inventory_functions') on conflict (version) do nothing;
