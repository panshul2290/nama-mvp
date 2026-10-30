-- 0023 — web portal fixes from the portal review (docs: scratchpad portal-review).
--   * Super admin has every staff power (prototype role matrix: "Super admin" = full on every
--     module), with one separation of duties kept: whoever recorded the passed inspection for a
--     permit application can't also approve it.
--   * Permit review: owners are notified (info requested, inspection booked, approved, rejected,
--     inspection failed); the document check blocks on missing required documents; moving to the
--     inspection stage books an inspection; owners can answer an information request; resubmitted
--     applications restart at the document check; approval dates the permit from approval.
--   * Expiry reminders are real (staff_permit_remind) and remembered (permits.reminded_at).
--   * Fleet: NWS can only assign a driver to a tanker of the driver's own company.
--   * Chat: read-only staff (viewer) can't message customers or drivers.
--   * Call-centre orders take a delivery window and refuse blocked customers.
--   * Complaints: agents can send a reply the customer sees; assign/escalate are logged in the case.
--   * Report builder: permits dataset and customer-segment grouping.
--   * Business: org_cancel_order (no wallet refund for account billing); org admins see complaints
--     on their organisation's orders.
--   * Companies see the orders generated from their own contracts before a driver takes them.
--   * Customers list: staff_customer_stats (wallet balance and order count, no row cap).
--   * More tables in the realtime publication.

-- ===========================================================================
-- Super admin passes every staff role check
-- ===========================================================================
create or replace function public.require_staff(p_roles public.staff_role[])
returns public.staff_role
language plpgsql stable security definer set search_path = public
as $$
declare r public.staff_role := public.my_staff_role();
begin
  if r is null then raise exception 'not_staff'; end if;
  if not (r = 'admin' or r = any(p_roles)) then raise exception 'forbidden_for_role: % cannot do this', r; end if;
  return r;
end $$;

-- ===========================================================================
-- Permits: columns, templates, helpers
-- ===========================================================================
alter table public.permits
  add column info_response     text check (char_length(info_response) <= 1000),
  add column info_responded_at timestamptz,
  add column reminded_at       timestamptz;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp) values
  ('permit_info_requested', 'Permit: information requested', 'owner', 'More information needed for {plate}',
   'NWS needs more information on permit application {permit}: {note}. Reply from Permits in the company portal.',
   'مطلوب معلومات إضافية لـ {plate}', 'تحتاج نما لمعلومات إضافية عن طلب الترخيص {permit}: {note}. يمكنك الرد من قسم التراخيص في بوابة الشركة.', true, true, false),
  ('permit_inspection_booked', 'Permit: inspection booked', 'owner', 'Inspection booked for {plate}',
   'NWS will inspect {plate} on {date} for permit application {permit}.',
   'تم حجز فحص لـ {plate}', 'ستقوم نما بفحص {plate} بتاريخ {date} لطلب الترخيص {permit}.', true, true, false),
  ('permit_inspection_failed', 'Permit: inspection failed', 'owner', 'Inspection failed for {plate}',
   '{plate} did not pass the NWS inspection for {permit}: {note}',
   'لم يجتز {plate} الفحص', 'لم يجتز {plate} فحص نما لطلب الترخيص {permit}: {note}', true, true, false),
  ('permit_approved', 'Permit: issued', 'owner', 'Permit issued for {plate}',
   'Permit {permit} is valid until {date}. The tanker can take jobs.',
   'تم إصدار ترخيص {plate}', 'الترخيص {permit} ساري حتى {date}. يمكن للصهريج استقبال الطلبات.', true, true, false),
  ('permit_rejected', 'Permit: rejected', 'owner', 'Permit application rejected',
   'Application {permit} for {plate} was rejected: {note}. You can correct it and apply again from the company portal.',
   'تم رفض طلب الترخيص', 'تم رفض الطلب {permit} لـ {plate}: {note}. يمكنك التصحيح والتقديم مجدداً من بوابة الشركة.', true, true, false)
on conflict (event) do nothing;

-- Notify the applicant and every owner of the tanker's company (each person once).
create function public.notify_permit(p_permit_id uuid, p_event text, p_vars jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare p public.permits; v jsonb;
begin
  select * into p from public.permits where id = p_permit_id;
  if not found then return; end if;
  v := jsonb_build_object('permit', p.permit_no, 'plate', coalesce((select plate from public.tankers where id = p.tanker_id), ''))
       || coalesce(p_vars, '{}'::jsonb);
  perform public.notify(u.id, p_event, null, v)
     from (select p.applied_by as id where p.applied_by is not null
           union
           select pr.id from public.profiles pr join public.tankers t on t.company_id = pr.company_id
            where t.id = p.tanker_id and pr.role = 'owner') u;
end $$;

-- Required tanker documents that aren't on file, approved and in date (labels, for messages).
create function public.permit_missing_documents(p_permit_id uuid)
returns text[]
language plpgsql stable security definer set search_path = public
as $$
declare p public.permits; t public.tankers; k text; out text[] := '{}';
  label constant jsonb := '{"mulkiya":"Mulkiya","insurance":"Insurance","water_test":"Water test"}';
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  select * into p from public.permits where id = p_permit_id;
  if not found then raise exception 'not_found'; end if;
  select * into t from public.tankers where id = p.tanker_id;
  foreach k in array case when t.service_type = 'DW' then array['mulkiya', 'insurance', 'water_test'] else array['mulkiya', 'insurance'] end loop
    if not exists (select 1 from public.tanker_documents d where d.tanker_id = t.id and d.kind = k and d.status = 'valid' and d.valid_to >= current_date) then
      out := array_append(out, label ->> k);
    end if;
  end loop;
  return out;
end $$;

-- ===========================================================================
-- Permit review RPCs
-- ===========================================================================
create or replace function public.staff_permit_stage(p_permit_id uuid, p_stage text, p_note text default null)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits; missing text[]; bk public.inspections;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'pending' then raise exception 'invalid_state: only pending applications move through stages'; end if;
  if p_stage = 'request_info' then
    update public.permits set info_requested = public.require_reason(p_note), info_response = null, info_responded_at = null, updated_at = now()
     where id = b.id returning * into a;
    perform public.notify_permit(a.id, 'permit_info_requested', jsonb_build_object('note', a.info_requested, 'note_ar', a.info_requested));
  elsif (b.stage, p_stage) in (('submitted', 'documents'), ('documents', 'inspection'), ('inspection', 'decision')) then
    if p_stage = 'inspection' then
      missing := public.permit_missing_documents(b.id);
      if cardinality(missing) > 0 then raise exception 'documents_incomplete: %', array_to_string(missing, ', '); end if;
    end if;
    if p_stage = 'decision' and not exists (select 1 from public.inspections i where i.tanker_id = b.tanker_id and i.result = 'pass'
                                              and (i.permit_id = b.id or i.created_at >= b.created_at)) then
      raise exception 'permit_review_incomplete: record a passed inspection first';
    end if;
    update public.permits set stage = p_stage, info_requested = null, updated_at = now() where id = b.id returning * into a;
    -- Reaching the inspection stage books a field inspection (unless one is already booked).
    if p_stage = 'inspection' then
      select * into bk from public.inspections where tanker_id = b.tanker_id and result = 'scheduled' order by created_at limit 1;
      if bk.id is null then
        insert into public.inspections (tanker_id, permit_id, inspector_id, result, notes, scheduled_for)
        values (b.tanker_id, b.id, null, 'scheduled', 'Permit application ' || b.permit_no, current_date + 1) returning * into bk;
      elsif bk.permit_id is null then
        update public.inspections set permit_id = b.id where id = bk.id returning * into bk;
      end if;
      perform public.notify_permit(a.id, 'permit_inspection_booked', jsonb_build_object('date', to_char(bk.scheduled_for, 'DD Mon YYYY'), 'date_ar', to_char(bk.scheduled_for, 'YYYY-MM-DD')));
    end if;
  else raise exception 'invalid_stage'; end if;
  perform public.write_audit('permit.stage', 'permit', b.id::text, jsonb_build_object('stage', b.stage, 'info_requested', b.info_requested),
                             jsonb_build_object('stage', a.stage, 'info_requested', a.info_requested), p_note);
  return a;
end $$;

create or replace function public.staff_review_permit(p_permit_id uuid, p_decision text, p_reason text)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits; r text; insp public.inspections;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if p_decision not in ('approve', 'reject') then raise exception 'invalid_decision'; end if;
  r := case when p_decision = 'reject' then public.require_reason(p_reason) else nullif(btrim(coalesce(p_reason, '')), '') end;
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'pending' then raise exception 'invalid_state: only pending permits can be reviewed'; end if;
  if p_decision = 'approve' and b.applied_by is not null then
    if b.stage <> 'decision' then raise exception 'permit_review_incomplete: the application is at the % stage', b.stage; end if;
    select * into insp from public.inspections i where i.tanker_id = b.tanker_id and i.result = 'pass'
       and (i.permit_id = b.id or i.created_at >= b.created_at) order by i.created_at desc limit 1;
    if insp.id is null then raise exception 'permit_review_incomplete: no passed inspection for this application'; end if;
    -- Separation of duties: the inspector who passed the tanker doesn't also approve its permit.
    if insp.inspector_id = auth.uid() then raise exception 'separation_of_duties: you recorded the inspection, so another officer must approve'; end if;
  end if;
  update public.permits
     set status = case when p_decision = 'approve' then 'approved'::public.permit_status else 'rejected'::public.permit_status end,
         -- An application is valid from approval for 12 months (its dates were placeholders until now).
         issued_at  = case when p_decision = 'approve' and b.applied_by is not null then now() else issued_at end,
         expires_at = case when p_decision = 'approve' and b.applied_by is not null then now() + interval '12 months' else expires_at end,
         reviewed_by = auth.uid(), reviewed_at = now(), reason = r, updated_at = now()
   where id = p_permit_id returning * into a;
  perform public.write_audit('permit.' || p_decision, 'permit', a.id::text, to_jsonb(b), to_jsonb(a), r);
  if p_decision = 'approve' then
    perform public.notify_permit(a.id, 'permit_approved', jsonb_build_object('date', to_char(a.expires_at, 'DD Mon YYYY'), 'date_ar', to_char(a.expires_at, 'YYYY-MM-DD')));
  else
    perform public.notify_permit(a.id, 'permit_rejected', jsonb_build_object('note', r, 'note_ar', r));
  end if;
  return a;
end $$;

-- Resubmitted applications go back through the document check.
create or replace function public.staff_resubmit_permit(p_permit_id uuid, p_expires_at timestamptz, p_reason text)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'rejected' then raise exception 'invalid_state: only rejected permits can be resubmitted'; end if;
  if p_expires_at is not null and p_expires_at <= b.issued_at then raise exception 'invalid_dates'; end if;
  if exists (select 1 from public.permits where tanker_id = b.tanker_id and status = 'pending' and id <> b.id) then raise exception 'application_pending'; end if;
  update public.permits
     set status = 'pending', expires_at = coalesce(p_expires_at, expires_at),
         stage = case when applied_by is not null then 'documents' else stage end,
         info_requested = null, info_response = null, info_responded_at = null,
         reviewed_by = null, reviewed_at = null, reason = null, updated_at = now()
   where id = p_permit_id returning * into a;
  perform public.write_audit('permit.resubmit', 'permit', a.id::text, to_jsonb(b), to_jsonb(a), p_reason);
  return a;
end $$;

-- The applicant (driver) or an owner of the tanker's company answers an information request.
create function public.permit_respond(p_permit_id uuid, p_note text)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits;
begin
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if not (b.applied_by = auth.uid()
          or (public.is_owner() and public.in_my_company(b.tanker_id))
          or (public.my_role() = 'driver' and public.my_tanker_id() = b.tanker_id)) then
    raise exception 'not_found';
  end if;
  if b.status <> 'pending' or b.info_requested is null then raise exception 'invalid_state: NWS has not asked for information'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'reason_required'; end if;
  update public.permits set info_response = left(btrim(p_note), 1000), info_responded_at = now(), info_requested = null, updated_at = now()
   where id = b.id returning * into a;
  insert into public.audit_log (actor_id, actor_email, actor_role, action, target_type, target_id, before, after, reason)
  select auth.uid(), (select email from auth.users where id = auth.uid()), public.my_role()::text, 'permit.info_response', 'permit', a.id::text,
         jsonb_build_object('info_requested', b.info_requested), jsonb_build_object('info_response', a.info_response), a.info_response;
  return a;
end $$;

-- Expiry reminder to the tanker's owners (permit_expiring template).
create function public.staff_permit_remind(p_permit_id uuid)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'approved' then raise exception 'invalid_state: only issued permits expire'; end if;
  update public.permits set reminded_at = now() where id = b.id returning * into a;
  perform public.notify_permit(a.id, 'permit_expiring', jsonb_build_object('date', to_char(a.expires_at, 'DD Mon YYYY'), 'date_ar', to_char(a.expires_at, 'YYYY-MM-DD')));
  perform public.write_audit('permit.remind', 'permit', a.id::text, null, jsonb_build_object('expires_at', a.expires_at), null);
  return a;
end $$;

-- Record an inspection result, optionally for one booked inspection (p_inspection_id).
drop function public.staff_record_inspection(uuid, uuid, text, text, jsonb);
create function public.staff_record_inspection(p_tanker_id uuid, p_permit_id uuid, p_result text, p_notes text,
                                               p_checklist jsonb default '{}'::jsonb, p_inspection_id uuid default null)
returns public.inspections
language plpgsql security definer set search_path = public
as $$
declare i public.inspections; target uuid;
begin
  perform public.require_staff(array['inspector', 'permit_officer']::public.staff_role[]);
  if p_result not in ('pass', 'fail', 'scheduled') then raise exception 'invalid_result'; end if;
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
  if p_inspection_id is not null then
    select id into target from public.inspections where id = p_inspection_id and tanker_id = p_tanker_id and result = 'scheduled' for update;
    if target is null then raise exception 'not_found'; end if;
    if p_result = 'scheduled' then raise exception 'invalid_result'; end if;
  elsif p_result <> 'scheduled' then
    select id into target from public.inspections where tanker_id = p_tanker_id and result = 'scheduled' order by created_at limit 1 for update;
  end if;
  if target is not null then
    update public.inspections
       set result = p_result, inspector_id = auth.uid(), notes = btrim(notes || E'\n' || coalesce(p_notes, '')), checklist = coalesce(p_checklist, '{}'::jsonb),
           permit_id = coalesce(p_permit_id, permit_id)
     where id = target returning * into i;
  else
    insert into public.inspections (tanker_id, permit_id, inspector_id, result, notes, checklist, scheduled_for)
    values (p_tanker_id, p_permit_id, auth.uid(), p_result, coalesce(p_notes, ''), coalesce(p_checklist, '{}'::jsonb),
            case when p_result = 'scheduled' then current_date + 1 else current_date end) returning * into i;
  end if;
  if i.permit_id is not null and p_result = 'pass' then
    update public.permits set stage = 'decision', updated_at = now() where id = i.permit_id and status = 'pending' and stage = 'inspection';
  end if;
  if i.permit_id is not null and p_result = 'fail' then
    perform public.notify_permit(i.permit_id, 'permit_inspection_failed', jsonb_build_object('note', coalesce(nullif(btrim(p_notes), ''), 'see the inspection notes'),
                                                                                             'note_ar', coalesce(nullif(btrim(p_notes), ''), 'راجع ملاحظات الفحص')));
  end if;
  perform public.write_audit('inspection.' || p_result, 'tanker', p_tanker_id::text, null, to_jsonb(i), p_notes);
  return i;
end $$;

-- ===========================================================================
-- Fleet: a driver goes only on a tanker of their own company
-- ===========================================================================
create or replace function public.staff_assign_tanker(p_driver_id uuid, p_tanker_id uuid, p_reason text)
returns public.tanker_assignments
language plpgsql security definer set search_path = public
as $$
declare a public.tanker_assignments; r text; dco uuid; tco uuid;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select company_id into dco from public.profiles where id = p_driver_id and role = 'driver';
  if not found then raise exception 'not_a_driver'; end if;
  select company_id into tco from public.tankers where id = p_tanker_id;
  if not found then raise exception 'not_found'; end if;
  if dco is distinct from tco then raise exception 'driver_other_company'; end if;
  if exists (select 1 from public.tanker_assignments where driver_id = p_driver_id and unassigned_at is null) then raise exception 'driver_already_assigned'; end if;
  if exists (select 1 from public.tanker_assignments where tanker_id = p_tanker_id and unassigned_at is null) then raise exception 'tanker_already_assigned'; end if;
  begin
    insert into public.tanker_assignments (driver_id, tanker_id, assigned_by) values (p_driver_id, p_tanker_id, auth.uid()) returning * into a;
  exception when unique_violation then
    raise exception 'already_assigned';
  end;
  perform public.write_audit('tanker.assign', 'tanker', p_tanker_id::text, null,
    jsonb_build_object('driver_id', p_driver_id, 'assignment_id', a.id), r);
  return a;
end $$;

-- ===========================================================================
-- Chat: read-only staff can't message
-- ===========================================================================
create or replace function public.send_message(p_order_id uuid, p_body text)
returns public.order_messages
language plpgsql security definer set search_path = public
as $$
declare o public.orders; m public.order_messages; who text;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'not_found'; end if;
  if o.customer_id = auth.uid() then who := 'customer';
  elsif o.driver_id = auth.uid() then who := 'driver';
  elsif public.is_staff() then
    if public.my_staff_role() = 'viewer' then raise exception 'forbidden_for_role: viewer cannot do this'; end if;
    who := 'staff';
  else raise exception 'not_found'; end if;
  if who <> 'staff' and o.status not in ('accepted', 'arriving', 'arrived', 'collected') then raise exception 'chat_closed'; end if;
  insert into public.order_messages (order_id, sender_id, sender_role, body) values (o.id, auth.uid(), who, btrim(p_body)) returning * into m;
  return m;
end $$;

-- ===========================================================================
-- Call-centre orders: delivery window, blocked customers refused
-- ===========================================================================
drop function public.staff_place_order(uuid, public.service_type, integer, double precision, double precision, text, text, text, boolean);
create function public.staff_place_order(p_customer_id uuid, p_service_type public.service_type, p_gallons integer, p_lat double precision, p_lng double precision,
                                         p_area text, p_address text, p_genesys_id text, p_emergency boolean default false,
                                         p_slot_start timestamptz default null, p_slot_end timestamptz default null, p_slot_label text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; z public.zones; st public.order_status := 'requested'; blocked boolean;
begin
  perform public.require_staff(array['operator', 'complaints_agent']::public.staff_role[]);
  select account_blocked into blocked from public.profiles where id = p_customer_id and role = 'customer';
  if not found then raise exception 'not_a_customer'; end if;
  if blocked then raise exception 'account_blocked'; end if;
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if coalesce(btrim(p_area), '') = '' then raise exception 'area_required'; end if;
  z := public.zone_at(p_lat, p_lng);
  if z.id is null then raise exception 'outside_service_area'; end if;
  if p_slot_start is not null then
    if p_slot_end is null or p_slot_end <= p_slot_start then raise exception 'invalid_slot'; end if;
    if p_slot_end < now() then raise exception 'slot_in_past'; end if;
    if p_slot_start > now() + interval '2 hours' then st := 'scheduled'; end if;
  end if;
  insert into public.orders (customer_id, service_type, gallons, area, zone_id, status, slot_start, slot_end, slot_label, slot_peak,
                             channel, genesys_id, is_emergency, pay_method)
  values (p_customer_id, p_service_type, p_gallons, left(btrim(p_area), 120), z.id, st, p_slot_start, p_slot_end, left(p_slot_label, 60),
          public.is_peak(p_slot_start), 'call_centre', nullif(btrim(coalesce(p_genesys_id, '')), ''), coalesce(p_emergency, false), 'cash')
  returning * into o;
  insert into public.order_locations (order_id, lat, lng, address) values (o.id, p_lat, p_lng, left(coalesce(btrim(p_address), ''), 300));
  insert into public.payments (order_id, customer_id, method, amount, status, gateway_ref) values (o.id, p_customer_id, 'cash', o.total, 'authorized', 'COD-' || o.order_no);
  update public.orders set payment_status = 'authorized' where id = o.id returning * into o;
  perform public.write_audit('order.create_for_caller', 'order', o.id::text, null,
    jsonb_build_object('order_no', o.order_no, 'genesys_id', p_genesys_id, 'customer_id', p_customer_id, 'slot_label', o.slot_label), 'Call-centre order');
  return o;
end $$;

-- ===========================================================================
-- Complaints: customer-visible reply; assign/escalate logged in the case
-- ===========================================================================
create or replace function public.staff_case_action(p_complaint_id uuid, p_action text, p_body text default null, p_team text default null, p_amount numeric default null)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare b public.complaints; a public.complaints; refunded numeric; logline text;
begin
  perform public.require_staff(array['complaints_agent', 'operator']::public.staff_role[]);
  select * into b from public.complaints where id = p_complaint_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'assign' then
    update public.complaints set state = case when state = 'resolved' then state else 'assigned' end,
                                 owner_team = coalesce(nullif(btrim(p_team), ''), owner_team) where id = b.id returning * into a;
    logline := 'Assigned to ' || coalesce(a.owner_team, 'the owning team') || '.';
  elsif p_action = 'escalate' then
    update public.complaints set state = 'escalated', owner_team = coalesce(nullif(btrim(p_team), ''), 'Tanker operations supervisor') where id = b.id returning * into a;
    logline := 'Escalated to ' || a.owner_team || '.';
  elsif p_action = 'refund' then
    if coalesce(p_amount, 0) <= 0 or p_amount > 50 then raise exception 'invalid_amount'; end if;
    if b.order_id is not null then refunded := public.refund_to_wallet(b.order_id, p_amount, 'refund', 'Complaint C-' || b.case_no); end if;
    if coalesce(refunded, 0) = 0 and b.customer_id is not null then
      insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (b.customer_id, 'goodwill', round(p_amount, 3), b.order_id, 'Complaint C-' || b.case_no);
      refunded := round(p_amount, 3);
    end if;
    update public.complaints set refund_amount = refund_amount + refunded where id = b.id returning * into a;
    insert into public.complaint_notes (complaint_id, author_id, author_role, body)
    values (b.id, auth.uid(), 'staff', 'Refunded ' || to_char(refunded, 'FM9990.000') || ' OMR to the customer''s wallet.');
  elsif p_action = 'resolve' then
    if char_length(btrim(coalesce(p_body, ''))) < 3 then raise exception 'reason_required'; end if;
    update public.complaints set state = 'resolved', resolved_at = now(), resolution = btrim(p_body) where id = b.id returning * into a;
    perform public.notify(b.customer_id, 'complaint_update', b.order_id, jsonb_build_object('case', 'C-' || b.case_no, 'status', 'resolved', 'status_ar', 'تم الحل'));
  elsif p_action = 'reopen' then
    update public.complaints set state = 'assigned', resolved_at = null where id = b.id and state = 'resolved' returning * into a;
    if not found then raise exception 'invalid_state'; end if;
  elsif p_action = 'reply' then
    if char_length(btrim(coalesce(p_body, ''))) < 1 then raise exception 'reason_required'; end if;
    a := b;
    perform public.notify(b.customer_id, 'complaint_update', b.order_id, jsonb_build_object('case', 'C-' || b.case_no, 'status', 'replied', 'status_ar', 'تم الرد'));
  elsif p_action = 'note' then
    a := b;
  else raise exception 'invalid_action'; end if;
  if logline is not null then
    insert into public.complaint_notes (complaint_id, author_id, author_role, body, internal)
    values (b.id, auth.uid(), 'staff', logline || coalesce(' ' || nullif(btrim(coalesce(p_body, '')), ''), ''), true);
  elsif nullif(btrim(coalesce(p_body, '')), '') is not null then
    insert into public.complaint_notes (complaint_id, author_id, author_role, body, internal)
    values (b.id, auth.uid(), 'staff', btrim(p_body), p_action = 'note');
  end if;
  perform public.write_audit('complaint.' || p_action, 'complaint', b.id::text,
    jsonb_build_object('state', b.state, 'owner_team', b.owner_team, 'refund_amount', b.refund_amount),
    jsonb_build_object('state', a.state, 'owner_team', a.owner_team, 'refund_amount', a.refund_amount), p_body);
  return a;
end $$;

-- Org admins see complaints filed on their organisation's orders.
create policy complaints_org on public.complaints for select to authenticated using (
  public.my_org_role() = 'admin' and exists (select 1 from public.orders o where o.id = complaints.order_id and o.org_id = public.my_org_id()));

-- ===========================================================================
-- Report builder: permits dataset, segment grouping
-- ===========================================================================
create or replace function public.staff_save_scheduled_report(p_name text, p_dataset text, p_group_by text, p_cadence text, p_format text, p_recipients text)
returns public.scheduled_reports
language plpgsql security definer set search_path = public
as $$
declare s public.scheduled_reports;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  if public.my_staff_role() = 'viewer' then raise exception 'forbidden_for_role: viewer cannot do this'; end if;
  p_dataset := lower(btrim(coalesce(p_dataset, '')));
  if char_length(btrim(coalesce(p_name, ''))) < 3
     or p_dataset not in ('orders', 'revenue', 'complaints', 'ratings', 'fleet', 'payments', 'permits')
     or p_group_by not in ('day', 'service', 'zone', 'company', 'category', 'channel', 'segment', 'status')
     or p_cadence not in ('daily', 'weekly', 'monthly') or p_format not in ('csv', 'xlsx', 'pdf') then
    raise exception 'invalid_value';
  end if;
  insert into public.scheduled_reports (name, dataset, group_by, cadence, format, recipients, created_by)
  values (btrim(p_name), p_dataset, p_group_by, p_cadence, p_format, left(coalesce(p_recipients, ''), 500), auth.uid()) returning * into s;
  perform public.write_audit('report.schedule', 'scheduled_report', s.id::text, null, to_jsonb(s), null);
  return s;
end $$;

-- ===========================================================================
-- Business: cancel an order billed to the account (nothing was charged, so no refund)
-- ===========================================================================
create function public.org_cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; r text := public.my_org_role();
begin
  if r is null or r = 'finance' then raise exception 'forbidden_for_role'; end if;
  select * into o from public.orders where id = p_order_id and org_id = public.my_org_id() for update;
  if not found then raise exception 'not_found'; end if;
  if r = 'site_manager' and o.customer_id is distinct from auth.uid() then raise exception 'not_found'; end if;
  if o.status not in ('pending_approval', 'scheduled', 'requested') then raise exception 'cannot_cancel'; end if;
  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer',
         cancel_reason = coalesce(nullif(left(btrim(coalesce(p_reason, '')), 300), ''), 'Cancelled by the business')
   where id = o.id returning * into o;
  -- Account orders aren't charged up front; any non-account payment goes back the usual way.
  if o.billing <> 'account' then perform public.refund_to_wallet(o.id, o.total, 'refund', 'Cancelled TO-' || o.order_no); end if;
  select * into o from public.orders where id = o.id;
  return o;
end $$;

-- ===========================================================================
-- Companies see orders generated from their own contracts (before a driver takes them)
-- ===========================================================================
create policy orders_owner_contract on public.orders for select to authenticated using (
  contract_id is not null and public.is_owner()
  and exists (select 1 from public.contracts k where k.id = orders.contract_id and k.company_id = public.my_company_id()));

-- ===========================================================================
-- Customers list: wallet balance and order count per customer, no row cap
-- ===========================================================================
create function public.staff_customer_stats()
returns table (customer_id uuid, wallet numeric, orders integer, delivered integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select p.id,
           coalesce((select sum(w.amount) from public.wallet_tx w where w.customer_id = p.id), 0)::numeric(12,3),
           (select count(*)::int from public.orders o where o.customer_id = p.id and not o.is_test),
           (select count(*)::int from public.orders o where o.customer_id = p.id and not o.is_test and o.status = 'delivered')
      from public.profiles p where p.role in ('customer', 'business');
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function public.notify_permit(uuid, text, jsonb) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'permit_missing_documents(uuid)', 'permit_respond(uuid, text)', 'staff_permit_remind(uuid)',
    'staff_record_inspection(uuid, uuid, text, text, jsonb, uuid)',
    'staff_place_order(uuid, public.service_type, integer, double precision, double precision, text, text, text, boolean, timestamptz, timestamptz, text)',
    'org_cancel_order(uuid, text)', 'staff_customer_stats()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- Realtime: the tables the portals subscribe to
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['contracts', 'company_tx', 'penalties', 'tanker_documents', 'tanker_assignments', 'invoices',
                           'inspections', 'complaint_notes', 'app_settings', 'driver_availability', 'shift_checks', 'water_tests'] loop
    if exists (select 1 from pg_class where relname = t and relnamespace = 'public'::regnamespace)
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
