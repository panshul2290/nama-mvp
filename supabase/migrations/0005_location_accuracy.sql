-- Location fixes carry accuracy and the device's fix time.
--   * report_location(lat, lng, accuracy_m, recorded_at) replaces the 2-argument version.
--   * Fixes with accuracy worse than 100 m are rejected (inaccurate_fix).
--   * recorded_at must be recent: not older than 2 minutes, and not more than
--     5 minutes ahead of the server clock (stale_fix).
--   * A fix older than the one already stored is ignored (out-of-order delivery).
--   * last_seen_at stays the server's receipt time (used for staleness);
--     last_fix_at is the device's fix time.

alter table public.tankers
  add column last_accuracy_m double precision check (last_accuracy_m >= 0),
  add column last_fix_at     timestamptz;

drop function public.report_location(double precision, double precision);

create function public.report_location(
  p_lat         double precision,
  p_lng         double precision,
  p_accuracy_m  double precision,
  p_recorded_at timestamptz
)
returns void
language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'invalid_location';
  end if;
  if p_accuracy_m is null or p_accuracy_m < 0 then
    raise exception 'accuracy_required';
  end if;
  if p_accuracy_m > 100 then
    raise exception 'inaccurate_fix: accuracy % m is worse than 100 m', round(p_accuracy_m::numeric, 1);
  end if;
  if p_recorded_at is null or p_recorded_at < now() - interval '2 minutes' or p_recorded_at > now() + interval '5 minutes' then
    raise exception 'stale_fix';
  end if;

  select * into t from public.tankers where driver_id = auth.uid();
  if not found then raise exception 'not_a_driver'; end if;
  if t.last_fix_at is not null and p_recorded_at <= t.last_fix_at then
    return; -- older than what we already have
  end if;

  update public.tankers
     set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy_m,
         last_fix_at = p_recorded_at, last_seen_at = now()
   where driver_id = auth.uid();

  update public.orders
     set status = 'arriving', arriving_at = now()
   where driver_id = auth.uid() and status = 'accepted';
end $$;

revoke execute on function public.report_location(double precision, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.report_location(double precision, double precision, double precision, timestamptz) to authenticated;
