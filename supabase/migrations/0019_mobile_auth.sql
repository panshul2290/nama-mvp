-- Mobile number is the main identity; email is optional.
--
-- Sign-up and sign-in use Supabase phone auth (password + SMS code to verify the
-- number and to reset the password). See docs/mobile-auth.md for the dashboard steps.
--
--   * normalize_phone(): the E.164 rules of lib/phone.ts, on the server.
--   * my_phone(): the caller's VERIFIED mobile (auth.users.phone with phone_confirmed_at).
--     my_email() now also requires a confirmed email. Invitations match on either.
--   * profiles.email: optional contact email given at sign-up (private column).
--   * invitations: by mobile number (primary) or email; exactly one of the two.
--   * Send SMS Auth Hook: public.send_sms_hook(event) writes the code to sms_outbox,
--     which no client role can read. No SMS gateway yet; the seam is marked below.
--   * DEMO_SMS_CODES (app_settings, default off): when on, demo_sms_code(phone)
--     returns the latest code so the demo OTP screen can show it.

-- ===========================================================================
-- Phone numbers
-- ===========================================================================
-- Omani mobiles (8 digits starting 7 or 9, with or without 968 / +968 / 00968), or any
-- other country with an explicit + / 00 prefix (8–15 digits). Null when not a mobile.
create function public.normalize_phone(p text)
returns text language plpgsql immutable set search_path = public
as $$
declare s text; d text; intl boolean;
begin
  if p is null then return null; end if;
  s := translate(btrim(p), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  s := regexp_replace(s, '[[:space:]().-]', '', 'g');
  if s like '00%' then s := '+' || substr(s, 3); end if;
  intl := s like '+%';
  d := case when intl then substr(s, 2) when s ~ '^[0-9]{8}$' then '968' || s else s end;
  if d !~ '^[0-9]+$' then return null; end if;
  if d like '968%' then
    return case when d ~ '^968[79][0-9]{7}$' then '+' || d end;
  end if;
  if not intl then return null; end if;  -- bare digits must be an Omani number
  return case when d ~ '^[1-9][0-9]{7,14}$' then '+' || d end;
end $$;

-- auth.users.phone is stored without the "+" by Supabase Auth.
create function public.auth_phone_e164(p text)
returns text language sql immutable
as $$ select case when nullif(btrim(coalesce(p, '')), '') is not null then '+' || ltrim(btrim(p), '+') end $$;

-- The caller's verified mobile number (E.164), or null.
create function public.my_phone()
returns text language sql stable security definer set search_path = public
as $$ select public.auth_phone_e164(phone) from auth.users where id = auth.uid() and phone_confirmed_at is not null $$;

-- The caller's confirmed email, or null (phone-only accounts have none).
create or replace function public.my_email()
returns text language sql stable security definer set search_path = public
as $$ select lower(email) from auth.users where id = auth.uid() and nullif(email, '') is not null and email_confirmed_at is not null $$;

-- ===========================================================================
-- Profiles: optional contact email; sign-up metadata and verified phone sync
-- ===========================================================================
create function public.valid_email(p text)
returns boolean language sql immutable
as $$ select p is not null and char_length(p) <= 254 and p ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' $$;

alter table public.profiles add column email text check (email is null or public.valid_email(email));
update public.profiles p set email = lower(u.email)
  from auth.users u where u.id = p.id and p.email is null and public.valid_email(lower(u.email));
-- Private like id_no: readable through my_private_profile(), editable by the person.
grant update (email) on public.profiles to authenticated;

create or replace function public.my_private_profile()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id_type', id_type, 'id_no', id_no, 'id_verified', id_verified, 'prefs', prefs, 'loyalty_points', loyalty_points, 'email', email)
    from public.profiles where id = auth.uid()
$$;

-- Phone sign-ups have no auth email: the optional email comes in metadata (contact_email,
-- so it never collides with the keys Supabase Auth adds itself). The phone comes from the
-- metadata or the auth user, normalised when it is a mobile. Never fails the sign-up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); em text;
begin
  em := lower(btrim(coalesce(nullif(new.email, ''), meta ->> 'contact_email', '')));
  insert into public.profiles (id, role, full_name, phone, email)
  values (
    new.id,
    case meta ->> 'role'
      when 'driver' then 'driver'::public.user_role
      when 'owner' then 'owner'::public.user_role
      when 'business' then 'business'::public.user_role
      else 'customer'::public.user_role end,
    coalesce(left(meta ->> 'full_name', 120), ''),
    coalesce(public.normalize_phone(meta ->> 'phone'), public.normalize_phone(public.auth_phone_e164(new.phone)),
             public.auth_phone_e164(new.phone), left(nullif(btrim(meta ->> 'phone'), ''), 32)),
    case when public.valid_email(em) then em end
  );
  return new;
end $$;

-- Once a number is verified (sign-up code, or a phone change), the profile shows it.
create function public.handle_user_contact_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.phone_confirmed_at is not null and nullif(new.phone, '') is not null
     and (new.phone is distinct from old.phone or old.phone_confirmed_at is null) then
    update public.profiles set phone = left(public.auth_phone_e164(new.phone), 32) where id = new.id;
  end if;
  if new.email_confirmed_at is not null and public.valid_email(lower(new.email))
     and (new.email is distinct from old.email or old.email_confirmed_at is null) then
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end $$;
create trigger on_auth_user_contact_changed
  after update of phone, phone_confirmed_at, email, email_confirmed_at on auth.users
  for each row execute function public.handle_user_contact_change();

-- Audit rows name the actor by email, else by mobile number.
create or replace function public.write_audit(p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql security definer set search_path = public
as $$
  insert into public.audit_log (actor_id, actor_email, actor_role, action, target_type, target_id, before, after, reason)
  select auth.uid(), (select coalesce(nullif(email, ''), public.auth_phone_e164(phone)) from auth.users where id = auth.uid()), public.my_staff_role()::text,
         p_action, p_target_type, p_target_id, p_before, p_after, nullif(btrim(coalesce(p_reason, '')), '')
$$;

-- ===========================================================================
-- Invitations by mobile number (primary) or email
-- ===========================================================================
alter table public.invitations add column phone text check (phone ~ '^\+[1-9][0-9]{7,14}$');
alter table public.invitations alter column email drop not null;
alter table public.invitations add constraint invitations_one_target check (num_nonnulls(email, phone) = 1);
drop index public.invitations_one_pending;
create unique index invitations_one_pending_email on public.invitations (kind, coalesce(company_id, org_id), lower(email)) where status = 'pending' and email is not null;
create unique index invitations_one_pending_phone on public.invitations (kind, coalesce(company_id, org_id), phone) where status = 'pending' and phone is not null;
create index invitations_phone on public.invitations (phone) where phone is not null;

-- Is this invitation addressed to the caller? Only a verified phone or confirmed email counts,
-- so knowing (or typing in) someone's number gives nothing.
create function public.invitation_is_mine(p_email text, p_phone text)
returns boolean language sql stable security definer set search_path = public
as $$ select (p_email is not null and lower(p_email) = public.my_email()) or (p_phone is not null and p_phone = public.my_phone()) $$;

-- "Mobile number or email" from an inviting form → exactly one normalised target.
create function public.contact_target(p_contact text, out o_email text, out o_phone text)
language plpgsql immutable set search_path = public
as $$
declare s text := btrim(coalesce(p_contact, ''));
begin
  if position('@' in s) > 0 then
    if not public.valid_email(lower(s)) then raise exception 'invalid_email'; end if;
    o_email := lower(s);
  else
    o_phone := public.normalize_phone(s);
    if o_phone is null then raise exception 'invalid_phone'; end if;
  end if;
end $$;

drop policy invitations_invitee on public.invitations;
create policy invitations_invitee on public.invitations for select to authenticated using (public.invitation_is_mine(email, phone));
drop policy organizations_invitee on public.organizations;
create policy organizations_invitee on public.organizations for select to authenticated using (
  exists (select 1 from public.invitations i where i.org_id = organizations.id and i.status = 'pending' and public.invitation_is_mine(i.email, i.phone)));

drop function public.owner_add_driver(text);
create function public.owner_add_driver(p_contact text)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare i public.invitations; c record;
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  select * into c from public.contact_target(p_contact);
  begin
    insert into public.invitations (kind, company_id, email, phone, invited_by)
    values ('driver', public.my_company_id(), c.o_email, c.o_phone, auth.uid()) returning * into i;
  exception when unique_violation then raise exception 'invitation_pending';
  end;
  return i;
end $$;

drop function public.org_add_member(text, text);
create function public.org_add_member(p_contact text, p_role text)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare i public.invitations; c record;
begin
  if coalesce(public.my_org_role(), '') <> 'admin' then raise exception 'forbidden_for_role'; end if;
  if p_role not in ('admin', 'site_manager', 'finance') then raise exception 'invalid_role'; end if;
  select * into c from public.contact_target(p_contact);
  if c.o_email = public.my_email() or c.o_phone = public.my_phone() then raise exception 'cannot_change_own_role'; end if;
  begin
    insert into public.invitations (kind, org_id, org_role, email, phone, invited_by)
    values ('org_member', public.my_org_id(), p_role, c.o_email, c.o_phone, auth.uid()) returning * into i;
  exception when unique_violation then raise exception 'invitation_pending';
  end;
  return i;
end $$;

-- The invitee accepts (or declines), matched on a verified phone or confirmed email.
-- The invitation and the profile are locked; the profile must still be unattached.
create or replace function public.respond_invitation(p_id uuid, p_accept boolean)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare i public.invitations; me public.profiles;
begin
  select * into i from public.invitations where id = p_id and status = 'pending' and public.invitation_is_mine(email, phone) for update;
  if not found then raise exception 'not_found'; end if;
  if i.expires_at < now() then raise exception 'invitation_expired'; end if;
  if not p_accept then
    update public.invitations set status = 'declined', decided_at = now() where id = i.id returning * into i;
    return i;
  end if;
  select * into me from public.profiles where id = auth.uid() for update;
  if i.kind = 'driver' then
    if me.role <> 'driver' then raise exception 'driver_not_found'; end if;
    if me.company_id is not null and me.company_id <> i.company_id then raise exception 'driver_in_other_company'; end if;
    update public.profiles set company_id = i.company_id where id = me.id;
    -- The driver chose to join: their own unaffiliated tanker joins with them.
    update public.tankers set company_id = i.company_id
     where id = (select tanker_id from public.tanker_assignments where driver_id = me.id and unassigned_at is null) and company_id is null;
  else
    if me.role <> 'business' then raise exception 'user_not_found'; end if;
    if me.org_id is not null and me.org_id <> i.org_id then raise exception 'user_in_other_org'; end if;
    update public.profiles set org_id = i.org_id, org_role = i.org_role where id = me.id;
  end if;
  update public.invitations set status = 'accepted', decided_at = now() where id = i.id returning * into i;
  return i;
end $$;

-- ===========================================================================
-- SMS: Send SMS Auth Hook → sms_outbox
-- ===========================================================================
-- One row per code Supabase Auth asks us to send. Holds live one-time codes, so no
-- client role can read it (RLS on, no policies, no grants). Rows older than a day are
-- pruned by the hook itself.
create table public.sms_outbox (
  id          bigint generated always as identity primary key,
  phone       text not null,
  otp         text not null,
  kind        text not null,               -- verify_phone (sign-up) | sign_in (code sign-in / password reset)
  user_id     uuid,
  created_at  timestamptz not null default now(),
  -- For a real gateway: a worker (or pg_net callback) marks what it delivered.
  sent_at     timestamptz,
  gateway_ref text
);
create index sms_outbox_phone on public.sms_outbox (phone, created_at desc);
alter table public.sms_outbox enable row level security;
revoke all on public.sms_outbox from public, anon, authenticated;

-- Supabase Auth → Hooks → Send SMS → Postgres function public.send_sms_hook.
-- event: { "user": { "id", "phone", "phone_confirmed_at", ... }, "sms": { "otp" } }
-- Returns {} on success, or { "error": { "http_code", "message" } }.
create function public.send_sms_hook(event jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := public.auth_phone_e164(event -> 'user' ->> 'phone');
  v_otp   text := nullif(btrim(coalesce(event -> 'sms' ->> 'otp', '')), '');
  v_uid   text := event -> 'user' ->> 'id';
begin
  if v_phone is null or v_otp is null then
    return jsonb_build_object('error', jsonb_build_object('http_code', 400, 'message', 'The SMS hook needs user.phone and sms.otp.'));
  end if;
  delete from public.sms_outbox where created_at < now() - interval '1 day';
  insert into public.sms_outbox (phone, otp, kind, user_id)
  values (v_phone, v_otp,
          coalesce(event -> 'sms' ->> 'sms_type',
                   case when nullif(event -> 'user' ->> 'phone_confirmed_at', '') is null then 'verify_phone' else 'sign_in' end),
          case when v_uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uid::uuid end);
  -- SMS GATEWAY SEAM: no provider is connected yet, so the code only lands in sms_outbox.
  -- To deliver for real, either point the Send SMS hook at an HTTPS endpoint (Edge Function
  -- calling Twilio / an Omani gateway), or call the gateway from here with pg_net, e.g.
  --   perform net.http_post(url := '<gateway>', headers := '{"Authorization": "Bearer <key>"}'::jsonb,
  --                         body := jsonb_build_object('to', v_phone, 'text', 'Nama Tanker code: ' || v_otp));
  -- (keep the key in Vault, not in this file). See docs/mobile-auth.md.
  return '{}'::jsonb;
end $$;

-- Demo only: show the code on the OTP screen. Off by default; switch on as the database owner:
--   update app_settings set value = 'on' where key = 'DEMO_SMS_CODES';
insert into public.app_settings (key, value, notes) values
  ('DEMO_SMS_CODES', 'off', 'on: demo_sms_code(phone) returns the latest SMS code so the demo sign-up/reset screens can show it. Never on in production (anyone could read any number''s code).')
on conflict (key) do nothing;
alter table public.app_settings add constraint app_settings_demo_sms_codes check (key <> 'DEMO_SMS_CODES' or value in ('on', 'off'));

create function public.demo_sms_code(p_phone text)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare p text := public.normalize_phone(p_phone); v text;
begin
  if coalesce((select value from public.app_settings where key = 'DEMO_SMS_CODES'), 'off') <> 'on' or p is null then return null; end if;
  select otp into v from public.sms_outbox where phone = p and created_at > now() - interval '10 minutes' order by created_at desc, id desc limit 1;
  return v;
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function public.normalize_phone(text), public.auth_phone_e164(text), public.my_phone(), public.valid_email(text),
  public.handle_user_contact_change(), public.invitation_is_mine(text, text), public.contact_target(text),
  public.send_sms_hook(jsonb), public.demo_sms_code(text), public.owner_add_driver(text), public.org_add_member(text, text)
from public, anon, authenticated;
-- valid_email backs a profiles check constraint, so whoever updates profiles.email needs it.
grant execute on function public.normalize_phone(text), public.valid_email(text), public.my_phone(), public.invitation_is_mine(text, text),
  public.owner_add_driver(text), public.org_add_member(text, text) to authenticated;
-- Signing up and resetting happen before there is a session.
grant execute on function public.demo_sms_code(text) to anon, authenticated;
-- Supabase Auth runs the hook as supabase_auth_admin.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.send_sms_hook(jsonb) to supabase_auth_admin;
