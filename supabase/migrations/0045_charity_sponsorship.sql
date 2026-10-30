-- Charity water sponsorship (item 39).
--
-- NWS keeps a list of beneficiary sites (a mosque, a family in need, a community site) with a
-- location, a contact and a verified flag. A customer sponsors a tanker for one of them, or for
-- "any approved site in a wilayat" (the one that has had the fewest sponsored deliveries lately),
-- and pays for it as a normal order (create_order, same price lock and receipt). The delivery
-- goes to the site; the site's contact is the order's delivery contact (0040) and gets the
-- arrival SMS, naming the sponsor unless they chose to stay anonymous. On delivery the sponsor
-- gets a thank-you with the delivery proof (the tank photo on the order page). Customers only
-- ever see a site's name, kind and wilayat: never a family's location or contact.

create table public.beneficiary_sites (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 2 and 120),
  name_ar       text not null check (char_length(btrim(name_ar)) between 2 and 120),
  kind          text not null check (kind in ('mosque', 'family', 'community')),
  wilayat_code  text not null references public.wilayats (code) on update cascade,
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  address       text not null default '' check (char_length(address) <= 300),
  landmark      text check (char_length(landmark) <= 300),
  contact_name  text check (char_length(contact_name) <= 80),
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  tank_gal      integer check (tank_gal between 100 and 100000),
  verified      boolean not null default false,
  active        boolean not null default true,
  notes         text check (char_length(notes) <= 300),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id) on delete set null
);

create table public.sponsorships (
  order_id     uuid primary key references public.orders (id) on delete cascade,
  sponsor_id   uuid not null references public.profiles (id) on delete cascade,
  site_id      uuid not null references public.beneficiary_sites (id) on delete restrict,
  any_in_wilayat boolean not null default false,
  anonymous    boolean not null default false,
  message      text check (char_length(message) <= 200),
  created_at   timestamptz not null default now(),
  thanked_at   timestamptz
);
create index sponsorships_site_idx on public.sponsorships (site_id, created_at desc);

alter table public.beneficiary_sites enable row level security;
alter table public.sponsorships enable row level security;
revoke all on public.beneficiary_sites, public.sponsorships from public, anon, authenticated;
grant select on public.beneficiary_sites, public.sponsorships to authenticated;
-- Sites: staff only (customers go through charity_sites(), which leaves out location and contact).
create policy beneficiary_sites_staff on public.beneficiary_sites for select to authenticated using (public.is_staff());
create policy sponsorships_own on public.sponsorships for select to authenticated using (sponsor_id = auth.uid() or public.is_staff());

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('sponsor_thanks', 'Sponsored delivery made', 'customer', 'Thank you: water delivered to {site}',
   '{gallons} gal reached {site} ({order}). See the delivery photo and your receipt in the app.',
   'شكراً لك: وصلت المياه إلى {site}',
   'وصل {gallons} جالون إلى {site} ({order}). شاهد صورة التوصيل وإيصالك في التطبيق.',
   true, false, false, false, 'service', false),
  ('contact_sponsored', 'Delivery contact: sponsored tanker on the way', 'customer', 'Nama Water: sponsored water on the way',
   'Nama Water: a tanker of water sponsored by {sponsor} is on the way to {place} ({order}). Tanker {plate}.',
   'نماء للمياه: مياه متبرَّع بها في الطريق',
   'نماء للمياه: صهريج مياه بتبرع من {sponsor} في الطريق إلى {place} ({order}). الصهريج {plate}.',
   false, true, false, false, 'service', true)
on conflict (event) do nothing;

-- Approved sites for the sponsor's picker (name, kind, wilayat; no location or contact).
create function public.charity_sites(p_wilayat text default null)
returns table (id uuid, name text, name_ar text, kind text, wilayat_code text, wilayat text, wilayat_ar text, governorate_code text)
language sql stable security definer set search_path = public
as $$
  select s.id, s.name, s.name_ar, s.kind, s.wilayat_code, w.name, w.name_ar, w.governorate_code
    from public.beneficiary_sites s join public.wilayats w on w.code = s.wilayat_code
   where s.verified and s.active and (p_wilayat is null or s.wilayat_code = upper(p_wilayat))
   order by w.governorate_code, w.sort, s.name
$$;

-- Sponsor a tanker: a site, or any approved site in a wilayat. Paid like any order.
create function public.sponsor_order(p_site_id uuid, p_wilayat text, p_service_type public.service_type, p_gallons integer,
                                     p_pay_method text default 'card', p_card_last4 text default null,
                                     p_anonymous boolean default false, p_message text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare s public.beneficiary_sites; o public.orders; any_site boolean := p_site_id is null;
begin
  if public.my_role() is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if p_service_type = 'WW' then raise exception 'invalid_value: sponsorship is for water deliveries'; end if;
  if any_site then
    select x.* into s from public.beneficiary_sites x
     where x.verified and x.active and x.wilayat_code = upper(coalesce(p_wilayat, ''))
     order by (select count(*) from public.sponsorships k where k.site_id = x.id and k.created_at > now() - interval '30 days'), random()
     limit 1;
  else
    select x.* into s from public.beneficiary_sites x where x.id = p_site_id and x.verified and x.active;
  end if;
  if s.id is null then raise exception 'no_charity_site'; end if;
  o := public.create_order(p_service_type, p_gallons, s.lat, s.lng, left(s.name, 120), s.address, null, null, null, null, false,
                           'Sponsored delivery: ' || left(s.name, 80), p_pay_method, p_card_last4, null);
  if o.status = 'cancelled' then return o; end if;   -- card declined at checkout: the sponsor retries
  update public.order_locations
     set wilayat_code = s.wilayat_code, landmark = s.landmark, contact_name = s.contact_name, contact_phone = s.contact_phone, call_ahead = s.contact_phone is not null
   where order_id = o.id;
  insert into public.sponsorships (order_id, sponsor_id, site_id, any_in_wilayat, anonymous, message)
  values (o.id, auth.uid(), s.id, any_site, coalesce(p_anonymous, false), nullif(left(btrim(coalesce(p_message, '')), 200), ''));
  return o;
end $$;

-- Sponsored orders: the site's contact hears who sent it (or "a sponsor"); 0040's generic
-- message is replaced for them. The sponsor is thanked on delivery.
create or replace function public.orders_contact_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare sp public.sponsorships; who text;
begin
  select * into sp from public.sponsorships where order_id = new.id;
  if new.status = 'accepted' and old.status = 'requested' then
    if sp.order_id is not null then
      who := case when sp.anonymous then null else nullif(split_part(btrim(coalesce((select full_name from public.profiles where id = sp.sponsor_id), '')), ' ', 1), '') end;
      perform public.notify_contact(new.id, 'contact_sponsored',
        jsonb_build_object('sponsor', coalesce(who, case when coalesce((select lang from public.profiles where id = new.customer_id), 'en') = 'ar' then 'متبرع' else 'a sponsor' end)));
    else
      perform public.notify_contact(new.id, 'contact_on_the_way');
    end if;
  elsif new.status = 'arrived' then perform public.notify_contact(new.id, 'contact_arrived');
  elsif new.status = 'delivered' and sp.order_id is not null and sp.thanked_at is null then
    perform public.notify(sp.sponsor_id, 'sponsor_thanks', new.id, jsonb_build_object('order', 'TO-' || new.order_no, 'gallons', new.gallons::text,
      'site', (select name from public.beneficiary_sites where id = sp.site_id), 'site_ar', (select name_ar from public.beneficiary_sites where id = sp.site_id)));
    update public.sponsorships set thanked_at = now() where order_id = new.id;
  end if;
  return new;
end $$;

-- The sponsor's view of their sponsorships (site name only).
create function public.my_sponsorships()
returns table (order_id uuid, order_no bigint, status public.order_status, site text, site_ar text, kind text, wilayat text, wilayat_ar text,
               gallons integer, total numeric, anonymous boolean, created_at timestamptz, delivered_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select o.id, o.order_no, o.status, s.name, s.name_ar, s.kind, w.name, w.name_ar, o.gallons, o.total, k.anonymous, k.created_at, o.delivered_at
    from public.sponsorships k join public.orders o on o.id = k.order_id join public.beneficiary_sites s on s.id = k.site_id
    join public.wilayats w on w.code = s.wilayat_code
   where k.sponsor_id = auth.uid()
   order by k.created_at desc
$$;

-- NWS: manage the list (operators, admins, complaints agents). Audited.
create function public.staff_save_beneficiary_site(p_id uuid, p_s jsonb, p_reason text)
returns public.beneficiary_sites
language plpgsql security definer set search_path = public
as $$
declare b public.beneficiary_sites; a public.beneficiary_sites; r text; v jsonb := coalesce(p_s, '{}'::jsonb); ph text;
begin
  perform public.require_staff(array['operator', 'complaints_agent']::public.staff_role[]);
  r := public.require_reason(p_reason);
  ph := nullif(btrim(coalesce(v ->> 'contact_phone', '')), '');
  if ph is not null then
    ph := public.normalize_phone(ph);
    if ph is null then raise exception 'invalid_phone'; end if;
  end if;
  if not exists (select 1 from public.wilayats where code = upper(coalesce(v ->> 'wilayat_code', ''))) then raise exception 'invalid_value: unknown wilayat'; end if;
  if p_id is null then
    insert into public.beneficiary_sites (name, name_ar, kind, wilayat_code, lat, lng, address, landmark, contact_name, contact_phone, tank_gal, verified, active, notes, updated_by)
    values (btrim(v ->> 'name'), btrim(v ->> 'name_ar'), v ->> 'kind', upper(v ->> 'wilayat_code'), (v ->> 'lat')::double precision, (v ->> 'lng')::double precision,
            coalesce(v ->> 'address', ''), nullif(btrim(coalesce(v ->> 'landmark', '')), ''), nullif(btrim(coalesce(v ->> 'contact_name', '')), ''), ph,
            nullif(v ->> 'tank_gal', '')::int, coalesce((v ->> 'verified')::boolean, false), coalesce((v ->> 'active')::boolean, true),
            nullif(btrim(coalesce(v ->> 'notes', '')), ''), auth.uid())
    returning * into a;
  else
    select * into b from public.beneficiary_sites where id = p_id for update;
    if not found then raise exception 'not_found'; end if;
    update public.beneficiary_sites
       set name = btrim(v ->> 'name'), name_ar = btrim(v ->> 'name_ar'), kind = v ->> 'kind', wilayat_code = upper(v ->> 'wilayat_code'),
           lat = (v ->> 'lat')::double precision, lng = (v ->> 'lng')::double precision, address = coalesce(v ->> 'address', ''),
           landmark = nullif(btrim(coalesce(v ->> 'landmark', '')), ''), contact_name = nullif(btrim(coalesce(v ->> 'contact_name', '')), ''), contact_phone = ph,
           tank_gal = nullif(v ->> 'tank_gal', '')::int, verified = coalesce((v ->> 'verified')::boolean, verified), active = coalesce((v ->> 'active')::boolean, active),
           notes = nullif(btrim(coalesce(v ->> 'notes', '')), ''), updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into a;
  end if;
  perform public.write_audit('charity.site_save', 'beneficiary_site', a.id::text, to_jsonb(b) - 'contact_phone', to_jsonb(a) - 'contact_phone', r);
  return a;
end $$;

-- NWS: sponsored deliveries per month (test-zone orders apart).
create function public.staff_sponsorship_report(p_months integer default 6)
returns table (month date, orders integer, delivered integer, gallons integer, total_omr numeric, sites integer, sponsors integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select date_trunc('month', k.created_at at time zone 'Asia/Muscat')::date, count(*)::int, count(*) filter (where o.status = 'delivered')::int,
           coalesce(sum(o.gallons) filter (where o.status = 'delivered'), 0)::int, coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0)::numeric,
           count(distinct k.site_id)::int, count(distinct k.sponsor_id)::int
      from public.sponsorships k join public.orders o on o.id = k.order_id
     where not o.is_test and k.created_at > date_trunc('month', now()) - make_interval(months => greatest(least(coalesce(p_months, 6), 36), 1) - 1)
     group by 1 order by 1 desc;
end $$;

revoke execute on function public.charity_sites(text),
  public.sponsor_order(uuid, text, public.service_type, integer, text, text, boolean, text), public.my_sponsorships(),
  public.staff_save_beneficiary_site(uuid, jsonb, text), public.staff_sponsorship_report(integer)
from public, anon;
grant execute on function public.charity_sites(text),
  public.sponsor_order(uuid, text, public.service_type, integer, text, text, boolean, text), public.my_sponsorships(),
  public.staff_save_beneficiary_site(uuid, jsonb, text), public.staff_sponsorship_report(integer)
to authenticated;
