-- Fleet: Naql vehicle and insurance fields, part-time availability, driver tiers (items 28, 30, 31).
--
-- #28 Tankers carry their Naql registration, vehicle operating card (number, expiry), chassis/VIN,
--     make/model/year, declared and NWS-verified tank capacity, insurance (company, policy,
--     expiry) and the IVMS tracking device ID. The company owner (or the independent driver)
--     edits them; NWS verifies them in Permits/Fleet. Expiry reminders come from 0026's
--     send_expiry_reminders (extended here). An expired operating card or insurance makes the
--     tanker ineligible: it can't go online or be assigned, and dispatch shows the reason.
-- #30 Drivers set weekly hours per day and a "not available until" date. Dispatch and
--     auto-offer skip drivers outside them; going online anyway is allowed (the app shows a note).
-- #31 Bronze/silver/gold tiers, computed nightly from the last 30 days (on-time rate, rating,
--     acceptance rate, completed jobs, overcharge reports, penalties) with thresholds in the
--     DRIVER_TIERS setting. A tier boosts the dispatch ranking and the auto-offer order; it never
--     touches a price.

-- ===========================================================================
-- #28 Vehicle and insurance fields
-- ===========================================================================
alter table public.tankers
  add column naql_reg_no           text check (char_length(naql_reg_no) <= 30),
  add column op_card_no            text check (char_length(op_card_no) <= 30),
  add column op_card_expiry        date,
  add column vin                   text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$'),
  add column make                  text check (char_length(make) <= 40),
  add column model                 text check (char_length(model) <= 40),
  add column model_year            integer check (model_year is null or model_year between 1970 and 2100),
  add column tank_capacity_gal     integer check (tank_capacity_gal is null or tank_capacity_gal between 100 and 20000),
  add column capacity_verified_gal integer check (capacity_verified_gal is null or capacity_verified_gal between 100 and 20000),
  add column insurance_company     text check (char_length(insurance_company) <= 80),
  add column insurance_policy_no   text check (char_length(insurance_policy_no) <= 40),
  add column insurance_expiry      date,
  add column tracking_device_id    text check (tracking_device_id is null or tracking_device_id ~ '^IV-[0-9]{4,6}$'),
  add column vehicle_status        text not null default 'unverified' check (vehicle_status in ('unverified', 'submitted', 'verified', 'rejected')),
  add column vehicle_note          text check (char_length(vehicle_note) <= 300),
  add column vehicle_verified_at   timestamptz,
  add column vehicle_verified_by   uuid references public.profiles (id) on delete set null,
  add column vehicle_updated_at    timestamptz;

-- Why a tanker's vehicle papers stop it working today (Muscat date): an expiry date that is
-- set and has passed. Unset dates don't block (the fields are new and optional).
create function public.tanker_vehicle_blockers(p_tanker uuid)
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_remove(array[
           case when t.op_card_expiry is not null and t.op_card_expiry < public.muscat_day(now()) then 'Vehicle operating card expired' end,
           case when t.insurance_expiry is not null and t.insurance_expiry < public.muscat_day(now()) then 'Insurance expired' end
         ]::text[], null), '{}')
    from public.tankers t where t.id = p_tanker
$$;

-- Going online with expired papers is refused (like a missing permit).
create function public.tanker_vehicle_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare b text[];
begin
  if new.is_online and (tg_op = 'INSERT' or not old.is_online) then
    b := array_remove(array[
           case when new.op_card_expiry is not null and new.op_card_expiry < public.muscat_day(now()) then 'Vehicle operating card expired' end,
           case when new.insurance_expiry is not null and new.insurance_expiry < public.muscat_day(now()) then 'Insurance expired' end]::text[], null);
    if cardinality(b) > 0 then raise exception 'vehicle_documents_expired: %', array_to_string(b, ', '); end if;
  end if;
  return new;
end $$;
create trigger tankers_vehicle_guard before insert or update of is_online on public.tankers
  for each row execute function public.tanker_vehicle_guard();

-- Every way an order gets a tanker (driver accept, NWS assign, auto-offer accept) goes through
-- requested → accepted: refuse it there for a tanker with expired papers.
create function public.orders_vehicle_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare b text[];
begin
  if new.tanker_id is not null then
    b := public.tanker_vehicle_blockers(new.tanker_id);
    if cardinality(b) > 0 then raise exception 'vehicle_documents_expired: %', array_to_string(b, ', '); end if;
  end if;
  return new;
end $$;
create trigger orders_vehicle_guard before update of status on public.orders
  for each row when (new.status = 'accepted' and old.status = 'requested') execute function public.orders_vehicle_guard();

-- Owner (company tanker) or independent driver (own tanker): save the vehicle fields. Any
-- change goes back to NWS for verification.
create function public.save_tanker_vehicle(p_tanker uuid, p_v jsonb)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare
  t public.tankers; v jsonb := coalesce(p_v, '{}'::jsonb);
  txt jsonb := '{"naql_reg_no": 30, "op_card_no": 30, "make": 40, "model": 40, "insurance_company": 80, "insurance_policy_no": 40}';
  k text; s text; out jsonb := '{}'::jsonb; v_vin text; v_dev text; yr integer; cap integer; d1 date; d2 date;
begin
  select * into t from public.tankers where id = p_tanker for update;
  if not found then raise exception 'not_found'; end if;
  if not ((public.is_owner() and public.in_my_company(t.id))
          or (public.my_role() = 'driver' and public.my_tanker_id() = t.id and t.company_id is null)) then
    raise exception 'not_found';
  end if;
  if jsonb_typeof(v) <> 'object' then raise exception 'invalid_value'; end if;
  for k in select jsonb_object_keys(txt) loop
    s := nullif(btrim(coalesce(v ->> k, '')), '');
    if char_length(s) > (txt ->> k)::integer then raise exception 'invalid_value: % is too long', k; end if;
    out := out || jsonb_build_object(k, s);
  end loop;
  v_vin := nullif(upper(regexp_replace(coalesce(v ->> 'vin', ''), '[\s-]', '', 'g')), '');
  if v_vin is not null and v_vin !~ '^[A-HJ-NPR-Z0-9]{11,17}$' then raise exception 'invalid_value: chassis / VIN must be 11–17 letters and digits (no I, O or Q)'; end if;
  v_dev := nullif(upper(btrim(coalesce(v ->> 'tracking_device_id', ''))), '');
  if v_dev is not null and v_dev !~ '^IV-[0-9]{4,6}$' then raise exception 'invalid_value: tracking device ID looks like IV-1234'; end if;
  begin
    yr := nullif(v ->> 'model_year', '')::integer;
    cap := nullif(v ->> 'tank_capacity_gal', '')::integer;
    d1 := nullif(v ->> 'op_card_expiry', '')::date;
    d2 := nullif(v ->> 'insurance_expiry', '')::date;
  exception when others then
    raise exception 'invalid_value: check the year, capacity and dates';
  end;
  if yr is not null and (yr < 1970 or yr > extract(year from now())::int + 1) then raise exception 'invalid_value: model year'; end if;
  if cap is not null and (cap < 100 or cap > 20000) then raise exception 'invalid_value: tank capacity must be 100–20,000 gal'; end if;
  update public.tankers
     set naql_reg_no = out ->> 'naql_reg_no', op_card_no = out ->> 'op_card_no', op_card_expiry = d1, vin = v_vin, make = out ->> 'make', model = out ->> 'model',
         model_year = yr, tank_capacity_gal = cap, insurance_company = out ->> 'insurance_company', insurance_policy_no = out ->> 'insurance_policy_no',
         insurance_expiry = d2, tracking_device_id = v_dev,
         vehicle_status = 'submitted', vehicle_verified_at = null, vehicle_verified_by = null, vehicle_note = null, vehicle_updated_at = now(),
         capacity_verified_gal = case when cap is distinct from t.tank_capacity_gal then null else t.capacity_verified_gal end
   where id = t.id returning * into t;
  return t;
end $$;

-- NWS (permit officers, admins) verifies or rejects the vehicle details, optionally recording the
-- tank capacity it measured. Audited.
create function public.staff_verify_tanker_vehicle(p_tanker uuid, p_decision text, p_capacity_gal integer default null, p_note text default null)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare b public.tankers; a public.tankers; r text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if p_decision not in ('verify', 'reject') then raise exception 'invalid_decision'; end if;
  if p_decision = 'reject' then r := public.require_reason(p_note); end if;
  if p_capacity_gal is not null and (p_capacity_gal < 100 or p_capacity_gal > 20000) then raise exception 'invalid_value: tank capacity must be 100–20,000 gal'; end if;
  select * into b from public.tankers where id = p_tanker for update;
  if not found then raise exception 'not_found'; end if;
  update public.tankers
     set vehicle_status = case when p_decision = 'verify' then 'verified' else 'rejected' end,
         vehicle_note = left(r, 300), vehicle_verified_at = now(), vehicle_verified_by = auth.uid(),
         capacity_verified_gal = case when p_decision = 'verify' then coalesce(p_capacity_gal, b.tank_capacity_gal, b.capacity_verified_gal) else b.capacity_verified_gal end
   where id = b.id returning * into a;
  perform public.write_audit('tanker.vehicle_' || p_decision, 'tanker', a.id::text,
    jsonb_build_object('vehicle_status', b.vehicle_status, 'capacity_verified_gal', b.capacity_verified_gal),
    jsonb_build_object('vehicle_status', a.vehicle_status, 'capacity_verified_gal', a.capacity_verified_gal), r);
  return a;
end $$;

-- ===========================================================================
-- #28 Expiry reminders: 0026's function, plus operating cards and insurance; tankers whose
-- papers have expired are taken offline.
-- ===========================================================================
alter table public.reminder_log drop constraint if exists reminder_log_kind_check;
alter table public.reminder_log add constraint reminder_log_kind_check check (kind in ('permit', 'document', 'refill', 'vehicle'));

create or replace function public.send_expiry_reminders()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r record; stage text; days integer; permits integer := 0; docs integer := 0; vehicles integer := 0; offline integer := 0;
  label constant jsonb := '{"mulkiya":"Mulkiya","tank_cleanliness":"Tank cleanliness certificate","rop_inspection":"ROP inspection","insurance":"Insurance","ivms_certificate":"IVMS certificate","heavy_licence":"Heavy vehicle licence","water_test":"Water test certificate"}';
  vlabel constant jsonb := '{"op_card": ["Vehicle operating card", "بطاقة تشغيل المركبة"], "insurance": ["Vehicle insurance", "تأمين المركبة"]}';
  today date := public.muscat_day(now());
begin
  for r in select p.*, t.plate, t.company_id from public.permits p join public.tankers t on t.id = p.tanker_id
            where p.status = 'approved' and p.expires_at > now() and p.expires_at <= now() + interval '30 days'
              and not exists (select 1 from public.permits n where n.tanker_id = p.tanker_id and n.status = 'pending') loop
    days := ceil(extract(epoch from r.expires_at - now()) / 86400)::integer;
    stage := case when days <= 1 then 'd1' when days <= 7 then 'd7' when days <= 14 then 'd14' else 'd30' end;
    insert into public.reminder_log (kind, subject_id, stage) values ('permit', r.id, stage) on conflict do nothing;
    if found then
      perform public.notify_permit(r.id, 'permit_expiring', jsonb_build_object('date', to_char(r.expires_at at time zone 'Asia/Muscat', 'DD Mon YYYY'),
                                                                                'date_ar', to_char(r.expires_at at time zone 'Asia/Muscat', 'YYYY-MM-DD')));
      if r.company_id is null then
        perform public.notify(a.driver_id, 'permit_expiring', null, jsonb_build_object('plate', r.plate, 'permit', r.permit_no,
                                'date', to_char(r.expires_at at time zone 'Asia/Muscat', 'DD Mon YYYY'), 'date_ar', to_char(r.expires_at at time zone 'Asia/Muscat', 'YYYY-MM-DD')))
           from public.tanker_assignments a where a.tanker_id = r.tanker_id and a.unassigned_at is null and a.driver_id is distinct from r.applied_by;
      end if;
      update public.permits set reminded_at = now() where id = r.id;
      permits := permits + 1;
    end if;
  end loop;

  for r in select d.*, t.plate, coalesce(t.company_id, (select company_id from public.profiles where id = d.driver_id)) as co
             from public.tanker_documents d left join public.tankers t on t.id = d.tanker_id
            where d.status = 'valid' and d.valid_to >= current_date and d.valid_to <= current_date + 30 loop
    days := r.valid_to - current_date;
    stage := case when days <= 1 then 'd1' when days <= 7 then 'd7' when days <= 14 then 'd14' else 'd30' end;
    insert into public.reminder_log (kind, subject_id, stage) values ('document', r.id, stage) on conflict do nothing;
    if found then
      perform public.notify(u.id, 'document_expiring', null, jsonb_build_object('document', coalesce(label ->> r.kind, r.kind), 'plate', coalesce(r.plate, 'your licence'),
                                                                                 'date', to_char(r.valid_to, 'DD Mon YYYY'), 'date_ar', to_char(r.valid_to, 'YYYY-MM-DD')))
         from (select pr.id from public.profiles pr where r.co is not null and pr.company_id = r.co and pr.role = 'owner'
               union select r.driver_id where r.driver_id is not null
               union select a.driver_id from public.tanker_assignments a where r.co is null and a.tanker_id = r.tanker_id and a.unassigned_at is null) u
        where u.id is not null;
      docs := docs + 1;
    end if;
  end loop;

  -- #28: the operating card and insurance on the tanker itself. The stage carries the date, so a
  -- renewed card is reminded again before its new expiry.
  for r in select t.id, t.plate, t.company_id, k.kind, k.d
             from public.tankers t
             cross join lateral (values ('op_card', t.op_card_expiry), ('insurance', t.insurance_expiry)) as k(kind, d)
            where t.on_platform and k.d is not null and k.d >= today and k.d <= today + 30 loop
    days := r.d - today;
    stage := r.kind || ':' || to_char(r.d, 'YYYYMMDD') || ':' || case when days <= 1 then 'd1' when days <= 7 then 'd7' when days <= 14 then 'd14' else 'd30' end;
    insert into public.reminder_log (kind, subject_id, stage) values ('vehicle', r.id, stage) on conflict do nothing;
    if found then
      perform public.notify(u.id, 'document_expiring', null, jsonb_build_object('document', vlabel -> r.kind ->> 0, 'document_ar', vlabel -> r.kind ->> 1, 'plate', r.plate,
                                                                                 'date', to_char(r.d, 'DD Mon YYYY'), 'date_ar', to_char(r.d, 'YYYY-MM-DD')))
         from (select pr.id from public.profiles pr where r.company_id is not null and pr.company_id = r.company_id and pr.role = 'owner'
               union select a.driver_id from public.tanker_assignments a where a.tanker_id = r.id and a.unassigned_at is null) u
        where u.id is not null;
      vehicles := vehicles + 1;
    end if;
  end loop;
  update public.tankers t set is_online = false
   where t.is_online and ((t.op_card_expiry is not null and t.op_card_expiry < today) or (t.insurance_expiry is not null and t.insurance_expiry < today));
  get diagnostics offline = row_count;
  return jsonb_build_object('permits', permits, 'documents', docs, 'vehicles', vehicles, 'taken_offline', offline);
end $$;

-- ===========================================================================
-- #30 Part-time availability
-- ===========================================================================
-- Hours per weekday (0 = Sunday, Muscat time). A row with no hours keeps 0010's meaning (the
-- shift label only) and doesn't restrict dispatch; available = false does. An end before the
-- start runs past midnight (22:00–06:00), counted on the day it starts.
alter table public.driver_availability
  add column start_time time,
  add column end_time   time,
  add constraint driver_availability_hours check ((start_time is null) = (end_time is null) and (start_time is null or start_time <> end_time));

create function public.driver_available_at(p_driver uuid, p_at timestamptz default now())
returns boolean
language sql stable security definer set search_path = public
as $$
  with m as (select (coalesce(p_at, now()) at time zone 'Asia/Muscat') as lt)
  select case
    when p_driver is null then true
    when exists (select 1 from public.driver_profiles dp, m where dp.driver_id = p_driver and dp.unavailable_until is not null and m.lt::date < dp.unavailable_until) then false
    else coalesce((select case when not a.available then false
                               when a.start_time is null then true
                               when a.start_time < a.end_time then m.lt::time >= a.start_time and m.lt::time < a.end_time
                               else m.lt::time >= a.start_time or m.lt::time < a.end_time end
                     from public.driver_availability a, m
                    where a.driver_id = p_driver and a.weekday = extract(dow from m.lt)::int), true)
  end
$$;

-- Why a driver is unavailable now (the dispatch blocker text), or null.
create function public.driver_availability_note(p_driver uuid, p_at timestamptz default now())
returns text
language sql stable security definer set search_path = public
as $$
  with m as (select (coalesce(p_at, now()) at time zone 'Asia/Muscat') as lt)
  select case
    when public.driver_available_at(p_driver, p_at) then null
    when exists (select 1 from public.driver_profiles dp, m where dp.driver_id = p_driver and m.lt::date < dp.unavailable_until)
      then 'Not available until ' || (select to_char(dp.unavailable_until, 'DD Mon YYYY') from public.driver_profiles dp where dp.driver_id = p_driver)
    else coalesce((select case when not a.available then 'Not available on ' || to_char(m.lt, 'Dy')
                               else format('Outside availability (%s %s–%s)', to_char(m.lt, 'Dy'), to_char(a.start_time, 'HH24:MI'), to_char(a.end_time, 'HH24:MI')) end
                     from public.driver_availability a, m where a.driver_id = p_driver and a.weekday = extract(dow from m.lt)::int), 'Outside availability')
  end
$$;

-- The driver (or their company owner) sets a day: available or not, and optional hours.
create function public.set_availability_hours(p_weekday integer, p_available boolean, p_start time default null, p_end time default null, p_driver_id uuid default null)
returns public.driver_availability
language plpgsql security definer set search_path = public
as $$
declare a public.driver_availability; target uuid := coalesce(p_driver_id, auth.uid());
begin
  if target = auth.uid() then
    if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  elsif not (public.is_owner() and exists (select 1 from public.profiles where id = target and role = 'driver' and company_id = public.my_company_id())) then
    raise exception 'not_found';
  end if;
  if p_weekday is null or p_weekday not between 0 and 6 then raise exception 'invalid_value: weekday'; end if;
  if (p_start is null) <> (p_end is null) or (p_start is not null and p_start = p_end) then raise exception 'invalid_value: give a start and an end time'; end if;
  insert into public.driver_availability (driver_id, weekday, available, shift, start_time, end_time)
  values (target, p_weekday, coalesce(p_available, true),
          case when p_start is null then 'day' when p_start < time '14:00' and p_start >= time '06:00' then 'day' when p_start >= time '14:00' and p_start < time '22:00' then 'evening' else 'night' end,
          p_start, p_end)
  on conflict (driver_id, weekday) do update
     set available = excluded.available, start_time = excluded.start_time, end_time = excluded.end_time,
         shift = case when excluded.start_time is null then driver_availability.shift else excluded.shift end
  returning * into a;
  return a;
end $$;

-- "Not available until" (back on that date); null clears it.
create function public.set_unavailable_until(p_date date, p_driver_id uuid default null)
returns public.driver_profiles
language plpgsql security definer set search_path = public
as $$
declare dp public.driver_profiles; target uuid := coalesce(p_driver_id, auth.uid());
begin
  if target = auth.uid() then
    if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  elsif not (public.is_owner() and exists (select 1 from public.profiles where id = target and role = 'driver' and company_id = public.my_company_id())) then
    raise exception 'not_found';
  end if;
  if p_date is not null and (p_date <= public.muscat_day(now()) or p_date > public.muscat_day(now()) + 366) then
    raise exception 'invalid_value: pick a date within the next year';
  end if;
  insert into public.driver_profiles (driver_id, unavailable_until, updated_at) values (target, p_date, now())
  on conflict (driver_id) do update set unavailable_until = excluded.unavailable_until, updated_at = now()
  returning * into dp;
  return dp;
end $$;

-- For the driver app's note when going online outside the hours.
create function public.my_availability_now()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('available', public.driver_available_at(auth.uid()), 'note', public.driver_availability_note(auth.uid()),
                            'unavailable_until', (select unavailable_until from public.driver_profiles where driver_id = auth.uid()))
$$;

-- ===========================================================================
-- #31 Driver tiers
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('DRIVER_TIERS',
   '{"silver": {"on_time_pct": 85, "rating": 4.3, "acceptance_pct": 60, "jobs_30d": 15, "max_overcharge": 1, "max_penalties": 2}, "gold": {"on_time_pct": 95, "rating": 4.7, "acceptance_pct": 80, "jobs_30d": 40, "max_overcharge": 0, "max_penalties": 0}, "boost": {"silver": 3, "gold": 6}, "min_rated": 5}',
   'Driver tiers (computed nightly from the last 30 days). A tier needs every threshold: on-time %, average rating (with at least min_rated ratings), offer acceptance % (ignored without offers), completed jobs, and at most max_overcharge overcharge reports and max_penalties penalties. boost = minutes taken off the dispatch score (ranking and auto-offer order only; prices never change). Thresholds are assumptions until NWS sets them.')
on conflict (key) do nothing;

-- A driver's last-30-days numbers (test-zone orders left out).
create function public.driver_tier_stats(p_driver uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with rated as (select x.rating from public.orders x where x.driver_id = p_driver and not x.is_test and x.rating is not null and x.rated_at > now() - interval '30 days'),
  offers as (
    select o.driver_id from public.orders o
     where not o.is_test and o.created_at > now() - interval '30 days'
       and exists (select 1 from public.tanker_assignments a where a.driver_id = p_driver and a.tanker_id = any(o.offered_tankers))),
  sla as (
    select count(*)::int as n, count(*) filter (where public.sla_served_at(o) is not null)::int as served,
           count(*) filter (where public.sla_state(o) = 'on_time')::int as on_time
      from public.orders o
     where o.driver_id = p_driver and not o.is_test and o.status = 'delivered' and o.delivered_at > now() - interval '30 days')
  select jsonb_build_object(
    'jobs_30d', (select n from sla),
    'on_time_pct', (select case when served = 0 then null else round(100.0 * on_time / served, 1) end from sla),
    'rating', (select round(avg(rating)::numeric, 2) from rated),
    'ratings', (select count(*)::int from rated),
    'acceptance_pct', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where driver_id = p_driver) / count(*), 1) end from offers),
    'offers', (select count(*)::int from offers),
    'overcharge', (select count(*)::int from public.complaints c join public.orders o on o.id = c.order_id
                    where c.category = 'overcharge' and o.driver_id = p_driver and c.created_at > now() - interval '30 days'),
    'penalties', (select count(*)::int from public.penalties p where p.driver_id = p_driver and p.state <> 'cancelled' and p.created_at > now() - interval '30 days'))
$$;

-- What a set of stats is missing for one tier's thresholds: [{metric, have, need}].
create function public.tier_gaps(p_stats jsonb, p_th jsonb, p_min_rated integer)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(g) filter (where g is not null), '[]'::jsonb) from (values
    (case when coalesce((p_stats ->> 'jobs_30d')::numeric, 0) < (p_th ->> 'jobs_30d')::numeric
          then jsonb_build_object('metric', 'jobs_30d', 'have', coalesce((p_stats ->> 'jobs_30d')::numeric, 0), 'need', (p_th ->> 'jobs_30d')::numeric) end),
    (case when coalesce((p_stats ->> 'on_time_pct')::numeric, 0) < (p_th ->> 'on_time_pct')::numeric
          then jsonb_build_object('metric', 'on_time_pct', 'have', (p_stats ->> 'on_time_pct')::numeric, 'need', (p_th ->> 'on_time_pct')::numeric) end),
    (case when coalesce((p_stats ->> 'ratings')::int, 0) < p_min_rated
          then jsonb_build_object('metric', 'ratings', 'have', coalesce((p_stats ->> 'ratings')::int, 0), 'need', p_min_rated)
          when coalesce((p_stats ->> 'rating')::numeric, 0) < (p_th ->> 'rating')::numeric
          then jsonb_build_object('metric', 'rating', 'have', (p_stats ->> 'rating')::numeric, 'need', (p_th ->> 'rating')::numeric) end),
    (case when (p_stats ->> 'acceptance_pct') is not null and (p_stats ->> 'acceptance_pct')::numeric < (p_th ->> 'acceptance_pct')::numeric
          then jsonb_build_object('metric', 'acceptance_pct', 'have', (p_stats ->> 'acceptance_pct')::numeric, 'need', (p_th ->> 'acceptance_pct')::numeric) end),
    (case when coalesce((p_stats ->> 'overcharge')::int, 0) > (p_th ->> 'max_overcharge')::int
          then jsonb_build_object('metric', 'overcharge', 'have', (p_stats ->> 'overcharge')::int, 'need', (p_th ->> 'max_overcharge')::int) end),
    (case when coalesce((p_stats ->> 'penalties')::int, 0) > (p_th ->> 'max_penalties')::int
          then jsonb_build_object('metric', 'penalties', 'have', (p_stats ->> 'penalties')::int, 'need', (p_th ->> 'max_penalties')::int) end)
  ) as x(g)
$$;

create function public.tier_for(p_stats jsonb)
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when jsonb_array_length(public.tier_gaps(p_stats, c -> 'gold', coalesce((c ->> 'min_rated')::int, 5))) = 0 then 'gold'
    when jsonb_array_length(public.tier_gaps(p_stats, c -> 'silver', coalesce((c ->> 'min_rated')::int, 5))) = 0 then 'silver'
    else 'bronze' end
    from (select public.setting_json('DRIVER_TIERS') as c) s
$$;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('tier_changed', 'Driver tier changed', 'driver', 'You are now {tier}',
   'Your driver tier is now {tier}. Gold and silver drivers are offered jobs first. See what counts in Profile.',
   'مستواك الآن {tier}', 'أصبح مستواك كسائق {tier}. يحصل سائقو المستوى الذهبي والفضي على عروض المهام أولاً. اطّلع على المعايير في الملف الشخصي.',
   true, false, false, false, 'service', false)
on conflict (event) do nothing;

-- pg_cron, nightly: every driver's tier. Admins can run it from NWS too.
create function public.compute_driver_tiers()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r record; st jsonb; tier text; old text; n integer := 0; changed integer := 0;
begin
  if auth.uid() is not null then perform public.require_staff(array['admin']::public.staff_role[]); end if;
  for r in select p.id from public.profiles p where p.role = 'driver' loop
    st := public.driver_tier_stats(r.id);
    tier := public.tier_for(st);
    select dp.tier into old from public.driver_profiles dp where dp.driver_id = r.id;
    insert into public.driver_profiles (driver_id, tier, tier_stats, tier_computed_at, updated_at) values (r.id, tier, st, now(), now())
    on conflict (driver_id) do update set tier = excluded.tier, tier_stats = excluded.tier_stats, tier_computed_at = now(), updated_at = now();
    if coalesce(old, 'bronze') <> tier then
      changed := changed + 1;
      perform public.notify(r.id, 'tier_changed', null, jsonb_build_object('tier', initcap(tier),
                              'tier_ar', case tier when 'gold' then 'ذهبي' when 'silver' then 'فضي' else 'برونزي' end));
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('drivers', n, 'changed', changed);
end $$;

-- The driver's tier, numbers and what the next tier needs.
create function public.my_driver_tier()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with c as (select public.setting_json('DRIVER_TIERS') as c),
  me as (select coalesce(dp.tier, 'bronze') as tier, coalesce(nullif(dp.tier_stats, '{}'::jsonb), public.driver_tier_stats(auth.uid())) as stats, dp.tier_computed_at
           from (select auth.uid() as id) u left join public.driver_profiles dp on dp.driver_id = u.id)
  select jsonb_build_object('tier', me.tier, 'stats', me.stats, 'computed_at', me.tier_computed_at, 'thresholds', c.c,
                            'next', case me.tier when 'bronze' then 'silver' when 'silver' then 'gold' end,
                            'needs', case me.tier when 'gold' then '[]'::jsonb
                                       else public.tier_gaps(me.stats, c.c -> case me.tier when 'bronze' then 'silver' else 'gold' end, coalesce((c.c ->> 'min_rated')::int, 5)) end)
    from me, c
   where public.my_role() = 'driver'
$$;

-- Admins edit the thresholds (NWS → Settings → Dispatch). Audited.
create function public.staff_set_driver_tiers(p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text; t text; k text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  foreach t in array array['silver', 'gold'] loop
    if jsonb_typeof(p_value -> t) <> 'object' then raise exception 'invalid_value: % thresholds missing', t; end if;
    foreach k in array array['on_time_pct', 'acceptance_pct'] loop
      if coalesce((p_value -> t ->> k)::numeric, -1) not between 0 and 100 then raise exception 'invalid_value: % % must be 0–100', t, k; end if;
    end loop;
    if coalesce((p_value -> t ->> 'rating')::numeric, -1) not between 0 and 5 then raise exception 'invalid_value: % rating must be 0–5', t; end if;
    if coalesce((p_value -> t ->> 'jobs_30d')::numeric, -1) not between 0 and 1000 then raise exception 'invalid_value: % jobs must be 0–1000', t; end if;
    foreach k in array array['max_overcharge', 'max_penalties'] loop
      if coalesce((p_value -> t ->> k)::numeric, -1) not between 0 and 100 then raise exception 'invalid_value: % % must be 0–100', t, k; end if;
    end loop;
    if coalesce((p_value -> 'boost' ->> t)::numeric, -1) not between 0 and 60 then raise exception 'invalid_value: boost must be 0–60 minutes'; end if;
  end loop;
  if (p_value -> 'gold' ->> 'jobs_30d')::numeric < (p_value -> 'silver' ->> 'jobs_30d')::numeric
     or (p_value -> 'gold' ->> 'rating')::numeric < (p_value -> 'silver' ->> 'rating')::numeric
     or (p_value -> 'gold' ->> 'on_time_pct')::numeric < (p_value -> 'silver' ->> 'on_time_pct')::numeric then
    raise exception 'invalid_value: gold must ask at least as much as silver';
  end if;
  if coalesce((p_value ->> 'min_rated')::int, -1) not between 0 and 100 then raise exception 'invalid_value: min_rated must be 0–100'; end if;
  b := public.setting_json('DRIVER_TIERS');
  update public.app_settings set value = p_value::text where key = 'DRIVER_TIERS';
  perform public.write_audit('setting.update', 'setting', 'DRIVER_TIERS', b, p_value, r);
  return p_value;
end $$;

-- ===========================================================================
-- Dispatch ranking (0031) plus: vehicle papers, availability, tier boost; and the tier column
-- ===========================================================================
drop function public.dispatch_candidates(uuid, integer);
drop function public.dispatch_rank(uuid);

create function public.dispatch_rank(p_order uuid)
returns table (tanker_id uuid, plate text, driver_id uuid, driver_name text, company_name text, distance_km numeric, eta_min integer,
               jobs_today integer, rating numeric, score numeric, eligible boolean, reasons text[], blockers text[], tier text)
language plpgsql stable security definer set search_path = public
as $$
declare
  o public.orders; l public.order_locations; cfg jsonb := coalesce(public.setting_json('DISPATCH'), '{}'::jsonb);
  tiers jsonb := coalesce(public.setting_json('DRIVER_TIERS'), '{}'::jsonb);
  spd numeric := coalesce((cfg ->> 'speed_kmh')::numeric, 30);
  maxkm numeric := coalesce((cfg ->> 'max_km')::numeric, 40);
  wj numeric := coalesce((cfg ->> 'weight_jobs')::numeric, 6);
  wr numeric := coalesce((cfg ->> 'weight_rating')::numeric, 5);
  day0 timestamptz := (date_trunc('day', now() at time zone 'Asia/Muscat')) at time zone 'Asia/Muscat';
begin
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'not_found'; end if;
  select * into l from public.order_locations where order_id = p_order;
  return query
    with c as (
      select t.id, t.plate, a.driver_id as drv, p.full_name, co.name as cname, co.status as cstatus, t.company_id, t.is_online, t.blocked,
             t.capacity_gal, t.last_fix_at,
             case when t.last_lat is not null and l.lat is not null then public.km(t.last_lat, t.last_lng, l.lat, l.lng)::numeric end as dkm,
             (select count(*)::int from public.orders x where x.tanker_id = t.id and x.accepted_at >= day0 and x.status <> 'cancelled') as jobs,
             (select round(avg(x.rating)::numeric, 2) from public.orders x
               where x.driver_id = a.driver_id and x.rating is not null and x.rated_at > now() - interval '90 days') as rt,
             exists (select 1 from public.orders x where (x.tanker_id = t.id or (a.driver_id is not null and x.driver_id = a.driver_id))
                       and x.status in ('accepted', 'arriving', 'arrived', 'collected')) as busy,
             public.tanker_has_valid_permit(t.id) as permit_ok,
             public.position_is_test(t.last_lat, t.last_lng) as t_test,
             public.tanker_vehicle_blockers(t.id) as vb,
             case when a.driver_id is not null then public.driver_availability_note(a.driver_id) end as avail,
             coalesce(dp.tier, 'bronze') as tr
        from public.tankers t
        left join public.tanker_assignments a on a.tanker_id = t.id and a.unassigned_at is null
        left join public.profiles p on p.id = a.driver_id
        left join public.companies co on co.id = t.company_id
        left join public.driver_profiles dp on dp.driver_id = a.driver_id
       where t.service_type = o.service_type and t.on_platform),
    e as (
      select c.*,
             array_remove(array[
               case when not c.is_online then 'Offline' end,
               case when c.blocked then 'Blocked by NWS' end,
               case when c.drv is null then 'No driver assigned' end,
               case when not c.permit_ok then 'No valid permit' end,
               case when c.cstatus is not null and c.cstatus <> 'active' then 'Company ' || c.cstatus end,
               case when c.capacity_gal < o.gallons then format('Capacity %s gal is below %s gal', c.capacity_gal, o.gallons) end,
               case when c.busy then 'On another job' end,
               case when c.t_test <> o.is_test then case when o.is_test then 'Not in the test zone' else 'In the test zone' end end,
               case when c.last_fix_at is null or c.last_fix_at < now() - interval '10 minutes' then 'No GPS fix in the last 10 minutes' end,
               case when o.contract_id is not null and not exists (select 1 from public.contracts k where k.id = o.contract_id and k.company_id = c.company_id and k.status = 'active')
                    then 'Not the contract''s company' end,
               case when c.dkm > maxkm then format('%s km away (limit %s km)', round(c.dkm, 1), maxkm) end,
               c.avail
             ]::text[] || c.vb, null) as bl,
             coalesce((tiers -> 'boost' ->> c.tr)::numeric, 0) as boost
        from c)
    select e.id, e.plate, e.drv, e.full_name, e.cname, round(e.dkm, 1),
           case when e.dkm is not null then ceil(e.dkm / greatest(spd, 1) * 60)::int end,
           e.jobs, e.rt,
           round(coalesce(e.dkm / greatest(spd, 1) * 60, 999) + wj * e.jobs - wr * (coalesce(e.rt, 4.5) - 4.5) - e.boost, 1),
           cardinality(e.bl) = 0,
           array_remove(array[
             case when e.dkm is not null then format('%s km · ETA %s min', round(e.dkm, 1), ceil(e.dkm / greatest(spd, 1) * 60)::int) end,
             format('%s job%s today', e.jobs, case when e.jobs = 1 then '' else 's' end),
             case when e.rt is not null then format('Rating %s', to_char(e.rt, 'FM0.0')) else 'No ratings yet' end,
             case when e.capacity_gal >= o.gallons then format('%s gal tanker', e.capacity_gal) end,
             case when e.boost > 0 then format('%s tier (−%s min)', initcap(e.tr), e.boost) end
           ]::text[], null),
           e.bl,
           e.tr
      from e
     order by cardinality(e.bl) = 0 desc, 10, e.plate;
end $$;

create function public.dispatch_candidates(p_order uuid, p_limit integer default 8)
returns table (tanker_id uuid, plate text, driver_id uuid, driver_name text, company_name text, distance_km numeric, eta_min integer,
               jobs_today integer, rating numeric, score numeric, eligible boolean, reasons text[], blockers text[], tier text, offered boolean)
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'not_found'; end if;
  return query
    select r.*, r.tanker_id = any(o.offered_tankers) from public.dispatch_rank(p_order) r
     limit greatest(least(coalesce(p_limit, 8), 50), 1);
end $$;

select public.nama_schedule('nama-driver-tiers', '15 20 * * *', 'select public.compute_driver_tiers()');

-- ===========================================================================
-- Grants
-- ===========================================================================
revoke execute on function public.tanker_vehicle_guard(), public.orders_vehicle_guard(), public.dispatch_rank(uuid),
  public.driver_tier_stats(uuid), public.tier_for(jsonb)
from public, anon, authenticated;
revoke execute on function public.tanker_vehicle_blockers(uuid), public.save_tanker_vehicle(uuid, jsonb),
  public.staff_verify_tanker_vehicle(uuid, text, integer, text), public.driver_available_at(uuid, timestamptz),
  public.driver_availability_note(uuid, timestamptz), public.set_availability_hours(integer, boolean, time, time, uuid),
  public.set_unavailable_until(date, uuid), public.my_availability_now(), public.tier_gaps(jsonb, jsonb, integer),
  public.compute_driver_tiers(), public.my_driver_tier(), public.staff_set_driver_tiers(jsonb, text), public.dispatch_candidates(uuid, integer)
from public, anon;
grant execute on function public.tanker_vehicle_blockers(uuid), public.save_tanker_vehicle(uuid, jsonb),
  public.staff_verify_tanker_vehicle(uuid, text, integer, text), public.driver_available_at(uuid, timestamptz),
  public.driver_availability_note(uuid, timestamptz), public.set_availability_hours(integer, boolean, time, time, uuid),
  public.set_unavailable_until(date, uuid), public.my_availability_now(), public.tier_gaps(jsonb, jsonb, integer),
  public.compute_driver_tiers(), public.my_driver_tier(), public.staff_set_driver_tiers(jsonb, text), public.dispatch_candidates(uuid, integer)
to authenticated;
