-- Tender gaps, batch A (part 1 of 4):
--   E13 / D12 / F6  notifications become a delivery pipeline: every in-app notification
--                   also queues one message per channel (push, SMS, WhatsApp, email) in
--                   notification_outbox, in the user's language, honouring their channel
--                   preferences and consent; a pg_cron dispatcher sends them through a
--                   provider adapter (simulated today: it marks the message sent and records
--                   the provider response). Push targets come from push_tokens
--                   (register_push_token, for the phone apps). Daily jobs send permit and
--                   document expiry reminders and predictive refill reminders.
--   E18 / D14       dynamic pricing: distance (nearest station or plant → customer) and
--                   demand (open requests per online tanker in the zone) multiply the
--                   delivery fee next to peak and priority, each capped, all from
--                   pricing_rules (NWS → Settings → Pricing). Neutral by default inside the
--                   free distance and under the demand threshold, so the old prices hold.
--                   Driver earnings stay a share of the multiplied fee.
--   I6              auto-dispatch: dispatch_candidates ranks every tanker for an order with
--                   reasons; zones with auto_offer offer each request to the best tanker for
--                   offer_seconds, then the next, then leave it in the open pool.
--   D8              independent drivers (no company) get a filling-credit wallet (driver_tx)
--                   with a simulated top-up; confirm_fill deducts from it.
--   E17             one SLA rule in SQL (sla_due_at / sla_served_at / order_sla), used by
--                   the portals and by my_order_sla for households.
--
-- Simulated on purpose: no SMS, WhatsApp, FCM or email provider exists yet. Switching a
-- channel's provider to 'external' (NOTIFY setting) leaves its messages for an outside
-- worker (lib/notify, POST /api/v1/notifications/claim) — the seam for the real gateways.

-- ===========================================================================
-- Shared helpers: masking (screens never show a full destination)
-- ===========================================================================
create function public.mask_phone(p text)
returns text language sql immutable
as $$
  select case
    when nullif(btrim(coalesce(p, '')), '') is null then null
    when length(regexp_replace(p, '\D', '', 'g')) <= 4 then '••••'
    else case when btrim(p) like '+%' then '+' || left(regexp_replace(p, '\D', '', 'g'), 3) || ' ' else '' end
         || '•••• ' || right(regexp_replace(p, '\D', '', 'g'), 4)
  end
$$;

create function public.mask_email(p text)
returns text language sql immutable
as $$
  select case when p is null or position('@' in p) = 0 then null
              else left(p, 1) || '•••@' || split_part(p, '@', 2) end
$$;

-- Defaults for profiles.prefs (the apps write the same keys): channels, marketing and reminder consent.
create function public.effective_prefs(p jsonb)
returns jsonb language sql immutable
as $$ select '{"push": true, "sms": true, "whatsapp": false, "email": false, "promotions": false, "reminders": true}'::jsonb || coalesce(p, '{}'::jsonb) $$;

-- Schedule a pg_cron job when pg_cron is available (Supabase); a no-op on plain Postgres / PGlite.
create function public.nama_schedule(p_name text, p_cron text, p_command text)
returns boolean
language plpgsql
as $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then return false; end if;
  begin
    create extension if not exists pg_cron;
    execute format('select cron.unschedule(jobid) from cron.job where jobname = %L', p_name);
    execute format('select cron.schedule(%L, %L, %L)', p_name, p_cron, p_command);
    return true;
  exception when others then
    raise notice 'pg_cron not available to this role (%); schedule "%" (%) by hand: %', sqlerrm, p_name, p_cron, p_command;
    return false;
  end;
end $$;
revoke execute on function public.nama_schedule(text, text, text) from public, anon, authenticated;

-- ===========================================================================
-- E13 — templates gain email, a category (consent) and "critical" (SMS ignores opt-out)
-- ===========================================================================
alter table public.notification_templates
  add column email    boolean not null default false,
  add column category text not null default 'service' check (category in ('service', 'reminder', 'marketing')),
  add column critical boolean not null default false;
alter table public.notification_templates drop constraint notification_templates_audience_check;
alter table public.notification_templates add constraint notification_templates_audience_check
  check (audience in ('customer', 'driver', 'owner', 'business', 'staff'));

update public.notification_templates set category = 'reminder' where event in ('refill_reminder', 'permit_expiring');
update public.notification_templates set critical = true
 where event in ('tanker_assigned', 'payment_failed', 'order_cancelled', 'driver_reassigning', 'driver_delayed');

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('job_offered', 'Job offered (auto-dispatch)', 'driver', 'Job offered to you', '{order} in {area}: you earn {earnings} OMR. Accept within {seconds} s.',
   'مهمة معروضة عليك', '{order} في {area}: تربح {earnings} ر.ع. اقبلها خلال {seconds} ثانية.', true, false, false, false, 'service', false),
  ('document_expiring', 'Document expiring', 'owner', 'Document expiring', '{document} for {plate} expires on {date}. Upload a renewed copy.',
   'مستند قارب على الانتهاء', 'ينتهي {document} للصهريج {plate} في {date}. ارفع نسخة مجددة.', true, true, false, true, 'reminder', false),
  ('fill_credit_low', 'Filling credit low', 'driver', 'Filling credit low', 'Your filling credit is {balance} OMR. Top up before your next fill.',
   'رصيد التعبئة منخفض', 'رصيد التعبئة لديك {balance} ر.ع. اشحن قبل التعبئة القادمة.', true, false, false, false, 'service', false),
  ('incident_escalated', 'Incident escalated', 'staff', '{incident} {priority} escalated', '{title}: {stage} target missed ({target}). Escalated to {level}.',
   'تصعيد الحادث {incident}', '{title}: تجاوز هدف {stage} ({target}). تم التصعيد إلى {level}.', true, true, false, true, 'service', true),
  ('data_export_ready', 'Your data export is ready', 'customer', 'Your data export is ready', 'Request {request}: your personal data export is ready in the app.',
   'تصدير بياناتك جاهز', 'الطلب {request}: تصدير بياناتك الشخصية جاهز في التطبيق.', true, false, false, true, 'service', false)
on conflict (event) do nothing;

-- ===========================================================================
-- E13 — push targets for the phone apps
-- ===========================================================================
create table public.push_tokens (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  token        text not null unique check (char_length(token) between 10 and 4096),
  platform     text not null check (platform in ('android', 'ios', 'web')),
  app          text check (app in ('customer', 'driver')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);
create index push_tokens_user_idx on public.push_tokens (user_id) where revoked_at is null;

-- Called by the apps after FCM (or APNs/web push) hands them a token. A token that moves
-- to another account (shared phone, new sign-in) follows the account that registered it last.
create function public.register_push_token(p_token text, p_platform text, p_app text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare t public.push_tokens;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_platform not in ('android', 'ios', 'web') then raise exception 'invalid_platform'; end if;
  if p_app is not null and p_app not in ('customer', 'driver') then raise exception 'invalid_app'; end if;
  if p_token is null or char_length(btrim(p_token)) not between 10 and 4096 then raise exception 'invalid_token'; end if;
  insert into public.push_tokens (user_id, token, platform, app)
  values (auth.uid(), btrim(p_token), p_platform, p_app)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, app = coalesce(excluded.app, push_tokens.app),
                                    last_seen_at = now(), revoked_at = null
  returning * into t;
  return jsonb_build_object('id', t.id, 'platform', t.platform, 'app', t.app);
end $$;

-- Sign-out: stop pushing to this device.
create function public.unregister_push_token(p_token text)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  update public.push_tokens set revoked_at = now() where token = btrim(p_token) and user_id = auth.uid() and revoked_at is null;
  return found;
end $$;

-- ===========================================================================
-- E13 — the outbox: one row per message per channel
-- ===========================================================================
create table public.notification_outbox (
  id                 bigint generated always as identity primary key,
  notification_id    bigint references public.notifications (id) on delete set null,
  user_id            uuid references public.profiles (id) on delete cascade,
  event              text not null,
  channel            text not null check (channel in ('push', 'sms', 'whatsapp', 'email')),
  lang               text not null default 'en' check (lang in ('en', 'ar')),
  destination        text,            -- what the provider is given (token, E.164 number, email); never shown
  destination_masked text,            -- what screens show
  title              text not null,
  body               text not null,
  status             text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts           integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  provider           text,
  provider_ref       text,
  provider_response  jsonb,
  error              text,
  order_id           uuid references public.orders (id) on delete set null,
  is_test            boolean not null default false,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz
);
create index notification_outbox_queue_idx on public.notification_outbox (next_attempt_at) where status = 'queued';
create index notification_outbox_created_idx on public.notification_outbox (created_at desc);
create index notification_outbox_user_idx on public.notification_outbox (user_id, created_at desc);

insert into public.app_settings (key, value, notes) values
  ('NOTIFY', '{"providers": {"push": "simulated", "sms": "simulated", "whatsapp": "simulated", "email": "simulated"}, "max_attempts": 3, "sender_id": "NamaWater"}',
   'Notification delivery: provider per channel (simulated = sent by the built-in simulator; external = left for an outside worker through the integration API; off = not sent), retries, SMS sender id.')
on conflict (key) do nothing;

-- Queue one message per channel. A channel with nowhere to send to is recorded as failed,
-- so NWS sees that the user has no device, number or email.
create function public.notification_enqueue(p_notification bigint, p_user uuid, p_event text, p_channels text[], p_title text, p_body text,
                                            p_order uuid, p_lang text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  pr public.profiles; c text; dest text; n integer := 0; tk record; test boolean;
begin
  select * into pr from public.profiles where id = p_user;
  if not found then return 0; end if;
  test := coalesce((select is_test from public.orders where id = p_order), false);
  foreach c in array coalesce(p_channels, '{}') loop
    if c = 'push' then
      for tk in select token, platform from public.push_tokens where user_id = p_user and revoked_at is null order by last_seen_at desc limit 5 loop
        insert into public.notification_outbox (notification_id, user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test)
        values (p_notification, p_user, p_event, 'push', p_lang, tk.token, tk.platform || ' device ' || left(tk.token, 6) || '…', p_title, p_body, p_order, test);
        n := n + 1;
      end loop;
      if not found then
        insert into public.notification_outbox (notification_id, user_id, event, channel, lang, title, body, order_id, is_test, status, error)
        values (p_notification, p_user, p_event, 'push', p_lang, p_title, p_body, p_order, test, 'failed', 'No registered device (no push token)');
        n := n + 1;
      end if;
    elsif c in ('sms', 'whatsapp') then
      dest := coalesce(public.normalize_phone(pr.phone),
                       (select public.auth_phone_e164(u.phone) from auth.users u where u.id = p_user and u.phone is not null));
      insert into public.notification_outbox (notification_id, user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test, status, error)
      values (p_notification, p_user, p_event, c, p_lang, dest, public.mask_phone(dest), p_title, p_body, p_order, test,
              case when dest is null then 'failed' else 'queued' end, case when dest is null then 'No mobile number on the account' end);
      n := n + 1;
    elsif c = 'email' then
      dest := coalesce(pr.email, (select lower(u.email) from auth.users u where u.id = p_user and coalesce(u.email, '') <> ''));
      insert into public.notification_outbox (notification_id, user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test, status, error)
      values (p_notification, p_user, p_event, 'email', p_lang, dest, public.mask_email(dest), p_title, p_body, p_order, test,
              case when dest is null then 'failed' else 'queued' end, case when dest is null then 'No email address on the account' end);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- In-app notification as before, plus the outbox. Consent: reminders need prefs.reminders,
-- marketing needs prefs.promotions (otherwise nothing is recorded at all). Channels: the
-- template's channels that the user hasn't switched off; a critical template's SMS goes
-- out even when the user turned SMS off (order-critical messages).
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
  insert into public.notifications (user_id, event, channels, title, body, order_id)
  values (p_user, p_event, case when cardinality(ch) = 0 then array['in_app'] else ch end, t, b, p_order)
  returning id into nid;
  if cardinality(ch) > 0 then
    perform public.notification_enqueue(nid, p_user, p_event, ch, t, b, p_order, lang);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Provider adapter. Real gateways plug in here: set the channel's provider to
-- 'external' and an outside worker claims and reports messages (0028 API).
-- ---------------------------------------------------------------------------
-- The built-in simulator: accepts every message except the documented failure cases, so
-- retries and failures can be demonstrated. Numbers ending 0000 are unreachable (retried),
-- push tokens starting "invalid" are unregistered and email to @bounce.test bounces (both final).
create function public.notification_send_simulated(r public.notification_outbox)
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
    'response', jsonb_build_object('simulated', true, 'accepted', ok, 'to', r.destination_masked, 'at', now(),
                                   'segments', case when r.channel = 'sms' then ceil(char_length(r.body)::numeric / case when r.lang = 'ar' then 70 else 160 end) end,
                                   'error', err));
end $$;

-- Which adapter a channel uses: null means "an external worker sends it".
create function public.notification_send(r public.notification_outbox)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare prov text := coalesce(public.setting_json('NOTIFY') -> 'providers' ->> r.channel, 'simulated');
begin
  if prov = 'simulated' then return public.notification_send_simulated(r); end if;
  if prov = 'off' then
    return jsonb_build_object('ok', false, 'permanent', true, 'provider', 'off', 'error', 'Channel switched off in NWS settings', 'response', null);
  end if;
  return null;
end $$;

-- Record a provider's answer: sent, retried with backoff (1, 2, 4 … min), or failed for good.
create function public.outbox_record(p_id bigint, p_ok boolean, p_permanent boolean, p_provider text, p_ref text, p_response jsonb, p_error text)
returns public.notification_outbox
language plpgsql security definer set search_path = public
as $$
declare r public.notification_outbox; maxa integer := coalesce((public.setting_json('NOTIFY') ->> 'max_attempts')::integer, 3);
begin
  update public.notification_outbox
     set attempts = attempts + 1,
         provider = coalesce(p_provider, provider),
         provider_ref = case when p_ok then left(p_ref, 120) else provider_ref end,
         provider_response = p_response,
         status = case when p_ok then 'sent' when coalesce(p_permanent, false) or attempts + 1 >= maxa then 'failed' else 'queued' end,
         error = case when p_ok then null else left(coalesce(p_error, 'Provider error'), 300) end,
         sent_at = case when p_ok then now() else sent_at end,
         next_attempt_at = case when p_ok then next_attempt_at else now() + make_interval(mins => power(2, attempts)::integer) end
   where id = p_id and status = 'queued'
  returning * into r;
  if r.id is not null and not p_ok and r.channel = 'push' and coalesce(p_permanent, false) then
    update public.push_tokens set revoked_at = now() where token = r.destination and revoked_at is null;
  end if;
  return r;
end $$;

-- The dispatcher (pg_cron every minute; staff can also run it). Rows for 'external'
-- channels stay queued for the outside worker.
create function public.dispatch_notifications(p_limit integer default 500)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r public.notification_outbox; res jsonb; sent integer := 0; failed integer := 0; retry integer := 0; left_ext integer := 0; a public.notification_outbox;
begin
  if auth.uid() is not null then perform public.require_staff(array['operator']::public.staff_role[]); end if;
  for r in select o.* from public.notification_outbox o where o.status = 'queued' and o.next_attempt_at <= now()
            order by o.id limit greatest(least(coalesce(p_limit, 500), 5000), 1) for update skip locked loop
    res := public.notification_send(r);
    if res is null then left_ext := left_ext + 1; continue; end if;
    a := public.outbox_record(r.id, (res ->> 'ok')::boolean, coalesce((res ->> 'permanent')::boolean, false), res ->> 'provider', res ->> 'ref', res -> 'response', res ->> 'error');
    if a.status = 'sent' then sent := sent + 1; elsif a.status = 'failed' then failed := failed + 1; else retry := retry + 1; end if;
  end loop;
  return jsonb_build_object('sent', sent, 'failed', failed, 'retrying', retry, 'external', left_ext);
end $$;

-- Staff: retry a failed message now (it keeps its history in provider_response).
create function public.staff_notify_retry(p_id bigint)
returns public.notification_outbox
language plpgsql security definer set search_path = public
as $$
declare r public.notification_outbox;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  update public.notification_outbox set status = 'queued', next_attempt_at = now(), attempts = 0, error = null
   where id = p_id and status = 'failed' and destination is not null returning * into r;
  if r.id is null then raise exception 'not_retryable'; end if;
  perform public.write_audit('notification.retry', 'notification_outbox', p_id::text, null, jsonb_build_object('channel', r.channel), null);
  return r;
end $$;

-- Staff: a test message to themselves on one channel (proves the pipeline end to end).
create function public.staff_notify_test(p_channel text)
returns public.notification_outbox
language plpgsql security definer set search_path = public
as $$
declare nid bigint; r public.notification_outbox;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  if p_channel not in ('push', 'sms', 'whatsapp', 'email') then raise exception 'invalid_channel'; end if;
  insert into public.notifications (user_id, event, channels, title, body)
  values (auth.uid(), 'test_message', array[p_channel], 'Test message', 'Test message from NWS Settings → Notifications.') returning id into nid;
  perform public.notification_enqueue(nid, auth.uid(), 'test_message', array[p_channel], 'Test message', 'Test message from NWS Settings → Notifications.', null, 'en');
  select * into r from public.notification_outbox where notification_id = nid order by id desc limit 1;
  return r;
end $$;

-- Outbox counts for the Notifications screen (server-side; test-zone messages apart).
create function public.staff_outbox_stats(p_days integer default 7)
returns table (channel text, status text, is_test boolean, n integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select o.channel, o.status, o.is_test, count(*)::int from public.notification_outbox o
     where o.created_at >= now() - make_interval(days => greatest(least(coalesce(p_days, 7), 366), 1))
     group by 1, 2, 3;
end $$;

-- In-app notifications per event (the templates table's "sent" column).
create function public.staff_notification_counts(p_days integer default 30)
returns table (event text, n integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select x.event, count(*)::int from public.notifications x
     where x.created_at >= now() - make_interval(days => greatest(least(coalesce(p_days, 30), 366), 1)) group by 1;
end $$;

-- Template editor: email channel added.
drop function public.staff_update_template(text, boolean, boolean, boolean, text, text, text, text, text);
create function public.staff_update_template(p_event text, p_push boolean, p_sms boolean, p_whatsapp boolean, p_title_en text, p_body_en text,
                                             p_title_ar text, p_body_ar text, p_reason text, p_email boolean default null)
returns public.notification_templates
language plpgsql security definer set search_path = public
as $$
declare b public.notification_templates; a public.notification_templates; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.notification_templates where event = p_event for update;
  if not found then raise exception 'not_found'; end if;
  update public.notification_templates
     set push = p_push, sms = p_sms, whatsapp = p_whatsapp, email = coalesce(p_email, email),
         title_en = coalesce(nullif(btrim(p_title_en), ''), title_en), body_en = coalesce(nullif(btrim(p_body_en), ''), body_en),
         title_ar = coalesce(nullif(btrim(p_title_ar), ''), title_ar), body_ar = coalesce(nullif(btrim(p_body_ar), ''), body_ar)
   where event = p_event returning * into a;
  perform public.write_audit('template.update', 'notification_template', p_event, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- ===========================================================================
-- D12 / F6 — scheduled reminders, once per subject and stage
-- ===========================================================================
create table public.reminder_log (
  kind       text not null check (kind in ('permit', 'document', 'refill')),
  subject_id uuid not null,
  stage      text not null,
  sent_at    timestamptz not null default now(),
  primary key (kind, subject_id, stage)
);

-- Permits and tanker documents expiring within 30 days: reminded at 30, 14, 7 and 1 day(s)
-- before, unless a renewal is already in review. Owners get it, and the driver of an
-- independent tanker.
create function public.send_expiry_reminders()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r record; stage text; days integer; permits integer := 0; docs integer := 0;
  label constant jsonb := '{"mulkiya":"Mulkiya","tank_cleanliness":"Tank cleanliness certificate","rop_inspection":"ROP inspection","insurance":"Insurance","ivms_certificate":"IVMS certificate","heavy_licence":"Heavy vehicle licence","water_test":"Water test certificate"}';
begin
  for r in select p.*, t.plate, t.company_id from public.permits p join public.tankers t on t.id = p.tanker_id
            where p.status = 'approved' and p.expires_at > now() and p.expires_at <= now() + interval '30 days'
              and not exists (select 1 from public.permits n where n.tanker_id = p.tanker_id and n.status = 'pending') loop
    days := ceil(extract(epoch from r.expires_at - now()) / 86400)::integer;
    stage := case when days <= 1 then 'd1' when days <= 7 then 'd7' when days <= 14 then 'd14' else 'd30' end;
    insert into public.reminder_log (kind, subject_id, stage) values ('permit', r.id, stage) on conflict do nothing;
    if found then
      perform public.notify_permit(r.id, 'permit_expiring', jsonb_build_object('date', to_char(r.expires_at at time zone 'Asia/Muscat', 'DD Mon YYYY'),
                                                                                'date_ar', to_char(r.expires_at at time zone 'Asia/Muscat', 'YYYY-MM-DD')));
      if r.company_id is null then
        perform public.notify(a.driver_id, 'permit_expiring', null, jsonb_build_object('plate', r.plate, 'permit', r.permit_no,
                                'date', to_char(r.expires_at at time zone 'Asia/Muscat', 'DD Mon YYYY'), 'date_ar', to_char(r.expires_at at time zone 'Asia/Muscat', 'YYYY-MM-DD')))
           from public.tanker_assignments a where a.tanker_id = r.tanker_id and a.unassigned_at is null and a.driver_id is distinct from r.applied_by;
      end if;
      update public.permits set reminded_at = now() where id = r.id;
      permits := permits + 1;
    end if;
  end loop;

  for r in select d.*, t.plate, coalesce(t.company_id, (select company_id from public.profiles where id = d.driver_id)) as co
             from public.tanker_documents d left join public.tankers t on t.id = d.tanker_id
            where d.status = 'valid' and d.valid_to >= current_date and d.valid_to <= current_date + 30 loop
    days := r.valid_to - current_date;
    stage := case when days <= 1 then 'd1' when days <= 7 then 'd7' when days <= 14 then 'd14' else 'd30' end;
    insert into public.reminder_log (kind, subject_id, stage) values ('document', r.id, stage) on conflict do nothing;
    if found then
      perform public.notify(u.id, 'document_expiring', null, jsonb_build_object('document', coalesce(label ->> r.kind, r.kind), 'plate', coalesce(r.plate, 'your licence'),
                                                                                 'date', to_char(r.valid_to, 'DD Mon YYYY'), 'date_ar', to_char(r.valid_to, 'YYYY-MM-DD')))
         from (select pr.id from public.profiles pr where r.co is not null and pr.company_id = r.co and pr.role = 'owner'
               union select r.driver_id where r.driver_id is not null
               union select a.driver_id from public.tanker_assignments a where r.co is null and a.tanker_id = r.tanker_id and a.unassigned_at is null) u
        where u.id is not null;
      docs := docs + 1;
    end if;
  end loop;
  return jsonb_build_object('permits', permits, 'documents', docs);
end $$;

-- F6 — the usual refill interval per property: the average gap between its last (up to 8)
-- delivered drinking-water orders (same rule as the customer app's home card). Test-zone
-- orders don't count.
create function public.refill_predictions()
returns table (property_id uuid, customer_id uuid, org_id uuid, label text, deliveries integer, avg_gap_days numeric,
               last_delivered_at timestamptz, next_due_at timestamptz, gallons integer)
language sql stable security definer set search_path = public
as $$
  with d as (
    select o.property_id, o.delivered_at, o.gallons,
           row_number() over (partition by o.property_id order by o.delivered_at desc) as rn
      from public.orders o
     where o.status = 'delivered' and o.service_type = 'DW' and o.property_id is not null and o.delivered_at is not null and not o.is_test),
  s as (
    select property_id, count(*)::int as n, max(delivered_at) as last_at, min(delivered_at) as first_at,
           (array_agg(gallons order by delivered_at desc))[1] as gallons
      from d where rn <= 8 group by property_id having count(*) >= 2)
  select p.id, p.customer_id, p.org_id, p.label, s.n,
         round((extract(epoch from s.last_at - s.first_at) / (s.n - 1) / 86400)::numeric, 1),
         s.last_at, s.last_at + (s.last_at - s.first_at) / (s.n - 1), s.gallons
    from s join public.properties p on p.id = s.property_id
   where s.last_at - s.first_at >= (s.n - 1) * interval '1 day'
$$;

-- Daily: properties due within a day (and not more than two weeks overdue), with no open
-- order or active contract, get one reminder per predicted refill. notify() checks consent.
create function public.send_refill_reminders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare r record; n integer := 0; v jsonb;
begin
  for r in select x.* from public.refill_predictions() x
            where x.next_due_at <= now() + interval '1 day' and x.next_due_at > now() - interval '14 days'
              and not exists (select 1 from public.orders o where o.property_id = x.property_id
                                and o.status in ('scheduled', 'pending_approval', 'requested', 'accepted', 'arriving', 'arrived'))
              and not exists (select 1 from public.contracts k where k.property_id = x.property_id and k.status = 'active') loop
    insert into public.reminder_log (kind, subject_id, stage) values ('refill', r.property_id, to_char(r.next_due_at at time zone 'Asia/Muscat', 'YYYY-MM-DD'))
    on conflict do nothing;
    if not found then continue; end if;
    v := jsonb_build_object('property', r.label, 'days', round(r.avg_gap_days)::text, 'gallons', r.gallons::text,
                            'date', to_char(r.next_due_at at time zone 'Asia/Muscat', 'DD Mon'));
    if r.customer_id is not null then
      perform public.notify(r.customer_id, 'refill_reminder', null, v);
    else
      perform public.notify(m.id, 'refill_reminder', null, v)
         from public.profiles m where m.org_id = r.org_id and m.role = 'business' and m.org_role in ('admin', 'site_manager');
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

update public.notification_templates
   set body_en = 'Your {property} tank usually needs a refill every {days} days — next one due around {date}. Book now?',
       body_ar = 'يحتاج خزان {property} عادةً إلى تعبئة كل {days} يوماً — الموعد القادم حوالي {date}. هل تحجز الآن؟'
 where event = 'refill_reminder';

create function public.run_daily_jobs()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare out jsonb;
begin
  if auth.uid() is not null then perform public.require_staff(array['admin']::public.staff_role[]); end if;
  out := public.send_expiry_reminders() || jsonb_build_object('refill_reminders', public.send_refill_reminders());
  return out;
end $$;

-- ===========================================================================
-- E18 / D14 — distance and demand factors on the delivery fee
-- ===========================================================================
insert into public.pricing_rules (rule_key, value, status, source, notes) values
  ('distance_free_km',       '15',   'assumption', 'Prototype assumption — no tender clause', 'Distance from the nearest filling station (wastewater: treatment plant) to the customer included in the base fee (km).'),
  ('distance_per_km',        '0.02', 'assumption', 'Prototype assumption — no tender clause', 'Delivery-fee multiplier added for each km beyond distance_free_km (0.02 = +2% per km).'),
  ('distance_cap',           '1.5',  'assumption', 'Prototype assumption — no tender clause', 'Highest distance multiplier.'),
  ('demand_min_open',        '10',   'assumption', 'Prototype assumption — no tender clause', 'Demand pricing starts only when the zone has at least this many open requests for the service.'),
  ('demand_ratio_threshold', '3',    'assumption', 'Prototype assumption — no tender clause', 'Open requests per online tanker in the zone above which the demand multiplier applies.'),
  ('demand_step',            '0.1',  'assumption', 'Prototype assumption — no tender clause', 'Multiplier added per extra open request per tanker above the threshold.'),
  ('demand_cap',             '1.3',  'assumption', 'Prototype assumption — no tender clause', 'Highest demand multiplier.'),
  ('dynamic_cap',            '2.5',  'assumption', 'Prototype assumption — no tender clause', 'Cap on the combined fee multiplier (peak × priority × distance × demand).')
on conflict (rule_key) do nothing;

update public.pricing_rules set notes = 'Evening peak multiplier on the delivery fee (18:00–20:00 slots).' where rule_key = 'peak_multiplier';
update public.pricing_rules set notes = 'Priority/emergency multiplier on the delivery fee.' where rule_key = 'priority_multiplier';
update public.pricing_rules set notes = 'Monthly plan discount on the delivery fee (fraction).' where rule_key = 'discount_monthly';
update public.pricing_rules set notes = 'Yearly plan discount on the delivery fee (fraction).' where rule_key = 'discount_yearly';

-- Distance and demand multipliers for a delivery point. Test-zone points use no distance
-- factor (their sites are virtual), so test orders price like Muscat ones; demand still
-- applies within the test zone. Without a point, both factors are neutral.
create function public.price_factors(p_type public.service_type, p_lat double precision, p_lng double precision, p_zone uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  z public.zones; s public.sites; d numeric; dm numeric := 1; em numeric := 1;
  open_n integer := 0; online_n integer := 0; ratio numeric := 0;
  free_km numeric := coalesce(public.rule_num('distance_free_km'), 15);
  per_km numeric := coalesce(public.rule_num('distance_per_km'), 0);
  dcap numeric := coalesce(public.rule_num('distance_cap'), 1);
  dmin numeric := coalesce(public.rule_num('demand_min_open'), 10);
  thr numeric := coalesce(public.rule_num('demand_ratio_threshold'), 3);
  step numeric := coalesce(public.rule_num('demand_step'), 0);
  ecap numeric := coalesce(public.rule_num('demand_cap'), 1);
begin
  if p_zone is not null then select * into z from public.zones where id = p_zone; end if;
  if z.id is null and p_lat is not null and p_lng is not null then z := public.zone_at(p_lat, p_lng, true); end if;
  if p_lat is not null and p_lng is not null and not coalesce(z.is_test, false) then
    select x.* into s from public.sites x
     where x.active and not x.is_test and x.kind = case when p_type = 'WW' then 'discharge' else 'fill' end and p_type = any(x.service_types)
     order by public.km(p_lat, p_lng, x.lat, x.lng) limit 1;
    if s.id is not null then
      d := round(public.km(p_lat, p_lng, s.lat, s.lng)::numeric, 1);
      dm := round(least(greatest(1 + greatest(d - free_km, 0) * per_km, 1), greatest(dcap, 1)), 3);
    end if;
  end if;
  if z.id is not null then
    select count(*)::int into open_n from public.orders o
     where o.status = 'requested' and o.zone_id = z.id and o.service_type = p_type and o.created_at > now() - interval '3 hours';
    select count(*)::int into online_n from public.tankers t
     where t.is_online and not t.blocked and t.service_type = p_type and t.last_fix_at > now() - interval '10 minutes'
       and (public.zone_at(t.last_lat, t.last_lng, true)).id = z.id;
    ratio := round(open_n::numeric / greatest(online_n, 1), 2);
    if open_n >= dmin and ratio > thr then
      em := round(least(1 + (ratio - thr) * step, greatest(ecap, 1)), 3);
    end if;
  end if;
  return jsonb_build_object('distance_km', d, 'distance_site', s.code, 'distance_mult', dm,
                            'open_requests', open_n, 'online_tankers', online_n, 'demand_ratio', ratio, 'demand_mult', em,
                            'zone', z.name);
end $$;

-- The full price with every factor, and its breakdown. price_quote_ext keeps its old
-- signature (neutral distance and demand).
create function public.price_quote_full(p_type public.service_type, p_gallons integer, p_peak boolean, p_priority boolean, p_discount_pct numeric,
                                        p_distance_mult numeric default 1, p_demand_mult numeric default 1)
returns table (
  water_charge    numeric(10,3),
  delivery_fee    numeric(10,3),
  discount        numeric(10,3),
  vat             numeric(10,3),
  total           numeric(10,3),
  driver_earnings numeric(10,3),
  water_status    public.rule_status,
  fee_status      public.rule_status,
  vat_status      public.rule_status,
  total_status    public.rule_status,
  earnings_status public.rule_status,
  rules_used      text[],
  base_fee        numeric(10,3),
  fee_multiplier  numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare
  q record;
  mult numeric := 1;
  fs public.rule_status;
  used text[];
  vat_rate numeric := public.rule_num('vat_rate');
  share numeric := public.rule_num('driver_share');
  cap numeric := coalesce(public.rule_num('dynamic_cap'), 99);
  fee numeric;
  k text;
begin
  select * into q from public.price_quote(p_type, p_gallons);
  fs := q.fee_status;
  used := q.rules_used;
  if coalesce(p_peak, false) then
    mult := mult * public.rule_num('peak_multiplier');
    fs := public.worst_status(fs, (select status from public.pricing_rules where rule_key = 'peak_multiplier'));
    used := array_append(used, 'peak_multiplier');
  end if;
  if coalesce(p_priority, false) then
    mult := mult * public.rule_num('priority_multiplier');
    fs := public.worst_status(fs, (select status from public.pricing_rules where rule_key = 'priority_multiplier'));
    used := array_append(used, 'priority_multiplier');
  end if;
  if coalesce(p_distance_mult, 1) > 1 then
    mult := mult * p_distance_mult;
    foreach k in array array['distance_free_km', 'distance_per_km', 'distance_cap'] loop
      fs := public.worst_status(fs, (select status from public.pricing_rules where rule_key = k));
      used := array_append(used, k);
    end loop;
  end if;
  if coalesce(p_demand_mult, 1) > 1 then
    mult := mult * p_demand_mult;
    foreach k in array array['demand_min_open', 'demand_ratio_threshold', 'demand_step', 'demand_cap'] loop
      fs := public.worst_status(fs, (select status from public.pricing_rules where rule_key = k));
      used := array_append(used, k);
    end loop;
  end if;
  if mult > cap then
    mult := cap;
    fs := public.worst_status(fs, (select status from public.pricing_rules where rule_key = 'dynamic_cap'));
    used := array_append(used, 'dynamic_cap');
  end if;
  fee := round(q.delivery_fee * mult, 3);
  water_charge    := q.water_charge;
  delivery_fee    := fee;
  discount        := round(fee * greatest(least(coalesce(p_discount_pct, 0), 0.5), 0), 3);
  vat             := round((q.water_charge + fee - discount) * vat_rate, 3);
  total           := q.water_charge + fee - discount + vat;
  driver_earnings := round(fee * share, 3);
  water_status    := q.water_status;
  fee_status      := fs;
  vat_status      := public.worst_status(q.vat_status, fs);
  total_status    := public.worst_status(q.water_status, fs, q.vat_status);
  earnings_status := public.worst_status(fs, (select status from public.pricing_rules where rule_key = 'driver_share'));
  rules_used      := used;
  base_fee        := q.delivery_fee;
  fee_multiplier  := round(mult, 4);
  return next;
end $$;

create or replace function public.price_quote_ext(p_type public.service_type, p_gallons integer, p_peak boolean, p_priority boolean, p_discount_pct numeric)
returns table (
  water_charge    numeric(10,3),
  delivery_fee    numeric(10,3),
  discount        numeric(10,3),
  vat             numeric(10,3),
  total           numeric(10,3),
  driver_earnings numeric(10,3),
  water_status    public.rule_status,
  fee_status      public.rule_status,
  vat_status      public.rule_status,
  total_status    public.rule_status,
  earnings_status public.rule_status,
  rules_used      text[]
)
language sql stable security definer set search_path = public
as $$
  select f.water_charge, f.delivery_fee, f.discount, f.vat, f.total, f.driver_earnings, f.water_status, f.fee_status, f.vat_status,
         f.total_status, f.earnings_status, f.rules_used
    from public.price_quote_full(p_type, p_gallons, p_peak, p_priority, p_discount_pct, 1, 1) f
$$;

-- The pricing trigger: the delivery point comes from the order RPC (transaction-local
-- nama.pricing_point, set just before the insert), else the order's property.
create or replace function public.price_order()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  q record;
  mode text;
  bad text;
  pct numeric := public.order_discount_pct(new.promo_code, new.contract_id);
  disc_rule text;
  disc_status public.rule_status;
  used text[];
  pt text := current_setting('nama.pricing_point', true);
  plat double precision; plng double precision;
  f jsonb;
begin
  if coalesce(pt, '') ~ '^-?[0-9.]+,-?[0-9.]+$' then
    plat := split_part(pt, ',', 1)::double precision; plng := split_part(pt, ',', 2)::double precision;
  elsif new.property_id is not null then
    select p.lat, p.lng into plat, plng from public.properties p where p.id = new.property_id;
  end if;
  f := public.price_factors(new.service_type, plat, plng, new.zone_id);
  select * into q from public.price_quote_full(new.service_type, new.gallons, new.slot_peak, new.is_emergency, pct,
                                               (f ->> 'distance_mult')::numeric, (f ->> 'demand_mult')::numeric);
  used := q.rules_used;
  -- A contract discount (no promotion) comes from a pricing rule; promotions are commercial decisions.
  if pct > 0 and new.contract_id is not null and not exists (select 1 from public.promotions where code = new.promo_code) then
    disc_rule := (select case c.plan when 'yearly' then 'discount_yearly' else 'discount_monthly' end from public.contracts c where c.id = new.contract_id);
    select status into disc_status from public.pricing_rules where rule_key = disc_rule;
    used := array_append(used, disc_rule);
  end if;
  select value into mode from public.app_settings where key = 'BILLING_MODE';
  mode := coalesce(mode, 'demo');

  if mode = 'production' then
    select string_agg(format('%s (%s, %s)', p.rule_key, p.status, p.source), ', ' order by p.rule_key) into bad
      from public.pricing_rules p
     where p.rule_key = any(used) and p.status <> 'confirmed';
    if bad is not null then
      raise exception 'pricing_unconfirmed: BILLING_MODE is production and these pricing rules are not confirmed: %', bad;
    end if;
  end if;

  new.water_charge    := q.water_charge;
  new.delivery_fee    := q.delivery_fee;
  new.discount        := q.discount;
  new.vat             := q.vat;
  new.total           := q.total;
  new.driver_earnings := q.driver_earnings;
  new.price_basis := jsonb_build_object(
    'water', q.water_status,
    'fee', case when disc_status is null then q.fee_status else public.worst_status(q.fee_status, disc_status) end,
    'vat', case when disc_status is null then q.vat_status else public.worst_status(q.vat_status, disc_status) end,
    'total', case when disc_status is null then q.total_status else public.worst_status(q.total_status, disc_status) end,
    'earnings', q.earnings_status,
    'rules', to_jsonb(used), 'mode', mode,
    'factors', jsonb_build_object('base_fee', q.base_fee, 'multiplier', q.fee_multiplier,
                                  'peak', coalesce(new.slot_peak, false), 'priority', coalesce(new.is_emergency, false),
                                  'distance_km', f -> 'distance_km', 'distance_mult', f -> 'distance_mult',
                                  'demand_ratio', f -> 'demand_ratio', 'demand_mult', f -> 'demand_mult'));
  if new.slot_peak or new.is_emergency or pct > 0 then
    new.price_basis := new.price_basis || jsonb_build_object('peak', new.slot_peak, 'priority', new.is_emergency, 'discount_pct', pct);
  end if;
  return new;
end $$;

-- The order RPCs that take a pin set the pricing point for the trigger: the existing
-- bodies are kept (renamed *_core, no longer callable directly) behind thin wrappers.
alter function public.create_order(public.service_type, integer, double precision, double precision, text, text, uuid, timestamptz, timestamptz, text, boolean, text, text, text, text)
  rename to create_order_core;
revoke execute on function public.create_order_core(public.service_type, integer, double precision, double precision, text, text, uuid, timestamptz, timestamptz, text, boolean, text, text, text, text)
  from public, anon, authenticated;
create function public.create_order(
  p_service_type public.service_type,
  p_gallons      integer,
  p_lat          double precision,
  p_lng          double precision,
  p_area         text,
  p_address      text default '',
  p_property_id  uuid default null,
  p_slot_start   timestamptz default null,
  p_slot_end     timestamptz default null,
  p_slot_label   text default null,
  p_emergency    boolean default false,
  p_driver_note  text default null,
  p_pay_method   text default 'card',
  p_card_last4   text default null,
  p_promo_code   text default null
)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  perform set_config('nama.pricing_point', case when p_lat is not null and p_lng is not null then p_lat::text || ',' || p_lng::text else '' end, true);
  o := public.create_order_core(p_service_type, p_gallons, p_lat, p_lng, p_area, p_address, p_property_id, p_slot_start, p_slot_end,
                                p_slot_label, p_emergency, p_driver_note, p_pay_method, p_card_last4, p_promo_code);
  perform set_config('nama.pricing_point', '', true);
  return o;
end $$;

alter function public.staff_place_order(uuid, public.service_type, integer, double precision, double precision, text, text, text, boolean, timestamptz, timestamptz, text)
  rename to staff_place_order_core;
revoke execute on function public.staff_place_order_core(uuid, public.service_type, integer, double precision, double precision, text, text, text, boolean, timestamptz, timestamptz, text)
  from public, anon, authenticated;
create function public.staff_place_order(p_customer_id uuid, p_service_type public.service_type, p_gallons integer, p_lat double precision, p_lng double precision,
                                         p_area text, p_address text, p_genesys_id text, p_emergency boolean default false,
                                         p_slot_start timestamptz default null, p_slot_end timestamptz default null, p_slot_label text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  perform set_config('nama.pricing_point', case when p_lat is not null and p_lng is not null then p_lat::text || ',' || p_lng::text else '' end, true);
  o := public.staff_place_order_core(p_customer_id, p_service_type, p_gallons, p_lat, p_lng, p_area, p_address, p_genesys_id, p_emergency,
                                     p_slot_start, p_slot_end, p_slot_label);
  perform set_config('nama.pricing_point', '', true);
  return o;
end $$;

-- The quote shows the same breakdown the order will be priced with. Pass the pin
-- (p_lat, p_lng) for distance and demand; without it both are neutral.
drop function public.quote_order(public.service_type, integer, timestamptz, boolean, text);
create function public.quote_order(p_service_type public.service_type, p_gallons integer, p_slot_start timestamptz default null,
                                   p_emergency boolean default false, p_promo_code text default null,
                                   p_lat double precision default null, p_lng double precision default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare q record; pct numeric := 0; promo public.promotions; f jsonb;
begin
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if nullif(btrim(coalesce(p_promo_code, '')), '') is not null then
    select * into promo from public.promotions where code = upper(btrim(p_promo_code)) and active and uses < max_uses and (valid_to is null or valid_to >= current_date)
       and (audience in ('all', 'household')
            or (audience = 'new' and not exists (select 1 from public.orders where customer_id = auth.uid() and status = 'delivered')));
    if not found then raise exception 'invalid_promo'; end if;
    pct := promo.pct;
  end if;
  f := public.price_factors(p_service_type, p_lat, p_lng, null);
  select * into q from public.price_quote_full(p_service_type, p_gallons, public.is_peak(p_slot_start), coalesce(p_emergency, false), pct,
                                               (f ->> 'distance_mult')::numeric, (f ->> 'demand_mult')::numeric);
  return to_jsonb(q) || jsonb_build_object('peak', public.is_peak(p_slot_start), 'priority', coalesce(p_emergency, false), 'discount_pct', pct,
                                           'promo_label', promo.label,
                                           'factors', jsonb_build_object('base_fee', q.base_fee, 'multiplier', q.fee_multiplier,
                                                                         'peak_mult', case when public.is_peak(p_slot_start) then public.rule_num('peak_multiplier') else 1 end,
                                                                         'priority_mult', case when coalesce(p_emergency, false) then public.rule_num('priority_multiplier') else 1 end,
                                                                         'distance_km', f -> 'distance_km', 'distance_mult', f -> 'distance_mult',
                                                                         'demand_ratio', f -> 'demand_ratio', 'demand_mult', f -> 'demand_mult',
                                                                         'located', p_lat is not null and p_lng is not null));
end $$;

-- Pricing settings: bounds for the multipliers (the caps can't be set to something silly).
create or replace function public.staff_update_pricing_rule(p_rule_key text, p_value text, p_status public.rule_status, p_source text, p_reason text)
returns public.pricing_rules
language plpgsql security definer set search_path = public
as $$
declare b public.pricing_rules; a public.pricing_rules; r text; v numeric;
  bounds constant jsonb := '{"peak_multiplier": [1, 3], "priority_multiplier": [1, 3], "distance_free_km": [0, 200], "distance_per_km": [0, 0.2],
                             "distance_cap": [1, 3], "demand_min_open": [1, 1000], "demand_ratio_threshold": [0.5, 50], "demand_step": [0, 1],
                             "demand_cap": [1, 3], "dynamic_cap": [1, 5], "driver_share": [0, 1], "vat_rate": [0, 0.5],
                             "discount_monthly": [0, 0.5], "discount_yearly": [0, 0.5]}';
begin
  perform public.require_staff(array['admin', 'finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.pricing_rules where rule_key = p_rule_key for update;
  if not found then raise exception 'not_found'; end if;
  if p_rule_key = 'dw_above_650_basis' then
    if p_value not in ('slab', 'whole_volume') then raise exception 'invalid_value'; end if;
  elsif btrim(coalesce(p_value, '')) !~ '^[0-9]+(\.[0-9]+)?$' then raise exception 'invalid_value';
  elsif bounds ? p_rule_key then
    v := btrim(p_value)::numeric;
    if v < (bounds -> p_rule_key ->> 0)::numeric or v > (bounds -> p_rule_key ->> 1)::numeric then
      raise exception 'invalid_value: % must be between % and %', p_rule_key, bounds -> p_rule_key ->> 0, bounds -> p_rule_key ->> 1;
    end if;
  end if;
  update public.pricing_rules set value = btrim(p_value), status = p_status, source = coalesce(nullif(btrim(p_source), ''), source), updated_at = now()
   where rule_key = p_rule_key returning * into a;
  perform public.write_audit('pricing.update', 'pricing_rule', p_rule_key, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- ===========================================================================
-- I6 — auto-dispatch: ranking, zone auto-offer, offer rounds
-- ===========================================================================
alter table public.zones
  add column auto_offer    boolean not null default false,
  add column offer_seconds integer not null default 45 check (offer_seconds between 10 and 600);

alter table public.orders
  add column offer_state      text check (offer_state in ('offering', 'pool')),
  add column offer_tanker_id  uuid references public.tankers (id) on delete set null,
  add column offer_expires_at timestamptz,
  add column offered_tankers  uuid[] not null default '{}';
create index orders_offer_idx on public.orders (offer_expires_at) where offer_state = 'offering';

insert into public.app_settings (key, value, notes) values
  ('DISPATCH', '{"speed_kmh": 30, "max_km": 40, "weight_jobs": 6, "weight_rating": 5, "max_offers": 5}',
   'Auto-dispatch ranking: straight-line ETA at speed_kmh, candidates within max_km, minutes added per job already done today (fairness) and taken off per rating point above 4.5; offers per order before it goes to the open pool.')
on conflict (key) do nothing;

-- Every tanker of the order's service, ranked: eligible first, then by score (ETA minutes,
-- plus a fairness penalty per job today, minus a bonus for rating). Each row says why.
create function public.dispatch_rank(p_order uuid)
returns table (tanker_id uuid, plate text, driver_id uuid, driver_name text, company_name text, distance_km numeric, eta_min integer,
               jobs_today integer, rating numeric, score numeric, eligible boolean, reasons text[], blockers text[])
language plpgsql stable security definer set search_path = public
as $$
declare
  o public.orders; l public.order_locations; cfg jsonb := coalesce(public.setting_json('DISPATCH'), '{}'::jsonb);
  spd numeric := coalesce((cfg ->> 'speed_kmh')::numeric, 30);
  maxkm numeric := coalesce((cfg ->> 'max_km')::numeric, 40);
  wj numeric := coalesce((cfg ->> 'weight_jobs')::numeric, 6);
  wr numeric := coalesce((cfg ->> 'weight_rating')::numeric, 5);
  day0 timestamptz := (date_trunc('day', now() at time zone 'Asia/Muscat')) at time zone 'Asia/Muscat';
begin
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'not_found'; end if;
  select * into l from public.order_locations where order_id = p_order;
  return query
    with c as (
      select t.id, t.plate, a.driver_id as drv, p.full_name, co.name as cname, co.status as cstatus, t.company_id, t.is_online, t.blocked,
             t.capacity_gal, t.last_fix_at,
             case when t.last_lat is not null and l.lat is not null then public.km(t.last_lat, t.last_lng, l.lat, l.lng)::numeric end as dkm,
             (select count(*)::int from public.orders x where x.tanker_id = t.id and x.accepted_at >= day0 and x.status <> 'cancelled') as jobs,
             (select round(avg(x.rating)::numeric, 2) from public.orders x
               where x.driver_id = a.driver_id and x.rating is not null and x.rated_at > now() - interval '90 days') as rt,
             exists (select 1 from public.orders x where (x.tanker_id = t.id or (a.driver_id is not null and x.driver_id = a.driver_id))
                       and x.status in ('accepted', 'arriving', 'arrived', 'collected')) as busy,
             public.tanker_has_valid_permit(t.id) as permit_ok,
             public.position_is_test(t.last_lat, t.last_lng) as t_test
        from public.tankers t
        left join public.tanker_assignments a on a.tanker_id = t.id and a.unassigned_at is null
        left join public.profiles p on p.id = a.driver_id
        left join public.companies co on co.id = t.company_id
       where t.service_type = o.service_type),
    e as (
      select c.*,
             array_remove(array[
               case when not c.is_online then 'Offline' end,
               case when c.blocked then 'Blocked by NWS' end,
               case when c.drv is null then 'No driver assigned' end,
               case when not c.permit_ok then 'No valid permit' end,
               case when c.cstatus is not null and c.cstatus <> 'active' then 'Company ' || c.cstatus end,
               case when c.capacity_gal < o.gallons then format('Capacity %s gal is below %s gal', c.capacity_gal, o.gallons) end,
               case when c.busy then 'On another job' end,
               case when c.t_test <> o.is_test then case when o.is_test then 'Not in the test zone' else 'In the test zone' end end,
               case when c.last_fix_at is null or c.last_fix_at < now() - interval '10 minutes' then 'No GPS fix in the last 10 minutes' end,
               case when o.contract_id is not null and not exists (select 1 from public.contracts k where k.id = o.contract_id and k.company_id = c.company_id and k.status = 'active')
                    then 'Not the contract''s company' end,
               case when c.dkm > maxkm then format('%s km away (limit %s km)', round(c.dkm, 1), maxkm) end
             ]::text[], null) as bl
        from c)
    select e.id, e.plate, e.drv, e.full_name, e.cname, round(e.dkm, 1),
           case when e.dkm is not null then ceil(e.dkm / greatest(spd, 1) * 60)::int end,
           e.jobs, e.rt,
           round(coalesce(e.dkm / greatest(spd, 1) * 60, 999) + wj * e.jobs - wr * (coalesce(e.rt, 4.5) - 4.5), 1),
           cardinality(e.bl) = 0,
           array_remove(array[
             case when e.dkm is not null then format('%s km · ETA %s min', round(e.dkm, 1), ceil(e.dkm / greatest(spd, 1) * 60)::int) end,
             format('%s job%s today', e.jobs, case when e.jobs = 1 then '' else 's' end),
             case when e.rt is not null then format('Rating %s', to_char(e.rt, 'FM0.0')) else 'No ratings yet' end,
             case when e.capacity_gal >= o.gallons then format('%s gal tanker', e.capacity_gal) end
           ]::text[], null),
           e.bl
      from e
     order by cardinality(e.bl) = 0 desc, 10, e.plate;
end $$;

-- Staff view of the ranking (order detail, dispatch queue).
create function public.dispatch_candidates(p_order uuid, p_limit integer default 8)
returns table (tanker_id uuid, plate text, driver_id uuid, driver_name text, company_name text, distance_km numeric, eta_min integer,
               jobs_today integer, rating numeric, score numeric, eligible boolean, reasons text[], blockers text[], offered boolean)
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'not_found'; end if;
  return query
    select r.*, r.tanker_id = any(o.offered_tankers) from public.dispatch_rank(p_order) r
     limit greatest(least(coalesce(p_limit, 8), 50), 1);
end $$;

-- Offer the order to the best eligible tanker it hasn't been offered to, or put it in the
-- open pool when there is none (or after max_offers).
create function public.offer_next(p_order uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare o public.orders; z public.zones; c_tanker uuid; c_driver uuid; maxo integer := coalesce((public.setting_json('DISPATCH') ->> 'max_offers')::integer, 5);
begin
  select * into o from public.orders where id = p_order for update;
  if not found or o.status <> 'requested' then return null; end if;
  select * into z from public.zones where id = o.zone_id;
  if not coalesce(z.auto_offer, false) then return null; end if;
  if cardinality(o.offered_tankers) < maxo then
    select r.tanker_id, r.driver_id into c_tanker, c_driver from public.dispatch_rank(o.id) r
     where r.eligible and not (r.tanker_id = any(o.offered_tankers)) order by r.score limit 1;
  end if;
  if c_tanker is null then
    update public.orders set offer_state = 'pool', offer_tanker_id = null, offer_expires_at = null where id = o.id;
    return null;
  end if;
  update public.orders set offer_state = 'offering', offer_tanker_id = c_tanker, offer_expires_at = now() + make_interval(secs => z.offer_seconds),
                           offered_tankers = offered_tankers || c_tanker
   where id = o.id;
  perform public.notify(c_driver, 'job_offered', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'area', o.area,
                                                                            'earnings', to_char(o.driver_earnings, 'FM9990.000'), 'seconds', z.offer_seconds::text));
  return c_tanker;
end $$;

-- Start or advance offers in auto-offer zones (pg_cron, and lazily whenever drivers poll).
create function public.advance_offers()
returns integer
language plpgsql security definer set search_path = public
as $$
declare r record; n integer := 0;
begin
  for r in select o.id from public.orders o join public.zones z on z.id = o.zone_id
            where o.status = 'requested' and z.auto_offer
              and (o.offer_state is null or (o.offer_state = 'offering' and o.offer_expires_at <= now()))
            order by o.is_emergency desc, o.created_at
            limit 200
            for update of o skip locked loop
    perform public.offer_next(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- An order that leaves the open pool drops its offer; one that comes back (driver had a
-- problem) is offered again, skipping the tankers already tried.
create function public.orders_offer_reset()
returns trigger language plpgsql
as $$
begin
  if new.status <> 'requested' then
    new.offer_tanker_id := null; new.offer_expires_at := null;
    if new.offer_state = 'offering' then new.offer_state := null; end if;
  elsif old.status is distinct from 'requested' then
    new.offer_state := null; new.offer_tanker_id := null; new.offer_expires_at := null;
  end if;
  return new;
end $$;
create trigger orders_offer_reset before update of status on public.orders
  for each row when (new.status is distinct from old.status) execute function public.orders_offer_reset();

-- The offered driver can pass at once; the next tanker gets it.
create function public.decline_offer(p_order_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  t := public.my_tanker();
  update public.orders set offer_expires_at = now()
   where id = p_order_id and status = 'requested' and offer_state = 'offering' and offer_tanker_id = t.id;
  if not found then return false; end if;
  perform public.offer_next(p_order_id);
  return true;
end $$;

-- Zone setting (NWS → Settings → Zones).
create function public.staff_set_zone_dispatch(p_zone_id uuid, p_auto_offer boolean, p_offer_seconds integer, p_reason text)
returns public.zones
language plpgsql security definer set search_path = public
as $$
declare b public.zones; a public.zones; r text;
begin
  perform public.require_staff(array['admin', 'operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.zones where id = p_zone_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_offer_seconds is null or p_offer_seconds not between 10 and 600 then raise exception 'invalid_value: offer time must be 10–600 seconds'; end if;
  update public.zones set auto_offer = coalesce(p_auto_offer, false), offer_seconds = p_offer_seconds where id = b.id returning * into a;
  if not a.auto_offer then
    update public.orders set offer_state = null, offer_tanker_id = null, offer_expires_at = null where zone_id = a.id and status = 'requested';
  end if;
  perform public.write_audit('zone.dispatch', 'zone', a.id::text, jsonb_build_object('auto_offer', b.auto_offer, 'offer_seconds', b.offer_seconds),
                             jsonb_build_object('auto_offer', a.auto_offer, 'offer_seconds', a.offer_seconds), r);
  return a;
end $$;

-- Accept: an order on offer to another tanker can't be taken until its offer runs out.
create or replace function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare
  t public.tankers;
  o public.orders;
  v_name text;
begin
  t := public.my_tanker();
  -- Serialise with assignment changes on this tanker, then re-check the assignment.
  select * into t from public.tankers where id = t.id for update;
  if public.my_tanker_id() is distinct from t.id then raise exception 'no_tanker'; end if;
  if t.blocked then raise exception 'tanker_blocked: %', coalesce(t.blocked_reason, 'blocked by NWS'); end if;
  if not public.tanker_company_active(t.id) then raise exception 'company_suspended'; end if;
  if not public.tanker_has_valid_permit(t.id) then raise exception 'permit_invalid'; end if;
  if not t.is_online then raise exception 'driver_offline'; end if;

  if exists (select 1 from public.orders
             where (driver_id = auth.uid() or tanker_id = t.id) and status in ('accepted', 'arriving', 'arrived', 'collected')) then
    raise exception 'driver_busy';
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  begin
    update public.orders
       set status = 'accepted',
           driver_id = auth.uid(),
           tanker_id = t.id,
           accepted_at = now(),
           driver_name = nullif(v_name, ''),
           tanker_plate = t.plate
     where id = p_order_id
       and status = 'requested'
       and service_type = t.service_type
       and gallons <= t.capacity_gal
       and (contract_id is null or exists (select 1 from public.contracts k where k.id = contract_id and k.company_id = t.company_id and k.status = 'active'))
       and (offer_state is distinct from 'offering' or offer_tanker_id = t.id or offer_expires_at <= now())
    returning * into o;
  exception when unique_violation then
    raise exception 'driver_busy';
  end;

  if not found then
    if exists (select 1 from public.orders where id = p_order_id and status = 'requested' and offer_state = 'offering'
                 and offer_tanker_id is distinct from t.id and offer_expires_at > now()) then
      raise exception 'offered_to_another_tanker';
    end if;
    if exists (select 1 from public.orders where id = p_order_id and status = 'requested') then
      raise exception 'not_eligible';
    end if;
    raise exception 'already_taken';
  end if;
  return o;
end $$;

-- Open requests: hide orders on offer to someone else; show the caller's own offer with
-- its deadline, and the fee multipliers behind the earnings.
drop function public.open_requests_near(double precision, double precision);
create function public.open_requests_near(p_lat double precision, p_lng double precision)
returns table (
  id               uuid,
  order_no         bigint,
  service_type     public.service_type,
  gallons          integer,
  area             text,
  distance_km      numeric,
  driver_earnings  numeric(10,3),
  earnings_status  text,
  created_at       timestamptz,
  is_emergency     boolean,
  slot_label       text,
  slot_end         timestamptz,
  channel          text,
  contract_no      bigint,
  is_test          boolean,
  offer_expires_at timestamptz,
  fee_factors      jsonb
)
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; side boolean;
begin
  t := public.my_tanker();
  perform public.release_due_orders();
  perform public.advance_offers();
  if not t.is_online or t.blocked or not public.tanker_company_active(t.id) or not public.tanker_has_valid_permit(t.id) then return; end if;
  side := public.position_is_test(p_lat, p_lng);

  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
           round(public.km(p_lat, p_lng, l.lat, l.lng)::numeric, 1) as distance_km,
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at, o.is_emergency, o.slot_label, o.slot_end, o.channel,
           k.contract_no, o.is_test,
           case when o.offer_state = 'offering' and o.offer_tanker_id = t.id then o.offer_expires_at end,
           (o.price_basis -> 'factors') - 'distance_km'
      from public.orders o
      join public.order_locations l on l.order_id = o.id
      left join public.contracts k on k.id = o.contract_id
     where o.status = 'requested'
       and o.is_test = side
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
       and (o.contract_id is null or (k.company_id = t.company_id and k.status = 'active'))
       and (o.offer_state is distinct from 'offering' or o.offer_tanker_id = t.id or o.offer_expires_at <= now())
     order by coalesce(o.offer_state = 'offering' and o.offer_tanker_id = t.id, false) desc, o.is_emergency desc, 6, o.created_at
     limit 50;
end $$;

-- ===========================================================================
-- D8 — filling credit for independent drivers (no company)
-- ===========================================================================
create table public.driver_tx (
  id         bigint generated always as identity primary key,
  driver_id  uuid not null references public.profiles (id) on delete cascade,
  tanker_id  uuid references public.tankers (id) on delete set null,
  kind       text not null check (kind in ('fill_topup', 'fill_charge', 'fill_refund', 'adjustment')),
  amount     numeric(12,3) not null,
  order_id   uuid references public.orders (id) on delete set null,
  method     text check (method in ('card', 'bank_transfer', 'staff')),
  card_last4 text check (card_last4 ~ '^[0-9]{4}$'),
  gateway_ref text,
  memo       text not null default '',
  created_at timestamptz not null default now()
);
create index driver_tx_driver_idx on public.driver_tx (driver_id, created_at desc);
create unique index driver_tx_one_fill_charge on public.driver_tx (order_id) where kind = 'fill_charge';

insert into public.app_settings (key, value, notes) values
  ('FILL_CREDIT', '{"block_when_insufficient": true, "low_balance_omr": 5, "min_topup_omr": 5, "max_topup_omr": 2000}',
   'Prepaid filling credit for independent drivers: whether a fill is refused without enough credit, the low-balance alert and top-up limits. Test-zone fills are not charged.')
on conflict (key) do nothing;

create function public.driver_fill_balance(p_driver uuid)
returns numeric language sql stable security definer set search_path = public
as $$ select coalesce(sum(amount), 0)::numeric(12,3) from public.driver_tx where driver_id = p_driver $$;

create function public.lock_driver_credit(p_driver uuid)
returns void language sql
as $$ select pg_advisory_xact_lock(hashtext('nama.fill_credit:' || p_driver::text)) $$;

-- The caller's filling credit: balance, whether it applies (independent drivers only) and the latest movements.
create function public.my_fill_credit()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare me public.profiles; cfg jsonb := coalesce(public.setting_json('FILL_CREDIT'), '{}'::jsonb);
begin
  select * into me from public.profiles where id = auth.uid();
  if me.role is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  return jsonb_build_object(
    'independent', me.company_id is null,
    'balance', public.driver_fill_balance(me.id),
    'low_balance', (cfg ->> 'low_balance_omr')::numeric,
    'min_topup', (cfg ->> 'min_topup_omr')::numeric,
    'max_topup', (cfg ->> 'max_topup_omr')::numeric,
    'required', coalesce((cfg ->> 'block_when_insufficient')::boolean, true),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'amount', x.amount, 'memo', x.memo, 'created_at', x.created_at) order by x.id desc)
                          from (select * from public.driver_tx where driver_id = me.id order by id desc limit 20) x), '[]'::jsonb));
end $$;

-- Simulated card top-up (card ending 0002 is declined, as at checkout).
create function public.driver_topup_fill_credit(p_amount numeric, p_card_last4 text default '4417')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me public.profiles; cfg jsonb := coalesce(public.setting_json('FILL_CREDIT'), '{}'::jsonb); amt numeric := round(coalesce(p_amount, 0), 3);
begin
  select * into me from public.profiles where id = auth.uid();
  if me.role is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  if me.company_id is not null then raise exception 'company_driver: your company tops up filling credit from the company portal'; end if;
  if amt < coalesce((cfg ->> 'min_topup_omr')::numeric, 5) or amt > coalesce((cfg ->> 'max_topup_omr')::numeric, 2000) then raise exception 'invalid_amount'; end if;
  if coalesce(p_card_last4, '') !~ '^[0-9]{4}$' then raise exception 'invalid_card'; end if;
  if p_card_last4 = '0002' then raise exception 'card_declined: card declined by issuer (simulated)'; end if;
  perform public.lock_driver_credit(me.id);
  insert into public.driver_tx (driver_id, tanker_id, kind, amount, method, card_last4, gateway_ref, memo)
  values (me.id, public.my_tanker_id(), 'fill_topup', amt, 'card', p_card_last4, 'SIM-FC-' || to_char(now(), 'YYMMDDHH24MISS'), 'Filling credit top-up (card, simulated)');
  return public.my_fill_credit();
end $$;

-- confirm_fill: company tankers draw on the company's filling credit (as before);
-- independent drivers on their own, refused when it doesn't cover the water.
create or replace function public.confirm_fill(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; s public.sites; d double precision; ok boolean; co uuid; bal numeric;
  cfg jsonb := coalesce(public.setting_json('FILL_CREDIT'), '{}'::jsonb);
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() and tanker_id = t.id for update;
  if not found then raise exception 'not_found'; end if;
  if o.service_type = 'WW' then raise exception 'no_fill_for_wastewater'; end if;
  if o.status not in ('accepted', 'arriving') then raise exception 'invalid_transition'; end if;
  if o.filled_at is not null then raise exception 'already_filled'; end if;
  co := t.company_id;
  if co is null and not o.is_test then
    perform public.lock_driver_credit(auth.uid());
    bal := public.driver_fill_balance(auth.uid());
    if bal < o.water_charge and coalesce((cfg ->> 'block_when_insufficient')::boolean, true) then
      raise exception 'insufficient_fill_credit: balance % OMR, this fill needs % OMR', to_char(bal, 'FM99990.000'), to_char(o.water_charge, 'FM99990.000');
    end if;
  end if;
  if o.is_test then
    select x.* into s from public.sites x where x.kind = 'fill' and x.is_test and o.service_type = any(x.service_types) limit 1;
    if s.id is null then raise exception 'no_fill_station'; end if;
    ok := true;
  else
    select x.* into s from public.sites x where x.kind = 'fill' and x.active and not x.is_test and o.service_type = any(x.service_types)
     order by public.km(coalesce(t.last_lat, 0), coalesce(t.last_lng, 0), x.lat, x.lng) limit 1;
    if s.id is null then raise exception 'no_fill_station'; end if;
    d := case when t.last_lat is null then null else public.km(t.last_lat, t.last_lng, s.lat, s.lng) * 1000 end;
    ok := d is not null and d <= s.radius_m and t.last_fix_at > now() - interval '5 minutes';
  end if;
  insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, lat, lng, verified, note)
  values (o.id, t.id, 'tfs', 'fill', s.id, o.gallons, t.last_lat, t.last_lng, ok,
          case when o.is_test then 'Test zone: filling accepted at the tanker''s position'
               when ok then 'Station meter matches order volume'
               else format('Tanker %s m from %s geofence (radius %s m)', coalesce(round(d)::text, 'unknown'), s.name, s.radius_m) end);
  update public.orders set filled_at = now(), fill_site_id = s.id, fill_meter_gal = o.gallons, fill_verified = ok where id = o.id returning * into o;
  if co is not null then
    insert into public.company_tx (company_id, driver_id, tanker_id, bucket, kind, amount, order_id, memo)
    values (co, auth.uid(), t.id, 'fill_credit', 'fill_charge', -o.water_charge, o.id, 'Filling at ' || s.name || ' for TO-' || o.order_no);
  elsif not o.is_test and o.water_charge > 0 then
    insert into public.driver_tx (driver_id, tanker_id, kind, amount, order_id, memo)
    values (auth.uid(), t.id, 'fill_charge', -o.water_charge, o.id, 'Filling at ' || s.name || ' for TO-' || o.order_no);
    bal := public.driver_fill_balance(auth.uid());
    if bal < coalesce((cfg ->> 'low_balance_omr')::numeric, 5) then
      perform public.notify(auth.uid(), 'fill_credit_low', o.id, jsonb_build_object('balance', to_char(bal, 'FM99990.000')));
    end if;
  end if;
  if not ok then
    perform public.raise_alert(t.id, o.id, 'Filling outside designated station', 'med',
                               format('%s confirmed filling for TO-%s outside %s geofence', t.plate, o.order_no, s.name), t.last_lat, t.last_lng, 'fill:' || o.id);
  end if;
  return o;
end $$;

-- NWS finance: every independent driver's filling credit.
create function public.staff_driver_fill_credit()
returns table (driver_id uuid, full_name text, plate text, balance numeric, topups numeric, charges numeric, last_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_staff(array['finance', 'operator', 'viewer']::public.staff_role[]);
  return query
    select p.id, p.full_name, (select t.plate from public.tanker_assignments a join public.tankers t on t.id = a.tanker_id
                                 where a.driver_id = p.id and a.unassigned_at is null limit 1),
           coalesce(sum(x.amount), 0)::numeric(12,3),
           coalesce(sum(x.amount) filter (where x.kind = 'fill_topup'), 0)::numeric(12,3),
           coalesce(-sum(x.amount) filter (where x.kind = 'fill_charge'), 0)::numeric(12,3),
           max(x.created_at)
      from public.profiles p left join public.driver_tx x on x.driver_id = p.id
     where p.role = 'driver' and (p.company_id is null or x.id is not null)
     group by p.id, p.full_name
     order by 4, 2;
end $$;

-- ===========================================================================
-- E17 — one SLA rule (the portals and lib/sla.ts follow it)
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('SLA', '{"asap_minutes": 120, "target_pct": 0.92}',
   'Customer SLA: an order is on time when it is delivered (wastewater: collected) by the end of its slot, or within asap_minutes of release (scheduled) or placement. target_pct is the on-time target.')
on conflict (key) do nothing;

-- Deadline: slot end, else release (or placement) + asap_minutes.
create function public.sla_due_at(o public.orders)
returns timestamptz language sql stable security definer set search_path = public
as $$ select coalesce(o.slot_end, coalesce(o.released_at, o.created_at) + make_interval(mins => coalesce((public.setting_json('SLA') ->> 'asap_minutes')::integer, 120))) $$;

-- Done: collected for wastewater, delivered otherwise.
create function public.sla_served_at(o public.orders)
returns timestamptz language sql immutable
as $$ select case when o.service_type = 'WW' then coalesce(o.collected_at, o.delivered_at) else o.delivered_at end $$;

-- on_time | late (served) · on_track | at_risk | overdue (open) · cancelled | not_started.
create function public.sla_state(o public.orders)
returns text language sql stable security definer set search_path = public
as $$
  select case
    when o.status = 'cancelled' then 'cancelled'
    when public.sla_served_at(o) is not null then case when public.sla_served_at(o) <= public.sla_due_at(o) then 'on_time' else 'late' end
    when o.status in ('scheduled', 'pending_approval') then 'not_started'
    when now() > public.sla_due_at(o) then 'overdue'
    when now() > public.sla_due_at(o) - interval '20 minutes' then 'at_risk'
    else 'on_track' end
$$;

create function public.order_sla_json(o public.orders)
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('order_id', o.id, 'due_at', public.sla_due_at(o), 'served_at', public.sla_served_at(o), 'state', public.sla_state(o),
                            'basis', case when o.slot_end is not null then 'slot' else 'asap' end,
                            'asap_minutes', coalesce((public.setting_json('SLA') ->> 'asap_minutes')::integer, 120),
                            'minutes_late', case when public.sla_served_at(o) is not null and public.sla_served_at(o) > public.sla_due_at(o)
                                                 then ceil(extract(epoch from public.sla_served_at(o) - public.sla_due_at(o)) / 60)::int
                                                 when public.sla_served_at(o) is null and o.status <> 'cancelled' and now() > public.sla_due_at(o)
                                                 then ceil(extract(epoch from now() - public.sla_due_at(o)) / 60)::int else 0 end)
$$;

-- For the customer apps (households), the driver, the owner, business members and staff.
create function public.my_order_sla(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or not (public.is_staff() or public.can_see_order(o.id)) then raise exception 'not_found'; end if;
  return public.order_sla_json(o);
end $$;

-- ===========================================================================
-- Settings: the new keys are editable (admin), each validated
-- ===========================================================================
create or replace function public.staff_update_setting(p_key text, p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text; c text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_key not in ('PRIVACY', 'LOYALTY', 'NOTIFY', 'DISPATCH', 'FILL_CREDIT', 'SLA') then raise exception 'invalid_setting'; end if;
  if p_key = 'LOYALTY' and not (coalesce((p_value ->> 'points_per_omr')::numeric, 0) > 0 and coalesce((p_value ->> 'redeem_points')::numeric, 0) >= 1
                                and coalesce((p_value ->> 'redeem_omr')::numeric, 0) > 0) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'PRIVACY' and not (p_value ?& array['mask_phone', 'mask_address', 'retention_gps_days', 'retention_orders_years', 'usage_data_default']) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'NOTIFY' then
    if jsonb_typeof(p_value -> 'providers') <> 'object' or coalesce((p_value ->> 'max_attempts')::integer, 0) not between 1 and 10 then raise exception 'invalid_value'; end if;
    foreach c in array array['push', 'sms', 'whatsapp', 'email'] loop
      if coalesce(p_value -> 'providers' ->> c, '') not in ('simulated', 'external', 'off') then raise exception 'invalid_value: provider for % must be simulated, external or off', c; end if;
    end loop;
  end if;
  if p_key = 'DISPATCH' and not (coalesce((p_value ->> 'speed_kmh')::numeric, 0) between 5 and 120 and coalesce((p_value ->> 'max_km')::numeric, 0) between 1 and 500
                                 and coalesce((p_value ->> 'weight_jobs')::numeric, -1) between 0 and 120 and coalesce((p_value ->> 'weight_rating')::numeric, -1) between 0 and 120
                                 and coalesce((p_value ->> 'max_offers')::integer, 0) between 1 and 20) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'FILL_CREDIT' and not (jsonb_typeof(p_value -> 'block_when_insufficient') = 'boolean' and coalesce((p_value ->> 'low_balance_omr')::numeric, -1) >= 0
                                    and coalesce((p_value ->> 'min_topup_omr')::numeric, 0) >= 1
                                    and coalesce((p_value ->> 'max_topup_omr')::numeric, 0) >= coalesce((p_value ->> 'min_topup_omr')::numeric, 0)) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'SLA' and not (coalesce((p_value ->> 'asap_minutes')::integer, 0) between 15 and 1440 and coalesce((p_value ->> 'target_pct')::numeric, 0) between 0.5 and 1) then
    raise exception 'invalid_value';
  end if;
  b := public.setting_json(p_key);
  update public.app_settings set value = p_value::text where key = p_key;
  perform public.write_audit('setting.update', 'setting', p_key, b, p_value, r);
  return p_value;
end $$;

-- ===========================================================================
-- Access: tables, policies, execute rights, schedules
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['push_tokens', 'notification_outbox', 'reminder_log', 'driver_tx'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select on public.push_tokens, public.reminder_log, public.driver_tx to authenticated;
-- The raw destination stays in the database (providers only); screens get the masked one.
grant select (id, notification_id, user_id, event, channel, lang, destination_masked, title, body, status, attempts, next_attempt_at,
              provider, provider_ref, provider_response, error, order_id, is_test, created_at, sent_at) on public.notification_outbox to authenticated;

create policy push_tokens_own   on public.push_tokens         for select to authenticated using (user_id = auth.uid());
create policy push_tokens_staff on public.push_tokens         for select to authenticated using (public.my_staff_role() in ('admin', 'operator'));
create policy outbox_staff      on public.notification_outbox for select to authenticated using (public.my_staff_role() in ('admin', 'operator', 'complaints_agent'));
create policy reminder_log_staff on public.reminder_log       for select to authenticated using (public.is_staff());
create policy driver_tx_own     on public.driver_tx           for select to authenticated using (driver_id = auth.uid());
create policy driver_tx_staff   on public.driver_tx           for select to authenticated using (public.is_staff());

revoke execute on function
  public.mask_phone(text), public.mask_email(text), public.effective_prefs(jsonb),
  public.notification_enqueue(bigint, uuid, text, text[], text, text, uuid, text),
  public.notification_send_simulated(public.notification_outbox), public.notification_send(public.notification_outbox),
  public.outbox_record(bigint, boolean, boolean, text, text, jsonb, text),
  public.send_expiry_reminders(), public.refill_predictions(), public.send_refill_reminders(),
  public.price_factors(public.service_type, double precision, double precision, uuid),
  public.price_quote_full(public.service_type, integer, boolean, boolean, numeric, numeric, numeric),
  public.dispatch_rank(uuid), public.offer_next(uuid), public.advance_offers(), public.orders_offer_reset(),
  public.driver_fill_balance(uuid), public.lock_driver_credit(uuid),
  public.sla_due_at(public.orders), public.sla_served_at(public.orders), public.sla_state(public.orders), public.order_sla_json(public.orders)
from public, anon, authenticated;
grant execute on function public.mask_phone(text), public.mask_email(text), public.effective_prefs(jsonb),
  public.sla_due_at(public.orders), public.sla_served_at(public.orders), public.sla_state(public.orders) to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'register_push_token(text, text, text)', 'unregister_push_token(text)',
    'dispatch_notifications(integer)', 'staff_notify_retry(bigint)', 'staff_notification_counts(integer)', 'staff_notify_test(text)', 'staff_outbox_stats(integer)',
    'staff_update_template(text, boolean, boolean, boolean, text, text, text, text, text, boolean)', 'run_daily_jobs()',
    'create_order(public.service_type, integer, double precision, double precision, text, text, uuid, timestamptz, timestamptz, text, boolean, text, text, text, text)',
    'staff_place_order(uuid, public.service_type, integer, double precision, double precision, text, text, text, boolean, timestamptz, timestamptz, text)',
    'quote_order(public.service_type, integer, timestamptz, boolean, text, double precision, double precision)',
    'staff_update_pricing_rule(text, text, public.rule_status, text, text)',
    'dispatch_candidates(uuid, integer)', 'decline_offer(uuid)', 'staff_set_zone_dispatch(uuid, boolean, integer, text)',
    'accept_order(uuid)', 'open_requests_near(double precision, double precision)',
    'my_fill_credit()', 'driver_topup_fill_credit(numeric, text)', 'confirm_fill(uuid)', 'staff_driver_fill_credit()',
    'my_order_sla(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Dispatcher and offers every minute (offers also advance whenever a driver polls);
-- reminders daily at 09:00 Muscat (05:00 UTC).
select public.nama_schedule('nama-notify-dispatch', '* * * * *', 'select public.dispatch_notifications()');
select public.nama_schedule('nama-advance-offers', '* * * * *', 'select public.advance_offers()');
select public.nama_schedule('nama-daily-reminders', '0 5 * * *', 'select public.run_daily_jobs()');
