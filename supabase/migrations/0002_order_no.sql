-- Human-readable order numbers (shown as TO-<order_no>).
--
--   * Backed by public.orders_order_no_seq, starting at 48200.
--   * Assigned only by a BEFORE INSERT trigger, which ignores any supplied value,
--     and frozen by a BEFORE UPDATE trigger. Clients also have no INSERT/UPDATE
--     rights on orders and no access to the sequence.
--   * Existing orders are numbered in created_at order before NOT NULL/UNIQUE.

create sequence public.orders_order_no_seq as bigint start with 48200 minvalue 48200;

alter table public.orders add column order_no bigint;

-- Backfill deterministically by creation time (nextval inside UPDATE has no order guarantee).
update public.orders o
   set order_no = 48199 + r.rn
  from (select id, row_number() over (order by created_at, id) as rn from public.orders) r
 where o.id = r.id;

-- Continue after the backfilled numbers (or start fresh at 48200 if there were none).
select case
         when max(order_no) is null then setval('public.orders_order_no_seq', 48200, false)
         else setval('public.orders_order_no_seq', max(order_no), true)
       end
  from public.orders;

alter table public.orders alter column order_no set not null;
alter table public.orders add constraint orders_order_no_key unique (order_no);
alter sequence public.orders_order_no_seq owned by public.orders.order_no;

revoke all on sequence public.orders_order_no_seq from public, anon, authenticated;

create function public.assign_order_no()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.order_no := nextval('public.orders_order_no_seq');
  return new;
end $$;

create function public.freeze_order_no()
returns trigger
language plpgsql
as $$
begin
  if new.order_no is distinct from old.order_no then
    raise exception 'order_no_immutable';
  end if;
  return new;
end $$;

create trigger orders_assign_order_no
  before insert on public.orders
  for each row execute function public.assign_order_no();

create trigger orders_freeze_order_no
  before update of order_no on public.orders
  for each row execute function public.freeze_order_no();

revoke execute on function public.assign_order_no(), public.freeze_order_no() from public, anon, authenticated;

-- RPCs returning public.orders (place_order, cancel_order, accept_order,
-- mark_arrived, mark_delivered) pick up the new column automatically.
-- open_requests_near lists its columns explicitly, so recreate it with order_no.
drop function public.open_requests_near(double precision, double precision);

create function public.open_requests_near(p_lat double precision, p_lng double precision)
returns table (
  id              uuid,
  order_no        bigint,
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
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
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
     order by 6, o.created_at
     limit 50;
end $$;

revoke execute on function public.open_requests_near(double precision, double precision) from public, anon;
grant execute on function public.open_requests_near(double precision, double precision) to authenticated;
