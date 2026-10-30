-- Money and price integrity, part 1 of 3: who sets the price, and that it never moves.
--
--   #44 tariff_classes    the water tariff per service and tanker capacity class (gallons
--                         range, baisa per gallon, status). The order's volume picks the class
--                         (the tanker that will be sent). How classes apply is the pricing rule
--                         tariff_basis (Q05): 'slab' charges each class's gallons at its rate,
--                         as today; 'whole_volume' charges every gallon at the picked class's
--                         rate. It replaces dw_tier_threshold_gal / dw_rate_* / ww_rate / te_rate
--                         and dw_above_650_basis, whose current values and statuses are migrated.
--   #45 delivery_charges  the delivery charge per zone (or the default for every zone),
--                         service and capacity class, in OMR, with a status. It replaces
--                         fee_dw_omr / fee_ww_omr / fee_te_omr (migrated as the defaults), so
--                         today's prices are unchanged. The quote takes the charge of the zone
--                         of the delivery point, else the default. The 0026 multipliers (peak,
--                         priority, distance, demand, capped) still apply to it, neutral by
--                         default as before; driver earnings stay driver_share × the charge.
--                         NWS → Settings → Pricing edits both tables (admin and finance only,
--                         every change audited).
--   #1  price lock        the order stores the whole breakdown at creation (price_basis v2:
--                         lines, tariff class and slabs, delivery charge and zone, multipliers,
--                         VAT rate, driver share), and a trigger refuses any later change to the
--                         price, the volume or the service, except inside an audited NWS staff
--                         RPC (staff_adjust_order_price; refunds never touch the price). Drivers
--                         and owners can never set a price: no RPC of theirs takes one.
--                         order_collect_omr() says what a driver collects at the door (cash on
--                         delivery only); open_requests_near returns it for the job offer.

-- ===========================================================================
-- Tables
-- ===========================================================================
create table public.tariff_classes (
  id           uuid primary key default gen_random_uuid(),
  service_type public.service_type not null,
  code         text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  min_gal      integer not null check (min_gal between 1 and 20000),
  max_gal      integer check (max_gal is null or (max_gal >= min_gal and max_gal <= 20000)),
  rate_baisa   numeric(10,4) not null check (rate_baisa >= 0 and rate_baisa <= 1000),
  status       public.rule_status not null,
  source       text not null check (char_length(btrim(source)) between 1 and 200),
  notes        text not null default '' check (char_length(notes) <= 500),
  active       boolean not null default true,
  updated_at   timestamptz not null default now(),
  unique (id, service_type)
);
create index tariff_classes_service_idx on public.tariff_classes (service_type, min_gal) where active;

create table public.delivery_charges (
  id           uuid primary key default gen_random_uuid(),
  zone_id      uuid references public.zones (id) on delete cascade,   -- null: the default for every zone
  service_type public.service_type not null,
  class_id     uuid not null,
  amount_omr   numeric(10,3) not null check (amount_omr >= 0 and amount_omr <= 1000),
  status       public.rule_status not null,
  source       text not null check (char_length(btrim(source)) between 1 and 200),
  notes        text not null default '' check (char_length(notes) <= 500),
  updated_at   timestamptz not null default now(),
  foreign key (class_id, service_type) references public.tariff_classes (id, service_type) on delete cascade
);
create unique index delivery_charges_zone_class on public.delivery_charges (zone_id, class_id) where zone_id is not null;
create unique index delivery_charges_default_class on public.delivery_charges (class_id) where zone_id is null;

-- Active classes of one service never overlap.
create function public.tariff_classes_no_overlap()
returns trigger
language plpgsql
as $$
begin
  if new.active and exists (
       select 1 from public.tariff_classes x
        where x.service_type = new.service_type and x.active and x.id <> new.id
          and x.min_gal <= coalesce(new.max_gal, 20000) and new.min_gal <= coalesce(x.max_gal, 20000)) then
    raise exception 'tariff_class_overlap: % % – % gal overlaps another active class', new.service_type, new.min_gal, coalesce(new.max_gal::text, '…');
  end if;
  return new;
end $$;
create trigger tariff_classes_overlap before insert or update on public.tariff_classes
  for each row execute function public.tariff_classes_no_overlap();
revoke execute on function public.tariff_classes_no_overlap() from public, anon, authenticated;

alter table public.tariff_classes enable row level security;
alter table public.delivery_charges enable row level security;
revoke all on public.tariff_classes, public.delivery_charges from anon, authenticated;
grant select on public.tariff_classes, public.delivery_charges to authenticated;
-- Prices are public to signed-in users (quotes show them), like pricing_rules.
create policy tariff_classes_read on public.tariff_classes for select to authenticated using (true);
create policy delivery_charges_read on public.delivery_charges for select to authenticated using (true);

-- ===========================================================================
-- Migrate today's rules (their current values, statuses and sources)
-- ===========================================================================
insert into public.tariff_classes (service_type, code, min_gal, max_gal, rate_baisa, status, source, notes)
select 'DW', 'DW-1', 1, thr.value::integer, r.value::numeric, r.status, r.source, 'Drinking water, tankers up to the first-tier threshold.'
  from public.pricing_rules r, public.pricing_rules thr
 where r.rule_key = 'dw_rate_upto_650' and thr.rule_key = 'dw_tier_threshold_gal';
insert into public.tariff_classes (service_type, code, min_gal, max_gal, rate_baisa, status, source, notes)
select 'DW', 'DW-2', thr.value::integer + 1, null, r.value::numeric, r.status, r.source, 'Drinking water, tankers above the first-tier threshold (tender: 3 baisa/gal above 650 gal).'
  from public.pricing_rules r, public.pricing_rules thr
 where r.rule_key = 'dw_rate_above_650' and thr.rule_key = 'dw_tier_threshold_gal';
insert into public.tariff_classes (service_type, code, min_gal, max_gal, rate_baisa, status, source, notes)
select 'WW', 'WW-1', 1, null, value::numeric, status, source, 'Wastewater, every tanker size.' from public.pricing_rules where rule_key = 'ww_rate';
insert into public.tariff_classes (service_type, code, min_gal, max_gal, rate_baisa, status, source, notes)
select 'TE', 'TE-1', 1, null, value::numeric, status, source, 'Treated effluent, every tanker size.' from public.pricing_rules where rule_key = 'te_rate';

-- One default delivery charge per class, from the service's old base fee.
insert into public.delivery_charges (zone_id, service_type, class_id, amount_omr, status, source, notes)
select null, c.service_type, c.id, r.value::numeric, r.status, r.source, 'Migrated from ' || r.rule_key || '.'
  from public.tariff_classes c
  join public.pricing_rules r on r.rule_key = 'fee_' || lower(c.service_type::text) || '_omr';

update public.pricing_rules
   set rule_key = 'tariff_basis',
       notes = 'How the tariff classes apply once an order is above the service''s first class (Q05). slab = each class''s gallons at its own rate (first 650 gal at 1 baisa, the rest at 3); whole_volume = every gallon at the rate of the class the volume falls in.',
       updated_at = now()
 where rule_key = 'dw_above_650_basis';
delete from public.pricing_rules
 where rule_key in ('dw_tier_threshold_gal', 'dw_rate_upto_650', 'dw_rate_above_650', 'ww_rate', 'te_rate', 'fee_dw_omr', 'fee_ww_omr', 'fee_te_omr');

-- ===========================================================================
-- Pricing engine
-- ===========================================================================
-- The water charge and the base delivery charge for a volume, from the class the volume
-- falls in and the delivery charge of the zone (else the default).
create function public.price_base(p_type public.service_type, p_gallons integer, p_zone uuid default null)
returns table (
  water_charge numeric(10,3),
  base_fee     numeric(10,3),
  water_status public.rule_status,
  fee_status   public.rule_status,
  rules_used   text[],
  tariff       jsonb,
  delivery     jsonb
)
language plpgsql stable security definer set search_path = public
as $$
declare
  c public.tariff_classes; s public.tariff_classes; d public.delivery_charges; basis public.pricing_rules;
  water numeric := 0; ws public.rule_status; slabs jsonb := '[]'; n integer; used text[] := '{}'; zname text;
begin
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  select * into c from public.tariff_classes x
   where x.service_type = p_type and x.active and p_gallons >= x.min_gal and (x.max_gal is null or p_gallons <= x.max_gal)
   order by x.min_gal desc limit 1;
  if not found then raise exception 'tariff_class_missing: no active % tariff class covers % gal', p_type, p_gallons; end if;
  ws := c.status;
  if exists (select 1 from public.tariff_classes x where x.service_type = p_type and x.active and x.min_gal < c.min_gal) then
    -- Above the first class: slab or whole volume (Q05).
    select * into basis from public.pricing_rules where rule_key = 'tariff_basis';
    if not found then raise exception 'pricing_rule_missing: tariff_basis'; end if;
    used := array['tariff_basis'];
    ws := public.worst_status(ws, basis.status);
    if basis.value = 'slab' then
      for s in select * from public.tariff_classes x where x.service_type = p_type and x.active and x.min_gal <= p_gallons order by x.min_gal loop
        n := least(p_gallons, coalesce(s.max_gal, p_gallons)) - s.min_gal + 1;
        water := water + n * s.rate_baisa;
        ws := public.worst_status(ws, s.status);
        slabs := slabs || jsonb_build_object('class_id', s.id, 'code', s.code, 'gallons', n, 'rate_baisa', s.rate_baisa, 'status', s.status);
      end loop;
    elsif basis.value = 'whole_volume' then
      water := p_gallons * c.rate_baisa;
    else
      raise exception 'pricing_rule_invalid: tariff_basis must be slab or whole_volume';
    end if;
  else
    water := p_gallons * c.rate_baisa;
  end if;
  if jsonb_array_length(slabs) = 0 then
    slabs := jsonb_build_array(jsonb_build_object('class_id', c.id, 'code', c.code, 'gallons', p_gallons, 'rate_baisa', c.rate_baisa, 'status', c.status));
  end if;

  if p_zone is not null then
    select * into d from public.delivery_charges where class_id = c.id and zone_id = p_zone;
  end if;
  if d.id is null then
    select * into d from public.delivery_charges where class_id = c.id and zone_id is null;
  end if;
  if d.id is null then raise exception 'delivery_charge_missing: no delivery charge for % class % (zone or default)', p_type, c.code; end if;
  if d.zone_id is not null then select name into zname from public.zones where id = d.zone_id; end if;

  water_charge := round(water / 1000, 3);
  base_fee     := round(d.amount_omr, 3);
  water_status := ws;
  fee_status   := d.status;
  rules_used   := used;
  tariff := jsonb_build_object('class_id', c.id, 'code', c.code, 'service_type', c.service_type, 'min_gal', c.min_gal, 'max_gal', c.max_gal,
                               'rate_baisa', c.rate_baisa, 'status', c.status, 'source', c.source,
                               'basis', case when cardinality(used) > 0 then basis.value end, 'slabs', slabs);
  delivery := jsonb_build_object('charge_id', d.id, 'zone_id', d.zone_id, 'zone', zname, 'is_default', d.zone_id is null,
                                 'amount', d.amount_omr, 'status', d.status, 'source', d.source);
  return next;
end $$;

-- Same columns as before (0004); the figures now come from the class and the default charge.
create or replace function public.price_quote(p_type public.service_type, p_gallons integer)
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
declare b record; vr public.pricing_rules; sh public.pricing_rules;
begin
  select * into b from public.price_base(p_type, p_gallons, null);
  select * into vr from public.pricing_rules where rule_key = 'vat_rate';
  if not found then raise exception 'pricing_rule_missing: vat_rate'; end if;
  select * into sh from public.pricing_rules where rule_key = 'driver_share';
  if not found then raise exception 'pricing_rule_missing: driver_share'; end if;
  water_charge    := b.water_charge;
  delivery_fee    := b.base_fee;
  vat             := round((b.water_charge + b.base_fee) * vr.value::numeric, 3);
  total           := b.water_charge + b.base_fee + vat;
  driver_earnings := round(b.base_fee * sh.value::numeric, 3);
  water_status    := b.water_status;
  fee_status      := b.fee_status;
  vat_status      := public.worst_status(vr.status, b.water_status, b.fee_status);
  total_status    := public.worst_status(b.water_status, b.fee_status, vat_status);
  earnings_status := public.worst_status(b.fee_status, sh.status);
  rules_used      := b.rules_used || array['vat_rate', 'driver_share'];
  return next;
end $$;

-- The full price for a zone: base charge × the 0026 multipliers (capped), discount, VAT,
-- driver earnings, plus the tariff and delivery details that the order stores.
create function public.price_quote_zone(p_type public.service_type, p_gallons integer, p_peak boolean, p_priority boolean, p_discount_pct numeric,
                                        p_distance_mult numeric, p_demand_mult numeric, p_zone uuid)
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
  fee_multiplier  numeric,
  tariff          jsonb,
  delivery        jsonb,
  vat_rate        numeric,
  driver_share    numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare
  b record;
  mult numeric := 1;
  fs public.rule_status;
  used text[];
  vr public.pricing_rules; sh public.pricing_rules;
  cap numeric := coalesce(public.rule_num('dynamic_cap'), 99);
  fee numeric;
  k text;
begin
  select * into b from public.price_base(p_type, p_gallons, p_zone);
  select * into vr from public.pricing_rules where rule_key = 'vat_rate';
  if not found then raise exception 'pricing_rule_missing: vat_rate'; end if;
  select * into sh from public.pricing_rules where rule_key = 'driver_share';
  if not found then raise exception 'pricing_rule_missing: driver_share'; end if;
  fs := b.fee_status;
  used := b.rules_used || array['vat_rate', 'driver_share'];
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
  fee := round(b.base_fee * mult, 3);
  water_charge    := b.water_charge;
  delivery_fee    := fee;
  discount        := round(fee * greatest(least(coalesce(p_discount_pct, 0), 0.5), 0), 3);
  vat             := round((b.water_charge + fee - discount) * vr.value::numeric, 3);
  total           := b.water_charge + fee - discount + vat;
  driver_earnings := round(fee * sh.value::numeric, 3);
  water_status    := b.water_status;
  fee_status      := fs;
  vat_status      := public.worst_status(vr.status, b.water_status, fs);
  total_status    := public.worst_status(b.water_status, fs, vat_status);
  earnings_status := public.worst_status(fs, sh.status);
  rules_used      := used;
  base_fee        := b.base_fee;
  fee_multiplier  := round(mult, 4);
  tariff          := b.tariff;
  delivery        := b.delivery;
  vat_rate        := vr.value::numeric;
  driver_share    := sh.value::numeric;
  return next;
end $$;

-- 0026's signature (default zone), kept for its callers (contract and business credit checks).
create or replace function public.price_quote_full(p_type public.service_type, p_gallons integer, p_peak boolean, p_priority boolean, p_discount_pct numeric,
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
language sql stable security definer set search_path = public
as $$
  select f.water_charge, f.delivery_fee, f.discount, f.vat, f.total, f.driver_earnings, f.water_status, f.fee_status, f.vat_status,
         f.total_status, f.earnings_status, f.rules_used, f.base_fee, f.fee_multiplier
    from public.price_quote_zone(p_type, p_gallons, p_peak, p_priority, p_discount_pct, p_distance_mult, p_demand_mult, null) f
$$;

-- The tariff classes and delivery charge an order rests on, when not confirmed, for the
-- BILLING_MODE = production check (next to the pricing rules).
create function public.price_unconfirmed(p_rules text[], p_tariff jsonb, p_delivery jsonb)
returns text
language sql stable security definer set search_path = public
as $$
  select string_agg(x, ', ' order by x) from (
    select format('%s (%s, %s)', p.rule_key, p.status, p.source) as x from public.pricing_rules p
     where p.rule_key = any(p_rules) and p.status <> 'confirmed'
    union all
    select format('tariff class %s (%s, %s)', c.code, c.status, c.source) from public.tariff_classes c
     where c.id in (select (e ->> 'class_id')::uuid from jsonb_array_elements(coalesce(p_tariff -> 'slabs', '[]')) e
                    union select (p_tariff ->> 'class_id')::uuid)
       and c.status <> 'confirmed'
    union all
    select format('delivery charge %s %s (%s, %s)', c.code, coalesce(z.name, 'default'), d.status, d.source)
      from public.delivery_charges d join public.tariff_classes c on c.id = d.class_id left join public.zones z on z.id = d.zone_id
     where d.id = (p_delivery ->> 'charge_id')::uuid and d.status <> 'confirmed'
  ) s
$$;

-- The pricing trigger. The delivery point comes from the order RPC (nama.pricing_point), else
-- the property; the zone is the order's. The full breakdown is locked into price_basis.
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
  select * into q from public.price_quote_zone(new.service_type, new.gallons, new.slot_peak, new.is_emergency, pct,
                                               (f ->> 'distance_mult')::numeric, (f ->> 'demand_mult')::numeric, new.zone_id);
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
    bad := public.price_unconfirmed(used, q.tariff, q.delivery);
    if bad is not null then
      raise exception 'pricing_unconfirmed: BILLING_MODE is production and these prices are not confirmed: %', bad;
    end if;
  end if;

  new.water_charge    := q.water_charge;
  new.delivery_fee    := q.delivery_fee;
  new.discount        := q.discount;
  new.vat             := q.vat;
  new.total           := q.total;
  new.driver_earnings := q.driver_earnings;
  new.price_basis := jsonb_build_object(
    'version', 2,
    'locked_at', now(),
    'water', q.water_status,
    'fee', case when disc_status is null then q.fee_status else public.worst_status(q.fee_status, disc_status) end,
    'vat', case when disc_status is null then q.vat_status else public.worst_status(q.vat_status, disc_status) end,
    'total', case when disc_status is null then q.total_status else public.worst_status(q.total_status, disc_status) end,
    'earnings', q.earnings_status,
    'rules', to_jsonb(used), 'mode', mode,
    'service_type', new.service_type, 'gallons', new.gallons, 'zone_id', new.zone_id,
    'lines', jsonb_build_object('water_charge', q.water_charge, 'delivery_fee', q.delivery_fee, 'discount', q.discount,
                                'vat', q.vat, 'total', q.total, 'driver_earnings', q.driver_earnings),
    'tariff', q.tariff,
    'delivery', q.delivery || jsonb_build_object('multiplier', q.fee_multiplier, 'fee', q.delivery_fee),
    'vat_rate', q.vat_rate,
    'driver_share', q.driver_share,
    'factors', jsonb_build_object('base_fee', q.base_fee, 'multiplier', q.fee_multiplier,
                                  'peak', coalesce(new.slot_peak, false), 'priority', coalesce(new.is_emergency, false),
                                  'distance_km', f -> 'distance_km', 'distance_mult', f -> 'distance_mult',
                                  'demand_ratio', f -> 'demand_ratio', 'demand_mult', f -> 'demand_mult'));
  if new.slot_peak or new.is_emergency or pct > 0 then
    new.price_basis := new.price_basis || jsonb_build_object('peak', new.slot_peak, 'priority', new.is_emergency, 'discount_pct', pct);
  end if;
  return new;
end $$;

-- The quote shows what the order will be priced with: the delivery point's zone and factors.
create or replace function public.quote_order(p_service_type public.service_type, p_gallons integer, p_slot_start timestamptz default null,
                                              p_emergency boolean default false, p_promo_code text default null,
                                              p_lat double precision default null, p_lng double precision default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare q record; pct numeric := 0; promo public.promotions; f jsonb; z uuid;
begin
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if nullif(btrim(coalesce(p_promo_code, '')), '') is not null then
    select * into promo from public.promotions where code = upper(btrim(p_promo_code)) and active and uses < max_uses and (valid_to is null or valid_to >= current_date)
       and (audience in ('all', 'household')
            or (audience = 'new' and not exists (select 1 from public.orders where customer_id = auth.uid() and status = 'delivered')));
    if not found then raise exception 'invalid_promo'; end if;
    pct := promo.pct;
  end if;
  if p_lat is not null and p_lng is not null then z := (public.zone_at(p_lat, p_lng)).id; end if;
  f := public.price_factors(p_service_type, p_lat, p_lng, z);
  select * into q from public.price_quote_zone(p_service_type, p_gallons, public.is_peak(p_slot_start), coalesce(p_emergency, false), pct,
                                               (f ->> 'distance_mult')::numeric, (f ->> 'demand_mult')::numeric, z);
  return to_jsonb(q) || jsonb_build_object('peak', public.is_peak(p_slot_start), 'priority', coalesce(p_emergency, false), 'discount_pct', pct,
                                           'promo_label', promo.label, 'zone_id', z,
                                           'factors', jsonb_build_object('base_fee', q.base_fee, 'multiplier', q.fee_multiplier,
                                                                         'peak_mult', case when public.is_peak(p_slot_start) then public.rule_num('peak_multiplier') else 1 end,
                                                                         'priority_mult', case when coalesce(p_emergency, false) then public.rule_num('priority_multiplier') else 1 end,
                                                                         'distance_km', f -> 'distance_km', 'distance_mult', f -> 'distance_mult',
                                                                         'demand_ratio', f -> 'demand_ratio', 'demand_mult', f -> 'demand_mult',
                                                                         'located', p_lat is not null and p_lng is not null));
end $$;

-- ===========================================================================
-- #1 — the price is locked at booking
-- ===========================================================================
-- Price lines, the breakdown, the volume and the service never change after insert, except
-- inside staff_adjust_order_price (which sets nama.price_change for its own transaction only).
create or replace function public.freeze_price()
returns trigger
language plpgsql
as $$
begin
  if (new.water_charge, new.delivery_fee, new.vat, new.total, new.driver_earnings, new.price_basis, new.discount, new.gallons, new.service_type)
     is distinct from (old.water_charge, old.delivery_fee, old.vat, old.total, old.driver_earnings, old.price_basis, old.discount, old.gallons, old.service_type) then
    if coalesce(current_setting('nama.price_change', true), '') = 'staff_adjustment'
       and (new.gallons, new.service_type, new.water_charge) is not distinct from (old.gallons, old.service_type, old.water_charge) then
      return new;
    end if;
    raise exception 'price_immutable';
  end if;
  return new;
end $$;
drop trigger orders_freeze_price on public.orders;
create trigger orders_freeze_price
  before update of water_charge, delivery_fee, vat, total, driver_earnings, price_basis, discount, gallons, service_type on public.orders
  for each row execute function public.freeze_price();
revoke execute on function public.freeze_price() from public, anon, authenticated;

-- NWS finance lowers an order's delivery fee (a correction or goodwill). The regulated water
-- charge never changes, the fee can only go down, VAT is recomputed at the locked rate and
-- the driver's earnings stay as booked. A prepaid order gets the difference back in the
-- wallet; an account order not yet invoiced is billed the new total.
create function public.staff_adjust_order_price(p_order_id uuid, p_delivery_fee numeric, p_reason text)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare b public.orders; a public.orders; r text; fee numeric := round(coalesce(p_delivery_fee, -1), 3); disc numeric; v numeric; tot numeric; rate numeric;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.orders where id = p_order_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status = 'cancelled' then raise exception 'invalid_state'; end if;
  if b.invoice_id is not null then raise exception 'already_invoiced'; end if;
  if fee < 0 then raise exception 'invalid_amount'; end if;
  if fee >= b.delivery_fee then raise exception 'price_increase_not_allowed: the delivery fee can only be lowered'; end if;
  rate := coalesce((b.price_basis ->> 'vat_rate')::numeric, public.rule_num('vat_rate'));
  disc := least(b.discount, fee);
  v := round((b.water_charge + fee - disc) * rate, 3);
  tot := b.water_charge + fee - disc + v;
  perform set_config('nama.price_change', 'staff_adjustment', true);
  update public.orders
     set delivery_fee = fee, discount = disc, vat = v, total = tot,
         price_basis = price_basis || jsonb_build_object('adjustments', coalesce(price_basis -> 'adjustments', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'at', now(), 'by', auth.uid(), 'reason', r, 'delivery_fee', jsonb_build_array(b.delivery_fee, fee),
           'vat', jsonb_build_array(b.vat, v), 'total', jsonb_build_array(b.total, tot))))
   where id = b.id returning * into a;
  perform set_config('nama.price_change', '', true);
  if b.billing = 'prepaid' then
    perform public.refund_to_wallet(b.id, b.total - tot, 'adjustment', 'NWS price correction TO-' || b.order_no || ': ' || r);
    select * into a from public.orders where id = b.id;
  end if;
  perform public.write_audit('order.price_adjust', 'order', b.id::text,
    jsonb_build_object('delivery_fee', b.delivery_fee, 'discount', b.discount, 'vat', b.vat, 'total', b.total),
    jsonb_build_object('delivery_fee', a.delivery_fee, 'discount', a.discount, 'vat', a.vat, 'total', a.total), r);
  return a;
end $$;

-- What the driver collects at the door: the total on cash-on-delivery orders (call centre),
-- nothing when the order is paid in the app or billed to a business account.
create function public.order_collect_omr(o public.orders)
returns numeric
language sql stable
as $$
  select case when o.pay_method = 'cash' and coalesce(o.billing, 'prepaid') = 'prepaid' and o.payment_status = 'authorized'
              then o.total - coalesce(o.short_credit, 0) else 0 end::numeric(10,3)
$$;

-- The job offer carries it (0026 body, plus collect_omr and pay_method).
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
  fee_factors      jsonb,
  collect_omr      numeric(10,3),
  pay_method       text
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
           (o.price_basis -> 'factors') - 'distance_km',
           public.order_collect_omr(o), o.pay_method
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
-- NWS → Settings → Pricing: tariff classes and delivery charges (admin, finance; audited)
-- ===========================================================================
create function public.staff_save_tariff_class(p_id uuid, p_service_type public.service_type, p_code text, p_min_gal integer, p_max_gal integer,
                                               p_rate_baisa numeric, p_status public.rule_status, p_source text, p_active boolean, p_reason text)
returns public.tariff_classes
language plpgsql security definer set search_path = public
as $$
declare b public.tariff_classes; a public.tariff_classes; r text; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if v_code !~'^[A-Z0-9-]{2,20}$' then raise exception 'invalid_value: code must be 2–20 letters, digits or dashes'; end if;
  if p_min_gal is null or p_min_gal < 1 or p_min_gal > 20000 or (p_max_gal is not null and (p_max_gal < p_min_gal or p_max_gal > 20000)) then
    raise exception 'invalid_value: the capacity range must lie within 1–20,000 gal';
  end if;
  if p_rate_baisa is null or p_rate_baisa < 0 or p_rate_baisa > 1000 then raise exception 'invalid_value: rate must be 0–1,000 baisa per gallon'; end if;
  if p_status is null or coalesce(btrim(p_source), '') = '' then raise exception 'invalid_value: status and source are required'; end if;
  if p_id is null then
    insert into public.tariff_classes (service_type, code, min_gal, max_gal, rate_baisa, status, source, active)
    values (p_service_type, v_code, p_min_gal, p_max_gal, p_rate_baisa, p_status, btrim(p_source), coalesce(p_active, true))
    returning * into a;
  else
    select * into b from public.tariff_classes where id = p_id for update;
    if not found then raise exception 'not_found'; end if;
    if b.service_type <> p_service_type then raise exception 'invalid_value: a class keeps its service'; end if;
    update public.tariff_classes
       set code = v_code, min_gal = p_min_gal, max_gal = p_max_gal, rate_baisa = p_rate_baisa, status = p_status,
           source = btrim(p_source), active = coalesce(p_active, active), updated_at = now()
     where id = p_id returning * into a;
  end if;
  if a.active and not exists (select 1 from public.delivery_charges where class_id = a.id and zone_id is null) then
    -- A new class needs a default delivery charge before it can price anything: start from the
    -- default of the class below it (same service), as an assumption to review.
    insert into public.delivery_charges (zone_id, service_type, class_id, amount_omr, status, source, notes)
    select null, a.service_type, a.id, d.amount_omr, 'assumption', 'Copied from ' || c.code || ' when ' || a.code || ' was added', ''
      from public.delivery_charges d join public.tariff_classes c on c.id = d.class_id
     where d.zone_id is null and c.service_type = a.service_type and c.id <> a.id
     order by c.min_gal desc limit 1;
  end if;
  perform public.write_audit(case when p_id is null then 'pricing.tariff_class_add' else 'pricing.tariff_class_update' end,
                             'tariff_class', a.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_save_delivery_charge(p_id uuid, p_zone_id uuid, p_class_id uuid, p_amount_omr numeric, p_status public.rule_status, p_source text, p_reason text)
returns public.delivery_charges
language plpgsql security definer set search_path = public
as $$
declare b public.delivery_charges; a public.delivery_charges; r text; c public.tariff_classes; amt numeric := round(coalesce(p_amount_omr, -1), 3);
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if amt < 0 or amt > 1000 then raise exception 'invalid_value: amount must be 0–1,000 OMR'; end if;
  if p_status is null or coalesce(btrim(p_source), '') = '' then raise exception 'invalid_value: status and source are required'; end if;
  if p_id is null then
    select * into c from public.tariff_classes where id = p_class_id;
    if not found then raise exception 'not_found'; end if;
    if p_zone_id is not null and not exists (select 1 from public.zones where id = p_zone_id) then raise exception 'not_found'; end if;
    if exists (select 1 from public.delivery_charges where class_id = c.id and zone_id is not distinct from p_zone_id) then raise exception 'already_exists'; end if;
    insert into public.delivery_charges (zone_id, service_type, class_id, amount_omr, status, source)
    values (p_zone_id, c.service_type, c.id, amt, p_status, btrim(p_source)) returning * into a;
  else
    select * into b from public.delivery_charges where id = p_id for update;
    if not found then raise exception 'not_found'; end if;
    update public.delivery_charges set amount_omr = amt, status = p_status, source = btrim(p_source), updated_at = now()
     where id = p_id returning * into a;
  end if;
  perform public.write_audit(case when p_id is null then 'pricing.delivery_charge_add' else 'pricing.delivery_charge_update' end,
                             'delivery_charge', a.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- Only a zone's own charge can be removed (the zone then pays the default).
create function public.staff_delete_delivery_charge(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare b public.delivery_charges; r text;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.delivery_charges where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.zone_id is null then raise exception 'invalid_value: the default charge can be changed, not removed'; end if;
  delete from public.delivery_charges where id = p_id;
  perform public.write_audit('pricing.delivery_charge_remove', 'delivery_charge', b.id::text, to_jsonb(b), null, r);
end $$;

-- The renamed basis rule keeps its two values (0026 body otherwise).
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
  if p_rule_key = 'tariff_basis' then
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
-- Execute rights
-- ===========================================================================
revoke execute on function
  public.price_base(public.service_type, integer, uuid),
  public.price_quote_zone(public.service_type, integer, boolean, boolean, numeric, numeric, numeric, uuid),
  public.price_unconfirmed(text[], jsonb, jsonb)
from public, anon, authenticated;
revoke execute on function public.order_collect_omr(public.orders) from public, anon;
grant execute on function public.order_collect_omr(public.orders) to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'open_requests_near(double precision, double precision)',
    'staff_adjust_order_price(uuid, numeric, text)',
    'staff_save_tariff_class(uuid, public.service_type, text, integer, integer, numeric, public.rule_status, text, boolean, text)',
    'staff_save_delivery_charge(uuid, uuid, uuid, numeric, public.rule_status, text, text)',
    'staff_delete_delivery_charge(uuid, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
