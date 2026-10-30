-- Batch D (part 1 of 3): clusters above governorates, and tankers that are in the NWS
-- register but not (yet) on the platform.
--
--   Clusters   NWS groups the governorates it serves into operating clusters. The register
--              file (Tankers Data.csv, kept out of the repo) gives each tanker a governorate
--              and a cluster; across its 10,706 rows every governorate sits in exactly one
--              cluster, so the cluster belongs to the governorate (governorates.cluster_code)
--              and a tanker's cluster is its governorate's. The importer warns about any row
--              whose cluster disagrees. Admins can move a governorate to another cluster
--              (Settings → Clusters, audited).
--   Governorates  one row per governorate with the spellings in use (the register says
--              "Al Dakhiliyah", the zones say "Ad Dakhiliyah"); zones get a governorate code
--              so orders can be reported per governorate and cluster.
--   Tankers    gain a governorate and two flags:
--                in_register  listed in the NWS tanker register (set by the importer, 0032)
--                on_platform  registered on this platform by a driver or company (true for
--                             every tanker so far; register-only tankers are false until
--                             their owner claims them)
--              plus capacity_known: the register has no capacity, so imported tankers carry
--              a 5,000 gal placeholder until the owner confirms it.
--   Register-only tankers are offline with no driver. Dispatch ranks only on-platform
--   tankers, and they can't be switched online.

-- ===========================================================================
-- Clusters and governorates
-- ===========================================================================
create table public.clusters (
  code    text primary key check (code ~ '^C[0-9]{1,2}$'),
  name    text not null unique,
  name_ar text not null,
  sort    integer not null default 0
);

create table public.governorates (
  code         text primary key check (code ~ '^[A-Z]{3}$'),
  name         text not null unique,
  name_ar      text not null,
  -- Lower-case spellings that mean this governorate (register file, zones, common variants).
  aliases      text[] not null default '{}',
  cluster_code text references public.clusters (code) on update cascade,
  -- Served by NWS (Dhofar has its own water company).
  nws_served   boolean not null default true,
  sort         integer not null default 0
);

insert into public.clusters (code, name, name_ar, sort) values
  ('C1', 'Cluster 1', 'المجموعة 1', 1),
  ('C2', 'Cluster 2', 'المجموعة 2', 2),
  ('C3', 'Cluster 3', 'المجموعة 3', 3)
on conflict (code) do nothing;

-- Cluster per governorate as in the NWS register (one cluster per governorate throughout).
-- Al Buraimi and Musandam aren't in the register: no cluster until NWS assigns one.
insert into public.governorates (code, name, name_ar, aliases, cluster_code, nws_served, sort) values
  ('MUS', 'Muscat',             'مسقط',            '{muscat,"muscat governorate"}',                                            'C1', true, 1),
  ('NSH', 'North Al Sharqiyah', 'شمال الشرقية',    '{"north al sharqiyah","north ash sharqiyah","north sharqiyah","shamal al sharqiyah"}', 'C1', true, 2),
  ('SSH', 'South Al Sharqiyah', 'جنوب الشرقية',    '{"south al sharqiyah","south ash sharqiyah","south sharqiyah","janub al sharqiyah"}',  'C1', true, 3),
  ('DHA', 'Al Dhahirah',        'الظاهرة',          '{"al dhahirah","adh dhahirah","al dhahira","dhahirah","ad dhahirah"}',              'C2', true, 4),
  ('NBA', 'North Al Batinah',   'شمال الباطنة',    '{"north al batinah","north batinah","shamal al batinah"}',                         'C2', true, 5),
  ('SBA', 'South Al Batinah',   'جنوب الباطنة',    '{"south al batinah","south batinah","janub al batinah"}',                          'C3', true, 6),
  ('DAK', 'Al Dakhiliyah',      'الداخلية',         '{"al dakhiliyah","ad dakhiliyah","dakhiliyah","ad dakhiliya","al dakhiliya"}',      'C3', true, 7),
  ('WUS', 'Al Wusta',           'الوسطى',           '{"al wusta",wusta}',                                                                'C3', true, 8),
  ('BUR', 'Al Buraimi',         'البريمي',          '{"al buraimi",buraimi}',                                                            null, true, 9),
  ('MSN', 'Musandam',           'مسندم',            '{musandam}',                                                                        null, true, 10),
  ('DHO', 'Dhofar',             'ظفار',             '{dhofar}',                                                                          null, false, 11)
on conflict (code) do nothing;

-- Governorate code for a name in any known spelling ("Al Dakhiliyah", "Ad Dakhiliyah Governorate",
-- "DAK", the Arabic name); null if unknown.
create function public.governorate_code(p text)
returns text
language sql stable security definer set search_path = public
as $$
  with k as (select btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z؀-ۿ ]+', ' ', 'g'), '\s+', ' ', 'g')) as s)
  select g.code from public.governorates g, k
   where k.s <> '' and (lower(g.code) = k.s or lower(g.name) = k.s or g.name_ar = btrim(p) or k.s = any(g.aliases)
                        or regexp_replace(k.s, ' governorate$', '') = any(g.aliases) or lower(g.name) = regexp_replace(k.s, ' governorate$', ''))
   order by g.sort limit 1
$$;

-- Cluster code for "Cluster 1", "cluster1", "C1" or "1"; null if unknown.
create function public.cluster_code(p text)
returns text
language sql stable security definer set search_path = public
as $$
  select c.code from public.clusters c
   where c.code = 'C' || nullif(substring(lower(btrim(coalesce(p, ''))) from '^(?:cluster\s*|c\s*)?0*([0-9]{1,2})$'), '')
$$;

-- Zones carry the governorate code (kept in step with the free-text governorate).
alter table public.zones add column governorate_code text references public.governorates (code) on update cascade;
update public.zones set governorate_code = public.governorate_code(governorate) where not is_test;

create function public.zones_set_governorate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.governorate_code := case when new.is_test then null else public.governorate_code(new.governorate) end;
  return new;
end $$;
create trigger zones_set_governorate before insert or update of governorate, is_test on public.zones
  for each row execute function public.zones_set_governorate();

-- ===========================================================================
-- Plates: one spelling for the register and the platform
-- ===========================================================================
-- "1798 ml", "1798ML", "1798/M L" → "1798 ML"; "12345" stays "12345" (no letter code).
-- Null when it isn't a plate (letters before the number, too many letters or digits).
create function public.normalize_plate(p text)
returns text
language plpgsql immutable
as $$
declare s text; m text[];
begin
  if p is null then return null; end if;
  s := upper(translate(btrim(p), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'));
  s := btrim(regexp_replace(regexp_replace(s, '[/\\._-]+', ' ', 'g'), '\s+', ' ', 'g'));
  m := regexp_match(s, '^([0-9]{1,6}) ?([A-Z]) ?([A-Z])?$');
  if m is not null then return m[1] || ' ' || m[2] || coalesce(m[3], ''); end if;
  if s ~ '^[0-9]{1,7}$' then return s; end if;
  return null;
end $$;

-- ===========================================================================
-- Tankers: governorate, register and platform flags
-- ===========================================================================
alter table public.tankers
  add column governorate_code text references public.governorates (code) on update cascade,
  add column in_register      boolean not null default false,
  add column on_platform      boolean not null default true,
  add column capacity_known   boolean not null default true;

create index tankers_governorate_idx on public.tankers (governorate_code);
create index tankers_on_platform_idx on public.tankers (plate) where on_platform;
create index tankers_in_register_idx on public.tankers (governorate_code, service_type) where in_register;

-- A register-only tanker has no driver: it can't be switched online.
create function public.tanker_platform_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.is_online and not new.on_platform then raise exception 'not_on_platform'; end if;
  return new;
end $$;
create trigger tankers_platform_guard before insert or update of is_online, on_platform on public.tankers
  for each row execute function public.tanker_platform_guard();

-- ===========================================================================
-- Staff: cluster of a governorate (admin), governorate of a tanker (operators, permit officers)
-- ===========================================================================
create function public.staff_set_governorate_cluster(p_governorate text, p_cluster text, p_reason text)
returns public.governorates
language plpgsql security definer set search_path = public
as $$
declare b public.governorates; a public.governorates; c text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into b from public.governorates where code = public.governorate_code(p_governorate) for update;
  if not found then raise exception 'not_found'; end if;
  if nullif(btrim(coalesce(p_cluster, '')), '') is not null then
    c := public.cluster_code(p_cluster);
    if c is null then raise exception 'invalid_cluster'; end if;
  end if;
  update public.governorates set cluster_code = c where code = b.code returning * into a;
  perform public.write_audit('governorate.cluster', 'governorate', b.code, jsonb_build_object('cluster', b.cluster_code), jsonb_build_object('cluster', a.cluster_code), p_reason);
  return a;
end $$;

create function public.staff_set_tanker_governorate(p_tanker_id uuid, p_governorate text, p_reason text)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare b public.tankers; a public.tankers; g text;
begin
  perform public.require_staff(array['operator', 'permit_officer']::public.staff_role[]);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  g := public.governorate_code(p_governorate);
  if g is null then raise exception 'invalid_governorate'; end if;
  select * into b from public.tankers where id = p_tanker_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.tankers set governorate_code = g where id = b.id returning * into a;
  perform public.write_audit('tanker.governorate', 'tanker', b.id::text, jsonb_build_object('plate', b.plate, 'governorate', b.governorate_code),
                             jsonb_build_object('plate', a.plate, 'governorate', a.governorate_code), p_reason);
  return a;
end $$;

-- ===========================================================================
-- Dispatch ranks only tankers on the platform (the register adds ~10,700 offline tankers
-- with no driver; ranking them per order would be slow and pointless). Same as 0026 otherwise.
-- ===========================================================================
create or replace function public.dispatch_rank(p_order uuid)
returns table (tanker_id uuid, plate text, driver_id uuid, driver_name text, company_name text, distance_km numeric, eta_min integer,
               jobs_today integer, rating numeric, score numeric, eligible boolean, reasons text[], blockers text[])
language plpgsql stable security definer set search_path = public
as $$
declare
  o public.orders; l public.order_locations; cfg jsonb := coalesce(public.setting_json('DISPATCH'), '{}'::jsonb);
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
             public.position_is_test(t.last_lat, t.last_lng) as t_test
        from public.tankers t
        left join public.tanker_assignments a on a.tanker_id = t.id and a.unassigned_at is null
        left join public.profiles p on p.id = a.driver_id
        left join public.companies co on co.id = t.company_id
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
               case when c.dkm > maxkm then format('%s km away (limit %s km)', round(c.dkm, 1), maxkm) end
             ]::text[], null) as bl
        from c)
    select e.id, e.plate, e.drv, e.full_name, e.cname, round(e.dkm, 1),
           case when e.dkm is not null then ceil(e.dkm / greatest(spd, 1) * 60)::int end,
           e.jobs, e.rt,
           round(coalesce(e.dkm / greatest(spd, 1) * 60, 999) + wj * e.jobs - wr * (coalesce(e.rt, 4.5) - 4.5), 1),
           cardinality(e.bl) = 0,
           array_remove(array[
             case when e.dkm is not null then format('%s km · ETA %s min', round(e.dkm, 1), ceil(e.dkm / greatest(spd, 1) * 60)::int) end,
             format('%s job%s today', e.jobs, case when e.jobs = 1 then '' else 's' end),
             case when e.rt is not null then format('Rating %s', to_char(e.rt, 'FM0.0')) else 'No ratings yet' end,
             case when e.capacity_gal >= o.gallons then format('%s gal tanker', e.capacity_gal) end
           ]::text[], null),
           e.bl
      from e
     order by cardinality(e.bl) = 0 desc, 10, e.plate;
end $$;

-- ===========================================================================
-- Access
-- ===========================================================================
alter table public.clusters enable row level security;
alter table public.governorates enable row level security;
revoke all on public.clusters, public.governorates from anon, authenticated;
grant select on public.clusters, public.governorates to authenticated;
-- Reference data: any signed-in user may read the names (the apps may show them later).
create policy clusters_read on public.clusters for select to authenticated using (true);
create policy governorates_read on public.governorates for select to authenticated using (true);

revoke execute on function public.zones_set_governorate(), public.tanker_platform_guard() from public, anon, authenticated;
revoke execute on function public.governorate_code(text), public.cluster_code(text), public.normalize_plate(text) from public, anon;
grant execute on function public.governorate_code(text), public.cluster_code(text), public.normalize_plate(text) to authenticated;
revoke execute on function public.staff_set_governorate_cluster(text, text, text), public.staff_set_tanker_governorate(uuid, text, text) from public, anon;
grant execute on function public.staff_set_governorate_cluster(text, text, text), public.staff_set_tanker_governorate(uuid, text, text) to authenticated;
