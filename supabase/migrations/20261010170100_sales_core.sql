-- Phase 7 (sales and receivables), part 2 of 3: tables, RLS, settings.
--
-- The platform RECORDS sales invoices the client issued elsewhere (decision
-- D-01: no invoice issuance, no e-invoice transmission). Invoice numbers are
-- the client's own. Posting creates balanced journal entries through the
-- accounting engine (posting rules: docs/sales/POSTING-RULES.md).
--
-- Tax: the VAT rate comes from public.tax_rates, which records its legal basis
-- and a verification status. It is PENDING CPA SIGN-OFF; every document stores
-- the rate and status it used. Nothing here claims BIR compliance.

-- ---------------------------------------------------------------------------
-- Tax rate registry (minimal; the full rule registry is a later phase)
-- ---------------------------------------------------------------------------
create table public.tax_rates (
  code                text primary key check (code ~ '^[A-Z0-9_]{2,40}$'),
  description         text not null,
  rate                numeric(7, 6) not null check (rate >= 0 and rate < 1),
  legal_basis         text not null,
  verification_status text not null check (verification_status in ('pending_signoff', 'signed_off', 'retired')),
  signed_off_by       text,
  signed_off_at       date,
  created_at          timestamptz not null default now(),
  check ((verification_status = 'signed_off') = (signed_off_by is not null and signed_off_at is not null))
);
insert into public.tax_rates (code, description, rate, legal_basis, verification_status) values
  ('VAT_STANDARD', 'Value-added tax on sales of goods and services (standard rate)', 0.12,
   'NIRC Secs. 106 and 108, as amended by RA 9337. Not verified against the primary text in Phase 1; CPA to confirm.',
   'pending_signoff');

-- ---------------------------------------------------------------------------
-- Per-client account mapping used by the posting rules
-- ---------------------------------------------------------------------------
create table public.sales_settings (
  client_id                   uuid primary key references public.clients (id) on delete cascade,
  ar_account_id               uuid not null,
  sales_account_id            uuid not null,
  output_vat_account_id       uuid not null,
  sales_returns_account_id    uuid not null,
  cwt_account_id              uuid not null,
  customer_advances_account_id uuid not null,
  updated_by                  uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at                  timestamptz not null default now(),
  foreign key (client_id, ar_account_id) references public.accounts (client_id, id),
  foreign key (client_id, sales_account_id) references public.accounts (client_id, id),
  foreign key (client_id, output_vat_account_id) references public.accounts (client_id, id),
  foreign key (client_id, sales_returns_account_id) references public.accounts (client_id, id),
  foreign key (client_id, cwt_account_id) references public.accounts (client_id, id),
  foreign key (client_id, customer_advances_account_id) references public.accounts (client_id, id)
);

-- New starter-template account for customer overpayments/advances (PROPOSED).
insert into public.coa_template_accounts
  (template_code, code, name, account_type, normal_balance, parent_code, is_postable, sort_order)
values ('PH-SME-V0', '2040', 'Advances from Customers', 'liability', 'credit', '2000', true, 226)
on conflict do nothing;

-- Customer credit terms (default due date for credit sales).
alter table public.counterparties
  add column credit_terms_days smallint check (credit_terms_days between 0 and 365);

-- ---------------------------------------------------------------------------
-- Sales invoices (records of invoices the client issued)
-- ---------------------------------------------------------------------------
create table public.sales_invoices (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients (id) on delete cascade,
  counterparty_id        uuid not null,
  invoice_no             text not null check (char_length(invoice_no) between 1 and 60),
  invoice_date           date not null check (invoice_date >= date '2000-01-01'),
  due_date               date not null,
  sale_type              text not null check (sale_type in ('cash', 'credit')),
  prices_include_vat     boolean not null default false,
  memo                   text check (char_length(memo) <= 500),
  status                 public.sales_doc_status not null default 'draft',
  vat_rate_code          text not null references public.tax_rates (code),
  vat_rate               numeric(7, 6) not null,
  vat_rate_status        text not null,
  -- Totals, computed by the database from the lines (never typed in).
  gross_amount           numeric(18, 2) not null default 0,
  discount_amount        numeric(18, 2) not null default 0,
  vatable_sales          numeric(18, 2) not null default 0,
  zero_rated_sales       numeric(18, 2) not null default 0,
  exempt_sales           numeric(18, 2) not null default 0,
  not_subject_sales      numeric(18, 2) not null default 0,
  vat_amount             numeric(18, 2) not null default 0,
  total_amount           numeric(18, 2) not null default 0,
  intake_transaction_id  uuid,
  row_version            integer not null default 1,
  idempotency_key        text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_at           timestamptz,
  review_comment         text check (char_length(review_comment) <= 1000),
  posted_by              uuid references public.profiles (id) on delete set null,
  posted_at              timestamptz,
  journal_entry_id       uuid,
  cancelled_by           uuid references public.profiles (id) on delete set null,
  cancelled_at           timestamptz,
  cancel_reason          text check (char_length(cancel_reason) <= 500),
  cancel_journal_entry_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (client_id, counterparty_id) references public.counterparties (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, intake_transaction_id) references public.intake_transactions (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (due_date >= invoice_date),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check (status <> 'posted' or journal_entry_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (total_amount = vatable_sales + zero_rated_sales + exempt_sales + not_subject_sales + vat_amount)
);
-- One live record per invoice number of the client's series.
create unique index sales_invoices_unique_no on public.sales_invoices (client_id, lower(invoice_no))
  where status <> 'cancelled';
-- An intake transaction becomes at most one live invoice.
create unique index sales_invoices_unique_intake on public.sales_invoices (client_id, intake_transaction_id)
  where intake_transaction_id is not null and status <> 'cancelled';
create index sales_invoices_customer_idx on public.sales_invoices (client_id, counterparty_id, invoice_date);

create table public.sales_invoice_lines (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null,
  invoice_id         uuid not null,
  line_no            smallint not null check (line_no between 1 and 500),
  description        text not null check (char_length(description) between 1 and 300),
  quantity           numeric(18, 4) not null check (quantity > 0),
  unit_price         numeric(18, 4) not null check (unit_price >= 0),
  discount_amount    numeric(18, 2) not null default 0 check (discount_amount >= 0),
  tax_class          public.sales_tax_class not null,
  revenue_account_id uuid,
  -- Computed: round(qty x price, 2) - discount; then net and VAT.
  line_amount        numeric(18, 2) not null check (line_amount > 0),
  net_amount         numeric(18, 2) not null,
  vat_amount         numeric(18, 2) not null check (vat_amount >= 0),
  foreign key (client_id, invoice_id) references public.sales_invoices (client_id, id) on delete cascade,
  foreign key (client_id, revenue_account_id) references public.accounts (client_id, id),
  unique (invoice_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Credit notes (returns, price adjustments, discounts, corrections)
-- ---------------------------------------------------------------------------
create table public.sales_credit_notes (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients (id) on delete cascade,
  invoice_id             uuid not null,
  credit_note_no         text not null check (char_length(credit_note_no) between 1 and 60),
  credit_date            date not null,
  reason_type            text not null check (reason_type in ('return', 'price_adjustment', 'discount', 'correction')),
  reason                 text not null check (char_length(reason) between 3 and 500),
  status                 public.sales_doc_status not null default 'draft',
  net_amount             numeric(18, 2) not null default 0,
  vat_amount             numeric(18, 2) not null default 0,
  total_amount           numeric(18, 2) not null default 0,
  row_version            integer not null default 1,
  idempotency_key        text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_at           timestamptz,
  review_comment         text check (char_length(review_comment) <= 1000),
  posted_by              uuid references public.profiles (id) on delete set null,
  posted_at              timestamptz,
  journal_entry_id       uuid,
  cancelled_by           uuid references public.profiles (id) on delete set null,
  cancelled_at           timestamptz,
  cancel_reason          text check (char_length(cancel_reason) <= 500),
  cancel_journal_entry_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (client_id, invoice_id) references public.sales_invoices (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check (status <> 'posted' or journal_entry_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (total_amount = net_amount + vat_amount)
);
create unique index sales_credit_notes_unique_no on public.sales_credit_notes (client_id, lower(credit_note_no))
  where status <> 'cancelled';

create table public.sales_credit_note_lines (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  credit_note_id uuid not null,
  line_no        smallint not null check (line_no between 1 and 500),
  description    text not null check (char_length(description) between 1 and 300),
  tax_class      public.sales_tax_class not null,
  line_amount    numeric(18, 2) not null check (line_amount > 0),
  net_amount     numeric(18, 2) not null,
  vat_amount     numeric(18, 2) not null check (vat_amount >= 0),
  foreign key (client_id, credit_note_id) references public.sales_credit_notes (client_id, id) on delete cascade,
  unique (credit_note_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Customer receipts and their allocation to invoices
-- ---------------------------------------------------------------------------
create table public.sales_receipts (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients (id) on delete cascade,
  counterparty_id        uuid not null,
  receipt_no             text not null check (char_length(receipt_no) between 1 and 60),
  receipt_date           date not null check (receipt_date >= date '2000-01-01'),
  payment_method         text not null check (payment_method in ('cash', 'check', 'bank_transfer', 'e_wallet', 'credit_card', 'other')),
  deposit_account_id     uuid not null,
  amount_received        numeric(18, 2) not null check (amount_received >= 0),
  -- Tax withheld by the customer, as stated on its certificate (not computed).
  withholding_amount     numeric(18, 2) not null default 0 check (withholding_amount >= 0),
  reference              text check (char_length(reference) <= 100),
  memo                   text check (char_length(memo) <= 500),
  status                 public.sales_doc_status not null default 'draft',
  row_version            integer not null default 1,
  idempotency_key        text not null check (char_length(idempotency_key) between 8 and 200),
  prepared_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_at           timestamptz,
  review_comment         text check (char_length(review_comment) <= 1000),
  posted_by              uuid references public.profiles (id) on delete set null,
  posted_at              timestamptz,
  journal_entry_id       uuid,
  cancelled_by           uuid references public.profiles (id) on delete set null,
  cancelled_at           timestamptz,
  cancel_reason          text check (char_length(cancel_reason) <= 500),
  cancel_journal_entry_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (client_id, counterparty_id) references public.counterparties (client_id, id),
  foreign key (client_id, deposit_account_id) references public.accounts (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  foreign key (client_id, cancel_journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (amount_received + withholding_amount > 0),
  check (posted_by is null or prepared_by is null or posted_by <> prepared_by),
  check (status <> 'posted' or journal_entry_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
-- Duplicate receipts: one live record per receipt number of the client.
create unique index sales_receipts_unique_no on public.sales_receipts (client_id, lower(receipt_no))
  where status <> 'cancelled';

create table public.sales_receipt_allocations (
  client_id  uuid not null,
  receipt_id uuid not null,
  invoice_id uuid not null,
  amount     numeric(18, 2) not null check (amount > 0),
  primary key (receipt_id, invoice_id),
  foreign key (client_id, receipt_id) references public.sales_receipts (client_id, id) on delete cascade,
  foreign key (client_id, invoice_id) references public.sales_invoices (client_id, id)
);
create index sales_receipt_allocations_invoice_idx on public.sales_receipt_allocations (invoice_id);

-- ---------------------------------------------------------------------------
-- Guards: posted/cancelled documents are immutable except their workflow
-- columns; lines and allocations change only while the document is a draft.
-- ---------------------------------------------------------------------------
create function private.sales_doc_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_workflow text[] := array['status', 'row_version', 'submitted_at', 'review_comment', 'posted_by',
    'posted_at', 'journal_entry_id', 'cancelled_by', 'cancelled_at', 'cancel_reason',
    'cancel_journal_entry_id', 'updated_at'];
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
create trigger sales_invoices_guard before update or delete on public.sales_invoices
  for each row execute function private.sales_doc_guard();
create trigger sales_credit_notes_guard before update or delete on public.sales_credit_notes
  for each row execute function private.sales_doc_guard();
create trigger sales_receipts_guard before update or delete on public.sales_receipts
  for each row execute function private.sales_doc_guard();

create function private.sales_child_guard() returns trigger
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
  end;
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % document cannot be changed', coalesce(v_status::text, 'missing')
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger sales_invoice_lines_guard before insert or update or delete on public.sales_invoice_lines
  for each row execute function private.sales_child_guard();
create trigger sales_credit_note_lines_guard before insert or update or delete on public.sales_credit_note_lines
  for each row execute function private.sales_child_guard();
create trigger sales_receipt_allocations_guard before insert or update or delete on public.sales_receipt_allocations
  for each row execute function private.sales_child_guard();

create trigger sales_invoices_touch before update on public.sales_invoices
  for each row execute function private.touch_updated_at();
create trigger sales_credit_notes_touch before update on public.sales_credit_notes
  for each row execute function private.touch_updated_at();
create trigger sales_receipts_touch before update on public.sales_receipts
  for each row execute function private.touch_updated_at();

create trigger audit_sales_settings after insert or update or delete on public.sales_settings
  for each row execute function audit.log_change();
create trigger audit_sales_invoices after insert or update or delete on public.sales_invoices
  for each row execute function audit.log_change();
create trigger audit_sales_invoice_lines after insert or update or delete on public.sales_invoice_lines
  for each row execute function audit.log_change();
create trigger audit_sales_credit_notes after insert or update or delete on public.sales_credit_notes
  for each row execute function audit.log_change();
create trigger audit_sales_credit_note_lines after insert or update or delete on public.sales_credit_note_lines
  for each row execute function audit.log_change();
create trigger audit_sales_receipts after insert or update or delete on public.sales_receipts
  for each row execute function audit.log_change();
create trigger audit_sales_receipt_allocations after insert or update or delete on public.sales_receipt_allocations
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- RLS: SELECT only, for users who can read the client. Writes go through
-- functions (20261010170200). tax_rates is reference data readable by all
-- signed-in users.
-- ---------------------------------------------------------------------------
revoke all on table public.tax_rates, public.sales_settings, public.sales_invoices, public.sales_invoice_lines,
  public.sales_credit_notes, public.sales_credit_note_lines, public.sales_receipts,
  public.sales_receipt_allocations
from public, anon, authenticated;
grant select on table public.tax_rates, public.sales_settings, public.sales_invoices, public.sales_invoice_lines,
  public.sales_credit_notes, public.sales_credit_note_lines, public.sales_receipts,
  public.sales_receipt_allocations
to authenticated;

alter table public.tax_rates enable row level security;
alter table public.tax_rates force row level security;
alter table public.sales_settings enable row level security;
alter table public.sales_settings force row level security;
alter table public.sales_invoices enable row level security;
alter table public.sales_invoices force row level security;
alter table public.sales_invoice_lines enable row level security;
alter table public.sales_invoice_lines force row level security;
alter table public.sales_credit_notes enable row level security;
alter table public.sales_credit_notes force row level security;
alter table public.sales_credit_note_lines enable row level security;
alter table public.sales_credit_note_lines force row level security;
alter table public.sales_receipts enable row level security;
alter table public.sales_receipts force row level security;
alter table public.sales_receipt_allocations enable row level security;
alter table public.sales_receipt_allocations force row level security;

create policy tax_rates_select on public.tax_rates for select to authenticated using (true);
create policy sales_settings_select on public.sales_settings for select to authenticated
  using (private.can_read_client(client_id));
create policy sales_invoices_select on public.sales_invoices for select to authenticated
  using (private.can_read_client(client_id));
create policy sales_invoice_lines_select on public.sales_invoice_lines for select to authenticated
  using (private.can_read_client(client_id));
create policy sales_credit_notes_select on public.sales_credit_notes for select to authenticated
  using (private.can_read_client(client_id));
create policy sales_credit_note_lines_select on public.sales_credit_note_lines for select to authenticated
  using (private.can_read_client(client_id));
create policy sales_receipts_select on public.sales_receipts for select to authenticated
  using (private.can_read_client(client_id));
create policy sales_receipt_allocations_select on public.sales_receipt_allocations for select to authenticated
  using (private.can_read_client(client_id));

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010170100', 'sales_core') on conflict (version) do nothing;
