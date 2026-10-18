-- Phase 6: client portal and standardized data intake (schema).
--
-- Canonical intake records that later sales, purchase, expense, inventory and
-- payroll modules reuse:
--   business_profiles          versioned business profile (as declared by the client)
--   counterparties             customers and suppliers
--   documents                  private files in Storage (bucket client-documents)
--   intake_transactions(+lines) one generic transaction schema for every kind
--   intake_events              append-only status history (submission tracking)
--   intake_comments            accountant feedback and replies (append-only)
--
-- Nothing here posts to the ledger. Intake data reaches the books only when an
-- APPROVED transaction is booked through a journal entry that itself passes
-- maker-checker (see 0018).
--
-- Writes happen ONLY through SECURITY DEFINER functions (0016);
-- authenticated users get SELECT, filtered by RLS. Tax-related fields are
-- recorded "as stated on the document"; nothing is computed.

create type public.intake_status as enum
  ('draft', 'submitted', 'needs_correction', 'reviewed', 'approved', 'rejected', 'posted', 'cancelled');
create type public.intake_subject as enum
  ('business_profile', 'counterparty', 'transaction', 'document', 'import_batch');
create type public.counterparty_kind as enum ('customer', 'supplier', 'both');
-- As DECLARED by the client; not verified against BIR registration.
create type public.declared_vat_status as enum ('vat_registered', 'non_vat', 'unknown');
create type public.intake_txn_kind as enum
  ('sale', 'purchase', 'expense', 'collection', 'payment', 'payroll', 'inventory', 'other');
create type public.document_category as enum
  ('sales_invoice', 'official_receipt', 'purchase_invoice', 'expense_receipt', 'bank_statement',
   'certificate_2307', 'payroll', 'registration', 'import_source', 'other');
create type public.document_review as enum ('pending', 'accepted', 'needs_correction', 'rejected');

-- ---------------------------------------------------------------------------
-- Authorization helpers (caller derived from auth.uid() only)
-- ---------------------------------------------------------------------------
-- Create, edit and submit intake records: assigned staff, client owner/staff.
create function private.can_submit_intake(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.is_assigned(p_client_id)
          and private.firm_role() in ('firm_manager', 'reviewer', 'accountant', 'bookkeeper'))
      or coalesce(private.client_role(p_client_id) in ('client_owner', 'client_staff'), false);
$$;

-- Review (check, request correction, mark reviewed): assigned firm staff.
create function private.can_review_intake(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_prepare_entries(p_client_id);
$$;

-- Approve or reject: assigned reviewer, or a manager.
create function private.can_approve_intake(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_approve_entries(p_client_id);
$$;

-- Business profile changes: client owner (propose) or manager/reviewer/accountant (doc 02).
create function private.can_propose_profile(p_client_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.is_assigned(p_client_id)
          and private.firm_role() in ('firm_manager', 'reviewer', 'accountant'))
      or coalesce(private.client_role(p_client_id) = 'client_owner', false);
$$;

create function private.today_ph() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Manila')::date;
$$;

-- Strict decimal parser for quantities and unit prices (up to 4 decimals).
create function private.parse_decimal4(p_text text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  if btrim(p_text) !~ '^[0-9]{1,14}(\.[0-9]{1,4})?$' then
    raise exception 'invalid number "%": use digits with up to 4 decimal places', left(p_text, 30)
      using errcode = '22023';
  end if;
  return btrim(p_text)::numeric;
end;
$$;

-- Same normalization for every name used in duplicate detection.
create function private.name_key(p_name text) returns text
language sql immutable set search_path = '' as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '');
$$;

-- ---------------------------------------------------------------------------
-- Business profiles (versioned; the latest APPROVED version is current)
-- ---------------------------------------------------------------------------
create table public.business_profiles (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients (id) on delete cascade,
  version               integer not null check (version >= 1),
  status                public.intake_status not null default 'draft'
                          check (status in ('draft', 'submitted', 'needs_correction', 'approved', 'rejected', 'cancelled')),
  registered_name       text check (char_length(registered_name) between 1 and 200),
  trade_name            text check (char_length(trade_name) between 1 and 200),
  tin                   text check (tin ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}(-[0-9]{3,5})?$'),
  rdo_code              text check (rdo_code ~ '^[0-9]{2,3}[A-Z]?$'),
  business_type         text check (business_type in ('sole_proprietorship', 'partnership', 'corporation',
                                                      'one_person_corporation', 'cooperative', 'other')),
  vat_status            public.declared_vat_status,
  registered_address    text check (char_length(registered_address) between 1 and 500),
  zip_code              text check (zip_code ~ '^[0-9]{4}$'),
  line_of_business      text check (char_length(line_of_business) between 1 and 200),
  fiscal_year_end_month smallint check (fiscal_year_end_month between 1 and 12),
  contact_email         text check (char_length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  contact_phone         text check (contact_phone ~ '^[0-9+() -]{7,20}$'),
  notes                 text check (char_length(notes) <= 1000),
  row_version           integer not null default 1,
  idempotency_key       text not null check (char_length(idempotency_key) between 8 and 200),
  created_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_by          uuid references public.profiles (id) on delete set null,
  submitted_at          timestamptz,
  decided_by            uuid references public.profiles (id) on delete set null,
  decided_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (client_id, version),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  -- Maker-checker: whoever submitted a profile change cannot approve it.
  check (status <> 'approved' or decided_by is null or submitted_by is null or decided_by <> submitted_by)
);
-- At most one change in progress per client.
create unique index business_profiles_one_open on public.business_profiles (client_id)
  where status in ('draft', 'submitted', 'needs_correction');

-- ---------------------------------------------------------------------------
-- Counterparties (customers and suppliers)
-- ---------------------------------------------------------------------------
create table public.counterparties (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  kind            public.counterparty_kind not null,
  registered_name text not null check (char_length(registered_name) between 1 and 200),
  name_key        text generated always as (private.name_key(registered_name)) stored,
  tin             text check (tin ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}(-[0-9]{3,5})?$'),
  vat_status      public.declared_vat_status not null default 'unknown',
  address         text check (char_length(address) between 1 and 500),
  email           text check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone           text check (phone ~ '^[0-9+() -]{7,20}$'),
  status          public.intake_status not null default 'draft'
                    check (status in ('draft', 'submitted', 'needs_correction', 'approved', 'rejected', 'cancelled')),
  source          text not null default 'portal' check (source in ('portal', 'staff', 'import')),
  import_batch_id uuid,
  row_version     integer not null default 1,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_by    uuid references public.profiles (id) on delete set null,
  submitted_at    timestamptz,
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, idempotency_key),
  unique (client_id, id)
);
-- Duplicate detection: one live record per TIN, or per name when there is no TIN.
create unique index counterparties_unique_tin on public.counterparties (client_id, tin)
  where tin is not null and status not in ('rejected', 'cancelled');
create unique index counterparties_unique_name on public.counterparties (client_id, name_key)
  where tin is null and status not in ('rejected', 'cancelled');

-- ---------------------------------------------------------------------------
-- Documents (metadata; the bytes live in the private Storage bucket)
-- ---------------------------------------------------------------------------
create table public.documents (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  storage_path      text not null unique
                      check (storage_path ~ '^clients/[0-9a-f-]{36}/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}\.[a-z]{3,4}$'),
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  extension         text not null check (extension in ('pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic', 'csv', 'txt', 'xlsx', 'docx')),
  mime_type         text not null check (mime_type in (
                      'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic',
                      'text/csv', 'text/plain',
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes        bigint not null check (size_bytes between 1 and 10485760),
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  category          public.document_category not null,
  period_month      date check (extract(day from period_month) = 1),
  description       text check (char_length(description) <= 500),
  upload_state      text not null default 'pending' check (upload_state in ('pending', 'complete')),
  review_status     public.document_review not null default 'pending',
  review_comment    text check (char_length(review_comment) <= 1000),
  uploaded_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  uploaded_at       timestamptz not null default now(),
  completed_at      timestamptz,
  reviewed_by       uuid references public.profiles (id) on delete set null,
  reviewed_at       timestamptz,
  deleted_at        timestamptz,
  deleted_by        uuid references public.profiles (id) on delete set null,
  delete_reason     text check (char_length(delete_reason) <= 500),
  idempotency_key   text not null check (char_length(idempotency_key) between 8 and 200),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (storage_path like 'clients/' || client_id::text || '/%'),
  check ((upload_state = 'complete') = (completed_at is not null))
);
-- The same file (same bytes) is stored once per client. Only completed uploads
-- count, so an abandoned pending row can never block a real upload.
create unique index documents_unique_live_hash on public.documents (client_id, sha256)
  where deleted_at is null and upload_state = 'complete';
create index documents_client_idx on public.documents (client_id, uploaded_at desc);

-- ---------------------------------------------------------------------------
-- Canonical intake transaction
-- ---------------------------------------------------------------------------
create table public.intake_transactions (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid not null references public.clients (id) on delete cascade,
  kind                      public.intake_txn_kind not null,
  status                    public.intake_status not null default 'draft',
  txn_date                  date check (txn_date >= date '2000-01-01'),
  document_type             text check (document_type in ('sales_invoice', 'official_receipt', 'billing_statement',
                              'delivery_receipt', 'cash_voucher', 'payroll_register', 'bank_record', 'other')),
  document_ref              text check (char_length(document_ref) between 1 and 100),
  counterparty_id           uuid,
  counterparty_name         text check (char_length(counterparty_name) between 1 and 200),
  counterparty_tin          text check (counterparty_tin ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}(-[0-9]{3,5})?$'),
  party_key                 text generated always as
                              (coalesce(counterparty_tin, private.name_key(counterparty_name))) stored,
  description               text check (char_length(description) between 1 and 500),
  currency                  text not null default 'PHP' check (currency = 'PHP'),
  gross_amount              numeric(18, 2) check (gross_amount > 0),
  -- As printed on the document. Never computed by the platform.
  vat_amount_stated         numeric(18, 2) check (vat_amount_stated >= 0),
  withholding_amount_stated numeric(18, 2) check (withholding_amount_stated >= 0),
  payment_method            text check (payment_method in ('cash', 'check', 'bank_transfer', 'e_wallet',
                              'credit_card', 'on_account', 'other')),
  -- Module-specific extension point (sales, payroll, inventory...), validated by those modules.
  attributes                jsonb not null default '{}'::jsonb
                              check (jsonb_typeof(attributes) = 'object' and length(attributes::text) <= 8192),
  source                    text not null default 'portal' check (source in ('portal', 'staff', 'import')),
  import_batch_id           uuid,
  import_row_no             integer,
  row_version               integer not null default 1,
  idempotency_key           text not null check (char_length(idempotency_key) between 8 and 200),
  created_by                uuid default auth.uid() references public.profiles (id) on delete set null,
  submitted_by              uuid references public.profiles (id) on delete set null,
  submitted_at              timestamptz,
  reviewed_by               uuid references public.profiles (id) on delete set null,
  reviewed_at               timestamptz,
  approved_by               uuid references public.profiles (id) on delete set null,
  approved_at               timestamptz,
  decided_by                uuid references public.profiles (id) on delete set null,
  decided_at                timestamptz,
  journal_entry_id          uuid,
  posted_at                 timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  foreign key (client_id, counterparty_id) references public.counterparties (client_id, id),
  foreign key (client_id, journal_entry_id) references public.journal_entries (client_id, id),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (vat_amount_stated is null or gross_amount is null or vat_amount_stated <= gross_amount),
  check (withholding_amount_stated is null or gross_amount is null or withholding_amount_stated <= gross_amount),
  -- Maker-checker: the reviewer cannot also approve.
  check (approved_by is null or reviewed_by is null or approved_by <> reviewed_by),
  check (status <> 'posted' or (journal_entry_id is not null and posted_at is not null))
);
-- Duplicate detection: the same document number from the same customer/supplier
-- (by TIN, else by name) for the same kind is recorded once while live.
create unique index intake_transactions_unique_document
  on public.intake_transactions (client_id, kind, party_key, lower(document_ref))
  where document_ref is not null and party_key is not null and status not in ('rejected', 'cancelled');
create index intake_transactions_client_status_idx on public.intake_transactions (client_id, status, txn_date);

create table public.intake_transaction_lines (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  transaction_id uuid not null,
  line_no        smallint not null check (line_no between 1 and 200),
  description    text check (char_length(description) between 1 and 300),
  quantity       numeric(18, 4) check (quantity > 0),
  unit_price     numeric(18, 4) check (unit_price >= 0),
  amount         numeric(18, 2) not null check (amount > 0),
  account_hint   text check (char_length(account_hint) between 1 and 100),
  foreign key (client_id, transaction_id) references public.intake_transactions (client_id, id) on delete cascade,
  unique (transaction_id, line_no)
);

create table public.intake_transaction_documents (
  client_id      uuid not null,
  transaction_id uuid not null,
  document_id    uuid not null,
  primary key (transaction_id, document_id),
  foreign key (client_id, transaction_id) references public.intake_transactions (client_id, id) on delete cascade,
  foreign key (client_id, document_id) references public.documents (client_id, id)
);
create index intake_transaction_documents_doc_idx on public.intake_transaction_documents (document_id);

-- ---------------------------------------------------------------------------
-- Submission tracking and feedback (append-only)
-- ---------------------------------------------------------------------------
create table public.intake_events (
  id           bigint generated always as identity primary key,
  client_id    uuid not null references public.clients (id) on delete cascade,
  subject_type public.intake_subject not null,
  subject_id   uuid not null,
  from_status  text,
  to_status    text not null,
  actor_id     uuid default auth.uid() references public.profiles (id) on delete set null,
  comment      text check (char_length(comment) <= 2000),
  occurred_at  timestamptz not null default now()
);
create index intake_events_subject_idx on public.intake_events (client_id, subject_type, subject_id, occurred_at);

create table public.intake_comments (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  subject_type    public.intake_subject not null,
  subject_id      uuid not null,
  author_id       uuid default auth.uid() references public.profiles (id) on delete set null,
  body            text not null check (char_length(btrim(body)) between 1 and 2000),
  -- 'internal' notes are visible to firm staff only.
  visibility      text not null default 'client' check (visibility in ('client', 'internal')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  created_at      timestamptz not null default now(),
  unique (client_id, idempotency_key)
);
create index intake_comments_subject_idx on public.intake_comments (client_id, subject_type, subject_id, created_at);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function private.intake_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger intake_events_append_only before update or delete on public.intake_events
  for each row execute function private.intake_append_only();
create trigger intake_comments_append_only before update or delete on public.intake_comments
  for each row execute function private.intake_append_only();

-- Once a transaction leaves draft/needs_correction, its content is frozen; only
-- workflow columns may change. Lines and document links follow the same rule.
create function private.intake_transaction_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_workflow text[] := array['status', 'row_version', 'submitted_by', 'submitted_at', 'reviewed_by',
    'reviewed_at', 'approved_by', 'approved_at', 'decided_by', 'decided_at', 'journal_entry_id',
    'posted_at', 'updated_at',
    -- Generated columns are NULL in NEW inside BEFORE triggers; party_key derives
    -- from frozen fields anyway.
    'party_key'];
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'intake transactions cannot be deleted; cancel or reject them instead'
      using errcode = '42501';
  end if;
  if new.client_id <> old.client_id then
    raise exception 'client_id cannot be changed' using errcode = '42501';
  end if;
  if old.status not in ('draft', 'needs_correction')
     and (to_jsonb(new) - v_workflow) is distinct from (to_jsonb(old) - v_workflow) then
    raise exception 'a % transaction cannot be edited', old.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger intake_transactions_guard before update or delete on public.intake_transactions
  for each row execute function private.intake_transaction_guard();

create function private.intake_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.intake_status;
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into v_status from public.intake_transactions
   where id = case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;
  if v_status is not null and v_status not in ('draft', 'needs_correction') then
    raise exception 'lines and attachments of a % transaction cannot be changed', v_status
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger intake_transaction_lines_guard before insert or update or delete on public.intake_transaction_lines
  for each row execute function private.intake_child_guard();
create trigger intake_transaction_documents_guard before insert or update or delete on public.intake_transaction_documents
  for each row execute function private.intake_child_guard();

-- Documents are never hard-deleted (soft delete with a reason).
create function private.document_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'documents cannot be deleted; use a soft delete with a reason' using errcode = '42501';
  end if;
  if new.client_id <> old.client_id or new.storage_path <> old.storage_path or new.sha256 <> old.sha256
     or new.size_bytes <> old.size_bytes or new.mime_type <> old.mime_type then
    raise exception 'a document''s file identity cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger documents_guard before update or delete on public.documents
  for each row execute function private.document_guard();

create trigger business_profiles_touch before update on public.business_profiles
  for each row execute function private.touch_updated_at();
create trigger counterparties_touch before update on public.counterparties
  for each row execute function private.touch_updated_at();
create trigger intake_transactions_touch before update on public.intake_transactions
  for each row execute function private.touch_updated_at();

-- Audit (append-only, row images)
create trigger audit_business_profiles after insert or update or delete on public.business_profiles
  for each row execute function audit.log_change();
create trigger audit_counterparties after insert or update or delete on public.counterparties
  for each row execute function audit.log_change();
create trigger audit_documents after insert or update or delete on public.documents
  for each row execute function audit.log_change();
create trigger audit_intake_transactions after insert or update or delete on public.intake_transactions
  for each row execute function audit.log_change();
create trigger audit_intake_transaction_lines after insert or update or delete on public.intake_transaction_lines
  for each row execute function audit.log_change();
create trigger audit_intake_transaction_documents after insert or update or delete on public.intake_transaction_documents
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- RLS: read-only for authenticated users, scoped to readable clients.
-- ---------------------------------------------------------------------------
revoke all on table
  public.business_profiles, public.counterparties, public.documents, public.intake_transactions,
  public.intake_transaction_lines, public.intake_transaction_documents, public.intake_events,
  public.intake_comments
from public, anon, authenticated;
grant select on table
  public.business_profiles, public.counterparties, public.documents, public.intake_transactions,
  public.intake_transaction_lines, public.intake_transaction_documents, public.intake_events,
  public.intake_comments
to authenticated;

alter table public.business_profiles enable row level security;
alter table public.business_profiles force row level security;
alter table public.counterparties enable row level security;
alter table public.counterparties force row level security;
alter table public.documents enable row level security;
alter table public.documents force row level security;
alter table public.intake_transactions enable row level security;
alter table public.intake_transactions force row level security;
alter table public.intake_transaction_lines enable row level security;
alter table public.intake_transaction_lines force row level security;
alter table public.intake_transaction_documents enable row level security;
alter table public.intake_transaction_documents force row level security;
alter table public.intake_events enable row level security;
alter table public.intake_events force row level security;
alter table public.intake_comments enable row level security;
alter table public.intake_comments force row level security;

create policy business_profiles_select on public.business_profiles for select to authenticated
  using (private.can_read_client(client_id));
create policy counterparties_select on public.counterparties for select to authenticated
  using (private.can_read_client(client_id));
-- Unfinished uploads are visible only to their uploader and staff; deleted ones only to staff.
create policy documents_select on public.documents for select to authenticated
  using (private.can_read_client(client_id)
         and (deleted_at is null or private.is_assigned(client_id))
         and (upload_state = 'complete' or uploaded_by = auth.uid() or private.is_assigned(client_id)));
create policy intake_transactions_select on public.intake_transactions for select to authenticated
  using (private.can_read_client(client_id));
create policy intake_transaction_lines_select on public.intake_transaction_lines for select to authenticated
  using (private.can_read_client(client_id));
create policy intake_transaction_documents_select on public.intake_transaction_documents for select to authenticated
  using (private.can_read_client(client_id));
create policy intake_events_select on public.intake_events for select to authenticated
  using (private.can_read_client(client_id));
create policy intake_comments_select on public.intake_comments for select to authenticated
  using (private.can_read_client(client_id) and (visibility = 'client' or private.is_assigned(client_id)));

-- ---------------------------------------------------------------------------
-- Storage: private bucket + object policies (doc 07 §5)
-- ---------------------------------------------------------------------------
-- The bucket itself also enforces the size cap and MIME allowlist server-side.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-documents', 'client-documents', false, 10485760, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- UPLOADS: API users get NO insert policy. The server first verifies the file's
-- actual bytes (type sniffing, size, hash), the user's own authorized call
-- creates a pending documents row, and only then the server writes the bytes
-- (server-only key) to exactly that row's path. A user calling the database
-- directly can therefore never place unchecked bytes in the bucket.

-- An object may be read when its live document row is readable by the caller.
create function private.storage_can_read(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_bucket = 'client-documents' and exists (
    select 1 from public.documents d
    where d.storage_path = p_name and d.deleted_at is null and private.can_read_client(d.client_id)
      and (d.upload_state = 'complete' or d.uploaded_by = auth.uid())
  );
$$;

revoke execute on function private.storage_can_read(text, text) from public, anon;
grant execute on function
  private.can_submit_intake(uuid), private.can_review_intake(uuid), private.can_approve_intake(uuid),
  private.can_propose_profile(uuid), private.storage_can_read(text, text)
to authenticated;

create policy client_documents_select on storage.objects for select to authenticated
  using (private.storage_can_read(bucket_id, name));
-- No INSERT, UPDATE or DELETE policies: API users can only read (via signed URLs).
