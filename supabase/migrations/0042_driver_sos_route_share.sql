-- Driver safety: SOS and live-route sharing (item 24).
--
-- SOS: during a job or an online shift the driver raises a high-severity 'SOS' alert to NWS
-- live operations with their position (the phone's, else the tanker's last fix). One open SOS
-- per tanker: pressing again updates its position. Live ops lists open SOS alerts first,
-- highlighted without sound.
-- Route share: a time-limited (1–12 h, default 4 h), revocable link to a public read-only page
-- with the tanker's live position and the destination AREA only: the area name and a point
-- rounded to about 1 km. Never the customer's pin, name, phone or the driver's name.

-- ===========================================================================
-- SOS
-- ===========================================================================
create index alerts_sos_open_idx on public.alerts (created_at desc) where type = 'SOS' and state <> 'resolved';

create function public.driver_sos(p_lat double precision default null, p_lng double precision default null, p_note text default null)
returns public.alerts
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; job public.orders; a public.alerts; nm text; v_lat double precision; v_lng double precision; note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  t := public.my_tanker();
  if t.id is null then raise exception 'no_tanker'; end if;
  select * into job from public.orders where (driver_id = auth.uid() or tanker_id = t.id) and status in ('accepted', 'arriving', 'arrived', 'collected') limit 1;
  if not t.is_online and job.id is null then raise exception 'sos_not_on_duty'; end if;
  if p_lat is not null and p_lng is not null and abs(p_lat) <= 90 and abs(p_lng) <= 180 then v_lat := p_lat; v_lng := p_lng;
  else v_lat := t.last_lat; v_lng := t.last_lng; end if;
  select full_name into nm from public.profiles where id = auth.uid();
  select * into a from public.alerts where tanker_id = t.id and type = 'SOS' and state <> 'resolved' order by id desc limit 1 for update;
  if a.id is not null then
    update public.alerts set lat = coalesce(v_lat, alerts.lat), lng = coalesce(v_lng, alerts.lng),
                             message = format('SOS from %s (%s)%s · updated %s', t.plate, coalesce(nm, 'driver'), coalesce(': ' || note, ''),
                                              to_char(now() at time zone 'Asia/Muscat', 'HH24:MI'))
     where id = a.id returning * into a;
    return a;
  end if;
  insert into public.alerts (tanker_id, order_id, type, severity, message, lat, lng, dedupe_key)
  values (t.id, job.id, 'SOS', 'high', format('SOS from %s (%s)%s', t.plate, coalesce(nm, 'driver'), coalesce(': ' || note, '')), v_lat, v_lng,
          'sos:' || t.id || ':' || extract(epoch from now())::bigint)
  returning * into a;
  return a;
end $$;

-- ===========================================================================
-- Live route share
-- ===========================================================================
create table public.route_shares (
  id         uuid primary key default gen_random_uuid(),
  token      text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  driver_id  uuid not null references public.profiles (id) on delete cascade,
  tanker_id  uuid not null references public.tankers (id) on delete cascade,
  order_id   uuid references public.orders (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  views      integer not null default 0,
  check (expires_at > created_at and expires_at <= created_at + interval '12 hours')
);
create index route_shares_driver_idx on public.route_shares (driver_id, created_at desc);

alter table public.route_shares enable row level security;
revoke all on public.route_shares from public, anon, authenticated;
grant select on public.route_shares to authenticated;
create policy route_shares_own on public.route_shares for select to authenticated using (driver_id = auth.uid());
create policy route_shares_staff on public.route_shares for select to authenticated using (public.is_staff());

create function public.driver_share_route(p_hours integer default 4)
returns public.route_shares
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; job uuid; s public.route_shares; h integer := coalesce(p_hours, 4);
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  if h < 1 or h > 12 then raise exception 'invalid_value: a link lasts 1–12 hours'; end if;
  t := public.my_tanker();
  if t.id is null then raise exception 'no_tanker'; end if;
  select id into job from public.orders where (driver_id = auth.uid() or tanker_id = t.id) and status in ('accepted', 'arriving', 'arrived', 'collected') limit 1;
  if not t.is_online and job is null then raise exception 'sos_not_on_duty'; end if;
  if (select count(*) from public.route_shares where driver_id = auth.uid() and revoked_at is null and expires_at > now()) >= 3 then
    raise exception 'too_many_shares';
  end if;
  insert into public.route_shares (driver_id, tanker_id, order_id, expires_at) values (auth.uid(), t.id, job, now() + make_interval(hours => h))
  returning * into s;
  return s;
end $$;

create function public.driver_revoke_route_share(p_id uuid)
returns public.route_shares
language plpgsql security definer set search_path = public
as $$
declare s public.route_shares;
begin
  update public.route_shares set revoked_at = now() where id = p_id and driver_id = auth.uid() and revoked_at is null returning * into s;
  if not found then raise exception 'not_found'; end if;
  return s;
end $$;

-- The public page (no sign-in): position and destination area while the link is live.
create function public.shared_route(p_token text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare s public.route_shares; t public.tankers; o public.orders; l public.order_locations; z text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{36}$' then return jsonb_build_object('state', 'invalid'); end if;
  select * into s from public.route_shares where token = p_token;
  if not found then return jsonb_build_object('state', 'invalid'); end if;
  if s.revoked_at is not null then return jsonb_build_object('state', 'revoked'); end if;
  if s.expires_at <= now() then return jsonb_build_object('state', 'expired'); end if;
  update public.route_shares set views = views + 1 where id = s.id;
  select * into t from public.tankers where id = s.tanker_id;
  -- The job now (the link outlives a job: the next one shows its area instead).
  select * into o from public.orders where tanker_id = t.id and status in ('accepted', 'arriving', 'arrived', 'collected') order by accepted_at desc limit 1;
  if o.id is not null then
    select * into l from public.order_locations where order_id = o.id;
    select name into z from public.zones where id = o.zone_id;
  end if;
  return jsonb_build_object(
    'state', 'live', 'expires_at', s.expires_at, 'plate', t.plate, 'service', t.service_type,
    'position', case when t.last_lat is not null then jsonb_build_object('lat', t.last_lat, 'lng', t.last_lng, 'at', t.last_fix_at,
                                                                         'age_s', extract(epoch from now() - t.last_fix_at)::int) end,
    'job', case when o.id is not null then jsonb_build_object(
             'stage', case when o.status = 'arrived' then 'at_destination' when o.status = 'collected' then 'to_plant' else 'on_the_way' end,
             'area', o.area, 'zone', z,
             'lat', round(l.lat::numeric, 2), 'lng', round(l.lng::numeric, 2)) end);
end $$;

revoke execute on function public.driver_sos(double precision, double precision, text), public.driver_share_route(integer),
  public.driver_revoke_route_share(uuid), public.shared_route(text) from public, anon;
grant execute on function public.driver_sos(double precision, double precision, text), public.driver_share_route(integer),
  public.driver_revoke_route_share(uuid) to authenticated;
grant execute on function public.shared_route(text) to anon, authenticated;
