-- Sign-in, messaging and support (part 1 of 3):
--   #10  Customer ID is optional at sign-up ("Add later in Account"). NWS can require it for
--        some orders without a code change: app_settings IDENTITY_REQUIRED_FOR lists the
--        kinds of order that need a verified ID / resident card / passport on the account
--        ("all", "household", "business", "scheduled", "emergency"; empty by default). A
--        trigger checks it when an order is placed by the customer or business member
--        themselves (call-centre, contract and system orders are not checked) and raises
--        identity_required. verify_identity now also checks passport numbers (5–20 letters
--        and digits, stored upper-case without spaces).
--   #11  WhatsApp login codes. Before asking Supabase Auth for a code, the app records the
--        channel the person picked (request_code_channel: sms or whatsapp, and the language).
--        The Send SMS hook (0019) reads it, writes the code to sms_outbox with that channel,
--        renders the message from the 'login_code' template (EN/AR, editable in NWS Settings →
--        Notifications) and hands it to the channel's provider (NOTIFY setting): the built-in
--        simulator marks it sent and logs a masked copy (code hidden) in notification_outbox
--        so NWS sees the delivery. WhatsApp falls back to SMS when the template's WhatsApp
--        switch or the WhatsApp provider is off. Demo mode still shows the code on screen
--        (demo_sms_code reads sms_outbox whatever the channel).
--        WHATSAPP GATEWAY SEAM: auth_code_deliver() (see the comment there).
--   #12  Code-only sign-in needs no schema change: signInWithOtp({ phone, shouldCreateUser:
--        false }) goes through the same hook (kind 'sign_in') and the app admits the session
--        like a password sign-in.

-- ===========================================================================
-- #10 — identity required for some orders (none by default)
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('IDENTITY_REQUIRED_FOR', '[]',
   'Orders that need a verified ID, resident card or passport on the ordering account: any of "all", "household" (customer app orders, the domestic tariff), "business" (business portal orders), "scheduled", "emergency". Empty = ID optional. Call-centre, contract and system orders are not checked.')
on conflict (key) do nothing;

create function public.identity_scopes_valid(p jsonb)
returns boolean language sql immutable
as $$
  select jsonb_typeof(p) = 'array'
     and not exists (select 1 from jsonb_array_elements(p) e
                      where jsonb_typeof(e) <> 'string' or e #>> '{}' not in ('all', 'household', 'business', 'scheduled', 'emergency'))
$$;
alter table public.app_settings add constraint app_settings_identity_required_for
  check (case when key = 'IDENTITY_REQUIRED_FOR' then public.identity_scopes_valid(value::jsonb) else true end);

-- Does this order need the orderer's identity on file?
create function public.identity_required_for_order(o public.orders)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare s jsonb := public.setting_json('IDENTITY_REQUIRED_FOR');
begin
  if s is null or jsonb_typeof(s) <> 'array' or jsonb_array_length(s) = 0 then return false; end if;
  return s ? 'all'
      or (s ? 'household' and o.org_id is null and o.channel = 'app')
      or (s ? 'business' and o.org_id is not null)
      or (s ? 'scheduled' and o.slot_start is not null)
      or (s ? 'emergency' and o.is_emergency);
end $$;

create function public.orders_identity_gate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Only the customer's (or business member's) own orders: staff, contracts and jobs are not checked.
  if auth.uid() is null or public.is_staff() or new.channel in ('call_centre', 'contract') then return new; end if;
  if not public.identity_required_for_order(new) then return new; end if;
  if not coalesce((select id_verified from public.profiles where id = auth.uid()), false) then
    raise exception 'identity_required';
  end if;
  return new;
end $$;
create trigger orders_identity_gate before insert on public.orders for each row execute function public.orders_identity_gate();

-- Civil ID / resident card: 8 digits (simulated national check, as before). Passport: 5–20
-- letters and digits; stored upper-case without spaces.
create or replace function public.verify_identity(p_id_type text, p_id_no text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; v text := upper(regexp_replace(coalesce(p_id_no, ''), '[\s-]', '', 'g'));
begin
  if p_id_type is null or p_id_type not in ('civil_id', 'resident_card', 'passport') then raise exception 'invalid_id_type'; end if;
  if p_id_type in ('civil_id', 'resident_card') and v !~ '^[0-9]{8}$' then raise exception 'id_not_verified'; end if;
  if p_id_type = 'passport' and v !~ '^[A-Z0-9]{5,20}$' then raise exception 'id_not_verified'; end if;
  update public.profiles set id_type = p_id_type, id_no = v, id_verified = true where id = auth.uid() returning * into p;
  return p;
end $$;

-- ===========================================================================
-- #11 — the channel a login code goes by
-- ===========================================================================
alter table public.sms_outbox
  add column channel  text not null default 'sms' check (channel in ('sms', 'whatsapp')),
  add column lang     text not null default 'en' check (lang in ('en', 'ar')),
  add column body     text,
  add column provider text;

-- What the person picked on the code screen, per number, for the next code (15 minutes).
-- Holds no code; still unreadable by clients (a number list).
create table public.otp_channel_requests (
  phone        text primary key,
  channel      text not null check (channel in ('sms', 'whatsapp')),
  lang         text not null default 'en' check (lang in ('en', 'ar')),
  requested_at timestamptz not null default now()
);
alter table public.otp_channel_requests enable row level security;
revoke all on public.otp_channel_requests from public, anon, authenticated;

-- Called just before signUp / signInWithOtp / resend. Answers the same for every number (no
-- account lookup). Picking WhatsApp for someone else's number only changes how their own
-- code reaches their own phone.
create function public.request_code_channel(p_phone text, p_channel text, p_lang text default 'en')
returns text
language plpgsql security definer set search_path = public
as $$
declare p text := public.normalize_phone(p_phone);
begin
  if p is null then raise exception 'invalid_phone'; end if;
  if p_channel is null or p_channel not in ('sms', 'whatsapp') then raise exception 'invalid_channel'; end if;
  delete from public.otp_channel_requests where requested_at < now() - interval '1 day';
  insert into public.otp_channel_requests (phone, channel, lang, requested_at)
  values (p, p_channel, case when p_lang = 'ar' then 'ar' else 'en' end, now())
  on conflict (phone) do update set channel = excluded.channel, lang = excluded.lang, requested_at = now();
  return p_channel;
end $$;

-- The login-code message (one template for both channels; NWS can edit the wording and switch
-- WhatsApp off, which sends WhatsApp requests by SMS).
insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('login_code', 'Sign-in code (SMS or WhatsApp)', 'customer', 'Nama Tanker code',
   '{code} is your Nama Tanker code. It expires in 10 minutes. Never share it: Nama staff will never ask for it.',
   'رمز نماء للصهاريج',
   '{code} هو رمزك في نماء للصهاريج. تنتهي صلاحيته خلال ١٠ دقائق. لا تشاركه مع أحد: موظفو نماء لن يطلبوه منك أبداً.',
   false, true, true, false, 'service', true)
on conflict (event) do nothing;

-- Hand one code to its channel's provider (NOTIFY providers: simulated / external / off).
create function public.auth_code_deliver(p_id bigint)
returns text
language plpgsql security definer set search_path = public
as $$
declare r public.sms_outbox; prov text; tpl public.notification_templates;
begin
  select * into r from public.sms_outbox where id = p_id;
  if not found then return null; end if;
  prov := coalesce(public.setting_json('NOTIFY') -> 'providers' ->> r.channel, 'simulated');
  if prov = 'simulated' then
    update public.sms_outbox set sent_at = now(), provider = 'simulated-' || r.channel, gateway_ref = 'SIM-OTP-' || upper(r.channel) || '-' || r.id where id = r.id;
    -- NWS sees the delivery in the outbox, never the code.
    select * into tpl from public.notification_templates where event = 'login_code';
    insert into public.notification_outbox (user_id, event, channel, lang, destination_masked, title, body, status, attempts, provider, provider_ref, provider_response, sent_at)
    values ((select id from public.profiles where id = r.user_id), 'login_code', r.channel, r.lang, public.mask_phone(r.phone),
            coalesce(case when r.lang = 'ar' then tpl.title_ar else tpl.title_en end, 'Nama Tanker code'),
            replace(coalesce(r.body, ''), r.otp, '••••••'), 'sent', 1, 'simulated-' || r.channel, 'SIM-OTP-' || upper(r.channel) || '-' || r.id,
            jsonb_build_object('simulated', true, 'accepted', true, 'kind', r.kind, 'at', now()), now());
  end if;
  -- WHATSAPP / SMS GATEWAY SEAM. With the channel's provider set to 'external', the code stays
  -- in sms_outbox (sent_at null) for a real gateway. For WhatsApp Business (Meta Cloud API or a
  -- BSP such as Twilio): send an approved AUTHENTICATION template (one-time-password button),
  -- e.g. pg_net here
  --   perform net.http_post(url := 'https://graph.facebook.com/v20.0/<phone-number-id>/messages',
  --     headers := jsonb_build_object('Authorization', 'Bearer ' || <token from Vault>),
  --     body := jsonb_build_object('messaging_product', 'whatsapp', 'to', r.phone, 'type', 'template',
  --       'template', jsonb_build_object('name', 'nama_login_code', 'language', jsonb_build_object('code', r.lang), 'components', ...)));
  -- or switch the Auth hook to HTTPS and send from an Edge Function. Fill sent_at / gateway_ref
  -- from the delivery callback. Keep tokens in Vault, never in this file (docs/mobile-auth.md).
  return prov;
end $$;

-- Supabase Auth → Hooks → Send SMS → Postgres function public.send_sms_hook (0019), now with
-- the channel. event: { "user": { "id", "phone", "phone_confirmed_at", ... }, "sms": { "otp" } }.
-- If Supabase Auth ever passes sms.channel, it wins over the recorded choice.
create or replace function public.send_sms_hook(event jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_phone   text := public.auth_phone_e164(event -> 'user' ->> 'phone');
  v_otp     text := nullif(btrim(coalesce(event -> 'sms' ->> 'otp', '')), '');
  v_uid     text := event -> 'user' ->> 'id';
  v_user    uuid;
  v_req     public.otp_channel_requests;
  v_channel text;
  v_lang    text;
  v_prov    text;
  tpl       public.notification_templates;
  v_body    text;
  v_id      bigint;
begin
  if v_phone is null or v_otp is null then
    return jsonb_build_object('error', jsonb_build_object('http_code', 400, 'message', 'The SMS hook needs user.phone and sms.otp.'));
  end if;
  v_user := case when v_uid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uid::uuid end;
  delete from public.sms_outbox where created_at < now() - interval '1 day';
  select * into v_req from public.otp_channel_requests where phone = v_phone and requested_at > now() - interval '15 minutes';
  v_channel := coalesce(nullif(event -> 'sms' ->> 'channel', ''), v_req.channel, 'sms');
  if v_channel not in ('sms', 'whatsapp') then v_channel := 'sms'; end if;
  v_lang := coalesce(v_req.lang, (select lang from public.profiles where id = v_user), 'en');
  if v_lang not in ('en', 'ar') then v_lang := 'en'; end if;
  select * into tpl from public.notification_templates nt where nt.event = 'login_code';
  if v_channel = 'whatsapp' then
    v_prov := coalesce(public.setting_json('NOTIFY') -> 'providers' ->> 'whatsapp', 'simulated');
    if tpl.event is null or not tpl.whatsapp or v_prov = 'off' then v_channel := 'sms'; end if;
  end if;
  v_body := public.fill_template(coalesce(case when v_lang = 'ar' then tpl.body_ar else tpl.body_en end, 'Nama Tanker code: {code}'),
                                 jsonb_build_object('code', v_otp));
  insert into public.sms_outbox (phone, otp, kind, user_id, channel, lang, body)
  values (v_phone, v_otp,
          coalesce(event -> 'sms' ->> 'sms_type',
                   case when nullif(event -> 'user' ->> 'phone_confirmed_at', '') is null then 'verify_phone' else 'sign_in' end),
          v_user, v_channel, v_lang, v_body)
  returning id into v_id;
  perform public.auth_code_deliver(v_id);
  return '{}'::jsonb;
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function public.identity_scopes_valid(jsonb), public.identity_required_for_order(public.orders), public.orders_identity_gate(),
  public.request_code_channel(text, text, text), public.auth_code_deliver(bigint)
from public, anon, authenticated;
-- identity_scopes_valid backs an app_settings check constraint.
grant execute on function public.identity_scopes_valid(jsonb) to authenticated;
-- Signing up, signing in with a code and resetting happen before there is a session.
grant execute on function public.request_code_channel(text, text, text) to anon, authenticated;
