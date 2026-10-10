-- Lint fix (plpgsql_check): the FOR loop declares its own integer variable;
-- the extra DECLAREd "i" was unused and shadowed. Behaviour is unchanged.
create or replace function public.create_fiscal_year(
  p_client_id uuid, p_start_date date, p_months integer default 12
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_fy uuid;
  v_end date;
begin
  perform private.require_active_user();
  if not private.can_approve_entries(p_client_id) then
    raise exception 'only reviewers and managers can open fiscal years' using errcode = '42501';
  end if;
  if extract(day from p_start_date) <> 1 then
    raise exception 'a fiscal year must start on the first day of a month' using errcode = '22023';
  end if;
  if p_months is null or p_months < 1 or p_months > 12 then
    raise exception 'a fiscal year has 1 to 12 monthly periods' using errcode = '22023';
  end if;
  v_end := (p_start_date + make_interval(months => p_months))::date - 1;
  insert into public.fiscal_years (client_id, start_date, end_date)
  values (p_client_id, p_start_date, v_end) returning id into v_fy;
  for period_index in 1..p_months loop
    insert into public.accounting_periods (client_id, fiscal_year_id, period_no, start_date, end_date)
    values (p_client_id, v_fy, period_index,
            (p_start_date + make_interval(months => period_index - 1))::date,
            (p_start_date + make_interval(months => period_index))::date - 1);
  end loop;
  return v_fy;
end;
$$;
