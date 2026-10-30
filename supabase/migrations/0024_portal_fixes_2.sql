-- 0024 — second round of portal fixes (scratchpad portal-review, chunks 5–7) and proof-of-delivery
-- location.
--   * Settings → Users: staff emails for the list (auth.users isn't readable from the browser) and
--     editing a staff member's zones.
--   * Exports are written to the audit log (staff_log_export).
--   * Privacy page: the consent figure is counted in the database, not by downloading every profile.

-- ===========================================================================
-- Settings → Users: emails and zones
-- ===========================================================================
create function public.staff_directory()
returns table (id uuid, email text)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  return query select p.id, u.email::text from public.profiles p join auth.users u on u.id = p.id where p.role = 'nws_staff';
end $$;

create function public.staff_set_zones(p_user_id uuid, p_zones text[], p_reason text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare b public.profiles; a public.profiles; r text; bad text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.profiles where id = p_user_id and role = 'nws_staff' for update;
  if not found then raise exception 'not_found'; end if;
  select z into bad from unnest(coalesce(p_zones, '{}')) z where not exists (select 1 from public.zones where name = z) limit 1;
  if bad is not null then raise exception 'invalid_value: unknown zone %', bad; end if;
  update public.profiles set staff_zones = coalesce(p_zones, '{}') where id = b.id returning * into a;
  perform public.write_audit('staff.zones', 'profile', a.id::text, jsonb_build_object('staff_zones', b.staff_zones), jsonb_build_object('staff_zones', a.staff_zones), r);
  return a;
end $$;

-- ===========================================================================
-- Exports leave a trace in the audit log (prototype: every export is audited)
-- ===========================================================================
create function public.staff_log_export(p_what text, p_rows integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  perform public.write_audit('report.export', 'export', left(coalesce(btrim(p_what), 'export'), 120), null,
                             jsonb_build_object('rows', greatest(coalesce(p_rows, 0), 0)), null);
end $$;

-- ===========================================================================
-- Privacy page: consent count without reading private columns row by row
-- ===========================================================================
create function public.staff_consent_stats()
returns table (customers integer, sharing integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select count(*)::int, count(*) filter (where coalesce((p.prefs ->> 'share_usage')::boolean, false))::int
      from public.profiles p where p.role = 'customer';
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
do $$
declare f text;
begin
  foreach f in array array['staff_directory()', 'staff_set_zones(uuid, text[], text)', 'staff_log_export(text, integer)', 'staff_consent_stats()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- Company portal: a rejected document keeps NWS's reason, so the owner sees why
-- ===========================================================================
alter table public.tanker_documents add column review_note text check (char_length(review_note) <= 500);

create or replace function public.staff_review_document(p_document_id uuid, p_approve boolean, p_reason text default null)
returns public.tanker_documents
language plpgsql security definer set search_path = public
as $$
declare b public.tanker_documents; a public.tanker_documents; r text;
begin
  perform public.require_staff(array['permit_officer', 'inspector']::public.staff_role[]);
  r := case when p_approve then nullif(btrim(coalesce(p_reason, '')), '') else public.require_reason(p_reason) end;
  select * into b from public.tanker_documents where id = p_document_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.tanker_documents set status = case when p_approve then 'valid' else 'rejected' end,
                                     review_note = case when p_approve then null else left(r, 500) end
   where id = b.id returning * into a;
  perform public.write_audit('document.' || case when p_approve then 'approve' else 'reject' end, 'document', b.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- ===========================================================================
-- Proof of delivery: where the photo was taken and where the proof was submitted
-- ===========================================================================
-- The driver app records the device's GPS fix (position, accuracy, time) when the photo is taken
-- and again on submit. Without a device fix the submit position falls back to the tanker's last
-- reported fix, as before (location_source says which). The distance from the delivery point is
-- computed here, so every screen shows the same figure.
alter table public.pods
  add column accuracy_m       real check (accuracy_m >= 0),
  add column fix_at           timestamptz,
  add column location_source  text check (location_source in ('device', 'tanker')),
  add column distance_m       integer check (distance_m >= 0),
  add column photo_lat        double precision check (photo_lat between -90 and 90),
  add column photo_lng        double precision check (photo_lng between -180 and 180),
  add column photo_accuracy_m real check (photo_accuracy_m >= 0),
  add column photo_at         timestamptz,
  add column photo_distance_m integer check (photo_distance_m >= 0),
  -- 'camera' (taken live in the app) or 'gallery' (chosen from the phone's photos: weaker evidence).
  add column photo_source     text check (photo_source in ('camera', 'gallery'));

-- Great-circle distance in metres (null when either point is missing).
create function public.distance_m(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns integer
language sql immutable set search_path = public
as $$
  select case when a_lat is null or a_lng is null or b_lat is null or b_lng is null then null else
    round(2 * 6371000 * asin(least(1, sqrt(power(sin(radians(b_lat - a_lat) / 2), 2)
                                           + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)))))::int end
$$;

-- A device fix is both coordinates or neither, on the globe, with a sane accuracy and not from the future.
create function public.pod_fix_ok(p_lat double precision, p_lng double precision, p_accuracy double precision, p_at timestamptz)
returns boolean
language sql stable set search_path = public
as $$
  select (p_lat is null and p_lng is null)
      or (p_lat is not null and p_lng is not null and p_lat between -90 and 90 and p_lng between -180 and 180
          and (p_accuracy is null or p_accuracy between 0 and 100000)
          and (p_at is null or p_at <= now() + interval '5 minutes'))
$$;

drop function public.submit_pod(uuid, integer, text, text, text, boolean, boolean, double precision, double precision);
create function public.submit_pod(p_order_id uuid, p_meter_gal integer, p_photo_path text default null, p_photo_hash text default null,
                                  p_signature_svg text default null, p_no_signature boolean default false, p_left_at_tank boolean default false,
                                  p_lat double precision default null, p_lng double precision default null,
                                  p_accuracy_m double precision default null, p_fix_at timestamptz default null,
                                  p_photo_lat double precision default null, p_photo_lng double precision default null,
                                  p_photo_accuracy_m double precision default null, p_photo_at timestamptz default null,
                                  p_photo_source text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; credit numeric; dest public.order_locations; dev boolean;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'arrived' then raise exception 'invalid_transition'; end if;
  if p_meter_gal is null or p_meter_gal < 0 or p_meter_gal > 20000 then raise exception 'invalid_meter'; end if;
  if coalesce(p_signature_svg, '') = '' and not coalesce(p_no_signature, false) then raise exception 'signature_required'; end if;
  if not public.evidence_object_ok(p_photo_path) then raise exception 'photo_required'; end if;
  if not public.pod_fix_ok(p_lat, p_lng, p_accuracy_m, p_fix_at) or not public.pod_fix_ok(p_photo_lat, p_photo_lng, p_photo_accuracy_m, p_photo_at) then
    raise exception 'invalid_pod_location';
  end if;
  if p_photo_source is not null and p_photo_source not in ('camera', 'gallery') then raise exception 'invalid_value'; end if;
  dev := p_lat is not null;
  select * into dest from public.order_locations where order_id = o.id;
  insert into public.pods (order_id, kind, photo_path, photo_hash, meter_gal, signature_svg, no_signature, left_at_tank, lat, lng,
                           accuracy_m, fix_at, location_source, distance_m, photo_lat, photo_lng, photo_accuracy_m, photo_at, photo_distance_m, photo_source)
  values (o.id, case when o.service_type = 'WW' then 'collection' else 'delivery' end, p_photo_path, p_photo_hash, p_meter_gal,
          nullif(p_signature_svg, ''), coalesce(p_no_signature, false), coalesce(p_left_at_tank, false),
          case when dev then p_lat else t.last_lat end, case when dev then p_lng else t.last_lng end,
          case when dev then p_accuracy_m end,
          case when dev then coalesce(p_fix_at, now()) else t.last_seen_at end,
          case when dev then 'device' when t.last_lat is not null then 'tanker' end,
          public.distance_m(case when dev then p_lat else t.last_lat end, case when dev then p_lng else t.last_lng end, dest.lat, dest.lng),
          p_photo_lat, p_photo_lng, case when p_photo_lat is not null then p_photo_accuracy_m end, case when p_photo_lat is not null then p_photo_at end,
          public.distance_m(p_photo_lat, p_photo_lng, dest.lat, dest.lng), p_photo_source);
  if o.service_type = 'WW' then
    update public.orders set status = 'collected', collected_at = now() where id = o.id returning * into o;
  else
    update public.orders set status = 'delivered', delivered_at = now() where id = o.id returning * into o;
    perform public.settle_order(o.id);
    select * into o from public.orders where id = o.id;
  end if;
  if o.service_type <> 'WW' and p_meter_gal < o.gallons * 0.95 then
    perform public.issue_penalty('short_volume', o.id, o.tanker_id,
      format('Delivered %s of %s gal (%s%% short)', p_meter_gal, o.gallons, round((1 - p_meter_gal::numeric / o.gallons) * 100)), 'Flow meter reading on proof of delivery');
    perform public.raise_alert(o.tanker_id, o.id, 'Short volume', 'med', format('TO-%s: %s of %s gal delivered', o.order_no, p_meter_gal, o.gallons),
                               t.last_lat, t.last_lng, 'short:' || o.id);
    -- Pro-rata share of the order for the missing volume.
    credit := round(o.total * (1 - p_meter_gal::numeric / o.gallons), 3);
    if o.billing = 'account' then
      update public.orders set short_credit = credit where id = o.id returning * into o;
    else
      perform public.refund_to_wallet(o.id, credit, 'refund', format('Short delivery TO-%s: %s of %s gal', o.order_no, p_meter_gal, o.gallons));
      update public.orders set short_credit = credit where id = o.id returning * into o;
    end if;
  end if;
  return o;
end $$;

revoke execute on function public.submit_pod(uuid, integer, text, text, text, boolean, boolean, double precision, double precision,
                                             double precision, timestamptz, double precision, double precision, double precision, timestamptz, text) from public, anon;
grant execute on function public.submit_pod(uuid, integer, text, text, text, boolean, boolean, double precision, double precision,
                                            double precision, timestamptz, double precision, double precision, double precision, timestamptz, text) to authenticated;
revoke execute on function public.distance_m(double precision, double precision, double precision, double precision), public.pod_fix_ok(double precision, double precision, double precision, timestamptz)
  from public, anon, authenticated;
