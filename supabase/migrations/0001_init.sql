-- Nama tanker MVP: schema, pricing, RLS, order lifecycle RPCs, realtime.
--
-- Access model
--   * Clients never INSERT/UPDATE orders directly. Every state change goes
--     through a SECURITY DEFINER function that checks who is calling and
--     which transition is allowed.
--   * The exact delivery point lives in order_locations, which only the
--     customer and the assigned driver (while the job is active) can read.
--     Open requests expose service, gallons, area, distance and earnings.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.user_role    as enum ('customer', 'driver');
create type public.service_type as enum ('DW', 'WW', 'TE');
create type public.order_status as enum
  ('requested', 'accepted', 'arriving', 'arrived', 'delivered', 'cancelled');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.user_role not null,
  full_name  text not null default '' check (char_length(full_name) <= 120),
  phone      text check (char_length(phone) <= 32),
  created_at timestamptz not null default now()
);

-- One tanker per driver.
create table public.tankers (
  driver_id    uuid primary key references public.profiles (id) on delete cascade,
  plate        text not null unique check (char_length(plate) between 2 and 20),
  service_type public.service_type not null,
  capacity_gal integer not null check (capacity_gal between 100 and 20000),
  is_online    boolean not null default false,
  last_lat     double precision check (last_lat between -90 and 90),
  last_lng     double precision check (last_lng between -180 and 180),
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.profiles (id) on delete cascade,
  driver_id       uuid references public.profiles (id) on delete set null,
  service_type    public.service_type not null,
  gallons         integer not null check (gallons between 1 and 20000),
  area            text not null check (char_length(area) between 1 and 120),
  -- Money in OMR, 3 decimals (1 OMR = 1000 baisa).
  water_charge    numeric(10,3) not null,
  delivery_fee    numeric(10,3) not null,
  vat             numeric(10,3) not null,
  total           numeric(10,3) not null,
  driver_earnings numeric(10,3) not null,
  status          public.order_status not null default 'requested',
  -- Snapshot at acceptance so the customer keeps them after the job ends.
  driver_name     text,
  tanker_plate    text,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  arriving_at     timestamptz,
  arrived_at      timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz
);

create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_open_idx     on public.orders (service_type, gallons) where status = 'requested';

-- A driver can hold only one job at a time.
create unique index orders_one_active_job_per_driver
  on public.orders (driver_id)
  where status in ('accepted', 'arriving', 'arrived');

create table public.order_locations (
  order_id uuid primary key references public.orders (id) on delete cascade,
  lat      double precision not null check (lat between -90 and 90),
  lng      double precision not null check (lng between -180 and 180),
  address  text not null default '' check (char_length(address) <= 300)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.my_role()
returns public.user_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

-- Tariff. Mirrors lib/pricing.ts exactly; change both together.
--   DW: 1 baisa/gal for the first 650 gal, 3 baisa/gal above that (tiered)
--   WW: 1 baisa/gal        TE: 0.05 baisa/gal
--   Delivery fee: DW 3.500, WW 6.000, TE 8.000 OMR
--   VAT 5% on (water + delivery). Driver earns 85% of the delivery fee.
create function public.price_quote(p_type public.service_type, p_gallons integer)
returns table (water_charge numeric(10,3), delivery_fee numeric(10,3), vat numeric(10,3),
               total numeric(10,3), driver_earnings numeric(10,3))
language sql immutable
as $$
  with w as (
    select round(case p_type
             when 'DW' then (least(p_gallons, 650) * 1 + greatest(p_gallons - 650, 0) * 3)::numeric
             when 'WW' then p_gallons * 1::numeric
             when 'TE' then p_gallons * 0.05
           end / 1000, 3) as water,
           case p_type when 'DW' then 3.5 when 'WW' then 6 when 'TE' then 8 end::numeric as fee
  ), v as (
    select water, fee, round((water + fee) * 0.05, 3) as vat from w
  )
  select water::numeric(10,3), fee::numeric(10,3), vat::numeric(10,3),
         (water + fee + vat)::numeric(10,3), round(fee * 0.85, 3)::numeric(10,3)
    from v
$$;

-- Profile row created from sign-up metadata: { role, full_name, phone }.
create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    case when new.raw_user_meta_data ->> 'role' = 'driver' then 'driver'::public.user_role
         else 'customer'::public.user_role end,
    coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), ''),
    left(new.raw_user_meta_data ->> 'phone', 32)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.tankers         enable row level security;
alter table public.orders          enable row level security;
alter table public.order_locations enable row level security;

revoke all on public.profiles, public.tankers, public.orders, public.order_locations from anon, authenticated;

-- profiles: read and edit your own; a driver can read the customer on their active job.
grant select on public.profiles to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_select_my_job_customer on public.profiles
  for select to authenticated using (
    exists (select 1 from public.orders o
            where o.customer_id = profiles.id
              and o.driver_id = auth.uid()
              and o.status in ('accepted', 'arriving', 'arrived')));

create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- tankers: drivers manage their own; position is written only via report_location().
-- Customers read only the tanker on their own active order.
grant select on public.tankers to authenticated;
grant insert (driver_id, plate, service_type, capacity_gal) on public.tankers to authenticated;
grant update (plate, service_type, capacity_gal, is_online) on public.tankers to authenticated;

create policy tankers_driver_select on public.tankers
  for select to authenticated using (driver_id = auth.uid());

create policy tankers_driver_insert on public.tankers
  for insert to authenticated
  with check (driver_id = auth.uid() and public.my_role() = 'driver');

create policy tankers_driver_update on public.tankers
  for update to authenticated
  using (driver_id = auth.uid()) with check (driver_id = auth.uid());

create policy tankers_customer_active_order on public.tankers
  for select to authenticated using (
    exists (select 1 from public.orders o
            where o.driver_id = tankers.driver_id
              and o.customer_id = auth.uid()
              and o.status in ('accepted', 'arriving', 'arrived')));

-- orders: customers see their own; drivers see open requests and their own jobs.
-- No insert/update grants: writes go through the RPCs below.
grant select on public.orders to authenticated;

create policy orders_customer_select on public.orders
  for select to authenticated using (customer_id = auth.uid());

create policy orders_driver_select on public.orders
  for select to authenticated using (
    driver_id = auth.uid()
    or (status = 'requested' and public.my_role() = 'driver'));

-- order_locations: the customer, and the assigned driver while the job is active.
grant select on public.order_locations to authenticated;

create policy order_locations_select on public.order_locations
  for select to authenticated using (
    exists (select 1 from public.orders o
            where o.id = order_locations.order_id
              and (o.customer_id = auth.uid()
                   or (o.driver_id = auth.uid()
                       and o.status in ('accepted', 'arriving', 'arrived')))));

-- ---------------------------------------------------------------------------
-- Order lifecycle RPCs
-- Errors are raised with a stable machine-readable message the UI maps to text.
-- ---------------------------------------------------------------------------

-- Customer places a request. Price is computed here, never taken from the client.
create function public.place_order(
  p_service_type public.service_type,
  p_gallons      integer,
  p_lat          double precision,
  p_lng          double precision,
  p_area         text,
  p_address      text default ''
)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare
  o public.orders;
  q record;
begin
  if public.my_role() is distinct from 'customer' then
    raise exception 'not_a_customer';
  end if;
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then
    raise exception 'invalid_gallons';
  end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'invalid_location';
  end if;
  if coalesce(btrim(p_area), '') = '' then
    raise exception 'area_required';
  end if;

  select * into q from public.price_quote(p_service_type, p_gallons);

  insert into public.orders (customer_id, service_type, gallons, area,
                             water_charge, delivery_fee, vat, total, driver_earnings)
  values (auth.uid(), p_service_type, p_gallons, left(btrim(p_area), 120),
          q.water_charge, q.delivery_fee, q.vat, q.total, q.driver_earnings)
  returning * into o;

  insert into public.order_locations (order_id, lat, lng, address)
  values (o.id, p_lat, p_lng, left(coalesce(btrim(p_address), ''), 300));

  return o;
end $$;

-- Customer cancels while nobody has accepted yet. Atomic against accept_order.
create function public.cancel_order(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  update public.orders
     set status = 'cancelled', cancelled_at = now()
   where id = p_order_id
     and customer_id = auth.uid()
     and status = 'requested'
  returning * into o;

  if not found then
    if exists (select 1 from public.orders where id = p_order_id and customer_id = auth.uid()) then
      raise exception 'cannot_cancel';
    end if;
    raise exception 'not_found';
  end if;
  return o;
end $$;

-- Open requests matching the caller's tanker, nearest first.
-- Exposes distance and area only; the exact point is revealed after acceptance.
create function public.open_requests_near(p_lat double precision, p_lng double precision)
returns table (
  id              uuid,
  service_type    public.service_type,
  gallons         integer,
  area            text,
  distance_km     numeric,
  driver_earnings numeric(10,3),
  created_at      timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare t public.tankers;
begin
  select * into t from public.tankers where driver_id = auth.uid();
  if not found then raise exception 'not_a_driver'; end if;
  if not t.is_online then return; end if;

  return query
    select o.id, o.service_type, o.gallons, o.area,
           round((6371 * 2 * asin(sqrt(
             power(sin(radians(l.lat - p_lat) / 2), 2) +
             cos(radians(p_lat)) * cos(radians(l.lat)) *
             power(sin(radians(l.lng - p_lng) / 2), 2))))::numeric, 1) as distance_km,
           o.driver_earnings, o.created_at
      from public.orders o
      join public.order_locations l on l.order_id = o.id
     where o.status = 'requested'
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
     order by 5, o.created_at
     limit 50;
end $$;

-- Driver takes a job. The UPDATE only matches while status = 'requested', so of
-- two concurrent callers exactly one gets the row; the other sees already_taken.
create function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare
  t public.tankers;
  o public.orders;
  v_name text;
begin
  select * into t from public.tankers where driver_id = auth.uid();
  if not found then raise exception 'not_a_driver'; end if;
  if not t.is_online then raise exception 'driver_offline'; end if;

  if exists (select 1 from public.orders
             where driver_id = auth.uid() and status in ('accepted', 'arriving', 'arrived')) then
    raise exception 'driver_busy';
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  begin
    update public.orders
       set status = 'accepted',
           driver_id = auth.uid(),
           accepted_at = now(),
           driver_name = nullif(v_name, ''),
           tanker_plate = t.plate
     where id = p_order_id
       and status = 'requested'
       and service_type = t.service_type
       and gallons <= t.capacity_gal
    returning * into o;
  exception when unique_violation then
    -- Same driver accepting two jobs at once; the partial unique index wins.
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

-- Driver GPS ping. The first ping on an accepted job moves it to 'arriving'.
create function public.report_location(p_lat double precision, p_lng double precision)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'invalid_location';
  end if;

  update public.tankers
     set last_lat = p_lat, last_lng = p_lng, last_seen_at = now()
   where driver_id = auth.uid();
  if not found then raise exception 'not_a_driver'; end if;

  update public.orders
     set status = 'arriving', arriving_at = now()
   where driver_id = auth.uid() and status = 'accepted';
end $$;

create function public.mark_arrived(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  update public.orders
     set status = 'arrived',
         arrived_at = now(),
         arriving_at = coalesce(arriving_at, now())
   where id = p_order_id
     and driver_id = auth.uid()
     and status in ('accepted', 'arriving')
  returning * into o;
  if not found then raise exception 'invalid_transition'; end if;
  return o;
end $$;

create function public.mark_delivered(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  update public.orders
     set status = 'delivered', delivered_at = now()
   where id = p_order_id
     and driver_id = auth.uid()
     and status = 'arrived'
  returning * into o;
  if not found then raise exception 'invalid_transition'; end if;
  return o;
end $$;

-- Functions are callable by signed-in users only.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_role(),
  public.price_quote(public.service_type, integer),
  public.place_order(public.service_type, integer, double precision, double precision, text, text),
  public.cancel_order(uuid),
  public.open_requests_near(double precision, double precision),
  public.accept_order(uuid),
  public.report_location(double precision, double precision),
  public.mark_arrived(uuid),
  public.mark_delivered(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime (Postgres Changes honour the RLS policies above)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.orders, public.tankers;
