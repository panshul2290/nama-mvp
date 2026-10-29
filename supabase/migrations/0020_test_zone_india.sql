-- A test service zone covering India, so developers and testers there can run
-- the whole customer and driver flow on real phones. NWS serves Oman only:
-- switch the zone off for production (NWS → Settings → Zones, or
--   update public.zones set active = false where is_test;).
--
--   * zones.is_test, plus an optional bounding box (min/max lat/lng). A zone with a
--     box contains exactly the points inside it; other zones stay centre + radius.
--     "Test – India" is a box around mainland India (68–97.5° E), far east of every
--     Omani zone (none reaches 61° E), and zone_at() ranks test zones last, so a
--     point inside any Omani zone always resolves to that zone.
--   * orders.is_test: set from the order's zone, frozen with it. NWS screens tag
--     these orders TEST and leave them out of KPIs, reports and invoices; automatic
--     and manual penalties are not issued on them.
--   * Virtual test sites: in a test order, filling and discharge are accepted (and
--     verified) wherever the tanker is, recorded against the "Test station" /
--     "Test plant" sites. Omani orders never use test sites; Oman geofences are
--     unchanged.
--   * Pricing: tariffs are global pricing rules (not per zone), so test orders are
--     priced exactly like Muscat ones, in OMR.

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.zones
  add column is_test boolean not null default false,
  add column min_lat double precision check (min_lat between -90 and 90),
  add column max_lat double precision check (max_lat between -90 and 90),
  add column min_lng double precision check (min_lng between -180 and 180),
  add column max_lng double precision check (max_lng between -180 and 180),
  add constraint zones_bbox_check check (
    (min_lat is null and max_lat is null and min_lng is null and max_lng is null)
    or (min_lat < max_lat and min_lng < max_lng));

alter table public.sites add column is_test boolean not null default false;

alter table public.orders add column is_test boolean not null default false;
create index orders_is_test_idx on public.orders (created_at) where is_test;

-- The flag follows the zone the order was placed in (zone_id is set by the server).
create function public.orders_set_is_test()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.zone_id is not null then
    new.is_test := coalesce((select z.is_test from public.zones z where z.id = new.zone_id), false);
  end if;
  return new;
end $$;
create trigger orders_set_is_test before insert or update of zone_id on public.orders
  for each row execute function public.orders_set_is_test();
revoke execute on function public.orders_set_is_test() from public, anon, authenticated;

-- ===========================================================================
-- The test zone and its virtual sites (active now; switch off for production)
-- ===========================================================================
insert into public.zones (name, governorate, center_lat, center_lng, radius_km, active, is_test, min_lat, max_lat, min_lng, max_lng)
values ('Test – India', 'Test – India', 22.0, 79.0, 1800, true, true, 6.5, 37.5, 68.0, 97.5)
on conflict (name) do nothing;

-- Coordinates are nominal: test trips accept filling / discharge at the tanker's position.
insert into public.sites (code, kind, name, service_types, lat, lng, radius_m, operator, is_test) values
  ('TEST-FILL', 'fill',      'Test station', '{DW,TE}', 22.0, 79.0, 5000, 'Test', true),
  ('TEST-DIS',  'discharge', 'Test plant',   '{WW}',    22.0, 79.0, 5000, 'Test', true)
on conflict (code) do nothing;

-- ===========================================================================
-- Zone matching: real (Omani) zones first, then the most specific (nearest centre)
-- ===========================================================================
create or replace function public.zone_at(p_lat double precision, p_lng double precision, p_include_inactive boolean default false)
returns public.zones language sql stable security definer set search_path = public
as $$
  select * from (
    select z.* from public.zones z
     where case when z.min_lat is not null
                then p_lat between z.min_lat and z.max_lat and p_lng between z.min_lng and z.max_lng
                else public.km(p_lat, p_lng, z.center_lat, z.center_lng) <= z.radius_km end
     order by z.is_test, public.km(p_lat, p_lng, z.center_lat, z.center_lng)
     limit 1) nearest
   where nearest.active or p_include_inactive
$$;

-- ===========================================================================
-- Trip legs: test orders fill and discharge at the tanker's position
-- ===========================================================================
create or replace function public.confirm_fill(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; s public.sites; d double precision; ok boolean; co uuid;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() and tanker_id = t.id for update;
  if not found then raise exception 'not_found'; end if;
  if o.service_type = 'WW' then raise exception 'no_fill_for_wastewater'; end if;
  if o.status not in ('accepted', 'arriving') then raise exception 'invalid_transition'; end if;
  if o.filled_at is not null then raise exception 'already_filled'; end if;
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
  co := t.company_id;
  if co is not null then
    insert into public.company_tx (company_id, driver_id, tanker_id, bucket, kind, amount, order_id, memo)
    values (co, auth.uid(), t.id, 'fill_credit', 'fill_charge', -o.water_charge, o.id, 'Filling at ' || s.name || ' for TO-' || o.order_no);
  end if;
  if not ok then
    perform public.raise_alert(t.id, o.id, 'Filling outside designated station', 'med',
                               format('%s confirmed filling for TO-%s outside %s geofence', t.plate, o.order_no, s.name), t.last_lat, t.last_lng, 'fill:' || o.id);
  end if;
  return o;
end $$;

create or replace function public.confirm_discharge(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; s public.sites; d double precision; ok boolean;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'collected' then raise exception 'invalid_transition'; end if;
  if o.is_test then
    select x.* into s from public.sites x where x.kind = 'discharge' and x.is_test and o.service_type = any(x.service_types) limit 1;
    if s.id is null then raise exception 'no_discharge_site'; end if;
    ok := true;
  else
    select x.* into s from public.sites x where x.kind = 'discharge' and x.active and not x.is_test and o.service_type = any(x.service_types)
     order by public.km(coalesce(t.last_lat, 0), coalesce(t.last_lng, 0), x.lat, x.lng) limit 1;
    if s.id is null then raise exception 'no_discharge_site'; end if;
    d := case when t.last_lat is null then null else public.km(t.last_lat, t.last_lng, s.lat, s.lng) * 1000 end;
    ok := d is not null and d <= s.radius_m and t.last_fix_at > now() - interval '5 minutes';
  end if;
  insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, lat, lng, verified, note)
  values (o.id, t.id, 'stp', 'discharge', s.id, o.gallons, t.last_lat, t.last_lng, ok,
          case when o.is_test then 'Test zone: discharge accepted at the tanker''s position'
               when ok then 'Valve opened inside geofence'
               else format('Valve opened %s m from %s (radius %s m)', coalesce(round(d)::text, 'unknown'), s.name, s.radius_m) end);
  update public.orders set status = 'delivered', delivered_at = now(), discharged_at = now(), discharge_site_id = s.id, discharge_verified = ok
   where id = o.id returning * into o;
  perform public.settle_order(o.id);
  select * into o from public.orders where id = o.id;
  if not ok then
    perform public.raise_alert(t.id, o.id, 'Discharge outside approved zone', 'high',
                               format('%s discharged TO-%s outside %s geofence', t.plate, o.order_no, s.name), t.last_lat, t.last_lng, 'discharge:' || o.id);
    perform public.issue_penalty('discharge_outside', o.id, t.id, 'Discharge outside approved geofence', 'IVMS valve sensor + GPS');
  end if;
  return o;
end $$;

-- ===========================================================================
-- Open requests carry is_test, so the driver app can tag them and use test sites
-- ===========================================================================
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
declare t public.tankers;
begin
  t := public.my_tanker();
  perform public.release_due_orders();
  if not t.is_online or t.blocked or not public.tanker_company_active(t.id) or not public.tanker_has_valid_permit(t.id) then return; end if;

  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
           round(public.km(p_lat, p_lng, l.lat, l.lng)::numeric, 1) as distance_km,
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at, o.is_emergency, o.slot_label, o.slot_end, o.channel,
           k.contract_no, o.is_test
      from public.orders o
      join public.order_locations l on l.order_id = o.id
      left join public.contracts k on k.id = o.contract_id
     where o.status = 'requested'
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
       and (o.contract_id is null or (k.company_id = t.company_id and k.status = 'active'))
     order by o.is_emergency desc, 6, o.created_at
     limit 50;
end $$;
revoke execute on function public.open_requests_near(double precision, double precision) from public, anon;
grant execute on function public.open_requests_near(double precision, double precision) to authenticated;

-- ===========================================================================
-- No penalties on test orders (late delivery, short volume, discharge, manual)
-- ===========================================================================
create or replace function public.issue_penalty(p_rule text, p_order uuid, p_tanker uuid, p_reason text, p_evidence text default '', p_amount numeric default null)
returns public.penalties
language plpgsql security definer set search_path = public
as $$
declare rule public.penalty_rules; o public.orders; p public.penalties; amt numeric;
begin
  select * into rule from public.penalty_rules where code = p_rule;
  if not found then raise exception 'unknown_penalty_rule'; end if;
  if not rule.active then return null; end if;
  if p_order is not null then select * into o from public.orders where id = p_order; end if;
  if o.is_test then return null; end if;
  amt := coalesce(p_amount, case when rule.amount_kind = 'pct' then round(coalesce(o.total, 0) * rule.amount / 100, 3) else rule.amount end);
  if p_order is not null and exists (select 1 from public.penalties where order_id = p_order and rule_code = p_rule and state <> 'cancelled') then
    return null;
  end if;
  insert into public.penalties (rule_code, company_id, tanker_id, driver_id, order_id, customer_id, org_id, amount, reason, evidence, created_by)
  values (p_rule,
          case when rule.party = 'driver' then public.tanker_company(coalesce(p_tanker, o.tanker_id)) end,
          case when rule.party = 'driver' then coalesce(p_tanker, o.tanker_id) end,
          case when rule.party = 'driver' then coalesce(o.driver_id, (select driver_id from public.tanker_assignments where tanker_id = p_tanker and unassigned_at is null)) end,
          p_order,
          case when rule.party = 'customer' then o.customer_id end,
          case when rule.party = 'business' then o.org_id end,
          amt, p_reason, coalesce(p_evidence, ''), auth.uid())
  returning * into p;
  if p.company_id is not null and amt > 0 then
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, penalty_id, memo)
    values (p.company_id, p.driver_id, p.tanker_id, 'penalty', -amt, p_order, p.id, rule.label);
    perform public.notify(m.id, 'penalty_issued', p_order, jsonb_build_object('amount', to_char(amt, 'FM9990.000'), 'reason', rule.label))
       from public.profiles m where m.company_id = p.company_id and m.role = 'owner';
    perform public.notify(p.driver_id, 'penalty_issued', p_order, jsonb_build_object('amount', to_char(amt, 'FM9990.000'), 'reason', rule.label));
  elsif p.customer_id is not null and amt > 0 then
    perform public.lock_wallet(p.customer_id);
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (p.customer_id, 'cancel_fee', -amt, p_order, rule.label);
  end if;
  return p;
end $$;

-- ===========================================================================
-- Business invoices never include test orders
-- ===========================================================================
create or replace function public.invoice_org(p_org uuid)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare inv public.invoices; org public.organizations; ids uuid[]; n integer; v numeric; tot numeric; first_at timestamptz;
begin
  select * into org from public.organizations where id = p_org for update;
  select array_agg(id) into ids from (
    select id from public.orders where org_id = p_org and billing = 'account' and status = 'delivered' and invoice_id is null and not is_test for update) x;
  if ids is null then raise exception 'nothing_to_invoice'; end if;
  select count(*), coalesce(sum(vat), 0), coalesce(sum(total - short_credit), 0), min(delivered_at)
    into n, v, tot, first_at
    from public.orders where id = any(ids);
  insert into public.invoices (org_id, period_start, period_end, orders, subtotal, vat, total, due_at)
  values (p_org, first_at::date, current_date, n, tot - v, v, tot, now() + make_interval(days => org.terms_days)) returning * into inv;
  update public.orders set invoice_id = inv.id where id = any(ids);
  perform public.notify(m.id, 'invoice_issued', null, jsonb_build_object('invoice', 'INV-' || inv.invoice_no, 'amount', to_char(tot, 'FM99990.000')))
     from public.profiles m where m.org_id = p_org and m.org_role in ('admin', 'finance');
  return inv;
end $$;
