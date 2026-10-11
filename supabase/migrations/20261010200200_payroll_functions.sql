-- Phase 10 (payroll and statutory contributions), part 3 of 3: access,
-- statutory rule sign-off, computation engine, workflow, posting, payments,
-- reconciliation. Rules: docs/payroll/PAYROLL-RULES.md (PENDING VERIFICATION).

create function private.payroll_event(
  p_client_id uuid, p_subject text, p_id uuid, p_from text, p_to text, p_comment text
) returns void
language sql security definer set search_path = '' as $$
  insert into public.payroll_events (client_id, subject, subject_id, from_status, to_status, comment)
  values (p_client_id, p_subject, p_id, p_from, p_to, nullif(btrim(coalesce(p_comment, '')), ''));
$$;

-- Parses an optional non-negative decimal from text ('' / null -> null).
create function private.payroll_num(p_text text, p_label text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  if btrim(p_text) !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' then
    raise exception '% must be a number with up to 6 decimals', p_label using errcode = '22023';
  end if;
  return btrim(p_text)::numeric;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access grants (firm managers only)
-- ---------------------------------------------------------------------------
create function public.grant_payroll_access(p_client_id uuid, p_user_id uuid, p_level public.payroll_access_level)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.firm_role;
  v_assigned boolean;
  v_client_member boolean;
begin
  perform private.require_active_user();
  if not (private.is_firm_manager() and private.is_assigned(p_client_id)) then
    raise exception 'only a firm manager can grant payroll access' using errcode = '42501';
  end if;
  select fm.role into v_role from public.firm_memberships fm join public.profiles p on p.id = fm.user_id
   where fm.user_id = p_user_id and p.is_active;
  v_assigned := v_role = 'firm_manager'
    or (v_role in ('reviewer', 'accountant', 'bookkeeper')
        and exists (select 1 from public.client_assignments where client_id = p_client_id and user_id = p_user_id));
  v_client_member := exists (select 1 from public.client_memberships cm join public.profiles p on p.id = cm.user_id
                              where cm.client_id = p_client_id and cm.user_id = p_user_id and p.is_active
                                and (cm.expires_at is null or cm.expires_at > now()));
  if p_level = 'approve' and not (coalesce(v_assigned, false) and v_role in ('firm_manager', 'reviewer')) then
    raise exception 'approve access is only for a reviewer or manager assigned to this client' using errcode = '22023';
  end if;
  if p_level = 'prepare' and not coalesce(v_assigned, false) then
    raise exception 'prepare access is only for firm staff assigned to this client' using errcode = '22023';
  end if;
  if p_level = 'view' and not (coalesce(v_assigned, false) or v_client_member) then
    raise exception 'view access is only for staff assigned to this client or the client''s own users' using errcode = '22023';
  end if;
  insert into public.payroll_access (client_id, user_id, access_level) values (p_client_id, p_user_id, p_level)
  on conflict (client_id, user_id) do update
    set access_level = excluded.access_level, granted_by = auth.uid(), granted_at = now();
  perform private.payroll_event(p_client_id, 'access', p_user_id, null, 'granted_' || p_level::text, null);
end;
$$;

create function public.revoke_payroll_access(p_client_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not (private.is_firm_manager() and private.is_assigned(p_client_id)) then
    raise exception 'only a firm manager can revoke payroll access' using errcode = '42501';
  end if;
  delete from public.payroll_access where client_id = p_client_id and user_id = p_user_id;
  if found then
    perform private.payroll_event(p_client_id, 'access', p_user_id, null, 'revoked', null);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Statutory rules: entered with a legal basis, signed off by someone else
-- ---------------------------------------------------------------------------
create function public.propose_payroll_rule(p_rule jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := coalesce(p_rule, '{}'::jsonb);
  v_kind public.payroll_rule_kind;
  v_method public.payroll_rule_method;
  v_id uuid;
  v_version integer;
  b jsonb;
  v_n integer := 0;
  v_prev_upper numeric;
  v_lower numeric;
  v_upper numeric;
  v_count integer;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can enter payroll rules' using errcode = '42501';
  end if;
  v_kind := (r ->> 'kind')::public.payroll_rule_kind;
  v_method := (r ->> 'method')::public.payroll_rule_method;
  if v_kind is null or v_method is null then
    raise exception 'choose the rule kind and method' using errcode = '22023';
  end if;
  if jsonb_typeof(r -> 'brackets') <> 'array' then
    raise exception 'add the brackets' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(r -> 'brackets');
  if v_count not between 1 and 200 then
    raise exception 'add 1 to 200 brackets' using errcode = '22023';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.payroll_rule_sets where kind = v_kind;
  begin
    insert into public.payroll_rule_sets
      (kind, version, method, description, legal_basis, effective_from, effective_to, base_floor, base_ceiling,
       frequency, deduct_employee_contributions)
    values (v_kind, v_version, v_method, btrim(r ->> 'description'), btrim(r ->> 'legal_basis'),
            (r ->> 'effective_from')::date, nullif(r ->> 'effective_to', '')::date,
            private.payroll_num(r ->> 'base_floor', 'the base floor'),
            private.payroll_num(r ->> 'base_ceiling', 'the base ceiling'),
            nullif(r ->> 'frequency', '')::public.payroll_frequency,
            nullif(r ->> 'deduct_employee_contributions', '')::boolean)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'incomplete or inconsistent rule: %', sqlerrm using errcode = '22023';
  end;
  for b in select value from jsonb_array_elements(r -> 'brackets') loop
    v_n := v_n + 1;
    v_lower := private.payroll_num(b ->> 'lower_bound', format('bracket %s lower bound', v_n));
    v_upper := private.payroll_num(b ->> 'upper_bound', format('bracket %s upper bound', v_n));
    -- Brackets must start at zero, be contiguous, and the last must be open-ended.
    if v_lower is null or (v_n = 1 and v_lower <> 0)
       or (v_n > 1 and v_lower <> case when v_method = 'graduated' then v_prev_upper else v_prev_upper + 0.01 end) then
      raise exception 'bracket %: brackets must start at 0 and follow each other without gaps or overlaps', v_n
        using errcode = '22023';
    end if;
    if (v_n < v_count) = (v_upper is null) then
      raise exception 'bracket %: only the last bracket is open-ended (no upper bound)', v_n using errcode = '22023';
    end if;
    if (v_method = 'fixed_table' and (nullif(b ->> 'ee_amount', '') is null or nullif(b ->> 'er_amount', '') is null))
       or (v_method = 'rate_table' and (nullif(b ->> 'ee_rate', '') is null or nullif(b ->> 'er_rate', '') is null))
       or (v_method = 'graduated' and (nullif(b ->> 'fixed_tax', '') is null or nullif(b ->> 'excess_rate', '') is null)) then
      raise exception 'bracket %: enter the amounts or rates this method needs', v_n using errcode = '22023';
    end if;
    insert into public.payroll_rule_brackets
      (rule_set_id, seq, lower_bound, upper_bound, ee_amount, er_amount, ec_amount, ee_rate, er_rate, fixed_tax, excess_rate)
    values (v_id, v_n, v_lower, v_upper,
            case when v_method = 'fixed_table' then private.payroll_num(b ->> 'ee_amount', 'employee amount') end,
            case when v_method = 'fixed_table' then private.payroll_num(b ->> 'er_amount', 'employer amount') end,
            case when v_method = 'fixed_table' then coalesce(private.payroll_num(b ->> 'ec_amount', 'EC amount'), 0) end,
            case when v_method = 'rate_table' then private.payroll_num(b ->> 'ee_rate', 'employee rate') end,
            case when v_method = 'rate_table' then private.payroll_num(b ->> 'er_rate', 'employer rate') end,
            case when v_method = 'graduated' then private.payroll_num(b ->> 'fixed_tax', 'fixed tax') end,
            case when v_method = 'graduated' then private.payroll_num(b ->> 'excess_rate', 'rate on excess') end);
    v_prev_upper := v_upper;
  end loop;
  perform audit.log_event('payroll_rule.proposed', null, jsonb_build_object('id', v_id, 'kind', v_kind, 'version', v_version));
  return v_id;
end;
$$;

create function public.sign_off_payroll_rule(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  s public.payroll_rule_sets;
begin
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can sign off payroll rules' using errcode = '42501';
  end if;
  select * into s from public.payroll_rule_sets where id = p_id for update;
  if not found then
    raise exception 'payroll rule not found' using errcode = 'P0002';
  end if;
  if s.status = 'signed_off' then
    return;
  end if;
  if s.status <> 'pending_signoff' then
    raise exception 'this payroll rule is retired' using errcode = '22023';
  end if;
  if s.entered_by = v_uid then
    raise exception 'you entered this rule, so someone else must sign it off' using errcode = '42501';
  end if;
  -- Only one signed-off version of a rule may be in effect on any date.
  perform 1 from public.payroll_rule_sets where kind = s.kind for update;
  if exists (select 1 from public.payroll_rule_sets o
              where o.kind = s.kind and o.status = 'signed_off' and o.id <> s.id
                and o.frequency is not distinct from s.frequency
                and daterange(o.effective_from, o.effective_to, '[]') && daterange(s.effective_from, s.effective_to, '[]')) then
    raise exception 'another signed-off % rule is in effect in these dates; end it first', s.kind using errcode = '22023';
  end if;
  update public.payroll_rule_sets set status = 'signed_off', signed_off_by = v_uid, signed_off_at = now() where id = p_id;
  perform audit.log_event('payroll_rule.signed_off', null, jsonb_build_object('id', p_id, 'kind', s.kind, 'version', s.version));
end;
$$;

-- Ends a rule's effect (a new version takes over) or, with no date, retires it.
create function public.end_payroll_rule(p_id uuid, p_effective_to date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.payroll_rule_sets;
begin
  perform private.require_active_user();
  if not private.is_tax_config_editor() then
    raise exception 'only a reviewer or manager can end payroll rules' using errcode = '42501';
  end if;
  select * into s from public.payroll_rule_sets where id = p_id for update;
  if not found then
    raise exception 'payroll rule not found' using errcode = 'P0002';
  end if;
  if p_effective_to is not null and p_effective_to < s.effective_from then
    raise exception 'the end date cannot be before the start date' using errcode = '22023';
  end if;
  -- Posted payrolls that used the rule after the new end date keep it.
  if p_effective_to is not null and exists (
       select 1 from public.payroll_payslips ps join public.payroll_runs r on r.id = ps.run_id
        where r.status = 'posted' and r.period_end > p_effective_to
          and p_id in (ps.sss_rule_id, ps.philhealth_rule_id, ps.pagibig_rule_id, ps.withholding_rule_id)) then
    raise exception 'posted payrolls after % used this rule' , p_effective_to using errcode = '22023';
  end if;
  update public.payroll_rule_sets
     set effective_to = coalesce(p_effective_to, effective_to),
         status = case when p_effective_to is null then 'retired' else status end
   where id = p_id;
  perform audit.log_event('payroll_rule.ended', null, jsonb_build_object('id', p_id, 'effective_to', p_effective_to));
end;
$$;

-- The signed-off rule in effect on a date (withholding: for the frequency).
create function private.payroll_rule_for(p_kind public.payroll_rule_kind, p_date date, p_frequency public.payroll_frequency)
returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.payroll_rule_sets
   where kind = p_kind and status = 'signed_off' and effective_from <= p_date
     and (effective_to is null or effective_to >= p_date)
     and (p_kind <> 'withholding' or frequency = p_frequency)
   order by effective_from desc limit 1;
$$;

-- Monthly contribution for a base. fixed_table: the bracket's amounts;
-- rate_table: rates on the base clamped to [floor, ceiling], bracket chosen
-- by the unclamped base; each share rounded to the centavo.
create function private.contribution_amounts(p_rule_id uuid, p_base numeric, out ee numeric, out er numeric, out ec numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.payroll_rule_sets;
  b public.payroll_rule_brackets;
  v_base numeric := p_base;
begin
  ee := 0; er := 0; ec := 0;
  if p_rule_id is null or coalesce(p_base, 0) <= 0 then
    return;
  end if;
  select * into s from public.payroll_rule_sets where id = p_rule_id;
  select * into b from public.payroll_rule_brackets
   where rule_set_id = p_rule_id and p_base >= lower_bound and (upper_bound is null or p_base <= upper_bound)
   order by seq desc limit 1;
  if not found then
    -- between two table brackets (sub-centavo bases): use the lower bracket
    select * into b from public.payroll_rule_brackets
     where rule_set_id = p_rule_id and lower_bound <= p_base order by seq desc limit 1;
  end if;
  if s.method = 'fixed_table' then
    ee := b.ee_amount; er := b.er_amount; ec := coalesce(b.ec_amount, 0);
  else
    v_base := greatest(v_base, coalesce(s.base_floor, v_base));
    v_base := least(v_base, coalesce(s.base_ceiling, v_base));
    ee := round(v_base * b.ee_rate, 2);
    er := round(v_base * b.er_rate, 2);
  end if;
end;
$$;

-- Graduated table: fixed tax + rate x (taxable - the bracket's lower bound).
create function private.withholding_amount(p_rule_id uuid, p_taxable numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.payroll_rule_brackets;
begin
  if p_rule_id is null or coalesce(p_taxable, 0) <= 0 then
    return 0;
  end if;
  select * into b from public.payroll_rule_brackets
   where rule_set_id = p_rule_id and (lower_bound < p_taxable or lower_bound = 0)
   order by seq desc limit 1;
  return b.fixed_tax + round((p_taxable - b.lower_bound) * b.excess_rate, 2);
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings and pay items
-- ---------------------------------------------------------------------------
create function public.set_payroll_settings(
  p_client_id uuid, p_net_pay uuid, p_employer_expense uuid, p_sss uuid, p_philhealth uuid, p_pagibig uuid,
  p_withholding uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.can_approve_payroll(p_client_id) then
    raise exception 'only a payroll approver can set the payroll accounts' using errcode = '42501';
  end if;
  if (select count(*) from public.accounts
       where client_id = p_client_id and is_active and is_postable
         and ((id in (p_net_pay, p_sss, p_philhealth, p_pagibig, p_withholding) and account_type = 'liability')
           or (id = p_employer_expense and account_type = 'expense')))
     <> (select count(distinct x) from unnest(array[p_net_pay, p_sss, p_philhealth, p_pagibig, p_withholding, p_employer_expense]) x) then
    raise exception 'choose active liability accounts for pay and contributions and an expense account for employer contributions'
      using errcode = '22023';
  end if;
  insert into public.payroll_settings (client_id, net_pay_account_id, employer_expense_account_id, sss_payable_account_id,
    philhealth_payable_account_id, pagibig_payable_account_id, withholding_payable_account_id)
  values (p_client_id, p_net_pay, p_employer_expense, p_sss, p_philhealth, p_pagibig, p_withholding)
  on conflict (client_id) do update
    set net_pay_account_id = excluded.net_pay_account_id, employer_expense_account_id = excluded.employer_expense_account_id,
        sss_payable_account_id = excluded.sss_payable_account_id,
        philhealth_payable_account_id = excluded.philhealth_payable_account_id,
        pagibig_payable_account_id = excluded.pagibig_payable_account_id,
        withholding_payable_account_id = excluded.withholding_payable_account_id,
        updated_by = auth.uid(), updated_at = now();
  perform private.payroll_event(p_client_id, 'settings', p_client_id, null, 'accounts_set', null);
end;
$$;

-- 2030 Salaries payable, 6012 Employer contributions, 2120/2130/2140
-- SSS/PhilHealth/Pag-IBIG payable, 2115 Withholding tax on compensation
-- payable (added if missing; kept apart from 2110 used for suppliers).
create function public.apply_default_payroll_settings(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_codes text[] := array['2030', '6012', '2120', '2130', '2140', '2115'];
  v_ids uuid[];
begin
  perform private.require_active_user();
  if not private.can_approve_payroll(p_client_id) then
    raise exception 'only a payroll approver can set the payroll accounts' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where client_id = p_client_id and code = '2115') then
    insert into public.accounts (client_id, code, name, account_type, normal_balance, is_postable)
    values (p_client_id, '2115', 'Withholding Tax on Compensation Payable', 'liability', 'credit', true);
  end if;
  select array_agg(a.id order by array_position(v_codes, a.code)) into v_ids
    from public.accounts a where a.client_id = p_client_id and a.code = any (v_codes);
  if coalesce(cardinality(v_ids), 0) <> 6 then
    raise exception 'the chart needs accounts 2030, 6012, 2120, 2130 and 2140; set the accounts manually' using errcode = '22023';
  end if;
  perform public.set_payroll_settings(p_client_id, v_ids[1], v_ids[2], v_ids[3], v_ids[4], v_ids[5], v_ids[6]);
end;
$$;

create function public.propose_payroll_item(p_client_id uuid, p_item jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t jsonb := coalesce(p_item, '{}'::jsonb);
  v_kind public.payroll_item_kind := (t ->> 'kind')::public.payroll_item_kind;
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_payroll(p_client_id) then
    raise exception 'not allowed to maintain this client''s payroll' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts where id = nullif(t ->> 'account_id', '')::uuid and client_id = p_client_id
                   and is_active and is_postable
                   and account_type::text = any (case when v_kind = 'earning' then array['expense']
                                                      else array['liability', 'asset'] end)) then
    raise exception 'choose an active % account', case when v_kind = 'earning' then 'expense' else 'liability or asset' end
      using errcode = '22023';
  end if;
  begin
    insert into public.payroll_items (client_id, code, name, kind, account_id, unit, multiplier, is_basic, is_taxable,
      in_sss_base, in_philhealth_base, in_pagibig_base)
    values (p_client_id, upper(btrim(t ->> 'code')), btrim(t ->> 'name'), v_kind, (t ->> 'account_id')::uuid,
            coalesce(nullif(t ->> 'unit', '')::public.payroll_item_unit, 'amount'),
            coalesce(private.payroll_num(t ->> 'multiplier', 'the multiplier'), 1),
            coalesce((t ->> 'is_basic')::boolean, false), coalesce((t ->> 'is_taxable')::boolean, false),
            coalesce((t ->> 'in_sss_base')::boolean, false), coalesce((t ->> 'in_philhealth_base')::boolean, false),
            coalesce((t ->> 'in_pagibig_base')::boolean, false))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'that code is already used, or there is already a basic-pay item' using errcode = '23505';
    when check_violation then
      raise exception 'invalid pay item: %', sqlerrm using errcode = '22023';
  end;
  perform private.payroll_event(p_client_id, 'item', v_id, null, 'proposed', null);
  return v_id;
end;
$$;

create function public.approve_payroll_item(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  t public.payroll_items;
begin
  select * into t from public.payroll_items where id = p_id for update;
  if not found or not private.can_view_payroll(t.client_id) then
    raise exception 'pay item not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_payroll(t.client_id) then
    raise exception 'only a payroll approver can approve pay items' using errcode = '42501';
  end if;
  if t.status <> 'proposed' then
    return;
  end if;
  if t.proposed_by = v_uid then
    raise exception 'you proposed this item, so another approver must approve it' using errcode = '42501';
  end if;
  update public.payroll_items set status = 'approved', approved_by = v_uid, approved_at = now() where id = p_id;
  perform private.payroll_event(t.client_id, 'item', p_id, 'proposed', 'approved', null);
end;
$$;

create function public.retire_payroll_item(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.payroll_items;
begin
  perform private.require_active_user();
  select * into t from public.payroll_items where id = p_id for update;
  if not found or not private.can_approve_payroll(t.client_id) then
    raise exception 'only a payroll approver can retire pay items' using errcode = '42501';
  end if;
  update public.payroll_items set status = 'retired' where id = p_id;
  perform private.payroll_event(t.client_id, 'item', p_id, t.status, 'retired', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Employees and rates
-- ---------------------------------------------------------------------------
create function public.save_employee(p_client_id uuid, p_id uuid, p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_id uuid;
begin
  perform private.require_active_user();
  if not private.can_prepare_payroll(p_client_id) then
    raise exception 'not allowed to maintain this client''s employees' using errcode = '42501';
  end if;
  begin
    if p_id is null then
      insert into public.employees (client_id, employee_no, last_name, first_name, middle_name, tin, sss_no, philhealth_no,
        pagibig_no, position, hire_date, withholding_exempt, exempt_reason)
      values (p_client_id, btrim(d ->> 'employee_no'), btrim(d ->> 'last_name'), btrim(d ->> 'first_name'),
              nullif(btrim(d ->> 'middle_name'), ''), private.normalize_tin(d ->> 'tin'), nullif(btrim(d ->> 'sss_no'), ''),
              nullif(btrim(d ->> 'philhealth_no'), ''), nullif(btrim(d ->> 'pagibig_no'), ''),
              nullif(btrim(d ->> 'position'), ''), (d ->> 'hire_date')::date,
              coalesce((d ->> 'withholding_exempt')::boolean, false), nullif(btrim(d ->> 'exempt_reason'), ''))
      returning id into v_id;
      perform private.payroll_event(p_client_id, 'employee', v_id, null, 'created', null);
    else
      update public.employees
         set employee_no = btrim(d ->> 'employee_no'), last_name = btrim(d ->> 'last_name'),
             first_name = btrim(d ->> 'first_name'), middle_name = nullif(btrim(d ->> 'middle_name'), ''),
             tin = private.normalize_tin(d ->> 'tin'), sss_no = nullif(btrim(d ->> 'sss_no'), ''),
             philhealth_no = nullif(btrim(d ->> 'philhealth_no'), ''), pagibig_no = nullif(btrim(d ->> 'pagibig_no'), ''),
             position = nullif(btrim(d ->> 'position'), ''), hire_date = (d ->> 'hire_date')::date,
             withholding_exempt = coalesce((d ->> 'withholding_exempt')::boolean, false),
             exempt_reason = nullif(btrim(d ->> 'exempt_reason'), '')
       where id = p_id and client_id = p_client_id
      returning id into v_id;
      if v_id is null then
        raise exception 'employee not found' using errcode = 'P0002';
      end if;
      perform private.payroll_event(p_client_id, 'employee', v_id, null, 'updated', null);
    end if;
  exception
    when unique_violation then
      raise exception 'employee number % is already used', btrim(d ->> 'employee_no') using errcode = '23505';
    when check_violation or not_null_violation then
      raise exception 'invalid employee details: %', sqlerrm using errcode = '22023';
  end;
  return v_id;
end;
$$;

create function public.add_employee_rate(
  p_employee_id uuid, p_effective_from date, p_basis public.pay_basis, p_basic text, p_daily text, p_hourly text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  v_id uuid;
begin
  perform private.require_active_user();
  select * into e from public.employees where id = p_employee_id;
  if not found or not private.can_prepare_payroll(e.client_id) then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if p_effective_from is null or p_effective_from < e.hire_date then
    raise exception 'the rate cannot start before the hire date' using errcode = '22023';
  end if;
  -- A rate cannot change pay that is already posted.
  if exists (select 1 from public.payroll_payslips ps join public.payroll_runs r on r.id = ps.run_id
              where ps.employee_id = e.id and r.status = 'posted' and r.period_end >= p_effective_from) then
    raise exception 'a posted payroll already covers %; use an adjustment instead', p_effective_from using errcode = '22023';
  end if;
  begin
    insert into public.employee_rates (client_id, employee_id, effective_from, pay_basis, basic_rate, daily_rate, hourly_rate)
    values (e.client_id, e.id, p_effective_from, p_basis, private.payroll_num(p_basic, 'the basic rate'),
            private.payroll_num(p_daily, 'the daily rate'), private.payroll_num(p_hourly, 'the hourly rate'))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a rate already starts on %', p_effective_from using errcode = '23505';
    when check_violation or not_null_violation then
      raise exception 'enter the basic, daily and hourly rates (greater than zero)' using errcode = '22023';
  end;
  perform private.payroll_event(e.client_id, 'employee', e.id, null, 'rate_added', p_effective_from::text);
  return v_id;
end;
$$;

create function public.terminate_employee(p_employee_id uuid, p_date date, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
begin
  perform private.require_active_user();
  select * into e from public.employees where id = p_employee_id for update;
  if not found or not private.can_prepare_payroll(e.client_id) then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if p_date is null or p_date < e.hire_date or char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'enter a termination date on or after the hire date, and the reason' using errcode = '22023';
  end if;
  if exists (select 1 from public.payroll_payslips ps join public.payroll_runs r on r.id = ps.run_id
              where ps.employee_id = e.id and r.status <> 'cancelled' and r.period_start > p_date) then
    raise exception 'the employee is on a payroll that starts after %; remove them from it or cancel it first', p_date
      using errcode = '22023';
  end if;
  update public.employees set termination_date = p_date, termination_reason = btrim(p_reason) where id = e.id;
  perform private.payroll_event(e.client_id, 'employee', e.id, null, 'terminated', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payroll computation
-- ---------------------------------------------------------------------------
create function private.employee_rate_on(p_employee_id uuid, p_date date) returns public.employee_rates
language sql stable security definer set search_path = '' as $$
  select * from public.employee_rates where employee_id = p_employee_id and effective_from <= p_date
   order by effective_from desc limit 1;
$$;

-- Computes one payslip. Contributions are MONTHLY amounts computed on the
-- month-to-date base (this run + earlier POSTED runs of the same month) less
-- what earlier runs already deducted, so semi-monthly payrolls and later
-- adjustments true up within the month. Withholding uses the table for the
-- run's frequency on this run's taxable pay.
-- p_strict: missing rules or negative net pay raise instead of noting.
create function private.compute_payslip(p_payslip_id uuid, p_strict boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps public.payroll_payslips;
  r public.payroll_runs;
  e public.employees;
  v_gross numeric; v_taxable numeric; v_sss_base numeric; v_ph_base numeric; v_pi_base numeric; v_other numeric;
  p_sss_base numeric; p_ph_base numeric; p_pi_base numeric;
  p_sss_ee numeric; p_sss_er numeric; p_sss_ec numeric; p_ph_ee numeric; p_ph_er numeric; p_pi_ee numeric; p_pi_er numeric;
  v_sss uuid; v_ph uuid; v_pi uuid; v_wt uuid;
  c record;
  v_sss_ee numeric; v_sss_er numeric; v_sss_ec numeric; v_ph_ee numeric; v_ph_er numeric; v_pi_ee numeric; v_pi_er numeric;
  v_tax_base numeric;
  v_tax numeric;
  v_net numeric;
  v_notes text[] := '{}'::text[];
  v_deduct boolean;
begin
  select * into ps from public.payroll_payslips where id = p_payslip_id;
  select * into r from public.payroll_runs where id = ps.run_id;
  select * into e from public.employees where id = ps.employee_id;

  select coalesce(sum(l.amount) filter (where t.kind = 'earning'), 0),
         coalesce(sum(l.amount) filter (where t.kind = 'earning' and t.is_taxable), 0),
         coalesce(sum(l.amount) filter (where t.kind = 'earning' and t.in_sss_base), 0),
         coalesce(sum(l.amount) filter (where t.kind = 'earning' and t.in_philhealth_base), 0),
         coalesce(sum(l.amount) filter (where t.kind = 'earning' and t.in_pagibig_base), 0),
         coalesce(sum(l.amount) filter (where t.kind = 'deduction'), 0)
    into v_gross, v_taxable, v_sss_base, v_ph_base, v_pi_base, v_other
    from public.payroll_lines l join public.payroll_items t on t.id = l.item_id
   where l.payslip_id = ps.id;

  select coalesce(sum(x.sss_base), 0), coalesce(sum(x.philhealth_base), 0), coalesce(sum(x.pagibig_base), 0),
         coalesce(sum(x.sss_ee), 0), coalesce(sum(x.sss_er), 0), coalesce(sum(x.sss_ec), 0),
         coalesce(sum(x.philhealth_ee), 0), coalesce(sum(x.philhealth_er), 0),
         coalesce(sum(x.pagibig_ee), 0), coalesce(sum(x.pagibig_er), 0)
    into p_sss_base, p_ph_base, p_pi_base, p_sss_ee, p_sss_er, p_sss_ec, p_ph_ee, p_ph_er, p_pi_ee, p_pi_er
    from public.payroll_payslips x join public.payroll_runs pr on pr.id = x.run_id
   where x.employee_id = e.id and pr.status = 'posted' and pr.id <> r.id
     and pr.period_start >= date_trunc('month', r.period_start)::date and pr.period_end < r.period_start;

  v_sss := private.payroll_rule_for('sss', r.period_end, null);
  v_ph := private.payroll_rule_for('philhealth', r.period_end, null);
  v_pi := private.payroll_rule_for('pagibig', r.period_end, null);
  v_wt := private.payroll_rule_for('withholding', r.period_end, r.frequency);
  if v_sss is null or v_ph is null or v_pi is null or v_wt is null then
    if p_strict then
      raise exception 'no signed-off % rule is in effect on % (%)',
        concat_ws(', ', case when v_sss is null then 'SSS' end, case when v_ph is null then 'PhilHealth' end,
                  case when v_pi is null then 'Pag-IBIG' end, case when v_wt is null then 'withholding' end),
        r.period_end, replace(r.frequency::text, '_', '-') using errcode = '22023';
    end if;
    v_notes := v_notes || 'Missing signed-off statutory rule: amounts incomplete'::text;
  end if;

  select * into c from private.contribution_amounts(v_sss, p_sss_base + v_sss_base);
  v_sss_ee := c.ee - p_sss_ee; v_sss_er := c.er - p_sss_er; v_sss_ec := c.ec - p_sss_ec;
  select * into c from private.contribution_amounts(v_ph, p_ph_base + v_ph_base);
  v_ph_ee := c.ee - p_ph_ee; v_ph_er := c.er - p_ph_er;
  select * into c from private.contribution_amounts(v_pi, p_pi_base + v_pi_base);
  v_pi_ee := c.ee - p_pi_ee; v_pi_er := c.er - p_pi_er;

  select deduct_employee_contributions into v_deduct from public.payroll_rule_sets where id = v_wt;
  v_tax_base := greatest(v_taxable - case when coalesce(v_deduct, false) then v_sss_ee + v_ph_ee + v_pi_ee else 0 end, 0);
  v_tax := case when e.withholding_exempt then 0 else private.withholding_amount(v_wt, v_tax_base) end;
  if e.withholding_exempt then
    v_notes := v_notes || ('Withholding exempt: ' || e.exempt_reason);
  end if;
  v_net := v_gross - (v_sss_ee + v_ph_ee + v_pi_ee) - v_tax - v_other;

  if e.termination_date is not null and e.termination_date <= r.period_end then
    v_notes := v_notes || ('Final pay: separated on ' || e.termination_date::text)::text;
  end if;
  if v_gross <= 0 then
    if p_strict then
      raise exception 'employee % has no pay in this payroll; remove them or add their pay', e.employee_no using errcode = '22023';
    end if;
    v_notes := v_notes || 'No pay entered'::text;
  end if;
  if v_net < 0 then
    if p_strict then
      raise exception 'employee %: deductions exceed pay (net %)', e.employee_no, v_net using errcode = '22023';
    end if;
    v_notes := v_notes || 'Deductions exceed pay'::text;
  end if;

  update public.payroll_payslips
     set gross_pay = v_gross, taxable_pay = v_tax_base, sss_base = v_sss_base, philhealth_base = v_ph_base,
         pagibig_base = v_pi_base, sss_ee = v_sss_ee, sss_er = v_sss_er, sss_ec = v_sss_ec,
         philhealth_ee = v_ph_ee, philhealth_er = v_ph_er, pagibig_ee = v_pi_ee, pagibig_er = v_pi_er,
         withholding_tax = v_tax, other_deductions = v_other, net_pay = v_net,
         sss_rule_id = v_sss, philhealth_rule_id = v_ph, pagibig_rule_id = v_pi, withholding_rule_id = v_wt,
         notes = nullif(array_to_string(v_notes, '; '), '')
   where id = ps.id;
end;
$$;

create function private.refresh_run_totals(p_run_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.payroll_runs r
     set (gross_pay, employee_contributions, employer_contributions, withholding_tax, other_deductions, net_pay) =
         (select coalesce(sum(gross_pay), 0),
                 coalesce(sum(sss_ee + philhealth_ee + pagibig_ee), 0),
                 coalesce(sum(sss_er + sss_ec + philhealth_er + pagibig_er), 0),
                 coalesce(sum(withholding_tax), 0), coalesce(sum(other_deductions), 0), coalesce(sum(net_pay), 0)
            from public.payroll_payslips where run_id = p_run_id)
   where r.id = p_run_id;
$$;

-- Fully employed for the whole period?
create function private.employed_in(e public.employees, p_start date, p_end date) returns boolean
language sql immutable set search_path = '' as $$
  select e.hire_date <= p_end and (e.termination_date is null or e.termination_date >= p_start);
$$;

-- Adds a payslip; prefills basic pay for monthly-paid employees employed for
-- the whole period (others: enter days worked).
create function private.add_payslip(r public.payroll_runs, e public.employees) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_basic public.payroll_items;
  v_rate public.employee_rates;
begin
  insert into public.payroll_payslips (client_id, run_id, employee_id) values (r.client_id, r.id, e.id)
  returning id into v_id;
  select * into v_basic from public.payroll_items where client_id = r.client_id and is_basic and status = 'approved';
  v_rate := private.employee_rate_on(e.id, r.period_end);
  if v_basic.id is not null and v_rate.id is not null and v_rate.pay_basis = 'monthly'
     and e.hire_date <= r.period_start and (e.termination_date is null or e.termination_date >= r.period_end) then
    insert into public.payroll_lines (client_id, payslip_id, line_no, item_id, description, amount)
    values (r.client_id, v_id, 1, v_basic.id, 'Basic pay',
            round(v_rate.basic_rate / case r.frequency when 'semi_monthly' then 2 else 1 end, 2));
  end if;
  perform private.compute_payslip(v_id, false);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Runs: create, edit payslips (draft), submit, return, post, cancel
-- ---------------------------------------------------------------------------
create function public.create_payroll_run(
  p_client_id uuid, p_frequency public.payroll_frequency, p_period_start date, p_period_end date, p_pay_date date,
  p_memo text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
  e public.employees;
  v_last date := (date_trunc('month', p_period_start) + interval '1 month - 1 day')::date;
begin
  perform private.require_active_user();
  if not private.can_prepare_payroll(p_client_id) then
    raise exception 'not allowed to prepare this client''s payroll' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select * into r from public.payroll_runs where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    return r.id;
  end if;
  if p_period_start is null or p_period_end is null or p_pay_date is null
     or not ((p_frequency = 'monthly' and extract(day from p_period_start) = 1 and p_period_end = v_last)
          or (p_frequency = 'semi_monthly'
              and ((extract(day from p_period_start) = 1 and extract(day from p_period_end) = 15
                    and date_trunc('month', p_period_end) = date_trunc('month', p_period_start))
                or (extract(day from p_period_start) = 16 and p_period_end = v_last)))) then
    raise exception 'monthly payrolls cover a whole month; semi-monthly payrolls cover the 1st-15th or the 16th to month end'
      using errcode = '22023';
  end if;
  if p_pay_date < p_period_start then
    raise exception 'the pay date cannot be before the period' using errcode = '22023';
  end if;
  begin
    insert into public.payroll_runs (client_id, frequency, period_start, period_end, pay_date, memo, idempotency_key)
    values (p_client_id, p_frequency, p_period_start, p_period_end, p_pay_date, nullif(btrim(p_memo), ''), p_idempotency_key)
    returning * into r;
  exception when unique_violation then
    if exists (select 1 from public.payroll_runs where client_id = p_client_id and idempotency_key = p_idempotency_key) then
      return (select id from public.payroll_runs where client_id = p_client_id and idempotency_key = p_idempotency_key);
    end if;
    raise exception 'a payroll for % to % already exists; cancel it first to redo it', p_period_start, p_period_end
      using errcode = '23505';
  end;
  if exists (select 1 from public.payroll_runs o where o.client_id = p_client_id and o.id <> r.id
               and o.status <> 'cancelled' and daterange(o.period_start, o.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')) then
    raise exception 'another payroll overlaps these dates' using errcode = '23505';
  end if;
  perform private.payroll_event(p_client_id, 'run', r.id, null, 'draft', null);
  for e in select * from public.employees where client_id = p_client_id order by employee_no loop
    if private.employed_in(e, p_period_start, p_period_end) then
      perform private.add_payslip(r, e);
    end if;
  end loop;
  perform private.refresh_run_totals(r.id);
  return r.id;
end;
$$;

create function private.draft_run_for_edit(p_run_id uuid) returns public.payroll_runs
language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found or not private.can_view_payroll(r.client_id) then
    raise exception 'payroll not found' using errcode = 'P0002';
  end if;
  if not private.can_prepare_payroll(r.client_id) then
    raise exception 'not allowed to prepare this client''s payroll' using errcode = '42501';
  end if;
  if r.status <> 'draft' then
    raise exception 'only a draft payroll can be changed' using errcode = '22023';
  end if;
  return r;
end;
$$;

create function public.add_employee_to_run(p_run_id uuid, p_employee_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs := private.draft_run_for_edit(p_run_id);
  e public.employees;
  v_id uuid;
begin
  select * into e from public.employees where id = p_employee_id and client_id = r.client_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not private.employed_in(e, r.period_start, r.period_end) then
    raise exception 'employee % was not employed in this period', e.employee_no using errcode = '22023';
  end if;
  if exists (select 1 from public.payroll_payslips where run_id = r.id and employee_id = e.id) then
    return (select id from public.payroll_payslips where run_id = r.id and employee_id = e.id);
  end if;
  v_id := private.add_payslip(r, e);
  perform private.refresh_run_totals(r.id);
  update public.payroll_runs set row_version = row_version + 1 where id = r.id;
  return v_id;
end;
$$;

create function public.remove_payslip(p_payslip_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := (select run_id from public.payroll_payslips where id = p_payslip_id);
  r public.payroll_runs;
begin
  if v_run is null then
    raise exception 'payslip not found' using errcode = 'P0002';
  end if;
  r := private.draft_run_for_edit(v_run);
  delete from public.payroll_payslips where id = p_payslip_id;
  perform private.refresh_run_totals(r.id);
  update public.payroll_runs set row_version = row_version + 1 where id = r.id;
end;
$$;

-- Replaces a payslip's lines. Each line: item_id, and either quantity (days
-- or hours, priced at the employee's rate in effect at the period end x the
-- item's multiplier) or amount. Earning amounts may be negative (e.g.
-- absences, corrections); deductions must be positive.
create function public.set_payslip_lines(p_payslip_id uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ps public.payroll_payslips;
  r public.payroll_runs;
  v_rate public.employee_rates;
  t public.payroll_items;
  v_line jsonb;
  v_n integer := 0;
  v_qty numeric;
  v_unit_rate numeric;
  v_amount numeric;
begin
  select * into ps from public.payroll_payslips where id = p_payslip_id;
  if not found then
    raise exception 'payslip not found' using errcode = 'P0002';
  end if;
  r := private.draft_run_for_edit(ps.run_id);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 200 then
    raise exception 'add up to 200 lines' using errcode = '22023';
  end if;
  v_rate := private.employee_rate_on(ps.employee_id, r.period_end);
  delete from public.payroll_lines where payslip_id = ps.id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    select * into t from public.payroll_items where id = nullif(v_line ->> 'item_id', '')::uuid and client_id = r.client_id
      and status = 'approved';
    if not found then
      raise exception 'line %: choose an approved pay item', v_n using errcode = '22023';
    end if;
    v_qty := nullif(btrim(coalesce(v_line ->> 'quantity', '')), '')::numeric;
    v_unit_rate := null;
    if v_qty is not null and t.unit <> 'amount' then
      if v_rate.id is null then
        raise exception 'line %: the employee has no pay rate in effect on %', v_n, r.period_end using errcode = '22023';
      end if;
      if v_qty <= 0 or v_qty > 744 then
        raise exception 'line %: enter the % (more than zero)', v_n, t.unit using errcode = '22023';
      end if;
      v_unit_rate := case t.unit when 'days' then v_rate.daily_rate else v_rate.hourly_rate end;
      v_amount := round(v_qty * v_unit_rate * t.multiplier, 2);
    else
      if coalesce(v_line ->> 'amount', '') !~ '^-?[0-9]{1,14}(\.[0-9]{1,2})?$' then
        raise exception 'line %: enter the amount (or the % worked)', v_n, t.unit using errcode = '22023';
      end if;
      v_amount := (v_line ->> 'amount')::numeric;
      v_qty := null;
    end if;
    if v_amount = 0 or (t.kind = 'deduction' and v_amount < 0) then
      raise exception 'line %: the amount must be non-zero (deductions: positive)', v_n using errcode = '22023';
    end if;
    insert into public.payroll_lines (client_id, payslip_id, line_no, item_id, description, quantity, rate, amount)
    values (r.client_id, ps.id, v_n, t.id, coalesce(nullif(btrim(v_line ->> 'description'), ''), t.name), v_qty, v_unit_rate,
            v_amount);
  end loop;
  perform private.compute_payslip(ps.id, false);
  perform private.refresh_run_totals(r.id);
  update public.payroll_runs set row_version = row_version + 1 where id = r.id;
end;
$$;

create function public.submit_payroll_run(p_run_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
  v_ps uuid;
begin
  perform private.require_active_user();
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found or not private.can_view_payroll(r.client_id) then
    raise exception 'payroll not found' using errcode = 'P0002';
  end if;
  if r.status = 'submitted' then
    return;
  end if;
  r := private.draft_run_for_edit(p_run_id);
  if not exists (select 1 from public.payroll_payslips where run_id = r.id) then
    raise exception 'the payroll has no employees' using errcode = '22023';
  end if;
  for v_ps in select id from public.payroll_payslips where run_id = r.id loop
    perform private.compute_payslip(v_ps, true);
  end loop;
  perform private.refresh_run_totals(r.id);
  update public.payroll_runs set status = 'submitted', submitted_at = now(), review_comment = null,
         row_version = row_version + 1 where id = r.id;
  perform private.payroll_event(r.client_id, 'run', r.id, 'draft', 'submitted', null);
end;
$$;

create function public.return_payroll_run(p_run_id uuid, p_comment text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
begin
  perform private.require_active_user();
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found or not private.can_view_payroll(r.client_id) then
    raise exception 'payroll not found' using errcode = 'P0002';
  end if;
  if not private.can_approve_payroll(r.client_id) then
    raise exception 'only a payroll approver can return a payroll' using errcode = '42501';
  end if;
  if r.status <> 'submitted' then
    raise exception 'only a submitted payroll can be returned' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'say what needs to change' using errcode = '22023';
  end if;
  update public.payroll_runs set status = 'draft', review_comment = btrim(p_comment), row_version = row_version + 1
   where id = r.id;
  perform private.payroll_event(r.client_id, 'run', r.id, 'submitted', 'draft', p_comment);
end;
$$;

-- POSTING (journal entry dated the period end; aggregate amounts only):
--   Dr each earning item's account          = earnings
--   Dr employer contributions expense       = SSS ER + EC + PhilHealth ER + Pag-IBIG ER
--   Cr SSS payable                          = SSS EE + ER + EC
--   Cr PhilHealth payable                   = PhilHealth EE + ER
--   Cr Pag-IBIG payable                     = Pag-IBIG EE + ER
--   Cr withholding tax on compensation      = tax withheld
--   Cr each deduction item's account        = other deductions
--   Cr net pay payable                      = net pay
create function public.post_payroll_run(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.payroll_runs;
  s public.payroll_settings;
  v_ps uuid;
  v_acc jsonb;
  v_lines jsonb;
  v_je uuid;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found or not private.can_view_payroll(r.client_id) then
    raise exception 'payroll not found' using errcode = 'P0002';
  end if;
  if r.status = 'posted' then
    return r.journal_entry_id;
  end if;
  if not private.can_approve_payroll(r.client_id) then
    raise exception 'only a payroll approver can post a payroll' using errcode = '42501';
  end if;
  if r.status <> 'submitted' then
    raise exception 'submit the payroll before posting it' using errcode = '22023';
  end if;
  if r.prepared_by = v_uid then
    raise exception 'you prepared this payroll, so another approver must post it' using errcode = '42501';
  end if;
  select * into s from public.payroll_settings where client_id = r.client_id;
  if not found then
    raise exception 'set up the payroll accounts for this client first' using errcode = '22023';
  end if;
  -- Month-to-date contributions need the month's payrolls posted in order.
  perform 1 from public.payroll_runs where client_id = r.client_id order by id for update;
  if exists (select 1 from public.payroll_runs o where o.client_id = r.client_id and o.status in ('draft', 'submitted')
               and o.id <> r.id and o.period_end < r.period_start
               and date_trunc('month', o.period_start) = date_trunc('month', r.period_start)) then
    raise exception 'post (or cancel) the earlier payroll of this month first' using errcode = '22023';
  end if;
  if exists (select 1 from public.payroll_runs o where o.client_id = r.client_id and o.status = 'posted'
               and o.period_start > r.period_end
               and date_trunc('month', o.period_start) = date_trunc('month', r.period_start)) then
    raise exception 'a later payroll of this month is already posted; cancel it first' using errcode = '22023';
  end if;

  perform set_config('app.payroll_compute', 'on', true);
  for v_ps in select id from public.payroll_payslips where run_id = r.id loop
    perform private.compute_payslip(v_ps, true);
  end loop;
  perform set_config('app.payroll_compute', 'off', true);
  perform private.refresh_run_totals(r.id);

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_acc from (
    select jsonb_build_object('account_id', t.account_id,
             case when t.kind = 'earning' then 'debit' else 'credit' end, sum(l.amount)) as x
      from public.payroll_lines l join public.payroll_items t on t.id = l.item_id
      join public.payroll_payslips ps on ps.id = l.payslip_id
     where ps.run_id = r.id group by t.account_id, t.kind
    union all
    select jsonb_build_object('account_id', s.employer_expense_account_id, 'debit', sum(sss_er + sss_ec + philhealth_er + pagibig_er))
      from public.payroll_payslips where run_id = r.id
    union all
    select jsonb_build_object('account_id', s.sss_payable_account_id, 'credit', sum(sss_ee + sss_er + sss_ec))
      from public.payroll_payslips where run_id = r.id
    union all
    select jsonb_build_object('account_id', s.philhealth_payable_account_id, 'credit', sum(philhealth_ee + philhealth_er))
      from public.payroll_payslips where run_id = r.id
    union all
    select jsonb_build_object('account_id', s.pagibig_payable_account_id, 'credit', sum(pagibig_ee + pagibig_er))
      from public.payroll_payslips where run_id = r.id
    union all
    select jsonb_build_object('account_id', s.withholding_payable_account_id, 'credit', sum(withholding_tax))
      from public.payroll_payslips where run_id = r.id
    union all
    select jsonb_build_object('account_id', s.net_pay_account_id, 'credit', sum(net_pay))
      from public.payroll_payslips where run_id = r.id
  ) q;
  select coalesce(jsonb_agg(jsonb_build_object('account_id', acct, 'debit', greatest(d - c, 0), 'credit', greatest(c - d, 0),
                                               'description', 'Payroll') order by acct), '[]'::jsonb)
    into v_lines
    from (select e ->> 'account_id' as acct, sum(coalesce((e ->> 'debit')::numeric, 0)) as d,
                 sum(coalesce((e ->> 'credit')::numeric, 0)) as c
            from jsonb_array_elements(v_acc) e group by 1) g
   where d <> c;
  v_je := private.post_generated_entry(r.client_id, r.period_end,
    format('Payroll %s to %s', r.period_start, r.period_end), 'payroll_run', r.id::text, 'payroll_run:' || r.id,
    v_lines, r.prepared_by);
  update public.payroll_runs set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je,
         row_version = row_version + 1 where id = r.id;
  perform private.payroll_event(r.client_id, 'run', r.id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

create function public.cancel_payroll_run(p_run_id uuid, p_reason text, p_reversal_date date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  r public.payroll_runs;
  v_rev uuid;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found or not private.can_view_payroll(r.client_id) then
    raise exception 'payroll not found' using errcode = 'P0002';
  end if;
  if r.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if r.status = 'posted' then
    if not private.can_approve_payroll(r.client_id) then
      raise exception 'only a payroll approver can cancel a posted payroll' using errcode = '42501';
    end if;
    if exists (select 1 from public.payroll_payments where run_id = r.id and status <> 'cancelled') then
      raise exception 'payments are recorded against this payroll; cancel them first' using errcode = '22023';
    end if;
    if exists (select 1 from public.payroll_runs o where o.client_id = r.client_id and o.status = 'posted'
                 and o.period_start > r.period_end and date_trunc('month', o.period_start) = date_trunc('month', r.period_start)) then
      raise exception 'a later payroll of this month is posted; cancel it first (its contributions depend on this one)'
        using errcode = '22023';
    end if;
    if p_reversal_date is not null and p_reversal_date < r.period_end then
      raise exception 'the cancellation date cannot be before the period end (%)', r.period_end using errcode = '22023';
    end if;
    v_rev := public.reverse_entry(r.journal_entry_id, coalesce(p_reversal_date, r.period_end),
      'Cancelled payroll: ' || btrim(p_reason), 'cancel:payroll_run:' || r.id);
  elsif not private.can_prepare_payroll(r.client_id) then
    raise exception 'not allowed to cancel this payroll' using errcode = '42501';
  end if;
  update public.payroll_runs
     set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason),
         cancel_journal_entry_id = v_rev, row_version = row_version + 1
   where id = r.id;
  perform private.payroll_event(r.client_id, 'run', r.id, r.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payments of net pay and remittances (per run)
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: payroll RLS applies to whoever calls it.
create function private.payroll_liability(p_run_id uuid, p_kind public.payroll_payment_kind, p_item_id uuid) returns numeric
language sql stable security invoker set search_path = '' as $$
  select case p_kind
    when 'net_pay' then (select coalesce(sum(net_pay), 0) from public.payroll_payslips where run_id = p_run_id)
    when 'sss' then (select coalesce(sum(sss_ee + sss_er + sss_ec), 0) from public.payroll_payslips where run_id = p_run_id)
    when 'philhealth' then (select coalesce(sum(philhealth_ee + philhealth_er), 0) from public.payroll_payslips where run_id = p_run_id)
    when 'pagibig' then (select coalesce(sum(pagibig_ee + pagibig_er), 0) from public.payroll_payslips where run_id = p_run_id)
    when 'withholding' then (select coalesce(sum(withholding_tax), 0) from public.payroll_payslips where run_id = p_run_id)
    else (select coalesce(sum(l.amount), 0) from public.payroll_lines l join public.payroll_payslips ps on ps.id = l.payslip_id
           where ps.run_id = p_run_id and l.item_id = p_item_id)
  end;
$$;

create function private.payroll_payment_account(p_run public.payroll_runs, p_kind public.payroll_payment_kind, p_item_id uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'net_pay' then s.net_pay_account_id
    when 'sss' then s.sss_payable_account_id
    when 'philhealth' then s.philhealth_payable_account_id
    when 'pagibig' then s.pagibig_payable_account_id
    when 'withholding' then s.withholding_payable_account_id
    else (select account_id from public.payroll_items where id = p_item_id)
  end
  from public.payroll_settings s where s.client_id = p_run.client_id;
$$;

create function public.record_payroll_payment(
  p_run_id uuid, p_kind public.payroll_payment_kind, p_item_id uuid, p_payment_date date, p_paid_from uuid,
  p_amount text, p_reference text, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
  v_id uuid;
  v_amount numeric;
  v_open numeric;
begin
  perform private.require_active_user();
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found or not private.can_view_payroll(r.client_id) then
    raise exception 'payroll not found' using errcode = 'P0002';
  end if;
  if not private.can_prepare_payroll(r.client_id) then
    raise exception 'not allowed to record payroll payments' using errcode = '42501';
  end if;
  perform private.require_key(p_idempotency_key);
  select id into v_id from public.payroll_payments where client_id = r.client_id and idempotency_key = p_idempotency_key;
  if found then
    return v_id;
  end if;
  if r.status <> 'posted' then
    raise exception 'only a posted payroll can be paid' using errcode = '22023';
  end if;
  if p_payment_date is null or p_payment_date < r.period_end or p_payment_date > private.today_ph() then
    raise exception 'the payment date must be from the period end (%) to today', r.period_end using errcode = '22023';
  end if;
  if (p_kind = 'deduction') <> (p_item_id is not null) then
    raise exception 'choose the deduction being remitted' using errcode = '22023';
  end if;
  if not exists (select 1 from public.accounts where id = p_paid_from and client_id = r.client_id and account_type = 'asset'
                   and is_active and is_postable) then
    raise exception 'choose the cash or bank account paid from' using errcode = '22023';
  end if;
  if coalesce(p_amount, '') !~ '^[0-9]{1,16}(\.[0-9]{1,2})?$' or p_amount::numeric <= 0 then
    raise exception 'enter the amount paid' using errcode = '22023';
  end if;
  v_amount := p_amount::numeric;
  v_open := private.payroll_liability(r.id, p_kind, p_item_id)
          - coalesce((select sum(amount) from public.payroll_payments where run_id = r.id and kind = p_kind
                        and item_id is not distinct from p_item_id and status <> 'cancelled'), 0);
  if v_amount > v_open then
    raise exception 'only % is unpaid for this payroll', v_open using errcode = '22023';
  end if;
  insert into public.payroll_payments (client_id, run_id, kind, item_id, payment_date, paid_from_account_id, amount, reference,
    idempotency_key)
  values (r.client_id, r.id, p_kind, p_item_id, p_payment_date, p_paid_from, v_amount, nullif(btrim(p_reference), ''),
          p_idempotency_key)
  returning id into v_id;
  perform private.payroll_event(r.client_id, 'payment', v_id, null, 'submitted', null);
  return v_id;
end;
$$;

create function public.post_payroll_payment(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  p public.payroll_payments;
  r public.payroll_runs;
  v_je uuid;
begin
  select * into p from public.payroll_payments where id = p_payment_id for update;
  if not found or not private.can_view_payroll(p.client_id) then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if p.status = 'posted' then
    return p.journal_entry_id;
  end if;
  if not private.can_approve_payroll(p.client_id) then
    raise exception 'only a payroll approver can post payments' using errcode = '42501';
  end if;
  if p.status <> 'submitted' then
    raise exception 'this payment is cancelled' using errcode = '22023';
  end if;
  if p.prepared_by = v_uid then
    raise exception 'you recorded this payment, so another approver must post it' using errcode = '42501';
  end if;
  select * into r from public.payroll_runs where id = p.run_id;
  if r.status <> 'posted' then
    raise exception 'the payroll is no longer posted' using errcode = '22023';
  end if;
  v_je := private.post_generated_entry(p.client_id, p.payment_date,
    format('Payroll %s: %s for %s to %s', case when p.kind = 'net_pay' then 'payment' else 'remittance' end,
           replace(p.kind::text, '_', ' '), r.period_start, r.period_end),
    'payroll_payment', p.id::text, 'payroll_payment:' || p.id,
    jsonb_build_array(
      jsonb_build_object('account_id', private.payroll_payment_account(r, p.kind, p.item_id), 'debit', p.amount,
                         'description', 'Payroll ' || replace(p.kind::text, '_', ' '), 'document_ref', p.reference),
      jsonb_build_object('account_id', p.paid_from_account_id, 'credit', p.amount, 'document_ref', p.reference)),
    p.prepared_by);
  update public.payroll_payments set status = 'posted', posted_by = v_uid, posted_at = now(), journal_entry_id = v_je
   where id = p.id;
  perform private.payroll_event(p.client_id, 'payment', p.id, 'submitted', 'posted', null);
  return v_je;
end;
$$;

create function public.cancel_payroll_payment(p_payment_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  p public.payroll_payments;
  v_rev uuid;
begin
  select * into p from public.payroll_payments where id = p_payment_id for update;
  if not found or not private.can_view_payroll(p.client_id) then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if p.status = 'cancelled' then
    return;
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required to cancel' using errcode = '22023';
  end if;
  if p.status = 'posted' then
    if not private.can_approve_payroll(p.client_id) then
      raise exception 'only a payroll approver can cancel a posted payment' using errcode = '42501';
    end if;
    v_rev := public.reverse_entry(p.journal_entry_id, p.payment_date, 'Cancelled payroll payment: ' || btrim(p_reason),
      'cancel:payroll_payment:' || p.id);
  elsif not private.can_prepare_payroll(p.client_id) then
    raise exception 'not allowed to cancel payroll payments' using errcode = '42501';
  end if;
  update public.payroll_payments set status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(),
         cancel_reason = btrim(p_reason), cancel_journal_entry_id = v_rev
   where id = p.id;
  perform private.payroll_event(p.client_id, 'payment', p.id, p.status::text, 'cancelled', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (SECURITY INVOKER: payroll RLS applies)
-- ---------------------------------------------------------------------------
-- GATE: per payroll liability account, what posted payrolls still owe
-- (liabilities - posted payments, as of the date) vs the general ledger.
create function public.payroll_reconciliation(p_client_id uuid, p_as_of date)
returns table (liability text, account_id uuid, account_code text, subledger_balance text, ledger_balance text, difference text)
language sql stable security invoker set search_path = '' as $$
  with s as (select * from public.payroll_settings where client_id = p_client_id),
  runs as (
    select r.* from public.payroll_runs r
      join public.journal_entries e on e.id = r.journal_entry_id
     where r.client_id = p_client_id and e.entry_date <= p_as_of
       and (r.cancel_journal_entry_id is null
            or (select entry_date from public.journal_entries where id = r.cancel_journal_entry_id) > p_as_of)
  ),
  pays as (
    select p.* from public.payroll_payments p
      join public.journal_entries e on e.id = p.journal_entry_id
     where p.client_id = p_client_id and e.entry_date <= p_as_of
       and (p.cancel_journal_entry_id is null
            or (select entry_date from public.journal_entries where id = p.cancel_journal_entry_id) > p_as_of)
  ),
  kinds as (
    select k.kind, k.label, k.account_id from s,
      lateral (values ('net_pay'::public.payroll_payment_kind, 'Net pay', s.net_pay_account_id),
                      ('sss', 'SSS', s.sss_payable_account_id),
                      ('philhealth', 'PhilHealth', s.philhealth_payable_account_id),
                      ('pagibig', 'Pag-IBIG', s.pagibig_payable_account_id),
                      ('withholding', 'Withholding tax on compensation', s.withholding_payable_account_id)) k(kind, label, account_id)
  ),
  sub as (
    select k.account_id, string_agg(k.label, ' + ' order by k.label) as label,
           sum(coalesce((select sum(private.payroll_liability(runs.id, k.kind, null)) from runs), 0)
             - coalesce((select sum(amount) from pays where pays.kind = k.kind), 0)) as amt
      from kinds k group by k.account_id
  ),
  gl as (
    select l.account_id, sum(l.credit - l.debit) as amt
      from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
     where l.client_id = p_client_id and e.status in ('posted', 'reversed') and e.entry_date <= p_as_of
       and l.account_id in (select account_id from kinds)
     group by 1
  )
  select sub.label, sub.account_id, a.code, sub.amt::numeric(18, 2)::text, coalesce(gl.amt, 0)::numeric(18, 2)::text,
         (coalesce(gl.amt, 0) - sub.amt)::numeric(18, 2)::text
    from sub join public.accounts a on a.id = sub.account_id
    left join gl on gl.account_id = sub.account_id
   order by a.code;
$$;

-- Contributions and withholding per employee for a month (posted payrolls).
create function public.payroll_month_summary(p_client_id uuid, p_month date)
returns table (employee_id uuid, employee_no text, employee_name text, gross_pay text, sss_ee text, sss_er text, sss_ec text,
               philhealth_ee text, philhealth_er text, pagibig_ee text, pagibig_er text, withholding_tax text, net_pay text)
language sql stable security invoker set search_path = '' as $$
  select e.id, e.employee_no, e.last_name || ', ' || e.first_name,
         sum(ps.gross_pay)::text, sum(ps.sss_ee)::text, sum(ps.sss_er)::text, sum(ps.sss_ec)::text,
         sum(ps.philhealth_ee)::text, sum(ps.philhealth_er)::text, sum(ps.pagibig_ee)::text, sum(ps.pagibig_er)::text,
         sum(ps.withholding_tax)::text, sum(ps.net_pay)::text
    from public.payroll_payslips ps
    join public.payroll_runs r on r.id = ps.run_id
    join public.employees e on e.id = ps.employee_id
   where r.client_id = p_client_id and r.status = 'posted'
     and date_trunc('month', r.period_start) = date_trunc('month', p_month)
   group by e.id, e.employee_no, e.last_name, e.first_name
   order by e.employee_no;
$$;

-- ---------------------------------------------------------------------------
-- Access summary: which clients' payroll the caller may open
-- ---------------------------------------------------------------------------
create or replace function public.get_my_access() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_firm_role public.firm_role;
  v_effective public.firm_role;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = v_uid;
  select role into v_firm_role from public.firm_memberships where user_id = v_uid;
  v_effective := private.firm_role();

  return jsonb_build_object(
    'user_id', v_uid,
    'email', v_profile.email,
    'full_name', v_profile.full_name,
    'is_active', coalesce(v_profile.is_active, false),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'firm_role', v_firm_role,
    'firm_role_effective', v_effective,
    'mfa_required', v_firm_role is not null and not private.staff_mfa_ok(),
    'client_memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', c.id, 'code', c.code, 'display_name', c.display_name,
        'status', c.status, 'role', private.client_role(c.id)
      ) order by c.display_name)
      from public.client_memberships cm
      join public.clients c on c.id = cm.client_id
      where cm.user_id = v_uid and private.client_role(c.id) is not null
    ), '[]'::jsonb),
    -- Clients this staff member may work on (all clients for managers).
    'staff_client_ids', coalesce((
      select jsonb_agg(c.id order by c.display_name)
      from public.clients c
      where v_effective in ('firm_manager', 'reviewer', 'accountant', 'bookkeeper')
        and private.is_assigned(c.id)
    ), '[]'::jsonb),
    -- Clients whose payroll the caller holds an explicit grant for.
    'payroll_client_ids', coalesce((
      select jsonb_agg(a.client_id order by a.client_id)
      from public.payroll_access a
      where a.user_id = v_uid and private.can_view_payroll(a.client_id)
    ), '[]'::jsonb)
  );
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
  private.payroll_event(uuid, text, uuid, text, text, text),
  private.contribution_amounts(uuid, numeric),
  private.withholding_amount(uuid, numeric),
  private.compute_payslip(uuid, boolean),
  private.refresh_run_totals(uuid),
  private.add_payslip(public.payroll_runs, public.employees),
  private.draft_run_for_edit(uuid),
  private.payroll_liability(uuid, public.payroll_payment_kind, uuid),
  private.payroll_payment_account(public.payroll_runs, public.payroll_payment_kind, uuid),
  private.employee_rate_on(uuid, date),
  private.payroll_rule_for(public.payroll_rule_kind, date, public.payroll_frequency)
from authenticated;
-- payroll_reconciliation (SECURITY INVOKER) calls payroll_liability.
grant execute on function private.payroll_liability(uuid, public.payroll_payment_kind, uuid) to authenticated;
revoke execute on function public.purge_synthetic_client(uuid) from public, anon, authenticated;
grant execute on function public.purge_synthetic_client(uuid) to service_role;

revoke execute on function
  public.grant_payroll_access(uuid, uuid, public.payroll_access_level),
  public.revoke_payroll_access(uuid, uuid),
  public.propose_payroll_rule(jsonb),
  public.sign_off_payroll_rule(uuid),
  public.end_payroll_rule(uuid, date),
  public.set_payroll_settings(uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  public.apply_default_payroll_settings(uuid),
  public.propose_payroll_item(uuid, jsonb),
  public.approve_payroll_item(uuid),
  public.retire_payroll_item(uuid),
  public.save_employee(uuid, uuid, jsonb),
  public.add_employee_rate(uuid, date, public.pay_basis, text, text, text),
  public.terminate_employee(uuid, date, text),
  public.create_payroll_run(uuid, public.payroll_frequency, date, date, date, text, text),
  public.add_employee_to_run(uuid, uuid),
  public.remove_payslip(uuid),
  public.set_payslip_lines(uuid, jsonb),
  public.submit_payroll_run(uuid),
  public.return_payroll_run(uuid, text),
  public.post_payroll_run(uuid),
  public.cancel_payroll_run(uuid, text, date),
  public.record_payroll_payment(uuid, public.payroll_payment_kind, uuid, date, uuid, text, text, text),
  public.post_payroll_payment(uuid),
  public.cancel_payroll_payment(uuid, text),
  public.payroll_reconciliation(uuid, date),
  public.payroll_month_summary(uuid, date)
from public, anon;
grant execute on function
  public.grant_payroll_access(uuid, uuid, public.payroll_access_level),
  public.revoke_payroll_access(uuid, uuid),
  public.propose_payroll_rule(jsonb),
  public.sign_off_payroll_rule(uuid),
  public.end_payroll_rule(uuid, date),
  public.set_payroll_settings(uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  public.apply_default_payroll_settings(uuid),
  public.propose_payroll_item(uuid, jsonb),
  public.approve_payroll_item(uuid),
  public.retire_payroll_item(uuid),
  public.save_employee(uuid, uuid, jsonb),
  public.add_employee_rate(uuid, date, public.pay_basis, text, text, text),
  public.terminate_employee(uuid, date, text),
  public.create_payroll_run(uuid, public.payroll_frequency, date, date, date, text, text),
  public.add_employee_to_run(uuid, uuid),
  public.remove_payslip(uuid),
  public.set_payslip_lines(uuid, jsonb),
  public.submit_payroll_run(uuid),
  public.return_payroll_run(uuid, text),
  public.post_payroll_run(uuid),
  public.cancel_payroll_run(uuid, text, date),
  public.record_payroll_payment(uuid, public.payroll_payment_kind, uuid, date, uuid, text, text, text),
  public.post_payroll_payment(uuid),
  public.cancel_payroll_payment(uuid, text),
  public.payroll_reconciliation(uuid, date),
  public.payroll_month_summary(uuid, date)
to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010200200', 'payroll_functions') on conflict (version) do nothing;
