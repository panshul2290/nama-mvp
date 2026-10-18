-- NWS staff portal: staff sub-roles, tanker blocks, permits, append-only audit log.
--
--   * profiles.role = 'nws_staff' with staff_role operator | permit_officer | admin.
--     Sign-up can never produce staff (handle_new_user maps anything but
--     'driver' to 'customer'); only an admin (staff_set_role) or the seed script
--     assigns it, and nobody can change their own role.
--   * Staff read everything; every staff write is a SECURITY DEFINER RPC that
--     checks the sub-role and writes exactly one audit_log row.
--     Sub-roles are strict: operator = blocks + driver assignment override;
--     permit_officer = permits; admin = staff roles.
--   * A tanker can go online / accept jobs only if it isn't blocked and has an
--     approved, unexpired permit for its own service type (enforced here, in the
--     online trigger and in accept_order / open_requests_near).

create type public.staff_role as enum ('operator', 'permit_officer', 'admin');
create type public.permit_status as enum ('pending', 'approved', 'rejected', 'expired');

alter table public.profiles add column staff_role public.staff_role;
alter table public.profiles add constraint profiles_staff_role_matches check ((role = 'nws_staff') = (staff_role is not null));

alter table public.tankers
  add column blocked        boolean not null default false,
  add column blocked_reason text,
  add column blocked_at     timestamptz,
  add column blocked_by     uuid references public.profiles (id) on delete set null;

create table public.permits (
  id          uuid primary key default gen_random_uuid(),
  tanker_id   uuid not null references public.tankers (id) on delete cascade,
  permit_no   text not null unique check (char_length(btrim(permit_no)) between 3 and 40),
  type        public.service_type not null,
  issued_at   timestamptz not null,
  expires_at  timestamptz not null,
  status      public.permit_status not null default 'pending',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  reason      text,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (expires_at > issued_at)
);
create index permits_tanker_idx on public.permits (tanker_id, expires_at desc);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  actor_role  text,
  action      text not null,
  target_type text not null,
  target_id   text not null,
  before      jsonb,
  after       jsonb,
  reason      text
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_target_idx on public.audit_log (target_type, target_id);

-- Append-only, for everyone (the trigger also stops the table owner).
create function public.audit_log_append_only()
returns trigger language plpgsql
as $$ begin raise exception 'audit_log_append_only'; end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.my_staff_role()
returns public.staff_role
language sql stable security definer set search_path = public
as $$ select staff_role from public.profiles where id = auth.uid() and role = 'nws_staff' $$;

-- Raise unless the caller is staff with one of the given sub-roles.
create function public.require_staff(p_roles public.staff_role[])
returns public.staff_role
language plpgsql stable security definer set search_path = public
as $$
declare r public.staff_role := public.my_staff_role();
begin
  if r is null then raise exception 'not_staff'; end if;
  if not (r = any(p_roles)) then raise exception 'forbidden_for_role: % cannot do this', r; end if;
  return r;
end $$;

create function public.write_audit(p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql security definer set search_path = public
as $$
  insert into public.audit_log (actor_id, actor_email, actor_role, action, target_type, target_id, before, after, reason)
  select auth.uid(), (select email from auth.users where id = auth.uid()), public.my_staff_role()::text,
         p_action, p_target_type, p_target_id, p_before, p_after, nullif(btrim(coalesce(p_reason, '')), '')
$$;

create function public.require_reason(p_reason text)
returns text language plpgsql immutable
as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) < 3 then raise exception 'reason_required'; end if;
  return btrim(p_reason);
end $$;

-- Permit validity: approved, unexpired, and for the tanker's own service type.
create function public.tanker_has_valid_permit(p_tanker uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.permits p join public.tankers t on t.id = p.tanker_id
     where p.tanker_id = p_tanker and p.status = 'approved' and p.expires_at > now() and p.type = t.service_type)
$$;

-- Effective status for display: an approved permit past its expiry reads 'expired'.
create function public.effective_status(p public.permits)
returns public.permit_status language sql stable
as $$ select case when p.status = 'approved' and p.expires_at <= now() then 'expired'::public.permit_status else p.status end $$;

create function public.tanker_json(t public.tankers)
returns jsonb language sql stable
as $$ select jsonb_build_object('plate', t.plate, 'is_online', t.is_online, 'blocked', t.blocked, 'blocked_reason', t.blocked_reason) $$;

-- ---------------------------------------------------------------------------
-- Enforcement: blocked or unpermitted tankers can't go online or take jobs
-- ---------------------------------------------------------------------------
create function public.tanker_online_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.is_online and (tg_op = 'INSERT' or not old.is_online) then
    if new.blocked then raise exception 'tanker_blocked: %', coalesce(new.blocked_reason, 'blocked by NWS'); end if;
    if not public.tanker_has_valid_permit(new.id) then raise exception 'permit_invalid'; end if;
  end if;
  return new;
end $$;

create trigger tankers_online_guard before insert or update of is_online on public.tankers
  for each row execute function public.tanker_online_guard();

-- Tankers that are online without a valid permit go offline now.
update public.tankers set is_online = false where is_online and (blocked or not public.tanker_has_valid_permit(id));

create or replace function public.open_requests_near(p_lat double precision, p_lng double precision)
returns table (
  id              uuid,
  order_no        bigint,
  service_type    public.service_type,
  gallons         integer,
  area            text,
  distance_km     numeric,
  driver_earnings numeric(10,3),
  earnings_status text,
  created_at      timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare t public.tankers;
begin
  t := public.my_tanker();
  if not t.is_online or t.blocked or not public.tanker_has_valid_permit(t.id) then return; end if;

  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
           round((6371 * 2 * asin(sqrt(
             power(sin(radians(l.lat - p_lat) / 2), 2) +
             cos(radians(p_lat)) * cos(radians(l.lat)) *
             power(sin(radians(l.lng - p_lng) / 2), 2))))::numeric, 1) as distance_km,
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at
      from public.orders o
      join public.order_locations l on l.order_id = o.id
     where o.status = 'requested'
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
     order by 6, o.created_at
     limit 50;
end $$;

create or replace function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare
  t public.tankers;
  o public.orders;
  v_name text;
begin
  t := public.my_tanker();
  if t.blocked then raise exception 'tanker_blocked: %', coalesce(t.blocked_reason, 'blocked by NWS'); end if;
  if not public.tanker_has_valid_permit(t.id) then raise exception 'permit_invalid'; end if;
  if not t.is_online then raise exception 'driver_offline'; end if;

  if exists (select 1 from public.orders
             where (driver_id = auth.uid() or tanker_id = t.id) and status in ('accepted', 'arriving', 'arrived')) then
    raise exception 'driver_busy';
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  begin
    update public.orders
       set status = 'accepted',
           driver_id = auth.uid(),
           tanker_id = t.id,
           accepted_at = now(),
           driver_name = nullif(v_name, ''),
           tanker_plate = t.plate
     where id = p_order_id
       and status = 'requested'
       and service_type = t.service_type
       and gallons <= t.capacity_gal
    returning * into o;
  exception when unique_violation then
    raise exception 'driver_busy';
  end;

  if not found then
    if exists (select 1 from public.orders where id = p_order_id and status = 'requested') then
      raise exception 'not_eligible';
    end if;
    raise exception 'already_taken';
  end if;
  return o;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: staff read everything; drivers read their own tanker's permits
-- ---------------------------------------------------------------------------
alter table public.permits   enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.permits, public.audit_log from anon, authenticated;
grant select on public.permits, public.audit_log to authenticated;

create policy profiles_staff_select          on public.profiles           for select to authenticated using (public.my_staff_role() is not null);
create policy tankers_staff_select           on public.tankers            for select to authenticated using (public.my_staff_role() is not null);
create policy tanker_assignments_staff_select on public.tanker_assignments for select to authenticated using (public.my_staff_role() is not null);
create policy orders_staff_select            on public.orders             for select to authenticated using (public.my_staff_role() is not null);
create policy order_locations_staff_select   on public.order_locations    for select to authenticated using (public.my_staff_role() is not null);
create policy permits_staff_select           on public.permits            for select to authenticated using (public.my_staff_role() is not null);
create policy permits_driver_select          on public.permits            for select to authenticated using (tanker_id = public.my_tanker_id());
create policy audit_log_staff_select         on public.audit_log          for select to authenticated using (public.my_staff_role() is not null);

-- ---------------------------------------------------------------------------
-- Staff RPCs (each checks the sub-role and writes exactly one audit row)
-- ---------------------------------------------------------------------------

-- operator: block / unblock a tanker. Blocking also takes it offline.
create function public.staff_block_tanker(p_tanker_id uuid, p_reason text)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare b public.tankers; a public.tankers; r text;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.tankers where id = p_tanker_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.blocked then raise exception 'already_blocked'; end if;
  update public.tankers set blocked = true, blocked_reason = r, blocked_at = now(), blocked_by = auth.uid(), is_online = false
   where id = p_tanker_id returning * into a;
  perform public.write_audit('tanker.block', 'tanker', a.id::text, public.tanker_json(b), public.tanker_json(a), r);
  return a;
end $$;

create function public.staff_unblock_tanker(p_tanker_id uuid, p_reason text)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare b public.tankers; a public.tankers; r text;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.tankers where id = p_tanker_id for update;
  if not found then raise exception 'not_found'; end if;
  if not b.blocked then raise exception 'not_blocked'; end if;
  update public.tankers set blocked = false, blocked_reason = null, blocked_at = null, blocked_by = null
   where id = p_tanker_id returning * into a;
  perform public.write_audit('tanker.unblock', 'tanker', a.id::text, public.tanker_json(b), public.tanker_json(a), r);
  return a;
end $$;

-- operator: driver assignment override. (Assignment will move to the tanker
-- company portal; this stays as the NWS override.)
create function public.staff_assign_tanker(p_driver_id uuid, p_tanker_id uuid, p_reason text)
returns public.tanker_assignments
language plpgsql security definer set search_path = public
as $$
declare a public.tanker_assignments; r text;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if not exists (select 1 from public.profiles where id = p_driver_id and role = 'driver') then raise exception 'not_a_driver'; end if;
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
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

create function public.staff_unassign_tanker(p_tanker_id uuid, p_reason text)
returns public.tanker_assignments
language plpgsql security definer set search_path = public
as $$
declare a public.tanker_assignments; r text;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into a from public.tanker_assignments where tanker_id = p_tanker_id and unassigned_at is null for update;
  if not found then raise exception 'not_assigned'; end if;
  if exists (select 1 from public.orders where tanker_id = p_tanker_id and status in ('accepted', 'arriving', 'arrived')) then
    raise exception 'tanker_on_job';
  end if;
  update public.tanker_assignments set unassigned_at = now() where id = a.id returning * into a;
  update public.tankers set is_online = false where id = p_tanker_id;
  perform public.write_audit('tanker.unassign', 'tanker', p_tanker_id::text,
    jsonb_build_object('driver_id', a.driver_id, 'assignment_id', a.id), null, r);
  return a;
end $$;

-- permit_officer: create (pending), review, resubmit after rejection.
create function public.staff_create_permit(p_tanker_id uuid, p_permit_no text, p_type public.service_type, p_issued_at timestamptz, p_expires_at timestamptz)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare p public.permits;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
  if p_issued_at is null or p_expires_at is null or p_expires_at <= p_issued_at then raise exception 'invalid_dates'; end if;
  begin
    insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, created_by)
    values (p_tanker_id, upper(btrim(p_permit_no)), p_type, p_issued_at, p_expires_at, auth.uid()) returning * into p;
  exception when unique_violation then raise exception 'permit_no_taken';
  end;
  perform public.write_audit('permit.create', 'permit', p.id::text, null, to_jsonb(p), null);
  return p;
end $$;

create function public.staff_review_permit(p_permit_id uuid, p_decision text, p_reason text)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits; r text;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if p_decision not in ('approve', 'reject') then raise exception 'invalid_decision'; end if;
  r := case when p_decision = 'reject' then public.require_reason(p_reason) else nullif(btrim(coalesce(p_reason, '')), '') end;
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'pending' then raise exception 'invalid_state: only pending permits can be reviewed'; end if;
  update public.permits
     set status = case when p_decision = 'approve' then 'approved'::public.permit_status else 'rejected'::public.permit_status end,
         reviewed_by = auth.uid(), reviewed_at = now(), reason = r, updated_at = now()
   where id = p_permit_id returning * into a;
  perform public.write_audit('permit.' || p_decision, 'permit', a.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_resubmit_permit(p_permit_id uuid, p_expires_at timestamptz, p_reason text)
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
  update public.permits
     set status = 'pending', expires_at = coalesce(p_expires_at, expires_at),
         reviewed_by = null, reviewed_at = null, reason = null, updated_at = now()
   where id = p_permit_id returning * into a;
  perform public.write_audit('permit.resubmit', 'permit', a.id::text, to_jsonb(b), to_jsonb(a), p_reason);
  return a;
end $$;

-- admin: make a user staff (or remove it). Admins can't change their own role.
create function public.staff_set_role(p_user_id uuid, p_staff_role public.staff_role, p_reason text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare b public.profiles; a public.profiles; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_user_id = auth.uid() then raise exception 'cannot_change_own_role'; end if;
  select * into b from public.profiles where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.role = 'driver' then raise exception 'target_is_driver'; end if;
  update public.profiles
     set role = case when p_staff_role is null then 'customer'::public.user_role else 'nws_staff'::public.user_role end,
         staff_role = p_staff_role
   where id = p_user_id returning * into a;
  perform public.write_audit('staff.set_role', 'profile', a.id::text,
    jsonb_build_object('role', b.role, 'staff_role', b.staff_role), jsonb_build_object('role', a.role, 'staff_role', a.staff_role), r);
  return a;
end $$;

-- Execute rights: helpers are internal; staff RPCs are callable by signed-in users (they check the sub-role).
revoke execute on function
  public.my_staff_role(), public.require_staff(public.staff_role[]), public.write_audit(text, text, text, jsonb, jsonb, text),
  public.require_reason(text), public.tanker_has_valid_permit(uuid), public.effective_status(public.permits),
  public.tanker_json(public.tankers), public.audit_log_append_only(), public.tanker_online_guard(),
  public.staff_block_tanker(uuid, text), public.staff_unblock_tanker(uuid, text),
  public.staff_assign_tanker(uuid, uuid, text), public.staff_unassign_tanker(uuid, text),
  public.staff_create_permit(uuid, text, public.service_type, timestamptz, timestamptz),
  public.staff_review_permit(uuid, text, text), public.staff_resubmit_permit(uuid, timestamptz, text),
  public.staff_set_role(uuid, public.staff_role, text)
from public, anon, authenticated;

grant execute on function
  public.my_staff_role(), public.effective_status(public.permits), public.tanker_has_valid_permit(uuid),
  public.staff_block_tanker(uuid, text), public.staff_unblock_tanker(uuid, text),
  public.staff_assign_tanker(uuid, uuid, text), public.staff_unassign_tanker(uuid, text),
  public.staff_create_permit(uuid, text, public.service_type, timestamptz, timestamptz),
  public.staff_review_permit(uuid, text, text), public.staff_resubmit_permit(uuid, timestamptz, text),
  public.staff_set_role(uuid, public.staff_role, text)
to authenticated;

-- Live Operations listens for permit changes too.
alter publication supabase_realtime add table public.permits;
