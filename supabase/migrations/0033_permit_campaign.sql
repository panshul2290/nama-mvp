-- Batch D (part 3 of 3): register lists, the permit campaign and per-cluster reports.
--
--   register_status_rows()   one row per tanker with its owner, cluster, current permit and
--                            campaign stage (internal; the RPCs below filter and page it, so
--                            no screen loads ~11,000 tankers).
--   staff_register_tankers   NWS → Permits → Register and Campaign drill-down: filtered,
--                            paged (≤ 2,000 per call), phones masked unless the staff member
--                            is privileged (PRIVACY.privileged_roles, 0027).
--   report_permit_campaign   the funnel by cluster and governorate: in register → owner invited
--                            → registered on the platform → permit applied → under review →
--                            permitted, plus expiring soon and expired.
--   staff_invite_registry_owners  SMS invitations to registry owners through the notification
--                            outbox (0026), throttled and consent-aware: never to an owner who
--                            opted out, is already on the platform, was invited in the last
--                            cooldown_days or has had max_invites; never to a number whose
--                            account switched SMS off; at most daily_cap a day, queued at
--                            per_minute (REGISTRY_INVITES setting). Template registry_invite (EN/AR).
--   staff_registry_owner_opt_out  record an owner's "STOP" (or undo it), audited.
--   report_clusters          Reports → Clusters: per cluster and governorate, register and
--                            platform tankers, permits, online now and orders.
-- Stages, furthest first: permitted (approved, unexpired permit for the tanker's type) >
-- review (pending at documents / inspection / decision) > applied (pending at submitted, or a
-- rejected or expired permit) > registered (on the platform, or the owner claimed the entry) >
-- invited (owner sent an invitation) > register.

-- ===========================================================================
-- Settings and the invitation template
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('REGISTRY_INVITES', '{"daily_cap": 2000, "per_minute": 60, "cooldown_days": 7, "max_invites": 3, "link": "https://nama.om/tanker"}',
   'SMS invitations to registry owners (NWS → Permits → Campaign): messages a day, sending rate per minute, days before the same owner can be invited again, invitations per owner, app link in the message.')
on conflict (key) do nothing;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('registry_invite', 'Register: invitation to the platform', 'owner', 'Register your tanker {plates}',
   'Nama Water Services: tanker {plates} is in the NWS tanker register. Sign up on the Nama Tanker app with this mobile number to apply for your permit online: {link} Reply STOP to opt out.',
   'سجّل صهريجك {plates}',
   'نما لخدمات المياه: الصهريج {plates} مدرج في سجل صهاريج نما. سجّل في تطبيق نما للصهاريج بهذا الرقم لتقديم طلب التصريح إلكترونياً: {link} للإلغاء أرسل STOP.',
   false, true, false, false, 'service', false)
on conflict (event) do nothing;

-- ===========================================================================
-- Register rows (internal)
-- ===========================================================================
create function public.register_status_rows()
returns table (
  tanker_id uuid, plate text, service_type public.service_type, governorate_code text, cluster_code text,
  in_register boolean, on_platform boolean, capacity_known boolean, capacity_gal integer, is_online boolean, blocked boolean,
  company_name text, owner_id uuid, owner_name text, owner_phone text, owner_claimed boolean, invited_at timestamptz,
  invite_count integer, sms_opt_out boolean, register_permit_status text, register_permit_no text,
  permit_id uuid, permit_no text, permit_expires timestamptz, permit_valid boolean,
  pending_id uuid, pending_no text, pending_stage text, stage text, import_batch_id uuid)
language sql stable security definer set search_path = public
as $$
  select t.id, t.plate, t.service_type, t.governorate_code, g.cluster_code,
         t.in_register, t.on_platform, t.capacity_known, t.capacity_gal, t.is_online, t.blocked,
         c.name, o.id, o.name, o.phone, o.profile_id is not null, o.invited_at, coalesce(o.invite_count, 0), coalesce(o.sms_opt_out, false),
         t.register_permit_status, t.register_permit_no,
         ap.id, ap.permit_no, ap.expires_at, ap.valid,
         pp.id, pp.permit_no, pp.stage,
         case when ap.valid then 'permitted'
              when pp.stage in ('documents', 'inspection', 'decision') then 'review'
              when pp.id is not null or ap.id is not null or exists (select 1 from public.permits x where x.tanker_id = t.id and x.status = 'rejected') then 'applied'
              when t.on_platform or o.profile_id is not null then 'registered'
              when o.invited_at is not null then 'invited'
              else 'register' end,
         t.import_batch_id
    from public.tankers t
    left join public.governorates g on g.code = t.governorate_code
    left join public.companies c on c.id = t.company_id
    left join public.registry_owners o on o.id = t.registry_owner_id
    left join lateral (select p.id, p.permit_no, p.expires_at,
                              (p.type = t.service_type and p.issued_at <= now() and p.expires_at > now()) as valid
                         from public.permits p where p.tanker_id = t.id and p.status = 'approved'
                        order by (p.type = t.service_type) desc, p.expires_at desc limit 1) ap on true
    left join lateral (select p.id, p.permit_no, p.stage from public.permits p
                        where p.tanker_id = t.id and p.status = 'pending' order by p.created_at desc limit 1) pp on true
$$;

-- Does a register row match a filter? Keys (all optional): cluster, governorate, service, stage,
-- permit (valid | expiring | expired | pending | none), source (register | platform | register_only | all;
-- default all), invite (never | invited | opted_out | no_phone), q (plate or owner), batch.
create function public.register_row_matches(
  p_filter jsonb, p_cluster text, p_gov text, p_service public.service_type, p_stage text, p_in_register boolean, p_on_platform boolean,
  p_permit_valid boolean, p_permit_expires timestamptz, p_pending boolean, p_plate text, p_owner text, p_phone text, p_invited timestamptz,
  p_opt_out boolean, p_batch uuid)
returns boolean
language sql stable
as $$
  select (nullif(p_filter ->> 'cluster', '') is null or p_cluster = p_filter ->> 'cluster' or (p_filter ->> 'cluster' = 'none' and p_cluster is null))
     and (nullif(p_filter ->> 'governorate', '') is null or p_gov = p_filter ->> 'governorate')
     and (nullif(p_filter ->> 'service', '') is null or p_service::text = p_filter ->> 'service')
     and (nullif(p_filter ->> 'stage', '') is null or p_stage = p_filter ->> 'stage'
          -- "reached" stages for the funnel drill-down
          or (p_filter ->> 'stage' = 'reached_invited' and p_stage <> 'register')
          or (p_filter ->> 'stage' = 'reached_registered' and p_stage in ('registered', 'applied', 'review', 'permitted'))
          or (p_filter ->> 'stage' = 'reached_applied' and p_stage in ('applied', 'review', 'permitted'))
          or (p_filter ->> 'stage' = 'reached_review' and p_stage in ('review', 'permitted'))
          or (p_filter ->> 'stage' = 'not_registered' and p_stage in ('register', 'invited')))
     and (nullif(p_filter ->> 'permit', '') is null
          or (p_filter ->> 'permit' = 'valid' and coalesce(p_permit_valid, false))
          or (p_filter ->> 'permit' = 'expiring' and coalesce(p_permit_valid, false)
              and p_permit_expires <= now() + make_interval(days => coalesce(nullif(p_filter ->> 'days', '')::integer, 30)))
          or (p_filter ->> 'permit' = 'expired' and p_permit_expires is not null and not coalesce(p_permit_valid, false))
          or (p_filter ->> 'permit' = 'pending' and p_pending)
          or (p_filter ->> 'permit' = 'none' and p_permit_expires is null and not p_pending)
          or (p_filter ->> 'permit' = 'blocked' and not coalesce(p_permit_valid, false)))
     and (case coalesce(nullif(p_filter ->> 'source', ''), 'all')
            when 'register' then p_in_register when 'platform' then p_on_platform
            when 'register_only' then p_in_register and not p_on_platform else true end)
     and (nullif(p_filter ->> 'invite', '') is null
          or (p_filter ->> 'invite' = 'never' and p_invited is null)
          or (p_filter ->> 'invite' = 'invited' and p_invited is not null)
          or (p_filter ->> 'invite' = 'opted_out' and p_opt_out)
          or (p_filter ->> 'invite' = 'no_phone' and p_phone is null))
     and (nullif(btrim(p_filter ->> 'q'), '') is null
          or p_plate ilike '%' || btrim(p_filter ->> 'q') || '%'
          or coalesce(p_owner, '') ilike '%' || btrim(p_filter ->> 'q') || '%')
     and (nullif(p_filter ->> 'batch', '') is null or p_batch::text = p_filter ->> 'batch')
$$;

-- ===========================================================================
-- Staff: the register, filtered and paged
-- ===========================================================================
create function public.staff_register_tankers(p_filter jsonb default '{}'::jsonb, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare lim integer := greatest(least(coalesce(p_limit, 100), 2000), 1); off integer := greatest(coalesce(p_offset, 0), 0);
        priv boolean := public.staff_privileged(); f jsonb := coalesce(p_filter, '{}'::jsonb); out jsonb;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  with m as (
    select r.* from public.register_status_rows() r
     where public.register_row_matches(f, r.cluster_code, r.governorate_code, r.service_type, r.stage, r.in_register, r.on_platform,
                                       r.permit_valid, r.permit_expires, r.pending_id is not null, r.plate, r.owner_name, r.owner_phone,
                                       r.invited_at, r.sms_opt_out, r.import_batch_id))
  select jsonb_build_object(
    'total', (select count(*) from m),
    'privileged', priv,
    'kpis', (select jsonb_build_object(
               'valid', count(*) filter (where permit_valid),
               'expiring_30', count(*) filter (where permit_valid and permit_expires <= now() + interval '30 days'),
               'blocked', count(*) filter (where not coalesce(permit_valid, false)),
               'pending', count(*) filter (where pending_id is not null),
               'on_platform', count(*) filter (where on_platform),
               'register_only', count(*) filter (where in_register and not on_platform),
               'capacity_unknown', count(*) filter (where not capacity_known)) from m),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
              'tanker_id', x.tanker_id, 'plate', x.plate, 'service_type', x.service_type, 'governorate', x.governorate_code, 'cluster', x.cluster_code,
              'in_register', x.in_register, 'on_platform', x.on_platform, 'capacity_gal', x.capacity_gal, 'capacity_known', x.capacity_known,
              'is_online', x.is_online, 'blocked', x.blocked, 'company', x.company_name,
              'owner_id', x.owner_id, 'owner_name', x.owner_name,
              'phone', case when priv then x.owner_phone else public.mask_phone(x.owner_phone) end,
              'has_phone', x.owner_phone is not null, 'claimed', x.owner_claimed, 'invited_at', x.invited_at, 'invite_count', x.invite_count, 'opted_out', x.sms_opt_out,
              'register_permit_status', x.register_permit_status, 'register_permit_no', x.register_permit_no,
              'permit_id', x.permit_id, 'permit_no', x.permit_no, 'permit_expires', x.permit_expires, 'permit_valid', coalesce(x.permit_valid, false),
              'pending_id', x.pending_id, 'pending_no', x.pending_no, 'pending_stage', x.pending_stage, 'stage', x.stage) order by x.plate)
              from (select * from m order by plate limit lim offset off) x), '[]'::jsonb))
    into out;
  return out;
end $$;

-- ===========================================================================
-- Reports: the permit campaign funnel
-- ===========================================================================
create function public.report_permit_campaign(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare f jsonb := coalesce(p_filter, '{}'::jsonb) || jsonb_build_object('source', 'register', 'stage', '', 'permit', ''); out jsonb;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  with m as (
    select r.* from public.register_status_rows() r
     where public.register_row_matches(f, r.cluster_code, r.governorate_code, r.service_type, r.stage, r.in_register, r.on_platform,
                                       r.permit_valid, r.permit_expires, r.pending_id is not null, r.plate, r.owner_name, r.owner_phone,
                                       r.invited_at, r.sms_opt_out, r.import_batch_id)),
  s as (
    select m.*, case m.stage when 'register' then 0 when 'invited' then 1 when 'registered' then 2 when 'applied' then 3 when 'review' then 4 else 5 end as lvl
      from m),
  agg as (
    select governorate_code, cluster_code, grouping(governorate_code, cluster_code) as gset,
           count(*) as in_register,
           count(*) filter (where lvl >= 1) as invited,
           count(*) filter (where lvl >= 2) as registered,
           count(*) filter (where lvl >= 3) as applied,
           count(*) filter (where lvl >= 4) as review,
           count(*) filter (where lvl >= 5) as permitted,
           count(*) filter (where permit_valid and permit_expires <= now() + interval '30 days') as expiring_30,
           count(*) filter (where permit_valid and permit_expires <= now() + interval '60 days') as expiring_60,
           count(*) filter (where permit_expires is not null and not coalesce(permit_valid, false)) as expired,
           count(*) filter (where owner_phone is null) as no_phone,
           count(*) filter (where sms_opt_out) as opted_out,
           count(*) filter (where lvl <= 1 and owner_phone is not null and not sms_opt_out) as invitable
      from s group by grouping sets ((governorate_code, cluster_code), (cluster_code), ()))
  select jsonb_build_object(
    'total', coalesce((select to_jsonb(a) - 'governorate_code' - 'cluster_code' - 'gset' from agg a where a.gset = 3),
                      jsonb_build_object('in_register', 0, 'invited', 0, 'registered', 0, 'applied', 0, 'review', 0, 'permitted', 0, 'expiring_30', 0,
                                         'expiring_60', 0, 'expired', 0, 'no_phone', 0, 'opted_out', 0, 'invitable', 0)),
    'by_cluster', coalesce((select jsonb_agg(to_jsonb(a) - 'governorate_code' - 'gset' || jsonb_build_object('name', coalesce(c.name, 'No cluster')) order by c.sort nulls last)
                              from agg a left join public.clusters c on c.code = a.cluster_code where a.gset = 2), '[]'::jsonb),
    'by_governorate', coalesce((select jsonb_agg(to_jsonb(a) - 'gset' || jsonb_build_object('name', coalesce(g.name, 'Unknown governorate')) order by g.sort nulls last)
                                  from agg a left join public.governorates g on g.code = a.governorate_code where a.gset = 0), '[]'::jsonb))
    into out;
  return out;
end $$;

-- ===========================================================================
-- Staff: SMS invitations to registry owners
-- ===========================================================================
create function public.staff_invite_registry_owners(
  p_owner_ids uuid[] default null, p_batch_id uuid default null, p_filter jsonb default null,
  p_lang text default 'ar', p_limit integer default 500, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  cfg jsonb := coalesce(public.setting_json('REGISTRY_INVITES'), '{}'::jsonb);
  cap integer := coalesce((cfg ->> 'daily_cap')::integer, 2000);
  per_min integer := greatest(coalesce((cfg ->> 'per_minute')::integer, 60), 1);
  cool integer := coalesce((cfg ->> 'cooldown_days')::integer, 7);
  maxi integer := coalesce((cfg ->> 'max_invites')::integer, 3);
  link text := coalesce(cfg ->> 'link', '');
  lim integer := greatest(least(coalesce(p_limit, 500), 500), 1);
  lang text := case when p_lang = 'en' then 'en' else 'ar' end;
  tpl public.notification_templates; day0 timestamptz := (date_trunc('day', now() at time zone 'Asia/Muscat')) at time zone 'Asia/Muscat';
  sent_today integer; room integer; o record; plates text; t text; b text; q integer := 0; slot integer;
  s_claimed integer := 0; s_opt integer := 0; s_phone integer := 0; s_cool integer := 0; s_max integer := 0; s_consent integer := 0; s_cap integer := 0;
  considered integer := 0; last_queue timestamptz;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if p_owner_ids is null and p_batch_id is null and p_filter is null then raise exception 'invalid_invite: choose owners, an import or a filter'; end if;
  if coalesce(cardinality(p_owner_ids), 0) > 500 then raise exception 'too_many: at most 500 owners per call'; end if;
  select * into tpl from public.notification_templates where event = 'registry_invite';
  if not found or not tpl.sms then raise exception 'invalid_state: the registry_invite SMS template is switched off'; end if;
  if coalesce(public.setting_json('NOTIFY') -> 'providers' ->> 'sms', 'simulated') = 'off' then raise exception 'invalid_state: SMS is switched off in NWS settings'; end if;
  select count(*)::int into sent_today from public.notification_outbox where event = 'registry_invite' and created_at >= day0;
  room := greatest(cap - sent_today, 0);
  -- Spread the queue: carry on after the last queued invitation, per_minute a minute.
  select max(next_attempt_at) into last_queue from public.notification_outbox where event = 'registry_invite' and status = 'queued';
  last_queue := greatest(coalesce(last_queue, now()), now());

  for o in
    select ro.* from public.registry_owners ro
     where (p_owner_ids is not null and ro.id = any(p_owner_ids))
        or (p_batch_id is not null and (ro.batch_id = p_batch_id or ro.first_batch_id = p_batch_id))
        or (p_filter is not null and ro.id in (
              select r.owner_id from public.register_status_rows() r
               where r.owner_id is not null
                 and public.register_row_matches(p_filter, r.cluster_code, r.governorate_code, r.service_type, r.stage, r.in_register, r.on_platform,
                                                 r.permit_valid, r.permit_expires, r.pending_id is not null, r.plate, r.owner_name, r.owner_phone,
                                                 r.invited_at, r.sms_opt_out, r.import_batch_id)))
     order by ro.invited_at nulls first, ro.created_at, ro.id
     for update skip locked
  loop
    exit when q >= lim;
    considered := considered + 1;
    if o.phone is null then s_phone := s_phone + 1; continue; end if;
    if o.sms_opt_out then s_opt := s_opt + 1; continue; end if;
    if o.profile_id is not null or exists (select 1 from public.tankers k where k.registry_owner_id = o.id and k.on_platform) then s_claimed := s_claimed + 1; continue; end if;
    if o.invite_count >= maxi then s_max := s_max + 1; continue; end if;
    if o.invited_at is not null and o.invited_at > now() - make_interval(days => cool) then s_cool := s_cool + 1; continue; end if;
    -- An account holding this number switched SMS off: respect it.
    if exists (select 1 from public.profiles p where p.phone = o.phone and coalesce((public.effective_prefs(p.prefs) ->> 'sms')::boolean, true) = false) then
      s_consent := s_consent + 1; continue;
    end if;
    if q >= room then s_cap := s_cap + 1; continue; end if;
    select string_agg(k.plate, ', ' order by k.plate) into plates
      from (select plate from public.tankers where registry_owner_id = o.id and not on_platform order by plate limit 3) k;
    if plates is null then s_claimed := s_claimed + 1; continue; end if;
    t := public.fill_template(case when lang = 'ar' then tpl.title_ar else tpl.title_en end, jsonb_build_object('plates', plates, 'link', link));
    b := public.fill_template(case when lang = 'ar' then tpl.body_ar else tpl.body_en end, jsonb_build_object('plates', plates, 'link', link, 'name', o.name));
    slot := q / per_min;
    insert into public.notification_outbox (user_id, event, channel, lang, destination, destination_masked, title, body, next_attempt_at)
    values (null, 'registry_invite', 'sms', lang, o.phone, public.mask_phone(o.phone), t, b, last_queue + make_interval(mins => slot));
    update public.registry_owners set invited_at = now(), invite_count = invite_count + 1, updated_at = now() where id = o.id;
    q := q + 1;
  end loop;

  perform public.write_audit('register.invite', 'registry_owners', coalesce(p_batch_id::text, 'selection'), null,
                             jsonb_build_object('queued', q, 'considered', considered, 'lang', lang, 'owners', coalesce(cardinality(p_owner_ids), 0),
                                                'batch', p_batch_id, 'filter', p_filter), p_reason);
  return jsonb_build_object('queued', q, 'considered', considered, 'daily_left', greatest(room - q, 0),
                            'skipped', jsonb_build_object('no_phone', s_phone, 'opted_out', s_opt, 'registered', s_claimed, 'max_invites', s_max,
                                                          'cooldown', s_cool, 'sms_off', s_consent, 'daily_cap', s_cap),
                            'minutes', ceil(q::numeric / per_min));
end $$;

create function public.staff_registry_owner_opt_out(p_owner_id uuid, p_opt_out boolean, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b public.registry_owners;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into b from public.registry_owners where id = p_owner_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.registry_owners set sms_opt_out = coalesce(p_opt_out, true), opted_out_at = case when coalesce(p_opt_out, true) then now() end, updated_at = now()
   where id = b.id;
  -- Invitations still waiting in the outbox for this number are withdrawn.
  if coalesce(p_opt_out, true) and b.phone is not null then
    update public.notification_outbox set status = 'failed', error = 'Owner opted out'
     where event = 'registry_invite' and destination = b.phone and status = 'queued';
  end if;
  perform public.write_audit(case when coalesce(p_opt_out, true) then 'register.opt_out' else 'register.opt_in' end, 'registry_owner', b.id::text,
                             jsonb_build_object('sms_opt_out', b.sms_opt_out), jsonb_build_object('sms_opt_out', coalesce(p_opt_out, true)), p_reason);
  return jsonb_build_object('id', b.id, 'sms_opt_out', coalesce(p_opt_out, true));
end $$;

-- ===========================================================================
-- Reports → Clusters
-- ===========================================================================
create function public.report_clusters(p_days integer default 30, p_cluster text default null, p_governorate text default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_since timestamptz := public.report_since(p_days); out jsonb;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  with g as (
    select g.code, g.name, g.cluster_code, g.sort from public.governorates g
     where (nullif(p_cluster, '') is null or g.cluster_code = p_cluster or (p_cluster = 'none' and g.cluster_code is null))
       and (nullif(p_governorate, '') is null or g.code = p_governorate)),
  tk as (
    select t.governorate_code as code,
           count(*) filter (where t.in_register) as in_register,
           count(*) filter (where t.on_platform) as on_platform,
           count(*) filter (where t.in_register and t.on_platform) as register_on_platform,
           count(*) filter (where t.is_online) as online,
           count(*) filter (where public.tanker_has_valid_permit(t.id)) as permitted,
           count(*) filter (where exists (select 1 from public.permits p where p.tanker_id = t.id and p.status = 'pending')) as pending
      from public.tankers t where t.governorate_code in (select code from g) group by 1),
  od as (
    select z.governorate_code as code,
           count(*) as placed,
           count(*) filter (where o.status = 'delivered') as delivered,
           count(*) filter (where o.status = 'cancelled') as cancelled,
           count(*) filter (where o.status = 'delivered' and public.sla_state(o) = 'on_time') as on_time,
           count(*) filter (where o.status = 'delivered' and public.sla_state(o) in ('on_time', 'late')) as timed,
           coalesce(sum(o.gallons) filter (where o.status = 'delivered'), 0) as gallons
      from public.orders o join public.zones z on z.id = o.zone_id
     where not o.is_test and o.created_at >= v_since and z.governorate_code in (select code from g) group by 1),
  rows as (
    select g.code, g.name, g.cluster_code, g.sort,
           coalesce(tk.in_register, 0) as in_register, coalesce(tk.on_platform, 0) as on_platform, coalesce(tk.register_on_platform, 0) as register_on_platform,
           coalesce(tk.online, 0) as online, coalesce(tk.permitted, 0) as permitted, coalesce(tk.pending, 0) as pending,
           coalesce(od.placed, 0) as placed, coalesce(od.delivered, 0) as delivered, coalesce(od.cancelled, 0) as cancelled,
           coalesce(od.on_time, 0) as on_time, coalesce(od.timed, 0) as timed, coalesce(od.gallons, 0) as gallons
      from g left join tk on tk.code = g.code left join od on od.code = g.code)
  select jsonb_build_object(
    'since', v_since,
    'by_governorate', coalesce((select jsonb_agg(to_jsonb(r) - 'sort' order by r.sort) from rows r), '[]'::jsonb),
    'by_cluster', coalesce((select jsonb_agg(x order by x ->> 'cluster_code' nulls last) from (
        select jsonb_build_object('cluster_code', r.cluster_code, 'name', coalesce(c.name, 'No cluster'),
               'governorates', count(*), 'in_register', sum(r.in_register), 'on_platform', sum(r.on_platform), 'register_on_platform', sum(r.register_on_platform),
               'online', sum(r.online), 'permitted', sum(r.permitted), 'pending', sum(r.pending), 'placed', sum(r.placed), 'delivered', sum(r.delivered),
               'cancelled', sum(r.cancelled), 'on_time', sum(r.on_time), 'timed', sum(r.timed), 'gallons', sum(r.gallons)) as x
          from rows r left join public.clusters c on c.code = r.cluster_code group by r.cluster_code, c.name) s), '[]'::jsonb),
    -- Tankers with no governorate (registered in an app, not in the register yet).
    'unassigned', jsonb_build_object('on_platform', (select count(*) from public.tankers where governorate_code is null and on_platform),
                                     'online', (select count(*) from public.tankers where governorate_code is null and is_online)),
    -- Orders in zones without a governorate code (test zone excluded).
    'orders_unmapped', (select count(*) from public.orders o left join public.zones z on z.id = o.zone_id
                         where not o.is_test and o.created_at >= v_since and z.governorate_code is null))
    into out;
  return out;
end $$;

-- ===========================================================================
-- Indexes for the campaign queries and the outbox throttle
-- ===========================================================================
create index notification_outbox_event_idx on public.notification_outbox (event, created_at desc);
create index permits_pending_tanker_idx on public.permits (tanker_id) where status = 'pending';

-- ===========================================================================
-- Access
-- ===========================================================================
revoke execute on function public.register_status_rows(),
  public.register_row_matches(jsonb, text, text, public.service_type, text, boolean, boolean, boolean, timestamptz, boolean, text, text, text, timestamptz, boolean, uuid)
  from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_register_tankers(jsonb, integer, integer)', 'report_permit_campaign(jsonb)',
    'staff_invite_registry_owners(uuid[], uuid, jsonb, text, integer, text)', 'staff_registry_owner_opt_out(uuid, boolean, text)',
    'report_clusters(integer, text, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
