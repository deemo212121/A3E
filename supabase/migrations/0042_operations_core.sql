-- Phase 15: firm operations (core objects).
-- Functions: 0043_operations_functions.sql
--
-- Work queues, filing calendar with distinct statuses (preparation, review,
-- approval, export, actual filing confirmation), missing-document requests,
-- in-app notifications (no financial details), client service status,
-- exception requests (locked periods, due-date changes, filing corrections).
--
-- No statutory deadline is shipped. Deadline rules are firm configuration with
-- a cited source, PENDING VERIFICATION until a second person verifies them.
-- All writes go through SECURITY DEFINER functions; API roles can only SELECT.

-- ---------------------------------------------------------------------------
-- Deadline rules (firm-wide configuration) and client subscriptions
-- ---------------------------------------------------------------------------
create table public.deadline_rules (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[A-Z][A-Z0-9_-]{1,39}$'),
  title            text not null check (char_length(title) between 3 and 200),
  kind             text not null check (kind in ('tax_return', 'document_submission', 'internal')),
  -- What the filing is for (a form code in the forms registry, or free text). Never assumed.
  form_code        text check (char_length(form_code) between 1 and 40),
  frequency        text not null check (frequency in ('monthly', 'quarterly', 'annual')),
  -- Due date: day `due_day` of the month that is `due_months_after` months
  -- after the month in which the period ends (clamped to the month's last day).
  due_months_after smallint not null check (due_months_after between 0 and 12),
  due_day          smallint not null check (due_day between 1 and 31),
  -- 'next_weekday' moves Saturday/Sunday to Monday. Holidays are NOT known to
  -- the system: change such dates through an approved due-date change.
  weekend_rule     text not null default 'none' check (weekend_rule in ('none', 'next_weekday')),
  -- Period numbers within the fiscal year that have no filing (e.g. a quarter
  -- covered by an annual return). Months 1-12, quarters 1-4.
  skip_periods     smallint[] not null default '{}',
  reminder_days    smallint[] not null default '{7,3,1}',
  -- {citation, issued_on, url?}; required for tax returns.
  source           jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object'),
  notes            text check (char_length(notes) <= 1000),
  status           text not null default 'pending_verification'
                     check (status in ('pending_verification', 'verified', 'retired')),
  entered_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  entered_at       timestamptz not null default now(),
  verified_by      uuid references public.profiles (id) on delete set null,
  verified_at      timestamptz,
  verify_note      text check (char_length(verify_note) <= 1000),
  check (verified_by is null or entered_by is null or verified_by <> entered_by),
  check ((status = 'verified') <= (verified_by is not null)),
  check (kind <> 'tax_return' or (source ? 'citation' and source ? 'issued_on')),
  check (cardinality(reminder_days) <= 10),
  check (cardinality(skip_periods) <= 12)
);

create table public.client_deadlines (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  rule_id      uuid not null references public.deadline_rules (id),
  starts_on    date not null,
  ends_on      date,
  -- Fiscal year end month: quarters and years end in this month.
  anchor_month smallint not null default 12 check (anchor_month between 1 and 12),
  preparer_id  uuid references public.profiles (id) on delete set null,
  reviewer_id  uuid references public.profiles (id) on delete set null,
  created_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  check (preparer_id is null or reviewer_id is null or preparer_id <> reviewer_id)
);
create index client_deadlines_client_idx on public.client_deadlines (client_id);

-- ---------------------------------------------------------------------------
-- Filing calendar: one row per return and period. Each step is its own status
-- with who and when; generating or downloading a file never marks it filed.
-- ---------------------------------------------------------------------------
create table public.filings (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients (id) on delete cascade,
  rule_id             uuid references public.deadline_rules (id),
  form_code           text not null check (char_length(form_code) between 1 and 40),
  title               text not null check (char_length(title) between 3 and 200),
  period_from         date not null,
  period_to           date not null,
  due_on              date not null,
  due_basis           text not null check (due_basis in ('rule', 'manual', 'approved_change')),
  status              text not null default 'not_started' check (status in (
                        'not_started', 'in_preparation', 'prepared', 'in_review', 'approved',
                        'exported', 'filed', 'not_required')),
  preparer_id         uuid references public.profiles (id) on delete set null,
  reviewer_id         uuid references public.profiles (id) on delete set null,
  workpaper_id        uuid,
  prepared_by         uuid references public.profiles (id) on delete set null,
  prepared_at         timestamptz,
  approved_by         uuid references public.profiles (id) on delete set null,
  approved_at         timestamptz,
  approval_note       text check (char_length(approval_note) <= 2000),
  output_run_id       uuid,
  export_method       text check (export_method in ('validated_file', 'official_form_tool', 'manual_form')),
  export_reference    text check (char_length(export_reference) <= 300),
  exported_by         uuid references public.profiles (id) on delete set null,
  exported_at         timestamptz,
  filed_on            date,
  filing_channel      text check (char_length(filing_channel) <= 100),
  filing_reference    text check (char_length(filing_reference) <= 200),
  filing_evidence     text check (char_length(filing_evidence) <= 1000),
  filed_confirmed_by  uuid references public.profiles (id) on delete set null,
  filed_confirmed_at  timestamptz,
  not_required_reason text check (char_length(not_required_reason) <= 1000),
  amends_id           uuid,
  version             integer not null default 1,
  created_by          uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (client_id, id),
  foreign key (client_id, amends_id) references public.filings (client_id, id),
  foreign key (client_id, workpaper_id) references public.tax_workpapers (client_id, id),
  check (period_to >= period_from),
  check (preparer_id is null or reviewer_id is null or preparer_id <> reviewer_id),
  check (approved_by is null or prepared_by is null or approved_by <> prepared_by),
  check (status not in ('prepared', 'in_review', 'approved', 'exported', 'filed') or prepared_by is not null),
  check (status not in ('approved', 'exported', 'filed') or approved_by is not null),
  check (status not in ('exported', 'filed') or (exported_by is not null and export_method is not null)),
  check ((status = 'filed') = (filed_confirmed_by is not null)),
  check (status <> 'filed' or (filed_on is not null and filing_reference is not null and filing_evidence is not null)),
  check ((status = 'not_required') = (not_required_reason is not null))
);
-- One original per return and period; amendments are separate rows.
create unique index filings_one_original on public.filings (client_id, form_code, period_from, period_to)
  where amends_id is null;
create index filings_due_idx on public.filings (due_on, status);
create index filings_client_idx on public.filings (client_id, due_on);

create table public.filing_events (
  id          bigint generated always as identity primary key,
  client_id   uuid not null,
  filing_id   uuid not null,
  from_status text,
  to_status   text,
  event       text not null,
  note        text check (char_length(note) <= 2000),
  actor_id    uuid default auth.uid() references public.profiles (id) on delete set null,
  occurred_at timestamptz not null default now(),
  foreign key (client_id, filing_id) references public.filings (client_id, id) on delete cascade
);
create index filing_events_filing_idx on public.filing_events (filing_id, id);

-- ---------------------------------------------------------------------------
-- Work queue
-- ---------------------------------------------------------------------------
create table public.work_items (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  kind            text not null check (kind in ('task', 'document_follow_up', 'correction', 'review', 'exception')),
  title           text not null check (char_length(title) between 3 and 200),
  details         text check (char_length(details) <= 2000),
  status          text not null default 'open'
                    check (status in ('open', 'in_progress', 'waiting_client', 'in_review', 'done', 'cancelled')),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id     uuid references public.profiles (id) on delete set null,
  reviewer_id     uuid references public.profiles (id) on delete set null,
  requires_review boolean not null default true,
  due_on          date,
  link_type       text check (link_type in ('journal_entry', 'intake_transaction', 'filing', 'document_request', 'exception')),
  link_id         uuid,
  completed_by    uuid references public.profiles (id) on delete set null,
  completed_at    timestamptz,
  version         integer not null default 1,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (assignee_id is null or reviewer_id is null or assignee_id <> reviewer_id),
  check ((link_type is null) = (link_id is null)),
  check ((status = 'done') = (completed_by is not null))
);
create index work_items_assignee_idx on public.work_items (assignee_id, status);
create index work_items_reviewer_idx on public.work_items (reviewer_id, status);
create index work_items_client_idx on public.work_items (client_id, status);

create table public.work_item_events (
  id          bigint generated always as identity primary key,
  client_id   uuid not null,
  item_id     uuid not null,
  from_status text,
  to_status   text,
  event       text not null,
  note        text check (char_length(note) <= 2000),
  actor_id    uuid default auth.uid() references public.profiles (id) on delete set null,
  occurred_at timestamptz not null default now(),
  foreign key (client_id, item_id) references public.work_items (client_id, id) on delete cascade
);
create index work_item_events_item_idx on public.work_item_events (item_id, id);

-- ---------------------------------------------------------------------------
-- Missing-document requests (visible to the client)
-- ---------------------------------------------------------------------------
create table public.document_requests (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  title           text not null check (char_length(title) between 3 and 200),
  details         text check (char_length(details) <= 1000),
  category        public.document_category,
  period_from     date,
  period_to       date,
  due_on          date not null,
  status          text not null default 'open' check (status in ('open', 'submitted', 'accepted', 'returned', 'cancelled')),
  requested_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  requested_at    timestamptz not null default now(),
  document_ids    uuid[] not null default '{}',
  response_note   text check (char_length(response_note) <= 1000),
  responded_by    uuid references public.profiles (id) on delete set null,
  responded_at    timestamptz,
  decision_note   text check (char_length(decision_note) <= 1000),
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  reminder_count  integer not null default 0,
  last_reminded_on date,
  version         integer not null default 1,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  unique (client_id, idempotency_key),
  unique (client_id, id),
  check (period_to is null or period_from is null or period_to >= period_from),
  check (cardinality(document_ids) <= 50),
  check (status not in ('submitted', 'accepted') or responded_by is not null),
  check (status not in ('accepted', 'returned', 'cancelled') or decided_by is not null)
);
create index document_requests_client_idx on public.document_requests (client_id, status, due_on);

create table public.document_request_events (
  id          bigint generated always as identity primary key,
  client_id   uuid not null,
  request_id  uuid not null,
  from_status text,
  to_status   text,
  event       text not null,
  note        text check (char_length(note) <= 1000),
  actor_id    uuid default auth.uid() references public.profiles (id) on delete set null,
  occurred_at timestamptz not null default now(),
  foreign key (client_id, request_id) references public.document_requests (client_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Notifications (in-app). Built from fixed templates: they name the client,
-- the kind of item and dates, never amounts or other financial details.
-- ---------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  client_id    uuid references public.clients (id) on delete cascade,
  kind         text not null check (kind ~ '^[a-z_]{3,40}$'),
  title        text not null check (char_length(title) between 3 and 200),
  body         text check (char_length(body) <= 500),
  link         text check (link ~ '^/[A-Za-z0-9/_-]*$'),
  -- Same event delivered twice (e.g. a retried reminder run) is stored once.
  dedupe_key   text not null check (char_length(dedupe_key) between 3 and 300),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  unique (recipient_id, dedupe_key),
  -- Defence in depth: no currency signs or money-looking numbers.
  -- (Same pattern as private.ops_text_safe in 0043.)
  check ((title || ' ' || coalesce(body, '')) !~ '(₱|[0-9][0-9,]*\.[0-9]{2}([^0-9]|$)|[0-9]{1,3}(,[0-9]{3})+)')
);
create index notifications_recipient_idx on public.notifications (recipient_id, read_at, created_at desc);

-- ---------------------------------------------------------------------------
-- Client service status (history; the latest row is current)
-- ---------------------------------------------------------------------------
create table public.client_service_status (
  id         bigint generated always as identity primary key,
  client_id  uuid not null references public.clients (id) on delete cascade,
  status     text not null check (status in ('active', 'awaiting_client', 'on_hold', 'suspended', 'offboarding', 'ended')),
  reason     text not null check (char_length(reason) between 3 and 1000),
  set_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  set_at     timestamptz not null default now()
);
create index client_service_status_idx on public.client_service_status (client_id, id desc);

-- ---------------------------------------------------------------------------
-- Exception requests: actions outside the normal workflow need a firm manager
-- other than the requester. Executed by the approving function.
-- ---------------------------------------------------------------------------
create table public.ops_exceptions (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  kind          text not null check (kind in ('reopen_locked_period', 'change_due_date', 'withdraw_filing_confirmation', 'other')),
  period_id     uuid,
  target_status public.period_status,
  filing_id     uuid,
  new_due_on    date,
  reason        text not null check (char_length(reason) between 10 and 1000),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  executed_at   timestamptz,
  requested_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 1000),
  unique (client_id, id),
  foreign key (client_id, period_id) references public.accounting_periods (client_id, id),
  foreign key (client_id, filing_id) references public.filings (client_id, id),
  check (decided_by is null or requested_by is null or decided_by <> requested_by),
  check ((status in ('approved', 'rejected')) = (decided_by is not null)),
  check (kind <> 'reopen_locked_period' or (period_id is not null and target_status in ('open', 'soft_closed'))),
  check (kind <> 'change_due_date' or (filing_id is not null and new_due_on is not null)),
  check (kind <> 'withdraw_filing_confirmation' or filing_id is not null)
);
create index ops_exceptions_client_idx on public.ops_exceptions (client_id, status);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function private.ops_no_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return old;
  end if;
  raise exception '% rows cannot be deleted', tg_table_name using errcode = '42501';
end;
$$;

-- A confirmed filing is frozen; only an approved exception withdraws it.
create function private.filing_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'filed' and new.status = 'filed'
     and (to_jsonb(new) - array['version', 'updated_at']) is distinct from (to_jsonb(old) - array['version', 'updated_at']) then
    raise exception 'a filed return cannot be edited; file an amendment' using errcode = '42501';
  end if;
  if old.status = 'filed' and new.status <> 'filed' and not exists (
       select 1 from public.ops_exceptions e
        where e.id::text = coalesce(current_setting('app.ops_exception', true), '')
          and e.filing_id = new.id and e.kind = 'withdraw_filing_confirmation'
          and e.status = 'approved' and e.executed_at is null) then
    raise exception 'a filing confirmation is withdrawn only through an approved exception' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger filings_guard before update on public.filings
  for each row execute function private.filing_guard();
create trigger filings_no_delete before delete on public.filings
  for each row execute function private.ops_no_delete();
create trigger work_items_no_delete before delete on public.work_items
  for each row execute function private.ops_no_delete();
create trigger document_requests_no_delete before delete on public.document_requests
  for each row execute function private.ops_no_delete();
create trigger ops_exceptions_no_delete before delete on public.ops_exceptions
  for each row execute function private.ops_no_delete();
create trigger work_items_touch before update on public.work_items
  for each row execute function private.touch_updated_at();

create trigger filing_events_append_only before update or delete on public.filing_events
  for each row execute function private.intake_append_only();
create trigger work_item_events_append_only before update or delete on public.work_item_events
  for each row execute function private.intake_append_only();
create trigger document_request_events_append_only before update or delete on public.document_request_events
  for each row execute function private.intake_append_only();
create trigger client_service_status_append_only before update or delete on public.client_service_status
  for each row execute function private.intake_append_only();

create trigger audit_deadline_rules after insert or update or delete on public.deadline_rules
  for each row execute function audit.log_change();
create trigger audit_client_deadlines after insert or update or delete on public.client_deadlines
  for each row execute function audit.log_change();
create trigger audit_filings after insert or update or delete on public.filings
  for each row execute function audit.log_change();
create trigger audit_work_items after insert or update or delete on public.work_items
  for each row execute function audit.log_change();
create trigger audit_document_requests after insert or update or delete on public.document_requests
  for each row execute function audit.log_change();
create trigger audit_client_service_status after insert or update or delete on public.client_service_status
  for each row execute function audit.log_change();
create trigger audit_ops_exceptions after insert or update or delete on public.ops_exceptions
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- Privileges and RLS (read only; writes through functions)
-- ---------------------------------------------------------------------------
revoke all on table public.deadline_rules, public.client_deadlines, public.filings, public.filing_events,
  public.work_items, public.work_item_events, public.document_requests, public.document_request_events,
  public.notifications, public.client_service_status, public.ops_exceptions
from public, anon, authenticated;
grant select on table public.deadline_rules, public.client_deadlines, public.filings, public.filing_events,
  public.work_items, public.work_item_events, public.document_requests, public.document_request_events,
  public.notifications, public.client_service_status, public.ops_exceptions
to authenticated;
revoke all on sequence public.filing_events_id_seq, public.work_item_events_id_seq,
  public.document_request_events_id_seq, public.client_service_status_id_seq
from public, anon, authenticated;

alter table public.deadline_rules enable row level security;
alter table public.deadline_rules force row level security;
alter table public.client_deadlines enable row level security;
alter table public.client_deadlines force row level security;
alter table public.filings enable row level security;
alter table public.filings force row level security;
alter table public.filing_events enable row level security;
alter table public.filing_events force row level security;
alter table public.work_items enable row level security;
alter table public.work_items force row level security;
alter table public.work_item_events enable row level security;
alter table public.work_item_events force row level security;
alter table public.document_requests enable row level security;
alter table public.document_requests force row level security;
alter table public.document_request_events enable row level security;
alter table public.document_request_events force row level security;
alter table public.notifications enable row level security;
alter table public.notifications force row level security;
alter table public.client_service_status enable row level security;
alter table public.client_service_status force row level security;
alter table public.ops_exceptions enable row level security;
alter table public.ops_exceptions force row level security;

create policy deadline_rules_select on public.deadline_rules for select to authenticated
  using (private.firm_role() in ('firm_manager', 'reviewer', 'accountant', 'bookkeeper'));
create policy client_deadlines_select on public.client_deadlines for select to authenticated
  using (private.is_assigned(client_id));
-- Staff only: filing preparation is the firm's internal workflow.
create policy filings_select on public.filings for select to authenticated using (private.is_assigned(client_id));
create policy filing_events_select on public.filing_events for select to authenticated
  using (private.is_assigned(client_id));
create policy work_items_select on public.work_items for select to authenticated using (private.is_assigned(client_id));
create policy work_item_events_select on public.work_item_events for select to authenticated
  using (private.is_assigned(client_id));
-- Requests are addressed to the client, so its members see them too.
create policy document_requests_select on public.document_requests for select to authenticated
  using (private.can_read_client(client_id));
create policy document_request_events_select on public.document_request_events for select to authenticated
  using (private.can_read_client(client_id));
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy client_service_status_select on public.client_service_status for select to authenticated
  using (private.is_assigned(client_id));
create policy ops_exceptions_select on public.ops_exceptions for select to authenticated
  using (private.is_assigned(client_id));

revoke execute on function private.ops_no_delete(), private.filing_guard() from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0042', 'operations_core') on conflict (version) do nothing;
