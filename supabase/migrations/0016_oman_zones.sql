-- Service zones for the whole of Oman (one per governorate), in addition to the
-- detailed Muscat-area zones. The most specific zone (nearest centre among the
-- zones containing a point) decides, so a disabled local zone such as Quriyat
-- still pauses service there even though the Muscat governorate zone covers it.

insert into public.zones (name, governorate, center_lat, center_lng, radius_km, active) values
  ('Muscat Governorate',        'Muscat',              23.5000, 58.4000,  60, true),
  ('North Al Batinah',          'North Al Batinah',    24.2000, 56.8000,  75, true),
  ('South Al Batinah',          'South Al Batinah',    23.5500, 57.6000,  60, true),
  ('Ad Dakhiliyah',             'Ad Dakhiliyah',       22.9000, 57.6000,  70, true),
  ('North Ash Sharqiyah',       'North Ash Sharqiyah', 22.7000, 58.5500,  70, true),
  ('South Ash Sharqiyah',       'South Ash Sharqiyah', 22.4000, 59.4000,  75, true),
  ('Adh Dhahirah',              'Adh Dhahirah',        23.2500, 56.5000,  75, true),
  ('Al Buraimi',                'Al Buraimi',          24.2500, 55.8000,  45, true),
  ('Al Wusta',                  'Al Wusta',            19.7000, 57.0000, 170, true),
  ('Dhofar',                    'Dhofar',              17.3000, 54.2000, 130, true),
  ('Musandam',                  'Musandam',            26.1000, 56.2500,  40, true)
on conflict (name) do nothing;

-- The nearest containing zone decides; it counts only if it's active (unless asked for any).
create or replace function public.zone_at(p_lat double precision, p_lng double precision, p_include_inactive boolean default false)
returns public.zones language sql stable security definer set search_path = public
as $$
  select * from (
    select z.* from public.zones z
     where public.km(p_lat, p_lng, z.center_lat, z.center_lng) <= z.radius_km
     order by public.km(p_lat, p_lng, z.center_lat, z.center_lng)
     limit 1) nearest
   where nearest.active or p_include_inactive
$$;
