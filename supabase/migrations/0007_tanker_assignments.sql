-- Tankers become first-class: tankers.id is the primary key, and drivers are
-- linked through tanker_assignments (at most one active assignment per driver
-- and per tanker). Permits, blocks and GPS attach to the tanker, not the driver.
--
-- Driver assignment will move to the tanker company portal; NWS operator
-- assignment (0008) stays as an override. Until then, a driver's onboarding
-- registers a tanker and assigns it to themselves (driver_register_tanker).

-- ---------------------------------------------------------------------------
-- tankers.id as primary key; tanker_assignments replaces tankers.driver_id
-- ---------------------------------------------------------------------------
alter table public.tankers add column id uuid not null default gen_random_uuid();

drop policy tankers_driver_select on public.tankers;
drop policy tankers_driver_insert on public.tankers;
drop policy tankers_driver_update on public.tankers;
drop policy tankers_customer_active_order on public.tankers;

alter table public.tankers drop constraint tankers_pkey;
alter table public.tankers add primary key (id);

create table public.tanker_assignments (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references public.profiles (id) on delete cascade,
  tanker_id     uuid not null references public.tankers (id) on delete cascade,
  assigned_at   timestamptz not null default now(),
  unassigned_at timestamptz,
  assigned_by   uuid references public.profiles (id) on delete set null,
  check (unassigned_at is null or unassigned_at >= assigned_at)
);
create unique index tanker_assignments_one_active_per_driver on public.tanker_assignments (driver_id) where unassigned_at is null;
create unique index tanker_assignments_one_active_per_tanker on public.tanker_assignments (tanker_id) where unassigned_at is null;

-- Migrate the existing one-driver-one-tanker links.
insert into public.tanker_assignments (driver_id, tanker_id, assigned_at, assigned_by)
select driver_id, id, created_at, driver_id from public.tankers;

-- Orders remember which tanker served them.
alter table public.orders add column tanker_id uuid references public.tankers (id) on delete set null;
update public.orders o
   set tanker_id = t.id
  from public.tankers t
 where o.driver_id is not null and t.driver_id = o.driver_id;
create unique index orders_one_active_job_per_tanker
  on public.orders (tanker_id)
  where status in ('accepted', 'arriving', 'arrived');

alter table public.tankers drop column driver_id;

-- Drivers no longer write tankers directly: registration and going online are RPCs.
revoke insert, update on public.tankers from authenticated;
revoke all on public.tanker_assignments from anon, authenticated;
grant select on public.tanker_assignments to authenticated;
alter table public.tanker_assignments enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers and RLS
-- ---------------------------------------------------------------------------
create function public.my_tanker_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select tanker_id from public.tanker_assignments where driver_id = auth.uid() and unassigned_at is null $$;

revoke execute on function public.my_tanker_id() from public, anon;
grant execute on function public.my_tanker_id() to authenticated;

create policy tankers_driver_select on public.tankers
  for select to authenticated using (id = public.my_tanker_id());

create policy tankers_customer_active_order on public.tankers
  for select to authenticated using (
    exists (select 1 from public.orders o
            where o.tanker_id = tankers.id
              and o.customer_id = auth.uid()
              and o.status in ('accepted', 'arriving', 'arrived')));

create policy tanker_assignments_driver_select on public.tanker_assignments
  for select to authenticated using (driver_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Driver RPCs
-- ---------------------------------------------------------------------------
-- Onboarding: register a tanker and assign it to yourself. Interim: the tanker
-- company portal will own tanker registration and driver assignment.
create function public.driver_register_tanker(p_plate text, p_service_type public.service_type, p_capacity_gal integer)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  if public.my_tanker_id() is not null then raise exception 'already_assigned'; end if;
  begin
    insert into public.tankers (plate, service_type, capacity_gal)
    values (upper(btrim(p_plate)), p_service_type, p_capacity_gal)
    returning * into t;
  exception when unique_violation then
    raise exception 'plate_taken';
  end;
  insert into public.tanker_assignments (driver_id, tanker_id, assigned_by) values (auth.uid(), t.id, auth.uid());
  return t;
end $$;

create function public.driver_set_online(p_online boolean)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  update public.tankers set is_online = coalesce(p_online, false)
   where id = public.my_tanker_id()
  returning * into t;
  if not found then raise exception 'no_tanker'; end if;
  return t;
end $$;

-- The driver's tanker, or a clear error (used by the RPCs below).
create function public.my_tanker()
returns public.tankers
language plpgsql stable security definer set search_path = public
as $$
declare t public.tankers;
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  select * into t from public.tankers where id = public.my_tanker_id();
  if not found then raise exception 'no_tanker'; end if;
  return t;
end $$;

create or replace function public.open_requests_near(p_lat double precision, p_lng double precision)
returns table (
  id              uuid,
  order_no        bigint,
  service_type    public.service_type,
  gallons         integer,
  area            text,
  distance_km     numeric,
  driver_earnings numeric(10,3),
  earnings_status text,
  created_at      timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare t public.tankers;
begin
  t := public.my_tanker();
  if not t.is_online then return; end if;

  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
           round((6371 * 2 * asin(sqrt(
             power(sin(radians(l.lat - p_lat) / 2), 2) +
             cos(radians(p_lat)) * cos(radians(l.lat)) *
             power(sin(radians(l.lng - p_lng) / 2), 2))))::numeric, 1) as distance_km,
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at
      from public.orders o
      join public.order_locations l on l.order_id = o.id
     where o.status = 'requested'
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
     order by 6, o.created_at
     limit 50;
end $$;

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
  if not t.is_online then raise exception 'driver_offline'; end if;

  if exists (select 1 from public.orders
             where (driver_id = auth.uid() or tanker_id = t.id) and status in ('accepted', 'arriving', 'arrived')) then
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
    returning * into o;
  exception when unique_violation then
    -- Same driver/tanker accepting two jobs at once; the partial unique indexes win.
    raise exception 'driver_busy';
  end;

  if not found then
    if exists (select 1 from public.orders where id = p_order_id and status = 'requested') then
      raise exception 'not_eligible';
    end if;
    raise exception 'already_taken';
  end if;
  return o;
end $$;

create or replace function public.report_location(
  p_lat         double precision,
  p_lng         double precision,
  p_accuracy_m  double precision,
  p_recorded_at timestamptz
)
returns void
language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'invalid_location';
  end if;
  if p_accuracy_m is null or p_accuracy_m < 0 then
    raise exception 'accuracy_required';
  end if;
  if p_accuracy_m > 100 then
    raise exception 'inaccurate_fix: accuracy % m is worse than 100 m', round(p_accuracy_m::numeric, 1);
  end if;
  if p_recorded_at is null or p_recorded_at < now() - interval '2 minutes' or p_recorded_at > now() + interval '5 minutes' then
    raise exception 'stale_fix';
  end if;

  t := public.my_tanker();
  if t.last_fix_at is not null and p_recorded_at <= t.last_fix_at then
    return; -- older than what we already have
  end if;

  -- GPS belongs to the tanker.
  update public.tankers
     set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy_m,
         last_fix_at = p_recorded_at, last_seen_at = now()
   where id = t.id;

  update public.orders
     set status = 'arriving', arriving_at = now()
   where tanker_id = t.id and driver_id = auth.uid() and status = 'accepted';
end $$;

revoke execute on function public.driver_register_tanker(text, public.service_type, integer), public.driver_set_online(boolean), public.my_tanker() from public, anon;
grant execute on function public.driver_register_tanker(text, public.service_type, integer), public.driver_set_online(boolean), public.my_tanker() to authenticated;
