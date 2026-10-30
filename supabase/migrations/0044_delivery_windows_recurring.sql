-- Delivery windows (Ramadan, Eid, prayer times) and scheduled / recurring orders (items 37, 38).
--
-- #38 NWS keeps named window templates (normal, Ramadan, Eid, …) with date ranges, the windows
--     offered per weekday and blocked times (around iftar, Friday prayer 11:30–13:30). The
--     template for a date is the active one whose range covers it (highest priority), else the
--     undated normal one. delivery_windows() feeds the customer request picker and the business
--     order form; an app order whose window overlaps a blocked time is refused (slot_blocked).
-- #37 Customers schedule an order for a future date and window (create_order already accepts a
--     slot; it becomes 'scheduled' and is released 90 minutes before), and set recurring orders
--     (every N days or weeks, a preferred window, an end date or a count) for farms and villas,
--     apart from tanker-company contracts. pg_cron creates each occurrence as a normal order
--     (create_order, as the customer) priced at that moment with the current tariff; the
--     customer is told the day before and can skip that delivery or pause the plan. A card that
--     declines then doesn't stop it: the order goes ahead with a payment follow-up (0043).
--     NWS sees the scheduled volume per day in Orders.

-- ===========================================================================
-- #38 Window templates
-- ===========================================================================
create table public.delivery_window_templates (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[a-z0-9_-]{2,30}$'),
  name_en    text not null check (char_length(btrim(name_en)) between 2 and 60),
  name_ar    text not null check (char_length(btrim(name_ar)) between 2 and 60),
  kind       text not null default 'other' check (kind in ('normal', 'ramadan', 'eid', 'other')),
  starts_on  date,
  ends_on    date,
  windows    jsonb not null,
  blocked    jsonb not null default '[]'::jsonb,
  priority   integer not null default 0 check (priority between 0 and 100),
  active     boolean not null default true,
  notes      text check (char_length(notes) <= 300),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  check ((starts_on is null) = (ends_on is null)),
  check (ends_on is null or ends_on >= starts_on)
);

-- Ramadan 1448 and the Eids are expected around these dates (moon sighting decides): NWS
-- confirms them in Settings → Delivery windows. Iftar moves through Ramadan; the block is wide.
insert into public.delivery_window_templates (code, name_en, name_ar, kind, starts_on, ends_on, windows, blocked, priority, active, notes) values
  ('normal', 'Normal', 'عادي', 'normal', null, null,
   '[{"from": "08:00", "to": "10:00"}, {"from": "10:00", "to": "12:00"}, {"from": "16:00", "to": "18:00"}, {"from": "18:00", "to": "20:00"}]',
   '[{"from": "11:30", "to": "13:30", "days": [5], "label_en": "Friday prayer", "label_ar": "صلاة الجمعة"}]', 0, true, null),
  ('ramadan-2027', 'Ramadan 1448', 'رمضان ١٤٤٨', 'ramadan', date '2027-02-08', date '2027-03-09',
   '[{"from": "09:00", "to": "11:00"}, {"from": "11:00", "to": "13:00"}, {"from": "14:00", "to": "16:00"}, {"from": "20:30", "to": "22:30"}]',
   '[{"from": "17:30", "to": "19:30", "label_en": "Iftar", "label_ar": "الإفطار"}, {"from": "11:30", "to": "13:30", "days": [5], "label_en": "Friday prayer", "label_ar": "صلاة الجمعة"}]',
   10, true, 'Expected dates: to be confirmed by NWS after the moon sighting.'),
  ('eid-al-fitr-2027', 'Eid al-Fitr', 'عيد الفطر', 'eid', date '2027-03-10', date '2027-03-12',
   '[{"from": "10:00", "to": "12:00"}, {"from": "16:00", "to": "18:00"}]',
   '[{"from": "06:00", "to": "09:00", "label_en": "Eid prayer", "label_ar": "صلاة العيد"}]', 20, true, 'Expected dates: to be confirmed by NWS.'),
  ('eid-al-adha-2027', 'Eid al-Adha', 'عيد الأضحى', 'eid', date '2027-05-16', date '2027-05-19',
   '[{"from": "10:00", "to": "12:00"}, {"from": "16:00", "to": "18:00"}]',
   '[{"from": "06:00", "to": "09:00", "label_en": "Eid prayer", "label_ar": "صلاة العيد"}]', 20, true, 'Expected dates: to be confirmed by NWS.')
on conflict (code) do nothing;

alter table public.delivery_window_templates enable row level security;
revoke all on public.delivery_window_templates from public, anon, authenticated;
grant select on public.delivery_window_templates to authenticated;
create policy delivery_window_templates_read on public.delivery_window_templates for select to authenticated using (true);

-- A list of {from, to[, days][, labels]} ranges; from/to "HH:MM" (to may be "24:00").
create function public.window_ranges_ok(p jsonb, p_blocked boolean)
returns boolean
language plpgsql immutable
as $$
declare e jsonb; d jsonb;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 24 or (not p_blocked and jsonb_array_length(p) = 0) then return false; end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'from', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(e ->> 'to', '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
       or (e ->> 'to') <= (e ->> 'from') then return false; end if;
    if e ? 'days' then
      if jsonb_typeof(e -> 'days') <> 'array' or jsonb_array_length(e -> 'days') = 0 then return false; end if;
      for d in select * from jsonb_array_elements(e -> 'days') loop
        if jsonb_typeof(d) <> 'number' or d::text::int not between 0 and 6 then return false; end if;
      end loop;
    end if;
    if char_length(coalesce(e ->> 'label_en', '')) > 40 or char_length(coalesce(e ->> 'label_ar', '')) > 40 then return false; end if;
  end loop;
  return true;
end $$;
alter table public.delivery_window_templates
  add constraint delivery_window_templates_windows_ok check (public.window_ranges_ok(windows, false)),
  add constraint delivery_window_templates_blocked_ok check (public.window_ranges_ok(blocked, true));

-- The template for a (Muscat) date.
create function public.window_template_for(p_day date)
returns public.delivery_window_templates
language sql stable security definer set search_path = public
as $$
  select t.* from public.delivery_window_templates t
   where t.active and ((t.starts_on is not null and p_day between t.starts_on and t.ends_on) or t.starts_on is null)
   order by (t.starts_on is not null) desc, t.priority desc, t.code
   limit 1
$$;

create function public.range_ts(p_day date, p_hm text)
returns timestamptz language sql immutable
as $$ select (p_day + case when p_hm = '24:00' then interval '1 day' else p_hm::time - time '00:00' end) at time zone 'Asia/Muscat' $$;

-- Does [start, end) overlap a blocked time of its day's template?
create function public.slot_blocked(p_start timestamptz, p_end timestamptz)
returns text
language sql stable security definer set search_path = public
as $$
  with d as (select public.muscat_day(p_start) as day)
  select coalesce(b ->> 'label_en', 'Blocked time')
    from d, lateral (select (public.window_template_for(d.day)).blocked as bl) t, jsonb_array_elements(coalesce(t.bl, '[]'::jsonb)) b
   where (not b ? 'days' or (b -> 'days') @> to_jsonb(extract(dow from d.day)::int))
     and p_start < public.range_ts(d.day, b ->> 'to') and coalesce(p_end, p_start + interval '2 hours') > public.range_ts(d.day, b ->> 'from')
   limit 1
$$;

-- Windows offered from today (Muscat) for p_days days, still open 30 minutes before they end
-- and clear of blocked times.
create function public.delivery_windows(p_days integer default 3)
returns table (day date, template_code text, template_en text, template_ar text, kind text, starts_at timestamptz, ends_at timestamptz,
               label text, peak boolean)
language sql stable security definer set search_path = public
as $$
  with days as (select (public.muscat_day(now()) + g)::date as day from generate_series(0, greatest(least(coalesce(p_days, 3), 30), 1) - 1) g),
  t as (select d.day, public.window_template_for(d.day) as tp from days d),
  w as (select t.day, (t.tp).code, (t.tp).name_en, (t.tp).name_ar, (t.tp).kind, e,
               public.range_ts(t.day, e ->> 'from') as s, public.range_ts(t.day, e ->> 'to') as en
          from t, jsonb_array_elements((t.tp).windows) e
         where (t.tp).id is not null and (not e ? 'days' or (e -> 'days') @> to_jsonb(extract(dow from t.day)::int)))
  select w.day, w.code, w.name_en, w.name_ar, w.kind, w.s, w.en,
         to_char(w.day, 'Dy DD Mon') || ' · ' || (w.e ->> 'from') || '–' || (w.e ->> 'to'),
         public.is_peak(w.s)
    from w
   where w.en - interval '30 minutes' > now() and public.slot_blocked(w.s, w.en) is null
   order by w.s
$$;

-- App orders: a window that overlaps a blocked time is refused.
create function public.orders_slot_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare b text;
begin
  if new.channel = 'app' and new.slot_start is not null then
    b := public.slot_blocked(new.slot_start, new.slot_end);
    if b is not null then raise exception 'slot_blocked: %', b; end if;
  end if;
  return new;
end $$;
create trigger orders_slot_guard before insert on public.orders for each row execute function public.orders_slot_guard();

-- NWS (operators, admins): save a template. Audited.
create function public.staff_save_window_template(p_id uuid, p_t jsonb, p_reason text)
returns public.delivery_window_templates
language plpgsql security definer set search_path = public
as $$
declare b public.delivery_window_templates; a public.delivery_window_templates; r text; v jsonb := coalesce(p_t, '{}'::jsonb);
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if not public.window_ranges_ok(v -> 'windows', false) or not public.window_ranges_ok(coalesce(v -> 'blocked', '[]'::jsonb), true) then
    raise exception 'invalid_value: windows must be HH:MM ranges with the end after the start';
  end if;
  if (nullif(v ->> 'starts_on', '') is null) <> (nullif(v ->> 'ends_on', '') is null) then raise exception 'invalid_value: give both dates or neither'; end if;
  if p_id is null then
    insert into public.delivery_window_templates (code, name_en, name_ar, kind, starts_on, ends_on, windows, blocked, priority, active, notes, updated_by)
    values (lower(btrim(v ->> 'code')), btrim(v ->> 'name_en'), btrim(v ->> 'name_ar'), coalesce(v ->> 'kind', 'other'),
            nullif(v ->> 'starts_on', '')::date, nullif(v ->> 'ends_on', '')::date, v -> 'windows', coalesce(v -> 'blocked', '[]'::jsonb),
            coalesce((v ->> 'priority')::int, 10), coalesce((v ->> 'active')::boolean, true), nullif(left(btrim(coalesce(v ->> 'notes', '')), 300), ''), auth.uid())
    returning * into a;
  else
    select * into b from public.delivery_window_templates where id = p_id for update;
    if not found then raise exception 'not_found'; end if;
    update public.delivery_window_templates
       set name_en = btrim(v ->> 'name_en'), name_ar = btrim(v ->> 'name_ar'), kind = coalesce(v ->> 'kind', kind),
           starts_on = nullif(v ->> 'starts_on', '')::date, ends_on = nullif(v ->> 'ends_on', '')::date,
           windows = v -> 'windows', blocked = coalesce(v -> 'blocked', '[]'::jsonb), priority = coalesce((v ->> 'priority')::int, priority),
           active = coalesce((v ->> 'active')::boolean, active), notes = nullif(left(btrim(coalesce(v ->> 'notes', '')), 300), ''),
           updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into a;
  end if;
  if not exists (select 1 from public.delivery_window_templates where active and starts_on is null) then
    raise exception 'invalid_value: keep one active template without dates (the normal one)';
  end if;
  perform public.write_audit('windows.save', 'delivery_window_template', a.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_delete_window_template(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare b public.delivery_window_templates; r text;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  delete from public.delivery_window_templates where id = p_id returning * into b;
  if b.id is null then raise exception 'not_found'; end if;
  if not exists (select 1 from public.delivery_window_templates where active and starts_on is null) then
    raise exception 'invalid_value: keep one active template without dates (the normal one)';
  end if;
  perform public.write_audit('windows.delete', 'delivery_window_template', b.id::text, to_jsonb(b), null, r);
end $$;

-- ===========================================================================
-- #37 Recurring orders (household; contracts stay with tanker companies)
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('RECURRING', '{"notice_hours": 24, "create_hours": 12}',
   'Recurring orders: the customer is told notice_hours before each delivery (skip or pause); the order is created, and priced with the tariff of that moment, create_hours before the window.')
on conflict (key) do nothing;

create sequence public.recurring_orders_no_seq as bigint start with 3101;
create table public.recurring_orders (
  id            uuid primary key default gen_random_uuid(),
  plan_no       bigint not null unique default nextval('public.recurring_orders_no_seq'),
  customer_id   uuid not null references public.profiles (id) on delete cascade,
  property_id   uuid references public.properties (id) on delete set null,
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  area          text not null check (char_length(btrim(area)) between 1 and 120),
  address       text not null default '' check (char_length(address) <= 300),
  details       jsonb not null default '{}'::jsonb,
  service_type  public.service_type not null,
  gallons       integer not null check (gallons between 100 and 20000),
  every_n       integer not null check (every_n between 1 and 90),
  unit          text not null check (unit in ('days', 'weeks')),
  window_from   time not null,
  window_to     time not null,
  start_on      date not null,
  end_on        date,
  max_count     integer check (max_count between 1 and 500),
  created_count integer not null default 0,
  pay_method    text not null check (pay_method in ('card', 'omannet', 'wallet_card')),
  card_last4    text check (card_last4 ~ '^[0-9]{4}$'),
  driver_note   text check (char_length(driver_note) <= 300),
  status        text not null default 'active' check (status in ('active', 'paused', 'ended')),
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (window_to > window_from),
  check (end_on is null or end_on >= start_on)
);
create index recurring_orders_customer_idx on public.recurring_orders (customer_id, created_at desc);

create table public.recurring_occurrences (
  id         bigint generated always as identity primary key,
  plan_id    uuid not null references public.recurring_orders (id) on delete cascade,
  on_date    date not null,
  state      text not null check (state in ('notified', 'skipped', 'created', 'failed')),
  order_id   uuid references public.orders (id) on delete set null,
  error      text,
  at         timestamptz not null default now(),
  unique (plan_id, on_date)
);

alter table public.orders add column recurring_id uuid references public.recurring_orders (id) on delete set null;
create index orders_recurring_idx on public.orders (recurring_id) where recurring_id is not null;

alter table public.recurring_orders enable row level security;
alter table public.recurring_occurrences enable row level security;
revoke all on public.recurring_orders, public.recurring_occurrences from public, anon, authenticated;
revoke all on sequence public.recurring_orders_no_seq from public, anon, authenticated;
grant select on public.recurring_orders, public.recurring_occurrences to authenticated;
create policy recurring_orders_own on public.recurring_orders for select to authenticated using (customer_id = auth.uid() or public.is_staff());
create policy recurring_occurrences_own on public.recurring_occurrences for select to authenticated using (
  public.is_staff() or exists (select 1 from public.recurring_orders p where p.id = recurring_occurrences.plan_id and p.customer_id = auth.uid()));

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('recurring_upcoming', 'Recurring delivery tomorrow', 'customer', 'Your regular delivery: {window}',
   '{gallons} gal of {service} is planned for {window} (plan RP-{plan}). It''s priced when the order is created, at the tariff of the day. Skip it or pause the plan in the app.',
   'توصيلك الدوري: {window}',
   'من المقرر توصيل {gallons} جالون من {service} في {window} (الخطة RP-{plan}). يُحسب السعر عند إنشاء الطلب وفق تعرفة ذلك اليوم. يمكنك تخطيه أو إيقاف الخطة مؤقتاً من التطبيق.',
   true, false, false, false, 'reminder', false),
  ('recurring_failed', 'Recurring delivery not placed', 'customer', 'We couldn''t place your regular delivery',
   'Plan RP-{plan}, {window}: {reason}. Order from the app, or call Nama on 1442.',
   'تعذّر إنشاء توصيلك الدوري',
   'الخطة RP-{plan}، {window}: {reason}. اطلب من التطبيق أو اتصل بنماء على 1442.',
   true, true, false, false, 'service', true)
on conflict (event) do nothing;

-- The plan's next delivery date on or after p_from that hasn't been skipped, created or failed.
create function public.recurring_next_date(p public.recurring_orders, p_from date)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare step integer := p.every_n * case when p.unit = 'weeks' then 7 else 1 end; d date; k integer := 0;
begin
  if p.max_count is not null and p.created_count >= p.max_count then return null; end if;
  d := p.start_on;
  if p_from > d then d := d + (ceil((p_from - d)::numeric / step))::int * step; end if;
  while k < 400 loop
    if p.end_on is not null and d > p.end_on then return null; end if;
    if not exists (select 1 from public.recurring_occurrences x where x.plan_id = p.id and x.on_date = d and x.state in ('skipped', 'created', 'failed')) then
      return d;
    end if;
    d := d + step; k := k + 1;
  end loop;
  return null;
end $$;

create function public.save_recurring_order(p jsonb)
returns public.recurring_orders
language plpgsql security definer set search_path = public
as $$
declare r public.recurring_orders; pr public.properties; v jsonb := coalesce(p, '{}'::jsonb); z public.zones;
  lat double precision; lng double precision; area text; addr text; wf time; wt time; s date; e date;
begin
  if public.my_role() is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if (select account_blocked from public.profiles where id = auth.uid()) then raise exception 'account_blocked'; end if;
  if nullif(v ->> 'property_id', '') is not null then
    select * into pr from public.properties where id = (v ->> 'property_id')::uuid and customer_id = auth.uid();
    if not found then raise exception 'not_found'; end if;
    lat := pr.lat; lng := pr.lng; area := coalesce(nullif(pr.area, ''), pr.label); addr := pr.address;
  else
    lat := (v ->> 'lat')::double precision; lng := (v ->> 'lng')::double precision; area := btrim(coalesce(v ->> 'area', '')); addr := coalesce(v ->> 'address', '');
  end if;
  if lat is null or lng is null then raise exception 'invalid_location'; end if;
  if coalesce(area, '') = '' then raise exception 'area_required'; end if;
  z := public.zone_at(lat, lng);
  if z.id is null then
    if (public.zone_at(lat, lng, true)).id is not null then raise exception 'zone_disabled'; end if;
    raise exception 'outside_service_area';
  end if;
  begin
    wf := (v ->> 'window_from')::time; wt := (v ->> 'window_to')::time; s := (v ->> 'start_on')::date; e := nullif(v ->> 'end_on', '')::date;
  exception when others then raise exception 'invalid_value: check the window and dates';
  end;
  if wf is null or wt is null or wt <= wf then raise exception 'invalid_slot'; end if;
  if s is null or s < public.muscat_day(now()) or s > public.muscat_day(now()) + 90 then raise exception 'invalid_value: start within the next 90 days'; end if;
  if e is not null and e < s then raise exception 'invalid_value: the end date is before the start'; end if;
  if e is null and nullif(v ->> 'max_count', '') is null then raise exception 'invalid_value: give an end date or a number of deliveries'; end if;
  if (select count(*) from public.recurring_orders where customer_id = auth.uid() and status <> 'ended') >= 10 then raise exception 'too_many_plans'; end if;
  insert into public.recurring_orders (customer_id, property_id, lat, lng, area, address, details, service_type, gallons, every_n, unit,
                                       window_from, window_to, start_on, end_on, max_count, pay_method, card_last4, driver_note)
  values (auth.uid(), pr.id, lat, lng, left(area, 120), left(coalesce(addr, ''), 300), public.address_details(v -> 'details'),
          (v ->> 'service_type')::public.service_type, (v ->> 'gallons')::int, (v ->> 'every_n')::int, v ->> 'unit',
          wf, wt, s, e, nullif(v ->> 'max_count', '')::int, coalesce(v ->> 'pay_method', 'card'),
          case when v ->> 'card_last4' ~ '^[0-9]{4}$' then v ->> 'card_last4' end, nullif(left(btrim(coalesce(v ->> 'driver_note', '')), 300), ''))
  returning * into r;
  return r;
end $$;

-- pause / resume / end the plan, or skip one delivery (default: the next one).
create function public.recurring_action(p_id uuid, p_action text, p_date date default null)
returns public.recurring_orders
language plpgsql security definer set search_path = public
as $$
declare r public.recurring_orders; d date;
begin
  select * into r from public.recurring_orders where id = p_id and customer_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'pause' and r.status = 'active' then update public.recurring_orders set status = 'paused', updated_at = now() where id = r.id returning * into r;
  elsif p_action = 'resume' and r.status = 'paused' then update public.recurring_orders set status = 'active', last_error = null, updated_at = now() where id = r.id returning * into r;
  elsif p_action = 'end' and r.status <> 'ended' then update public.recurring_orders set status = 'ended', updated_at = now() where id = r.id returning * into r;
  elsif p_action = 'skip' and r.status <> 'ended' then
    d := coalesce(p_date, public.recurring_next_date(r, public.muscat_day(now())));
    if d is null then raise exception 'invalid_state: no delivery to skip'; end if;
    if exists (select 1 from public.recurring_occurrences where plan_id = r.id and on_date = d and state = 'created') then
      raise exception 'already_created: cancel that order instead';
    end if;
    insert into public.recurring_occurrences (plan_id, on_date, state) values (r.id, d, 'skipped')
    on conflict (plan_id, on_date) do update set state = 'skipped', at = now();
  else raise exception 'invalid_transition'; end if;
  return r;
end $$;

-- The customer's plans with the next delivery.
create function public.my_recurring_orders()
returns table (plan public.recurring_orders, next_on date, next_state text, next_order uuid)
language sql stable security definer set search_path = public
as $$
  select r, n.d, x.state, x.order_id
    from public.recurring_orders r
    cross join lateral (select case when r.status = 'ended' then null else public.recurring_next_date(r, public.muscat_day(now())) end as d) n
    left join public.recurring_occurrences x on x.plan_id = r.id and x.on_date = n.d
   where r.customer_id = auth.uid()
   order by r.status = 'ended', r.created_at desc
$$;

-- pg_cron, every 15 minutes: the notice, then the order (as the customer, through create_order).
create function public.run_recurring_orders()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  cfg jsonb := coalesce(public.setting_json('RECURRING'), '{}'::jsonb);
  notice interval := make_interval(hours => coalesce((cfg ->> 'notice_hours')::int, 24));
  lead interval := make_interval(hours => coalesce((cfg ->> 'create_hours')::int, 12));
  p public.recurring_orders; d date; s timestamptz; e timestamptz; occ public.recurring_occurrences; o public.orders;
  prev_sub text := current_setting('request.jwt.claim.sub', true); prev_claims text := current_setting('request.jwt.claims', true);
  label text; declined boolean; notified integer := 0; created integer := 0; failed integer := 0; err text;
begin
  if auth.uid() is not null then perform public.require_staff(array['admin']::public.staff_role[]); end if;
  for p in select * from public.recurring_orders where status = 'active' order by created_at for update skip locked loop
    d := public.recurring_next_date(p, public.muscat_day(now()));
    if d is null then
      update public.recurring_orders set status = 'ended', updated_at = now() where id = p.id;
      continue;
    end if;
    s := (d + p.window_from) at time zone 'Asia/Muscat';
    e := (d + p.window_to) at time zone 'Asia/Muscat';
    label := to_char(d, 'Dy DD Mon') || ' · ' || to_char(p.window_from, 'HH24:MI') || '–' || to_char(p.window_to, 'HH24:MI');
    select * into occ from public.recurring_occurrences where plan_id = p.id and on_date = d;
    if e - interval '30 minutes' <= now() then
      -- Missed (the plan was paused over it, or the job didn't run): record it and move on.
      insert into public.recurring_occurrences (plan_id, on_date, state, error) values (p.id, d, 'failed', 'Window passed before the order was created')
      on conflict (plan_id, on_date) do update set state = 'failed', error = excluded.error, at = now();
      continue;
    end if;
    if occ.id is null and s - now() <= notice then
      insert into public.recurring_occurrences (plan_id, on_date, state) values (p.id, d, 'notified');
      perform public.notify(p.customer_id, 'recurring_upcoming', null, jsonb_build_object(
        'window', label, 'gallons', p.gallons::text, 'plan', p.plan_no::text,
        'service', case p.service_type when 'DW' then 'drinking water' when 'TE' then 'treated water' else 'wastewater pickup' end,
        'service_ar', case p.service_type when 'DW' then 'مياه الشرب' when 'TE' then 'المياه المعالجة' else 'سحب مياه الصرف' end));
      notified := notified + 1;
    end if;
    if s - now() <= lead then
      -- A saved card the simulated gateway declines (0002) doesn't stop the delivery (0043).
      declined := p.card_last4 = '0002' and p.pay_method in ('card', 'wallet_card');
      begin
        perform set_config('request.jwt.claim.sub', p.customer_id::text, true);
        perform set_config('request.jwt.claims', json_build_object('sub', p.customer_id, 'role', 'authenticated')::text, true);
        o := public.create_order(p.service_type, p.gallons, p.lat, p.lng, p.area, p.address, p.property_id, s, e, label, false, p.driver_note,
                                 p.pay_method, case when declined then null else p.card_last4 end, null);
        if o.status = 'cancelled' then raise exception 'payment_failed'; end if;
        if p.details <> '{}'::jsonb then perform public.set_order_details(o.id, p.details); end if;
        perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true);
        perform set_config('request.jwt.claims', coalesce(prev_claims, ''), true);
        if declined and o.payment_status = 'authorized' then
          update public.payments set status = 'pending', confirmed_at = null, gateway_ref = 'AUTOPAY-RP' || p.plan_no || '-' || o.order_no,
                                     card_last4 = '0002', failure_reason = 'Saved card declined (simulated)'
           where order_id = o.id and status = 'authorized' and card_amount > 0;
          if found then
            update public.orders set payment_status = 'pending', payment_followup = 'autopay_failed', payment_followup_at = now() where id = o.id;
            perform public.notify(p.customer_id, 'autopay_failed', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'slot', label));
          end if;
        end if;
        update public.orders set recurring_id = p.id where id = o.id;
        insert into public.recurring_occurrences (plan_id, on_date, state, order_id) values (p.id, d, 'created', o.id)
        on conflict (plan_id, on_date) do update set state = 'created', order_id = excluded.order_id, error = null, at = now();
        update public.recurring_orders set created_count = created_count + 1, last_error = null, updated_at = now(),
                                           status = case when max_count is not null and created_count + 1 >= max_count then 'ended' else status end
         where id = p.id;
        created := created + 1;
      exception when others then
        err := split_part(sqlerrm, ':', 1);
        perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true);
        perform set_config('request.jwt.claims', coalesce(prev_claims, ''), true);
        insert into public.recurring_occurrences (plan_id, on_date, state, error) values (p.id, d, 'failed', left(sqlerrm, 300))
        on conflict (plan_id, on_date) do update set state = 'failed', error = excluded.error, at = now();
        update public.recurring_orders set last_error = left(sqlerrm, 300), updated_at = now() where id = p.id;
        perform public.notify(p.customer_id, 'recurring_failed', null, jsonb_build_object('plan', p.plan_no::text, 'window', label,
          'reason', case err when 'zone_disabled' then 'deliveries are paused in this area' when 'slot_blocked' then 'that window is closed on this day'
                             when 'account_blocked' then 'the account is on hold' when 'identity_required' then 'ID verification is needed'
                             when 'insufficient_wallet' then 'not enough in the wallet' else 'it couldn''t be placed' end,
          'reason_ar', case err when 'zone_disabled' then 'التوصيل متوقف في هذه المنطقة' when 'slot_blocked' then 'هذه الفترة مغلقة في ذلك اليوم'
                                when 'account_blocked' then 'الحساب موقوف' when 'identity_required' then 'يلزم التحقق من الهوية'
                                when 'insufficient_wallet' then 'رصيد المحفظة غير كافٍ' else 'تعذّر إنشاء الطلب' end));
        failed := failed + 1;
      end;
    end if;
  end loop;
  return jsonb_build_object('notified', notified, 'created', created, 'failed', failed);
end $$;

-- NWS → Orders: scheduled volume per day (orders already booked, and recurring deliveries not yet
-- created), test-zone orders apart.
create function public.staff_scheduled_volume(p_days integer default 14)
returns table (day date, orders integer, gallons integer, dw_gal integer, ww_gal integer, te_gal integer, recurring_planned integer, recurring_gal integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    with days as (select (public.muscat_day(now()) + g)::date as day from generate_series(0, greatest(least(coalesce(p_days, 14), 60), 1) - 1) g),
    booked as (
      select public.muscat_day(o.slot_start) as day, count(*)::int as n, sum(o.gallons)::int as gal,
             sum(o.gallons) filter (where o.service_type = 'DW')::int as dw, sum(o.gallons) filter (where o.service_type = 'WW')::int as ww,
             sum(o.gallons) filter (where o.service_type = 'TE')::int as te
        from public.orders o
       where o.slot_start is not null and not o.is_test and o.status in ('scheduled', 'requested', 'accepted', 'arriving', 'arrived', 'collected', 'pending_approval')
         and public.muscat_day(o.slot_start) between public.muscat_day(now()) and public.muscat_day(now()) + greatest(least(coalesce(p_days, 14), 60), 1)
       group by 1),
    planned as (
      select d.day, count(*)::int as n, sum(r.gallons)::int as gal
        from days d join public.recurring_orders r on r.status = 'active' and d.day >= r.start_on and (r.end_on is null or d.day <= r.end_on)
         and ((d.day - r.start_on) % (r.every_n * case when r.unit = 'weeks' then 7 else 1 end)) = 0
       where not exists (select 1 from public.recurring_occurrences x where x.plan_id = r.id and x.on_date = d.day and x.state in ('created', 'skipped', 'failed'))
       group by d.day)
    select d.day, coalesce(b.n, 0), coalesce(b.gal, 0), coalesce(b.dw, 0), coalesce(b.ww, 0), coalesce(b.te, 0), coalesce(p.n, 0), coalesce(p.gal, 0)
      from days d left join booked b on b.day = d.day left join planned p on p.day = d.day
     order by d.day;
end $$;

select public.nama_schedule('nama-recurring-orders', '*/15 * * * *', 'select public.run_recurring_orders()');

revoke execute on function public.orders_slot_guard(), public.recurring_next_date(public.recurring_orders, date) from public, anon, authenticated;
revoke execute on function public.window_ranges_ok(jsonb, boolean), public.window_template_for(date), public.range_ts(date, text),
  public.slot_blocked(timestamptz, timestamptz), public.delivery_windows(integer), public.staff_save_window_template(uuid, jsonb, text),
  public.staff_delete_window_template(uuid, text), public.save_recurring_order(jsonb), public.recurring_action(uuid, text, date),
  public.my_recurring_orders(), public.run_recurring_orders(), public.staff_scheduled_volume(integer)
from public, anon;
grant execute on function public.window_ranges_ok(jsonb, boolean), public.window_template_for(date), public.range_ts(date, text),
  public.slot_blocked(timestamptz, timestamptz), public.delivery_windows(integer), public.staff_save_window_template(uuid, jsonb, text),
  public.staff_delete_window_template(uuid, text), public.save_recurring_order(jsonb), public.recurring_action(uuid, text, date),
  public.my_recurring_orders(), public.run_recurring_orders(), public.staff_scheduled_volume(integer)
to authenticated;
