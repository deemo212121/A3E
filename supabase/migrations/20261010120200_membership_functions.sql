-- Phase 3: privileged operations as SECURITY DEFINER functions.
--
-- Every function:
--   * derives the caller from auth.uid() (never from parameters),
--   * requires an active account,
--   * checks authority and separation-of-duties rules,
--   * writes an audit event.
-- Error codes: 42501 forbidden, P0002 not found, 23505 conflict, 22023 invalid input.

create function private.require_active_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid and is_active) then
    raise exception 'account is disabled' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- 'firm' for firm admins/managers, 'owner' for the client's owner, else null.
create function private.member_admin_level(p_client_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.is_firm_admin() or private.is_firm_manager() then 'firm'
    when private.client_role(p_client_id) = 'client_owner' then 'owner'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Access summary for the signed-in user (used by server-side guards and UI)
-- ---------------------------------------------------------------------------
create function public.get_my_access() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_firm_role public.firm_role;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = v_uid;
  select role into v_firm_role from public.firm_memberships where user_id = v_uid;

  return jsonb_build_object(
    'user_id', v_uid,
    'email', v_profile.email,
    'full_name', v_profile.full_name,
    'is_active', coalesce(v_profile.is_active, false),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'firm_role', v_firm_role,                       -- assigned role
    'firm_role_effective', private.firm_role(),     -- null until MFA satisfied
    'mfa_required', v_firm_role is not null and not private.staff_mfa_ok(),
    'client_memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', c.id, 'code', c.code, 'display_name', c.display_name,
        'status', c.status, 'role', private.client_role(c.id)
      ) order by c.display_name)
      from public.client_memberships cm
      join public.clients c on c.id = cm.client_id
      where cm.user_id = v_uid and private.client_role(c.id) is not null
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
create function public.create_client(p_code text, p_display_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not (private.is_firm_admin() or private.is_firm_manager()) then
    raise exception 'only firm admins and managers can create clients' using errcode = '42501';
  end if;
  insert into public.clients (code, display_name, created_by)
  values (upper(trim(p_code)), trim(p_display_name), auth.uid())
  returning id into v_id;
  perform audit.log_event('client.created', v_id, jsonb_build_object('code', upper(trim(p_code))));
  return v_id;
end;
$$;

create function public.update_client(
  p_client_id uuid, p_display_name text, p_status public.client_status
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not (private.is_firm_admin() or private.is_firm_manager()) then
    raise exception 'only firm admins and managers can update clients' using errcode = '42501';
  end if;
  update public.clients
     set display_name = coalesce(trim(p_display_name), display_name),
         status = coalesce(p_status, status)
   where id = p_client_id;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff assignments
-- ---------------------------------------------------------------------------
create function public.assign_staff(
  p_client_id uuid, p_user_id uuid, p_assignment_role public.assignment_role
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_active_user();
  if not (private.is_firm_admin() or private.is_firm_manager()) then
    raise exception 'only firm admins and managers can assign staff' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  insert into public.client_assignments (client_id, user_id, assignment_role, created_by)
  values (p_client_id, p_user_id, p_assignment_role, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.unassign_staff(
  p_client_id uuid, p_user_id uuid, p_assignment_role public.assignment_role
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not (private.is_firm_admin() or private.is_firm_manager()) then
    raise exception 'only firm admins and managers can unassign staff' using errcode = '42501';
  end if;
  delete from public.client_assignments
   where client_id = p_client_id and user_id = p_user_id and assignment_role = p_assignment_role;
  if not found then
    raise exception 'assignment not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
create function public.create_invitation(
  p_email text,
  p_kind public.invitation_kind,
  p_firm_role public.firm_role default null,
  p_client_id uuid default null,
  p_client_role public.client_role default null,
  p_ttl_hours integer default 72
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_level text;
  v_id uuid;
begin
  perform private.require_active_user();
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'invitation lifetime must be 1 to 168 hours' using errcode = '22023';
  end if;

  if p_kind = 'firm' then
    if not private.is_firm_admin() then
      raise exception 'only firm admins can invite firm staff' using errcode = '42501';
    end if;
    if p_firm_role is null or p_client_id is not null or p_client_role is not null then
      raise exception 'firm invitations need a firm role only' using errcode = '22023';
    end if;
    if exists (select 1 from public.firm_memberships fm
               join public.profiles p on p.id = fm.user_id
               where lower(p.email) = v_email) then
      raise exception 'this person already has a firm role' using errcode = '23505';
    end if;
  else
    if p_client_id is null or p_client_role is null or p_firm_role is not null then
      raise exception 'client invitations need a client and a client role only' using errcode = '22023';
    end if;
    v_level := private.member_admin_level(p_client_id);
    if v_level is null then
      raise exception 'not allowed to invite members to this client' using errcode = '42501';
    end if;
    if v_level = 'owner' and p_client_role = 'client_owner' then
      raise exception 'only the firm can add client owners' using errcode = '42501';
    end if;
    if exists (select 1 from public.clients where id = p_client_id and status = 'archived') then
      raise exception 'client is archived' using errcode = '22023';
    end if;
    if exists (select 1 from public.client_memberships cm
               join public.profiles p on p.id = cm.user_id
               where cm.client_id = p_client_id and lower(p.email) = v_email) then
      raise exception 'this person is already a member of the client' using errcode = '23505';
    end if;
  end if;

  -- Replace any pending invitation for the same person and target.
  update public.invitations
     set revoked_at = now(), revoked_by = auth.uid()
   where lower(email) = v_email and kind = p_kind
     and client_id is not distinct from p_client_id
     and accepted_at is null and revoked_at is null;

  insert into public.invitations
    (email, kind, firm_role, client_id, client_role, expires_at, created_by)
  values
    (v_email, p_kind, p_firm_role, p_client_id, p_client_role,
     now() + make_interval(hours => p_ttl_hours), auth.uid())
  returning id into v_id;

  perform audit.log_event('invitation.created', p_client_id,
    jsonb_build_object('invitation_id', v_id, 'kind', p_kind,
                       'firm_role', p_firm_role, 'client_role', p_client_role));
  return v_id;
end;
$$;

create function public.revoke_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invitations;
begin
  perform private.require_active_user();
  select * into v_inv from public.invitations where id = p_invitation_id;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if not (
    (v_inv.kind = 'firm' and private.is_firm_admin())
    or (v_inv.kind = 'client' and private.member_admin_level(v_inv.client_id) is not null)
  ) then
    raise exception 'not allowed to revoke this invitation' using errcode = '42501';
  end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'invitation is no longer pending' using errcode = '22023';
  end if;
  update public.invitations set revoked_at = now(), revoked_by = auth.uid() where id = p_invitation_id;
end;
$$;

-- Pending invitations addressed to the caller's CONFIRMED email.
create function public.list_my_invitations()
returns table (
  id uuid, kind public.invitation_kind, firm_role public.firm_role,
  client_id uuid, client_name text, client_role public.client_role, expires_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
begin
  return query
  select i.id, i.kind, i.firm_role, i.client_id, c.display_name, i.client_role, i.expires_at
  from public.invitations i
  join auth.users u on u.id = v_uid and u.email_confirmed_at is not null
  left join public.clients c on c.id = i.client_id
  where lower(i.email) = lower(u.email)
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  order by i.created_at;
end;
$$;

create function public.accept_invitation(p_invitation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_user();
  v_email text;
  v_confirmed timestamptz;
  v_inv public.invitations;
begin
  select lower(email), email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  select * into v_inv from public.invitations where id = p_invitation_id for update;

  -- Same error for "missing" and "not yours" to avoid probing other people's invitations.
  if not found or lower(v_inv.email) <> v_email or v_confirmed is null then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'invitation is no longer valid' using errcode = '22023';
  end if;

  if v_inv.kind = 'firm' then
    if exists (select 1 from public.firm_memberships where user_id = v_uid) then
      raise exception 'you already have a firm role' using errcode = '23505';
    end if;
    insert into public.firm_memberships (user_id, role, created_by)
    values (v_uid, v_inv.firm_role, v_inv.created_by);
  else
    if exists (select 1 from public.clients where id = v_inv.client_id and status = 'archived') then
      raise exception 'client is archived' using errcode = '22023';
    end if;
    if exists (select 1 from public.client_memberships
               where client_id = v_inv.client_id and user_id = v_uid) then
      raise exception 'you are already a member of this client' using errcode = '23505';
    end if;
    insert into public.client_memberships (client_id, user_id, role, created_by)
    values (v_inv.client_id, v_uid, v_inv.client_role, v_inv.created_by);
  end if;

  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  perform audit.log_event('invitation.accepted', v_inv.client_id,
    jsonb_build_object('invitation_id', v_inv.id, 'kind', v_inv.kind));
  return jsonb_build_object('kind', v_inv.kind, 'client_id', v_inv.client_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Client membership changes
-- ---------------------------------------------------------------------------
create function private.assert_owner_remains(p_client_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.client_memberships cm
    join public.profiles p on p.id = cm.user_id
    where cm.client_id = p_client_id and cm.role = 'client_owner' and p.is_active
  ) then
    raise exception 'a client must keep at least one active owner' using errcode = '22023';
  end if;
end;
$$;

create function public.set_client_member_role(
  p_client_id uuid, p_user_id uuid, p_role public.client_role
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_level text;
  v_current public.client_role;
begin
  perform private.require_active_user();
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  v_level := private.member_admin_level(p_client_id);
  if v_level is null then
    raise exception 'not allowed to manage members of this client' using errcode = '42501';
  end if;
  select role into v_current from public.client_memberships
   where client_id = p_client_id and user_id = p_user_id for update;
  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;
  if v_level = 'owner' and (p_role = 'client_owner' or v_current = 'client_owner') then
    raise exception 'only the firm can grant or change the owner role' using errcode = '42501';
  end if;
  update public.client_memberships set role = p_role
   where client_id = p_client_id and user_id = p_user_id;
  perform private.assert_owner_remains(p_client_id);
end;
$$;

create function public.remove_client_member(p_client_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_level text;
  v_current public.client_role;
begin
  perform private.require_active_user();
  if p_user_id = auth.uid() then
    raise exception 'you cannot remove yourself' using errcode = '42501';
  end if;
  v_level := private.member_admin_level(p_client_id);
  if v_level is null then
    raise exception 'not allowed to manage members of this client' using errcode = '42501';
  end if;
  select role into v_current from public.client_memberships
   where client_id = p_client_id and user_id = p_user_id for update;
  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;
  if v_level = 'owner' and v_current = 'client_owner' then
    raise exception 'only the firm can remove a client owner' using errcode = '42501';
  end if;
  delete from public.client_memberships where client_id = p_client_id and user_id = p_user_id;
  perform private.assert_owner_remains(p_client_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Firm roles and account status (firm admins only)
-- ---------------------------------------------------------------------------
create function private.assert_admin_remains() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.firm_memberships fm
    join public.profiles p on p.id = fm.user_id
    where fm.role = 'firm_admin' and p.is_active
  ) then
    raise exception 'the firm must keep at least one active firm admin' using errcode = '22023';
  end if;
end;
$$;

-- p_role null removes the firm role.
create function public.set_firm_role(p_user_id uuid, p_role public.firm_role) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_firm_admin() then
    raise exception 'only firm admins can change firm roles' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if p_role is null then
    delete from public.firm_memberships where user_id = p_user_id;
    delete from public.client_assignments where user_id = p_user_id;
  else
    insert into public.firm_memberships (user_id, role, created_by)
    values (p_user_id, p_role, auth.uid())
    on conflict (user_id) do update set role = excluded.role;
    if p_role = 'firm_admin' then
      delete from public.client_assignments where user_id = p_user_id;
    elsif p_role not in ('reviewer', 'firm_manager') then
      delete from public.client_assignments
       where user_id = p_user_id and assignment_role = 'reviewer';
    end if;
  end if;
  perform private.assert_admin_remains();
end;
$$;

create function public.set_user_active(p_user_id uuid, p_active boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_firm_admin() then
    raise exception 'only firm admins can enable or disable accounts' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own account status' using errcode = '42501';
  end if;
  if p_active then
    update public.profiles
       set is_active = true, disabled_at = null, disabled_by = null, disabled_reason = null
     where id = p_user_id;
  else
    if p_reason is null or char_length(trim(p_reason)) < 3 then
      raise exception 'a reason is required to disable an account' using errcode = '22023';
    end if;
    update public.profiles
       set is_active = false, disabled_at = now(), disabled_by = auth.uid(),
           disabled_reason = left(trim(p_reason), 500)
     where id = p_user_id;
  end if;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  perform private.assert_admin_remains();
  perform audit.log_event(case when p_active then 'account.enabled' else 'account.disabled' end,
    null, jsonb_build_object('user_id', p_user_id, 'reason', p_reason));
end;
$$;

-- Authorizes AND audits an MFA reset (lost device). The factor removal itself
-- happens in Supabase Auth via the server, only after this call succeeds.
create function public.authorize_mfa_reset(p_user_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  if not private.is_firm_admin() then
    raise exception 'only firm admins can reset two-step verification' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'ask another firm admin to reset your own two-step verification'
      using errcode = '42501';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  perform audit.log_event('account.mfa_reset', null,
    jsonb_build_object('user_id', p_user_id, 'reason', left(trim(p_reason), 500)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap the first firm admin (service role / SQL editor only)
-- ---------------------------------------------------------------------------
create function private.bootstrap_firm_admin(p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  if exists (select 1 from public.firm_memberships where role = 'firm_admin') then
    raise exception 'a firm admin already exists; use the application to manage roles'
      using errcode = '42501';
  end if;
  select id into v_uid from public.profiles where lower(email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'no user with that email; invite or create the auth user first'
      using errcode = 'P0002';
  end if;
  insert into public.firm_memberships (user_id, role) values (v_uid, 'firm_admin');
  perform audit.log_event('firm_admin.bootstrapped', null, jsonb_build_object('user_id', v_uid));
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  private.require_active_user(), private.member_admin_level(uuid),
  private.assert_owner_remains(uuid), private.assert_admin_remains(),
  private.bootstrap_firm_admin(text)
from public, anon, authenticated;

revoke execute on function
  public.get_my_access(),
  public.create_client(text, text),
  public.update_client(uuid, text, public.client_status),
  public.assign_staff(uuid, uuid, public.assignment_role),
  public.unassign_staff(uuid, uuid, public.assignment_role),
  public.create_invitation(text, public.invitation_kind, public.firm_role, uuid, public.client_role, integer),
  public.revoke_invitation(uuid),
  public.list_my_invitations(),
  public.accept_invitation(uuid),
  public.set_client_member_role(uuid, uuid, public.client_role),
  public.remove_client_member(uuid, uuid),
  public.set_firm_role(uuid, public.firm_role),
  public.set_user_active(uuid, boolean, text),
  public.authorize_mfa_reset(uuid, text)
from public, anon;

grant execute on function
  public.get_my_access(),
  public.create_client(text, text),
  public.update_client(uuid, text, public.client_status),
  public.assign_staff(uuid, uuid, public.assignment_role),
  public.unassign_staff(uuid, uuid, public.assignment_role),
  public.create_invitation(text, public.invitation_kind, public.firm_role, uuid, public.client_role, integer),
  public.revoke_invitation(uuid),
  public.list_my_invitations(),
  public.accept_invitation(uuid),
  public.set_client_member_role(uuid, uuid, public.client_role),
  public.remove_client_member(uuid, uuid),
  public.set_firm_role(uuid, public.firm_role),
  public.set_user_active(uuid, boolean, text),
  public.authorize_mfa_reset(uuid, text)
to authenticated;
