-- Test-zone orders and Omani orders never cross: a tanker matches only orders on
-- its own side, decided by where the tanker is (its last GPS fix; no fix counts
-- as Oman). Covers driver acceptance and NWS assignment through one trigger, and
-- open_requests_near lists only the driver's side.

-- True when a point lies in a test zone (active or not). Outside every zone → false.
create function public.position_is_test(p_lat double precision, p_lng double precision)
returns boolean language sql stable security definer set search_path = public
as $$
  select case when p_lat is null or p_lng is null then false
              else coalesce((public.zone_at(p_lat, p_lng, true)).is_test, false) end
$$;
revoke execute on function public.position_is_test(double precision, double precision) from public, anon;
grant execute on function public.position_is_test(double precision, double precision) to authenticated;

-- Taking an order (accept_order, staff_order_action 'assign'): the tanker must be on the order's side.
create function public.orders_match_side()
returns trigger language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  if new.tanker_id is not null and new.tanker_id is distinct from old.tanker_id then
    select * into t from public.tankers where id = new.tanker_id;
    if public.position_is_test(t.last_lat, t.last_lng) <> new.is_test then
      raise exception 'not_eligible: %', case when new.is_test then 'test-zone order; the tanker is not in the test zone'
                                               else 'Omani order; the tanker is in the test zone' end;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.orders_match_side() from public, anon, authenticated;
create trigger orders_match_side before update of tanker_id on public.orders
  for each row execute function public.orders_match_side();

-- Open requests: only the side the driver is on.
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
  created_at      timestamptz,
  is_emergency    boolean,
  slot_label      text,
  slot_end        timestamptz,
  channel         text,
  contract_no     bigint,
  is_test         boolean
)
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; side boolean;
begin
  t := public.my_tanker();
  perform public.release_due_orders();
  if not t.is_online or t.blocked or not public.tanker_company_active(t.id) or not public.tanker_has_valid_permit(t.id) then return; end if;
  side := public.position_is_test(p_lat, p_lng);

  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
           round(public.km(p_lat, p_lng, l.lat, l.lng)::numeric, 1) as distance_km,
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at, o.is_emergency, o.slot_label, o.slot_end, o.channel,
           k.contract_no, o.is_test
      from public.orders o
      join public.order_locations l on l.order_id = o.id
      left join public.contracts k on k.id = o.contract_id
     where o.status = 'requested'
       and o.is_test = side
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
       and (o.contract_id is null or (k.company_id = t.company_id and k.status = 'active'))
     order by o.is_emergency desc, 6, o.created_at
     limit 50;
end $$;
