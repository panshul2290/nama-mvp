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
