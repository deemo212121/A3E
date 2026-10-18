-- Phase 13 (BIR forms and supporting schedules), part 2 of 2: definition
-- checks, evaluation, approval / sign-off gates, workpapers with
-- traceability, validations and history. Docs: docs/tax/FORMS.md.
--
-- DEFINITION (JSON):
--   lines: [{code, label, kind, ...}] in order, kind one of
--     tax_output {rule_code, output}  a REVIEWED tax computation's output (Phase 12)
--     tax_input  {rule_code, input}   that computation's input (books + adjustments)
--     manual                          entered on the workpaper with a reason
--     fact       {fact}               a taxpayer fact (text, e.g. TIN)
--     formula    {expr}               the Phase 12 expression language over
--                                     earlier numeric lines ({"input": "<line code>"})
--   schedules:   [{code, title, rule_code, input}]  supporting schedule = the
--                                     source lines behind that computation input
--   validations: [{code, severity: error|warning, message, when: {cmp, args: [e, e]}}]
--                the message is raised when the comparison is TRUE.
-- Formula lines are rounded with the form's rounding policy.

create function private.form_line_codes(p_def jsonb, p_numeric boolean) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(l ->> 'code'), '{}')
    from jsonb_array_elements(p_def -> 'lines') l
   where not p_numeric or l ->> 'kind' <> 'fact';
$$;

create function private.form_validate(p_form public.tax_forms) returns void
language plpgsql stable set search_path = '' as $$
declare
  d jsonb := p_form.definition;
  l jsonb;
  s jsonb;
  v jsonb;
  seen text[] := '{}';
  numeric_seen text[] := '{}';
begin
  if jsonb_typeof(d -> 'lines') <> 'array' or jsonb_array_length(d -> 'lines') = 0 then
    raise exception 'the form needs lines' using errcode = '22023';
  end if;
  for l in select value from jsonb_array_elements(d -> 'lines') loop
    if coalesce(l ->> 'code', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.]{0,19}$' or (l ->> 'code') = any (seen) then
      raise exception 'each line needs a unique code (letters, digits, _ or .)' using errcode = '22023';
    end if;
    if char_length(coalesce(l ->> 'label', '')) < 2 then
      raise exception 'line % needs a label', l ->> 'code' using errcode = '22023';
    end if;
    case l ->> 'kind'
      when 'tax_output' then
        if coalesce(l ->> 'rule_code', '') = '' or coalesce(l ->> 'output', '') = '' then
          raise exception 'line %: give rule_code and output', l ->> 'code' using errcode = '22023';
        end if;
      when 'tax_input' then
        if coalesce(l ->> 'rule_code', '') = '' or coalesce(l ->> 'input', '') = '' then
          raise exception 'line %: give rule_code and input', l ->> 'code' using errcode = '22023';
        end if;
      when 'fact' then
        if coalesce(l ->> 'fact', '') = '' then
          raise exception 'line %: give the fact', l ->> 'code' using errcode = '22023';
        end if;
      when 'formula' then
        perform private.tax_check(l -> 'expr', numeric_seen, '{}'::jsonb, '{}');
      when 'manual' then null;
      else raise exception 'line %: unknown kind %', l ->> 'code', l ->> 'kind' using errcode = '22023';
    end case;
    seen := seen || (l ->> 'code');
    if l ->> 'kind' <> 'fact' then
      numeric_seen := numeric_seen || (l ->> 'code');
    end if;
  end loop;
  for s in select value from jsonb_array_elements(coalesce(d -> 'schedules', '[]'::jsonb)) loop
    if coalesce(s ->> 'code', '') = '' or coalesce(s ->> 'rule_code', '') = '' or coalesce(s ->> 'input', '') = '' then
      raise exception 'each schedule needs code, rule_code and input' using errcode = '22023';
    end if;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(d -> 'validations', '[]'::jsonb)) loop
    if coalesce(v ->> 'code', '') = '' or coalesce(v ->> 'severity', '') not in ('error', 'warning')
       or char_length(coalesce(v ->> 'message', '')) < 3 then
      raise exception 'each validation needs code, severity (error or warning) and message' using errcode = '22023';
    end if;
    perform private.tax_check(jsonb_build_object('if', v -> 'when', 'then', '1', 'else', '0'), numeric_seen, '{}'::jsonb, '{}');
  end loop;
  if p_form.rounding ->> 'mode' not in ('half_away_from_zero', 'down', 'up') then
    raise exception 'invalid rounding mode' using errcode = '22023';
  end if;
  perform private.tax_round(0, coalesce((p_form.rounding ->> 'places')::integer, 2), p_form.rounding ->> 'mode');
end;
$$;

-- Evaluates a form on given values for its non-formula lines.
-- Returns {lines: {code: value}, messages: [{code, severity, message}]}.
create function private.form_evaluate(p_form public.tax_forms, p_given jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  l jsonb;
  v jsonb;
  lines jsonb := '{}'::jsonb;
  nums jsonb := '{}'::jsonb;
  msgs jsonb := '[]'::jsonb;
  x numeric;
  fired boolean;
begin
  for l in select value from jsonb_array_elements(p_form.definition -> 'lines') loop
    if l ->> 'kind' = 'formula' then
      begin
        x := private.tax_round(private.tax_eval(l -> 'expr', jsonb_build_object('inputs', nums, 'params', '{}'::jsonb,
               'steps', '{}'::jsonb)), coalesce((p_form.rounding ->> 'places')::integer, 2), p_form.rounding ->> 'mode');
        lines := lines || jsonb_build_object(l ->> 'code', x::text);
        nums := nums || jsonb_build_object(l ->> 'code', x::text);
      exception when others then
        msgs := msgs || jsonb_build_array(jsonb_build_object('code', 'CANNOT_COMPUTE:' || (l ->> 'code'),
                  'severity', 'error', 'message', format('Line %s cannot be computed: %s', l ->> 'code', sqlerrm)));
      end;
    elsif not (p_given ? (l ->> 'code')) or p_given -> (l ->> 'code') = 'null'::jsonb then
      msgs := msgs || jsonb_build_array(jsonb_build_object('code', 'MISSING:' || (l ->> 'code'), 'severity', 'error',
                'message', format('Line %s (%s) has no value', l ->> 'code', l ->> 'label')));
    elsif l ->> 'kind' = 'fact' then
      lines := lines || jsonb_build_object(l ->> 'code', p_given ->> (l ->> 'code'));
    else
      x := private.tax_dec(p_given -> (l ->> 'code'), 'line ' || (l ->> 'code'));
      lines := lines || jsonb_build_object(l ->> 'code', x::text);
      nums := nums || jsonb_build_object(l ->> 'code', x::text);
    end if;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(p_form.definition -> 'validations', '[]'::jsonb)) loop
    begin
      fired := private.tax_eval(jsonb_build_object('if', v -> 'when', 'then', '1', 'else', '0'),
                 jsonb_build_object('inputs', nums, 'params', '{}'::jsonb, 'steps', '{}'::jsonb)) = 1;
    exception when others then
      fired := false; -- lines it needs are missing; already reported
    end;
    if fired then
      msgs := msgs || jsonb_build_array(jsonb_build_object('code', v ->> 'code', 'severity', v ->> 'severity',
                'message', v ->> 'message'));
    end if;
  end loop;
  return jsonb_build_object('lines', lines, 'messages', msgs);
end;
$$;

-- Fixture check: expected lines equal (numerically) and, when given, the
-- exact set of message codes.
create function private.form_fixture_passes(p_result jsonb, p_expected jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select not exists (
           select 1 from jsonb_each(coalesce(p_expected -> 'lines', '{}'::jsonb)) e
            where not (p_result -> 'lines' ? e.key)
               or (case when (e.value #>> '{}') ~ '^-?[0-9.]+$' and (p_result -> 'lines' ->> e.key) ~ '^-?[0-9.]+$'
                        then (e.value #>> '{}')::numeric <> (p_result -> 'lines' ->> e.key)::numeric
                        else (e.value #>> '{}') <> (p_result -> 'lines' ->> e.key) end))
     and (not p_expected ? 'messages'
          or (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(p_expected -> 'messages') x)
           = (select coalesce(array_agg(m ->> 'code' order by m ->> 'code'), '{}')
                from jsonb_array_elements(p_result -> 'messages') m));
$$;

create function private.form_fixture_results(p_form_id uuid)
returns table (fixture_id uuid, name text, kind text, as_of date, reviewed boolean, passed boolean, expected jsonb,
               actual jsonb, error text)
language plpgsql stable security definer set search_path = '' as $$
declare
  f public.tax_forms;
  x public.tax_form_fixtures;
  v_res jsonb;
begin
  select * into f from public.tax_forms where id = p_form_id;
  for x in select * from public.tax_form_fixtures where form_id = p_form_id order by created_at, name loop
    fixture_id := x.id; name := x.name; kind := x.kind; as_of := x.as_of; reviewed := x.reviewed_by is not null;
    expected := x.expected; actual := null; error := null; passed := false;
    begin
      if x.as_of < f.effective_from or (f.effective_to is not null and x.as_of > f.effective_to) then
        raise exception 'the fixture date % is outside the form''s effective dates', x.as_of;
      end if;
      v_res := case when private.tax_eligibility(f.eligibility, x.facts) is null then private.form_evaluate(f, x.given)
                    else jsonb_build_object('lines', '{}'::jsonb, 'messages',
                           jsonb_build_array(jsonb_build_object('code', 'NOT_APPLICABLE'))) end;
      actual := v_res;
      passed := private.form_fixture_passes(v_res, x.expected);
    exception when others then
      error := sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Registry workflow
-- ---------------------------------------------------------------------------
create function public.propose_tax_form(p_form jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_form, '{}'::jsonb);
  f public.tax_forms;
  v_code text := upper(btrim(coalesce(j ->> 'form_code', '')));
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can enter form definitions' using errcode = '42501';
  end if;
  perform 1 from public.tax_forms where form_code = v_code for update;
  begin
    insert into public.tax_forms (form_code, version, title, official_version, frequency, effective_from, effective_to,
      eligibility, definition, rounding, sources, limitations)
    values (v_code, coalesce((select max(version) from public.tax_forms where form_code = v_code), 0) + 1,
            btrim(j ->> 'title'), btrim(j ->> 'official_version'), j ->> 'frequency', (j ->> 'effective_from')::date,
            nullif(j ->> 'effective_to', '')::date, coalesce(j -> 'eligibility', '[]'::jsonb),
            coalesce(j -> 'definition', '{}'::jsonb),
            coalesce(j -> 'rounding', '{"places": 2, "mode": "half_away_from_zero"}'::jsonb),
            coalesce(j -> 'sources', '[]'::jsonb), btrim(j ->> 'limitations'))
    returning * into f;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception 'incomplete or invalid form definition: %', sqlerrm using errcode = '22023';
  end;
  perform private.form_validate(f);
  perform audit.log_event('tax_form.proposed', null, jsonb_build_object('id', f.id, 'code', f.form_code, 'version', f.version));
  return f.id;
end;
$$;

create function public.add_form_fixture(p_form_id uuid, p_fixture jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_fixture, '{}'::jsonb);
  f public.tax_forms;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.is_accountant_reviewer() then
    raise exception 'only firm accountants, reviewers or managers can add fixtures' using errcode = '42501';
  end if;
  select * into f from public.tax_forms where id = p_form_id;
  if not found then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if f.status <> 'draft' then
    raise exception 'fixtures can only be added to a draft form' using errcode = '42501';
  end if;
  if jsonb_typeof(j -> 'expected' -> 'lines') <> 'object' then
    raise exception 'give the expected line values' using errcode = '22023';
  end if;
  begin
    insert into public.tax_form_fixtures (form_id, name, kind, as_of, facts, given, expected, basis)
    values (f.id, btrim(j ->> 'name'), j ->> 'kind', (j ->> 'as_of')::date, coalesce(j -> 'facts', '{}'::jsonb),
            coalesce(j -> 'given', '{}'::jsonb), j -> 'expected', btrim(j ->> 'basis'))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a fixture with that name already exists' using errcode = '23505';
    when check_violation or not_null_violation or invalid_datetime_format then
      raise exception 'incomplete fixture: %', sqlerrm using errcode = '22023';
  end;
  return v_id;
end;
$$;

create function public.review_form_fixture(p_fixture_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  x public.tax_form_fixtures;
begin
  if not private.is_accountant_reviewer() then
    raise exception 'only firm accountants, reviewers or managers can review fixtures' using errcode = '42501';
  end if;
  select * into x from public.tax_form_fixtures where id = p_fixture_id for update;
  if not found then
    raise exception 'fixture not found' using errcode = 'P0002';
  end if;
  if x.reviewed_by is not null then
    return;
  end if;
  if x.created_by = v_uid then
    raise exception 'you wrote this fixture, so another accountant must review it' using errcode = '42501';
  end if;
  update public.tax_form_fixtures set reviewed_by = v_uid, reviewed_at = now() where id = x.id;
end;
$$;

create function private.form_ready(f public.tax_forms, p_need_reviewed boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_failed text;
begin
  if jsonb_array_length(f.sources) = 0 or exists (
       select 1 from jsonb_array_elements(f.sources) s
        where char_length(coalesce(s ->> 'citation', '')) < 5 or coalesce(s ->> 'issued_on', '') !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception 'cite the official form, its instructions and issuances (citation and issue date)' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tax_form_fixtures where form_id = f.id and kind = 'normal')
     or not exists (select 1 from public.tax_form_fixtures where form_id = f.id and kind = 'boundary') then
    raise exception 'add at least one normal and one boundary fixture' using errcode = '22023';
  end if;
  if p_need_reviewed and exists (select 1 from public.tax_form_fixtures where form_id = f.id and reviewed_by is null) then
    raise exception 'every fixture must be reviewed by an accountant first' using errcode = '22023';
  end if;
  select string_agg(name || coalesce(' (' || error || ')', ''), '; ') into v_failed
    from private.form_fixture_results(f.id) where not passed;
  if v_failed is not null then
    raise exception 'fixtures do not pass: %', v_failed using errcode = '22023';
  end if;
end;
$$;

create function public.submit_tax_form(p_form_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.tax_forms;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can submit form definitions' using errcode = '42501';
  end if;
  select * into f from public.tax_forms where id = p_form_id for update;
  if not found then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if f.status = 'pending_review' then
    return;
  end if;
  if f.status <> 'draft' then
    raise exception 'only a draft form can be submitted' using errcode = '22023';
  end if;
  perform private.form_validate(f);
  perform private.form_ready(f, false);
  update public.tax_forms set status = 'pending_review' where id = f.id;
end;
$$;

-- GATE 1: verified computations.
create function public.approve_tax_form(p_form_id uuid, p_sources_verified boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  f public.tax_forms;
begin
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can approve form definitions' using errcode = '42501';
  end if;
  select * into f from public.tax_forms where id = p_form_id for update;
  if not found then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if f.status in ('approved', 'enabled') then
    return;
  end if;
  if f.status <> 'pending_review' then
    raise exception 'submit the form for review first' using errcode = '22023';
  end if;
  if f.entered_by = v_uid then
    raise exception 'you entered this form, so someone else must approve it' using errcode = '42501';
  end if;
  if not coalesce(p_sources_verified, false) then
    raise exception 'confirm that you checked the definition against the official form and its instructions'
      using errcode = '22023';
  end if;
  perform private.form_ready(f, true);
  perform 1 from public.tax_forms where form_code = f.form_code for update;
  if exists (select 1 from public.tax_forms o where o.form_code = f.form_code and o.status in ('approved', 'enabled')
               and o.id <> f.id
               and daterange(o.effective_from, o.effective_to, '[]') && daterange(f.effective_from, f.effective_to, '[]')) then
    raise exception 'another approved version of % covers these dates; end it first', f.form_code using errcode = '22023';
  end if;
  update public.tax_forms set status = 'approved', approved_by = v_uid, approved_at = now(), review_note = nullif(btrim(p_note), '')
   where id = f.id;
  perform audit.log_event('tax_form.approved', null, jsonb_build_object('id', f.id));
end;
$$;

-- GATE 2: production use only with a documented accountant sign-off.
create function public.enable_tax_form(p_form_id uuid, p_statement text, p_evidence text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  f public.tax_forms;
begin
  if not private.is_firm_manager() then
    raise exception 'only a firm manager can enable a form for production use' using errcode = '42501';
  end if;
  select * into f from public.tax_forms where id = p_form_id for update;
  if not found then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if f.status = 'enabled' then
    return;
  end if;
  if f.status <> 'approved' then
    raise exception 'only an approved form can be enabled' using errcode = '22023';
  end if;
  if f.entered_by = v_uid then
    raise exception 'you entered this form, so another manager must sign it off' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_statement, ''))) < 20 or char_length(btrim(coalesce(p_evidence, ''))) < 5 then
    raise exception 'record the accountant sign-off statement and where the evidence is kept' using errcode = '22023';
  end if;
  update public.tax_forms set status = 'enabled', signoff_by = v_uid, signoff_at = now(),
         signoff_statement = btrim(p_statement), signoff_evidence = btrim(p_evidence)
   where id = f.id;
  perform audit.log_event('tax_form.enabled', null, jsonb_build_object('id', f.id, 'code', f.form_code, 'version', f.version));
end;
$$;

create function public.reject_tax_form(p_form_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can reject form definitions' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'say why the form is rejected' using errcode = '22023';
  end if;
  update public.tax_forms set status = 'rejected', review_note = btrim(p_note)
   where id = p_form_id and status in ('draft', 'pending_review', 'approved');
  if not found then
    raise exception 'this form cannot be rejected' using errcode = '22023';
  end if;
end;
$$;

create function public.end_tax_form(p_form_id uuid, p_effective_to date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.tax_forms;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can end form versions' using errcode = '42501';
  end if;
  select * into f from public.tax_forms where id = p_form_id for update;
  if not found or f.status not in ('approved', 'enabled') then
    raise exception 'only an approved or enabled form can be ended' using errcode = '22023';
  end if;
  if p_effective_to is not null and (p_effective_to < f.effective_from or exists (
       select 1 from public.tax_workpapers w where w.form_id = f.id and w.status in ('prepared', 'signed_off')
          and w.period_to > p_effective_to)) then
    raise exception 'workpapers after % used this version, or the date is before its start', p_effective_to
      using errcode = '22023';
  end if;
  update public.tax_forms
     set effective_to = coalesce(p_effective_to, effective_to),
         status = case when p_effective_to is null then 'retired' else status end
   where id = f.id;
end;
$$;

create function public.tax_form_fixture_results(p_form_id uuid)
returns table (fixture_id uuid, name text, kind text, as_of date, reviewed boolean, passed boolean, expected jsonb,
               actual jsonb, error text)
language sql stable security definer set search_path = '' as $$
  select * from private.form_fixture_results(p_form_id) where private.firm_role() is not null;
$$;

-- REGRESSION across form versions: every fixture of every approved/enabled
-- version, run with the version in effect on the fixture's date.
create function public.form_regression(p_code text)
returns table (fixture_id uuid, fixture_name text, as_of date, written_for integer, ran_with integer, passed boolean,
               error text)
language plpgsql stable security definer set search_path = '' as $$
declare
  x record;
  f public.tax_forms;
  v_res jsonb;
begin
  if private.firm_role() is null then
    return;
  end if;
  for x in select fx.*, t.version as written_version from public.tax_form_fixtures fx
             join public.tax_forms t on t.id = fx.form_id
            where t.form_code = upper(p_code) and t.status in ('approved', 'enabled', 'retired')
            order by fx.as_of, fx.name loop
    fixture_id := x.id; fixture_name := x.name; as_of := x.as_of; written_for := x.written_version;
    ran_with := null; passed := false; error := null;
    select * into f from public.tax_forms
     where form_code = upper(p_code) and status in ('approved', 'enabled') and effective_from <= x.as_of
       and (effective_to is null or effective_to >= x.as_of)
     order by version desc limit 1;
    if f.id is null then
      error := 'no approved version in effect on this date';
    else
      ran_with := f.version;
      begin
        v_res := case when private.tax_eligibility(f.eligibility, x.facts) is null then private.form_evaluate(f, x.given)
                      else jsonb_build_object('lines', '{}'::jsonb, 'messages',
                             jsonb_build_array(jsonb_build_object('code', 'NOT_APPLICABLE'))) end;
        passed := private.form_fixture_passes(v_res, x.expected);
      exception when others then
        error := sqlerrm;
      end;
    end if;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Workpapers
-- ---------------------------------------------------------------------------
create function private.workpaper_event(p_client uuid, p_wp uuid, p_event text, p_detail text) returns void
language sql security definer set search_path = '' as $$
  insert into public.tax_workpaper_events (client_id, workpaper_id, event, detail)
  values (p_client, p_wp, p_event, nullif(btrim(coalesce(p_detail, '')), ''));
$$;

-- Prepares a workpaper from an ENABLED form, or records why it cannot.
-- Values come from REVIEWED tax computations of the same period (an
-- unreviewed one is used but blocks sign-off), manual lines and authorized
-- overrides of source lines (each with a reason). Formula lines are always
-- computed. Every line records where it came from.
create function public.prepare_workpaper(
  p_client_id uuid, p_form_code text, p_period_from date, p_period_to date, p_manual jsonb, p_overrides jsonb,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_form_code, '')));
  f public.tax_forms;
  v_facts jsonb;
  v_status text;
  v_reason text;
  l jsonb;
  e jsonb;
  c public.tax_computations;
  v_given jsonb := '{}'::jsonb;
  v_sources jsonb := '{}'::jsonb;
  v_computations jsonb := '{}'::jsonb;
  v_msgs jsonb := '[]'::jsonb;
  v_res jsonb;
  v_id uuid;
  v_codes text[];
  v_formula text[];
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to prepare tax workpapers for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select id into v_id from public.tax_workpapers where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    return (select jsonb_build_object('workpaper_id', id, 'status', status, 'reason', reason)
              from public.tax_workpapers where id = v_id);
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception 'choose a valid period' using errcode = '22023';
  end if;
  v_facts := private.tax_facts(p_client_id);

  if not exists (select 1 from public.tax_obligations where client_id = p_client_id and rule_code = v_code
                   and starts_on <= p_period_from and (ends_on is null or ends_on >= p_period_to)) then
    v_status := 'not_applicable';
    v_reason := 'this form is not a configured obligation of the client for the whole period';
  end if;
  if v_status is null then
    select * into f from public.tax_forms
     where form_code = v_code and status = 'enabled' and effective_from <= p_period_to
       and (effective_to is null or effective_to >= p_period_to)
     order by version desc limit 1;
    if f.id is null then
      v_status := 'unsupported';
      v_reason := 'no form version is enabled (verified and signed off by an accountant) for this period; prepare it manually';
    elsif f.effective_from > p_period_from then
      v_status := 'unsupported';
      v_reason := format('the form version changed on %s, inside the period; prepare it manually', f.effective_from);
    elsif private.tax_eligibility(f.eligibility, v_facts) is not null then
      v_status := 'not_applicable';
      v_reason := format('the client does not meet the form''s eligibility (%s); confirm with a professional',
                         private.tax_eligibility(f.eligibility, v_facts));
    end if;
  end if;

  if v_status is null then
    v_codes := private.form_line_codes(f.definition, false);
    select coalesce(array_agg(x ->> 'code'), '{}') into v_formula
      from jsonb_array_elements(f.definition -> 'lines') x where x ->> 'kind' = 'formula';
    for e in select value from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb) || coalesce(p_overrides, '[]'::jsonb)) loop
      if not (e ->> 'line') = any (v_codes) or (e ->> 'line') = any (v_formula) then
        raise exception 'line % cannot be entered (unknown, or computed by formula)', e ->> 'line' using errcode = '22023';
      end if;
      if char_length(btrim(coalesce(e ->> 'reason', ''))) < 5 then
        raise exception 'every manual value or override needs a reason' using errcode = '22023';
      end if;
      perform private.tax_dec(e -> 'value', 'the value for line ' || (e ->> 'line'));
    end loop;
    for l in select value from jsonb_array_elements(f.definition -> 'lines') loop
      if l ->> 'kind' in ('tax_output', 'tax_input') then
        c := null;
        select * into c from public.tax_computations
         where client_id = p_client_id and rule_code = upper(l ->> 'rule_code') and period_from = p_period_from
           and period_to = p_period_to and status in ('reviewed', 'computed')
         order by (status = 'reviewed') desc, prepared_at desc limit 1;
        if c.id is not null then
          v_given := v_given || jsonb_build_object(l ->> 'code',
            case l ->> 'kind' when 'tax_output' then c.outputs -> (l ->> 'output') else c.inputs -> (l ->> 'input') end);
          v_computations := v_computations || jsonb_build_object(upper(l ->> 'rule_code'), c.id);
          if c.status <> 'reviewed' then
            v_msgs := v_msgs || jsonb_build_array(jsonb_build_object('code', 'UNREVIEWED:' || (l ->> 'code'),
                      'severity', 'error', 'message', format('Line %s uses a tax computation that is not reviewed yet', l ->> 'code')));
          end if;
        end if;
        v_sources := v_sources || jsonb_build_object(l ->> 'code', jsonb_build_object('kind', l ->> 'kind',
          'rule_code', upper(l ->> 'rule_code'), 'computation_id', c.id, 'computation_status', c.status));
      elsif l ->> 'kind' = 'fact' then
        v_given := v_given || jsonb_build_object(l ->> 'code', v_facts -> (l ->> 'fact'));
        v_sources := v_sources || jsonb_build_object(l ->> 'code', jsonb_build_object('kind', 'fact', 'fact', l ->> 'fact'));
      elsif l ->> 'kind' = 'manual' then
        select x -> 'value' into e from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) x
         where x ->> 'line' = l ->> 'code' limit 1;
        if e is not null then
          v_given := v_given || jsonb_build_object(l ->> 'code', e);
        end if;
        v_sources := v_sources || jsonb_build_object(l ->> 'code', jsonb_build_object('kind', 'manual'));
      else
        v_sources := v_sources || jsonb_build_object(l ->> 'code', jsonb_build_object('kind', 'formula',
          'depends_on', coalesce((select jsonb_agg(distinct d) from jsonb_path_query(l -> 'expr', 'strict $.**.input') d),
                                 '[]'::jsonb)));
      end if;
    end loop;
    -- Authorized overrides of source lines (formula lines stay computed).
    for e in select value from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) loop
      v_sources := jsonb_set(v_sources, array[e ->> 'line', 'overridden_from'], coalesce(v_given -> (e ->> 'line'), 'null'::jsonb));
      v_given := v_given || jsonb_build_object(e ->> 'line', e -> 'value');
      v_msgs := v_msgs || jsonb_build_array(jsonb_build_object('code', 'OVERRIDDEN:' || (e ->> 'line'), 'severity', 'warning',
                'message', format('Line %s was overridden: %s', e ->> 'line', btrim(e ->> 'reason'))));
    end loop;
    v_res := private.form_evaluate(f, v_given);
    v_status := 'prepared';
  end if;

  insert into public.tax_workpapers (client_id, form_code, form_id, period_from, period_to, status, reason, facts, lines,
    line_sources, messages, idempotency_key)
  values (p_client_id, v_code, case when v_status = 'prepared' then f.id end, p_period_from, p_period_to, v_status, v_reason,
          v_facts, coalesce(v_res -> 'lines', '{}'::jsonb),
          v_sources || jsonb_build_object('@computations', v_computations),
          v_msgs || coalesce(v_res -> 'messages', '[]'::jsonb), p_idempotency_key)
  returning id into v_id;

  if v_status = 'prepared' then
    for e in select value from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) loop
      insert into public.tax_workpaper_entries (client_id, workpaper_id, line_code, kind, value, reason, reference)
      values (p_client_id, v_id, e ->> 'line', 'manual', (e ->> 'value')::numeric, btrim(e ->> 'reason'),
              nullif(btrim(e ->> 'reference'), ''));
    end loop;
    for e in select value from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) loop
      insert into public.tax_workpaper_entries (client_id, workpaper_id, line_code, kind, value, computed, reason, reference)
      values (p_client_id, v_id, e ->> 'line', 'override', (e ->> 'value')::numeric,
              nullif(v_sources -> (e ->> 'line') ->> 'overridden_from', '')::numeric, btrim(e ->> 'reason'),
              nullif(btrim(e ->> 'reference'), ''));
    end loop;
    update public.tax_workpapers set status = 'superseded'
     where client_id = p_client_id and form_code = v_code and id <> v_id and status in ('prepared', 'signed_off')
       and period_from = p_period_from and period_to = p_period_to;
  end if;
  perform private.workpaper_event(p_client_id, v_id, v_status, v_reason);
  return jsonb_build_object('workpaper_id', v_id, 'status', v_status, 'reason', v_reason);
end;
$$;

-- Documented accountant sign-off of a prepared workpaper.
create function public.sign_off_workpaper(p_id uuid, p_statement text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  w public.tax_workpapers;
begin
  select * into w from public.tax_workpapers where id = p_id for update;
  if not found or not private.is_assigned(w.client_id) then
    raise exception 'workpaper not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(w.client_id) then
    raise exception 'only a reviewer or manager can sign off a workpaper' using errcode = '42501';
  end if;
  if w.status = 'signed_off' then
    return;
  end if;
  if w.status <> 'prepared' then
    raise exception 'only a current prepared workpaper can be signed off' using errcode = '22023';
  end if;
  if w.prepared_by = v_uid then
    raise exception 'you prepared this workpaper, so another accountant must sign it off' using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_array_elements(w.messages) m where m ->> 'severity' = 'error') then
    raise exception 'resolve the validation errors first' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_statement, ''))) < 10 then
    raise exception 'write the sign-off statement' using errcode = '22023';
  end if;
  update public.tax_workpapers set status = 'signed_off', signed_off_by = v_uid, signed_off_at = now(),
         signoff_statement = btrim(p_statement)
   where id = p_id;
  perform private.workpaper_event(w.client_id, w.id, 'signed_off', p_statement);
end;
$$;

-- Supporting schedules: the source lines behind each schedule's computation input.
create function public.workpaper_schedule(p_workpaper_id uuid)
returns table (schedule_code text, schedule_title text, entry_id uuid, entry_no integer, entry_date date,
               source_type text, source_ref text, amount text)
language sql stable security invoker set search_path = '' as $$
  select s ->> 'code', s ->> 'title', l.entry_id, l.entry_no, l.entry_date, l.source_type, l.source_ref,
         l.amount::numeric(18, 2)::text
    from public.tax_workpapers w
    join public.tax_forms f on f.id = w.form_id
    cross join lateral jsonb_array_elements(coalesce(f.definition -> 'schedules', '[]'::jsonb)) s
    join public.tax_lineage l
      on l.computation_id = (w.line_sources -> '@computations' ->> upper(s ->> 'rule_code'))::uuid
     and l.input_name = s ->> 'input'
   where w.id = p_workpaper_id
   order by s ->> 'code', l.entry_date, l.id;
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

revoke execute on all functions in schema private from public, anon;
revoke execute on function
  private.form_validate(public.tax_forms), private.form_evaluate(public.tax_forms, jsonb),
  private.form_fixture_results(uuid), private.form_ready(public.tax_forms, boolean),
  private.workpaper_event(uuid, uuid, text, text)
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.propose_tax_form(jsonb), public.add_form_fixture(uuid, jsonb), public.review_form_fixture(uuid),
  public.submit_tax_form(uuid), public.approve_tax_form(uuid, boolean, text), public.enable_tax_form(uuid, text, text),
  public.reject_tax_form(uuid, text), public.end_tax_form(uuid, date), public.tax_form_fixture_results(uuid),
  public.form_regression(text), public.prepare_workpaper(uuid, text, date, date, jsonb, jsonb, text),
  public.sign_off_workpaper(uuid, text), public.workpaper_schedule(uuid)
from public, anon;
grant execute on function
  public.propose_tax_form(jsonb), public.add_form_fixture(uuid, jsonb), public.review_form_fixture(uuid),
  public.submit_tax_form(uuid), public.approve_tax_form(uuid, boolean, text), public.enable_tax_form(uuid, text, text),
  public.reject_tax_form(uuid, text), public.end_tax_form(uuid, date), public.tax_form_fixture_results(uuid),
  public.form_regression(text), public.prepare_workpaper(uuid, text, date, date, jsonb, jsonb, text),
  public.sign_off_workpaper(uuid, text), public.workpaper_schedule(uuid)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0039', 'forms_functions') on conflict (version) do nothing;
