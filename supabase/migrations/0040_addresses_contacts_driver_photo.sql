-- Addresses, delivery contacts and the driver's photo (items 16, 17, 23).
--
-- #16 Optional structured address on properties and orders: wilayat (from a list per
--     governorate, reusing 0031's governorates), village/area, Way number, house/building
--     number, National Address ID (free text, for the future national address scheme) and
--     landmark directions. None of them is required.
-- #17 A delivery contact (name + mobile, +968 by default) who isn't the account holder, e.g. a
--     farm caretaker, and a "call me before arrival" flag. The contact gets the arrival SMS
--     through the notification outbox as a non-user recipient: transactional messages only.
-- #23 Drivers' profile photos in a private bucket (driver-photos), readable by the driver,
--     NWS staff, the driver's company owner, and the customer of an order assigned to that
--     driver while it is active; the customer's tracking card (order_driver_card).
--
-- The order's address details live on order_locations, so they follow its RLS: the
-- customer always, the assigned driver only while the job is active, staff.

-- ===========================================================================
-- #16 Wilayats per governorate
-- ===========================================================================
create table public.wilayats (
  code             text primary key check (code ~ '^[A-Z]{3}-[0-9]{2}$'),
  governorate_code text not null references public.governorates (code) on update cascade,
  name             text not null,
  name_ar          text not null,
  sort             integer not null default 0,
  unique (governorate_code, name)
);

insert into public.wilayats (code, governorate_code, name, name_ar, sort) values
  ('MUS-01', 'MUS', 'Muscat', 'مسقط', 1), ('MUS-02', 'MUS', 'Muttrah', 'مطرح', 2), ('MUS-03', 'MUS', 'Bawshar', 'بوشر', 3),
  ('MUS-04', 'MUS', 'As Seeb', 'السيب', 4), ('MUS-05', 'MUS', 'Al Amerat', 'العامرات', 5), ('MUS-06', 'MUS', 'Qurayyat', 'قريات', 6),
  ('NSH-01', 'NSH', 'Ibra', 'إبراء', 1), ('NSH-02', 'NSH', 'Al Mudhaibi', 'المضيبي', 2), ('NSH-03', 'NSH', 'Bidiyah', 'بدية', 3),
  ('NSH-04', 'NSH', 'Al Qabil', 'القابل', 4), ('NSH-05', 'NSH', 'Wadi Bani Khalid', 'وادي بني خالد', 5), ('NSH-06', 'NSH', 'Dima Wa At Taiyyin', 'دماء والطائيين', 6),
  ('SSH-01', 'SSH', 'Sur', 'صور', 1), ('SSH-02', 'SSH', 'Al Kamil Wal Wafi', 'الكامل والوافي', 2), ('SSH-03', 'SSH', 'Jaalan Bani Bu Hassan', 'جعلان بني بو حسن', 3),
  ('SSH-04', 'SSH', 'Jaalan Bani Bu Ali', 'جعلان بني بو علي', 4), ('SSH-05', 'SSH', 'Masirah', 'مصيرة', 5),
  ('DHA-01', 'DHA', 'Ibri', 'عبري', 1), ('DHA-02', 'DHA', 'Yanqul', 'ينقل', 2), ('DHA-03', 'DHA', 'Dhank', 'ضنك', 3),
  ('NBA-01', 'NBA', 'Sohar', 'صحار', 1), ('NBA-02', 'NBA', 'Shinas', 'شناص', 2), ('NBA-03', 'NBA', 'Liwa', 'لوى', 3),
  ('NBA-04', 'NBA', 'Saham', 'صحم', 4), ('NBA-05', 'NBA', 'Al Khaburah', 'الخابورة', 5), ('NBA-06', 'NBA', 'As Suwayq', 'السويق', 6),
  ('SBA-01', 'SBA', 'Ar Rustaq', 'الرستاق', 1), ('SBA-02', 'SBA', 'Al Awabi', 'العوابي', 2), ('SBA-03', 'SBA', 'Nakhal', 'نخل', 3),
  ('SBA-04', 'SBA', 'Wadi Al Maawil', 'وادي المعاول', 4), ('SBA-05', 'SBA', 'Barka', 'بركاء', 5), ('SBA-06', 'SBA', 'Al Musanaah', 'المصنعة', 6),
  ('DAK-01', 'DAK', 'Nizwa', 'نزوى', 1), ('DAK-02', 'DAK', 'Bahla', 'بهلاء', 2), ('DAK-03', 'DAK', 'Manah', 'منح', 3),
  ('DAK-04', 'DAK', 'Al Hamra', 'الحمراء', 4), ('DAK-05', 'DAK', 'Adam', 'أدم', 5), ('DAK-06', 'DAK', 'Izki', 'إزكي', 6),
  ('DAK-07', 'DAK', 'Samail', 'سمائل', 7), ('DAK-08', 'DAK', 'Bidbid', 'بدبد', 8),
  ('WUS-01', 'WUS', 'Haima', 'هيماء', 1), ('WUS-02', 'WUS', 'Duqm', 'الدقم', 2), ('WUS-03', 'WUS', 'Mahout', 'محوت', 3), ('WUS-04', 'WUS', 'Al Jazer', 'الجازر', 4),
  ('BUR-01', 'BUR', 'Al Buraimi', 'البريمي', 1), ('BUR-02', 'BUR', 'Mahdah', 'محضة', 2), ('BUR-03', 'BUR', 'As Sunaynah', 'السنينة', 3),
  ('MSN-01', 'MSN', 'Khasab', 'خصب', 1), ('MSN-02', 'MSN', 'Dibba', 'دبا', 2), ('MSN-03', 'MSN', 'Bukha', 'بخا', 3), ('MSN-04', 'MSN', 'Madha', 'مدحاء', 4),
  ('DHO-01', 'DHO', 'Salalah', 'صلالة', 1), ('DHO-02', 'DHO', 'Taqah', 'طاقة', 2), ('DHO-03', 'DHO', 'Mirbat', 'مرباط', 3),
  ('DHO-04', 'DHO', 'Rakhyut', 'رخيوت', 4), ('DHO-05', 'DHO', 'Thumrait', 'ثمريت', 5), ('DHO-06', 'DHO', 'Dhalkut', 'ضلكوت', 6),
  ('DHO-07', 'DHO', 'Al Mazyona', 'المزيونة', 7), ('DHO-08', 'DHO', 'Muqshin', 'مقشن', 8), ('DHO-09', 'DHO', 'Shalim and the Hallaniyat Islands', 'شليم وجزر الحلانيات', 9),
  ('DHO-10', 'DHO', 'Sadah', 'سدح', 10)
on conflict (code) do nothing;

alter table public.wilayats enable row level security;
revoke all on public.wilayats from public, anon, authenticated;
grant select on public.wilayats to authenticated;
create policy wilayats_read on public.wilayats for select to authenticated using (true);

-- ===========================================================================
-- #16 / #17 Address details and delivery contact on properties and order locations
-- ===========================================================================
alter table public.properties
  add column wilayat_code        text references public.wilayats (code) on update cascade,
  add column village             text check (char_length(village) <= 80),
  add column way_no              text check (char_length(way_no) <= 20),
  add column house_no            text check (char_length(house_no) <= 20),
  add column national_address_id text check (char_length(national_address_id) <= 40),
  add column landmark            text check (char_length(landmark) <= 300),
  add column contact_name        text check (char_length(contact_name) <= 80),
  add column contact_phone       text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column call_ahead          boolean not null default false;

alter table public.order_locations
  add column wilayat_code        text references public.wilayats (code) on update cascade,
  add column village             text check (char_length(village) <= 80),
  add column way_no              text check (char_length(way_no) <= 20),
  add column house_no            text check (char_length(house_no) <= 20),
  add column national_address_id text check (char_length(national_address_id) <= 40),
  add column landmark            text check (char_length(landmark) <= 300),
  add column contact_name        text check (char_length(contact_name) <= 80),
  add column contact_phone       text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column call_ahead          boolean not null default false;

-- The details in a client's jsonb, checked and tidied: blanks become null, the mobile number
-- is normalised (+968 by default). Unknown keys are ignored; every key is optional.
create function public.address_details(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v jsonb := coalesce(p, '{}'::jsonb);
  w text := nullif(upper(btrim(coalesce(v ->> 'wilayat', ''))), '');
  ph text := nullif(btrim(coalesce(v ->> 'contact_phone', '')), '');
  norm text;
  clean text;
  k text;
  out jsonb := '{}'::jsonb;
  lim jsonb := '{"village": 80, "way_no": 20, "house_no": 20, "national_address_id": 40, "landmark": 300, "contact_name": 80}';
begin
  if jsonb_typeof(v) <> 'object' then raise exception 'invalid_value: address details must be an object'; end if;
  if w is not null and not exists (select 1 from public.wilayats where code = w) then raise exception 'invalid_value: unknown wilayat'; end if;
  out := out || jsonb_build_object('wilayat', w);
  for k in select jsonb_object_keys(lim) loop
    clean := nullif(btrim(regexp_replace(coalesce(v ->> k, ''), '[[:cntrl:]]+', ' ', 'g')), '');
    if char_length(clean) > (lim ->> k)::integer then raise exception 'invalid_value: % is too long', k; end if;
    out := out || jsonb_build_object(k, clean);
  end loop;
  if ph is not null then
    norm := public.normalize_phone(ph);
    if norm is null then raise exception 'invalid_phone'; end if;
  end if;
  return out || jsonb_build_object('contact_phone', norm, 'call_ahead', coalesce((v ->> 'call_ahead')::boolean, false));
end $$;

-- Customer (own property) or business site manager/admin (visible site): set the details.
create function public.set_property_details(p_id uuid, p_details jsonb)
returns public.properties
language plpgsql security definer set search_path = public
as $$
declare p public.properties; d jsonb := public.address_details(p_details); r public.user_role := public.my_role();
begin
  if r = 'business' and coalesce(public.my_org_role(), '') not in ('admin', 'site_manager') then raise exception 'forbidden_for_role'; end if;
  if r not in ('customer', 'business') then raise exception 'forbidden_for_role'; end if;
  update public.properties x
     set wilayat_code = d ->> 'wilayat', village = d ->> 'village', way_no = d ->> 'way_no', house_no = d ->> 'house_no',
         national_address_id = d ->> 'national_address_id', landmark = d ->> 'landmark',
         contact_name = d ->> 'contact_name', contact_phone = d ->> 'contact_phone', call_ahead = (d ->> 'call_ahead')::boolean
   where x.id = p_id
     and ((r = 'customer' and x.customer_id = auth.uid()) or (r = 'business' and x.org_id is not null and public.org_order_visible(x.org_id, x.id)))
  returning * into p;
  if not found then raise exception 'not_found'; end if;
  return p;
end $$;

-- The same on an order not yet finished (the request flow sends it right after create_order;
-- the driver sees it on the trip screen). Price, volume and service are untouched (0036 lock).
create function public.set_order_details(p_order uuid, p_details jsonb)
returns public.order_locations
language plpgsql security definer set search_path = public
as $$
declare o public.orders; l public.order_locations; d jsonb := public.address_details(p_details);
begin
  select * into o from public.orders where id = p_order for update;
  if not found or not (o.customer_id = auth.uid()
                       or (o.org_id is not null and o.org_id = public.my_org_id() and coalesce(public.my_org_role(), '') in ('admin', 'site_manager')
                           and public.org_order_visible(o.org_id, o.property_id))) then
    raise exception 'not_found';
  end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'invalid_state'; end if;
  update public.order_locations
     set wilayat_code = d ->> 'wilayat', village = d ->> 'village', way_no = d ->> 'way_no', house_no = d ->> 'house_no',
         national_address_id = d ->> 'national_address_id', landmark = d ->> 'landmark',
         contact_name = d ->> 'contact_name', contact_phone = d ->> 'contact_phone', call_ahead = (d ->> 'call_ahead')::boolean
   where order_id = o.id
  returning * into l;
  if not found then raise exception 'not_found'; end if;
  return l;
end $$;

-- An order placed for a saved property (app, business, contract, call centre) starts with that
-- property's details; anything sent with the order wins.
create function public.order_locations_from_property()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare p public.properties;
begin
  if new.wilayat_code is null and new.village is null and new.way_no is null and new.house_no is null and new.national_address_id is null
     and new.landmark is null and new.contact_name is null and new.contact_phone is null and not new.call_ahead then
    select x.* into p from public.properties x join public.orders o on o.property_id = x.id where o.id = new.order_id;
    if p.id is not null then
      new.wilayat_code := p.wilayat_code; new.village := p.village; new.way_no := p.way_no; new.house_no := p.house_no;
      new.national_address_id := p.national_address_id; new.landmark := p.landmark;
      new.contact_name := p.contact_name; new.contact_phone := p.contact_phone; new.call_ahead := p.call_ahead;
    end if;
  end if;
  return new;
end $$;
create trigger order_locations_from_property before insert on public.order_locations
  for each row execute function public.order_locations_from_property();

-- ===========================================================================
-- #17 Messages to a delivery contact who isn't a user (transactional only)
-- ===========================================================================
insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('contact_on_the_way', 'Delivery contact: tanker on the way', 'customer', 'Nama Water: tanker on the way',
   'Nama Water: tanker {plate} is on the way to {place} for {order} (driver {driver}).{call}',
   'نماء للمياه: الصهريج في الطريق',
   'نماء للمياه: الصهريج {plate} في الطريق إلى {place} للطلب {order} (السائق {driver}).{call}',
   false, true, false, false, 'service', true),
  ('contact_arrived', 'Delivery contact: tanker arrived', 'customer', 'Nama Water: tanker arrived',
   'Nama Water: tanker {plate} has arrived at {place} for {order}. Please meet the driver.',
   'نماء للمياه: وصل الصهريج',
   'نماء للمياه: وصل الصهريج {plate} إلى {place} للطلب {order}. يرجى مقابلة السائق.',
   false, true, false, false, 'service', true)
on conflict (event) do nothing;

-- One SMS to the order's delivery contact, through the same outbox and providers as every
-- other message. The contact has no account, so: no in-app copy, no preferences, and never a
-- marketing message (a template whose class isn't transactional is refused). Returns the
-- outbox id, or null when there is nothing to send.
create function public.notify_contact(p_order uuid, p_event text, p_vars jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  tpl public.notification_templates; o public.orders; l public.order_locations; lang text; v jsonb; t text; b text; nid bigint;
  senders jsonb := public.setting_json('NOTIFY');
begin
  select * into tpl from public.notification_templates where event = p_event;
  if not found or tpl.message_class <> 'transactional' or not tpl.sms then return null; end if;
  select * into o from public.orders where id = p_order;
  select * into l from public.order_locations where order_id = p_order;
  if o.id is null or l.contact_phone is null then return null; end if;
  -- The account holder's language (the contact has no settings of their own).
  lang := coalesce((select p.lang from public.profiles p where p.id = o.customer_id), 'en');
  v := jsonb_build_object('order', 'TO-' || o.order_no, 'plate', coalesce(o.tanker_plate, ''),
                          'driver', coalesce(split_part(btrim(coalesce(o.driver_name, '')), ' ', 1), ''),
                          'place', coalesce(nullif(btrim(coalesce(l.landmark, '')), ''), o.area),
                          'call', case when l.call_ahead then case when lang = 'ar' then ' سيتصل بك السائق قبل الوصول.' else ' The driver will call you before arriving.' end else '' end)
       || coalesce(p_vars, '{}'::jsonb);
  t := public.fill_template(case when lang = 'ar' then tpl.title_ar else tpl.title_en end, v);
  b := public.fill_template(case when lang = 'ar' then tpl.body_ar else tpl.body_en end, v);
  insert into public.notification_outbox (user_id, event, channel, lang, destination, destination_masked, title, body, order_id, is_test,
                                          message_class, sender_id)
  values (null, p_event, 'sms', lang, l.contact_phone, public.mask_phone(l.contact_phone), t, b, o.id, o.is_test,
          'transactional', coalesce(senders -> 'sender_ids' ->> 'transactional', senders ->> 'sender_id'))
  returning notification_outbox.id into nid;
  return nid;
end $$;

-- Assigned (on the way) and arrived: the contact hears about it too.
create function public.orders_contact_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'accepted' and old.status = 'requested' then perform public.notify_contact(new.id, 'contact_on_the_way');
  elsif new.status = 'arrived' then perform public.notify_contact(new.id, 'contact_arrived');
  end if;
  return new;
end $$;
create trigger orders_contact_notify after update of status on public.orders
  for each row when (new.status is distinct from old.status) execute function public.orders_contact_notify();

-- ===========================================================================
-- #23 Driver profile (photo; availability and tier columns are used by 0041)
-- ===========================================================================
create table public.driver_profiles (
  driver_id         uuid primary key references public.profiles (id) on delete cascade,
  photo_path        text check (photo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'),
  photo_updated_at  timestamptz,
  unavailable_until date,
  tier              text not null default 'bronze' check (tier in ('bronze', 'silver', 'gold')),
  tier_stats        jsonb not null default '{}'::jsonb,
  tier_computed_at  timestamptz,
  updated_at        timestamptz not null default now()
);

alter table public.driver_profiles enable row level security;
revoke all on public.driver_profiles from public, anon, authenticated;
grant select on public.driver_profiles to authenticated;
create policy driver_profiles_own on public.driver_profiles for select to authenticated using (driver_id = auth.uid());
create policy driver_profiles_owner on public.driver_profiles for select to authenticated using (
  public.is_owner() and exists (select 1 from public.profiles p where p.id = driver_profiles.driver_id and p.company_id = public.my_company_id()));
create policy driver_profiles_staff on public.driver_profiles for select to authenticated using (public.is_staff());

-- Who may see a driver's photo: the driver, staff, their company owner, and the customer of an
-- order assigned to that driver while it is active (accepted → delivered or cancelled).
create function public.driver_photo_readable(p_folder text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare d uuid;
begin
  if p_folder is null or p_folder !~ '^[0-9a-f-]{36}$' then return false; end if;
  d := p_folder::uuid;
  return d = auth.uid()
      or public.is_staff()
      or (public.is_owner() and exists (select 1 from public.profiles p where p.id = d and p.company_id = public.my_company_id()))
      or exists (select 1 from public.orders o where o.driver_id = d and o.customer_id = auth.uid()
                   and o.status in ('accepted', 'arriving', 'arrived', 'collected'));
end $$;

-- Private bucket for the photos: <driver id>/<file>. Supabase only (PGlite has no Storage).
do $$
begin
  if to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('driver-photos', 'driver-photos', false) on conflict (id) do nothing;
    execute 'drop policy if exists driver_photos_upload on storage.objects';
    execute 'drop policy if exists driver_photos_update on storage.objects';
    execute 'drop policy if exists driver_photos_delete on storage.objects';
    execute 'drop policy if exists driver_photos_read on storage.objects';
    execute $p$create policy driver_photos_upload on storage.objects for insert to authenticated with check (
      bucket_id = 'driver-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.my_role() = 'driver')$p$;
    execute $p$create policy driver_photos_update on storage.objects for update to authenticated using (
      bucket_id = 'driver-photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute $p$create policy driver_photos_delete on storage.objects for delete to authenticated using (
      bucket_id = 'driver-photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute $p$create policy driver_photos_read on storage.objects for select to authenticated using (
      bucket_id = 'driver-photos' and public.driver_photo_readable((storage.foldername(name))[1]))$p$;
  end if;
end $$;

create function public.driver_photo_uploaded(p_path text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare ok boolean;
begin
  execute 'select exists (select 1 from storage.objects where bucket_id = ''driver-photos'' and name = $1)' into ok using p_path;
  return ok;
end $$;
revoke execute on function public.driver_photo_uploaded(text) from public, anon, authenticated;

-- The driver sets (or clears, with null) their photo after uploading it to their folder.
create function public.set_driver_photo(p_path text)
returns public.driver_profiles
language plpgsql security definer set search_path = public
as $$
declare dp public.driver_profiles; p text := nullif(btrim(coalesce(p_path, '')), '');
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  if p is not null then
    if split_part(p, '/', 1) <> auth.uid()::text or p !~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$' then raise exception 'invalid_path'; end if;
    -- PGlite tests have no Storage; on Supabase the file must be in the bucket.
    if to_regclass('storage.objects') is not null then
      if not public.driver_photo_uploaded(p) then raise exception 'photo_required'; end if;
    end if;
  end if;
  insert into public.driver_profiles (driver_id, photo_path, photo_updated_at, updated_at) values (auth.uid(), p, now(), now())
  on conflict (driver_id) do update set photo_path = excluded.photo_path, photo_updated_at = now(), updated_at = now()
  returning * into dp;
  return dp;
end $$;

-- The customer's card as soon as a driver is assigned: first name, photo, plate, company and
-- the driver's rating. Nothing else about the driver (no phone, no surname).
create function public.order_driver_card(p_order uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders; r numeric; n integer; dp public.driver_profiles;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.driver_id is null then return null; end if;
  if not (public.is_staff() or (o.customer_id = auth.uid() and o.status in ('accepted', 'arriving', 'arrived', 'collected'))) then return null; end if;
  select round(avg(x.rating)::numeric, 1), count(x.rating)::int into r, n
    from public.orders x where x.driver_id = o.driver_id and x.rating is not null and not x.is_test and x.rated_at > now() - interval '180 days';
  select * into dp from public.driver_profiles where driver_id = o.driver_id;
  return jsonb_build_object(
    'first_name', nullif(split_part(btrim(coalesce((select full_name from public.profiles where id = o.driver_id), o.driver_name, '')), ' ', 1), ''),
    'photo_path', dp.photo_path,
    'plate', coalesce(o.tanker_plate, (select plate from public.tankers where id = o.tanker_id)),
    'company', (select c.name from public.tankers t join public.companies c on c.id = t.company_id where t.id = o.tanker_id),
    'rating', r, 'ratings', coalesce(n, 0),
    'tier', coalesce(dp.tier, 'bronze'));
end $$;

-- ===========================================================================
-- Grants
-- ===========================================================================
revoke execute on function public.order_locations_from_property(), public.notify_contact(uuid, text, jsonb), public.orders_contact_notify()
from public, anon, authenticated;
revoke execute on function public.address_details(jsonb), public.set_property_details(uuid, jsonb), public.set_order_details(uuid, jsonb),
  public.driver_photo_readable(text), public.set_driver_photo(text), public.order_driver_card(uuid)
from public, anon;
grant execute on function public.address_details(jsonb), public.set_property_details(uuid, jsonb), public.set_order_details(uuid, jsonb),
  public.driver_photo_readable(text), public.set_driver_photo(text), public.order_driver_card(uuid)
to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'driver_profiles') then
    alter publication supabase_realtime add table public.driver_profiles;
  end if;
end $$;
