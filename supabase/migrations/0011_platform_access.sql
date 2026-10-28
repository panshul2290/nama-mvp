-- Platform helpers, row-level security, pricing extensions (peak, priority,
-- discounts) and template-driven notifications.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.is_staff()
returns boolean language sql stable security definer set search_path = public
as $$ select public.my_staff_role() is not null $$;

-- Company of an owner or a driver.
create function public.my_company_id()
returns uuid language sql stable security definer set search_path = public
as $$ select company_id from public.profiles where id = auth.uid() and role in ('owner', 'driver') $$;

create function public.my_org_id()
returns uuid language sql stable security definer set search_path = public
as $$ select org_id from public.profiles where id = auth.uid() and role = 'business' $$;

create function public.my_org_role()
returns text language sql stable security definer set search_path = public
as $$ select org_role from public.profiles where id = auth.uid() and role = 'business' $$;

create function public.km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable
as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

create function public.wallet_balance(p_customer uuid)
returns numeric language sql stable security definer set search_path = public
as $$ select coalesce(sum(amount), 0)::numeric(12,3) from public.wallet_tx where customer_id = p_customer $$;

create function public.company_balance(p_company uuid, p_bucket text default 'earnings')
returns numeric language sql stable security definer set search_path = public
as $$ select coalesce(sum(amount), 0)::numeric(12,3) from public.company_tx where company_id = p_company and bucket = p_bucket $$;

-- The active zone that contains a point (nearest centre wins), or null.
create function public.zone_at(p_lat double precision, p_lng double precision, p_include_inactive boolean default false)
returns public.zones language sql stable security definer set search_path = public
as $$
  select z.* from public.zones z
   where (z.active or p_include_inactive)
     and public.km(p_lat, p_lng, z.center_lat, z.center_lng) <= z.radius_km
   order by public.km(p_lat, p_lng, z.center_lat, z.center_lng)
   limit 1
$$;

create function public.setting_json(p_key text)
returns jsonb language sql stable security definer set search_path = public
as $$ select case when value ~ '^\s*[{\[]' then value::jsonb else to_jsonb(value) end from public.app_settings where key = p_key $$;

create function public.rule_num(p_key text)
returns numeric language sql stable security definer set search_path = public
as $$ select value::numeric from public.pricing_rules where rule_key = p_key $$;

-- Tanker of the caller's active job (driver), else their assigned tanker.
create function public.tanker_company(p_tanker uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select company_id from public.tankers where id = p_tanker $$;

-- Is this tanker part of the caller's company (owner portal)?
create function public.in_my_company(p_tanker uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select p_tanker is not null and exists (select 1 from public.tankers t where t.id = p_tanker and t.company_id is not null and t.company_id = public.my_company_id()
                                               and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')) $$;

-- ---------------------------------------------------------------------------
-- New platform settings
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value, notes) values
  ('EMERGENCY', '{"on": false, "zone": null, "reason": null, "since": null}', 'Emergency mode: dispatch priority to the zone, banners in every app, shift override.'),
  ('PRIVACY', '{"mask_phone": true, "mask_address": true, "retention_gps_days": 90, "retention_orders_years": 7, "residency": "Oman (simulated)", "usage_data_default": false}', 'Data privacy controls.'),
  ('LOYALTY', '{"points_per_omr": 1, "redeem_points": 100, "redeem_omr": 1}', 'Loyalty: points earned per OMR paid; points needed for each OMR of wallet credit.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Reference data every signed-in user may read.
create policy zones_read                  on public.zones                  for select to authenticated using (true);
create policy sites_read                  on public.sites                  for select to authenticated using (true);
create policy complaint_sla_read          on public.complaint_sla          for select to authenticated using (true);
create policy penalty_rules_read          on public.penalty_rules          for select to authenticated using (true);
create policy notification_templates_read on public.notification_templates for select to authenticated using (true);
create policy incident_targets_read       on public.incident_targets       for select to authenticated using (true);

-- Companies: public directory columns for everyone (contract wizard); bank details only via RPC.
revoke select on public.companies from authenticated;
grant select (id, name, cr_no, phone, rating, since, status, created_at) on public.companies to authenticated;
create policy companies_read on public.companies for select to authenticated using (status = 'active' or public.is_staff() or id = public.my_company_id());

create policy organizations_staff  on public.organizations for select to authenticated using (public.is_staff());
create policy organizations_member on public.organizations for select to authenticated using (id = public.my_org_id());

-- Staff read everything new.
do $$
declare t text;
begin
  foreach t in array array['properties', 'contracts', 'promotions', 'payments', 'wallet_tx', 'payout_batches', 'company_tx',
    'pods', 'source_events', 'gps_fixes', 'order_messages', 'tanker_documents', 'water_tests', 'devices', 'shift_checks',
    'driver_availability', 'trip_issues', 'complaints', 'complaint_notes', 'alerts', 'penalties', 'inspections',
    'invoices', 'incidents', 'integrations', 'fraud_flags', 'data_requests', 'scheduled_reports', 'notifications']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_staff', t);
  end loop;
end $$;

-- Customers
create policy properties_own        on public.properties      for select to authenticated using (customer_id = auth.uid() or (org_id is not null and org_id = public.my_org_id()));
create policy contracts_party       on public.contracts       for select to authenticated using (customer_id = auth.uid() or (org_id is not null and org_id = public.my_org_id()) or company_id = public.my_company_id());
create policy payments_own          on public.payments        for select to authenticated using (customer_id = auth.uid() or (org_id is not null and org_id = public.my_org_id()));
create policy payment_methods_own   on public.payment_methods for select to authenticated using (customer_id = auth.uid());
create policy wallet_tx_own         on public.wallet_tx       for select to authenticated using (customer_id = auth.uid());
create policy notifications_own     on public.notifications   for select to authenticated using (user_id = auth.uid());
create policy data_requests_own     on public.data_requests   for select to authenticated using (customer_id = auth.uid());
create policy complaints_own        on public.complaints      for select to authenticated using (customer_id = auth.uid());
create policy complaint_notes_own   on public.complaint_notes for select to authenticated using (
  not internal and exists (select 1 from public.complaints c where c.id = complaint_notes.complaint_id and c.customer_id = auth.uid()));
create policy penalties_customer    on public.penalties       for select to authenticated using (customer_id = auth.uid() or (org_id is not null and org_id = public.my_org_id()));

-- Order-scoped evidence: the customer, the assigned driver, the tanker's company owner.
create function public.can_see_order(p_order uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.orders o
     where o.id = p_order
       and (o.customer_id = auth.uid()
            or o.driver_id = auth.uid()
            or (o.org_id is not null and o.org_id = public.my_org_id())
            or public.in_my_company(o.tanker_id)))
$$;
create policy pods_party           on public.pods           for select to authenticated using (public.can_see_order(order_id));
create policy source_events_party  on public.source_events  for select to authenticated using (order_id is not null and public.can_see_order(order_id));
create policy order_messages_party on public.order_messages for select to authenticated using (public.can_see_order(order_id));

-- Drivers
create policy company_tx_driver     on public.company_tx          for select to authenticated using (driver_id = auth.uid());
create policy shift_checks_own      on public.shift_checks        for select to authenticated using (driver_id = auth.uid());
create policy availability_own      on public.driver_availability for select to authenticated using (driver_id = auth.uid());
create policy trip_issues_own       on public.trip_issues         for select to authenticated using (driver_id = auth.uid());
create policy penalties_driver      on public.penalties           for select to authenticated using (driver_id = auth.uid());
create policy documents_driver      on public.tanker_documents    for select to authenticated using (driver_id = auth.uid() or tanker_id = public.my_tanker_id());
create policy water_tests_driver    on public.water_tests         for select to authenticated using (tanker_id = public.my_tanker_id());
create policy devices_driver        on public.devices             for select to authenticated using (tanker_id = public.my_tanker_id());

-- Tanker company owners: their company's tankers, drivers, jobs and records.
create function public.is_owner()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner' and company_id is not null) $$;

create policy tankers_customer_collected on public.tankers for select to authenticated using (
  exists (select 1 from public.orders o where o.tanker_id = tankers.id and o.customer_id = auth.uid() and o.status = 'collected'));

-- A wastewater job stays the driver's until discharge: keep the customer's name and address visible.
create policy profiles_driver_collected on public.profiles for select to authenticated using (
  exists (select 1 from public.orders o where o.customer_id = profiles.id and o.driver_id = auth.uid() and o.status = 'collected'));
create policy order_locations_driver_collected on public.order_locations for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_locations.order_id and o.driver_id = auth.uid() and o.status = 'collected'));

create policy tankers_owner            on public.tankers            for select to authenticated using (public.is_owner() and company_id = public.my_company_id());
create policy profiles_owner_drivers   on public.profiles           for select to authenticated using (public.is_owner() and company_id = public.my_company_id());
create policy assignments_owner        on public.tanker_assignments for select to authenticated using (public.in_my_company(tanker_id));
create policy orders_owner             on public.orders             for select to authenticated using (public.in_my_company(tanker_id));
create policy permits_owner            on public.permits            for select to authenticated using (public.in_my_company(tanker_id));
create policy company_tx_owner         on public.company_tx         for select to authenticated using (public.is_owner() and company_id = public.my_company_id());
create policy shift_checks_owner       on public.shift_checks       for select to authenticated using (public.in_my_company(tanker_id));
create policy availability_owner       on public.driver_availability for select to authenticated using (public.is_owner() and exists (select 1 from public.profiles p where p.id = driver_id and p.company_id = public.my_company_id()));
create policy trip_issues_owner        on public.trip_issues        for select to authenticated using (public.in_my_company(tanker_id));
create policy penalties_owner          on public.penalties          for select to authenticated using (public.is_owner() and company_id = public.my_company_id());
create policy documents_owner          on public.tanker_documents   for select to authenticated using (public.in_my_company(tanker_id) or (public.is_owner() and exists (select 1 from public.profiles p where p.id = driver_id and p.company_id = public.my_company_id())));
create policy water_tests_owner        on public.water_tests        for select to authenticated using (public.in_my_company(tanker_id));
create policy devices_owner            on public.devices            for select to authenticated using (public.in_my_company(tanker_id));
create policy gps_fixes_owner          on public.gps_fixes          for select to authenticated using (public.in_my_company(tanker_id));
create policy alerts_owner             on public.alerts             for select to authenticated using (public.in_my_company(tanker_id));
create policy inspections_owner        on public.inspections        for select to authenticated using (public.in_my_company(tanker_id));
-- Contract offers: the owner sees the site, the household's name and the business account.
create policy properties_owner_contract on public.properties for select to authenticated using (
  public.is_owner() and exists (select 1 from public.contracts k where k.property_id = properties.id and k.company_id = public.my_company_id()));
create policy organizations_owner_contract on public.organizations for select to authenticated using (
  public.is_owner() and exists (select 1 from public.contracts k where k.org_id = organizations.id and k.company_id = public.my_company_id()));
create policy profiles_owner_contract on public.profiles for select to authenticated using (
  public.is_owner() and exists (select 1 from public.contracts k where k.customer_id = profiles.id and k.company_id = public.my_company_id()));

-- Business (B2B) members: their organisation's orders, sites, invoices and people.
create policy orders_org            on public.orders          for select to authenticated using (org_id is not null and org_id = public.my_org_id());
create policy order_locations_org   on public.order_locations for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_locations.order_id and o.org_id is not null and o.org_id = public.my_org_id()));
create policy profiles_org_members  on public.profiles        for select to authenticated using (org_id is not null and org_id = public.my_org_id());
create policy invoices_org          on public.invoices        for select to authenticated using (org_id = public.my_org_id());
create policy tankers_org_active    on public.tankers         for select to authenticated using (
  exists (select 1 from public.orders o where o.tanker_id = tankers.id and o.org_id is not null and o.org_id = public.my_org_id()
             and o.status in ('accepted', 'arriving', 'arrived', 'collected')));

-- ---------------------------------------------------------------------------
-- Pricing: peak / priority multipliers and discounts on the delivery fee
-- ---------------------------------------------------------------------------
-- Same lines as price_quote, plus a discount line. Driver earnings are a share
-- of the full (multiplied) fee; discounts are borne by the platform.
create function public.price_quote_ext(p_type public.service_type, p_gallons integer, p_peak boolean, p_priority boolean, p_discount_pct numeric)
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
language plpgsql stable security definer set search_path = public
as $$
declare
  q record;
  mult numeric := 1;
  fs public.rule_status;
  used text[];
  vat_rate numeric := public.rule_num('vat_rate');
  share numeric := public.rule_num('driver_share');
  fee numeric;
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
  return next;
end $$;

-- Discount for an order being priced: an active promotion code, or a contract plan discount.
create function public.order_discount_pct(p_promo text, p_contract uuid)
returns numeric language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select pct from public.promotions where code = p_promo and active and (valid_to is null or valid_to >= current_date)),
    (select public.rule_num(case c.plan when 'yearly' then 'discount_yearly' else 'discount_monthly' end) from public.contracts c where c.id = p_contract),
    0)
$$;

create or replace function public.price_order()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  q record;
  mode text;
  bad text;
  pct numeric := public.order_discount_pct(new.promo_code, new.contract_id);
begin
  select * into q from public.price_quote_ext(new.service_type, new.gallons, new.slot_peak, new.is_emergency, pct);
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
  new.discount        := q.discount;
  new.vat             := q.vat;
  new.total           := q.total;
  new.driver_earnings := q.driver_earnings;
  new.price_basis := jsonb_build_object(
    'water', q.water_status, 'fee', q.fee_status, 'vat', q.vat_status,
    'total', q.total_status, 'earnings', q.earnings_status,
    'rules', to_jsonb(q.rules_used), 'mode', mode);
  if new.slot_peak or new.is_emergency or pct > 0 then
    new.price_basis := new.price_basis || jsonb_build_object('peak', new.slot_peak, 'priority', new.is_emergency, 'discount_pct', pct);
  end if;
  return new;
end $$;

-- The discount is frozen with the rest of the price.
create or replace function public.freeze_price()
returns trigger
language plpgsql
as $$
begin
  if (new.water_charge, new.delivery_fee, new.vat, new.total, new.driver_earnings, new.price_basis, new.discount)
     is distinct from (old.water_charge, old.delivery_fee, old.vat, old.total, old.driver_earnings, old.price_basis, old.discount) then
    raise exception 'price_immutable';
  end if;
  return new;
end $$;
drop trigger orders_freeze_price on public.orders;
create trigger orders_freeze_price
  before update of water_charge, delivery_fee, vat, total, driver_earnings, price_basis, discount on public.orders
  for each row execute function public.freeze_price();

-- Peak = evening slot (18:00–20:00 Muscat time).
create function public.is_peak(p_at timestamptz)
returns boolean language sql stable
as $$ select extract(hour from (coalesce(p_at, now()) at time zone 'Asia/Muscat')) between 18 and 19 $$;

-- ---------------------------------------------------------------------------
-- Notifications from templates
-- ---------------------------------------------------------------------------
create function public.fill_template(p_text text, p_vars jsonb)
returns text language plpgsql immutable
as $$
declare k text; out text := p_text;
begin
  for k in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb)) loop
    out := replace(out, '{' || k || '}', coalesce(p_vars ->> k, ''));
  end loop;
  return out;
end $$;

create function public.notify(p_user uuid, p_event text, p_order uuid, p_vars jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  tpl public.notification_templates;
  lang text;
  ch text[] := '{}';
begin
  if p_user is null then return; end if;
  select * into tpl from public.notification_templates where event = p_event;
  if not found then return; end if;
  select coalesce(p.lang, 'en') into lang from public.profiles p where p.id = p_user;
  if tpl.push then ch := array_append(ch, 'push'); end if;
  if tpl.sms then ch := array_append(ch, 'sms'); end if;
  if tpl.whatsapp then ch := array_append(ch, 'whatsapp'); end if;
  if cardinality(ch) = 0 then ch := array['in_app']; end if;
  if lang = 'ar' then
    select coalesce(p_vars, '{}'::jsonb) || coalesce(jsonb_object_agg(left(k, -3), v), '{}'::jsonb) into p_vars
      from jsonb_each(coalesce(p_vars, '{}'::jsonb)) as e(k, v) where k like '%\_ar';
  end if;
  insert into public.notifications (user_id, event, channels, title, body, order_id)
  values (p_user, p_event, ch,
          public.fill_template(case when lang = 'ar' then tpl.title_ar else tpl.title_en end, p_vars),
          public.fill_template(case when lang = 'ar' then tpl.body_ar else tpl.body_en end, p_vars),
          p_order);
end $$;

-- Order status changes notify the customer (and B2B approvers / company owners where relevant).
create function public.orders_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v jsonb := jsonb_build_object('order', 'TO-' || new.order_no, 'plate', coalesce(new.tanker_plate, ''), 'driver', coalesce(new.driver_name, ''),
                                'total', to_char(new.total, 'FM9990.000'), 'slot', coalesce(new.slot_label, ''));
  m record;
begin
  if tg_op = 'INSERT' then
    if new.status = 'scheduled' then perform public.notify(new.customer_id, 'order_scheduled', new.id, v);
    elsif new.status = 'pending_approval' then
      for m in select id from public.profiles where org_id = new.org_id and org_role = 'admin' loop
        perform public.notify(m.id, 'approval_needed', new.id, v);
      end loop;
    elsif new.status = 'requested' and not (new.channel = 'app' and new.pay_method is not null) then
      perform public.notify(new.customer_id, 'order_confirmed', new.id, v);
    end if;
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  case new.status
    when 'accepted' then perform public.notify(new.customer_id, 'tanker_assigned', new.id, v);
    when 'arrived' then perform public.notify(new.customer_id, 'arrived', new.id, v);
    when 'collected' then perform public.notify(new.customer_id, 'collected', new.id, v);
    when 'delivered' then perform public.notify(new.customer_id, case when new.service_type = 'WW' then 'discharged' else 'delivered' end, new.id, v);
    when 'cancelled' then
      if new.payment_status = 'failed' then perform public.notify(new.customer_id, 'payment_failed', new.id, v);
      else perform public.notify(new.customer_id, 'order_cancelled', new.id, v || jsonb_build_object('reason', coalesce(new.cancel_reason, ''))); end if;
    when 'requested' then
      if old.status in ('accepted', 'arriving', 'arrived') then perform public.notify(new.customer_id, 'driver_reassigning', new.id, v);
      elsif old.status = 'pending_approval' then perform public.notify(new.customer_id, 'order_confirmed', new.id, v);
      end if;
    else null;
  end case;
  return new;
end $$;

create trigger orders_notify_insert after insert on public.orders for each row execute function public.orders_notify();
create trigger orders_notify_update after update of status on public.orders for each row execute function public.orders_notify();

-- ---------------------------------------------------------------------------
-- Execute rights for the helpers
-- ---------------------------------------------------------------------------
revoke execute on function
  public.is_staff(), public.my_company_id(), public.my_org_id(), public.my_org_role(),
  public.km(double precision, double precision, double precision, double precision),
  public.wallet_balance(uuid), public.company_balance(uuid, text),
  public.zone_at(double precision, double precision, boolean), public.setting_json(text), public.rule_num(text),
  public.tanker_company(uuid), public.in_my_company(uuid), public.can_see_order(uuid), public.is_owner(),
  public.price_quote_ext(public.service_type, integer, boolean, boolean, numeric), public.order_discount_pct(text, uuid),
  public.is_peak(timestamptz), public.fill_template(text, jsonb), public.notify(uuid, text, uuid, jsonb), public.orders_notify()
from public, anon, authenticated;

grant execute on function
  public.is_staff(), public.my_company_id(), public.my_org_id(), public.my_org_role(),
  public.km(double precision, double precision, double precision, double precision),
  public.zone_at(double precision, double precision, boolean), public.setting_json(text),
  public.in_my_company(uuid), public.can_see_order(uuid), public.is_owner(),
  public.price_quote_ext(public.service_type, integer, boolean, boolean, numeric), public.is_peak(timestamptz)
to authenticated;

-- Live screens listen to these too.
alter publication supabase_realtime add table public.alerts, public.notifications, public.order_messages, public.complaints;
