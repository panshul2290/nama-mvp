-- Tender gaps, batch A (part 3 of 4):
--   J6     incident matrix at the tender's values (P1 15 min / 2 h, P2 1 h / 4 h, P3 4 h /
--          1 working day, P4 1 / 2 working days; working days Sun–Thu, Muscat), penalties
--          of 3/3/2/2 % of the monthly invoice per breach (shown, not charged), escalation
--          thresholds that notify staff through the notification pipeline (0026), and breach
--          flags (incident_status) for Settings → System health.
--   C1/C5  IVMS feed: devices registered per tanker take fixes (device id, plate, position,
--          accuracy, speed, heading, time, ignition) through the integration API with a
--          per-integration key; every fix records its source (phone, simulated or IVMS —
--          gps_fixes.source is added by 0030) and tankers keep the last fix's source.
--          Phone fixes worse than 10 m are flagged "low accuracy" (still accepted up to
--          100 m); fill and discharge evidence is graded, IVMS-grade only at ±10 m. A
--          built-in IVMS simulator, started by NWS staff for chosen tankers, moves them
--          along a route through the same ingestion path.
--   G11/A6 versioned integration API (/api/v1, Next.js route handlers → the api_v1_* RPCs
--          below): API keys per integration (only a SHA-256 hash is stored), scopes, a
--          per-minute rate limit and a request log; orders, tankers and permits (read),
--          permit status updates (TAS), fill/discharge events (TFS/STP), IVMS fixes and the
--          notification gateway seam (0026 outbox). Outgoing webhooks for order and permit
--          events, signed with HMAC-SHA256, retried with backoff (pg_net on Supabase; a
--          simulated receiver otherwise). Spec: docs/api/openapi.yaml.

-- ===========================================================================
-- J6 — incident matrix with working days, penalties and escalation
-- ===========================================================================
alter table public.incident_targets
  add column response_wd  integer,                 -- working days (null: minutes apply)
  add column resolve_wd   integer,
  add column penalty_pct  numeric(4,2) not null default 0,
  add column escalate_pct integer[] not null default '{50,100}';

update public.incident_targets set label = 'Critical — service down',   response_min = 15,  resolve_min = 120, response_wd = null, resolve_wd = null, penalty_pct = 3 where priority = 'P1';
update public.incident_targets set label = 'High — major degradation',  response_min = 60,  resolve_min = 240, response_wd = null, resolve_wd = null, penalty_pct = 3 where priority = 'P2';
update public.incident_targets set label = 'Medium — partial impact',   response_min = 240, resolve_min = 480, response_wd = null, resolve_wd = 1,    penalty_pct = 2 where priority = 'P3';
update public.incident_targets set label = 'Low — minor / cosmetic',    response_min = 480, resolve_min = 960, response_wd = 1,    resolve_wd = 2,    penalty_pct = 2 where priority = 'P4';
comment on column public.incident_targets.resolve_min is 'Minutes; ignored when resolve_wd (working days, Sun–Thu Muscat) is set.';

-- Add n working days (Sunday–Thursday, Asia/Muscat). A start on Friday or Saturday counts
-- from the start of the next Sunday.
create function public.add_working_days(p_at timestamptz, p_days integer)
returns timestamptz
language plpgsql stable
as $$
declare t timestamp := p_at at time zone 'Asia/Muscat'; n integer := 0;
begin
  while extract(dow from t) in (5, 6) loop t := date_trunc('day', t) + interval '1 day'; end loop;
  while n < p_days loop
    t := t + interval '1 day';
    if extract(dow from t) not in (5, 6) then n := n + 1; end if;
  end loop;
  return t at time zone 'Asia/Muscat';
end $$;

create function public.incident_due(p_opened timestamptz, p_minutes integer, p_wd integer)
returns timestamptz language sql stable
as $$ select case when p_wd is not null then public.add_working_days(p_opened, p_wd) else p_opened + make_interval(mins => p_minutes) end $$;

create table public.incident_escalations (
  incident_id uuid not null references public.incidents (id) on delete cascade,
  stage       text not null check (stage in ('response', 'resolution')),
  level       integer not null,
  at          timestamptz not null default now(),
  primary key (incident_id, stage, level)
);

-- Each incident with its deadlines and breach flags.
create function public.incident_status()
returns table (id uuid, inc_no bigint, priority text, title text, system text, state text, opened_at timestamptz, acknowledged_at timestamptz, resolved_at timestamptz,
               response_due timestamptz, resolve_due timestamptz, response_breached boolean, resolve_breached boolean, penalty_pct numeric, escalation_level integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select i.id, i.inc_no, i.priority, i.title, i.system, i.state, i.opened_at, i.acknowledged_at, i.resolved_at,
           public.incident_due(i.opened_at, t.response_min, t.response_wd), public.incident_due(i.opened_at, t.resolve_min, t.resolve_wd),
           coalesce(i.acknowledged_at, now()) > public.incident_due(i.opened_at, t.response_min, t.response_wd),
           coalesce(i.resolved_at, now()) > public.incident_due(i.opened_at, t.resolve_min, t.resolve_wd),
           t.penalty_pct,
           coalesce((select max(e.level) from public.incident_escalations e where e.incident_id = i.id), 0)
      from public.incidents i join public.incident_targets t on t.priority = i.priority
     order by i.opened_at desc;
end $$;

-- Escalation: when an open incident has used a threshold share of its response or
-- resolution target (50 %, 100 % by default), notify the next level once.
--   level 1: control-room operators · level 2: Super admins
create function public.incident_scan()
returns integer
language plpgsql security definer set search_path = public
as $$
declare r record; due timestamptz; used numeric; lvl integer; pct integer; n integer := 0; stage text; tgt text;
begin
  for r in select i.*, t.response_min, t.response_wd, t.resolve_min, t.resolve_wd, t.escalate_pct from public.incidents i
             join public.incident_targets t on t.priority = i.priority where i.state <> 'resolved' loop
    foreach stage in array array['response', 'resolution'] loop
      continue when stage = 'response' and r.acknowledged_at is not null;
      due := case when stage = 'response' then public.incident_due(r.opened_at, r.response_min, r.response_wd) else public.incident_due(r.opened_at, r.resolve_min, r.resolve_wd) end;
      used := extract(epoch from now() - r.opened_at) / greatest(extract(epoch from due - r.opened_at), 1) * 100;
      lvl := 0;
      foreach pct in array r.escalate_pct loop
        lvl := lvl + 1;
        continue when used < pct;
        insert into public.incident_escalations (incident_id, stage, level) values (r.id, stage, lvl) on conflict do nothing;
        if found then
          tgt := case when stage = 'response' then coalesce(r.response_wd::text || ' working day(s)', r.response_min || ' min') else coalesce(r.resolve_wd::text || ' working day(s)', r.resolve_min || ' min') end;
          perform public.notify(p.id, 'incident_escalated', null,
                                jsonb_build_object('incident', 'INC-' || r.inc_no, 'priority', r.priority, 'title', r.title,
                                                   'stage', case when pct >= 100 then stage || ' (breached)' else stage || ' (' || pct || '% used)' end,
                                                   'stage_ar', case when stage = 'response' then 'الاستجابة' else 'الحل' end,
                                                   'target', tgt, 'level', case when lvl >= 2 then 'Super admins' else 'Control room' end,
                                                   'level_ar', case when lvl >= 2 then 'المشرفين' else 'غرفة التحكم' end))
             from public.profiles p
            where p.role = 'nws_staff' and p.staff_role = case when lvl >= 2 then 'admin'::public.staff_role else 'operator'::public.staff_role end;
          n := n + 1;
        end if;
      end loop;
    end loop;
  end loop;
  return n;
end $$;

-- ===========================================================================
-- G11 — API keys, scopes, rate limit, request log
-- ===========================================================================
create table public.api_keys (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 3 and 80),
  integration    text references public.integrations (key) on delete set null,
  prefix         text not null unique,      -- first characters, shown to identify the key
  key_hash       text not null unique,      -- sha256(key), hex; the key itself is never stored
  scopes         text[] not null,
  rate_per_min   integer not null default 120 check (rate_per_min between 1 and 10000),
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

create table public.api_requests (
  id         bigint generated always as identity primary key,
  key_id     uuid references public.api_keys (id) on delete set null,
  method     text not null,
  path       text not null,
  status     integer not null,
  rows       integer,
  error      text,
  at         timestamptz not null default now()
);
create index api_requests_key_idx on public.api_requests (key_id, at desc);
create index api_requests_at_idx on public.api_requests (at desc);

create function public.api_scopes()
returns text[] language sql immutable
as $$ select array['orders:read', 'tankers:read', 'permits:read', 'permits:write', 'events:write', 'ivms:write', 'reports:read', 'notify:send'] $$;

-- Staff: create a key. The full key is returned once and never again.
create function public.staff_create_api_key(p_name text, p_scopes text[], p_rate_per_min integer default 120, p_integration text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare raw text; k public.api_keys;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  if p_scopes is null or cardinality(p_scopes) = 0 or not (p_scopes <@ public.api_scopes()) then raise exception 'invalid_value: unknown scope'; end if;
  raw := 'nama_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (name, integration, prefix, key_hash, scopes, rate_per_min, created_by)
  values (btrim(p_name), p_integration, left(raw, 18), encode(extensions.digest(raw, 'sha256'), 'hex'), p_scopes, coalesce(p_rate_per_min, 120), auth.uid())
  returning * into k;
  perform public.write_audit('api_key.create', 'api_key', k.id::text, null, jsonb_build_object('name', k.name, 'scopes', k.scopes, 'prefix', k.prefix), null);
  return jsonb_build_object('id', k.id, 'key', raw, 'prefix', k.prefix, 'scopes', k.scopes);
end $$;

create function public.staff_revoke_api_key(p_id uuid, p_reason text)
returns public.api_keys
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  update public.api_keys set revoked_at = now() where id = p_id and revoked_at is null returning * into k;
  if k.id is null then raise exception 'not_found'; end if;
  perform public.write_audit('api_key.revoke', 'api_key', k.id::text, null, jsonb_build_object('name', k.name), r);
  return k;
end $$;

-- Every API RPC starts here: the key must exist, be live, hold the scope and be under its
-- per-minute limit. The request is logged (in the caller's transaction: a call that fails
-- afterwards is logged by api_log_failure from the route handler).
create function public.api_auth(p_key text, p_scope text, p_method text, p_path text)
returns public.api_keys
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; used integer;
begin
  select * into k from public.api_keys where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex') and revoked_at is null;
  if k.id is null then raise exception 'api_unauthorized: invalid or revoked API key'; end if;
  if not (p_scope = any(k.scopes)) then raise exception 'api_forbidden: this key lacks the % scope', p_scope; end if;
  perform pg_advisory_xact_lock(hashtext('nama.api:' || k.id::text));
  select count(*) into used from public.api_requests where key_id = k.id and at > now() - interval '1 minute';
  if used >= k.rate_per_min then raise exception 'api_rate_limited: % requests per minute', k.rate_per_min; end if;
  update public.api_keys set last_used_at = now() where id = k.id;
  insert into public.api_requests (key_id, method, path, status) values (k.id, left(p_method, 10), left(p_path, 200), 200);
  return k;
end $$;

-- Route handlers log refused or failed calls (no data is returned).
create function public.api_log_failure(p_key text, p_method text, p_path text, p_status integer, p_error text)
returns void
language plpgsql security definer set search_path = public
as $$
declare kid uuid;
begin
  select id into kid from public.api_keys where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  -- Unknown keys are logged without a key; cap anonymous noise.
  if kid is null and (select count(*) from public.api_requests where key_id is null and at > now() - interval '1 minute') > 300 then return; end if;
  insert into public.api_requests (key_id, method, path, status, error)
  values (kid, left(coalesce(p_method, '?'), 10), left(coalesce(p_path, '?'), 200), coalesce(p_status, 500), left(p_error, 300));
end $$;

create function public.api_audit(k public.api_keys, p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb, p_reason text)
returns void language sql security definer set search_path = public
as $$
  insert into public.audit_log (actor_id, actor_email, actor_role, action, target_type, target_id, before, after, reason)
  values (null, 'api:' || k.name, 'integration', p_action, p_target_type, p_target_id, p_before, p_after, p_reason)
$$;

-- Keyset paging helper: (created_at, id) cursors encoded as "iso|uuid".
create function public.api_cursor(p_cursor text)
returns table (at timestamptz, id uuid) language sql immutable
as $$ select case when p_cursor ~ '\|' then split_part(p_cursor, '|', 1)::timestamptz end, case when p_cursor ~ '\|' then split_part(p_cursor, '|', 2)::uuid end $$;

-- GET /api/v1/orders — no customer identity, no exact location (area and zone only).
create function public.api_v1_orders(p_key text, p_since timestamptz default null, p_status text default null, p_limit integer default 100,
                                     p_cursor text default null, p_include_test boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; c record; out_rows jsonb; lim integer := greatest(least(coalesce(p_limit, 100), 500), 1); last_cursor text;
begin
  k := public.api_auth(p_key, 'orders:read', 'GET', '/api/v1/orders');
  select * into c from public.api_cursor(p_cursor);
  with x as (
    select o.* from public.orders o
     where (p_since is null or o.created_at >= p_since) and (p_status is null or o.status::text = p_status)
       and (p_include_test or not o.is_test)
       and (c.at is null or (o.created_at, o.id) > (c.at, c.id))
     order by o.created_at, o.id limit lim)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'order_no', 'TO-' || x.order_no, 'status', x.status, 'service_type', x.service_type, 'gallons', x.gallons,
           'area', x.area, 'zone', (select z.name from public.zones z where z.id = x.zone_id), 'channel', x.channel, 'is_emergency', x.is_emergency,
           'slot_start', x.slot_start, 'slot_end', x.slot_end, 'tanker_plate', x.tanker_plate,
           'price', jsonb_build_object('water_charge', x.water_charge, 'delivery_fee', x.delivery_fee, 'discount', x.discount, 'vat', x.vat, 'total', x.total, 'currency', 'OMR'),
           'created_at', x.created_at, 'accepted_at', x.accepted_at, 'filled_at', x.filled_at, 'delivered_at', x.delivered_at, 'cancelled_at', x.cancelled_at,
           'sla', public.sla_state(x), 'is_test', x.is_test) order by x.created_at, x.id), '[]'::jsonb),
         (array_agg(x.created_at::text || '|' || x.id::text order by x.created_at desc, x.id desc))[1]
    into out_rows, last_cursor from x;
  update public.api_requests set rows = jsonb_array_length(out_rows) where id = (select max(id) from public.api_requests where key_id = k.id);
  return jsonb_build_object('data', out_rows, 'next_cursor', case when jsonb_array_length(out_rows) = lim then last_cursor end);
end $$;

-- GET /api/v1/tankers
create function public.api_v1_tankers(p_key text, p_limit integer default 200, p_cursor text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; rows jsonb; lim integer := greatest(least(coalesce(p_limit, 200), 1000), 1);
begin
  k := public.api_auth(p_key, 'tankers:read', 'GET', '/api/v1/tankers');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'plate', t.plate, 'service_type', t.service_type, 'capacity_gal', t.capacity_gal, 'company', c.name, 'company_cr', c.cr_no,
           'online', t.is_online, 'blocked', t.blocked, 'permit_valid', public.tanker_has_valid_permit(t.id),
           'device_id', (select d.id from public.devices d where d.tanker_id = t.id),
           'last_fix', case when t.last_fix_at is not null then jsonb_build_object('lat', t.last_lat, 'lng', t.last_lng, 'accuracy_m', t.last_accuracy_m,
                                                                                  'at', t.last_fix_at, 'source', t.last_fix_source) end) order by t.plate), '[]'::jsonb)
    into rows
    from (select * from public.tankers where p_cursor is null or plate > p_cursor order by plate limit lim) t
    left join public.companies c on c.id = t.company_id;
  return jsonb_build_object('data', rows, 'next_cursor', case when jsonb_array_length(rows) = lim then rows -> (lim - 1) ->> 'plate' end);
end $$;

-- GET /api/v1/permits
create function public.api_v1_permits(p_key text, p_status text default null, p_expiring_days integer default null, p_limit integer default 200, p_cursor text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; rows jsonb; lim integer := greatest(least(coalesce(p_limit, 200), 1000), 1);
begin
  k := public.api_auth(p_key, 'permits:read', 'GET', '/api/v1/permits');
  select coalesce(jsonb_agg(jsonb_build_object(
           'permit_no', p.permit_no, 'plate', t.plate, 'type', p.type, 'status', p.status, 'effective_status', public.effective_status(p),
           'stage', p.stage, 'issued_at', p.issued_at, 'expires_at', p.expires_at, 'reviewed_at', p.reviewed_at) order by p.permit_no), '[]'::jsonb)
    into rows
    from (select * from public.permits x
           where (p_status is null or x.status::text = p_status)
             and (p_expiring_days is null or (x.status = 'approved' and x.expires_at <= now() + make_interval(days => p_expiring_days)))
             and (p_cursor is null or x.permit_no > p_cursor)
           order by x.permit_no limit lim) p
    join public.tankers t on t.id = p.tanker_id;
  return jsonb_build_object('data', rows, 'next_cursor', case when jsonb_array_length(rows) = lim then rows -> (lim - 1) ->> 'permit_no' end);
end $$;

-- PATCH /api/v1/permits/{permit_no} — a TAS-style system approves, rejects or revokes.
create function public.api_v1_permit_update(p_key text, p_permit_no text, p_status text, p_reason text, p_expires_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; b public.permits; a public.permits;
begin
  k := public.api_auth(p_key, 'permits:write', 'PATCH', '/api/v1/permits/' || coalesce(p_permit_no, ''));
  if p_status not in ('approved', 'rejected') then raise exception 'invalid_value: status must be approved or rejected'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into b from public.permits where permit_no = p_permit_no for update;
  if not found then raise exception 'not_found'; end if;
  update public.permits
     set status = p_status::public.permit_status, reviewed_at = now(),
         reason = left(btrim(p_reason), 500),
         expires_at = coalesce(p_expires_at, expires_at),
         stage = 'decision'
   where id = b.id returning * into a;
  perform public.api_audit(k, 'permit.api_' || p_status, 'permit', a.id::text, jsonb_build_object('status', b.status, 'expires_at', b.expires_at),
                           jsonb_build_object('status', a.status, 'expires_at', a.expires_at), btrim(p_reason));
  perform public.notify_permit(a.id, 'permit_' || p_status, jsonb_build_object('date', to_char(a.expires_at at time zone 'Asia/Muscat', 'DD Mon YYYY'),
                                                                               'reason', btrim(p_reason), 'note', btrim(p_reason)));
  return jsonb_build_object('permit_no', a.permit_no, 'status', a.status, 'expires_at', a.expires_at);
end $$;

-- POST /api/v1/events — fill (TFS) and discharge (STP) meter events, recorded as evidence
-- against the order; a meter more than 5 % off the order raises an alert.
create function public.api_v1_event(p_key text, p_body jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; o public.orders; s public.sites; ev_kind text := p_body ->> 'kind'; meter integer; ok boolean; ev public.source_events;
begin
  k := public.api_auth(p_key, 'events:write', 'POST', '/api/v1/events');
  if ev_kind not in ('fill', 'discharge') then raise exception 'invalid_value: kind must be fill or discharge'; end if;
  select * into o from public.orders where order_no = nullif(regexp_replace(coalesce(p_body ->> 'order_no', ''), '\D', '', 'g'), '')::bigint;
  if not found then raise exception 'not_found: order'; end if;
  if p_body ? 'plate' and o.tanker_plate is distinct from p_body ->> 'plate' then raise exception 'invalid_value: plate does not match the order''s tanker'; end if;
  select x.* into s from public.sites x where x.code = p_body ->> 'site_code' and x.kind = ev_kind;
  if not found then raise exception 'not_found: site'; end if;
  meter := (p_body ->> 'meter_gal')::integer;
  if meter is null or meter < 0 or meter > 20000 then raise exception 'invalid_value: meter_gal'; end if;
  ok := abs(meter - o.gallons) <= o.gallons * 0.05 and o.service_type = any(s.service_types);
  insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, verified, note, created_at)
  values (o.id, o.tanker_id, case when ev_kind = 'fill' then 'tfs' else 'stp' end, ev_kind, s.id, meter, ok,
          format('%s via API (%s)%s', case when ev_kind = 'fill' then 'Station meter' else 'Plant meter' end, k.name,
                 case when ok then '' else format(': %s gal against %s ordered', meter, o.gallons) end),
          coalesce((p_body ->> 'at')::timestamptz, now()))
  returning * into ev;
  if not ok and o.tanker_id is not null then
    perform public.raise_alert(o.tanker_id, o.id, case when ev_kind = 'fill' then 'Station meter mismatch' else 'Plant meter mismatch' end, 'med',
                               format('TO-%s: %s meter %s gal, order %s gal', o.order_no, s.name, meter, o.gallons), null, null, 'meter:' || ev_kind || ':' || o.id);
  end if;
  return jsonb_build_object('id', ev.id, 'order_no', 'TO-' || o.order_no, 'verified', ok);
end $$;

-- ===========================================================================
-- C1 / C5 — fix sources, accuracy grades, IVMS devices and ingestion
-- ===========================================================================
alter table public.tankers add column last_fix_source text check (last_fix_source in ('phone', 'simulated', 'ivms'));
alter table public.gps_fixes add column heading numeric(5,1), add column ignition boolean;
alter table public.devices
  add column api_key_id   uuid references public.api_keys (id) on delete set null,
  add column last_fix_at  timestamptz,
  add column active       boolean not null default true;
alter table public.source_events add column evidence_grade text check (evidence_grade in ('ivms', 'gps_precise', 'low_accuracy', 'test_zone'));

insert into public.app_settings (key, value, notes) values
  ('GPS', '{"ivms_grade_m": 10, "phone_max_m": 100}',
   'Positional accuracy: fixes within ivms_grade_m are evidence grade (the tender''s ±10 m); phone fixes worse than that are flagged low accuracy and refused beyond phone_max_m.')
on conflict (key) do nothing;

-- How good was the tanker's last fix for geofence evidence?
create function public.fix_grade(p_source text, p_accuracy double precision)
returns text language sql stable security definer set search_path = public
as $$
  select case when p_accuracy is not null and p_accuracy <= coalesce((public.setting_json('GPS') ->> 'ivms_grade_m')::numeric, 10)
              then case when p_source = 'ivms' then 'ivms' else 'gps_precise' end
              else 'low_accuracy' end
$$;

-- One path for every fix (phone, simulator, IVMS): the tanker's position, the trip moving
-- to arriving, the GPS history, speeding and off-area alerts. Older fixes are ignored.
create function public.record_fix(p_tanker uuid, p_lat double precision, p_lng double precision, p_accuracy double precision, p_at timestamptz,
                                  p_source text, p_speed numeric default null, p_heading numeric default null, p_ignition boolean default null)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; prev public.gps_fixes; spd numeric := p_speed; job uuid; fid bigint;
begin
  select * into t from public.tankers where id = p_tanker;
  if not found then raise exception 'not_found'; end if;
  if t.last_fix_at is not null and p_at <= t.last_fix_at then return false; end if;
  update public.tankers
     set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy, last_fix_at = p_at, last_seen_at = now(), last_fix_source = p_source
   where id = t.id;
  update public.orders set status = 'arriving', arriving_at = now()
   where tanker_id = t.id and status = 'accepted';
  select id into job from public.orders where tanker_id = t.id and status in ('accepted', 'arriving', 'arrived', 'collected') limit 1;
  select * into prev from public.gps_fixes where tanker_id = t.id order by recorded_at desc limit 1;
  if spd is null and prev.id is not null and p_at > prev.recorded_at then
    spd := round((public.km(prev.lat, prev.lng, p_lat, p_lng) / greatest(extract(epoch from p_at - prev.recorded_at), 1) * 3600)::numeric, 1);
  end if;
  insert into public.gps_fixes (tanker_id, order_id, lat, lng, accuracy_m, speed_kmh, recorded_at, heading, ignition)
  values (t.id, job, p_lat, p_lng, p_accuracy, spd, p_at, p_heading, p_ignition) returning id into fid;
  -- gps_fixes.source arrives with 0030 (dynamic SQL, so this compiles before it). Phone fixes are
  -- left for 0030's report_location(…, p_source) to tag 'phone' or 'simulated'.
  if p_source <> 'phone' then
    execute 'update public.gps_fixes set source = $1 where id = $2' using p_source, fid;
  end if;
  if spd is not null and spd > 100 and spd < 250 then
    perform public.raise_alert(t.id, job, 'Speeding', 'med', format('%s at %s km/h (limit 100 for heavy vehicles)', t.plate, spd), p_lat, p_lng,
                               'speed:' || t.id || ':' || to_char(now(), 'YYYYMMDDHH24'));
  end if;
  if exists (select 1 from public.zones) and (public.zone_at(p_lat, p_lng, true)).id is null then
    perform public.raise_alert(t.id, job, 'Off-premise / outside service area', 'low', format('%s is outside every NWS service area', t.plate), p_lat, p_lng,
                               'offarea:' || t.id || ':' || to_char(now(), 'YYYYMMDDHH24'));
  end if;
  return true;
end $$;

-- The phone path keeps its checks; fixes up to phone_max_m are accepted and those worse than
-- ivms_grade_m are low accuracy (fix_grade), instead of one 100 m rule for everything.
create or replace function public.report_location(
  p_lat         double precision,
  p_lng         double precision,
  p_accuracy_m  double precision,
  p_recorded_at timestamptz
)
returns void
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; maxm numeric := coalesce((public.setting_json('GPS') ->> 'phone_max_m')::numeric, 100);
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'invalid_location'; end if;
  if p_accuracy_m is null or p_accuracy_m < 0 then raise exception 'accuracy_required'; end if;
  if p_accuracy_m > maxm then raise exception 'inaccurate_fix: accuracy % m is worse than % m', round(p_accuracy_m::numeric, 1), maxm; end if;
  if p_recorded_at is null or p_recorded_at < now() - interval '2 minutes' or p_recorded_at > now() + interval '5 minutes' then raise exception 'stale_fix'; end if;
  t := public.my_tanker();
  -- A tanker on an IVMS feed keeps its IVMS position: the phone fills in only when IVMS is silent.
  if t.last_fix_source = 'ivms' and t.last_fix_at > now() - interval '2 minutes' then
    update public.tankers set last_seen_at = now() where id = t.id;
    return;
  end if;
  perform public.record_fix(t.id, p_lat, p_lng, p_accuracy_m, p_recorded_at, 'phone');
end $$;

-- IVMS ingestion (route handler POST /api/v1/ivms/fixes). Each fix:
--   {device_id, plate, lat, lng, accuracy_m, speed_kmh, heading, recorded_at, ignition}
-- The device must be registered to the tanker with that plate. Returns accepted/rejected counts.
create function public.ivms_ingest(p_fixes jsonb, p_key_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare f jsonb; d public.devices; t public.tankers; ok integer := 0; old integer := 0; bad jsonb := '[]'::jsonb; at timestamptz; lat double precision; lng double precision; acc double precision;
begin
  if jsonb_typeof(p_fixes) <> 'array' then raise exception 'invalid_value: expected an array of fixes'; end if;
  if jsonb_array_length(p_fixes) > 500 then raise exception 'invalid_value: at most 500 fixes per call'; end if;
  for f in select x from jsonb_array_elements(p_fixes) x order by (x ->> 'recorded_at') loop
    begin
      select * into d from public.devices where id = f ->> 'device_id' and active;
      if d.id is null or d.tanker_id is null then raise exception 'unknown_device'; end if;
      if p_key_id is not null and d.api_key_id is not null and d.api_key_id <> p_key_id then raise exception 'device_belongs_to_another_integration'; end if;
      select * into t from public.tankers where id = d.tanker_id;
      if f ? 'plate' and upper(replace(f ->> 'plate', ' ', '')) <> upper(replace(t.plate, ' ', '')) then raise exception 'plate_mismatch'; end if;
      lat := (f ->> 'lat')::double precision; lng := (f ->> 'lng')::double precision; acc := (f ->> 'accuracy_m')::double precision;
      at := (f ->> 'recorded_at')::timestamptz;
      if lat is null or lng is null or abs(lat) > 90 or abs(lng) > 180 then raise exception 'invalid_location'; end if;
      if acc is null or acc < 0 or acc > 500 then raise exception 'invalid_accuracy'; end if;
      if at is null or at > now() + interval '5 minutes' or at < now() - interval '24 hours' then raise exception 'invalid_time'; end if;
      if public.record_fix(t.id, lat, lng, acc, at, 'ivms', (f ->> 'speed_kmh')::numeric, (f ->> 'heading')::numeric, (f ->> 'ignition')::boolean) then
        ok := ok + 1;
        update public.devices set last_fix_at = at where id = d.id;
      else
        old := old + 1;
      end if;
    exception when others then
      bad := bad || jsonb_build_object('device_id', f ->> 'device_id', 'recorded_at', f ->> 'recorded_at', 'error', split_part(sqlerrm, ':', 1));
    end;
  end loop;
  return jsonb_build_object('accepted', ok, 'ignored_older', old, 'rejected', bad);
end $$;

create function public.api_v1_ivms_fixes(p_key text, p_fixes jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys;
begin
  k := public.api_auth(p_key, 'ivms:write', 'POST', '/api/v1/ivms/fixes');
  update public.integrations set status = 'ok', last_test_at = now(), note = 'Live feed through API key ' || k.prefix || '…' where key = 'ivms' and status <> 'down';
  return public.ivms_ingest(p_fixes, k.id);
end $$;

-- NWS: register (or move) an IVMS unit on a tanker, optionally tied to one integration key.
create function public.staff_register_device(p_device_id text, p_tanker_id uuid, p_api_key_id uuid default null)
returns public.devices
language plpgsql security definer set search_path = public
as $$
declare d public.devices;
begin
  perform public.require_staff(array['operator', 'permit_officer']::public.staff_role[]);
  if p_device_id !~ '^IV-[0-9]{4,6}$' then raise exception 'invalid_value: device id must look like IV-12345'; end if;
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
  update public.devices set tanker_id = null where tanker_id = p_tanker_id and id <> p_device_id;
  insert into public.devices (id, tanker_id, api_key_id) values (p_device_id, p_tanker_id, p_api_key_id)
  on conflict (id) do update set tanker_id = excluded.tanker_id, api_key_id = coalesce(excluded.api_key_id, devices.api_key_id), active = true
  returning * into d;
  perform public.write_audit('device.register', 'tanker', p_tanker_id::text, null, jsonb_build_object('device', d.id), null);
  return d;
end $$;

-- Evidence grade on fill and discharge (the confirm_* bodies of 0026 and 0020, plus the grade).
create function public.source_events_grade()
returns trigger language plpgsql security definer set search_path = public
as $$
declare t public.tankers; o public.orders;
begin
  if new.evidence_grade is not null or new.kind not in ('fill', 'discharge') or new.source not in ('tfs', 'stp') or new.note like '%via API%' then return new; end if;
  select * into o from public.orders where id = new.order_id;
  if o.is_test then new.evidence_grade := 'test_zone'; return new; end if;
  select * into t from public.tankers where id = new.tanker_id;
  new.evidence_grade := public.fix_grade(t.last_fix_source, t.last_accuracy_m);
  if new.evidence_grade = 'low_accuracy' then
    new.note := new.note || format(' · position accuracy %s (evidence needs ±%s m)',
                                   coalesce(round(t.last_accuracy_m::numeric)::text || ' m', 'unknown'), coalesce(public.setting_json('GPS') ->> 'ivms_grade_m', '10'));
  end if;
  return new;
end $$;
create trigger source_events_grade before insert on public.source_events for each row execute function public.source_events_grade();

-- ---------------------------------------------------------------------------
-- The built-in IVMS simulator: staff start it for chosen tankers with a route (the
-- portal gets a road route from OSRM); each tick moves the tanker ~speed along it and
-- reports an IVMS fix (±3 m) through ivms_ingest.
-- ---------------------------------------------------------------------------
create table public.ivms_sim (
  tanker_id   uuid primary key references public.tankers (id) on delete cascade,
  device_id   text not null references public.devices (id) on delete cascade,
  route       jsonb not null,          -- [[lat, lng], …]
  pos_m       double precision not null default 0,
  speed_kmh   numeric not null default 40 check (speed_kmh between 5 and 100),
  started_by  uuid references public.profiles (id) on delete set null,
  started_at  timestamptz not null default now(),
  last_tick   timestamptz not null default now(),
  loop        boolean not null default true
);

create function public.staff_ivms_sim_start(p_tanker_id uuid, p_route jsonb, p_speed_kmh numeric default 40)
returns public.ivms_sim
language plpgsql security definer set search_path = public
as $$
declare d text; s public.ivms_sim;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  if jsonb_typeof(p_route) <> 'array' or jsonb_array_length(p_route) < 2 or jsonb_array_length(p_route) > 5000 then raise exception 'invalid_value: route needs 2–5000 points'; end if;
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
  select id into d from public.devices where tanker_id = p_tanker_id;
  if d is null then
    d := 'IV-9' || lpad((abs(hashtext(p_tanker_id::text)) % 100000)::text, 5, '0');
    insert into public.devices (id, tanker_id) values (d, p_tanker_id)
    on conflict (id) do update set tanker_id = excluded.tanker_id, active = true;
  end if;
  insert into public.ivms_sim (tanker_id, device_id, route, speed_kmh, started_by)
  values (p_tanker_id, d, p_route, coalesce(p_speed_kmh, 40), auth.uid())
  on conflict (tanker_id) do update set route = excluded.route, pos_m = 0, speed_kmh = excluded.speed_kmh, started_by = excluded.started_by, started_at = now(), last_tick = now()
  returning * into s;
  perform public.write_audit('ivms.sim_start', 'tanker', p_tanker_id::text, null, jsonb_build_object('device', d, 'points', jsonb_array_length(p_route)), null);
  perform public.ivms_sim_tick();
  return s;
end $$;

create function public.staff_ivms_sim_stop(p_tanker_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  delete from public.ivms_sim where tanker_id = p_tanker_id;
  return found;
end $$;

-- Advance every running simulation to "now" and report one fix each (pg_cron every
-- minute; the Live ops page also ticks it every few seconds while it is open).
create function public.ivms_sim_tick()
returns integer
language plpgsql security definer set search_path = public
as $$
declare s public.ivms_sim; total double precision; i integer; seg double precision; acc double precision; lat double precision; lng double precision;
  a jsonb; b jsonb; n integer := 0; hdg numeric; target double precision;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'not_staff'; end if;
  for s in select * from public.ivms_sim for update skip locked loop
    -- route length
    total := 0;
    for i in 0 .. jsonb_array_length(s.route) - 2 loop
      total := total + public.km((s.route -> i ->> 0)::float8, (s.route -> i ->> 1)::float8, (s.route -> (i + 1) ->> 0)::float8, (s.route -> (i + 1) ->> 1)::float8) * 1000;
    end loop;
    target := s.pos_m + s.speed_kmh / 3.6 * least(extract(epoch from now() - s.last_tick), 120);
    if target >= total then
      if s.loop then target := 0; else target := total; end if;
    end if;
    acc := 0; lat := (s.route -> 0 ->> 0)::float8; lng := (s.route -> 0 ->> 1)::float8; hdg := 0;
    for i in 0 .. jsonb_array_length(s.route) - 2 loop
      a := s.route -> i; b := s.route -> (i + 1);
      seg := public.km((a ->> 0)::float8, (a ->> 1)::float8, (b ->> 0)::float8, (b ->> 1)::float8) * 1000;
      if acc + seg >= target or i = jsonb_array_length(s.route) - 2 then
        lat := (a ->> 0)::float8 + ((b ->> 0)::float8 - (a ->> 0)::float8) * case when seg > 0 then least((target - acc) / seg, 1) else 0 end;
        lng := (a ->> 1)::float8 + ((b ->> 1)::float8 - (a ->> 1)::float8) * case when seg > 0 then least((target - acc) / seg, 1) else 0 end;
        hdg := round(((degrees(atan2((b ->> 1)::float8 - (a ->> 1)::float8, (b ->> 0)::float8 - (a ->> 0)::float8)) + 360)::numeric % 360), 1);
        exit;
      end if;
      acc := acc + seg;
    end loop;
    update public.ivms_sim set pos_m = target, last_tick = now() where tanker_id = s.tanker_id;
    perform public.ivms_ingest(jsonb_build_array(jsonb_build_object(
      'device_id', s.device_id, 'lat', round(lat::numeric, 6), 'lng', round(lng::numeric, 6), 'accuracy_m', 3,
      'speed_kmh', s.speed_kmh, 'heading', hdg, 'recorded_at', now(), 'ignition', true)));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Staff shortcut for the portal timer.
create function public.staff_ivms_sim_tick()
returns integer
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return public.ivms_sim_tick();
end $$;

-- ===========================================================================
-- Notification gateway seam (0026): an outside worker sends 'external' channels.
-- ===========================================================================
create function public.api_v1_notifications_claim(p_key text, p_channel text, p_limit integer default 50)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; rows jsonb;
begin
  k := public.api_auth(p_key, 'notify:send', 'POST', '/api/v1/notifications/claim');
  if p_channel not in ('push', 'sms', 'whatsapp', 'email') then raise exception 'invalid_value: channel'; end if;
  if coalesce(public.setting_json('NOTIFY') -> 'providers' ->> p_channel, 'simulated') <> 'external' then
    raise exception 'invalid_state: channel % is not set to an external gateway in NWS Settings → Notifications', p_channel;
  end if;
  with c as (
    select o.id from public.notification_outbox o
     where o.status = 'queued' and o.channel = p_channel and o.next_attempt_at <= now()
     order by o.id limit greatest(least(coalesce(p_limit, 50), 500), 1) for update skip locked),
  u as (
    update public.notification_outbox o set next_attempt_at = now() + interval '5 minutes', provider = 'external:' || k.name
      from c where o.id = c.id returning o.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'channel', u.channel, 'to', u.destination, 'lang', u.lang, 'title', u.title, 'body', u.body,
                                               'event', u.event, 'attempt', u.attempts + 1) order by u.id), '[]'::jsonb)
    into rows from u;
  return jsonb_build_object('data', rows);
end $$;

create function public.api_v1_notifications_report(p_key text, p_id bigint, p_ok boolean, p_provider_ref text default null, p_response jsonb default null,
                                                   p_error text default null, p_permanent boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; r public.notification_outbox;
begin
  k := public.api_auth(p_key, 'notify:send', 'POST', '/api/v1/notifications/report');
  r := public.outbox_record(p_id, coalesce(p_ok, false), coalesce(p_permanent, false), 'external:' || k.name, p_provider_ref, p_response, p_error);
  if r.id is null then raise exception 'not_found: message not queued'; end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'attempts', r.attempts);
end $$;

-- ===========================================================================
-- G11 — outgoing webhooks (order and permit events), HMAC-SHA256 signed, retried
-- ===========================================================================
create table public.webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 3 and 80),
  url         text not null check (url ~ '^(https://|simulate://)'),
  secret_enc  bytea not null,           -- signing secret, encrypted (0027 key)
  events      text[] not null,
  active      boolean not null default true,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.webhook_deliveries (
  id              bigint generated always as identity primary key,
  endpoint_id     uuid not null references public.webhook_endpoints (id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  status          text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  request_id      bigint,               -- pg_net request, while sending
  response_status integer,
  response_body   text,
  signature       text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index webhook_deliveries_queue_idx on public.webhook_deliveries (next_attempt_at) where status in ('queued', 'sending');

create function public.webhook_events()
returns text[] language sql immutable
as $$ select array['order.created', 'order.accepted', 'order.filled', 'order.delivered', 'order.cancelled', 'permit.approved', 'permit.rejected', 'permit.expiring'] $$;

create function public.staff_create_webhook(p_name text, p_url text, p_events text[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare secret text := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex'); e public.webhook_endpoints;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  if p_events is null or cardinality(p_events) = 0 or not (p_events <@ public.webhook_events()) then raise exception 'invalid_value: unknown event'; end if;
  if p_url !~ '^(https://[^ ]+|simulate://[a-z0-9-]+)$' then raise exception 'invalid_value: the URL must use https:// (or simulate://name for the built-in receiver)'; end if;
  insert into public.webhook_endpoints (name, url, secret_enc, events, created_by) values (btrim(p_name), p_url, public.pii_encrypt(secret), p_events, auth.uid()) returning * into e;
  perform public.write_audit('webhook.create', 'webhook', e.id::text, null, jsonb_build_object('name', e.name, 'url', e.url, 'events', e.events), null);
  return jsonb_build_object('id', e.id, 'secret', secret);
end $$;

create function public.staff_set_webhook(p_id uuid, p_active boolean)
returns public.webhook_endpoints
language plpgsql security definer set search_path = public
as $$
declare e public.webhook_endpoints;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  update public.webhook_endpoints set active = p_active where id = p_id returning * into e;
  if e.id is null then raise exception 'not_found'; end if;
  perform public.write_audit('webhook.' || case when p_active then 'enable' else 'disable' end, 'webhook', e.id::text, null, null, null);
  return e;
end $$;

create function public.webhook_enqueue(p_event text, p_data jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  insert into public.webhook_deliveries (endpoint_id, event, payload)
  select e.id, p_event, jsonb_build_object('id', gen_random_uuid(), 'type', p_event, 'created_at', now(), 'api_version', 'v1', 'data', p_data)
    from public.webhook_endpoints e where e.active and p_event = any(e.events);
  get diagnostics n = row_count;
  return n;
end $$;

create function public.staff_test_webhook(p_id uuid)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare d bigint;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  insert into public.webhook_deliveries (endpoint_id, event, payload)
  select e.id, 'ping', jsonb_build_object('id', gen_random_uuid(), 'type', 'ping', 'created_at', now(), 'api_version', 'v1', 'data', jsonb_build_object('message', 'Test from NWS Settings → Integrations'))
    from public.webhook_endpoints e where e.id = p_id
  returning id into d;
  if d is null then raise exception 'not_found'; end if;
  perform public.webhook_dispatch();
  return d;
end $$;

-- Order and permit events (test-zone orders are not sent).
create function public.orders_webhook()
returns trigger language plpgsql security definer set search_path = public
as $$
declare ev text;
begin
  if new.is_test then return new; end if;
  ev := case when tg_op = 'INSERT' then 'order.created'
             when new.status is distinct from old.status and new.status = 'accepted' then 'order.accepted'
             when new.status is distinct from old.status and new.status = 'delivered' then 'order.delivered'
             when new.status is distinct from old.status and new.status = 'cancelled' then 'order.cancelled'
             when new.filled_at is not null and old.filled_at is null then 'order.filled' end;
  if ev is not null and exists (select 1 from public.webhook_endpoints where active and ev = any(events)) then
    perform public.webhook_enqueue(ev, jsonb_build_object('order_no', 'TO-' || new.order_no, 'id', new.id, 'status', new.status, 'service_type', new.service_type,
                                                          'gallons', new.gallons, 'area', new.area, 'tanker_plate', new.tanker_plate, 'total', new.total,
                                                          'channel', new.channel, 'at', now()));
  end if;
  return new;
end $$;
create trigger orders_webhook after insert or update of status, filled_at on public.orders for each row execute function public.orders_webhook();

create function public.permits_webhook()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status::text in ('approved', 'rejected') then
    perform public.webhook_enqueue('permit.' || new.status::text, jsonb_build_object('permit_no', new.permit_no, 'plate', (select plate from public.tankers where id = new.tanker_id),
                                                                                    'type', new.type, 'status', new.status, 'expires_at', new.expires_at, 'at', now()));
  end if;
  if new.reminded_at is distinct from old.reminded_at and new.reminded_at is not null then
    perform public.webhook_enqueue('permit.expiring', jsonb_build_object('permit_no', new.permit_no, 'plate', (select plate from public.tankers where id = new.tanker_id),
                                                                         'expires_at', new.expires_at, 'at', now()));
  end if;
  return new;
end $$;
create trigger permits_webhook after update of status, reminded_at on public.permits for each row execute function public.permits_webhook();

-- Signature: "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>" (see docs/api).
create function public.webhook_sign(p_secret text, p_ts bigint, p_body text)
returns text language sql immutable
as $$ select 't=' || p_ts || ',v1=' || encode(extensions.hmac(p_ts::text || '.' || p_body, p_secret, 'sha256'), 'hex') $$;

-- Dispatcher (pg_cron every minute): sends through pg_net when the database has it
-- (Supabase), reads earlier responses, retries with backoff (1, 2, 4, 8, 16 min; 6 tries).
-- simulate://… endpoints (and databases without pg_net) get the built-in receiver, which
-- checks the signature and answers 200.
create function public.webhook_dispatch()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare d record; body text; ts bigint; sig text; secret text; rid bigint; st integer; resp text; sent integer := 0; failed integer := 0; has_net boolean := to_regproc('net.http_post') is not null;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'not_staff'; end if;
  -- Responses to requests already sent.
  if has_net then
    for d in select w.* from public.webhook_deliveries w where w.status = 'sending' and w.request_id is not null for update skip locked loop
      begin
        execute 'select status_code, left(content, 500) from net._http_response where id = $1' into st, resp using d.request_id;
      exception when others then st := null;
      end;
      continue when st is null and d.next_attempt_at > now() - interval '2 minutes';
      update public.webhook_deliveries
         set status = case when st between 200 and 299 then 'sent' when attempts >= 6 then 'failed' else 'queued' end,
             response_status = st, response_body = coalesce(resp, 'No response (timeout)'), request_id = null,
             sent_at = case when st between 200 and 299 then now() end,
             next_attempt_at = now() + make_interval(mins => power(2, least(attempts, 5))::integer)
       where id = d.id;
    end loop;
  end if;
  for d in select w.*, e.url, e.secret_enc from public.webhook_deliveries w join public.webhook_endpoints e on e.id = w.endpoint_id
            where w.status = 'queued' and w.next_attempt_at <= now() and e.active order by w.id limit 200 for update of w skip locked loop
    body := d.payload::text;
    ts := extract(epoch from now())::bigint;
    secret := public.pii_decrypt(d.secret_enc);
    sig := public.webhook_sign(secret, ts, body);
    if d.url like 'simulate://%' or not has_net then
      -- Built-in receiver: verifies the signature as a real receiver would.
      st := case when d.url like 'simulate://fail%' then 500
                 when public.webhook_sign(secret, ts, body) = sig then 200 else 401 end;
      update public.webhook_deliveries
         set attempts = attempts + 1, signature = sig, response_status = st,
             response_body = case when st = 200 then '{"received": true, "simulated": true, "signature": "valid"}' else '{"error": "simulated receiver error"}' end,
             status = case when st = 200 then 'sent' when attempts + 1 >= 6 then 'failed' else 'queued' end,
             sent_at = case when st = 200 then now() end,
             next_attempt_at = now() + make_interval(mins => power(2, least(attempts, 5))::integer)
       where id = d.id;
      if st = 200 then sent := sent + 1; else failed := failed + 1; end if;
    else
      execute 'select net.http_post(url := $1, body := $2::jsonb, headers := $3::jsonb, timeout_milliseconds := 5000)'
         into rid using d.url, body, jsonb_build_object('Content-Type', 'application/json', 'X-Nama-Signature', sig, 'X-Nama-Event', d.event, 'X-Nama-Delivery', d.id::text);
      update public.webhook_deliveries set attempts = attempts + 1, signature = sig, status = 'sending', request_id = rid, next_attempt_at = now() where id = d.id;
      sent := sent + 1;
    end if;
  end loop;
  return jsonb_build_object('sent', sent, 'failed', failed, 'pg_net', has_net);
end $$;

-- Staff: run the webhook dispatcher now (Settings → Integrations).
create function public.staff_webhook_dispatch()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  return public.webhook_dispatch();
end $$;

-- ===========================================================================
-- Access
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['incident_escalations', 'api_keys', 'api_requests', 'ivms_sim', 'webhook_endpoints', 'webhook_deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select on public.incident_escalations, public.api_requests, public.ivms_sim, public.webhook_deliveries to authenticated;
-- Key hashes and webhook secrets are never readable through the API.
grant select (id, name, integration, prefix, scopes, rate_per_min, created_by, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
grant select (id, name, url, events, active, created_by, created_at) on public.webhook_endpoints to authenticated;
create policy incident_escalations_staff on public.incident_escalations for select to authenticated using (public.is_staff());
create policy api_keys_staff on public.api_keys for select to authenticated using (public.my_staff_role() = 'admin');
create policy api_requests_staff on public.api_requests for select to authenticated using (public.my_staff_role() = 'admin');
create policy ivms_sim_staff on public.ivms_sim for select to authenticated using (public.is_staff());
create policy webhook_endpoints_staff on public.webhook_endpoints for select to authenticated using (public.my_staff_role() = 'admin');
create policy webhook_deliveries_staff on public.webhook_deliveries for select to authenticated using (public.my_staff_role() = 'admin');

revoke execute on function
  public.add_working_days(timestamptz, integer), public.incident_due(timestamptz, integer, integer), public.incident_scan(),
  public.api_scopes(), public.api_auth(text, text, text, text), public.api_audit(public.api_keys, text, text, text, jsonb, jsonb, text), public.api_cursor(text),
  public.fix_grade(text, double precision),
  public.record_fix(uuid, double precision, double precision, double precision, timestamptz, text, numeric, numeric, boolean),
  public.ivms_ingest(jsonb, uuid), public.source_events_grade(), public.ivms_sim_tick(),
  public.webhook_events(), public.webhook_enqueue(text, jsonb), public.orders_webhook(), public.permits_webhook(), public.webhook_sign(text, bigint, text), public.webhook_dispatch()
from public, anon, authenticated;
grant execute on function public.add_working_days(timestamptz, integer), public.incident_due(timestamptz, integer, integer), public.api_scopes(),
  public.fix_grade(text, double precision), public.webhook_events() to authenticated;

-- The integration API is called with the publishable key and no session (anon): each
-- function checks the API key itself.
do $$
declare f text;
begin
  foreach f in array array[
    'api_v1_orders(text, timestamptz, text, integer, text, boolean)', 'api_v1_tankers(text, integer, text)',
    'api_v1_permits(text, text, integer, integer, text)', 'api_v1_permit_update(text, text, text, text, timestamptz)',
    'api_v1_event(text, jsonb)', 'api_v1_ivms_fixes(text, jsonb)',
    'api_v1_notifications_claim(text, text, integer)', 'api_v1_notifications_report(text, bigint, boolean, text, jsonb, text, boolean)',
    'api_log_failure(text, text, text, integer, text)']
  loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array[
    'incident_status()', 'staff_create_api_key(text, text[], integer, text)', 'staff_revoke_api_key(uuid, text)',
    'report_location(double precision, double precision, double precision, timestamptz)',
    'staff_register_device(text, uuid, uuid)', 'staff_ivms_sim_start(uuid, jsonb, numeric)', 'staff_ivms_sim_stop(uuid)', 'staff_ivms_sim_tick()',
    'staff_create_webhook(text, text, text[])', 'staff_set_webhook(uuid, boolean)', 'staff_test_webhook(uuid)', 'staff_webhook_dispatch()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

alter publication supabase_realtime add table public.ivms_sim;

-- ===========================================================================
-- pg_cron jobs are recorded here and scheduled after the migration commits
-- (scripts/schedule-cron.mjs, run by db:apply), one job per connection with retries:
-- on Supabase, cron.schedule can drop the connection, which inside a migration rolls
-- the whole migration back.
-- ===========================================================================
create table if not exists public.cron_wanted (
  name    text primary key,
  cron    text not null,
  command text not null
);
revoke all on public.cron_wanted from public, anon, authenticated;

create or replace function public.nama_schedule(p_name text, p_cron text, p_command text)
returns boolean
language sql
as $$
  insert into public.cron_wanted (name, cron, command) values (p_name, p_cron, p_command)
  on conflict (name) do update set cron = excluded.cron, command = excluded.command
  returning true
$$;
revoke execute on function public.nama_schedule(text, text, text) from public, anon, authenticated;

-- Jobs from 0026/0027 (some were not scheduled when those ran).
select public.nama_schedule('nama-notify-dispatch', '* * * * *', 'select public.dispatch_notifications()');
select public.nama_schedule('nama-advance-offers', '* * * * *', 'select public.advance_offers()');
select public.nama_schedule('nama-daily-reminders', '0 5 * * *', 'select public.run_daily_jobs()');
select public.nama_schedule('nama-retention', '0 23 * * *', 'select public.run_retention(false)');

select public.nama_schedule('nama-incident-scan', '* * * * *', 'select public.incident_scan()');
select public.nama_schedule('nama-ivms-sim', '* * * * *', 'select public.ivms_sim_tick()');
select public.nama_schedule('nama-webhooks', '* * * * *', 'select public.webhook_dispatch()');
