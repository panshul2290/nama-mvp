-- GPS freshness. report_location() already stores each fix with last_seen_at
-- (only the latest fix per tanker is kept). These computed fields let the API
-- say whether that fix is stale: PostgREST exposes them as columns, e.g.
--   GET /tankers?select=last_lat,last_lng,last_seen_at,location_age_s,location_stale
-- They run as the caller, so they only ever see tanker rows RLS already allows.
-- The 60 s threshold is mirrored in lib/gps.ts (STALE_AFTER_S).

create function public.location_age_s(t public.tankers)
returns integer
language sql stable
as $$ select case when t.last_seen_at is null then null
                  else floor(extract(epoch from (now() - t.last_seen_at)))::integer end $$;

create function public.location_stale(t public.tankers)
returns boolean
language sql stable
as $$ select t.last_seen_at is null or now() - t.last_seen_at > interval '60 seconds' $$;

revoke execute on function public.location_age_s(public.tankers), public.location_stale(public.tankers) from public, anon;
grant execute on function public.location_age_s(public.tankers), public.location_stale(public.tankers) to authenticated;
