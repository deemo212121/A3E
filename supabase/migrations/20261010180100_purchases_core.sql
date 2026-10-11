-- Phase 8 (purchases, expenses, payables), part 2 of 3: tables, RLS.
--
-- Supplier bills, cash purchases and reimbursements are RECORDED from the
-- documents received; posting creates balanced journal entries through the
-- accounting engine (docs/purchases/POSTING-RULES.md).
--
-- NO tax rule is invented here:
--   * withholding codes (ATC, rate, base) are entered by the firm with their
--     legal basis, VERSIONED, and must be SIGNED OFF by a different person
--     before any bill using them can be posted; the table starts EMPTY;
--   * purchase categories (inventory / fixed asset / prepayment / expense ->
--     account) are the accountant's POLICY and must be approved before use;
--   * input VAT uses public.tax_rates (pending CPA sign-off), as in sales.

-- ---------------------------------------------------------------------------
-- Withholding tax codes (firm-wide, versioned, signed off)
-- ---------------------------------------------------------------------------
create table public.withholding_codes (
  id              uuid primary key default gen_random_uuid(),
  code            text not null check (code ~ '^[A-Z0-9]{2,12}$'),
  version         integer not null check (version >= 1),
  description     text not null check (char_length(description) between 3 and 300),
  rate            numeric(7, 6) not null check (rate > 0 and rate < 1),
  -- What the rate applies to; part of the rule, so it is signed off with it.
  base            text not null check (base in ('net_of_vat', 'gross')),
  legal_basis     text not null check (char_length(legal_basis) between 5 and 500),
  effective_from  date not null,
  effective_to    date,
  status          text not null default 'pending_signoff' check (status in ('pending_signoff', 'signed_off', 'retired')),
  entered_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at      timestamptz not null default now(),
  signed_off_by   uuid references public.profiles (id) on delete set null,
  signed_off_at   timestamptz,
  unique (code, version),
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'signed_off') <= (signed_off_by is not null)),
  check (signed_off_by is null or entered_by is null or signed_off_by <> entered_by)
);

-- ---------------------------------------------------------------------------
-- Per-client purchase policy: categories and posting accounts
-- ---------------------------------------------------------------------------
create table public.purchase_categories (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  name         text not null check (char_length(name) between 2 and 100),
  kind         public.purchase_kind not null,
  account_id   uuid not null,
  status       text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  proposed_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  approved_by  uuid references public.profiles (id) on delete set null,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (client_id, account_id) references public.accounts (client_id, id),
  unique (client_id, id),
  check (approved_by is null or proposed_by is null or approved_by <> proposed_by)
);
create unique index purchase_categories_unique_name on public.purchase_categories (client_id, lower(name))
  where status <> 'retired';

create table public.purchase_settings (
  client_id                    uuid primary key references public.clients (id) on delete cascade,
  ap_account_id                uuid not null,
  input_vat_account_id         uuid not null,
  withholding_payable_account_id uuid not null,
  supplier_advances_account_id uuid not null,
  -- Accountant policy: expense lines at or above this unit cost are flagged
  -- "may need capitalizing" for review. NULL = no flag.
  capitalization_threshold     numeric(18, 2) check (capitalization_threshold > 0),
  updated_by                   uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at                   timestamptz not null default now(),
  foreign key (client_id, ap_account_id) references public.accounts (client_id, id),
  foreign key (client_id, input_vat_account_id) references public.accounts (client_id, id),
  foreign key (client_id, withholding_payable_account_id) references public.accounts (client_id, id),
  foreign key (client_id, supplier_advances_account_id) references public.accounts (client_id, id)
);

insert into public.coa_template_accounts
  (template_code, code, name, account_type, normal_balance, parent_code, is_postable, sort_order)
values ('PH-SME-V0', '1130', 'Advances to Suppliers', 'asset', 'debit', '1000', true, 46)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Bills (supplier invoices, cash purchases, reimbursements)
-- ---------------------------------------------------------------------------
create table public.purchase_bills (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.clients (id) on delete cascade,
  bill_type               text not null check (bill_type in ('bill', 'cash_purchase', 'reimbursement')),
  counterparty_id         uuid not null,
  bill_no                 text not null check (char_length(bill_no) between 1 and 60),
  bill_date               date not null check (bill_date >= date '2000-01-01'),
  due_date                date not null,
  -- Cash purchases are paid on the spot from this account (no payable).
  paid_from_account_id    uuid,
  prices_include_vat      boolean not null default false,
  memo                    text check (char_length(memo) <= 500),
  status                  public.sales_doc_status not null default 'draft',
  vat_rate_code           text not null references public.tax_rates (code),
  vat_rate                numeric(7, 6) not null,
  vat_rate_status         text not null,
  net_amount              numeric(18, 2) not null default 0,
  vat_amount              numeric(18, 2) not null default 0,
  gross_amount            numeric(18, 2) not null default 0,
  withholding_amount      numeric(18, 2) not null default 0,
  payable_amount          numeric(18, 2) not null default 0,
  policy_flags            text[] not null default '{}',
  intake_transaction_id   uuid,
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
  foreign key (client_id, counterparty_id) references public.counterparties (client_id, id),
  foreign key (client_id, paid_from_account_id) references public.accounts (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, intake_transaction_id) references public.intake_transactions (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (due_date >= bill_date),
  check ((bill_type = 'cash_purchase') = (paid_from_account_id is not null)),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check (status <> 'posted' or journal_entry_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (gross_amount = net_amount + vat_amount),
  check (payable_amount = gross_amount - withholding_amount)
);
-- GATE: one live bill per supplier invoice number.
create unique index purchase_bills_unique_no on public.purchase_bills (client_id, counterparty_id, lower(bill_no))
  where status <> 'cancelled';
create unique index purchase_bills_unique_intake on public.purchase_bills (client_id, intake_transaction_id)
  where intake_transaction_id is not null and status <> 'cancelled';
create index purchase_bills_supplier_idx on public.purchase_bills (client_id, counterparty_id, bill_date);

create table public.purchase_bill_lines (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null,
  bill_id              uuid not null,
  line_no              smallint not null check (line_no between 1 and 500),
  description          text not null check (char_length(description) between 1 and 300),
  quantity             numeric(18, 4) not null check (quantity > 0),
  unit_price           numeric(18, 4) not null check (unit_price >= 0),
  discount_amount      numeric(18, 2) not null default 0 check (discount_amount >= 0),
  tax_class            public.sales_tax_class not null,
  -- For VAT-able lines: goods, services or capital goods (as the document shows).
  vat_category         text check (vat_category in ('goods', 'services', 'capital_goods')),
  category_id          uuid not null,
  kind                 public.purchase_kind not null,
  account_id           uuid not null,
  -- Original receipt details (reimbursements: each line can be another supplier's receipt).
  source_supplier_name text check (char_length(source_supplier_name) between 1 and 200),
  source_supplier_tin  text check (source_supplier_tin ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}(-[0-9]{3,5})?$'),
  source_document_ref  text check (char_length(source_document_ref) between 1 and 100),
  withholding_code_id  uuid references public.withholding_codes (id),
  withholding_rate     numeric(7, 6),
  withholding_base     numeric(18, 2),
  withholding_amount   numeric(18, 2) not null default 0 check (withholding_amount >= 0),
  line_amount          numeric(18, 2) not null check (line_amount > 0),
  net_amount           numeric(18, 2) not null,
  vat_amount           numeric(18, 2) not null check (vat_amount >= 0),
  foreign key (client_id, bill_id) references public.purchase_bills (client_id, id) on delete cascade,
  foreign key (client_id, category_id) references public.purchase_categories (client_id, id),
  foreign key (client_id, account_id) references public.accounts (client_id, id),
  unique (bill_id, line_no),
  check ((tax_class = 'vatable') = (vat_category is not null)),
  check ((withholding_code_id is null) = (withholding_rate is null and withholding_base is null and withholding_amount = 0))
);

create table public.purchase_bill_documents (
  client_id   uuid not null,
  bill_id     uuid not null,
  document_id uuid not null,
  primary key (bill_id, document_id),
  foreign key (client_id, bill_id) references public.purchase_bills (client_id, id) on delete cascade,
  foreign key (client_id, document_id) references public.documents (client_id, id)
);

-- ---------------------------------------------------------------------------
-- Supplier payments and their allocation to bills
-- ---------------------------------------------------------------------------
create table public.supplier_payments (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.clients (id) on delete cascade,
  counterparty_id         uuid not null,
  payment_no              text not null check (char_length(payment_no) between 1 and 60),
  payment_date            date not null check (payment_date >= date '2000-01-01'),
  payment_method          text not null check (payment_method in ('cash', 'check', 'bank_transfer', 'e_wallet', 'credit_card', 'other')),
  paid_from_account_id    uuid not null,
  amount_paid             numeric(18, 2) not null check (amount_paid > 0),
  reference               text check (char_length(reference) <= 100),
  memo                    text check (char_length(memo) <= 500),
  status                  public.sales_doc_status not null default 'draft',
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
  foreign key (client_id, counterparty_id) references public.counterparties (client_id, id),
  foreign key (client_id, paid_from_account_id) references public.accounts (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check (status <> 'posted' or journal_entry_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create unique index supplier_payments_unique_no on public.supplier_payments (client_id, lower(payment_no))
  where status <> 'cancelled';

create table public.supplier_payment_allocations (
  client_id  uuid not null,
  payment_id uuid not null,
  bill_id    uuid not null,
  amount     numeric(18, 2) not null check (amount > 0),
  primary key (payment_id, bill_id),
  foreign key (client_id, payment_id) references public.supplier_payments (client_id, id) on delete cascade,
  foreign key (client_id, bill_id) references public.purchase_bills (client_id, id)
);
create index supplier_payment_allocations_bill_idx on public.supplier_payment_allocations (bill_id);

-- ---------------------------------------------------------------------------
-- Guards (same rules as sales documents)
-- ---------------------------------------------------------------------------
create trigger purchase_bills_guard before update or delete on public.purchase_bills
  for each row execute function private.sales_doc_guard();
create trigger supplier_payments_guard before update or delete on public.supplier_payments
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
  end;
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % document cannot be changed', coalesce(v_status::text, 'missing')
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger purchase_bill_lines_guard before insert or update or delete on public.purchase_bill_lines
  for each row execute function private.sales_child_guard();
create trigger purchase_bill_documents_guard before insert or update or delete on public.purchase_bill_documents
  for each row execute function private.sales_child_guard();
create trigger supplier_payment_allocations_guard before insert or update or delete on public.supplier_payment_allocations
  for each row execute function private.sales_child_guard();

-- A signed-off withholding code is frozen (a change = a new version).
create function private.withholding_code_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'withholding codes cannot be deleted; retire them' using errcode = '42501';
  end if;
  if old.status <> 'pending_signoff'
     and (to_jsonb(new) - array['status', 'effective_to']) is distinct from (to_jsonb(old) - array['status', 'effective_to']) then
    raise exception 'a signed-off withholding code cannot be changed; add a new version' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger withholding_codes_guard before update or delete on public.withholding_codes
  for each row execute function private.withholding_code_guard();

create trigger purchase_bills_touch before update on public.purchase_bills
  for each row execute function private.touch_updated_at();
create trigger supplier_payments_touch before update on public.supplier_payments
  for each row execute function private.touch_updated_at();

create trigger audit_withholding_codes after insert or update or delete on public.withholding_codes
  for each row execute function audit.log_change();
create trigger audit_purchase_categories after insert or update or delete on public.purchase_categories
  for each row execute function audit.log_change();
create trigger audit_purchase_settings after insert or update or delete on public.purchase_settings
  for each row execute function audit.log_change();
create trigger audit_purchase_bills after insert or update or delete on public.purchase_bills
  for each row execute function audit.log_change();
create trigger audit_purchase_bill_lines after insert or update or delete on public.purchase_bill_lines
  for each row execute function audit.log_change();
create trigger audit_purchase_bill_documents after insert or update or delete on public.purchase_bill_documents
  for each row execute function audit.log_change();
create trigger audit_supplier_payments after insert or update or delete on public.supplier_payments
  for each row execute function audit.log_change();
create trigger audit_supplier_payment_allocations after insert or update or delete on public.supplier_payment_allocations
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- RLS: SELECT only. Withholding codes are readable by firm staff and by
-- users of any client (they appear on bills).
-- ---------------------------------------------------------------------------
revoke all on table public.withholding_codes, public.purchase_categories, public.purchase_settings,
  public.purchase_bills, public.purchase_bill_lines, public.purchase_bill_documents,
  public.supplier_payments, public.supplier_payment_allocations
from public, anon, authenticated;
grant select on table public.withholding_codes, public.purchase_categories, public.purchase_settings,
  public.purchase_bills, public.purchase_bill_lines, public.purchase_bill_documents,
  public.supplier_payments, public.supplier_payment_allocations
to authenticated;

alter table public.withholding_codes enable row level security;
alter table public.withholding_codes force row level security;
alter table public.purchase_categories enable row level security;
alter table public.purchase_categories force row level security;
alter table public.purchase_settings enable row level security;
alter table public.purchase_settings force row level security;
alter table public.purchase_bills enable row level security;
alter table public.purchase_bills force row level security;
alter table public.purchase_bill_lines enable row level security;
alter table public.purchase_bill_lines force row level security;
alter table public.purchase_bill_documents enable row level security;
alter table public.purchase_bill_documents force row level security;
alter table public.supplier_payments enable row level security;
alter table public.supplier_payments force row level security;
alter table public.supplier_payment_allocations enable row level security;
alter table public.supplier_payment_allocations force row level security;

create policy withholding_codes_select on public.withholding_codes for select to authenticated
  using (private.is_active_user());
create policy purchase_categories_select on public.purchase_categories for select to authenticated
  using (private.can_read_client(client_id));
create policy purchase_settings_select on public.purchase_settings for select to authenticated
  using (private.can_read_client(client_id));
create policy purchase_bills_select on public.purchase_bills for select to authenticated
  using (private.can_read_client(client_id));
create policy purchase_bill_lines_select on public.purchase_bill_lines for select to authenticated
  using (private.can_read_client(client_id));
create policy purchase_bill_documents_select on public.purchase_bill_documents for select to authenticated
  using (private.can_read_client(client_id));
create policy supplier_payments_select on public.supplier_payments for select to authenticated
  using (private.can_read_client(client_id));
create policy supplier_payment_allocations_select on public.supplier_payment_allocations for select to authenticated
  using (private.can_read_client(client_id));

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010180100', 'purchases_core') on conflict (version) do nothing;
