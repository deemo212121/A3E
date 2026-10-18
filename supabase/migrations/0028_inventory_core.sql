-- Phase 9 (inventory and cost of goods sold), part 2 of 3: tables, RLS.
--
-- Costing: moving weighted average, perpetual (PROPOSED, PENDING
-- VERIFICATION; docs/inventory/COSTING-METHOD.md). The stock ledger
-- (inventory_ledger) is the source of truth for quantities and values; item
-- and location balances are maintained from it under row locks.

create table public.inventory_settings (
  client_id                  uuid primary key references public.clients (id) on delete cascade,
  cogs_account_id            uuid not null,
  adjustment_account_id      uuid not null,
  supplier_return_account_id uuid not null,
  costing_method             text not null default 'weighted_average' check (costing_method in ('weighted_average')),
  costing_status             text not null default 'pending_verification'
                               check (costing_status in ('pending_verification', 'verified')),
  -- Negative stock is refused unless a reviewer/manager approves this policy.
  allow_negative_stock       boolean not null default false,
  negative_stock_reason      text check (char_length(negative_stock_reason) <= 500),
  negative_stock_approved_by uuid references public.profiles (id) on delete set null,
  negative_stock_approved_at timestamptz,
  updated_by                 uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at                 timestamptz not null default now(),
  foreign key (client_id, cogs_account_id) references public.accounts (client_id, id),
  foreign key (client_id, adjustment_account_id) references public.accounts (client_id, id),
  foreign key (client_id, supplier_return_account_id) references public.accounts (client_id, id),
  check (not allow_negative_stock or (negative_stock_approved_by is not null and negative_stock_reason is not null))
);

create table public.inventory_locations (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  code       text not null check (code ~ '^[A-Za-z0-9._-]{1,20}$'),
  name       text not null check (char_length(name) between 1 and 100),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (client_id, id)
);
create unique index inventory_locations_unique_code on public.inventory_locations (client_id, lower(code));

create table public.inventory_items (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id) on delete cascade,
  sku                  text not null check (sku ~ '^[A-Za-z0-9._/-]{1,40}$'),
  name                 text not null check (char_length(name) between 1 and 200),
  unit                 text not null check (char_length(unit) between 1 and 20),
  inventory_account_id uuid not null,
  is_active            boolean not null default true,
  -- Maintained by posting (company-wide, all locations).
  qty_on_hand          numeric(18, 4) not null default 0,
  value_on_hand        numeric(18, 2) not null default 0,
  last_unit_cost       numeric(18, 6),
  last_movement_date   date,
  created_by           uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at           timestamptz not null default now(),
  foreign key (client_id, inventory_account_id) references public.accounts (client_id, id),
  unique (client_id, id)
);
create unique index inventory_items_unique_sku on public.inventory_items (client_id, lower(sku));

create table public.inventory_stock (
  client_id   uuid not null,
  item_id     uuid not null,
  location_id uuid not null,
  quantity    numeric(18, 4) not null default 0,
  primary key (item_id, location_id),
  foreign key (client_id, item_id) references public.inventory_items (client_id, id) on delete cascade,
  foreign key (client_id, location_id) references public.inventory_locations (client_id, id)
);

create table public.inventory_movements (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.clients (id) on delete cascade,
  movement_type           public.inventory_movement_type not null,
  movement_date           date not null check (movement_date >= date '2000-01-01'),
  status                  public.sales_doc_status not null default 'draft',
  purchase_bill_id        uuid,
  sales_invoice_id        uuid,
  offset_account_id       uuid,
  reason                  text check (char_length(reason) <= 500),
  memo                    text check (char_length(memo) <= 500),
  total_value             numeric(18, 2),
  row_version             integer not null default 1,
  idempotency_key         text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by             uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_at            timestamptz,
  review_comment          text check (char_length(review_comment) <= 1000),
  posted_by               uuid references public.profiles (id) on delete set null,
  posted_at               timestamptz,
  journal_entry_id        uuid,
  cancelled_by            uuid references public.profiles (id) on delete set null,
  cancelled_at            timestamptz,
  cancel_reason           text check (char_length(cancel_reason) <= 500),
  cancel_journal_entry_id uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  foreign key (client_id, purchase_bill_id) references public.purchase_bills (client_id, id),
  foreign key (client_id, sales_invoice_id) references public.sales_invoices (client_id, id),
  foreign key (client_id, offset_account_id) references public.accounts (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (purchase_bill_id is null or movement_type = 'receipt'),
  check (sales_invoice_id is null or movement_type in ('issue', 'customer_return')),
  check (movement_type <> 'customer_return' or sales_invoice_id is not null),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index inventory_movements_client_idx on public.inventory_movements (client_id, movement_date);

create table public.inventory_movement_lines (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null,
  movement_id     uuid not null,
  line_no         smallint not null check (line_no between 1 and 500),
  item_id         uuid not null,
  location_id     uuid not null,
  to_location_id  uuid,
  -- Positive, except adjustments (signed count difference, never zero).
  quantity        numeric(18, 4) not null check (quantity <> 0),
  -- Cost per unit for unlinked receipts and stock-up adjustments (input).
  unit_cost       numeric(18, 4) check (unit_cost >= 0),
  bill_line_no    smallint,
  invoice_line_no smallint,
  foreign key (client_id, movement_id) references public.inventory_movements (client_id, id) on delete cascade,
  foreign key (client_id, item_id) references public.inventory_items (client_id, id),
  foreign key (client_id, location_id) references public.inventory_locations (client_id, id),
  foreign key (client_id, to_location_id) references public.inventory_locations (client_id, id),
  unique (movement_id, line_no),
  check (to_location_id is null or to_location_id <> location_id)
);

-- The stock ledger: one row per quantity/value change (append-only).
create table public.inventory_ledger (
  id               bigint generated always as identity primary key,
  client_id        uuid not null,
  item_id          uuid not null,
  location_id      uuid not null,
  movement_id      uuid not null,
  line_no          smallint not null,
  entry_date       date not null,
  movement_type    public.inventory_movement_type not null,
  is_reversal      boolean not null default false,
  qty_change       numeric(18, 4) not null,
  value_change     numeric(18, 2) not null,
  unit_cost        numeric(18, 6),
  purchase_bill_id uuid,
  bill_line_no     smallint,
  sales_invoice_id uuid,
  invoice_line_no  smallint,
  created_at       timestamptz not null default now(),
  foreign key (client_id, item_id) references public.inventory_items (client_id, id),
  foreign key (client_id, location_id) references public.inventory_locations (client_id, id),
  foreign key (client_id, movement_id) references public.inventory_movements (client_id, id)
);
create index inventory_ledger_item_idx on public.inventory_ledger (client_id, item_id, entry_date, id);
create index inventory_ledger_bill_idx on public.inventory_ledger (purchase_bill_id, bill_line_no) where purchase_bill_id is not null;
create index inventory_ledger_invoice_idx on public.inventory_ledger (sales_invoice_id, invoice_line_no) where sales_invoice_id is not null;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
-- total_value is set at posting, so it joins the workflow columns.
create or replace function private.sales_doc_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_workflow text[] := array['status', 'row_version', 'submitted_at', 'review_comment', 'posted_by',
    'posted_at', 'journal_entry_id', 'cancelled_by', 'cancelled_at', 'cancel_reason',
    'cancel_journal_entry_id', 'updated_at', 'total_value'];
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'sales documents cannot be deleted; cancel them instead' using errcode = '42501';
  end if;
  if new.client_id <> old.client_id then
    raise exception 'client_id cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'cancelled' then
    raise exception 'a cancelled document cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'draft' and (to_jsonb(new) - v_workflow) is distinct from (to_jsonb(old) - v_workflow) then
    raise exception 'a % document cannot be edited', old.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger inventory_movements_guard before update or delete on public.inventory_movements
  for each row execute function private.sales_doc_guard();

create or replace function private.sales_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.sales_doc_status;
  v_row jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_status := case tg_table_name
    when 'sales_invoice_lines' then (select status from public.sales_invoices where id = (v_row ->> 'invoice_id')::uuid)
    when 'sales_credit_note_lines' then (select status from public.sales_credit_notes where id = (v_row ->> 'credit_note_id')::uuid)
    when 'sales_receipt_allocations' then (select status from public.sales_receipts where id = (v_row ->> 'receipt_id')::uuid)
    when 'purchase_bill_lines' then (select status from public.purchase_bills where id = (v_row ->> 'bill_id')::uuid)
    when 'purchase_bill_documents' then (select status from public.purchase_bills where id = (v_row ->> 'bill_id')::uuid)
    when 'supplier_payment_allocations' then (select status from public.supplier_payments where id = (v_row ->> 'payment_id')::uuid)
    when 'inventory_movement_lines' then (select status from public.inventory_movements where id = (v_row ->> 'movement_id')::uuid)
  end;
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % document cannot be changed', coalesce(v_status::text, 'missing')
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger inventory_movement_lines_guard before insert or update or delete on public.inventory_movement_lines
  for each row execute function private.sales_child_guard();

create trigger inventory_ledger_append_only before update or delete on public.inventory_ledger
  for each row execute function private.intake_append_only();

-- An item's account never changes once it has stock history.
create function private.inventory_item_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'items cannot be deleted; deactivate them' using errcode = '42501';
  end if;
  if new.inventory_account_id <> old.inventory_account_id
     and exists (select 1 from public.inventory_ledger where item_id = old.id) then
    raise exception 'the inventory account cannot change once the item has stock movements' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger inventory_items_guard before update or delete on public.inventory_items
  for each row execute function private.inventory_item_guard();

-- A posted bill or invoice with stock linked to it cannot be cancelled until
-- that stock movement is cancelled (keeps stock, valuation and ledger aligned).
create function private.block_cancel_with_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status = 'posted' and exists (
       select 1 from public.inventory_movements m
        where m.status = 'posted'
          and ((tg_table_name = 'purchase_bills' and m.purchase_bill_id = old.id)
            or (tg_table_name = 'sales_invoices' and m.sales_invoice_id = old.id))) then
    raise exception 'stock movements are linked to this document; cancel them first' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger purchase_bills_stock_guard before update of status on public.purchase_bills
  for each row execute function private.block_cancel_with_stock();
create trigger sales_invoices_stock_guard before update of status on public.sales_invoices
  for each row execute function private.block_cancel_with_stock();

create trigger inventory_movements_touch before update on public.inventory_movements
  for each row execute function private.touch_updated_at();

create trigger audit_inventory_settings after insert or update or delete on public.inventory_settings
  for each row execute function audit.log_change();
create trigger audit_inventory_locations after insert or update or delete on public.inventory_locations
  for each row execute function audit.log_change();
create trigger audit_inventory_items after insert or update or delete on public.inventory_items
  for each row execute function audit.log_change();
create trigger audit_inventory_movements after insert or update or delete on public.inventory_movements
  for each row execute function audit.log_change();
create trigger audit_inventory_movement_lines after insert or update or delete on public.inventory_movement_lines
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- RLS: SELECT only for users who can read the client.
-- ---------------------------------------------------------------------------
revoke all on table public.inventory_settings, public.inventory_locations, public.inventory_items,
  public.inventory_stock, public.inventory_movements, public.inventory_movement_lines, public.inventory_ledger
from public, anon, authenticated;
grant select on table public.inventory_settings, public.inventory_locations, public.inventory_items,
  public.inventory_stock, public.inventory_movements, public.inventory_movement_lines, public.inventory_ledger
to authenticated;

alter table public.inventory_settings enable row level security;
alter table public.inventory_settings force row level security;
alter table public.inventory_locations enable row level security;
alter table public.inventory_locations force row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_items force row level security;
alter table public.inventory_stock enable row level security;
alter table public.inventory_stock force row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_movements force row level security;
alter table public.inventory_movement_lines enable row level security;
alter table public.inventory_movement_lines force row level security;
alter table public.inventory_ledger enable row level security;
alter table public.inventory_ledger force row level security;

create policy inventory_settings_select on public.inventory_settings for select to authenticated using (private.can_read_client(client_id));
create policy inventory_locations_select on public.inventory_locations for select to authenticated using (private.can_read_client(client_id));
create policy inventory_items_select on public.inventory_items for select to authenticated using (private.can_read_client(client_id));
create policy inventory_stock_select on public.inventory_stock for select to authenticated using (private.can_read_client(client_id));
create policy inventory_movements_select on public.inventory_movements for select to authenticated using (private.can_read_client(client_id));
create policy inventory_movement_lines_select on public.inventory_movement_lines for select to authenticated using (private.can_read_client(client_id));
create policy inventory_ledger_select on public.inventory_ledger for select to authenticated using (private.can_read_client(client_id));

insert into supabase_migrations.schema_migrations (version, name)
values ('0028', 'inventory_core') on conflict (version) do nothing;
