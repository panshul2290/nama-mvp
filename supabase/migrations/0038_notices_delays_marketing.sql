-- Sign-in, messaging and support (part 2 of 3):
--   #19  Automatic delay messages. scan_delay_notices() (pg_cron every 2 minutes, registered
--        through nama_schedule → cron_wanted → scripts/schedule-cron.mjs; staff can run it
--        too) tells the customer, through notify() and the outbox, in their language, once per
--        event (order_notices is the dedupe log):
--          * still unassigned N minutes after release              → order_unassigned
--          * an assigned tanker's ETA slips more than X minutes      → order_eta_slip
--            (the promise is set when the tanker is assigned: straight-line distance at the
--            DISPATCH speed plus a filling allowance; re-estimated from the tanker's last fix)
--          * past the delivery window / SLA (sla_due_at, 0026)       → order_late
--          * a reassignment to another tanker                        → order_reassigned
--          * the driver giving the job back / cancelling             → driver_reassigning /
--            order_cancelled, unless the status-change trigger (0011) has already said so
--        A trigger logs tanker changes (order_dispatch_events); the scan sends the messages.
--        Thresholds: app_settings DELAY_NOTICES (NWS Settings → Notifications).
--   #20  Service-disruption notices: NWS operators and admins post a notice (EN/AR title and
--        text, severity, all areas / zones / clusters, start and end), optionally notifying the
--        customers and business admins with a property or a recent order there. Customers see
--        it on the app home and request screen, businesses on their dashboard for the sites it
--        covers (my_service_notices).
--   #21  Transactional vs marketing. Every template has a message class (marketing for the
--        marketing category, transactional otherwise), copied onto each outbox row with the
--        SMS sender ID for that class (NOTIFY sender_ids: transactional and marketing).
--        Marketing goes only to people with the promotions consent (0026), always ends with
--        an opt-out line, and marketing SMS waits until the quiet hours end (21:00–08:00
--        Asia/Muscat, NOTIFY quiet_hours).

-- ===========================================================================
-- #21 — message class, sender IDs, quiet hours, opt-out line
-- ===========================================================================
alter table public.notification_templates
  add column message_class text generated always as (case when category = 'marketing' then 'marketing' else 'transactional' end) stored;

alter table public.notification_outbox
  add column message_class text not null default 'transactional' check (message_class in ('transactional', 'marketing')),
  add column sender_id     text;
grant select (message_class, sender_id) on public.notification_outbox to authenticated;

update public.app_settings
   set value = (value::jsonb
                || jsonb_build_object('sender_ids', jsonb_build_object('transactional', coalesce(value::jsonb ->> 'sender_id', 'NamaWater'), 'marketing', 'NamaOffers'))
                || '{"quiet_hours": {"start": 21, "end": 8}}'::jsonb)::text
 where key = 'NOTIFY' and value ~ '^\s*\{' and not (value::jsonb ? 'sender_ids');

-- A sample marketing template (nothing sends it automatically; NWS can use it for campaigns).
insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('promo_offer', 'Offer (marketing)', 'customer', '{title}', '{body}', '{title}', '{body}', true, true, false, false, 'marketing', false)
on conflict (event) do nothing;

-- The opt-out line every marketing message carries.
create function public.marketing_opt_out(p_lang text)
returns text language sql immutable
as $$
  select case when p_lang = 'ar'
              then 'لإيقاف العروض: الحساب ← العروض والخصومات، أو أرسل STOP.'
              else 'To stop offers: Account → Promotions and offers, or reply STOP.' end
$$;

-- End of the quiet hours (Asia/Muscat) if p_at falls inside them, else null.
create function public.quiet_hours_until(p_at timestamptz)
returns timestamptz
language plpgsql stable security definer set search_path = public
as $$
declare
  cfg jsonb := public.setting_json('NOTIFY') -> 'quiet_hours';
  s integer := coalesce((cfg ->> 'start')::integer, 21);
  e integer := coalesce((cfg ->> 'end')::integer, 8);
  loc timestamp := p_at at time zone 'Asia/Muscat';
  h integer := extract(hour from loc)::integer;
begin
  if s = e then return null; end if;
  if s > e then
    if h >= s then return (date_trunc('day', loc) + interval '1 day' + make_interval(hours => e)) at time zone 'Asia/Muscat'; end if;
    if h < e then return (date_trunc('day', loc) + make_interval(hours => e)) at time zone 'Asia/Muscat'; end if;
  elsif h >= s and h < e then
    return (date_trunc('day', loc) + make_interval(hours => e)) at time zone 'Asia/Muscat';
  end if;
  return null;
end $$;

-- 0026's enqueue, plus the message class and sender ID on each row and quiet hours for
-- marketing SMS (queued until the quiet hours end).
create or replace function public.notification_enqueue(p_notification bigint, p_user uuid, p_event text, p_channels text[], p_title text, p_body text,
                                                       p_order uuid, p_lang text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  pr public.profiles; c text; dest text; n integer := 0; tk record; test boolean;
  cls text := coalesce((select message_class from public.notification_templates where event = p_event), 'transactional');
  senders jsonb := public.setting_json('NOTIFY');
  sender text := coalesce(senders -> 'sender_ids' ->> cls, senders ->> 'sender_id');
  later timestamptz := case when cls = 'marketing' then public.quiet_hours_until(now()) end;
begin
  select * into pr from public.profiles where id = p_user;
  if not found then return 0; end if;
  test := coalesce((select is_test from public.orders where id = p_order), false);
  foreach c in array coalesce(p_channels, '{}') loop
    if c = 'push' then
      for tk in select token, platform from public.push_tokens where user_id = p_user and revoked_at is null order by last_seen_at desc limit 5 loop
        insert into public.notification_outbox (notification_id, user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test, message_class)
        values (p_notification, p_user, p_event, 'push', p_lang, tk.token, tk.platform || ' device ' || left(tk.token, 6) || '…', p_title, p_body, p_order, test, cls);
        n := n + 1;
      end loop;
      if not found then
        insert into public.notification_outbox (notification_id, user_id, event, channel, lang, title, body, order_id, is_test, status, error, message_class)
        values (p_notification, p_user, p_event, 'push', p_lang, p_title, p_body, p_order, test, 'failed', 'No registered device (no push token)', cls);
        n := n + 1;
      end if;
    elsif c in ('sms', 'whatsapp') then
      dest := coalesce(public.normalize_phone(pr.phone),
                       (select public.auth_phone_e164(u.phone) from auth.users u where u.id = p_user and u.phone is not null));
      insert into public.notification_outbox (notification_id, user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test, status, error,
                                              message_class, sender_id, next_attempt_at)
      values (p_notification, p_user, p_event, c, p_lang, dest, public.mask_phone(dest), p_title, p_body, p_order, test,
              case when dest is null then 'failed' else 'queued' end, case when dest is null then 'No mobile number on the account' end,
              cls, sender, case when c = 'sms' and later is not null then later else now() end);
      n := n + 1;
    elsif c = 'email' then
      dest := coalesce(pr.email, (select lower(u.email) from auth.users u where u.id = p_user and coalesce(u.email, '') <> ''));
      insert into public.notification_outbox (notification_id, user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test, status, error, message_class)
      values (p_notification, p_user, p_event, 'email', p_lang, dest, public.mask_email(dest), p_title, p_body, p_order, test,
              case when dest is null then 'failed' else 'queued' end, case when dest is null then 'No email address on the account' end, cls);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- 0026's notify(), plus the opt-out line on marketing messages.
create or replace function public.notify(p_user uuid, p_event text, p_order uuid, p_vars jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  tpl public.notification_templates;
  pr public.profiles;
  lang text;
  prefs jsonb;
  ch text[] := '{}';
  t text; b text;
  nid bigint;
begin
  if p_user is null then return; end if;
  select * into tpl from public.notification_templates where event = p_event;
  if not found then return; end if;
  select * into pr from public.profiles where id = p_user;
  if not found then return; end if;
  prefs := public.effective_prefs(pr.prefs);
  if tpl.category = 'marketing' and not coalesce((prefs ->> 'promotions')::boolean, false) then return; end if;
  if tpl.category = 'reminder' and not coalesce((prefs ->> 'reminders')::boolean, true) then return; end if;
  lang := coalesce(pr.lang, 'en');
  if tpl.push and coalesce((prefs ->> 'push')::boolean, true) then ch := array_append(ch, 'push'); end if;
  if tpl.sms and (coalesce((prefs ->> 'sms')::boolean, true) or tpl.critical) then ch := array_append(ch, 'sms'); end if;
  if tpl.whatsapp and coalesce((prefs ->> 'whatsapp')::boolean, false) then ch := array_append(ch, 'whatsapp'); end if;
  if tpl.email and coalesce((prefs ->> 'email')::boolean, false) then ch := array_append(ch, 'email'); end if;
  if lang = 'ar' then
    select coalesce(p_vars, '{}'::jsonb) || coalesce(jsonb_object_agg(left(k, -3), v), '{}'::jsonb) into p_vars
      from jsonb_each(coalesce(p_vars, '{}'::jsonb)) as e(k, v) where k like '%\_ar';
  end if;
  t := public.fill_template(case when lang = 'ar' then tpl.title_ar else tpl.title_en end, p_vars);
  b := public.fill_template(case when lang = 'ar' then tpl.body_ar else tpl.body_en end, p_vars);
  if tpl.category = 'marketing' then b := btrim(b) || E'\n' || public.marketing_opt_out(lang); end if;
  insert into public.notifications (user_id, event, channels, title, body, order_id)
  values (p_user, p_event, case when cardinality(ch) = 0 then array['in_app'] else ch end, t, b, p_order)
  returning id into nid;
  if cardinality(ch) > 0 then
    perform public.notification_enqueue(nid, p_user, p_event, ch, t, b, p_order, lang);
  end if;
end $$;

-- The simulator records the sender ID it was given.
create or replace function public.notification_send_simulated(r public.notification_outbox)
returns jsonb
language plpgsql stable
as $$
declare ok boolean := true; perm boolean := false; err text;
begin
  if r.channel in ('sms', 'whatsapp') and right(regexp_replace(coalesce(r.destination, ''), '\D', '', 'g'), 4) = '0000' then
    ok := false; err := 'Simulated: handset unreachable';
  elsif r.channel = 'push' and r.destination like 'invalid%' then
    ok := false; perm := true; err := 'Simulated: UNREGISTERED (token no longer valid)';
  elsif r.channel = 'email' and r.destination like '%@bounce.test' then
    ok := false; perm := true; err := 'Simulated: mailbox does not exist (hard bounce)';
  end if;
  return jsonb_build_object(
    'ok', ok, 'permanent', perm, 'error', err, 'provider', 'simulated-' || r.channel,
    'ref', case when ok then 'SIM-' || upper(r.channel) || '-' || r.id end,
    'response', jsonb_build_object('simulated', true, 'accepted', ok, 'to', r.destination_masked, 'at', now(), 'class', r.message_class,
                                   'sender', case when r.channel in ('sms', 'whatsapp') then r.sender_id end,
                                   'segments', case when r.channel = 'sms' then ceil(char_length(r.body)::numeric / case when r.lang = 'ar' then 70 else 160 end) end,
                                   'error', err));
end $$;

-- A marketing SMS that comes up during the quiet hours (a retry, a setting change) waits for
-- the morning instead of being sent; null leaves it queued, like an external channel.
create or replace function public.notification_send(r public.notification_outbox)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare prov text := coalesce(public.setting_json('NOTIFY') -> 'providers' ->> r.channel, 'simulated'); later timestamptz;
begin
  if r.channel = 'sms' and r.message_class = 'marketing' then
    later := public.quiet_hours_until(now());
    if later is not null then
      update public.notification_outbox set next_attempt_at = later where id = r.id;
      return null;
    end if;
  end if;
  if prov = 'simulated' then return public.notification_send_simulated(r); end if;
  if prov = 'off' then
    return jsonb_build_object('ok', false, 'permanent', true, 'provider', 'off', 'error', 'Channel switched off in NWS settings', 'response', null);
  end if;
  return null;
end $$;

-- Admins: the SMS sender IDs per class (alphanumeric, 3–11 characters, as SMS gateways allow).
create function public.staff_set_sender_ids(p_transactional text, p_marketing text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; a jsonb; r text; tr text := btrim(coalesce(p_transactional, '')); mk text := btrim(coalesce(p_marketing, ''));
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if tr !~ '^[A-Za-z0-9][A-Za-z0-9 ]{1,9}[A-Za-z0-9]$' or mk !~ '^[A-Za-z0-9][A-Za-z0-9 ]{1,9}[A-Za-z0-9]$' then raise exception 'invalid_sender_id'; end if;
  if lower(tr) = lower(mk) then raise exception 'invalid_sender_id: transactional and marketing need different sender IDs'; end if;
  b := public.setting_json('NOTIFY');
  a := b || jsonb_build_object('sender_id', tr, 'sender_ids', jsonb_build_object('transactional', tr, 'marketing', mk));
  update public.app_settings set value = a::text where key = 'NOTIFY';
  perform public.write_audit('setting.update', 'setting', 'NOTIFY', b, a, r);
  return a;
end $$;

-- ===========================================================================
-- #19 — delay messages
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('DELAY_NOTICES', '{"enabled": true, "unassigned_min": 20, "eta_slip_min": 15, "fill_min": 20}',
   'Automatic delay messages to customers: still unassigned after unassigned_min minutes; ETA slipping by more than eta_slip_min minutes (fill_min minutes are allowed for filling at the station); past the delivery window or SLA; reassignment; the driver giving the job back.')
on conflict (key) do nothing;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('order_unassigned', 'Still finding a tanker (delay)', 'customer', 'Still finding a tanker for {order}',
   'It’s taking longer than usual ({minutes} min so far). We’ll message you as soon as a tanker is assigned. You can still cancel free of charge.',
   'ما زلنا نبحث عن صهريج للطلب {order}',
   'يستغرق الأمر وقتاً أطول من المعتاد ({minutes} دقيقة حتى الآن). سنراسلك فور تعيين صهريج. لا يزال بإمكانك الإلغاء مجاناً.',
   true, true, true, false, 'service', false),
  ('order_eta_slip', 'Tanker running late (ETA)', 'customer', 'Your tanker is running late',
   '{plate} is about {minutes} min behind for {order}. New estimate: {eta}.',
   'الصهريج متأخر',
   'الصهريج {plate} متأخر نحو {minutes} دقيقة للطلب {order}. الموعد المتوقع الجديد: {eta}.',
   true, true, true, false, 'service', true),
  ('order_late', 'Past the delivery window', 'customer', '{order} is running late',
   'Your delivery is past its promised time ({window}). The NWS control room is on it and we’ll keep you posted.',
   'الطلب {order} متأخر',
   'تجاوز التوصيل موعده المحدد ({window}). غرفة التحكم في نماء تتابع الأمر وسنبقيك على اطلاع.',
   true, true, true, false, 'service', true),
  ('order_reassigned', 'New tanker assigned', 'customer', 'New tanker for {order}',
   '{plate} ({driver}) is taking over your delivery. Track it live in the app.',
   'صهريج جديد للطلب {order}',
   'الصهريج {plate} ({driver}) سيتولى توصيل طلبك. تابعه مباشرة في التطبيق.',
   true, true, true, false, 'service', true)
on conflict (event) do nothing;

-- Dedupe log: one message per order, kind and reference (the release time, the tanker, the event).
create table public.order_notices (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references public.orders (id) on delete cascade,
  kind       text not null check (kind in ('unassigned', 'eta_slip', 'late', 'reassigned', 'released', 'driver_cancelled')),
  ref        text not null default '',
  sent       boolean not null default true,   -- false: another path had already told the customer
  created_at timestamptz not null default now(),
  unique (order_id, kind, ref)
);

-- The ETA promised when a tanker was assigned.
create table public.order_eta_promises (
  order_id    uuid primary key references public.orders (id) on delete cascade,
  tanker_id   uuid references public.tankers (id) on delete set null,
  promised_at timestamptz not null,
  set_at      timestamptz not null default now()
);

-- Tanker changes on an order, for the scan.
create table public.order_dispatch_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  kind        text not null check (kind in ('reassigned', 'released', 'driver_cancelled')),
  from_tanker uuid,
  to_tanker   uuid,
  at          timestamptz not null default now(),
  handled_at  timestamptz
);
create index order_dispatch_events_open_idx on public.order_dispatch_events (id) where handled_at is null;

alter table public.order_notices enable row level security;
alter table public.order_eta_promises enable row level security;
alter table public.order_dispatch_events enable row level security;
revoke all on public.order_notices, public.order_eta_promises, public.order_dispatch_events from public, anon, authenticated;
grant select on public.order_notices to authenticated;
create policy order_notices_staff on public.order_notices for select to authenticated using (public.is_staff());

-- Minutes from the tanker's last fix to the delivery point at the DISPATCH speed, plus the filling
-- allowance while a drinking/treated-water load isn't filled yet. Null without a fix.
create function public.order_eta_minutes(o public.orders)
returns integer
language sql stable security definer set search_path = public
as $$
  select ceil(public.km(t.last_lat, t.last_lng, l.lat, l.lng) / greatest(coalesce((public.setting_json('DISPATCH') ->> 'speed_kmh')::numeric, 30), 1) * 60
              + case when o.service_type <> 'WW' and o.filled_at is null then coalesce((public.setting_json('DELAY_NOTICES') ->> 'fill_min')::numeric, 20) else 0 end)::integer
    from public.tankers t join public.order_locations l on l.order_id = o.id
   where t.id = o.tanker_id and t.last_lat is not null and t.last_lng is not null
$$;

create function public.orders_dispatch_watch()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.tanker_id is not null and new.tanker_id is distinct from old.tanker_id then
    insert into public.order_eta_promises (order_id, tanker_id, promised_at)
    values (new.id, new.tanker_id, now() + make_interval(mins => coalesce(public.order_eta_minutes(new), 60)))
    on conflict (order_id) do update set tanker_id = excluded.tanker_id, promised_at = excluded.promised_at, set_at = now();
    if old.tanker_id is not null then
      insert into public.order_dispatch_events (order_id, kind, from_tanker, to_tanker) values (new.id, 'reassigned', old.tanker_id, new.tanker_id);
    end if;
  elsif old.tanker_id is not null and new.tanker_id is null and new.status = 'requested' then
    insert into public.order_dispatch_events (order_id, kind, from_tanker) values (new.id, 'released', old.tanker_id);
  end if;
  if new.status = 'cancelled' and old.status is distinct from new.status and new.cancelled_by = 'driver' then
    insert into public.order_dispatch_events (order_id, kind, from_tanker) values (new.id, 'driver_cancelled', old.tanker_id);
  end if;
  return new;
end $$;
create trigger orders_dispatch_watch after update of tanker_id, status on public.orders for each row execute function public.orders_dispatch_watch();

-- Record a notice once; true when this call recorded it (the caller then sends the message).
create function public.order_notice_once(p_order uuid, p_kind text, p_ref text, p_sent boolean default true)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare nid bigint;
begin
  insert into public.order_notices (order_id, kind, ref, sent) values (p_order, p_kind, coalesce(p_ref, ''), p_sent)
  on conflict (order_id, kind, ref) do nothing returning id into nid;
  return nid is not null;
end $$;

create function public.scan_delay_notices()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  cfg jsonb := coalesce(public.setting_json('DELAY_NOTICES'), '{}'::jsonb);
  un integer := coalesce((cfg ->> 'unassigned_min')::integer, 20);
  slip_min integer := coalesce((cfg ->> 'eta_slip_min')::integer, 15);
  o public.orders; e public.order_dispatch_events; p public.order_eta_promises;
  n_un integer := 0; n_eta integer := 0; n_late integer := 0; n_ev integer := 0;
  eta integer; slip integer; ref text; due timestamptz; t public.tankers;
  v jsonb;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'not_staff'; end if;
  if not coalesce((cfg ->> 'enabled')::boolean, true) then return jsonb_build_object('enabled', false); end if;

  -- 1. Released but still unassigned after N minutes (once per release).
  for o in select * from public.orders x
            where x.status = 'requested' and x.tanker_id is null and x.created_at > now() - interval '2 days'
              and coalesce(x.released_at, x.created_at) < now() - make_interval(mins => un)
              and (x.slot_start is null or x.slot_start <= now()) loop
    ref := extract(epoch from coalesce(o.released_at, o.created_at))::bigint::text;
    if public.order_notice_once(o.id, 'unassigned', ref) then
      perform public.notify(o.customer_id, 'order_unassigned', o.id, jsonb_build_object('order', 'TO-' || o.order_no,
        'minutes', floor(extract(epoch from now() - coalesce(o.released_at, o.created_at)) / 60)::integer));
      n_un := n_un + 1;
    end if;
  end loop;

  -- 2. ETA slipping more than X minutes behind the promise (once per assignment).
  for o in select x.* from public.orders x join public.order_eta_promises pp on pp.order_id = x.id and pp.tanker_id = x.tanker_id
            where x.status in ('accepted', 'arriving') loop
    eta := public.order_eta_minutes(o);
    if eta is null then continue; end if;
    select * into p from public.order_eta_promises where order_id = o.id;
    slip := floor(extract(epoch from (now() + make_interval(mins => eta)) - p.promised_at) / 60)::integer;
    if slip >= slip_min and public.order_notice_once(o.id, 'eta_slip', o.tanker_id::text) then
      perform public.notify(o.customer_id, 'order_eta_slip', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'plate', coalesce(o.tanker_plate, ''),
        'minutes', slip, 'eta', to_char((now() + make_interval(mins => eta)) at time zone 'Asia/Muscat', 'HH24:MI')));
      n_eta := n_eta + 1;
    end if;
  end loop;

  -- 3. Past the delivery window / SLA (once per order).
  for o in select * from public.orders x
            where x.status in ('requested', 'accepted', 'arriving') and x.created_at > now() - interval '2 days' and public.sla_due_at(x) < now() loop
    if exists (select 1 from public.order_notices where order_id = o.id and kind = 'late') then continue; end if;
    due := public.sla_due_at(o);
    -- The control-room scan (staff_scan) may already have sent "Your tanker is delayed".
    if exists (select 1 from public.notifications where order_id = o.id and event in ('driver_delayed', 'order_late')) then
      perform public.order_notice_once(o.id, 'late', '', false);
      continue;
    end if;
    perform public.order_notice_once(o.id, 'late', '');
    if o.slot_end is not null and o.tanker_id is not null then
      -- Same alert (and dedupe key) as staff_scan, which then doesn't message the customer again.
      select * into t from public.tankers where id = o.tanker_id;
      perform public.raise_alert(o.tanker_id, o.id, 'Delivery window breach', 'med', format('TO-%s missed its %s window', o.order_no, coalesce(o.slot_label, 'delivery')),
                                 t.last_lat, t.last_lng, 'window:' || o.id);
    end if;
    perform public.notify(o.customer_id, 'order_late', o.id, jsonb_build_object('order', 'TO-' || o.order_no,
      'window', coalesce(nullif(o.slot_label, ''), to_char(due at time zone 'Asia/Muscat', 'HH24:MI'))));
    n_late := n_late + 1;
  end loop;

  -- 4. Reassignments and jobs given back.
  for e in select * from public.order_dispatch_events where handled_at is null order by id limit 500 loop
    select * into o from public.orders where id = e.order_id;
    v := jsonb_build_object('order', 'TO-' || o.order_no, 'plate', coalesce(o.tanker_plate, ''), 'driver', coalesce(o.driver_name, ''));
    if e.kind = 'reassigned' then
      if o.tanker_id = e.to_tanker and o.status in ('accepted', 'arriving', 'arrived', 'collected')
         and public.order_notice_once(o.id, 'reassigned', e.id::text) then
        perform public.notify(o.customer_id, 'order_reassigned', o.id, v);
        n_ev := n_ev + 1;
      end if;
    elsif e.kind = 'released' then
      if exists (select 1 from public.notifications where order_id = o.id and event = 'driver_reassigning' and created_at >= e.at - interval '1 minute') then
        perform public.order_notice_once(o.id, 'released', e.id::text, false);
      elsif o.status = 'requested' and public.order_notice_once(o.id, 'released', e.id::text) then
        perform public.notify(o.customer_id, 'driver_reassigning', o.id, v);
        n_ev := n_ev + 1;
      end if;
    elsif e.kind = 'driver_cancelled' then
      if exists (select 1 from public.notifications where order_id = o.id and event = 'order_cancelled' and created_at >= e.at - interval '1 minute') then
        perform public.order_notice_once(o.id, 'driver_cancelled', e.id::text, false);
      elsif public.order_notice_once(o.id, 'driver_cancelled', e.id::text) then
        perform public.notify(o.customer_id, 'order_cancelled', o.id, v || jsonb_build_object('reason', coalesce(o.cancel_reason, '')));
        n_ev := n_ev + 1;
      end if;
    end if;
    update public.order_dispatch_events set handled_at = now() where id = e.id;
  end loop;
  delete from public.order_dispatch_events where handled_at < now() - interval '30 days';
  return jsonb_build_object('enabled', true, 'unassigned', n_un, 'eta_slip', n_eta, 'late', n_late, 'dispatch', n_ev);
end $$;

-- ===========================================================================
-- Settings this batch owns (admins): DELAY_NOTICES and IDENTITY_REQUIRED_FOR (0037)
-- ===========================================================================
create function public.staff_update_comms_setting(p_key text, p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_key not in ('DELAY_NOTICES', 'IDENTITY_REQUIRED_FOR') then raise exception 'invalid_setting'; end if;
  if p_key = 'DELAY_NOTICES' and not (jsonb_typeof(p_value -> 'enabled') = 'boolean'
       and coalesce((p_value ->> 'unassigned_min')::integer, 0) between 5 and 240
       and coalesce((p_value ->> 'eta_slip_min')::integer, 0) between 5 and 180
       and coalesce((p_value ->> 'fill_min')::integer, -1) between 0 and 120) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'IDENTITY_REQUIRED_FOR' then
    if not public.identity_scopes_valid(p_value) then raise exception 'invalid_value'; end if;
    select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into p_value from jsonb_array_elements_text(p_value) x;
  end if;
  b := public.setting_json(p_key);
  update public.app_settings set value = p_value::text where key = p_key;
  perform public.write_audit('setting.update', 'setting', p_key, b, p_value, r);
  return p_value;
end $$;

-- ===========================================================================
-- #20 — service-disruption notices
-- ===========================================================================
create table public.service_notices (
  id            uuid primary key default gen_random_uuid(),
  title_en      text not null check (char_length(btrim(title_en)) between 3 and 120),
  title_ar      text not null check (char_length(btrim(title_ar)) between 3 and 120),
  body_en       text not null default '' check (char_length(body_en) <= 500),
  body_ar       text not null default '' check (char_length(body_ar) <= 500),
  severity      text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  scope         text not null check (scope in ('all', 'zones', 'clusters')),
  zone_ids      uuid[] not null default '{}',
  cluster_codes text[] not null default '{}',
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,
  notified      integer not null default 0,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  ended_at      timestamptz,
  ended_by      uuid references public.profiles (id) on delete set null,
  check (ends_at is null or ends_at > starts_at),
  check (scope <> 'zones' or cardinality(zone_ids) > 0),
  check (scope <> 'clusters' or cardinality(cluster_codes) > 0)
);
create index service_notices_live_idx on public.service_notices (starts_at desc) where ended_at is null;
alter table public.service_notices enable row level security;
revoke all on public.service_notices from public, anon, authenticated;
grant select on public.service_notices to authenticated;
create policy service_notices_staff on public.service_notices for select to authenticated using (public.is_staff());

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('service_notice', 'Service disruption notice', 'customer', '{title}', '{body} ({until})', '{title}', '{body} ({until})', true, true, true, false, 'service', false)
on conflict (event) do nothing;

create function public.notice_live(n public.service_notices)
returns boolean language sql stable
as $$ select n.ended_at is null and n.starts_at <= now() and (n.ends_at is null or n.ends_at > now()) $$;

create function public.notice_covers_zone(n public.service_notices, p_zone uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select n.scope = 'all'
      or (n.scope = 'zones' and p_zone = any(n.zone_ids))
      or (n.scope = 'clusters' and exists (select 1 from public.zones z join public.governorates g on g.code = z.governorate_code
                                            where z.id = p_zone and g.cluster_code = any(n.cluster_codes)))
$$;

-- Area names for a notice (zones or clusters), English and Arabic.
create function public.notice_areas(n public.service_notices)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case n.scope
    when 'zones' then (select jsonb_build_object('en', coalesce(jsonb_agg(z.name order by z.name), '[]'), 'ar', coalesce(jsonb_agg(z.name order by z.name), '[]'))
                         from public.zones z where z.id = any(n.zone_ids))
    when 'clusters' then (select jsonb_build_object('en', coalesce(jsonb_agg(c.name order by c.sort), '[]'), 'ar', coalesce(jsonb_agg(coalesce(c.name_ar, c.name) order by c.sort), '[]'))
                            from public.clusters c where c.code = any(n.cluster_codes))
    else jsonb_build_object('en', '[]'::jsonb, 'ar', '[]'::jsonb) end
$$;

-- Live notices for the caller: their properties (households) or their organisation's sites
-- (business), their orders of the last 90 days, and the point they are ordering for.
-- sites: the caller's property / site labels the notice covers.
create function public.my_service_notices(p_lat double precision default null, p_lng double precision default null)
returns table (id uuid, title_en text, title_ar text, body_en text, body_ar text, severity text, scope text, starts_at timestamptz, ends_at timestamptz,
               areas jsonb, sites text[])
language plpgsql stable security definer set search_path = public
as $$
declare here uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_lat is not null and p_lng is not null then here := (public.zone_at(p_lat, p_lng)).id; end if;
  return query
  with places as (
    select pp.label, (public.zone_at(pp.lat, pp.lng)).id as zone_id from public.properties pp
     where pp.customer_id = auth.uid() or (pp.org_id is not null and pp.org_id = public.my_org_id())
  ), zs as (
    select zone_id from places where zone_id is not null
    union select x.zone_id from public.orders x where x.customer_id = auth.uid() and x.zone_id is not null and x.created_at > now() - interval '90 days'
    union select here where here is not null
  )
  select n.id, n.title_en, n.title_ar, n.body_en, n.body_ar, n.severity, n.scope, n.starts_at, n.ends_at, public.notice_areas(n),
         coalesce((select array_agg(distinct pl.label order by pl.label) from places pl where n.scope <> 'all' and public.notice_covers_zone(n, pl.zone_id)), '{}')
    from public.service_notices n
   where public.notice_live(n) and (n.scope = 'all' or exists (select 1 from zs where public.notice_covers_zone(n, zs.zone_id)))
   order by case n.severity when 'critical' then 0 when 'warning' then 1 else 2 end, n.starts_at desc
   limit 5;
end $$;

-- Operators and admins post a notice; with p_notify, the customers and business admins with a
-- property or a recent order in the area get it as a message (at most 5,000 people).
create function public.staff_post_notice(p_title_en text, p_title_ar text, p_body_en text, p_body_ar text, p_severity text, p_scope text,
                                         p_zone_ids uuid[], p_clusters text[], p_starts_at timestamptz, p_ends_at timestamptz, p_notify boolean, p_reason text)
returns public.service_notices
language plpgsql security definer set search_path = public
as $$
declare n public.service_notices; r text; u record; k integer := 0; until_en text; until_ar text;
begin
  perform public.require_staff(array['operator', 'admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_severity is null or p_severity not in ('info', 'warning', 'critical') then raise exception 'invalid_value: severity'; end if;
  if p_scope is null or p_scope not in ('all', 'zones', 'clusters') then raise exception 'invalid_value: scope'; end if;
  if char_length(btrim(coalesce(p_title_en, ''))) < 3 or char_length(btrim(coalesce(p_title_ar, ''))) < 3 then raise exception 'invalid_value: title in English and Arabic'; end if;
  if p_scope = 'zones' and (coalesce(cardinality(p_zone_ids), 0) = 0 or exists (select 1 from unnest(p_zone_ids) z where not exists (select 1 from public.zones where id = z))) then
    raise exception 'invalid_value: zones';
  end if;
  if p_scope = 'clusters' and (coalesce(cardinality(p_clusters), 0) = 0 or exists (select 1 from unnest(p_clusters) c where not exists (select 1 from public.clusters where code = c))) then
    raise exception 'invalid_cluster';
  end if;
  if p_ends_at is not null and p_ends_at <= greatest(coalesce(p_starts_at, now()), now()) then raise exception 'invalid_dates'; end if;
  insert into public.service_notices (title_en, title_ar, body_en, body_ar, severity, scope, zone_ids, cluster_codes, starts_at, ends_at, created_by)
  values (btrim(p_title_en), btrim(p_title_ar), btrim(coalesce(p_body_en, '')), btrim(coalesce(p_body_ar, '')), p_severity, p_scope,
          case when p_scope = 'zones' then p_zone_ids else '{}' end, case when p_scope = 'clusters' then p_clusters else '{}' end,
          coalesce(p_starts_at, now()), p_ends_at, auth.uid())
  returning * into n;
  if coalesce(p_notify, false) then
    until_en := case when n.ends_at is null then 'until further notice' else 'until ' || to_char(n.ends_at at time zone 'Asia/Muscat', 'HH24:MI, DD/MM') end;
    until_ar := case when n.ends_at is null then 'حتى إشعار آخر' else 'حتى ' || to_char(n.ends_at at time zone 'Asia/Muscat', 'HH24:MI، DD/MM') end;
    for u in
      select distinct x.uid from (
        select pp.customer_id as uid from public.properties pp where pp.customer_id is not null and public.notice_covers_zone(n, (public.zone_at(pp.lat, pp.lng)).id)
        union select o.customer_id from public.orders o where o.created_at > now() - interval '90 days' and o.org_id is null and (n.scope = 'all' or public.notice_covers_zone(n, o.zone_id))
        union select m.id from public.profiles m join public.properties pp on pp.org_id = m.org_id
               where m.org_role = 'admin' and public.notice_covers_zone(n, (public.zone_at(pp.lat, pp.lng)).id)
      ) x join public.profiles pr on pr.id = x.uid and pr.role in ('customer', 'business')
      limit 5000
    loop
      perform public.notify(u.uid, 'service_notice', null, jsonb_build_object('title', n.title_en, 'title_ar', n.title_ar,
        'body', coalesce(nullif(n.body_en, ''), n.title_en), 'body_ar', coalesce(nullif(n.body_ar, ''), n.title_ar), 'until', until_en, 'until_ar', until_ar));
      k := k + 1;
    end loop;
    update public.service_notices set notified = k where id = n.id returning * into n;
  end if;
  perform public.write_audit('notice.post', 'service_notice', n.id::text, null, to_jsonb(n), r);
  return n;
end $$;

create function public.staff_end_notice(p_id uuid, p_reason text)
returns public.service_notices
language plpgsql security definer set search_path = public
as $$
declare b public.service_notices; a public.service_notices; r text;
begin
  perform public.require_staff(array['operator', 'admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.service_notices where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.ended_at is not null then raise exception 'invalid_state'; end if;
  update public.service_notices set ended_at = now(), ended_by = auth.uid() where id = p_id returning * into a;
  perform public.write_audit('notice.end', 'service_notice', p_id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- ===========================================================================
-- Execute rights and the schedule
-- ===========================================================================
revoke execute on function public.marketing_opt_out(text), public.quiet_hours_until(timestamptz), public.staff_set_sender_ids(text, text, text),
  public.order_eta_minutes(public.orders), public.orders_dispatch_watch(), public.order_notice_once(uuid, text, text, boolean), public.scan_delay_notices(),
  public.staff_update_comms_setting(text, jsonb, text), public.notice_live(public.service_notices), public.notice_covers_zone(public.service_notices, uuid),
  public.notice_areas(public.service_notices), public.my_service_notices(double precision, double precision),
  public.staff_post_notice(text, text, text, text, text, text, uuid[], text[], timestamptz, timestamptz, boolean, text), public.staff_end_notice(uuid, text)
from public, anon, authenticated;
grant execute on function public.staff_set_sender_ids(text, text, text), public.scan_delay_notices(), public.staff_update_comms_setting(text, jsonb, text),
  public.my_service_notices(double precision, double precision),
  public.staff_post_notice(text, text, text, text, text, text, uuid[], text[], timestamptz, timestamptz, boolean, text), public.staff_end_notice(uuid, text)
to authenticated;

select public.nama_schedule('nama-delay-notices', '*/2 * * * *', 'select public.scan_delay_notices()');
