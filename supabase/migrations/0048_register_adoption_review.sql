-- 0048: adopting an NWS register tanker needs a verified owner or NWS approval (security review
-- SEC-03).
--
-- Imported register tankers carry NWS-issued permits (0032). A driver or owner who registered a
-- register plate whose owner has no mobile number on file adopted that tanker together with its
-- approved permit, and could go online under it at once. Now an adoption is:
--   * approved straight away when the adopter is the verified register owner: the register's
--     mobile number is the adopter's verified number, the owner row is already linked to the
--     adopter, or (registry_claim) to the owner of the company the tanker joins;
--   * otherwise PENDING: the tanker is on the platform but can't go online, be offered or accept
--     jobs (tanker_has_valid_permit is false and going online raises adoption_pending) until an
--     NWS permit officer (or admin) approves it. A rejection gives the plate back to the register
--     (off the platform, no company, the driver unassigned). Both are audited and the adopter is
--     notified.

alter table public.tankers
  add column adoption_state       text check (adoption_state in ('pending', 'approved', 'rejected')),
  add column adoption_by          uuid references public.profiles (id) on delete set null,
  add column adoption_at          timestamptz,
  add column adoption_reviewed_by uuid references public.profiles (id) on delete set null,
  add column adoption_reviewed_at timestamptz,
  add column adoption_note        text check (char_length(adoption_note) <= 300);
create index tankers_adoption_pending_idx on public.tankers (adoption_at) where adoption_state = 'pending';

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('adoption_review', 'Register tanker claimed: review needed', 'staff', '{plate} claimed: review needed',
   '{who} registered register tanker {plate} without a matching owner mobile number. Approve or reject it in Permits → Register.',
   'مطالبة بالصهريج {plate}: تحتاج مراجعة',
   'سجّل {who} صهريج السجل {plate} دون رقم هاتف مطابق للمالك. وافق أو ارفض من التصاريح ← السجل.',
   true, false, false, false, 'service', false),
  ('adoption_approved', 'Register tanker claim approved', 'owner', '{plate} approved by NWS',
   'NWS confirmed {plate} is yours. It can now go online with its permit.',
   'وافقت نماء على {plate}',
   'أكدت نماء أن {plate} يخصك. يمكنه الآن العمل بتصريحه.',
   true, true, false, false, 'service', true),
  ('adoption_rejected', 'Register tanker claim rejected', 'owner', '{plate} not confirmed',
   'NWS could not confirm {plate} is yours: {reason}. Contact NWS permits with the vehicle registration card.',
   'لم تؤكد نماء {plate}',
   'تعذّر على نماء التأكد من أن {plate} يخصك: {reason}. تواصل مع قسم التصاريح في نماء مع بطاقة تسجيل المركبة.',
   true, true, false, false, 'service', true)
on conflict (event) do nothing;

-- The caller is the verified owner of this register entry (see the header).
create function public.registry_verified_adopter(p_owner uuid, p_company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_owner is not null and exists (
    select 1 from public.registry_owners o
     where o.id = p_owner
       and ((auth.uid() is not null and o.profile_id = auth.uid())
            or (o.phone is not null and o.phone = public.verified_phone(auth.uid()))
            or (o.profile_id is not null and p_company is not null
                and exists (select 1 from public.profiles p where p.id = o.profile_id and p.company_id = p_company))))
$$;

-- A register tanker joining the platform: approved for its verified owner, else pending review.
create function public.tankers_adoption_review()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare u record; who text;
begin
  if new.in_register and new.on_platform and not coalesce(old.on_platform, false) then
    new.adoption_by := auth.uid();
    new.adoption_at := now();
    new.adoption_reviewed_by := null;
    new.adoption_reviewed_at := null;
    if public.registry_verified_adopter(new.registry_owner_id, new.company_id) then
      new.adoption_state := 'approved';
      new.adoption_note := 'Verified register owner';
    else
      new.adoption_state := 'pending';
      new.adoption_note := null;
      new.is_online := false;
      who := coalesce((select full_name from public.profiles where id = auth.uid()), 'A user');
      for u in select id from public.profiles where role = 'nws_staff' and staff_role in ('permit_officer', 'admin') order by staff_role desc, id limit 30 loop
        perform public.notify(u.id, 'adoption_review', null, jsonb_build_object('plate', new.plate, 'who', who));
      end loop;
    end if;
  end if;
  return new;
end $$;
create trigger tankers_adoption_review before update of on_platform on public.tankers
  for each row execute function public.tankers_adoption_review();

-- Going online with a pending claim: a clear error before the permit check.
create function public.tankers_adoption_guard()
returns trigger
language plpgsql
as $$
begin
  if new.is_online and new.adoption_state = 'pending' then raise exception 'adoption_pending'; end if;
  return new;
end $$;
create trigger tankers_adoption_guard before insert or update of is_online on public.tankers
  for each row execute function public.tankers_adoption_guard();

-- The permit is usable only once the claim is settled (every dispatch/online/accept path uses this).
create or replace function public.tanker_has_valid_permit(p_tanker uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.permits p join public.tankers t on t.id = p.tanker_id
     where p.tanker_id = p_tanker and p.status = 'approved' and p.issued_at <= now() and p.expires_at > now() and p.type = t.service_type
       and t.adoption_state is distinct from 'pending')
$$;

-- NWS: the pending claims.
create function public.staff_adoption_claims()
returns table (tanker_id uuid, plate text, service_type public.service_type, governorate_code text, adopter_id uuid, adopter_name text,
               adopter_role public.user_role, adopter_phone text, company_name text, requested_at timestamptz,
               register_owner text, register_owner_phone text, permit_no text, permit_expires_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_staff(array['permit_officer', 'operator', 'inspector']::public.staff_role[]);
  return query
    select t.id, t.plate, t.service_type, t.governorate_code, p.id, p.full_name, p.role, public.mask_phone(coalesce(public.verified_phone(p.id), p.phone)),
           c.name, t.adoption_at, o.name, public.mask_phone(o.phone),
           (select m.permit_no from public.permits m where m.tanker_id = t.id and m.status = 'approved' order by m.expires_at desc limit 1),
           (select m.expires_at from public.permits m where m.tanker_id = t.id and m.status = 'approved' order by m.expires_at desc limit 1)
      from public.tankers t
      left join public.profiles p on p.id = t.adoption_by
      left join public.companies c on c.id = t.company_id
      left join public.registry_owners o on o.id = t.registry_owner_id
     where t.adoption_state = 'pending'
     order by t.adoption_at;
end $$;

create function public.staff_review_adoption(p_tanker uuid, p_approve boolean, p_reason text)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare b public.tankers; a public.tankers; r text;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.tankers where id = p_tanker for update;
  if not found then raise exception 'not_found'; end if;
  if b.adoption_state is distinct from 'pending' then raise exception 'invalid_state'; end if;
  if p_approve then
    update public.tankers set adoption_state = 'approved', adoption_reviewed_by = auth.uid(), adoption_reviewed_at = now(), adoption_note = left(r, 300)
     where id = b.id returning * into a;
    if b.adoption_by is not null then perform public.notify(b.adoption_by, 'adoption_approved', null, jsonb_build_object('plate', b.plate)); end if;
  else
    update public.tanker_assignments set unassigned_at = now() where tanker_id = b.id and unassigned_at is null;
    update public.tankers
       set adoption_state = 'rejected', adoption_reviewed_by = auth.uid(), adoption_reviewed_at = now(), adoption_note = left(r, 300),
           is_online = false, on_platform = false, company_id = null, capacity_known = false
     where id = b.id returning * into a;
    if b.adoption_by is not null then perform public.notify(b.adoption_by, 'adoption_rejected', null, jsonb_build_object('plate', b.plate, 'reason', r)); end if;
  end if;
  perform public.write_audit(case when p_approve then 'tanker.adoption_approve' else 'tanker.adoption_reject' end, 'tanker', b.id::text,
    jsonb_build_object('adoption_state', b.adoption_state, 'adoption_by', b.adoption_by, 'company_id', b.company_id, 'on_platform', b.on_platform),
    jsonb_build_object('adoption_state', a.adoption_state, 'company_id', a.company_id, 'on_platform', a.on_platform), r);
  return a;
end $$;

revoke execute on function public.registry_verified_adopter(uuid, uuid), public.tankers_adoption_review(), public.tankers_adoption_guard()
  from public, anon, authenticated;
revoke execute on function public.staff_adoption_claims(), public.staff_review_adoption(uuid, boolean, text) from public, anon;
grant execute on function public.staff_adoption_claims(), public.staff_review_adoption(uuid, boolean, text) to authenticated;
