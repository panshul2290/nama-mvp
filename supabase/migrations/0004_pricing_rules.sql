-- Pricing governance.
--
--   * Every tariff figure lives in public.pricing_rules with a status:
--       confirmed              — taken from the tender's tariff table
--       pending_clarification  — awaiting an answer from NWS (query ID in source)
--       assumption             — our placeholder, no tender basis yet
--   * Orders are priced by a BEFORE INSERT trigger that reads only this table.
--     Clients (and place_order) never supply prices.
--   * Each order records the status of the rules behind each price line
--     (orders.price_basis), so screens can flag unconfirmed lines.
--   * BILLING_MODE (public.app_settings): 'demo' (default) prices with any rule;
--     'production' refuses to price an order if any rule it uses isn't confirmed.

create type public.rule_status as enum ('confirmed', 'pending_clarification', 'assumption');

create table public.pricing_rules (
  rule_key   text primary key check (rule_key ~ '^[a-z0-9_]+$'),
  value      text not null,
  status     public.rule_status not null,
  source     text not null,
  notes      text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.pricing_rules (rule_key, value, status, source, notes) values
  -- confirmed: tender tariff table
  ('dw_tier_threshold_gal', '650',  'confirmed', 'Tender tariff table', 'Drinking water: first tier ends at 650 gallons.'),
  ('dw_rate_upto_650',      '1',    'confirmed', 'Tender tariff table', 'Drinking water, up to 650 gal: baisa per gallon.'),
  ('ww_rate',               '1',    'confirmed', 'Tender tariff table', 'Wastewater: baisa per gallon.'),
  ('te_rate',               '0.05', 'confirmed', 'Tender tariff table', 'Treated effluent: baisa per gallon.'),
  -- pending clarification from NWS
  ('dw_rate_above_650',     '3',    'pending_clarification', 'Q05', 'Drinking water above 650 gal: baisa per gallon. How it applies depends on dw_above_650_basis.'),
  ('dw_above_650_basis',    'slab', 'pending_clarification', 'Q05', 'slab = 3 baisa only on the gallons above 650 (first 650 at 1 baisa); whole_volume = 3 baisa on every gallon once the order exceeds 650.'),
  ('vat_rate',              '0.05', 'pending_clarification', 'Q07', 'VAT application: currently 5% on (water charge + delivery fee). Whether VAT applies to the regulated water charge, the delivery fee, or both is awaiting NWS.'),
  -- assumptions (no tender basis yet)
  ('fee_dw_omr',            '3.5',  'assumption', 'Prototype assumption — no tender clause', 'Delivery base fee, drinking water (OMR).'),
  ('fee_ww_omr',            '6',    'assumption', 'Prototype assumption — no tender clause', 'Delivery base fee, wastewater (OMR).'),
  ('fee_te_omr',            '8',    'assumption', 'Prototype assumption — no tender clause', 'Delivery base fee, treated effluent (OMR).'),
  ('driver_share',          '0.85', 'assumption', 'Prototype assumption — no tender clause', 'Driver''s share of the delivery fee (fraction).'),
  ('peak_multiplier',       '1.2',  'assumption', 'Prototype assumption — no tender clause', 'Evening peak multiplier on the delivery fee. Not used by the MVP (no delivery slots).'),
  ('priority_multiplier',   '1.5',  'assumption', 'Prototype assumption — no tender clause', 'Priority/emergency multiplier on the delivery fee. Not used by the MVP.'),
  ('discount_monthly',      '0.10', 'assumption', 'Prototype assumption — no tender clause', 'Monthly plan discount on the delivery fee (fraction). Not used by the MVP (no plans).'),
  ('discount_yearly',       '0.15', 'assumption', 'Prototype assumption — no tender clause', 'Yearly plan discount on the delivery fee (fraction). Not used by the MVP (no plans).'),
  ('cancel_fee_omr',        '1',    'assumption', 'Prototype assumption — no tender clause', 'Cancellation fee once a tanker is assigned (OMR). Not used: the MVP only allows free cancellation before acceptance.');

create table public.app_settings (
  key   text primary key,
  value text not null,
  notes text not null default '',
  check (key <> 'BILLING_MODE' or value in ('demo', 'production'))
);
insert into public.app_settings (key, value, notes) values
  ('BILLING_MODE', 'demo', 'demo: price with any rule (non-confirmed lines are flagged). production: refuse to price an order unless every rule it uses is confirmed.');

-- Readable by signed-in users (the app shows statuses); writable by nobody but the database owner.
alter table public.pricing_rules enable row level security;
alter table public.app_settings  enable row level security;
revoke all on public.pricing_rules, public.app_settings from anon, authenticated;
grant select on public.pricing_rules, public.app_settings to authenticated;
create policy pricing_rules_read on public.pricing_rules for select to authenticated using (true);
create policy app_settings_read  on public.app_settings  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Pricing from rules
-- ---------------------------------------------------------------------------
create function public.rule_rank(s public.rule_status)
returns integer language sql immutable
as $$ select case s when 'confirmed' then 0 when 'assumption' then 1 else 2 end $$;

create function public.worst_status(variadic s public.rule_status[])
returns public.rule_status language sql immutable
as $$ select x from unnest(s) x order by public.rule_rank(x) desc limit 1 $$;

drop function public.price_quote(public.service_type, integer);

create function public.price_quote(p_type public.service_type, p_gallons integer)
returns table (
  water_charge    numeric(10,3),
  delivery_fee    numeric(10,3),
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
language plpgsql stable security definer set search_path = public
as $$
declare
  r  record;
  v  jsonb := '{}';   -- rule_key -> {value, status}
  used text[] := '{}';
  w_rules text[];
  fee_key text := 'fee_' || lower(p_type::text) || '_omr';
  thr numeric; water_baisa numeric; fee numeric; vat_rate numeric; share numeric;
  ws public.rule_status; fs public.rule_status; vs public.rule_status; ss public.rule_status;
begin
  for r in select rule_key, value, status from public.pricing_rules loop
    v := v || jsonb_build_object(r.rule_key, jsonb_build_object('value', r.value, 'status', r.status));
  end loop;

  if p_type = 'DW' then
    w_rules := array['dw_tier_threshold_gal', 'dw_rate_upto_650'];
    thr := (v -> 'dw_tier_threshold_gal' ->> 'value')::numeric;
    if p_gallons <= thr then
      water_baisa := p_gallons * (v -> 'dw_rate_upto_650' ->> 'value')::numeric;
    else
      w_rules := w_rules || array['dw_rate_above_650', 'dw_above_650_basis'];
      water_baisa := case v -> 'dw_above_650_basis' ->> 'value'
        when 'slab' then thr * (v -> 'dw_rate_upto_650' ->> 'value')::numeric
                         + (p_gallons - thr) * (v -> 'dw_rate_above_650' ->> 'value')::numeric
        when 'whole_volume' then p_gallons * (v -> 'dw_rate_above_650' ->> 'value')::numeric
      end;
    end if;
  elsif p_type = 'WW' then
    w_rules := array['ww_rate'];
    water_baisa := p_gallons * (v -> 'ww_rate' ->> 'value')::numeric;
  else
    w_rules := array['te_rate'];
    water_baisa := p_gallons * (v -> 'te_rate' ->> 'value')::numeric;
  end if;

  used := w_rules || array[fee_key, 'vat_rate', 'driver_share'];
  for i in 1 .. array_length(used, 1) loop
    if not v ? used[i] then raise exception 'pricing_rule_missing: %', used[i]; end if;
  end loop;
  if water_baisa is null then raise exception 'pricing_rule_invalid: dw_above_650_basis must be slab or whole_volume'; end if;

  fee      := (v -> fee_key ->> 'value')::numeric;
  vat_rate := (v -> 'vat_rate' ->> 'value')::numeric;
  share    := (v -> 'driver_share' ->> 'value')::numeric;

  select public.worst_status(variadic array_agg((v -> k ->> 'status')::public.rule_status)) into ws from unnest(w_rules) k;
  fs := (v -> fee_key ->> 'status')::public.rule_status;
  ss := (v -> 'driver_share' ->> 'status')::public.rule_status;
  vs := public.worst_status((v -> 'vat_rate' ->> 'status')::public.rule_status, ws, fs);

  water_charge    := round(water_baisa / 1000, 3);
  delivery_fee    := round(fee, 3);
  vat             := round((water_charge + delivery_fee) * vat_rate, 3);
  total           := water_charge + delivery_fee + vat;
  driver_earnings := round(fee * share, 3);
  water_status    := ws;
  fee_status      := fs;
  vat_status      := vs;
  total_status    := public.worst_status(ws, fs, vs);
  earnings_status := public.worst_status(fs, ss);
  rules_used      := used;
  return next;
end $$;

revoke execute on function public.price_quote(public.service_type, integer) from public, anon;
grant execute on function public.price_quote(public.service_type, integer) to authenticated;
revoke execute on function public.rule_rank(public.rule_status), public.worst_status(public.rule_status[]) from public, anon;

alter table public.orders add column price_basis jsonb;

-- Existing orders were priced with today's rule values; record their statuses.
update public.orders o
   set price_basis = (
         select jsonb_build_object(
                  'water', q.water_status, 'fee', q.fee_status, 'vat', q.vat_status,
                  'total', q.total_status, 'earnings', q.earnings_status,
                  'rules', to_jsonb(q.rules_used), 'mode', 'demo', 'backfilled', true)
           from public.price_quote(o.service_type, o.gallons) q)
 where o.price_basis is null;

create function public.price_order()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  q record;
  mode text;
  bad text;
begin
  select * into q from public.price_quote(new.service_type, new.gallons);
  select value into mode from public.app_settings where key = 'BILLING_MODE';
  mode := coalesce(mode, 'demo');

  if mode = 'production' then
    select string_agg(format('%s (%s, %s)', p.rule_key, p.status, p.source), ', ' order by p.rule_key) into bad
      from public.pricing_rules p
     where p.rule_key = any(q.rules_used) and p.status <> 'confirmed';
    if bad is not null then
      raise exception 'pricing_unconfirmed: BILLING_MODE is production and these pricing rules are not confirmed: %', bad;
    end if;
  end if;

  -- Whatever the caller supplied, the price comes from the rules.
  new.water_charge    := q.water_charge;
  new.delivery_fee    := q.delivery_fee;
  new.vat             := q.vat;
  new.total           := q.total;
  new.driver_earnings := q.driver_earnings;
  new.price_basis := jsonb_build_object(
    'water', q.water_status, 'fee', q.fee_status, 'vat', q.vat_status,
    'total', q.total_status, 'earnings', q.earnings_status,
    'rules', to_jsonb(q.rules_used), 'mode', mode);
  return new;
end $$;

revoke execute on function public.price_order() from public, anon, authenticated;

create trigger orders_price
  before insert on public.orders
  for each row execute function public.price_order();

-- Prices are frozen after insert, like order_no.
create function public.freeze_price()
returns trigger
language plpgsql
as $$
begin
  if (new.water_charge, new.delivery_fee, new.vat, new.total, new.driver_earnings, new.price_basis)
     is distinct from (old.water_charge, old.delivery_fee, old.vat, old.total, old.driver_earnings, old.price_basis) then
    raise exception 'price_immutable';
  end if;
  return new;
end $$;

create trigger orders_freeze_price
  before update of water_charge, delivery_fee, vat, total, driver_earnings, price_basis on public.orders
  for each row execute function public.freeze_price();

revoke execute on function public.freeze_price() from public, anon, authenticated;

-- place_order no longer prices anything; the trigger does.
create or replace function public.place_order(
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
declare o public.orders;
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

  insert into public.orders (customer_id, service_type, gallons, area)
  values (auth.uid(), p_service_type, p_gallons, left(btrim(p_area), 120))
  returning * into o;

  insert into public.order_locations (order_id, lat, lng, address)
  values (o.id, p_lat, p_lng, left(coalesce(btrim(p_address), ''), 300));

  return o;
end $$;

-- open_requests_near also reports whether the driver's earnings rest on unconfirmed rules.
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
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at
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
