-- 0052: optional two-step sign-in (TOTP) for NWS staff (security review SEC-06).
--
-- Staff and admin accounts were password-only. Staff can now add an authenticator app
-- (Supabase Auth MFA, TOTP) from the NWS portal; once added, the portal asks for its code at
-- every sign-in. STAFF_MFA decides whether it is required:
--   * 'off' (the demo default): optional. Nothing changes for staff who don't add one.
--   * 'on': every staff permission needs a session that passed the second step (JWT aal2).
--     my_staff_role() — the one function every staff RLS policy and RPC checks (is_staff,
--     require_staff, staff_pii_role, …) — returns null for an aal1 session, so a stolen
--     password alone reads and does nothing as staff. The portal sends such sessions to add or
--     use their authenticator first.
-- Admins switch it with staff_set_staff_mfa (reason required, audited); with it on, only an
-- admin who signed in with the second step can switch it off again.

insert into public.app_settings (key, value, notes) values
  ('STAFF_MFA', 'off', 'Two-step sign-in (authenticator app) for NWS staff. off: optional. on: staff permissions need a session that passed the second step (aal2).')
on conflict (key) do nothing;
alter table public.app_settings add constraint app_settings_staff_mfa check (key <> 'STAFF_MFA' or value in ('on', 'off'));

-- The session's authenticator assurance level from the JWT (aal1 when absent).
create function public.jwt_aal()
returns text language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1') $$;

create function public.staff_mfa_required()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select value from public.app_settings where key = 'STAFF_MFA'), 'off') = 'on' $$;

create or replace function public.my_staff_role()
returns public.staff_role
language sql stable security definer set search_path = public
as $$
  select staff_role from public.profiles
   where id = auth.uid() and role = 'nws_staff'
     and (not public.staff_mfa_required() or public.jwt_aal() = 'aal2')
$$;

-- For the portal: is the second step required, and has this session passed it?
create function public.staff_mfa_status()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('required', public.staff_mfa_required(), 'aal', public.jwt_aal(),
                            'staff', exists (select 1 from public.profiles where id = auth.uid() and role = 'nws_staff'))
$$;

create function public.staff_set_staff_mfa(p_on boolean, p_reason text)
returns text
language plpgsql security definer set search_path = public
as $$
declare b text; a text := case when p_on then 'on' else 'off' end; r text;
begin
  perform public.require_staff(array[]::public.staff_role[]);  -- admins only
  r := public.require_reason(p_reason);
  -- Switching it on from a password-only session would lock the admin out of staff rights.
  if p_on and public.jwt_aal() <> 'aal2' then raise exception 'mfa_required: add and use your authenticator app first'; end if;
  select value into b from public.app_settings where key = 'STAFF_MFA' for update;
  update public.app_settings set value = a where key = 'STAFF_MFA';
  perform public.write_audit('setting.update', 'setting', 'STAFF_MFA', to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

revoke execute on function public.jwt_aal(), public.staff_mfa_required(), public.staff_mfa_status(), public.staff_set_staff_mfa(boolean, text) from public, anon;
grant execute on function public.jwt_aal(), public.staff_mfa_required(), public.staff_mfa_status(), public.staff_set_staff_mfa(boolean, text) to authenticated;
