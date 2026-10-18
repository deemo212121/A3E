-- Phase 4: the access summary also lists the clients a staff member may work on,
-- so server-side route guards and navigation use the same facts.
-- (RLS remains the final authority for every data access.)

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
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.get_my_access() from public, anon;
grant execute on function public.get_my_access() to authenticated;
