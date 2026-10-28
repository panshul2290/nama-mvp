-- Follow-ups from end-to-end testing of 0015.

-- A passed inspection advances an application only from the inspection stage
-- (stages move one step at a time, as staff_permit_stage enforces).
create or replace function public.staff_record_inspection(p_tanker_id uuid, p_permit_id uuid, p_result text, p_notes text, p_checklist jsonb default '{}'::jsonb)
returns public.inspections
language plpgsql security definer set search_path = public
as $$
declare i public.inspections;
begin
  perform public.require_staff(array['inspector', 'permit_officer']::public.staff_role[]);
  if p_result not in ('pass', 'fail', 'scheduled') then raise exception 'invalid_result'; end if;
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
  update public.inspections
     set result = p_result, inspector_id = auth.uid(), notes = btrim(notes || E'\n' || coalesce(p_notes, '')), checklist = coalesce(p_checklist, '{}'::jsonb),
         permit_id = coalesce(p_permit_id, permit_id)
   where id = (select id from public.inspections where tanker_id = p_tanker_id and result = 'scheduled' and p_result <> 'scheduled' order by created_at limit 1)
  returning * into i;
  if i.id is null then
    insert into public.inspections (tanker_id, permit_id, inspector_id, result, notes, checklist, scheduled_for)
    values (p_tanker_id, p_permit_id, auth.uid(), p_result, coalesce(p_notes, ''), coalesce(p_checklist, '{}'::jsonb),
            case when p_result = 'scheduled' then current_date + 1 else current_date end) returning * into i;
  end if;
  if p_permit_id is not null and p_result = 'pass' then
    update public.permits set stage = 'decision', updated_at = now() where id = p_permit_id and status = 'pending' and stage = 'inspection';
  end if;
  perform public.write_audit('inspection.' || p_result, 'tanker', p_tanker_id::text, null, to_jsonb(i), p_notes);
  return i;
end $$;

-- Invitees can read the name of the business that invited them.
create policy organizations_invitee on public.organizations for select to authenticated using (
  exists (select 1 from public.invitations i where i.org_id = organizations.id and i.status = 'pending' and lower(i.email) = public.my_email()));

-- Invitation lists update live.
alter publication supabase_realtime add table public.invitations;
