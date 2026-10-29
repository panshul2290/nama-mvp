-- Demo data for the presentation: tanker companies and their fleet, a business
-- account, households with properties, contracts, and 30 days of history
-- (orders, payments, proof of delivery, ratings, complaints, penalties, alerts,
-- payouts, invoices, incidents). Run after `npm run seed` (accounts) with
-- `npm run seed:demo`. Runs once: it records DEMO_SEEDED in app_settings.
do $$
declare
  uid jsonb := '{}'::jsonb;  -- email -> user id
  r record;
  e text;
  co_harthy uuid; co_busaidi uuid; co_seeb uuid;
  org_noor uuid;
  tk jsonb := '{}'::jsonb;   -- plate -> tanker id
  v_plate text;
  tid uuid;
  did uuid;
  cust uuid[];
  props jsonb := '{}'::jsonb;
  site_qurum uuid; site_khuwair uuid;
  p uuid;
  d integer; n integer; i integer;
  svc public.service_type;
  gal integer;
  t0 timestamptz;
  o public.orders;
  v_lat double precision; v_lng double precision;
  fill uuid; dis uuid;
  v_rating integer;
  notif_before bigint;
  ct_fatma uuid; ct_noor uuid;
  batch uuid;
  seq_dw text[] := array['4521 TK', '3318 TK', '2290 TK', '9034 HB'];
  seq_ww text[] := array['7702 TK', '8841 TK'];
  seq_te text[] := array['6610 TK'];
  areas text[] := array['Al Khuwair', 'Al Ghubrah', 'Bawshar', 'Al Mawaleh', 'Al Hail', 'Seeb', 'Al Amerat', 'Qurum', 'Madinat Sultan Qaboos', 'Al Ansab'];
  pts double precision[][] := array[[23.5985, 58.4210], [23.6020, 58.3990], [23.5760, 58.3990], [23.6380, 58.2470], [23.6560, 58.2160],
                                    [23.6700, 58.1700], [23.5200, 58.5000], [23.6050, 58.4590], [23.5900, 58.4180], [23.5600, 58.3600]];
  comments text[] := array['Very punctual, thank you', 'Driver was polite and careful', 'Clean tanker, good water', 'Arrived a bit late', 'Excellent service', 'Took longer than the ETA', 'Great, will order again', 'Hose leaked slightly'];
begin
  if exists (select 1 from public.app_settings where key = 'DEMO_SEEDED') then
    raise notice 'Demo data already seeded; skipping.';
    return;
  end if;
  perform setseed(0.42);

  for r in select u.email, u.id from auth.users u where u.email like '%@nama.test' and u.email not like 'test-%' loop
    uid := uid || jsonb_build_object(r.email, r.id);
  end loop;
  foreach e in array array['customer@nama.test', 'driver@nama.test', 'owner@nama.test', 'owner2@nama.test', 'business@nama.test', 'nws-admin@nama.test'] loop
    if not uid ? e then raise exception 'Run npm run seed first (missing %)', e; end if;
  end loop;
  select array_agg((uid ->> x)::uuid) into cust from unnest(array['customer@nama.test', 'customer2@nama.test', 'customer3@nama.test', 'customer4@nama.test',
                                                                  'customer5@nama.test', 'customer6@nama.test', 'customer7@nama.test', 'customer8@nama.test']) x where uid ? x;

  select max(id) into notif_before from public.notifications;

  -- ---- tanker companies ------------------------------------------------------
  insert into public.companies (name, cr_no, phone, email, bank_name, iban, rating, since, status)
  values ('Al Harthy Water Transport', '1098765', '+968 2470 1122', 'ops@alharthy-water.om', 'Bank Muscat', 'OM810270000012345678901', 4.7, '2015-03-01', 'active')
  returning id into co_harthy;
  insert into public.companies (name, cr_no, phone, email, bank_name, iban, rating, since, status)
  values ('Al Busaidi Tankers', '1187654', '+968 2455 3344', 'fleet@albusaidi-tankers.om', 'National Bank of Oman', 'OM330180000098765432101', 4.5, '2018-09-15', 'active')
  returning id into co_busaidi;
  insert into public.companies (name, cr_no, phone, bank_name, iban, rating, since, status)
  values ('Seeb Sewage Services', '1201122', '+968 2442 9900', 'Sohar International', 'OM540290000055554444333', 4.3, '2020-01-10', 'active')
  returning id into co_seeb;
  update public.profiles set company_id = co_harthy where id = (uid ->> 'owner@nama.test')::uuid;
  update public.profiles set company_id = co_busaidi where id = (uid ->> 'owner2@nama.test')::uuid;

  -- ---- fleet: tankers, drivers, permits, devices, documents, water tests -------
  for r in select * from (values
      ('4521 TK', 'DW'::public.service_type, 5000,  'driver@nama.test',  'harthy',  400),
      ('3318 TK', 'DW', 3000,  'driver2@nama.test', 'harthy',  25),
      ('2290 TK', 'DW', 10000, 'driver5@nama.test', 'busaidi', 300),
      ('9034 HB', 'DW', 5000,  null,                'busaidi', -12),
      ('7702 TK', 'WW', 5000,  'driver3@nama.test', 'seeb',    200),
      ('8841 TK', 'WW', 7000,  'driver7@nama.test', 'busaidi', 18),
      ('6610 TK', 'TE', 10000, 'driver4@nama.test', 'harthy',  150),
      ('5397 HA', 'DW', 3000,  'driver6@nama.test', 'busaidi', null)
    ) v(pl, st, cap, drv, co, permit_days) loop
    select id into tid from public.tankers where plate = r.pl;
    if tid is null then
      insert into public.tankers (plate, service_type, capacity_gal) values (r.pl, r.st, r.cap) returning id into tid;
    end if;
    update public.tankers set company_id = case r.co when 'harthy' then co_harthy when 'busaidi' then co_busaidi else co_seeb end,
                              is_online = false where id = tid;
    tk := tk || jsonb_build_object(r.pl, tid);
    if r.drv is not null and uid ? r.drv then
      did := (uid ->> r.drv)::uuid;
      update public.profiles set company_id = (select company_id from public.tankers where id = tid) where id = did;
      if not exists (select 1 from public.tanker_assignments where tanker_id = tid and unassigned_at is null)
         and not exists (select 1 from public.tanker_assignments where driver_id = did and unassigned_at is null) then
        insert into public.tanker_assignments (driver_id, tanker_id, assigned_by) values (did, tid, (uid ->> 'nws-admin@nama.test')::uuid);
      end if;
      insert into public.tanker_documents (driver_id, kind, ref_no, valid_to) values (did, 'heavy_licence', 'HL-' || (100000 + floor(random() * 899999))::int, current_date + 400);
    end if;
    if r.permit_days is not null and not exists (select 1 from public.permits where tanker_id = tid and status = 'approved' and expires_at > now()) then
      insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, status, reviewed_by, reviewed_at, stage)
      values (tid, 'NWS-' || r.st || '-2026-' || lpad((1000 + floor(random() * 8999))::int::text, 4, '0'), r.st,
              now() + make_interval(days => r.permit_days) - interval '1 year', now() + make_interval(days => r.permit_days),
              'approved', (uid ->> 'nws-permits@nama.test')::uuid, now() - interval '1 year', 'decision');
    end if;
    insert into public.devices (id, tanker_id, firmware, installed_at)
    values ('IV-' || (70100 + (select count(*) from public.devices)), tid, case when random() < 0.8 then '4.2.1' else '4.1.7' end, current_date - 300)
    on conflict do nothing;
    insert into public.tanker_documents (tanker_id, kind, ref_no, valid_to) values
      (tid, 'mulkiya', 'MK-' || replace(r.pl, ' ', ''), current_date + 210),
      (tid, 'tank_cleanliness', 'TC-' || replace(r.pl, ' ', ''), current_date + case when r.pl = '3318 TK' then 9 else 75 end),
      (tid, 'rop_inspection', 'ROP-' || replace(r.pl, ' ', ''), current_date + 160),
      (tid, 'insurance', 'INS-' || replace(r.pl, ' ', ''), current_date + case when r.pl = '8841 TK' then 14 else 240 end),
      (tid, 'ivms_certificate', 'IVC-' || replace(r.pl, ' ', ''), current_date + 330);
    if r.st = 'DW' then
      insert into public.water_tests (tanker_id, cert_no, tested_at, chlorine, turbidity, tds, ph, passed)
      values (tid, 'WQ-26-' || (88000 + floor(random() * 999))::int, current_date - (5 + floor(random() * 40))::int, 0.4 + round(random()::numeric * 0.3, 2),
              round(0.3 + random()::numeric * 0.5, 2), 180 + floor(random() * 120)::int, round(7.0 + random()::numeric * 0.8, 1), true)
      on conflict (cert_no) do nothing;
    end if;
  end loop;
  -- A renewal application waiting for review, and one rejected earlier.
  insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, status, stage, applied_by)
  values ((tk ->> '9034 HB')::uuid, 'APP-9034HB-' || to_char(now(), 'YYMMDD'), 'DW', now(), now() + interval '1 year', 'pending', 'documents', (uid ->> 'owner2@nama.test')::uuid);
  insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, status, stage, applied_by)
  values ((tk ->> '5397 HA')::uuid, 'APP-5397HA-' || to_char(now(), 'YYMMDD'), 'DW', now(), now() + interval '1 year', 'pending', 'submitted', (uid ->> 'owner2@nama.test')::uuid);

  -- Last known positions around Muscat (all offline until a driver goes online).
  update public.tankers t set last_lat = v.la, last_lng = v.ln, last_fix_at = now() - interval '3 hours', last_seen_at = now() - interval '3 hours', last_accuracy_m = 8
    from (values ('4521 TK', 23.6036, 58.3856), ('3318 TK', 23.5850, 58.4100), ('2290 TK', 23.6400, 58.2400), ('7702 TK', 23.5700, 58.3400),
                 ('8841 TK', 23.6650, 58.1800), ('6610 TK', 23.5640, 58.3330), ('9034 HB', 23.5200, 58.4900)) v(pl, la, ln)
   where t.plate = v.pl;

  -- ---- households: properties, wallets, payment methods -----------------------
  for i in 1 .. coalesce(array_length(cust, 1), 0) loop
    insert into public.properties (customer_id, label, address, area, lat, lng, tank_gal)
    values (cust[i], case when i = 1 then 'Home' else 'Villa' end, 'Way ' || (2000 + i * 37) || ', House ' || (10 + i), areas[i],
            pts[i][1], pts[i][2], case when i % 3 = 0 then 5000 else 3000 end)
    returning id into p;
    props := props || jsonb_build_object(cust[i]::text, p);
    insert into public.wallet_tx (customer_id, kind, amount, memo, created_at) values (cust[i], 'topup', 20 + (i % 3) * 10, 'Card top-up ••4417', now() - interval '29 days');
    insert into public.payment_methods (customer_id, brand, last4, is_default) values (cust[i], 'Visa', '4417', true);
  end loop;
  insert into public.properties (customer_id, label, address, area, lat, lng, tank_gal)
  values (cust[1], 'Farm — Al Mawaleh', 'Farm road 4', 'Al Mawaleh', 23.6380, 58.2470, 10000);
  insert into public.payment_methods (customer_id, brand, last4) values (cust[1], 'OmanNet', '0921');
  update public.profiles set id_type = 'civil_id', id_no = '08' || lpad((123456 + floor(random() * 800000))::int::text, 6, '0'), id_verified = true where id = any(cust[1:6]);
  update public.profiles set segment = 'farm' where id = cust[4];

  -- ---- business account: Al Noor Hotel ------------------------------------------
  insert into public.organizations (name, cr_no, segment, credit_limit, terms_days, approval_limit, invoicing, status)
  values ('Al Noor Hotel', '1305566', 'commercial', 5000, 30, 60, 'monthly', 'active') returning id into org_noor;
  update public.profiles set org_id = org_noor, org_role = 'admin' where id = (uid ->> 'business@nama.test')::uuid;
  update public.profiles set org_id = org_noor, org_role = 'site_manager' where id = (uid ->> 'business-site@nama.test')::uuid;
  update public.profiles set org_id = org_noor, org_role = 'finance' where id = (uid ->> 'business-finance@nama.test')::uuid;
  insert into public.properties (org_id, label, address, area, lat, lng, tank_gal)
  values (org_noor, 'Al Noor Hotel — Qurum', 'Qurum Beach Road', 'Qurum', 23.6110, 58.4700, 40000) returning id into site_qurum;
  insert into public.properties (org_id, label, address, area, lat, lng, tank_gal)
  values (org_noor, 'Al Noor Residences — Al Khuwair', 'Way 3013', 'Al Khuwair', 23.5930, 58.4300, 20000) returning id into site_khuwair;

  -- ---- contracts ---------------------------------------------------------------
  insert into public.contracts (customer_id, property_id, company_id, service_type, gallons, frequency, plan, slot, start_date, end_date, monthly_est, status, decided_at)
  values (cust[1], (props ->> cust[1]::text)::uuid, co_harthy, 'DW', 3000, 'weekly', 'monthly', 'morning', current_date - 21, current_date + 70, 47.640, 'active', now() - interval '21 days')
  returning id into ct_fatma;
  insert into public.contracts (org_id, property_id, company_id, service_type, gallons, frequency, plan, slot, start_date, end_date, monthly_est, status, decided_at)
  values (org_noor, site_qurum, co_busaidi, 'DW', 10000, 'weekly', 'yearly', 'morning', current_date - 60, current_date + 300, 162.900, 'active', now() - interval '60 days')
  returning id into ct_noor;
  insert into public.contracts (customer_id, property_id, company_id, service_type, gallons, frequency, plan, slot, start_date, end_date, monthly_est, status)
  values (cust[3], (props ->> cust[3]::text)::uuid, co_harthy, 'DW', 5000, 'biweekly', 'monthly', 'evening', current_date + 3, current_date + 93, 30.990, 'pending_owner');

  -- ---- 30 days of household history ---------------------------------------------
  select id into fill from public.sites where code = 'FS-GHB';
  for d in reverse 30 .. 1 loop
    n := 5 + floor(random() * 6)::int;
    for i in 1 .. n loop
      svc := case when random() < 0.72 then 'DW' when random() < 0.7 then 'WW' else 'TE' end;
      v_plate := case svc when 'DW' then seq_dw[1 + floor(random() * 3)::int] when 'WW' then seq_ww[1 + floor(random() * 2)::int] else seq_te[1] end;
      gal := case svc when 'DW' then (array[1000, 2000, 3000, 3000, 5000])[1 + floor(random() * 5)::int]
                      when 'WW' then (array[3000, 5000])[1 + floor(random() * 2)::int] else 10000 end;
      p := cust[1 + floor(random() * array_length(cust, 1))::int];
      select x.lat, x.lng into v_lat, v_lng from public.properties x where x.id = (props ->> p::text)::uuid;
      t0 := date_trunc('day', now() - make_interval(days => d)) + make_interval(hours => 6 + floor(random() * 14)::int, mins => floor(random() * 60)::int);
      tid := (tk ->> v_plate)::uuid;
      gal := least(gal, (select capacity_gal from public.tankers where id = tid));
      select driver_id into did from public.tanker_assignments where tanker_id = tid and unassigned_at is null;
      insert into public.orders (customer_id, service_type, gallons, area, property_id, zone_id, created_at, pay_method, channel, slot_peak)
      values (p, svc, gal, (select area from public.properties where id = (props ->> p::text)::uuid), (props ->> p::text)::uuid,
              (public.zone_at(v_lat, v_lng, true)).id, t0, case when random() < 0.4 then 'wallet' else 'card' end,
              case when random() < 0.1 then 'call_centre' else 'app' end, extract(hour from t0 at time zone 'Asia/Muscat') between 18 and 19)
      returning * into o;
      insert into public.order_locations (order_id, lat, lng, address) values (o.id, v_lat + (random() - 0.5) * 0.002, v_lng + (random() - 0.5) * 0.002, 'Saved property');
      if random() < 0.08 then
        update public.orders set status = 'cancelled', cancelled_at = t0 + interval '6 minutes', cancelled_by = 'customer', payment_status = 'refunded' where id = o.id;
        insert into public.payments (order_id, customer_id, method, amount, status, refunded_amount, created_at, card_last4)
        values (o.id, p, o.pay_method, o.total, 'refunded', o.total, t0, '4417');
        continue;
      end if;
      dis := (select id from public.sites where kind = 'discharge' and not is_test order by random() limit 1);
      v_rating := case when random() < 0.7 then (array[5, 5, 5, 4, 4, 4, 3, 2])[1 + floor(random() * 8)::int] end;
      update public.orders
         set status = 'delivered', driver_id = did, tanker_id = tid, tanker_plate = v_plate,
             driver_name = (select full_name from public.profiles where id = did),
             accepted_at = t0 + make_interval(mins => 2 + floor(random() * 9)::int),
             arriving_at = t0 + make_interval(mins => 12),
             filled_at = case when svc <> 'WW' then t0 + make_interval(mins => 22) end,
             fill_site_id = case when svc = 'DW' then fill when svc = 'TE' then (select id from public.sites where code = 'TE-ANS') end,
             fill_meter_gal = case when svc <> 'WW' then gal end, fill_verified = case when svc <> 'WW' then random() < 0.96 end,
             arrived_at = t0 + make_interval(mins => 38 + floor(random() * 40)::int),
             collected_at = case when svc = 'WW' then t0 + interval '75 minutes' end,
             discharged_at = case when svc = 'WW' then t0 + interval '110 minutes' end,
             discharge_site_id = case when svc = 'WW' then dis end, discharge_verified = case when svc = 'WW' then random() < 0.95 end,
             delivered_at = t0 + make_interval(mins => case when svc = 'WW' then 110 else 60 + floor(random() * 40)::int end),
             payment_status = 'captured',
             rating = v_rating, rating_comment = case when v_rating is not null and random() < 0.5 then comments[1 + floor(random() * 8)::int] end,
             tip = case when v_rating = 5 and random() < 0.4 then 0.5 else 0 end,
             rated_at = case when v_rating is not null then t0 + interval '2 hours' end
       where id = o.id returning * into o;
      insert into public.payments (order_id, customer_id, method, amount, wallet_amount, card_amount, status, created_at, captured_at, card_last4, gateway_ref)
      values (o.id, p, o.pay_method, o.total, case when o.pay_method = 'wallet' then o.total else 0 end, case when o.pay_method = 'wallet' then 0 else o.total end,
              'captured', t0, o.delivered_at, case when o.pay_method = 'card' then '4417' end, 'SIM-' || o.order_no);
      if o.pay_method = 'wallet' then
        insert into public.wallet_tx (customer_id, kind, amount, order_id, memo, created_at) values (p, 'topup', o.total, null, 'Card top-up ••4417', t0 - interval '1 minute');
        insert into public.wallet_tx (customer_id, kind, amount, order_id, memo, created_at) values (p, 'payment', -o.total, o.id, 'TO-' || o.order_no, t0);
      end if;
      insert into public.pods (order_id, kind, photo_hash, meter_gal, signature_svg, no_signature, lat, lng, created_at)
      values (o.id, case when svc = 'WW' then 'collection' else 'delivery' end, md5(o.id::text),
              case when random() < 0.05 then floor(gal * 0.9)::int else gal end,
              case when random() < 0.85 then 'M10 40 C 30 10, 50 70, 70 40 S 110 20, 130 45' end, random() >= 0.85, v_lat, v_lng, o.delivered_at);
      insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo, created_at)
      values ((select company_id from public.tankers where id = tid), did, tid, 'earning', o.driver_earnings, o.id, 'TO-' || o.order_no, o.delivered_at);
      if o.tip > 0 then
        insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo, created_at)
        values ((select company_id from public.tankers where id = tid), did, tid, 'tip', o.tip, o.id, 'Tip TO-' || o.order_no, o.rated_at);
      end if;
      if svc <> 'WW' then
        insert into public.company_tx (company_id, driver_id, tanker_id, bucket, kind, amount, order_id, memo, created_at)
        values ((select company_id from public.tankers where id = tid), did, tid, 'fill_credit', 'fill_charge', -o.water_charge, o.id, 'Filling for TO-' || o.order_no, o.filled_at);
        insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, verified, note, created_at)
        values (o.id, tid, 'tfs', 'fill', o.fill_site_id, gal, o.fill_verified, case when o.fill_verified then 'Station meter matches order volume' else 'Tanker 620 m from the station geofence' end, o.filled_at);
      else
        insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, verified, note, created_at)
        values (o.id, tid, 'stp', 'discharge', dis, gal, o.discharge_verified, case when o.discharge_verified then 'Valve opened inside geofence' else 'Valve opened 1.2 km from the plant' end, o.discharged_at);
      end if;
      update public.profiles set loyalty_points = loyalty_points + floor(o.total)::int where id = p;
    end loop;
  end loop;
  -- Filling credit: each company topped up at the start of the month.
  insert into public.company_tx (company_id, bucket, kind, amount, memo, created_at)
  select c, 'fill_credit', 'fill_topup', 800, 'Filling credit top-up (bank transfer)', now() - interval '30 days' from unnest(array[co_harthy, co_busaidi, co_seeb]) c;

  -- ---- business history: account orders, invoices --------------------------------
  for d in reverse 30 .. 1 loop
    continue when d % 3 <> 0;
    t0 := date_trunc('day', now() - make_interval(days => d)) + interval '8 hours';
    tid := (tk ->> '2290 TK')::uuid;
    select driver_id into did from public.tanker_assignments where tanker_id = tid and unassigned_at is null;
    insert into public.orders (customer_id, org_id, service_type, gallons, area, property_id, zone_id, created_at, channel, billing, pay_method, payment_status, po_number, contract_id,
                               slot_start, slot_end, slot_label)
    values ((uid ->> 'business-site@nama.test')::uuid, org_noor, 'DW', 10000, case when d % 2 = 0 then 'Qurum' else 'Al Khuwair' end,
            case when d % 2 = 0 then site_qurum else site_khuwair end, (public.zone_at(23.6, 58.44, true)).id, t0 - interval '1 day',
            case when d % 2 = 0 then 'contract' else 'business' end, 'account', 'account', 'on_account', 'PO-NH-' || (4400 + d),
            case when d % 2 = 0 then ct_noor end, t0, t0 + interval '2 hours', to_char(t0, 'Dy DD Mon') || ' · 8–10 am')
    returning * into o;
    insert into public.order_locations (order_id, lat, lng, address)
    values (o.id, case when d % 2 = 0 then 23.6110 else 23.5930 end, case when d % 2 = 0 then 58.4700 else 58.4300 end, 'Al Noor Hotel');
    update public.orders set status = 'delivered', driver_id = did, tanker_id = tid, tanker_plate = '2290 TK', driver_name = (select full_name from public.profiles where id = did),
                             accepted_at = t0 - interval '50 minutes', arriving_at = t0 - interval '45 minutes', filled_at = t0 - interval '30 minutes', fill_site_id = fill,
                             fill_meter_gal = 10000, fill_verified = true, arrived_at = t0 + make_interval(mins => floor(random() * 50)::int),
                             delivered_at = t0 + interval '70 minutes'
     where id = o.id returning * into o;
    insert into public.payments (order_id, org_id, customer_id, method, amount, status, created_at) values (o.id, org_noor, o.customer_id, 'account', o.total, 'on_account', t0);
    insert into public.pods (order_id, kind, photo_hash, meter_gal, signature_svg, lat, lng, created_at)
    values (o.id, 'delivery', md5(o.id::text), case when d = 9 then 9400 else 10000 end, 'M10 40 C 30 10, 50 70, 70 40', 23.6, 58.45, o.delivered_at);
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo, created_at)
    values (co_busaidi, did, tid, 'earning', o.driver_earnings, o.id, 'TO-' || o.order_no, o.delivered_at);
  end loop;
  -- Orders to date invoiced and paid.
  perform public.invoice_org(org_noor);
  update public.invoices set status = 'paid', paid_at = now() - interval '5 days', issued_at = now() - interval '16 days', due_at = now() + interval '14 days', period_end = current_date - 16
   where org_id = org_noor;
  update public.payments set status = 'captured', captured_at = now() - interval '5 days' where org_id = org_noor;
  update public.orders set payment_status = 'captured' where org_id = org_noor;

  -- ---- complaints -----------------------------------------------------------------
  for r in select o2.id, o2.customer_id, o2.order_no, (row_number() over ())::int rn
             from (select * from public.orders where status = 'delivered' and org_id is null order by created_at desc limit 8) o2 loop
    insert into public.complaints (order_id, customer_id, category, description, channel, genesys_id, state, owner_team, sla_hours, due_at, created_at, resolved_at, resolution, refund_amount)
    select r.id, r.customer_id, c.category,
           (array['The tanker arrived 50 minutes after the slot.', 'Tank was only about two-thirds full.', 'Water smelled of chlorine.',
                  'Driver was rude at the gate.', 'I was charged the peak fee in the afternoon.', 'Hose leaked water on the driveway.',
                  'Driver did not call before arriving.', 'Delivery was marked done before the tank was full.'])[r.rn],
           case when r.rn in (3, 7) then 'call_centre' else 'app' end, case when r.rn in (3, 7) then 'GEN-' || (52000 + r.rn) end,
           (array['new', 'assigned', 'escalated', 'resolved', 'resolved', 'new', 'assigned', 'resolved'])[r.rn], c.team, c.hours,
           now() - make_interval(days => r.rn::int) + make_interval(hours => c.hours), now() - make_interval(days => r.rn::int),
           case when (array['new', 'assigned', 'escalated', 'resolved', 'resolved', 'new', 'assigned', 'resolved'])[r.rn] = 'resolved' then now() - make_interval(days => r.rn::int) + interval '9 hours' end,
           case when (array['new', 'assigned', 'escalated', 'resolved', 'resolved', 'new', 'assigned', 'resolved'])[r.rn] = 'resolved' then 'Refunded and driver briefed.' end,
           case when r.rn in (4, 8) then 1 else 0 end
      from public.complaint_sla c
     where c.category = (array['late_delivery', 'incomplete_volume', 'water_quality', 'driver_conduct', 'overcharging', 'spillage', 'late_delivery', 'incomplete_volume'])[r.rn];
  end loop;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body, created_at)
  select id, customer_id, 'customer', description, created_at from public.complaints;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body, internal, created_at)
  select id, (uid ->> 'nws-complaints@nama.test')::uuid, 'staff', 'Called the tanker company; driver statement requested.', true, created_at + interval '2 hours'
    from public.complaints where state <> 'new';

  -- ---- penalties, alerts, inspections, fraud flags ---------------------------------
  insert into public.penalties (rule_code, company_id, tanker_id, driver_id, order_id, amount, reason, evidence, state, dispute_text, created_at, disputed_at)
  select 'late_delivery', co_harthy, (tk ->> '3318 TK')::uuid, (uid ->> 'driver2@nama.test')::uuid, (select id from public.orders where tanker_plate = '3318 TK' and status = 'delivered' order by created_at desc limit 1),
         5, 'More than 30 minutes past the 4–6 pm window', 'Slot end vs. arrival time', 'disputed', 'Road closure at Al Khuwair roundabout, see ROP notice', now() - interval '3 days', now() - interval '2 days';
  insert into public.penalties (rule_code, company_id, tanker_id, driver_id, order_id, amount, reason, evidence, state, created_at)
  select 'short_volume', co_busaidi, (tk ->> '2290 TK')::uuid, (uid ->> 'driver5@nama.test')::uuid, (select id from public.orders where org_id = org_noor order by created_at desc limit 1 offset 3),
         10, 'Delivered 9,400 of 10,000 gal (6% short)', 'Flow meter reading on proof of delivery', 'upheld', now() - interval '9 days';
  insert into public.penalties (rule_code, company_id, tanker_id, driver_id, amount, reason, evidence, state, created_at)
  values ('discharge_outside', co_busaidi, (tk ->> '8841 TK')::uuid, (uid ->> 'driver7@nama.test')::uuid, 500, 'Discharge outside approved geofence', 'IVMS valve sensor + GPS: 1.2 km from Seeb STP', 'issued', now() - interval '1 day');
  insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, penalty_id, memo, created_at)
  select company_id, driver_id, tanker_id, 'penalty', -amount, id, (select label from public.penalty_rules where code = rule_code), created_at from public.penalties;

  insert into public.alerts (tanker_id, type, severity, message, lat, lng, created_at, dedupe_key) values
    ((tk ->> '8841 TK')::uuid, 'Discharge outside approved zone', 'high', '8841 TK opened its valve 1.2 km from Seeb STP', 23.6750, 58.2010, now() - interval '1 day', 'seed:dis'),
    ((tk ->> '9034 HB')::uuid, 'Non-renewed tanker on active trip', 'high', '9034 HB reported moving with an expired permit', 23.5200, 58.4900, now() - interval '40 minutes', 'seed:permit'),
    ((tk ->> '3318 TK')::uuid, 'Speeding', 'med', '3318 TK at 112 km/h on Sultan Qaboos Street (limit 100)', 23.5880, 58.4050, now() - interval '25 minutes', 'seed:speed'),
    ((tk ->> '6610 TK')::uuid, 'IVMS signal lost', 'med', '6610 TK: no GPS for 14 minutes near Al Ansab', 23.5640, 58.3330, now() - interval '14 minutes', 'seed:signal'),
    ((tk ->> '7702 TK')::uuid, 'Collection outside designated area', 'low', '7702 TK collected outside its contracted zone', 23.5700, 58.3400, now() - interval '2 hours', 'seed:collect');
  update public.alerts set state = 'acknowledged', acted_by = (uid ->> 'nws-operator@nama.test')::uuid, acted_at = now() - interval '20 hours', action_note = 'Inspector dispatched'
   where dedupe_key = 'seed:dis';

  insert into public.inspections (tanker_id, inspector_id, result, notes, scheduled_for, created_at) values
    ((tk ->> '4521 TK')::uuid, (uid ->> 'nws-inspector@nama.test')::uuid, 'pass', 'Tank clean, seals intact, IVMS reporting', current_date - 20, now() - interval '20 days'),
    ((tk ->> '8841 TK')::uuid, (uid ->> 'nws-inspector@nama.test')::uuid, 'scheduled', 'From alert: Discharge outside approved zone', current_date + 1, now() - interval '20 hours'),
    ((tk ->> '9034 HB')::uuid, (uid ->> 'nws-inspector@nama.test')::uuid, 'fail', 'Valve seal broken; permit renewal on hold', current_date - 6, now() - interval '6 days');

  insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key, created_at) values
    ('Duplicate proof-of-delivery photo', 'order', (select id::text from public.orders where tanker_plate = '3318 TK' order by created_at desc limit 1 offset 2), 'Photo hash reused on 2 deliveries', 90, 'seed:pod', now() - interval '4 days'),
    ('Unusual ordering', 'customer', cust[5]::text, '7 orders in 24 h', 40, 'seed:orders', now() - interval '2 days');

  -- ---- payouts, incidents, data requests, reports -----------------------------------
  insert into public.payout_batches (run_by, total, companies, created_at) values ((uid ->> 'nws-finance@nama.test')::uuid, 0, 0, date_trunc('week', now()) - interval '1 day') returning id into batch;
  insert into public.company_tx (company_id, kind, amount, payout_batch_id, memo, created_at)
  select company_id, 'payout', -round(sum(amount) * 0.6, 3), batch, 'Payout batch PB-' || (select batch_no from public.payout_batches where id = batch), date_trunc('week', now()) - interval '1 day'
    from public.company_tx where bucket = 'earnings' and created_at < date_trunc('week', now()) - interval '1 day' group by company_id having sum(amount) > 0;
  update public.payout_batches set total = (select -sum(amount) from public.company_tx where payout_batch_id = batch), companies = (select count(*) from public.company_tx where payout_batch_id = batch) where id = batch;

  insert into public.incidents (priority, title, system, state, owner, notes, opened_at, acknowledged_at, resolved_at) values
    ('P2', 'Payment gateway timeouts during evening peak', 'Payments', 'resolved', 'Platform on-call', 'Gateway failover tested; retries added.', now() - interval '12 days', now() - interval '12 days' + interval '18 minutes', now() - interval '12 days' + interval '3 hours'),
    ('P3', 'ROP vehicle checks slower than 5 s', 'ROP interface', 'acknowledged', 'Integration team', 'Waiting for ROP maintenance window.', now() - interval '2 days', now() - interval '2 days' + interval '50 minutes', null),
    ('P4', 'Arabic label truncated on driver earnings', 'Driver app', 'open', 'Mobile team', '', now() - interval '6 hours', null, null);

  insert into public.data_requests (customer_id, kind, details, state, created_at, closed_at) values
    (cust[2], 'access', 'Please send me all data you hold about me.', 'completed', now() - interval '20 days', now() - interval '18 days'),
    (cust[6], 'delete', 'Close my account and delete my data.', 'open', now() - interval '1 day', null);

  insert into public.scheduled_reports (name, dataset, group_by, cadence, format, recipients, created_by) values
    ('Daily operations summary', 'orders', 'service', 'daily', 'pdf', 'ops-leads@nama.om', (uid ->> 'nws-admin@nama.test')::uuid),
    ('Monthly revenue by company', 'revenue', 'company', 'monthly', 'xlsx', 'finance@nama.om', (uid ->> 'nws-finance@nama.test')::uuid);

  -- Upcoming contract deliveries for the next week, and promo usage.
  perform public.generate_contract_orders();
  update public.promotions set uses = 37 where code = 'WELCOME10';
  update public.promotions set uses = 412 where code = 'SUMMER5';

  -- The history above fired a notification per status change; keep a small, recent inbox instead.
  delete from public.notifications where id > coalesce(notif_before, 0);
  insert into public.notifications (user_id, event, channels, title, body, order_id, created_at)
  select o2.customer_id, 'delivered', '{push,sms,whatsapp}', 'Delivered', 'TO-' || o2.order_no || ' delivered. Proof of delivery is in the app. Rate your driver.', o2.id, o2.delivered_at
    from public.orders o2 where o2.customer_id = cust[1] and o2.status = 'delivered' order by o2.delivered_at desc limit 3;

  insert into public.app_settings (key, value, notes) values ('DEMO_SEEDED', now()::text, 'Demo data loaded by supabase/seed/demo.sql');
  raise notice 'Demo data seeded.';
end $$;
