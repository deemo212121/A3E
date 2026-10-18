-- Phase 12 (tax rules and computation framework), part 2 of 2: the formula
-- language, validation, the approval gate, computation with lineage, and
-- client configuration. Docs: docs/tax/TAX-ENGINE.md.
--
-- FORMULA LANGUAGE (JSON; nothing else can run):
--   "12.5"                                  a number (string, exact decimal)
--   {"input": "name"}                       a declared input
--   {"param": "name"}                       a numeric rule parameter
--   {"ref": "step"}                         an earlier step's result
--   {"op": "add|sub|mul|div|min|max", "args": [e, e, ...]}   ("neg": one arg)
--   {"round": e, "places": 0-6, "mode": "half_away_from_zero|down|up"}
--   {"if": {"cmp": "gt|gte|lt|lte|eq|neq", "args": [e, e]}, "then": e, "else": e}
--   {"graduated": e, "table": "param"}      table: [{"over","fixed","rate"}, ...]
--       ascending; uses the last row with value > over: fixed + (value - over) x rate;
--       0 when the value is not above the first row.
-- Arithmetic is exact (numeric). Only explicit "round" nodes and the rule's
-- output rounding round anything.

-- ---------------------------------------------------------------------------
-- Evaluation
-- ---------------------------------------------------------------------------
create function private.tax_dec(p_value jsonb, p_label text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v text := p_value #>> '{}';
begin
  if p_value is null or jsonb_typeof(p_value) not in ('string', 'number') or v !~ '^-?[0-9]{1,15}(\.[0-9]{1,10})?$' then
    raise exception '% must be a decimal number', p_label using errcode = '22023';
  end if;
  return v::numeric;
end;
$$;

create function private.tax_round(p_value numeric, p_places integer, p_mode text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_places is null or p_places not between 0 and 6 then
    raise exception 'rounding places must be 0 to 6' using errcode = '22023';
  end if;
  return case coalesce(p_mode, 'half_away_from_zero')
    when 'half_away_from_zero' then round(p_value, p_places)
    when 'down' then trunc(p_value, p_places)::numeric
    when 'up' then round(sign(p_value) * ceil(abs(p_value) * power(10::numeric, p_places)) / power(10::numeric, p_places), p_places)
    else null end;
end;
$$;

create function private.tax_eval(p_node jsonb, p_env jsonb, p_depth integer default 0) returns numeric
language plpgsql stable set search_path = '' as $$
declare
  v_args numeric[];
  a jsonb;
  v numeric;
  c numeric[];
  row_ jsonb;
  best jsonb;
  op text;
  b boolean;
begin
  if p_depth > 40 then
    raise exception 'formula is nested too deeply' using errcode = '22023';
  end if;
  if jsonb_typeof(p_node) in ('string', 'number') then
    return private.tax_dec(p_node, 'a constant');
  end if;
  if jsonb_typeof(p_node) <> 'object' then
    raise exception 'invalid formula node: %', p_node using errcode = '22023';
  end if;
  if p_node ? 'input' then
    if not (p_env -> 'inputs') ? (p_node ->> 'input') then
      raise exception 'input % has no value', p_node ->> 'input' using errcode = '22023';
    end if;
    return private.tax_dec(p_env -> 'inputs' -> (p_node ->> 'input'), 'input ' || (p_node ->> 'input'));
  elsif p_node ? 'param' then
    return private.tax_dec(p_env -> 'params' -> (p_node ->> 'param'), 'parameter ' || (p_node ->> 'param'));
  elsif p_node ? 'ref' then
    if not (p_env -> 'steps') ? (p_node ->> 'ref') then
      raise exception 'step % is not computed yet', p_node ->> 'ref' using errcode = '22023';
    end if;
    return (p_env -> 'steps' ->> (p_node ->> 'ref'))::numeric;
  elsif p_node ? 'op' then
    op := p_node ->> 'op';
    for a in select value from jsonb_array_elements(coalesce(p_node -> 'args', '[]'::jsonb)) loop
      v_args := v_args || private.tax_eval(a, p_env, p_depth + 1);
    end loop;
    if coalesce(cardinality(v_args), 0) = 0 then
      raise exception 'operation % needs arguments', op using errcode = '22023';
    end if;
    case op
      when 'add' then select sum(x) into v from unnest(v_args) x;
      when 'mul' then
        v := 1;
        for i in 1 .. cardinality(v_args) loop v := v * v_args[i]; end loop;
      when 'sub' then
        if cardinality(v_args) <> 2 then raise exception 'sub needs 2 arguments' using errcode = '22023'; end if;
        v := v_args[1] - v_args[2];
      when 'div' then
        if cardinality(v_args) <> 2 then raise exception 'div needs 2 arguments' using errcode = '22023'; end if;
        if v_args[2] = 0 then raise exception 'division by zero in the formula' using errcode = '22012'; end if;
        v := v_args[1] / v_args[2];
      when 'min' then select min(x) into v from unnest(v_args) x;
      when 'max' then select max(x) into v from unnest(v_args) x;
      when 'neg' then
        if cardinality(v_args) <> 1 then raise exception 'neg needs 1 argument' using errcode = '22023'; end if;
        v := -v_args[1];
      else raise exception 'unknown operation %', op using errcode = '22023';
    end case;
    return v;
  elsif p_node ? 'round' then
    return private.tax_round(private.tax_eval(p_node -> 'round', p_env, p_depth + 1),
                             coalesce((p_node ->> 'places')::integer, 2), p_node ->> 'mode');
  elsif p_node ? 'if' then
    c := array[private.tax_eval(p_node -> 'if' -> 'args' -> 0, p_env, p_depth + 1),
               private.tax_eval(p_node -> 'if' -> 'args' -> 1, p_env, p_depth + 1)];
    b := (case p_node -> 'if' ->> 'cmp'
            when 'gt' then c[1] > c[2] when 'gte' then c[1] >= c[2] when 'lt' then c[1] < c[2]
            when 'lte' then c[1] <= c[2] when 'eq' then c[1] = c[2] when 'neq' then c[1] <> c[2] end);
    if b is null then
      raise exception 'unknown comparison %', p_node -> 'if' ->> 'cmp' using errcode = '22023';
    end if;
    return private.tax_eval((case when b then p_node -> 'then' else p_node -> 'else' end), p_env, p_depth + 1);
  elsif p_node ? 'graduated' then
    v := private.tax_eval(p_node -> 'graduated', p_env, p_depth + 1);
    best := null;
    for row_ in select value from jsonb_array_elements(p_env -> 'params' -> (p_node ->> 'table')) loop
      if v > private.tax_dec(row_ -> 'over', 'table over') then
        best := row_;
      end if;
    end loop;
    if best is null then
      return 0;
    end if;
    return private.tax_dec(best -> 'fixed', 'table fixed')
         + (v - private.tax_dec(best -> 'over', 'table over')) * private.tax_dec(best -> 'rate', 'table rate');
  end if;
  raise exception 'unknown formula node: %', p_node using errcode = '22023';
end;
$$;

-- Static check of a formula node: only known node types, declared inputs,
-- existing numeric params / tables, and earlier steps.
create function private.tax_check(p_node jsonb, p_inputs text[], p_params jsonb, p_steps text[], p_depth integer default 0)
returns void
language plpgsql immutable set search_path = '' as $$
declare
  a jsonb;
  r jsonb;
  prev numeric := null;
begin
  if p_depth > 40 then
    raise exception 'formula is nested too deeply' using errcode = '22023';
  end if;
  if jsonb_typeof(p_node) in ('string', 'number') then
    perform private.tax_dec(p_node, 'a constant');
    return;
  end if;
  if jsonb_typeof(p_node) <> 'object' then
    raise exception 'invalid formula node: %', p_node using errcode = '22023';
  end if;
  if p_node ? 'input' then
    if not (p_node ->> 'input') = any (p_inputs) then
      raise exception 'formula uses undeclared input %', p_node ->> 'input' using errcode = '22023';
    end if;
  elsif p_node ? 'param' then
    perform private.tax_dec(p_params -> (p_node ->> 'param'), 'parameter ' || (p_node ->> 'param'));
  elsif p_node ? 'ref' then
    if not (p_node ->> 'ref') = any (p_steps) then
      raise exception 'formula refers to step % before it is computed', p_node ->> 'ref' using errcode = '22023';
    end if;
  elsif p_node ? 'op' then
    if not (p_node ->> 'op') = any (array['add', 'sub', 'mul', 'div', 'min', 'max', 'neg']) then
      raise exception 'unknown operation %', p_node ->> 'op' using errcode = '22023';
    end if;
    if jsonb_typeof(p_node -> 'args') <> 'array' or jsonb_array_length(p_node -> 'args') = 0 then
      raise exception 'operation % needs arguments', p_node ->> 'op' using errcode = '22023';
    end if;
    for a in select value from jsonb_array_elements(p_node -> 'args') loop
      perform private.tax_check(a, p_inputs, p_params, p_steps, p_depth + 1);
    end loop;
  elsif p_node ? 'round' then
    if coalesce(p_node ->> 'mode', 'half_away_from_zero') not in ('half_away_from_zero', 'down', 'up')
       or coalesce((p_node ->> 'places')::integer, 2) not between 0 and 6 then
      raise exception 'invalid rounding in the formula' using errcode = '22023';
    end if;
    perform private.tax_check(p_node -> 'round', p_inputs, p_params, p_steps, p_depth + 1);
  elsif p_node ? 'if' then
    if coalesce(p_node -> 'if' ->> 'cmp', '') not in ('gt', 'gte', 'lt', 'lte', 'eq', 'neq')
       or jsonb_array_length(coalesce(p_node -> 'if' -> 'args', '[]'::jsonb)) <> 2
       or not (p_node ? 'then' and p_node ? 'else') then
      raise exception 'an "if" needs cmp, 2 args, then and else' using errcode = '22023';
    end if;
    perform private.tax_check(p_node -> 'if' -> 'args' -> 0, p_inputs, p_params, p_steps, p_depth + 1);
    perform private.tax_check(p_node -> 'if' -> 'args' -> 1, p_inputs, p_params, p_steps, p_depth + 1);
    perform private.tax_check(p_node -> 'then', p_inputs, p_params, p_steps, p_depth + 1);
    perform private.tax_check(p_node -> 'else', p_inputs, p_params, p_steps, p_depth + 1);
  elsif p_node ? 'graduated' then
    if jsonb_typeof(p_params -> (p_node ->> 'table')) <> 'array' or jsonb_array_length(p_params -> (p_node ->> 'table')) = 0 then
      raise exception 'graduated table % is missing', p_node ->> 'table' using errcode = '22023';
    end if;
    for r in select value from jsonb_array_elements(p_params -> (p_node ->> 'table')) loop
      if prev is not null and private.tax_dec(r -> 'over', 'table over') <= prev then
        raise exception 'graduated table % must be in ascending order', p_node ->> 'table' using errcode = '22023';
      end if;
      prev := private.tax_dec(r -> 'over', 'table over');
      perform private.tax_dec(r -> 'fixed', 'table fixed');
      perform private.tax_dec(r -> 'rate', 'table rate');
    end loop;
    perform private.tax_check(p_node -> 'graduated', p_inputs, p_params, p_steps, p_depth + 1);
  else
    raise exception 'unknown formula node: %', p_node using errcode = '22023';
  end if;
end;
$$;

-- Runs a rule on inputs: every step in order, then the outputs rounded by the
-- rule's rounding policy. Returns {output: "decimal text"}.
create function private.tax_run(p_rule public.tax_rules, p_inputs jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  env jsonb := jsonb_build_object('inputs', coalesce(p_inputs, '{}'::jsonb), 'params', p_rule.params, 'steps', '{}'::jsonb);
  s jsonb;
  o text;
  out jsonb := '{}'::jsonb;
begin
  for s in select value from jsonb_array_elements(p_rule.formula -> 'steps') loop
    env := jsonb_set(env, array['steps', s ->> 'name'], to_jsonb(private.tax_eval(s -> 'expr', env)::text));
  end loop;
  for o in select value from jsonb_array_elements_text(p_rule.formula -> 'outputs') loop
    out := out || jsonb_build_object(o, private.tax_round((env -> 'steps' ->> o)::numeric,
      coalesce((p_rule.rounding ->> 'places')::integer, 2), p_rule.rounding ->> 'mode')::text);
  end loop;
  return out;
end;
$$;

-- Validates the whole rule definition.
create function private.tax_validate(p_rule public.tax_rules) returns void
language plpgsql stable set search_path = '' as $$
declare
  i jsonb;
  s jsonb;
  c jsonb;
  v_inputs text[] := '{}';
  v_steps text[] := '{}';
  o text;
begin
  for i in select value from jsonb_array_elements(p_rule.inputs) loop
    if coalesce(i ->> 'name', '') !~ '^[a-z][a-z0-9_]{0,39}$' or coalesce(i ->> 'source', '') not in ('ledger', 'manual') then
      raise exception 'each input needs a name (lowercase) and a source (ledger or manual)' using errcode = '22023';
    end if;
    if (i ->> 'name') = any (v_inputs) then
      raise exception 'input % is declared twice', i ->> 'name' using errcode = '22023';
    end if;
    v_inputs := v_inputs || (i ->> 'name');
  end loop;
  if jsonb_typeof(p_rule.formula -> 'steps') <> 'array' or jsonb_array_length(p_rule.formula -> 'steps') = 0
     or jsonb_typeof(p_rule.formula -> 'outputs') <> 'array' or jsonb_array_length(p_rule.formula -> 'outputs') = 0 then
    raise exception 'the formula needs steps and outputs' using errcode = '22023';
  end if;
  for s in select value from jsonb_array_elements(p_rule.formula -> 'steps') loop
    if coalesce(s ->> 'name', '') !~ '^[a-z][a-z0-9_]{0,39}$' or (s ->> 'name') = any (v_steps) then
      raise exception 'each step needs a unique lowercase name' using errcode = '22023';
    end if;
    perform private.tax_check(s -> 'expr', v_inputs, p_rule.params, v_steps);
    v_steps := v_steps || (s ->> 'name');
  end loop;
  for o in select value from jsonb_array_elements_text(p_rule.formula -> 'outputs') loop
    if not o = any (v_steps) then
      raise exception 'output % is not a step', o using errcode = '22023';
    end if;
  end loop;
  for c in select value from jsonb_array_elements(p_rule.eligibility) loop
    if coalesce(c ->> 'fact', '') = '' or coalesce(c ->> 'op', '') not in ('eq', 'neq', 'in', 'not_in', 'gte', 'lte')
       or not c ? 'value' then
      raise exception 'each eligibility condition needs fact, op (eq, neq, in, not_in, gte, lte) and value'
        using errcode = '22023';
    end if;
  end loop;
  perform private.tax_round(0, coalesce((p_rule.rounding ->> 'places')::integer, 2), p_rule.rounding ->> 'mode');
  if p_rule.rounding ->> 'mode' not in ('half_away_from_zero', 'down', 'up') then
    raise exception 'invalid output rounding mode' using errcode = '22023';
  end if;
end;
$$;

-- Eligibility: null when every condition holds; otherwise 'missing:<fact>' or
-- 'fails:<fact>'.
create function private.tax_eligibility(p_conditions jsonb, p_facts jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  c jsonb;
  f jsonb;
  ok boolean;
begin
  for c in select value from jsonb_array_elements(p_conditions) loop
    f := p_facts -> (c ->> 'fact');
    if f is null or f = 'null'::jsonb then
      return 'missing:' || (c ->> 'fact');
    end if;
    ok := case c ->> 'op'
      when 'eq' then f = c -> 'value'
      when 'neq' then f <> c -> 'value'
      when 'in' then (c -> 'value') @> jsonb_build_array(f)
      when 'not_in' then not (c -> 'value') @> jsonb_build_array(f)
      when 'gte' then (f #>> '{}')::numeric >= (c ->> 'value')::numeric
      when 'lte' then (f #>> '{}')::numeric <= (c ->> 'value')::numeric
    end;
    if not coalesce(ok, false) then
      return 'fails:' || (c ->> 'fact');
    end if;
  end loop;
  return null;
end;
$$;

-- Runs every fixture of a rule; one row per fixture.
create function private.tax_fixture_results(p_rule_id uuid)
returns table (fixture_id uuid, name text, kind text, as_of date, reviewed boolean, passed boolean, expected jsonb,
               actual jsonb, error text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.tax_rules;
  f public.tax_rule_fixtures;
  v_out jsonb;
  v_elig text;
begin
  select * into r from public.tax_rules where id = p_rule_id;
  for f in select * from public.tax_rule_fixtures where rule_id = p_rule_id order by created_at, name loop
    fixture_id := f.id; name := f.name; kind := f.kind; as_of := f.as_of; reviewed := f.reviewed_by is not null;
    expected := f.expected; actual := null; error := null; passed := false;
    begin
      if f.as_of < r.effective_from or (r.effective_to is not null and f.as_of > r.effective_to) then
        raise exception 'the fixture date % is outside the rule''s effective dates', f.as_of;
      end if;
      v_elig := private.tax_eligibility(r.eligibility, f.facts);
      v_out := case when v_elig is null then private.tax_run(r, f.inputs)
                    else jsonb_build_object('not_applicable', v_elig) end;
      actual := v_out;
      -- Compare as numbers: every expected key must match exactly.
      passed := not exists (
        select 1 from jsonb_each(f.expected) e
         where not (v_out ? e.key)
            or (case when jsonb_typeof(e.value) in ('string', 'number') and (e.value #>> '{}') ~ '^-?[0-9.]+$'
                          and (v_out ->> e.key) ~ '^-?[0-9.]+$'
                     then (e.value #>> '{}')::numeric <> (v_out ->> e.key)::numeric
                     else e.value <> v_out -> e.key end));
    exception when others then
      error := sqlerrm;
      passed := false;
    end;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Registry workflow: propose -> fixtures -> review fixtures -> submit -> approve
-- ---------------------------------------------------------------------------
create function private.is_accountant_reviewer() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.firm_role() in ('firm_manager', 'reviewer', 'accountant'), false);
$$;

create function public.propose_tax_rule(p_rule jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_rule, '{}'::jsonb);
  r public.tax_rules;
  v_code text := upper(btrim(coalesce(j ->> 'code', '')));
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can enter tax rules' using errcode = '42501';
  end if;
  perform 1 from public.tax_rules where code = v_code for update;
  begin
    insert into public.tax_rules (code, version, name, tax_type, description, effective_from, effective_to, eligibility,
      inputs, params, formula, rounding, sources)
    values (v_code, coalesce((select max(version) from public.tax_rules where code = v_code), 0) + 1,
            btrim(j ->> 'name'), j ->> 'tax_type', nullif(btrim(j ->> 'description'), ''),
            (j ->> 'effective_from')::date, nullif(j ->> 'effective_to', '')::date,
            coalesce(j -> 'eligibility', '[]'::jsonb), coalesce(j -> 'inputs', '[]'::jsonb),
            coalesce(j -> 'params', '{}'::jsonb), coalesce(j -> 'formula', '{}'::jsonb),
            coalesce(j -> 'rounding', '{"places": 2, "mode": "half_away_from_zero"}'::jsonb),
            coalesce(j -> 'sources', '[]'::jsonb))
    returning * into r;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception 'incomplete or invalid tax rule: %', sqlerrm using errcode = '22023';
  end;
  perform private.tax_validate(r);
  perform audit.log_event('tax_rule.proposed', null, jsonb_build_object('id', r.id, 'code', r.code, 'version', r.version));
  return r.id;
end;
$$;

create function public.add_tax_fixture(p_rule_id uuid, p_fixture jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := coalesce(p_fixture, '{}'::jsonb);
  r public.tax_rules;
  v_id uuid;
  i jsonb;
  o text;
begin
  perform private.require_active_user();
  if not private.is_accountant_reviewer() then
    raise exception 'only firm accountants, reviewers or managers can add fixtures' using errcode = '42501';
  end if;
  select * into r from public.tax_rules where id = p_rule_id;
  if not found then
    raise exception 'tax rule not found' using errcode = 'P0002';
  end if;
  if r.status <> 'draft' then
    raise exception 'fixtures can only be added to a draft rule' using errcode = '42501';
  end if;
  for i in select value from jsonb_array_elements(r.inputs) loop
    perform private.tax_dec(j -> 'inputs' -> (i ->> 'name'), 'fixture input ' || (i ->> 'name'));
  end loop;
  if jsonb_typeof(j -> 'expected') <> 'object' or (select count(*) from jsonb_object_keys(j -> 'expected')) = 0 then
    raise exception 'give the expected results' using errcode = '22023';
  end if;
  if not (j -> 'expected') ? 'not_applicable' then
    for o in select value from jsonb_array_elements_text(r.formula -> 'outputs') loop
      perform private.tax_dec(j -> 'expected' -> o, 'expected ' || o);
    end loop;
  end if;
  begin
    insert into public.tax_rule_fixtures (rule_id, name, kind, as_of, facts, inputs, expected, basis)
    values (r.id, btrim(j ->> 'name'), j ->> 'kind', (j ->> 'as_of')::date, coalesce(j -> 'facts', '{}'::jsonb),
            j -> 'inputs', j -> 'expected', btrim(j ->> 'basis'))
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

-- An accountant confirms the fixture's expected results are correct per the source.
create function public.review_tax_fixture(p_fixture_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  f public.tax_rule_fixtures;
begin
  if not private.is_accountant_reviewer() then
    raise exception 'only firm accountants, reviewers or managers can review fixtures' using errcode = '42501';
  end if;
  select * into f from public.tax_rule_fixtures where id = p_fixture_id for update;
  if not found then
    raise exception 'fixture not found' using errcode = 'P0002';
  end if;
  if f.reviewed_by is not null then
    return;
  end if;
  if f.created_by = v_uid then
    raise exception 'you wrote this fixture, so another accountant must review it' using errcode = '42501';
  end if;
  update public.tax_rule_fixtures set reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), '')
   where id = f.id;
end;
$$;

create function private.tax_rule_ready(r public.tax_rules, p_need_reviewed boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_failed text;
begin
  if jsonb_array_length(r.sources) = 0 or exists (
       select 1 from jsonb_array_elements(r.sources) s
        where char_length(coalesce(s ->> 'citation', '')) < 5 or coalesce(s ->> 'issued_on', '') !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception 'cite at least one authoritative source (citation and issue date) for every source listed'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.tax_rule_fixtures where rule_id = r.id and kind = 'normal')
     or not exists (select 1 from public.tax_rule_fixtures where rule_id = r.id and kind = 'boundary') then
    raise exception 'add at least one normal and one boundary fixture' using errcode = '22023';
  end if;
  if p_need_reviewed and exists (select 1 from public.tax_rule_fixtures where rule_id = r.id and reviewed_by is null) then
    raise exception 'every fixture must be reviewed by an accountant first' using errcode = '22023';
  end if;
  select string_agg(name || coalesce(' (' || error || ')', ''), '; ') into v_failed
    from private.tax_fixture_results(r.id) where not passed;
  if v_failed is not null then
    raise exception 'fixtures do not pass: %', v_failed using errcode = '22023';
  end if;
end;
$$;

create function public.submit_tax_rule(p_rule_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.tax_rules;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can submit tax rules' using errcode = '42501';
  end if;
  select * into r from public.tax_rules where id = p_rule_id for update;
  if not found then
    raise exception 'tax rule not found' using errcode = 'P0002';
  end if;
  if r.status = 'pending_review' then
    return;
  end if;
  if r.status <> 'draft' then
    raise exception 'only a draft rule can be submitted' using errcode = '22023';
  end if;
  perform private.tax_validate(r);
  perform private.tax_rule_ready(r, false);
  update public.tax_rules set status = 'pending_review', submitted_at = now() where id = r.id;
  perform audit.log_event('tax_rule.submitted', null, jsonb_build_object('id', r.id));
end;
$$;

-- THE GATE: a rule computes only after this succeeds.
create function public.approve_tax_rule(p_rule_id uuid, p_sources_verified boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.tax_rules;
begin
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can approve tax rules' using errcode = '42501';
  end if;
  select * into r from public.tax_rules where id = p_rule_id for update;
  if not found then
    raise exception 'tax rule not found' using errcode = 'P0002';
  end if;
  if r.status = 'approved' then
    return;
  end if;
  if r.status <> 'pending_review' then
    raise exception 'submit the rule for review first' using errcode = '22023';
  end if;
  if r.entered_by = v_uid then
    raise exception 'you entered this rule, so someone else must approve it' using errcode = '42501';
  end if;
  if not coalesce(p_sources_verified, false) then
    raise exception 'confirm that you checked the rule against the cited official sources' using errcode = '22023';
  end if;
  perform private.tax_rule_ready(r, true);
  perform 1 from public.tax_rules where code = r.code for update;
  if exists (select 1 from public.tax_rules o where o.code = r.code and o.status = 'approved' and o.id <> r.id
               and daterange(o.effective_from, o.effective_to, '[]') && daterange(r.effective_from, r.effective_to, '[]')) then
    raise exception 'another approved version of % is in effect in these dates; end it first', r.code using errcode = '22023';
  end if;
  update public.tax_rules set status = 'approved', approved_by = v_uid, approved_at = now(), sources_verified_by = v_uid,
         review_note = nullif(btrim(p_note), '')
   where id = r.id;
  perform audit.log_event('tax_rule.approved', null, jsonb_build_object('id', r.id, 'code', r.code, 'version', r.version));
end;
$$;

create function public.reject_tax_rule(p_rule_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can reject tax rules' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'say why the rule is rejected' using errcode = '22023';
  end if;
  update public.tax_rules set status = 'rejected', review_note = btrim(p_note)
   where id = p_rule_id and status in ('draft', 'pending_review');
  if not found then
    raise exception 'only a draft or submitted rule can be rejected' using errcode = '22023';
  end if;
end;
$$;

-- Ends an approved version on a date (a new version takes over), or retires it.
create function public.end_tax_rule(p_rule_id uuid, p_effective_to date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.tax_rules;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can end tax rules' using errcode = '42501';
  end if;
  select * into r from public.tax_rules where id = p_rule_id for update;
  if not found or r.status <> 'approved' then
    raise exception 'only an approved rule can be ended' using errcode = '22023';
  end if;
  if p_effective_to is not null and p_effective_to < r.effective_from then
    raise exception 'the end date cannot be before the start date' using errcode = '22023';
  end if;
  if p_effective_to is not null and exists (
       select 1 from public.tax_computations c where c.rule_id = r.id and c.status in ('computed', 'reviewed')
          and c.period_to > p_effective_to) then
    raise exception 'computations after % used this rule', p_effective_to using errcode = '22023';
  end if;
  update public.tax_rules
     set effective_to = coalesce(p_effective_to, effective_to),
         status = case when p_effective_to is null then 'retired' else status end
   where id = r.id;
end;
$$;

-- Fixture results for one rule (for the registry screen).
create function public.tax_rule_fixture_results(p_rule_id uuid)
returns table (fixture_id uuid, name text, kind text, as_of date, reviewed boolean, passed boolean, expected jsonb,
               actual jsonb, error text)
language sql stable security definer set search_path = '' as $$
  select * from private.tax_fixture_results(p_rule_id) where private.firm_role() is not null;
$$;

-- REGRESSION across effective dates: every fixture of every approved version
-- of a code, evaluated with the version in effect on the fixture's date.
create function public.tax_regression(p_code text)
returns table (fixture_id uuid, fixture_name text, as_of date, written_for integer, ran_with integer, passed boolean,
               error text)
language plpgsql stable security definer set search_path = '' as $$
declare
  f record;
  r public.tax_rules;
  v_out jsonb;
begin
  if private.firm_role() is null then
    return;
  end if;
  for f in select x.*, t.version as written_version from public.tax_rule_fixtures x
             join public.tax_rules t on t.id = x.rule_id
            where t.code = upper(p_code) and t.status in ('approved', 'retired')
            order by x.as_of, x.name loop
    fixture_id := f.id; fixture_name := f.name; as_of := f.as_of; written_for := f.written_version;
    ran_with := null; passed := false; error := null;
    select * into r from public.tax_rules
     where code = upper(p_code) and status = 'approved' and effective_from <= f.as_of
       and (effective_to is null or effective_to >= f.as_of)
     order by version desc limit 1;
    if r.id is null then
      error := 'no approved version in effect on this date';
    else
      ran_with := r.version;
      begin
        v_out := case when private.tax_eligibility(r.eligibility, f.facts) is null then private.tax_run(r, f.inputs)
                      else jsonb_build_object('not_applicable', private.tax_eligibility(r.eligibility, f.facts)) end;
        passed := not exists (
          select 1 from jsonb_each(f.expected) e
           where not (v_out ? e.key)
              or (case when (e.value #>> '{}') ~ '^-?[0-9.]+$' and (v_out ->> e.key) ~ '^-?[0-9.]+$'
                       then (e.value #>> '{}')::numeric <> (v_out ->> e.key)::numeric
                       else e.value <> v_out -> e.key end));
      exception when others then
        error := sqlerrm;
      end;
    end if;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client configuration
-- ---------------------------------------------------------------------------
create function public.set_tax_profile(p_client_id uuid, p_attributes jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s tax profile' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_attributes, 'null'::jsonb)) <> 'object' then
    raise exception 'give the profile facts as name/value pairs' using errcode = '22023';
  end if;
  insert into public.tax_profiles (client_id, attributes) values (p_client_id, p_attributes)
  on conflict (client_id) do update
    set attributes = excluded.attributes, status = 'proposed', proposed_by = auth.uid(), proposed_at = now(),
        confirmed_by = null, confirmed_at = null;
end;
$$;

create function public.confirm_tax_profile(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  t public.tax_profiles;
begin
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only a reviewer or manager can confirm the tax profile' using errcode = '42501';
  end if;
  select * into t from public.tax_profiles where client_id = p_client_id for update;
  if not found then
    raise exception 'there is no tax profile to confirm' using errcode = 'P0002';
  end if;
  if t.status = 'confirmed' then
    return;
  end if;
  if t.proposed_by = v_uid then
    raise exception 'you proposed this profile, so another reviewer must confirm it' using errcode = '42501';
  end if;
  update public.tax_profiles set status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() where client_id = p_client_id;
end;
$$;

-- Facts for eligibility: the confirmed tax profile attributes, overlaid by
-- the APPROVED business profile (business_type, vat_status, fiscal year end).
create function private.tax_facts(p_client_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select attributes from public.tax_profiles where client_id = p_client_id and status = 'confirmed'),
                  '{}'::jsonb)
      || coalesce((select jsonb_strip_nulls(jsonb_build_object('business_type', b.business_type, 'vat_status', b.vat_status,
                                                              'fiscal_year_end_month', b.fiscal_year_end_month))
                     from public.business_profiles b
                    where b.client_id = p_client_id and b.status = 'approved'
                    order by b.version desc limit 1), '{}'::jsonb);
$$;

create function public.add_tax_obligation(p_client_id uuid, p_code text, p_starts_on date, p_ends_on date, p_notes text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s tax obligations' using errcode = '42501';
  end if;
  if exists (select 1 from public.tax_obligations where client_id = p_client_id and rule_code = upper(p_code)
               and daterange(starts_on, ends_on, '[]') && daterange(p_starts_on, p_ends_on, '[]')) then
    raise exception 'this obligation already covers part of those dates' using errcode = '23505';
  end if;
  begin
    insert into public.tax_obligations (client_id, rule_code, starts_on, ends_on, notes)
    values (p_client_id, upper(btrim(p_code)), p_starts_on, p_ends_on, nullif(btrim(p_notes), ''))
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid obligation: %', sqlerrm using errcode = '22023';
  end;
  return v_id;
end;
$$;

create function public.end_tax_obligation(p_id uuid, p_ends_on date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.tax_obligations;
begin
  perform private.require_active_user();
  select * into o from public.tax_obligations where id = p_id for update;
  if not found or not private.can_maintain_coa(o.client_id) then
    raise exception 'obligation not found' using errcode = 'P0002';
  end if;
  if p_ends_on is null or p_ends_on < o.starts_on then
    raise exception 'the end date must be on or after the start date' using errcode = '22023';
  end if;
  update public.tax_obligations set ends_on = p_ends_on where id = p_id;
end;
$$;

create function public.set_tax_input_mapping(
  p_client_id uuid, p_code text, p_input text, p_account_ids uuid[], p_sign text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.can_maintain_coa(p_client_id) then
    raise exception 'not allowed to change this client''s tax mappings' using errcode = '42501';
  end if;
  if (select count(*) from public.accounts where client_id = p_client_id and id = any (p_account_ids))
     <> cardinality(p_account_ids) then
    raise exception 'choose accounts of this client' using errcode = '22023';
  end if;
  insert into public.tax_input_mappings (client_id, rule_code, input_name, account_ids, sign)
  values (p_client_id, upper(btrim(p_code)), btrim(p_input), p_account_ids, p_sign)
  on conflict (client_id, rule_code, input_name) do update
    set account_ids = excluded.account_ids, sign = excluded.sign, updated_by = auth.uid(), updated_at = now();
exception when check_violation then
  raise exception 'invalid mapping: %', sqlerrm using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- Computation
-- ---------------------------------------------------------------------------
-- Computes one obligation for a period, or records why it cannot:
--   not_applicable  not an obligation of the client, or the profile fails eligibility
--   unsupported     no VERIFIED and APPROVED rule covers the period
--   manual_review   facts, mappings or manual inputs are missing, or the rule
--                   changes inside the period: a professional must handle it
-- Ledger inputs come from POSTED entries in the period (lineage kept per
-- journal line). Adjustments are stored separately with a reason; they never
-- change the books. Earlier results for the same period are superseded.
create function public.compute_tax(
  p_client_id uuid, p_code text, p_period_from date, p_period_to date, p_adjustments jsonb, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  r public.tax_rules;
  v_facts jsonb;
  v_elig text;
  v_status text;
  v_reason text;
  i jsonb;
  m public.tax_input_mappings;
  a jsonb;
  v_ledger jsonb := '{}'::jsonb;
  v_adj jsonb := '{}'::jsonb;
  v_inputs jsonb := '{}'::jsonb;
  v_out jsonb;
  v_amt numeric;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_entries(p_client_id) then
    raise exception 'not allowed to compute taxes for this client' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select id into v_id from public.tax_computations where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    return (select jsonb_build_object('computation_id', id, 'status', status, 'reason', reason)
              from public.tax_computations where id = v_id);
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception 'choose a valid period' using errcode = '22023';
  end if;
  if p_adjustments is not null and jsonb_typeof(p_adjustments) <> 'array' then
    raise exception 'adjustments must be a list' using errcode = '22023';
  end if;
  v_facts := private.tax_facts(p_client_id);

  -- 1. Is this a configured obligation of the client for the whole period?
  if not exists (select 1 from public.tax_obligations where client_id = p_client_id and rule_code = v_code
                   and starts_on <= p_period_from and (ends_on is null or ends_on >= p_period_to)) then
    v_status := 'not_applicable';
    v_reason := 'not a configured obligation of this client for the whole period';
  end if;
  -- 2. Is there a verified, approved rule for the period?
  if v_status is null then
    select * into r from public.tax_rules
     where code = v_code and status = 'approved' and effective_from <= p_period_to
       and (effective_to is null or effective_to >= p_period_to)
     order by version desc limit 1;
    if r.id is null then
      v_status := 'unsupported';
      v_reason := 'no verified and approved rule covers this period; prepare it manually with professional review';
    elsif r.effective_from > p_period_from then
      v_status := 'manual_review';
      v_reason := format('the rule changed on %s, inside the period; split the period or handle it manually', r.effective_from);
    end if;
  end if;
  -- 3. Confirmed profile and eligibility.
  if v_status is null and not exists (select 1 from public.tax_profiles where client_id = p_client_id and status = 'confirmed') then
    v_status := 'manual_review';
    v_reason := 'the client''s tax profile is not confirmed by a reviewer';
  end if;
  if v_status is null then
    v_elig := private.tax_eligibility(r.eligibility, v_facts);
    if v_elig like 'missing:%' then
      v_status := 'manual_review';
      v_reason := format('the tax profile lacks the fact "%s" this rule needs', substr(v_elig, 9));
    elsif v_elig is not null then
      v_status := 'not_applicable';
      v_reason := format('the client is not eligible under this rule (%s)', substr(v_elig, 7));
    end if;
  end if;
  -- 4. Inputs: adjustments, ledger mappings, manual values.
  if v_status is null then
    for a in select value from jsonb_array_elements(coalesce(p_adjustments, '[]'::jsonb)) loop
      if not exists (select 1 from jsonb_array_elements(r.inputs) x where x ->> 'name' = a ->> 'input') then
        raise exception 'adjustment for unknown input %', a ->> 'input' using errcode = '22023';
      end if;
      if char_length(btrim(coalesce(a ->> 'reason', ''))) < 5 then
        raise exception 'every adjustment needs a reason' using errcode = '22023';
      end if;
      v_amt := private.tax_dec(a -> 'amount', 'adjustment amount');
      if v_amt = 0 or v_amt <> round(v_amt, 2) then
        raise exception 'adjustment amounts are non-zero, to the centavo' using errcode = '22023';
      end if;
      v_adj := jsonb_set(v_adj, array[a ->> 'input'],
                         to_jsonb((coalesce((v_adj ->> (a ->> 'input'))::numeric, 0) + v_amt)::text));
    end loop;
    for i in select value from jsonb_array_elements(r.inputs) loop
      if i ->> 'source' = 'ledger' then
        select * into m from public.tax_input_mappings
         where client_id = p_client_id and rule_code = v_code and input_name = i ->> 'name';
        if not found then
          v_status := 'manual_review';
          v_reason := format('map the input "%s" to the client''s accounts', i ->> 'name');
          exit;
        end if;
        select coalesce(sum(case m.sign when 'credit_minus_debit' then l.credit - l.debit else l.debit - l.credit end), 0)
          into v_amt
          from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
         where l.client_id = p_client_id and l.account_id = any (m.account_ids)
           and e.status in ('posted', 'reversed') and e.entry_date between p_period_from and p_period_to;
        v_ledger := v_ledger || jsonb_build_object(i ->> 'name', v_amt::numeric(18, 2)::text);
      elsif not v_adj ? (i ->> 'name') then
        v_status := 'manual_review';
        v_reason := format('enter the manual input "%s" with its reason', i ->> 'name');
        exit;
      end if;
      v_inputs := v_inputs || jsonb_build_object(i ->> 'name',
        (coalesce((v_ledger ->> (i ->> 'name'))::numeric, 0) + coalesce((v_adj ->> (i ->> 'name'))::numeric, 0))::text);
    end loop;
  end if;
  if v_status is null then
    v_out := private.tax_run(r, v_inputs);
    v_status := 'computed';
  end if;

  insert into public.tax_computations (client_id, rule_code, rule_id, period_from, period_to, status, reason, facts,
    ledger_inputs, adjustments, inputs, outputs, idempotency_key)
  values (p_client_id, v_code, case when v_status = 'computed' then r.id end, p_period_from, p_period_to, v_status,
          v_reason, v_facts, v_ledger, v_adj, v_inputs, v_out, p_idempotency_key)
  returning id into v_id;

  if v_status = 'computed' then
    for a in select value from jsonb_array_elements(coalesce(p_adjustments, '[]'::jsonb)) loop
      insert into public.tax_adjustments (client_id, computation_id, input_name, amount, reason, reference)
      values (p_client_id, v_id, a ->> 'input', (a #>> '{amount}')::numeric, btrim(a ->> 'reason'),
              nullif(btrim(a ->> 'reference'), ''));
    end loop;
    insert into public.tax_lineage (client_id, computation_id, input_name, journal_line_id, entry_id, entry_no, entry_date,
      source_type, source_ref, amount)
    select p_client_id, v_id, mp.input_name, l.id, e.id, e.entry_no, e.entry_date, e.source_type, e.source_ref,
           case mp.sign when 'credit_minus_debit' then l.credit - l.debit else l.debit - l.credit end
      from public.tax_input_mappings mp
      join public.journal_lines l on l.client_id = mp.client_id and l.account_id = any (mp.account_ids)
      join public.journal_entries e on e.id = l.entry_id
     where mp.client_id = p_client_id and mp.rule_code = v_code
       and mp.input_name in (select x ->> 'name' from jsonb_array_elements(r.inputs) x where x ->> 'source' = 'ledger')
       and e.status in ('posted', 'reversed') and e.entry_date between p_period_from and p_period_to;
    update public.tax_computations set status = 'superseded'
     where client_id = p_client_id and rule_code = v_code and id <> v_id and status in ('computed', 'reviewed')
       and period_from = p_period_from and period_to = p_period_to;
  end if;
  return jsonb_build_object('computation_id', v_id, 'status', v_status, 'reason', v_reason, 'outputs', v_out);
end;
$$;

create function public.review_tax_computation(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  c public.tax_computations;
begin
  select * into c from public.tax_computations where id = p_id for update;
  if not found or not private.is_assigned(c.client_id) then
    raise exception 'computation not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_entries(c.client_id) then
    raise exception 'only a reviewer or manager can review tax computations' using errcode = '42501';
  end if;
  if c.status = 'reviewed' then
    return;
  end if;
  if c.status <> 'computed' then
    raise exception 'only a current computed result can be reviewed' using errcode = '22023';
  end if;
  if c.prepared_by = v_uid then
    raise exception 'you prepared this computation, so another reviewer must review it' using errcode = '42501';
  end if;
  update public.tax_computations set status = 'reviewed', reviewed_by = v_uid, reviewed_at = now(),
         review_note = nullif(btrim(p_note), '')
   where id = p_id;
end;
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
  private.tax_eval(jsonb, jsonb, integer), private.tax_check(jsonb, text[], jsonb, text[], integer),
  private.tax_run(public.tax_rules, jsonb), private.tax_validate(public.tax_rules),
  private.tax_fixture_results(uuid), private.tax_rule_ready(public.tax_rules, boolean), private.tax_facts(uuid)
from authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.propose_tax_rule(jsonb), public.add_tax_fixture(uuid, jsonb), public.review_tax_fixture(uuid, text),
  public.submit_tax_rule(uuid), public.approve_tax_rule(uuid, boolean, text), public.reject_tax_rule(uuid, text),
  public.end_tax_rule(uuid, date), public.tax_rule_fixture_results(uuid), public.tax_regression(text),
  public.set_tax_profile(uuid, jsonb), public.confirm_tax_profile(uuid),
  public.add_tax_obligation(uuid, text, date, date, text), public.end_tax_obligation(uuid, date),
  public.set_tax_input_mapping(uuid, text, text, uuid[], text),
  public.compute_tax(uuid, text, date, date, jsonb, text), public.review_tax_computation(uuid, text)
from public, anon;
grant execute on function
  public.propose_tax_rule(jsonb), public.add_tax_fixture(uuid, jsonb), public.review_tax_fixture(uuid, text),
  public.submit_tax_rule(uuid), public.approve_tax_rule(uuid, boolean, text), public.reject_tax_rule(uuid, text),
  public.end_tax_rule(uuid, date), public.tax_rule_fixture_results(uuid), public.tax_regression(text),
  public.set_tax_profile(uuid, jsonb), public.confirm_tax_profile(uuid),
  public.add_tax_obligation(uuid, text, date, date, text), public.end_tax_obligation(uuid, date),
  public.set_tax_input_mapping(uuid, text, text, uuid[], text),
  public.compute_tax(uuid, text, date, date, jsonb, text), public.review_tax_computation(uuid, text)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('0037', 'tax_functions') on conflict (version) do nothing;
