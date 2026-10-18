-- Phase 15: firm operations (functions). Objects: 0042_operations_core.sql
--
-- Every action derives the caller from auth.uid(), checks the caller's role and
-- client assignment, records an event with who/when, and is audited.
-- Status changes accept the row version the caller saw: a stale retry gets a
-- conflict instead of overwriting someone else's change; repeating an action
-- that already happened is a no-op.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Same pattern as the notifications check constraint (no money-looking text).
create function private.ops_text_safe(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_text, '') !~ '(₱|[0-9][0-9,]*\.[0-9]{2}([^0-9]|$)|[0-9]{1,3}(,[0-9]{3})+)';
$$;

-- May this user work on the client (reviewer slot: reviewer or manager)?
create function private.ops_eligible(p_user uuid, p_client uuid, p_reviewer boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.firm_memberships fm
      join public.profiles p on p.id = fm.user_id
     where fm.user_id = p_user and p.is_active
       and fm.role in ('firm_manager', 'reviewer', 'accountant', 'bookkeeper')
       and (not p_reviewer or fm.role in ('firm_manager', 'reviewer'))
       and (fm.role = 'firm_manager'
            or exists (select 1 from public.client_assignments a where a.client_id = p_client and a.user_id = p_user))
  );
$$;

create function private.ops_is_manager(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client) and private.firm_role() = 'firm_manager';
$$;

-- Accountants, reviewers and managers (not bookkeepers): filing work, exceptions.
create function private.ops_is_preparer(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_assigned(p_client) and private.firm_role() in ('firm_manager', 'reviewer', 'accountant');
$$;

create function private.ops_client_code(p_client uuid) returns text
language sql stable security definer set search_path = '' as $$
  select code from public.clients where id = p_client;
$$;

-- In-app notification from a fixed template. Never notifies the actor (unless
-- p_self), skips inactive users, and stores a repeated event once.
create function private.ops_notify(
  p_recipient uuid, p_client uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text,
  p_self boolean default false
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  v_body text := p_body;
begin
  if p_recipient is null or (p_recipient = auth.uid() and not p_self) then
    return 0;
  end if;
  if not exists (select 1 from public.profiles where id = p_recipient and is_active) then
    return 0;
  end if;
  if not private.ops_text_safe(v_body) then
    v_body := 'Open the item for details.';
  end if;
  insert into public.notifications (recipient_id, client_id, kind, title, body, link, dedupe_key)
  values (p_recipient, p_client, p_kind, p_title, v_body, p_link, left(p_dedupe, 300))
  on conflict (recipient_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function private.ops_notify_managers(
  p_client uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text, p_self boolean default false
) returns integer
language sql security definer set search_path = '' as $$
  select coalesce(sum(private.ops_notify(fm.user_id, p_client, p_kind, p_title, p_body, p_link, p_dedupe, p_self)), 0)::integer
    from public.firm_memberships fm where fm.role = 'firm_manager';
$$;

-- Client owners and client staff (who can act on requests).
create function private.ops_notify_client(
  p_client uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text, p_self boolean default false
) returns integer
language sql security definer set search_path = '' as $$
  select coalesce(sum(private.ops_notify(cm.user_id, p_client, p_kind, p_title, p_body, p_link, p_dedupe, p_self)), 0)::integer
    from public.client_memberships cm
   where cm.client_id = p_client and cm.role in ('client_owner', 'client_staff')
     and (cm.expires_at is null or cm.expires_at > now());
$$;

create function private.ops_link(p_client uuid, p_kind text, p_id uuid) returns text
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'work' then '/staff/clients/' || p_client || '/operations/work/' || p_id
    when 'filing' then '/staff/clients/' || p_client || '/operations/filings/' || p_id
    when 'operations' then '/staff/clients/' || p_client || '/operations'
    when 'portal_requests' then '/portal/' || p_client || '/requests'
    when 'exceptions' then '/review/exceptions'
  end;
$$;

create function private.ops_check_version(p_current integer, p_expected integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is not null and p_expected <> p_current then
    raise exception 'this item was changed by someone else; reload and try again' using errcode = '40001';
  end if;
end;
$$;

create function private.ops_note(p_note text, p_min integer, p_what text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_note, ''))) < p_min then
    raise exception '%', p_what using errcode = '22023';
  end if;
  return nullif(btrim(coalesce(p_note, '')), '');
end;
$$;

-- ---------------------------------------------------------------------------
-- Deadline rules (configuration, never assumed)
-- ---------------------------------------------------------------------------
-- Due date for a period ending p_period_to (see deadline_rules).
create function private.ops_due_date(p_period_to date, p_months integer, p_day integer, p_weekend text)
returns date
language plpgsql immutable set search_path = '' as $$
declare
  v_month date := (date_trunc('month', p_period_to::timestamp) + make_interval(months => p_months))::date;
  v_last integer := extract(day from (v_month + interval '1 month' - interval '1 day'))::integer;
  v_due date := v_month + (least(p_day, v_last) - 1);
begin
  if p_weekend = 'next_weekday' then
    if extract(isodow from v_due) = 6 then
      v_due := v_due + 2;
    elsif extract(isodow from v_due) = 7 then
      v_due := v_due + 1;
    end if;
  end if;
  return v_due;
end;
$$;

-- Periods (monthly, quarterly or annual, ending in fiscal months aligned to the
-- fiscal year end month) whose end falls within [p_from, p_to].
create function private.ops_periods(p_frequency text, p_anchor integer, p_from date, p_to date)
returns table (period_no integer, period_from date, period_to date)
language sql immutable set search_path = '' as $$
  with len as (
    select case p_frequency when 'monthly' then 1 when 'quarterly' then 3 else 12 end as n
  ), months as (
    select (m + interval '1 month' - interval '1 day')::date as month_end, extract(month from m)::integer as mon
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp),
                           interval '1 month') as m
  )
  -- Fiscal month of the period end (1-12) divided by the period length.
  select ((((mon - p_anchor - 1 + 24) % 12) + 1) / len.n)::integer as period_no,
         (date_trunc('month', month_end) - make_interval(months => len.n - 1))::date,
         month_end
    from months, len
   where mod(mon - p_anchor + 12, len.n) = 0 and month_end between p_from and p_to
   order by month_end;
$$;

create function public.propose_deadline_rule(p_rule jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_id uuid;
  v_source jsonb := coalesce(p_rule -> 'source', '{}'::jsonb);
begin
  if private.firm_role() not in ('firm_manager', 'reviewer', 'accountant') or private.firm_role() is null then
    raise exception 'only accountants, reviewers and managers can propose deadline rules' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rule) is distinct from 'object' then
    raise exception 'the rule must be a JSON object' using errcode = '22023';
  end if;
  if coalesce(p_rule ->> 'kind', '') = 'tax_return'
     and (char_length(coalesce(v_source ->> 'citation', '')) < 5 or coalesce(v_source ->> 'issued_on', '') = '') then
    raise exception 'a tax return deadline needs its source (citation and issue date)' using errcode = '22023';
  end if;
  insert into public.deadline_rules (code, title, kind, form_code, frequency, due_months_after, due_day,
                                     weekend_rule, skip_periods, reminder_days, source, notes, entered_by)
  values (
    upper(btrim(p_rule ->> 'code')), btrim(p_rule ->> 'title'), p_rule ->> 'kind', nullif(btrim(p_rule ->> 'form_code'), ''),
    p_rule ->> 'frequency', (p_rule ->> 'due_months_after')::smallint, (p_rule ->> 'due_day')::smallint,
    coalesce(p_rule ->> 'weekend_rule', 'none'),
    coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(p_rule -> 'skip_periods') x), '{}'),
    coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(p_rule -> 'reminder_days') x), '{7,3,1}'),
    v_source, nullif(btrim(p_rule ->> 'notes'), ''), v_uid
  )
  returning id into v_id;
  if exists (select 1 from public.deadline_rules r, unnest(r.reminder_days) d where r.id = v_id and (d < 0 or d > 90))
     or exists (select 1 from public.deadline_rules r, unnest(r.skip_periods) s where r.id = v_id
                 and (s < 1 or s > case r.frequency when 'monthly' then 12 when 'quarterly' then 4 else 1 end)) then
    raise exception 'reminder days must be 0 to 90 and skipped periods must exist for the frequency' using errcode = '22023';
  end if;
  return v_id;
end;
$$;

-- A reviewer or manager other than the author checks the rule against its source.
create function public.verify_deadline_rule(p_id uuid, p_source_checked boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.deadline_rules;
begin
  if coalesce(private.firm_role() in ('firm_manager', 'reviewer'), false) is false then
    raise exception 'only reviewers and managers can verify deadline rules' using errcode = '42501';
  end if;
  select * into r from public.deadline_rules where id = p_id for update;
  if not found then
    raise exception 'deadline rule not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending_verification' then
    raise exception 'only a rule pending verification can be verified' using errcode = '22023';
  end if;
  if r.entered_by = v_uid then
    raise exception 'you entered this rule, so another person must verify it' using errcode = '42501';
  end if;
  if not coalesce(p_source_checked, false) then
    raise exception 'confirm that you checked the rule against its source' using errcode = '22023';
  end if;
  update public.deadline_rules
     set status = 'verified', verified_by = v_uid, verified_at = now(),
         verify_note = private.ops_note(p_note, 5, 'write what you checked')
   where id = p_id;
end;
$$;

create function public.retire_deadline_rule(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if coalesce(private.firm_role() = 'firm_manager', false) is false then
    raise exception 'only firm managers can retire deadline rules' using errcode = '42501';
  end if;
  update public.deadline_rules
     set status = 'retired', notes = left(concat_ws(' | ', notes, 'Retired: ' || private.ops_note(p_note, 5, 'write why the rule is retired')), 1000)
   where id = p_id and status <> 'retired';
  if not found then
    raise exception 'deadline rule not found or already retired' using errcode = 'P0002';
  end if;
end;
$$;

create function public.set_client_deadline(
  p_client_id uuid, p_rule_id uuid, p_starts_on date, p_anchor_month integer, p_preparer_id uuid, p_reviewer_id uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only reviewers and managers of this client can set its deadlines' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deadline_rules where id = p_rule_id and status <> 'retired') then
    raise exception 'deadline rule not found' using errcode = 'P0002';
  end if;
  if p_starts_on is null then
    raise exception 'choose the date the deadline applies from' using errcode = '22023';
  end if;
  if p_preparer_id is not null and not private.ops_eligible(p_preparer_id, p_client_id, false) then
    raise exception 'the preparer is not assigned to this client' using errcode = '22023';
  end if;
  if p_reviewer_id is not null and not private.ops_eligible(p_reviewer_id, p_client_id, true) then
    raise exception 'the reviewer must be a reviewer or manager assigned to this client' using errcode = '22023';
  end if;
  if exists (select 1 from public.client_deadlines where client_id = p_client_id and rule_id = p_rule_id and ends_on is null) then
    raise exception 'this deadline is already set for the client; end it first' using errcode = '23505';
  end if;
  insert into public.client_deadlines (client_id, rule_id, starts_on, anchor_month, preparer_id, reviewer_id)
  values (p_client_id, p_rule_id, p_starts_on, coalesce(p_anchor_month, 12), p_preparer_id, p_reviewer_id)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.end_client_deadline(p_id uuid, p_ends_on date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d public.client_deadlines;
begin
  perform private.require_active_user();
  select * into d from public.client_deadlines where id = p_id for update;
  if not found or not private.is_assigned(d.client_id) then
    raise exception 'client deadline not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(d.client_id) then
    raise exception 'only reviewers and managers of this client can end its deadlines' using errcode = '42501';
  end if;
  if p_ends_on is null or p_ends_on < d.starts_on then
    raise exception 'the end date must be on or after the start date' using errcode = '22023';
  end if;
  update public.client_deadlines set ends_on = p_ends_on where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Filing calendar
-- ---------------------------------------------------------------------------
create function private.filing_event(p_f public.filings, p_from text, p_event text, p_note text) returns void
language sql security definer set search_path = '' as $$
  insert into public.filing_events (client_id, filing_id, from_status, to_status, event, note)
  values (p_f.client_id, p_f.id, p_from, p_f.status, p_event, nullif(btrim(coalesce(p_note, '')), ''));
$$;

-- Creates the missing filings for the client's deadlines in the range.
-- Idempotent: running it again (or retrying) creates nothing twice.
create function public.generate_filing_calendar(p_client_id uuid, p_from date, p_to date) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer := 0;
  v_id uuid;
  f public.filings;
  x record;
begin
  perform private.require_active_user();
  if not private.ops_is_preparer(p_client_id) then
    raise exception 'only accountants, reviewers and managers of this client can build its calendar' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception 'choose a range of up to two years' using errcode = '22023';
  end if;
  for x in
    select d.id as deadline_id, d.preparer_id, d.reviewer_id, d.starts_on, d.ends_on, r.id as rule_id, r.code,
           r.title, coalesce(r.form_code, r.code) as form_code, r.due_months_after, r.due_day, r.weekend_rule,
           p.period_from, p.period_to
      from public.client_deadlines d
      join public.deadline_rules r on r.id = d.rule_id and r.status <> 'retired'
      cross join lateral private.ops_periods(r.frequency, d.anchor_month, p_from, p_to) p
     where d.client_id = p_client_id
       and p.period_to >= d.starts_on
       and (d.ends_on is null or p.period_from <= d.ends_on)
       and not (p.period_no = any (r.skip_periods))
     order by p.period_to, r.code
  loop
    v_id := null;
    insert into public.filings (client_id, rule_id, form_code, title, period_from, period_to, due_on, due_basis,
                                preparer_id, reviewer_id)
    values (p_client_id, x.rule_id, x.form_code, x.title, x.period_from, x.period_to,
            private.ops_due_date(x.period_to, x.due_months_after, x.due_day, x.weekend_rule), 'rule',
            case when private.ops_eligible(x.preparer_id, p_client_id, false) then x.preparer_id end,
            case when private.ops_eligible(x.reviewer_id, p_client_id, true) then x.reviewer_id end)
    on conflict (client_id, form_code, period_from, period_to) where amends_id is null do nothing
    returning id into v_id;
    if v_id is not null then
      select * into f from public.filings where id = v_id;
      perform private.filing_event(f, null, 'created', 'From deadline rule ' || x.code);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- A filing not covered by a deadline rule (due date entered by hand, with the reason).
create function public.add_filing(
  p_client_id uuid, p_form_code text, p_title text, p_period_from date, p_period_to date, p_due_on date, p_reason text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  f public.filings;
begin
  perform private.require_active_user();
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only reviewers and managers of this client can add filings' using errcode = '42501';
  end if;
  if p_due_on is null or p_period_from is null or p_period_to is null then
    raise exception 'enter the period and the due date' using errcode = '22023';
  end if;
  insert into public.filings (client_id, form_code, title, period_from, period_to, due_on, due_basis)
  values (p_client_id, btrim(p_form_code), btrim(p_title), p_period_from, p_period_to, p_due_on, 'manual')
  returning * into f;
  perform private.filing_event(f, null, 'created', 'Manual due date: ' || private.ops_note(p_reason, 5, 'write where the due date comes from'));
  return f.id;
end;
$$;

-- Preparer and reviewer of a filing. Managers assign anyone eligible; others may
-- only claim an unclaimed preparer slot for themselves. Replacing a person needs a reason.
create function public.assign_filing(
  p_id uuid, p_preparer_id uuid, p_reviewer_id uuid, p_reason text, p_version integer
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  f public.filings;
  v_manager boolean;
begin
  select * into f from public.filings where id = p_id for update;
  if not found or not private.is_assigned(f.client_id) then
    raise exception 'filing not found' using errcode = 'P0002';
  end if;
  if f.preparer_id is not distinct from p_preparer_id and f.reviewer_id is not distinct from p_reviewer_id then
    return;
  end if;
  perform private.ops_check_version(f.version, p_version);
  if f.status in ('filed', 'not_required') then
    raise exception 'a closed filing cannot be reassigned' using errcode = '22023';
  end if;
  v_manager := private.ops_is_manager(f.client_id);
  if not v_manager and not (f.preparer_id is null and p_preparer_id = v_uid
                            and f.reviewer_id is not distinct from p_reviewer_id and private.ops_is_preparer(f.client_id)) then
    raise exception 'only a firm manager can reassign a filing; you can only claim an unassigned one' using errcode = '42501';
  end if;
  if p_preparer_id is not null and not private.ops_eligible(p_preparer_id, f.client_id, false) then
    raise exception 'the preparer is not assigned to this client' using errcode = '22023';
  end if;
  if p_reviewer_id is not null and not private.ops_eligible(p_reviewer_id, f.client_id, true) then
    raise exception 'the reviewer must be a reviewer or manager assigned to this client' using errcode = '22023';
  end if;
  if p_reviewer_id is not null and (p_reviewer_id = p_preparer_id or p_reviewer_id = f.prepared_by) then
    raise exception 'the reviewer cannot be the preparer' using errcode = '22023';
  end if;
  if (f.preparer_id is not null and f.preparer_id is distinct from p_preparer_id)
     or (f.reviewer_id is not null and f.reviewer_id is distinct from p_reviewer_id) then
    perform private.ops_note(p_reason, 5, 'write the reason for the reassignment');
  end if;
  update public.filings set preparer_id = p_preparer_id, reviewer_id = p_reviewer_id, version = version + 1
   where id = p_id returning * into f;
  perform private.filing_event(f, f.status, 'assigned', p_reason);
  if p_preparer_id is not null then
    perform private.ops_notify(p_preparer_id, f.client_id, 'filing_assigned', 'Filing assigned to you',
      private.ops_client_code(f.client_id) || ' · ' || f.form_code || ' for ' || f.period_from || ' to ' || f.period_to
        || ' · due ' || f.due_on, private.ops_link(f.client_id, 'filing', f.id), 'filing_assigned:' || f.id || ':' || f.version);
  end if;
  if p_reviewer_id is not null then
    perform private.ops_notify(p_reviewer_id, f.client_id, 'filing_assigned', 'Filing review assigned to you',
      private.ops_client_code(f.client_id) || ' · ' || f.form_code || ' for ' || f.period_from || ' to ' || f.period_to
        || ' · due ' || f.due_on, private.ops_link(f.client_id, 'filing', f.id), 'filing_review_assigned:' || f.id || ':' || f.version);
  end if;
end;
$$;

-- The filing workflow. Each step is a separate status with who and when:
--   not_started -> in_preparation -> prepared -> in_review -> approved -> exported -> filed
--   in_review -> in_preparation (returned);  not_started|in_preparation -> not_required
-- 'filed' is recorded ONLY from an actual filing confirmation (reference and
-- evidence); generating or downloading a file never changes a filing.
create function public.advance_filing(p_id uuid, p_action text, p_data jsonb, p_version integer) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  f public.filings;
  v_from text;
  v_target text;
  v_note text;
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_wp public.tax_workpapers;
  v_run uuid;
  v_method text;
  v_filed_on date;
  v_code text;
  v_desc text;
begin
  select * into f from public.filings where id = p_id for update;
  if not found or not private.is_assigned(f.client_id) then
    raise exception 'filing not found' using errcode = 'P0002';
  end if;
  v_target := case p_action
    when 'start' then 'in_preparation' when 'prepared' then 'prepared' when 'submit' then 'in_review'
    when 'return' then 'in_preparation' when 'approve' then 'approved' when 'export' then 'exported'
    when 'confirm_filed' then 'filed' when 'not_required' then 'not_required' end;
  if v_target is null then
    raise exception 'unknown filing action' using errcode = '22023';
  end if;
  -- Repeating a step that already happened (e.g. a retried request) changes nothing.
  if f.status = v_target and p_action <> 'return' then
    return f.status;
  end if;
  perform private.ops_check_version(f.version, p_version);
  v_from := f.status;
  v_note := nullif(btrim(coalesce(v_data ->> 'note', '')), '');
  v_code := private.ops_client_code(f.client_id);
  v_desc := v_code || ' · ' || f.form_code || ' for ' || f.period_from || ' to ' || f.period_to;

  if p_action = 'start' then
    if f.status <> 'not_started' then
      raise exception 'only a filing that has not started can be started' using errcode = '22023';
    end if;
    if not private.ops_is_preparer(f.client_id) then
      raise exception 'only accountants, reviewers and managers can prepare filings' using errcode = '42501';
    end if;
    if f.preparer_id is not null and f.preparer_id <> v_uid and not private.ops_is_manager(f.client_id) then
      raise exception 'this filing is assigned to another preparer' using errcode = '42501';
    end if;
    update public.filings set status = 'in_preparation', preparer_id = coalesce(preparer_id, v_uid), version = version + 1
     where id = p_id returning * into f;

  elsif p_action = 'prepared' then
    if f.status <> 'in_preparation' then
      raise exception 'only a filing in preparation can be marked prepared' using errcode = '22023';
    end if;
    if f.preparer_id is distinct from v_uid then
      raise exception 'only the assigned preparer can mark the filing prepared' using errcode = '42501';
    end if;
    if v_data ? 'workpaper_id' and coalesce(v_data ->> 'workpaper_id', '') <> '' then
      select * into v_wp from public.tax_workpapers
       where id = (v_data ->> 'workpaper_id')::uuid and client_id = f.client_id;
      if not found or v_wp.status not in ('prepared', 'signed_off') or v_wp.form_code <> f.form_code
         or v_wp.period_from <> f.period_from or v_wp.period_to <> f.period_to then
        raise exception 'the workpaper must be a current workpaper of the same form and period' using errcode = '22023';
      end if;
    elsif v_note is null or char_length(v_note) < 10 then
      raise exception 'link the workpaper, or describe how the return was prepared' using errcode = '22023';
    end if;
    update public.filings set status = 'prepared', prepared_by = v_uid, prepared_at = now(),
           workpaper_id = v_wp.id, version = version + 1
     where id = p_id returning * into f;

  elsif p_action = 'submit' then
    if f.status <> 'prepared' then
      raise exception 'only a prepared filing can be submitted for review' using errcode = '22023';
    end if;
    if f.prepared_by <> v_uid and not private.ops_is_manager(f.client_id) then
      raise exception 'only the preparer can submit the filing for review' using errcode = '42501';
    end if;
    if f.reviewer_id is null then
      raise exception 'assign a reviewer first' using errcode = '22023';
    end if;
    update public.filings set status = 'in_review', version = version + 1 where id = p_id returning * into f;
    perform private.ops_notify(f.reviewer_id, f.client_id, 'filing_review', 'Filing ready for your review', v_desc,
      private.ops_link(f.client_id, 'filing', f.id), 'filing_review:' || f.id || ':' || f.version);

  elsif p_action in ('return', 'approve') then
    if f.status <> 'in_review' then
      raise exception 'only a filing in review can be approved or returned' using errcode = '22023';
    end if;
    if not private.can_approve_entries(f.client_id) then
      raise exception 'only reviewers and managers can review filings' using errcode = '42501';
    end if;
    if f.prepared_by = v_uid then
      raise exception 'you prepared this filing, so another person must review it' using errcode = '42501';
    end if;
    if f.reviewer_id <> v_uid and not private.ops_is_manager(f.client_id) then
      raise exception 'this filing is assigned to another reviewer' using errcode = '42501';
    end if;
    if p_action = 'return' then
      v_note := private.ops_note(v_note, 5, 'write what needs to change');
      update public.filings set status = 'in_preparation', prepared_by = null, prepared_at = null, version = version + 1
       where id = p_id returning * into f;
      perform private.ops_notify(f.preparer_id, f.client_id, 'filing_returned', 'Filing returned to you', v_desc,
        private.ops_link(f.client_id, 'filing', f.id), 'filing_returned:' || f.id || ':' || f.version);
    else
      v_note := private.ops_note(v_note, 10, 'write the approval note (what you reviewed)');
      if f.workpaper_id is not null and not exists (
        select 1 from public.tax_workpapers where id = f.workpaper_id and status = 'signed_off') then
        raise exception 'the linked workpaper must be signed off first' using errcode = '22023';
      end if;
      update public.filings set status = 'approved', approved_by = v_uid, approved_at = now(), approval_note = v_note,
             version = version + 1
       where id = p_id returning * into f;
      perform private.ops_notify(f.preparer_id, f.client_id, 'filing_approved', 'Filing approved', v_desc,
        private.ops_link(f.client_id, 'filing', f.id), 'filing_approved:' || f.id || ':' || f.version);
    end if;

  elsif p_action = 'export' then
    if f.status <> 'approved' then
      raise exception 'only an approved filing can be exported' using errcode = '22023';
    end if;
    if not private.ops_is_preparer(f.client_id) then
      raise exception 'only accountants, reviewers and managers can record an export' using errcode = '42501';
    end if;
    v_method := v_data ->> 'method';
    if v_method = 'validated_file' then
      select id into v_run from public.output_runs
       where id = nullif(v_data ->> 'output_run_id', '')::uuid and client_id = f.client_id
         and status in ('validated', 'signed_off');
      if v_run is null then
        raise exception 'the file must be a validated electronic output of this client' using errcode = '22023';
      end if;
    elsif v_method in ('official_form_tool', 'manual_form') then
      if char_length(btrim(coalesce(v_data ->> 'reference', ''))) < 3 then
        raise exception 'write where the exported return is kept (file name or reference)' using errcode = '22023';
      end if;
    else
      raise exception 'choose how the return was exported' using errcode = '22023';
    end if;
    update public.filings set status = 'exported', export_method = v_method, output_run_id = v_run,
           export_reference = nullif(btrim(coalesce(v_data ->> 'reference', '')), ''),
           exported_by = v_uid, exported_at = now(), version = version + 1
     where id = p_id returning * into f;

  elsif p_action = 'confirm_filed' then
    if f.status <> 'exported' then
      raise exception 'record the export first; filing is confirmed only after an actual submission' using errcode = '22023';
    end if;
    if not private.ops_is_preparer(f.client_id) then
      raise exception 'only accountants, reviewers and managers can confirm a filing' using errcode = '42501';
    end if;
    begin
      v_filed_on := (v_data ->> 'filed_on')::date;
    exception when others then
      v_filed_on := null;
    end;
    if v_filed_on is null or v_filed_on > current_date or v_filed_on < f.period_from then
      raise exception 'enter the actual filing date' using errcode = '22023';
    end if;
    if char_length(btrim(coalesce(v_data ->> 'channel', ''))) < 2
       or char_length(btrim(coalesce(v_data ->> 'reference', ''))) < 3
       or char_length(btrim(coalesce(v_data ->> 'evidence', ''))) < 5 then
      raise exception 'enter the filing channel, the confirmation reference and where the proof is kept' using errcode = '22023';
    end if;
    update public.filings set status = 'filed', filed_on = v_filed_on, filing_channel = btrim(v_data ->> 'channel'),
           filing_reference = btrim(v_data ->> 'reference'), filing_evidence = btrim(v_data ->> 'evidence'),
           filed_confirmed_by = v_uid, filed_confirmed_at = now(), version = version + 1
     where id = p_id returning * into f;
    perform private.ops_notify(f.preparer_id, f.client_id, 'filing_filed', 'Filing confirmed as filed', v_desc,
      private.ops_link(f.client_id, 'filing', f.id), 'filing_filed:' || f.id);
    perform private.ops_notify(f.reviewer_id, f.client_id, 'filing_filed', 'Filing confirmed as filed', v_desc,
      private.ops_link(f.client_id, 'filing', f.id), 'filing_filed:' || f.id);
    perform private.ops_notify_client(f.client_id, 'filing_filed', 'Your accountant confirmed a tax filing',
      f.form_code || ' for ' || f.period_from || ' to ' || f.period_to || ' was filed on ' || f.filed_on,
      private.ops_link(f.client_id, 'portal_requests', null), 'filing_filed:' || f.id);

  elsif p_action = 'not_required' then
    if f.status not in ('not_started', 'in_preparation') then
      raise exception 'only a filing not yet prepared can be marked not required' using errcode = '22023';
    end if;
    if not private.ops_is_manager(f.client_id) then
      raise exception 'only a firm manager can mark a filing not required' using errcode = '42501';
    end if;
    v_note := private.ops_note(v_note, 10, 'write why no filing is required');
    update public.filings set status = 'not_required', not_required_reason = v_note, version = version + 1
     where id = p_id returning * into f;
  end if;

  perform private.filing_event(f, v_from, p_action, coalesce(v_note, v_data ->> 'reference'));
  return f.status;
end;
$$;

-- An amended return: a new filing linked to the filed original (which stays filed).
create function public.amend_filing(p_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  o public.filings;
  f public.filings;
begin
  perform private.require_active_user();
  select * into o from public.filings where id = p_id;
  if not found or not private.is_assigned(o.client_id) then
    raise exception 'filing not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(o.client_id) then
    raise exception 'only reviewers and managers can start an amendment' using errcode = '42501';
  end if;
  if o.status <> 'filed' then
    raise exception 'only a filed return can be amended' using errcode = '22023';
  end if;
  insert into public.filings (client_id, rule_id, form_code, title, period_from, period_to, due_on, due_basis,
                              preparer_id, reviewer_id, amends_id)
  values (o.client_id, o.rule_id, o.form_code, left('Amended: ' || o.title, 200), o.period_from, o.period_to,
          current_date, 'manual', o.preparer_id, o.reviewer_id, o.id)
  returning * into f;
  perform private.filing_event(f, null, 'created', 'Amendment: ' || private.ops_note(p_reason, 10, 'write why the return is amended'));
  return f.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Work queue
-- ---------------------------------------------------------------------------
create function private.work_event(p_w public.work_items, p_from text, p_event text, p_note text) returns void
language sql security definer set search_path = '' as $$
  insert into public.work_item_events (client_id, item_id, from_status, to_status, event, note)
  values (p_w.client_id, p_w.id, p_from, p_w.status, p_event, nullif(btrim(coalesce(p_note, '')), ''));
$$;

create function private.ops_link_ok(p_client uuid, p_type text, p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'journal_entry' then exists (select 1 from public.journal_entries where id = p_id and client_id = p_client)
    when 'intake_transaction' then exists (select 1 from public.intake_transactions where id = p_id and client_id = p_client)
    when 'filing' then exists (select 1 from public.filings where id = p_id and client_id = p_client)
    when 'document_request' then exists (select 1 from public.document_requests where id = p_id and client_id = p_client)
    when 'exception' then exists (select 1 from public.ops_exceptions where id = p_id and client_id = p_client)
    else p_type is null and p_id is null
  end;
$$;

create function public.create_work_item(p_client_id uuid, p_item jsonb, p_idempotency_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  w public.work_items;
  v_assignee uuid := nullif(p_item ->> 'assignee_id', '')::uuid;
  v_reviewer uuid := nullif(p_item ->> 'reviewer_id', '')::uuid;
  v_link_type text := nullif(p_item ->> 'link_type', '');
  v_link_id uuid := nullif(p_item ->> 'link_id', '')::uuid;
begin
  if not private.is_assigned(p_client_id) then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  -- A retried request returns the item it already created.
  select * into w from public.work_items where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    if w.created_by <> v_uid then
      raise exception 'this request key was already used' using errcode = '23505';
    end if;
    return w.id;
  end if;
  if char_length(btrim(coalesce(p_item ->> 'title', ''))) < 3 then
    raise exception 'write a title of at least three characters' using errcode = '22023';
  end if;
  if v_assignee is not null and not private.ops_eligible(v_assignee, p_client_id, false) then
    raise exception 'the assignee is not assigned to this client' using errcode = '22023';
  end if;
  if v_reviewer is not null and not private.ops_eligible(v_reviewer, p_client_id, true) then
    raise exception 'the reviewer must be a reviewer or manager assigned to this client' using errcode = '22023';
  end if;
  if not private.ops_link_ok(p_client_id, v_link_type, v_link_id) then
    raise exception 'the linked record was not found for this client' using errcode = '22023';
  end if;
  insert into public.work_items (client_id, kind, title, details, priority, assignee_id, reviewer_id, requires_review,
                                 due_on, link_type, link_id, idempotency_key, created_by)
  values (p_client_id, coalesce(p_item ->> 'kind', 'task'), btrim(coalesce(p_item ->> 'title', '')),
          nullif(btrim(p_item ->> 'details'), ''), coalesce(nullif(p_item ->> 'priority', ''), 'normal'),
          v_assignee, v_reviewer, coalesce((p_item ->> 'requires_review')::boolean, true),
          nullif(p_item ->> 'due_on', '')::date, v_link_type, v_link_id, p_idempotency_key, v_uid)
  returning * into w;
  perform private.work_event(w, null, 'created', null);
  perform private.ops_notify(v_assignee, p_client_id, 'work_assigned', 'Work item assigned to you',
    'Client ' || private.ops_client_code(p_client_id) || coalesce(' · due ' || w.due_on, ''),
    private.ops_link(p_client_id, 'work', w.id), 'work_assigned:' || w.id || ':' || w.version);
  return w.id;
end;
$$;

create function public.transition_work_item(p_id uuid, p_to text, p_note text, p_version integer) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  w public.work_items;
  v_from text;
  v_manager boolean;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_desc text;
begin
  select * into w from public.work_items where id = p_id for update;
  if not found or not private.is_assigned(w.client_id) then
    raise exception 'work item not found' using errcode = 'P0002';
  end if;
  if w.status = p_to then
    return w.status;
  end if;
  perform private.ops_check_version(w.version, p_version);
  v_from := w.status;
  v_manager := private.ops_is_manager(w.client_id);
  v_desc := 'Client ' || private.ops_client_code(w.client_id);

  if p_to = 'cancelled' and v_from in ('open', 'in_progress', 'waiting_client', 'in_review') then
    if w.created_by <> v_uid and not v_manager then
      raise exception 'only the creator or a firm manager can cancel a work item' using errcode = '42501';
    end if;
    v_note := private.ops_note(v_note, 5, 'write why the item is cancelled');
    update public.work_items set status = 'cancelled', version = version + 1 where id = p_id returning * into w;

  elsif (v_from, p_to) in (('open', 'in_progress'), ('open', 'waiting_client'), ('in_progress', 'waiting_client'),
                          ('waiting_client', 'in_progress')) then
    if w.assignee_id is null and private.ops_eligible(v_uid, w.client_id, false) and w.reviewer_id is distinct from v_uid then
      w.assignee_id := v_uid; -- claiming an unassigned item
    elsif w.assignee_id is distinct from v_uid and not v_manager then
      raise exception 'only the assignee or a firm manager can work on this item' using errcode = '42501';
    end if;
    update public.work_items set status = p_to, assignee_id = w.assignee_id, version = version + 1
     where id = p_id returning * into w;

  elsif (v_from, p_to) = ('in_progress', 'in_review') then
    if not w.requires_review then
      raise exception 'this item does not need review; mark it done' using errcode = '22023';
    end if;
    if w.assignee_id is distinct from v_uid and not v_manager then
      raise exception 'only the assignee can submit the item for review' using errcode = '42501';
    end if;
    if w.reviewer_id is null then
      raise exception 'assign a reviewer first' using errcode = '22023';
    end if;
    update public.work_items set status = 'in_review', version = version + 1 where id = p_id returning * into w;
    perform private.ops_notify(w.reviewer_id, w.client_id, 'work_review', 'Work item ready for your review', v_desc,
      private.ops_link(w.client_id, 'work', w.id), 'work_review:' || w.id || ':' || w.version);

  elsif (v_from, p_to) = ('in_progress', 'done') then
    if w.requires_review then
      raise exception 'this item needs a reviewer''s approval' using errcode = '22023';
    end if;
    if w.assignee_id is distinct from v_uid and not v_manager then
      raise exception 'only the assignee can complete the item' using errcode = '42501';
    end if;
    update public.work_items set status = 'done', completed_by = v_uid, completed_at = now(), version = version + 1
     where id = p_id returning * into w;

  elsif v_from = 'in_review' and p_to in ('done', 'in_progress') then
    if w.assignee_id = v_uid then
      raise exception 'you did this work, so another person must review it' using errcode = '42501';
    end if;
    if w.reviewer_id is distinct from v_uid and not v_manager then
      raise exception 'only the assigned reviewer or a firm manager can review this item' using errcode = '42501';
    end if;
    if p_to = 'in_progress' then
      v_note := private.ops_note(v_note, 5, 'write what needs to change');
      update public.work_items set status = 'in_progress', version = version + 1 where id = p_id returning * into w;
      perform private.ops_notify(w.assignee_id, w.client_id, 'work_returned', 'Work item returned to you', v_desc,
        private.ops_link(w.client_id, 'work', w.id), 'work_returned:' || w.id || ':' || w.version);
    else
      update public.work_items set status = 'done', completed_by = v_uid, completed_at = now(), version = version + 1
       where id = p_id returning * into w;
      perform private.ops_notify(w.assignee_id, w.client_id, 'work_approved', 'Work item approved', v_desc,
        private.ops_link(w.client_id, 'work', w.id), 'work_approved:' || w.id);
    end if;

  else
    raise exception 'a work item cannot move from % to %', v_from, p_to using errcode = '22023';
  end if;

  perform private.work_event(w, v_from, case when v_from = 'in_review' and p_to = 'in_progress' then 'returned' else p_to end, v_note);
  return w.status;
end;
$$;

-- Reassignment. Managers assign anyone eligible; other staff may only claim an
-- unassigned item for themselves. Replacing a person needs a reason.
create function public.assign_work_item(
  p_id uuid, p_assignee_id uuid, p_reviewer_id uuid, p_reason text, p_version integer
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  w public.work_items;
  v_old public.work_items;
begin
  select * into w from public.work_items where id = p_id for update;
  if not found or not private.is_assigned(w.client_id) then
    raise exception 'work item not found' using errcode = 'P0002';
  end if;
  if w.assignee_id is not distinct from p_assignee_id and w.reviewer_id is not distinct from p_reviewer_id then
    return;
  end if;
  perform private.ops_check_version(w.version, p_version);
  if w.status in ('done', 'cancelled') then
    raise exception 'a closed work item cannot be reassigned' using errcode = '22023';
  end if;
  if not private.ops_is_manager(w.client_id)
     and not (w.assignee_id is null and p_assignee_id = v_uid and w.reviewer_id is not distinct from p_reviewer_id) then
    raise exception 'only a firm manager can reassign work; you can only claim unassigned items' using errcode = '42501';
  end if;
  if p_assignee_id is not null and not private.ops_eligible(p_assignee_id, w.client_id, false) then
    raise exception 'the assignee is not assigned to this client' using errcode = '22023';
  end if;
  if p_reviewer_id is not null and not private.ops_eligible(p_reviewer_id, w.client_id, true) then
    raise exception 'the reviewer must be a reviewer or manager assigned to this client' using errcode = '22023';
  end if;
  if p_reviewer_id is not null and p_reviewer_id = p_assignee_id then
    raise exception 'the reviewer cannot be the assignee' using errcode = '22023';
  end if;
  if (w.assignee_id is not null and w.assignee_id is distinct from p_assignee_id)
     or (w.reviewer_id is not null and w.reviewer_id is distinct from p_reviewer_id) then
    perform private.ops_note(p_reason, 5, 'write the reason for the reassignment');
  end if;
  v_old := w;
  update public.work_items set assignee_id = p_assignee_id, reviewer_id = p_reviewer_id, version = version + 1
   where id = p_id returning * into w;
  perform private.work_event(w, w.status, 'assigned', p_reason);
  if p_assignee_id is distinct from v_old.assignee_id then
    perform private.ops_notify(p_assignee_id, w.client_id, 'work_assigned', 'Work item assigned to you',
      'Client ' || private.ops_client_code(w.client_id), private.ops_link(w.client_id, 'work', w.id),
      'work_assigned:' || w.id || ':' || w.version);
    perform private.ops_notify(v_old.assignee_id, w.client_id, 'work_reassigned', 'Work item reassigned to someone else',
      'Client ' || private.ops_client_code(w.client_id), private.ops_link(w.client_id, 'work', w.id),
      'work_reassigned:' || w.id || ':' || w.version);
  end if;
  if p_reviewer_id is distinct from v_old.reviewer_id then
    perform private.ops_notify(p_reviewer_id, w.client_id, 'work_assigned', 'Work item review assigned to you',
      'Client ' || private.ops_client_code(w.client_id), private.ops_link(w.client_id, 'work', w.id),
      'work_review_assigned:' || w.id || ':' || w.version);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Missing-document requests
-- ---------------------------------------------------------------------------
create function private.request_event(p_r public.document_requests, p_from text, p_event text, p_note text) returns void
language sql security definer set search_path = '' as $$
  insert into public.document_request_events (client_id, request_id, from_status, to_status, event, note)
  values (p_r.client_id, p_r.id, p_from, p_r.status, p_event, nullif(btrim(coalesce(p_note, '')), ''));
$$;

create function public.create_document_request(p_client_id uuid, p_req jsonb, p_idempotency_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.document_requests;
begin
  if not private.is_assigned(p_client_id) then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  select * into r from public.document_requests where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    if r.requested_by <> v_uid then
      raise exception 'this request key was already used' using errcode = '23505';
    end if;
    return r.id;
  end if;
  if nullif(p_req ->> 'due_on', '') is null then
    raise exception 'choose the due date' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_req ->> 'title', ''))) < 3 then
    raise exception 'write what is needed (at least three characters)' using errcode = '22023';
  end if;
  insert into public.document_requests (client_id, title, details, category, period_from, period_to, due_on,
                                        idempotency_key, requested_by)
  values (p_client_id, btrim(coalesce(p_req ->> 'title', '')), nullif(btrim(p_req ->> 'details'), ''),
          nullif(p_req ->> 'category', '')::public.document_category,
          nullif(p_req ->> 'period_from', '')::date, nullif(p_req ->> 'period_to', '')::date,
          (p_req ->> 'due_on')::date, p_idempotency_key, v_uid)
  returning * into r;
  perform private.request_event(r, null, 'created', null);
  perform private.ops_notify_client(p_client_id, 'document_request', 'New document request from your accountant',
    'Due ' || r.due_on || '.', private.ops_link(p_client_id, 'portal_requests', null), 'document_request:' || r.id);
  return r.id;
end;
$$;

-- The client responds with uploaded documents (or explains why there are none).
create function public.respond_document_request(p_id uuid, p_document_ids uuid[], p_note text, p_version integer)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.document_requests;
  v_from text;
  v_docs uuid[] := coalesce(p_document_ids, '{}');
begin
  select * into r from public.document_requests where id = p_id for update;
  if not found or not private.can_read_client(r.client_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if coalesce(private.client_role(r.client_id) in ('client_owner', 'client_staff'), false) is false then
    raise exception 'only the business owner or its staff can respond to a request' using errcode = '42501';
  end if;
  if r.status = 'submitted' and r.responded_by = v_uid and r.document_ids = v_docs then
    return; -- retried submission
  end if;
  perform private.ops_check_version(r.version, p_version);
  if r.status not in ('open', 'returned') then
    raise exception 'this request is not waiting for a response' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_docs) d
              where not exists (select 1 from public.documents x where x.id = d and x.client_id = r.client_id
                                   and x.upload_state = 'complete' and x.deleted_at is null)) then
    raise exception 'attach documents uploaded for this business' using errcode = '22023';
  end if;
  if cardinality(v_docs) = 0 and char_length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'attach at least one document, or explain why there is none' using errcode = '22023';
  end if;
  v_from := r.status;
  update public.document_requests
     set status = 'submitted', document_ids = v_docs, response_note = nullif(btrim(coalesce(p_note, '')), ''),
         responded_by = v_uid, responded_at = now(), version = version + 1
   where id = p_id returning * into r;
  perform private.request_event(r, v_from, 'submitted', p_note);
  perform private.ops_notify(r.requested_by, r.client_id, 'document_response', 'Client responded to a document request',
    'Client ' || private.ops_client_code(r.client_id), private.ops_link(r.client_id, 'operations', null),
    'document_response:' || r.id || ':' || r.version);
end;
$$;

create function public.decide_document_request(p_id uuid, p_decision text, p_note text, p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.document_requests;
  v_to text := case p_decision when 'accept' then 'accepted' when 'return' then 'returned' when 'cancel' then 'cancelled' end;
  v_from text;
begin
  select * into r from public.document_requests where id = p_id for update;
  if not found or not private.is_assigned(r.client_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_to is null then
    raise exception 'unknown decision' using errcode = '22023';
  end if;
  if r.status = v_to then
    return;
  end if;
  perform private.ops_check_version(r.version, p_version);
  if v_to in ('accepted', 'returned') and r.status <> 'submitted' then
    raise exception 'only a submitted response can be accepted or returned' using errcode = '22023';
  end if;
  if v_to = 'cancelled' then
    if r.status not in ('open', 'returned', 'submitted') then
      raise exception 'this request is already closed' using errcode = '22023';
    end if;
    if r.requested_by <> v_uid and not private.ops_is_manager(r.client_id) then
      raise exception 'only the requester or a firm manager can cancel a request' using errcode = '42501';
    end if;
  end if;
  if v_to <> 'accepted' then
    perform private.ops_note(p_note, 5, case when v_to = 'returned' then 'write what is still missing' else 'write why the request is cancelled' end);
  end if;
  v_from := r.status;
  update public.document_requests
     set status = v_to, decided_by = v_uid, decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         version = version + 1
   where id = p_id returning * into r;
  perform private.request_event(r, v_from, v_to, p_note);
  perform private.ops_notify_client(r.client_id, 'document_request_' || v_to,
    case v_to when 'accepted' then 'Your accountant accepted your documents'
              when 'returned' then 'Your accountant needs more for a document request'
              else 'A document request was cancelled' end,
    'Request due ' || r.due_on || '.', private.ops_link(r.client_id, 'portal_requests', null),
    'document_request_' || v_to || ':' || r.id || ':' || r.version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reminders (deadlines and requests). Safe to retry: every notification has a
-- dedupe key per item, due date and reminder day.
-- Callable by a firm manager or by a scheduled job using the service role.
-- ---------------------------------------------------------------------------
create function public.run_reminders(p_as_of date default current_date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_as_of date := coalesce(p_as_of, current_date);
  v_filings integer := 0;
  v_requests integer := 0;
  v_work integer := 0;
  v_n integer;
  v_days integer;
  v_title text;
  v_key text;
  x record;
begin
  if not (coalesce(private.firm_role() = 'firm_manager', false)
          or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'only firm managers or the scheduler can run reminders' using errcode = '42501';
  end if;
  if v_as_of not between current_date - 7 and current_date + 31 then
    raise exception 'reminders run for today (up to a week back for a missed run)' using errcode = '22023';
  end if;

  for x in
    select f.*, coalesce(r.reminder_days, '{7,3,1}'::smallint[]) as days
      from public.filings f left join public.deadline_rules r on r.id = f.rule_id
     where f.status not in ('filed', 'not_required')
  loop
    v_days := x.due_on - v_as_of;
    v_title := case
      when v_days = 0 then 'Filing due today'
      when v_days > 0 and v_days = any (x.days) then 'Filing due in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end
      when v_days < 0 and mod(-v_days, 7) = 1 then 'Filing overdue' end;
    continue when v_title is null;
    v_key := 'filing_due:' || x.id || ':' || x.due_on || ':' || v_days;
    v_n := 0;
    if x.preparer_id is null and x.reviewer_id is null then
      v_n := private.ops_notify_managers(x.client_id, 'filing_due', v_title,
        private.ops_client_code(x.client_id) || ' · ' || x.form_code || ' for ' || x.period_from || ' to ' || x.period_to
          || ' · due ' || x.due_on || ' · no one assigned', private.ops_link(x.client_id, 'filing', x.id), v_key, true);
    else
      v_n := private.ops_notify(x.preparer_id, x.client_id, 'filing_due', v_title,
               private.ops_client_code(x.client_id) || ' · ' || x.form_code || ' for ' || x.period_from || ' to ' || x.period_to
                 || ' · due ' || x.due_on, private.ops_link(x.client_id, 'filing', x.id), v_key, true)
           + private.ops_notify(x.reviewer_id, x.client_id, 'filing_due', v_title,
               private.ops_client_code(x.client_id) || ' · ' || x.form_code || ' for ' || x.period_from || ' to ' || x.period_to
                 || ' · due ' || x.due_on, private.ops_link(x.client_id, 'filing', x.id), v_key, true);
    end if;
    v_filings := v_filings + v_n;
  end loop;

  for x in select * from public.document_requests where status in ('open', 'returned') loop
    v_days := x.due_on - v_as_of;
    v_title := case
      when v_days = 0 then 'A document request is due today'
      when v_days in (3, 1) then 'A document request is due soon'
      when v_days < 0 and mod(-v_days, 7) = 1 then 'A document request is overdue' end;
    continue when v_title is null;
    v_n := private.ops_notify_client(x.client_id, 'document_reminder', v_title, 'Due ' || x.due_on || '.',
      private.ops_link(x.client_id, 'portal_requests', null), 'document_reminder:' || x.id || ':' || x.due_on || ':' || v_days, true);
    if v_n > 0 then
      update public.document_requests set reminder_count = reminder_count + 1, last_reminded_on = v_as_of where id = x.id;
      insert into public.document_request_events (client_id, request_id, from_status, to_status, event, note)
      values (x.client_id, x.id, x.status, x.status, 'reminded', v_title);
    end if;
    v_requests := v_requests + v_n;
  end loop;

  for x in select * from public.work_items where status not in ('done', 'cancelled') and due_on is not null loop
    v_days := x.due_on - v_as_of;
    v_title := case when v_days = 0 then 'Work item due today'
                    when v_days < 0 and mod(-v_days, 7) = 1 then 'Work item overdue' end;
    continue when v_title is null;
    v_work := v_work + private.ops_notify(coalesce(x.assignee_id, x.reviewer_id), x.client_id, 'work_due', v_title,
      'Client ' || private.ops_client_code(x.client_id) || ' · due ' || x.due_on, private.ops_link(x.client_id, 'work', x.id),
      'work_due:' || x.id || ':' || x.due_on || ':' || v_days, true);
  end loop;

  perform audit.log_event('ops.reminders_run', null,
    jsonb_build_object('as_of', v_as_of, 'filings', v_filings, 'requests', v_requests, 'work', v_work));
  return jsonb_build_object('filings', v_filings, 'requests', v_requests, 'work', v_work);
end;
$$;

create function public.mark_notifications_read(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  perform private.require_active_user();
  update public.notifications set read_at = now()
   where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client service status
-- ---------------------------------------------------------------------------
create function public.set_client_service_status(p_client_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_current text;
begin
  perform private.require_active_user();
  if not private.ops_is_manager(p_client_id) then
    raise exception 'only firm managers can change a client''s service status' using errcode = '42501';
  end if;
  select status into v_current from public.client_service_status where client_id = p_client_id order by id desc limit 1;
  if v_current is not distinct from p_status then
    return;
  end if;
  insert into public.client_service_status (client_id, status, reason)
  values (p_client_id, p_status, private.ops_note(p_reason, 3, 'write the reason'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Exception requests (two people: a requester and a firm manager)
-- ---------------------------------------------------------------------------
create function public.request_exception(p_client_id uuid, p_kind text, p_data jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_period uuid := nullif(v_data ->> 'period_id', '')::uuid;
  v_filing uuid := nullif(v_data ->> 'filing_id', '')::uuid;
  v_id uuid;
begin
  if not private.ops_is_preparer(p_client_id) then
    raise exception 'only accountants, reviewers and managers of this client can request an exception' using errcode = '42501';
  end if;
  if p_kind = 'reopen_locked_period' and not exists (
       select 1 from public.accounting_periods where id = v_period and client_id = p_client_id and status = 'locked') then
    raise exception 'choose a locked period of this client' using errcode = '22023';
  end if;
  if p_kind = 'change_due_date' and not exists (
       select 1 from public.filings where id = v_filing and client_id = p_client_id and status not in ('filed', 'not_required')) then
    raise exception 'choose an open filing of this client' using errcode = '22023';
  end if;
  if p_kind = 'withdraw_filing_confirmation' and not exists (
       select 1 from public.filings where id = v_filing and client_id = p_client_id and status = 'filed') then
    raise exception 'choose a filed return of this client' using errcode = '22023';
  end if;
  if exists (select 1 from public.ops_exceptions
              where client_id = p_client_id and kind = p_kind and status = 'pending'
                and period_id is not distinct from v_period and filing_id is not distinct from v_filing
                and p_kind <> 'other') then
    raise exception 'the same exception is already waiting for a decision' using errcode = '23505';
  end if;
  insert into public.ops_exceptions (client_id, kind, period_id, target_status, filing_id, new_due_on, reason, requested_by)
  values (p_client_id, p_kind, v_period,
          case when p_kind = 'reopen_locked_period' then coalesce(nullif(v_data ->> 'target_status', ''), 'soft_closed')::public.period_status end,
          v_filing, nullif(v_data ->> 'new_due_on', '')::date, btrim(coalesce(p_reason, '')), v_uid)
  returning id into v_id;
  perform private.ops_notify_managers(p_client_id, 'exception_requested', 'Exception request waiting for a decision',
    'Client ' || private.ops_client_code(p_client_id), private.ops_link(p_client_id, 'exceptions', null),
    'exception_requested:' || v_id);
  return v_id;
end;
$$;

-- A firm manager other than the requester decides; an approval is carried out
-- immediately and recorded.
create function public.decide_exception(p_id uuid, p_approve boolean, p_note text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  e public.ops_exceptions;
  f public.filings;
begin
  select * into e from public.ops_exceptions where id = p_id for update;
  if not found or not private.is_assigned(e.client_id) then
    raise exception 'exception request not found' using errcode = 'P0002';
  end if;
  if not private.ops_is_manager(e.client_id) then
    raise exception 'only a firm manager can decide an exception request' using errcode = '42501';
  end if;
  if e.status <> 'pending' then
    if (e.status = 'approved') = coalesce(p_approve, false) and e.decided_by = v_uid then
      return e.status; -- retried decision
    end if;
    raise exception 'this request was already decided' using errcode = '22023';
  end if;
  if e.requested_by = v_uid then
    raise exception 'you requested this exception, so another manager must decide it' using errcode = '42501';
  end if;
  update public.ops_exceptions
     set status = case when p_approve then 'approved' else 'rejected' end, decided_by = v_uid, decided_at = now(),
         decision_note = private.ops_note(p_note, 5, 'write the reason for the decision')
   where id = p_id returning * into e;

  if e.status = 'approved' and e.kind <> 'other' then
    perform set_config('app.ops_exception', e.id::text, true);
    if e.kind = 'reopen_locked_period' then
      perform public.set_period_status(e.period_id, e.target_status, left('Exception approved: ' || e.reason, 500));
    elsif e.kind = 'change_due_date' then
      select * into f from public.filings where id = e.filing_id for update;
      if f.status in ('filed', 'not_required') then
        raise exception 'the filing is already closed' using errcode = '22023';
      end if;
      update public.filings set due_on = e.new_due_on, due_basis = 'approved_change', version = version + 1
       where id = e.filing_id returning * into f;
      perform private.filing_event(f, f.status, 'due_date_changed', 'Due date changed by approved exception: ' || e.reason);
    elsif e.kind = 'withdraw_filing_confirmation' then
      select * into f from public.filings where id = e.filing_id for update;
      if f.status <> 'filed' then
        raise exception 'the filing is no longer confirmed as filed' using errcode = '22023';
      end if;
      perform private.filing_event(f, 'filed', 'filing_confirmation_withdrawn',
        left('Withdrawn by approved exception: ' || e.reason || ' | was: filed on ' || f.filed_on || ' via ' || f.filing_channel
             || ', reference ' || f.filing_reference || ', evidence ' || f.filing_evidence, 2000));
      update public.filings set status = 'exported', filed_on = null, filing_channel = null, filing_reference = null,
             filing_evidence = null, filed_confirmed_by = null, filed_confirmed_at = null, version = version + 1
       where id = e.filing_id;
    end if;
    update public.ops_exceptions set executed_at = now() where id = p_id;
    perform set_config('app.ops_exception', '', true);
  end if;
  perform private.ops_notify(e.requested_by, e.client_id, 'exception_decided',
    case when e.status = 'approved' then 'Your exception request was approved' else 'Your exception request was rejected' end,
    'Client ' || private.ops_client_code(e.client_id), private.ops_link(e.client_id, 'operations', null),
    'exception_decided:' || e.id);
  return e.status;
end;
$$;

create function public.cancel_exception(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  update public.ops_exceptions set status = 'cancelled'
   where id = p_id and status = 'pending' and requested_by = auth.uid();
  if not found then
    raise exception 'pending request of yours not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Reopening a locked period now needs an approved exception (requested by one
-- person, approved by a firm manager who is someone else). Otherwise unchanged.
create or replace function public.set_period_status(
  p_period_id uuid, p_status public.period_status, p_reason text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_period public.accounting_periods;
begin
  perform private.require_active_user();
  select * into v_period from public.accounting_periods where id = p_period_id for update;
  if not found or not private.can_read_client(v_period.client_id) then
    raise exception 'period not found' using errcode = 'P0002';
  end if;
  if v_period.status = p_status then
    return;
  end if;
  if p_status = 'locked' or v_period.status = 'locked' then
    -- Locking and unlocking: firm managers only (SoD-4); unlocking needs a reason.
    if not (private.is_assigned(v_period.client_id) and private.firm_role() = 'firm_manager') then
      raise exception 'only firm managers can lock or reopen a locked period' using errcode = '42501';
    end if;
    if v_period.status = 'locked' and (p_reason is null or char_length(trim(p_reason)) < 3) then
      raise exception 'a reason is required to reopen a locked period' using errcode = '22023';
    end if;
    if v_period.status = 'locked' and not exists (
      select 1 from public.ops_exceptions e
       where e.id::text = coalesce(current_setting('app.ops_exception', true), '')
         and e.period_id = p_period_id and e.kind = 'reopen_locked_period'
         and e.status = 'approved' and e.executed_at is null and e.target_status = p_status
    ) then
      raise exception 'reopening a locked period needs an approved exception request' using errcode = '42501';
    end if;
    if p_status = 'locked' and exists (
      select 1 from public.journal_entries
      where period_id = p_period_id and status in ('draft', 'submitted')
    ) then
      raise exception 'post, return or void all draft and submitted entries before locking'
        using errcode = '22023';
    end if;
  elsif not private.can_approve_entries(v_period.client_id) then
    raise exception 'only reviewers and managers can close or reopen periods' using errcode = '42501';
  end if;
  update public.accounting_periods
     set status = p_status, status_changed_at = now(), status_changed_by = auth.uid(),
         status_reason = nullif(left(trim(coalesce(p_reason, '')), 500), '')
   where id = p_period_id;
  perform audit.log_event('period.status_changed', v_period.client_id,
    jsonb_build_object('period_id', p_period_id, 'from', v_period.status, 'to', p_status,
                       'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Access changes release work: when someone loses access to a client (assignment
-- removed, role changed, account disabled), their open items become unassigned
-- and managers are told. Accountability for completed steps is kept.
-- ---------------------------------------------------------------------------
create function private.ops_release(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  x record;
begin
  for x in
    select * from public.work_items
     where status not in ('done', 'cancelled')
       and ((assignee_id = p_user and not private.ops_eligible(p_user, client_id, false))
            or (reviewer_id = p_user and not private.ops_eligible(p_user, client_id, true)))
  loop
    update public.work_items
       set assignee_id = case when assignee_id = p_user and not private.ops_eligible(p_user, client_id, false) then null else assignee_id end,
           reviewer_id = case when reviewer_id = p_user and not private.ops_eligible(p_user, client_id, true) then null else reviewer_id end,
           version = version + 1
     where id = x.id;
    insert into public.work_item_events (client_id, item_id, from_status, to_status, event, note)
    values (x.client_id, x.id, x.status, x.status, 'unassigned', 'Access to the client changed');
    perform private.ops_notify_managers(x.client_id, 'work_unassigned', 'Work became unassigned after an access change',
      'Client ' || private.ops_client_code(x.client_id), private.ops_link(x.client_id, 'work', x.id),
      'work_unassigned:' || x.id || ':' || p_user || ':' || (x.version + 1));
  end loop;
  for x in
    select * from public.filings
     where status not in ('filed', 'not_required')
       and ((preparer_id = p_user and not private.ops_eligible(p_user, client_id, false))
            or (reviewer_id = p_user and not private.ops_eligible(p_user, client_id, true)))
  loop
    update public.filings
       set preparer_id = case when preparer_id = p_user and not private.ops_eligible(p_user, client_id, false) then null else preparer_id end,
           reviewer_id = case when reviewer_id = p_user and not private.ops_eligible(p_user, client_id, true) then null else reviewer_id end,
           version = version + 1
     where id = x.id;
    insert into public.filing_events (client_id, filing_id, from_status, to_status, event, note)
    values (x.client_id, x.id, x.status, x.status, 'unassigned', 'Access to the client changed');
    perform private.ops_notify_managers(x.client_id, 'filing_unassigned', 'Filing became unassigned after an access change',
      'Client ' || private.ops_client_code(x.client_id), private.ops_link(x.client_id, 'filing', x.id),
      'filing_unassigned:' || x.id || ':' || p_user || ':' || (x.version + 1));
  end loop;
  update public.client_deadlines set preparer_id = null
   where preparer_id = p_user and not private.ops_eligible(p_user, client_id, false);
  update public.client_deadlines set reviewer_id = null
   where reviewer_id = p_user and not private.ops_eligible(p_user, client_id, true);
end;
$$;

create function private.ops_release_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.purge_allowed() then
    return null;
  end if;
  if tg_table_name = 'profiles' then
    if old.is_active and not new.is_active then
      perform private.ops_release(new.id);
    end if;
  else
    perform private.ops_release(old.user_id);
  end if;
  return null;
end;
$$;

create trigger ops_release_on_unassign after delete on public.client_assignments
  for each row execute function private.ops_release_trigger();
create trigger ops_release_on_role_change after update or delete on public.firm_memberships
  for each row execute function private.ops_release_trigger();
create trigger ops_release_on_disable after update of is_active on public.profiles
  for each row execute function private.ops_release_trigger();

-- ---------------------------------------------------------------------------
-- Activity report (who did what, when). Values are NOT returned, only which
-- fields changed. Managers: everything; reviewers: their assigned clients;
-- firm admins: firm-level events (no client data). Viewing it is audited.
-- ---------------------------------------------------------------------------
create function public.ops_activity_report(p_client_id uuid, p_from date, p_to date)
returns table (occurred_at timestamptz, actor_id uuid, actor_name text, client_id uuid, client_code text,
               action text, table_name text, row_id text, changed_fields text[])
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.firm_role := private.firm_role();
begin
  perform private.require_active_user();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'choose a range of up to one year' using errcode = '22023';
  end if;
  if p_client_id is not null then
    if not (v_role = 'firm_manager' or private.can_approve_entries(p_client_id)) then
      raise exception 'only managers and the client''s reviewers can see its activity' using errcode = '42501';
    end if;
  elsif v_role is null or v_role not in ('firm_admin', 'firm_manager') then
    raise exception 'only firm admins and managers can see firm-wide activity' using errcode = '42501';
  end if;
  perform audit.log_event('ops.activity_report_viewed', p_client_id, jsonb_build_object('from', p_from, 'to', p_to));
  return query
    select e.occurred_at, e.actor_id, coalesce(nullif(p.full_name, ''), p.email), e.client_id, c.code, e.action,
           e.table_name, e.row_id,
           case when e.old_data is not null and e.new_data is not null then
             array(select k from jsonb_object_keys(e.new_data) k
                    where k not in ('updated_at', 'version', 'row_version')
                      and (e.old_data -> k) is distinct from (e.new_data -> k) order by k)
           end
      from audit.events e
      left join public.profiles p on p.id = e.actor_id
      left join public.clients c on c.id = e.client_id
     where e.occurred_at >= p_from and e.occurred_at < p_to + 1
       and (case
              when p_client_id is not null then e.client_id = p_client_id
              when v_role = 'firm_admin' then e.client_id is null
              else true
            end)
     order by e.occurred_at desc, e.id desc
     limit 2000;
end;
$$;

-- ---------------------------------------------------------------------------
-- Synthetic purge (adds the operations tables)
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
  delete from public.notifications where client_id = p_client_id;
  delete from public.ops_exceptions where client_id = p_client_id;
  delete from public.client_service_status where client_id = p_client_id;
  delete from public.document_request_events where client_id = p_client_id;
  delete from public.document_requests where client_id = p_client_id;
  delete from public.work_item_events where client_id = p_client_id;
  delete from public.work_items where client_id = p_client_id;
  delete from public.filing_events where client_id = p_client_id;
  delete from public.filings where client_id = p_client_id and amends_id is not null;
  delete from public.filings where client_id = p_client_id;
  delete from public.client_deadlines where client_id = p_client_id;
  delete from public.client_einvoice_assessments where client_id = p_client_id;
  delete from public.output_validations where client_id = p_client_id;
  delete from public.output_runs where client_id = p_client_id;
  delete from public.tax_workpaper_events where client_id = p_client_id;
  delete from public.tax_workpaper_entries where client_id = p_client_id;
  delete from public.tax_workpapers where client_id = p_client_id;
  delete from public.tax_lineage where client_id = p_client_id;
  delete from public.tax_adjustments where client_id = p_client_id;
  delete from public.tax_computations where client_id = p_client_id;
  delete from public.tax_input_mappings where client_id = p_client_id;
  delete from public.tax_obligations where client_id = p_client_id;
  delete from public.tax_profiles where client_id = p_client_id;
  delete from public.account_report_mappings where client_id = p_client_id;
  delete from public.payroll_events where client_id = p_client_id;
  delete from public.payroll_payments where client_id = p_client_id;
  delete from public.payroll_lines where client_id = p_client_id;
  delete from public.payroll_payslips where client_id = p_client_id;
  delete from public.payroll_runs where client_id = p_client_id;
  delete from public.employee_rates where client_id = p_client_id;
  delete from public.employees where client_id = p_client_id;
  delete from public.payroll_items where client_id = p_client_id;
  delete from public.payroll_settings where client_id = p_client_id;
  delete from public.payroll_access where client_id = p_client_id;
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

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon;
revoke execute on function
  private.ops_text_safe(text), private.ops_eligible(uuid, uuid, boolean), private.ops_is_manager(uuid),
  private.ops_is_preparer(uuid), private.ops_client_code(uuid),
  private.ops_notify(uuid, uuid, text, text, text, text, text, boolean),
  private.ops_notify_managers(uuid, text, text, text, text, text, boolean),
  private.ops_notify_client(uuid, text, text, text, text, text, boolean), private.ops_link(uuid, text, uuid),
  private.ops_check_version(integer, integer), private.ops_note(text, integer, text),
  private.ops_due_date(date, integer, integer, text), private.ops_periods(text, integer, date, date),
  private.filing_event(public.filings, text, text, text), private.work_event(public.work_items, text, text, text),
  private.ops_link_ok(uuid, text, uuid), private.request_event(public.document_requests, text, text, text),
  private.ops_release(uuid), private.ops_release_trigger()
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.propose_deadline_rule(jsonb), public.verify_deadline_rule(uuid, boolean, text), public.retire_deadline_rule(uuid, text),
  public.set_client_deadline(uuid, uuid, date, integer, uuid, uuid), public.end_client_deadline(uuid, date),
  public.generate_filing_calendar(uuid, date, date), public.add_filing(uuid, text, text, date, date, date, text),
  public.assign_filing(uuid, uuid, uuid, text, integer), public.advance_filing(uuid, text, jsonb, integer),
  public.amend_filing(uuid, text),
  public.create_work_item(uuid, jsonb, text), public.transition_work_item(uuid, text, text, integer),
  public.assign_work_item(uuid, uuid, uuid, text, integer),
  public.create_document_request(uuid, jsonb, text), public.respond_document_request(uuid, uuid[], text, integer),
  public.decide_document_request(uuid, text, text, integer),
  public.run_reminders(date), public.mark_notifications_read(uuid[]),
  public.set_client_service_status(uuid, text, text),
  public.request_exception(uuid, text, jsonb, text), public.decide_exception(uuid, boolean, text),
  public.cancel_exception(uuid), public.ops_activity_report(uuid, date, date)
from public, anon;
grant execute on function
  public.propose_deadline_rule(jsonb), public.verify_deadline_rule(uuid, boolean, text), public.retire_deadline_rule(uuid, text),
  public.set_client_deadline(uuid, uuid, date, integer, uuid, uuid), public.end_client_deadline(uuid, date),
  public.generate_filing_calendar(uuid, date, date), public.add_filing(uuid, text, text, date, date, date, text),
  public.assign_filing(uuid, uuid, uuid, text, integer), public.advance_filing(uuid, text, jsonb, integer),
  public.amend_filing(uuid, text),
  public.create_work_item(uuid, jsonb, text), public.transition_work_item(uuid, text, text, integer),
  public.assign_work_item(uuid, uuid, uuid, text, integer),
  public.create_document_request(uuid, jsonb, text), public.respond_document_request(uuid, uuid[], text, integer),
  public.decide_document_request(uuid, text, text, integer),
  public.run_reminders(date), public.mark_notifications_read(uuid[]),
  public.set_client_service_status(uuid, text, text),
  public.request_exception(uuid, text, jsonb, text), public.decide_exception(uuid, boolean, text),
  public.cancel_exception(uuid), public.ops_activity_report(uuid, date, date)
to authenticated;
grant execute on function public.run_reminders(date) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
values ('0043', 'operations_functions') on conflict (version) do nothing;
