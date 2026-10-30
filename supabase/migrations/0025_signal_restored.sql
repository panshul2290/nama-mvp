-- 0025 — "IVMS signal lost" closes itself when GPS comes back.
--   staff_scan raises the alert for an online tanker with no fix for 5 minutes (dedupe
--   'signal:' || tanker id), but nothing closed it, so a tanker that came back kept an open
--   alert and the company dashboard said "online with no GPS" while its position updated.
--   A trigger on tankers.last_fix_at resolves it as soon as a fresh fix is stored, whichever
--   path stored it (report_location, the IVMS simulator); existing stale alerts are closed here.

-- ===========================================================================
-- A fresh fix resolves the tanker's open signal-lost alert
-- ===========================================================================
create function public.resolve_signal_lost()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Only a fix younger than the scan's 5-minute threshold counts as the signal being back.
  if new.last_fix_at is not null and new.last_fix_at is distinct from old.last_fix_at and new.last_fix_at > now() - interval '5 minutes' then
    update public.alerts
       set state = 'resolved', acted_by = null, acted_at = now(),
           action_note = 'GPS signal restored at ' || to_char(new.last_fix_at at time zone 'Asia/Muscat', 'YYYY-MM-DD HH24:MI')
     where tanker_id = new.id and type = 'IVMS signal lost' and state <> 'resolved' and created_at < new.last_fix_at;
  end if;
  return new;
end $$;

create trigger tankers_signal_restored
  after update of last_fix_at on public.tankers
  for each row execute function public.resolve_signal_lost();

revoke execute on function public.resolve_signal_lost() from public, anon, authenticated;

-- ===========================================================================
-- Close the alerts already left open by a tanker whose GPS came back
-- ===========================================================================
update public.alerts a
   set state = 'resolved', acted_by = null, acted_at = now(),
       action_note = 'GPS signal restored at ' || to_char(t.last_fix_at at time zone 'Asia/Muscat', 'YYYY-MM-DD HH24:MI')
  from public.tankers t
 where t.id = a.tanker_id and a.type = 'IVMS signal lost' and a.state <> 'resolved' and t.last_fix_at > a.created_at;
