-- Money and price integrity, part 2 of 3: what the platform charges the fleet, and the
-- customer's "driver asked for more money" button.
--
--   #46 platform_fees        the tender's platform fees, editable in NWS → Settings → Pricing
--                            (admin and finance, audited): a monthly subscription per owner
--                            account, a one-off registration fee per tanker, a per-trip fee per
--                            service (DW, WW, TE) and a cancellation fee. No amounts are invented:
--                            every fee starts at 0 OMR with the status "to be quoted in the bid".
--       platform_fee_ledger  each fee as it accrues, with the amount and status in force then:
--                            per-trip fees when a (non-test) order is delivered, cancellation fees
--                            on chargeable cancellations (a cancellation fee was kept), the
--                            registration fee when a tanker is registered on the platform, and
--                            subscriptions monthly for every active tanker company (pg_cron, the
--                            1st of each month; recorded in cron_wanted by nama_schedule and
--                            scheduled by scripts/schedule-cron.mjs after db:apply). Idempotent by
--                            dedupe key. Reports: staff_platform_fee_report (NWS → Reports) and
--                            owner_platform_fees (company portal → Finance: fees owed).
--   #2  overcharge           report_overcharge: a customer reports, on an active order or within
--                            72 h of delivery, that the driver asked for more money (optional
--                            amount and note). It opens a complaint of the new category
--                            "overcharge" with high priority (12 h SLA, Fleet compliance), raises
--                            a high alert on the tanker and a fraud flag on the driver (scored
--                            higher on repeats). The matching penalty rule driver_overcharge is
--                            added switched off at 0 OMR for NWS to set (Settings → Penalties).

-- ===========================================================================
-- #46 platform fees
-- ===========================================================================
create table public.platform_fees (
  fee_key      text primary key check (fee_key in ('owner_subscription', 'tanker_registration', 'trip_dw', 'trip_ww', 'trip_te', 'cancellation')),
  kind         text not null check (kind in ('subscription', 'registration', 'trip', 'cancellation')),
  service_type public.service_type,
  amount_omr   numeric(10,3) not null default 0 check (amount_omr >= 0 and amount_omr <= 10000),
  status       text not null default 'to_be_quoted' check (status in ('to_be_quoted', 'pending_clarification', 'confirmed')),
  notes        text not null default '' check (char_length(notes) <= 500),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id) on delete set null
);

insert into public.platform_fees (fee_key, kind, service_type, notes) values
  ('owner_subscription',  'subscription', null, 'Monthly subscription per tanker-owner account. To be quoted in the bid.'),
  ('tanker_registration', 'registration', null, 'One-off registration fee per tanker registered on the platform. To be quoted in the bid.'),
  ('trip_dw',             'trip',         'DW', 'Per-trip fee, drinking water, charged on delivery. To be quoted in the bid.'),
  ('trip_ww',             'trip',         'WW', 'Per-trip fee, wastewater, charged on completion. To be quoted in the bid.'),
  ('trip_te',             'trip',         'TE', 'Per-trip fee, treated effluent, charged on delivery. To be quoted in the bid.'),
  ('cancellation',        'cancellation', null, 'Platform fee per chargeable cancellation (a cancellation fee was kept). To be quoted in the bid.');

create table public.platform_fee_ledger (
  id           bigint generated always as identity primary key,
  fee_key      text not null references public.platform_fees (fee_key),
  company_id   uuid references public.companies (id) on delete set null,
  driver_id    uuid references public.profiles (id) on delete set null,
  tanker_id    uuid references public.tankers (id) on delete set null,
  order_id     uuid references public.orders (id) on delete set null,
  period_month date,
  amount_omr   numeric(10,3) not null check (amount_omr >= 0),
  fee_status   text not null,
  dedupe_key   text not null unique,
  accrued_at   timestamptz not null default now()
);
create index platform_fee_ledger_company_idx on public.platform_fee_ledger (company_id, accrued_at desc);
create index platform_fee_ledger_at_idx on public.platform_fee_ledger (accrued_at desc);

alter table public.platform_fees enable row level security;
alter table public.platform_fee_ledger enable row level security;
revoke all on public.platform_fees, public.platform_fee_ledger from anon, authenticated;
grant select on public.platform_fees, public.platform_fee_ledger to authenticated;
create policy platform_fees_read on public.platform_fees for select to authenticated using (true);
create policy platform_fee_ledger_staff on public.platform_fee_ledger for select to authenticated using (public.is_staff());
create policy platform_fee_ledger_owner on public.platform_fee_ledger for select to authenticated using (
  company_id is not null and company_id = public.my_company_id()
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner'));
create policy platform_fee_ledger_driver on public.platform_fee_ledger for select to authenticated using (company_id is null and driver_id = auth.uid());

-- Record one fee at today's amount and status; a second call with the same key is a no-op.
create function public.accrue_platform_fee(p_key text, p_company uuid, p_driver uuid, p_tanker uuid, p_order uuid, p_month date, p_dedupe text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare f public.platform_fees; n integer;
begin
  select * into f from public.platform_fees where fee_key = p_key;
  if not found then return false; end if;
  insert into public.platform_fee_ledger (fee_key, company_id, driver_id, tanker_id, order_id, period_month, amount_omr, fee_status, dedupe_key)
  values (p_key, p_company, p_driver, p_tanker, p_order, p_month, f.amount_omr, f.status, p_dedupe)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Per-trip fee on delivery, cancellation fee on a chargeable cancellation.
create function public.orders_platform_fees()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.is_test then return new; end if;
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    perform public.accrue_platform_fee('trip_' || lower(new.service_type::text), public.tanker_company(new.tanker_id), new.driver_id, new.tanker_id,
                                       new.id, null, 'trip:' || new.id);
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' and coalesce(new.cancel_fee, 0) > 0 then
    perform public.accrue_platform_fee('cancellation', public.tanker_company(new.tanker_id), new.driver_id, new.tanker_id,
                                       new.id, null, 'cancel:' || new.id);
  end if;
  return new;
end $$;
create trigger orders_platform_fees after update of status on public.orders
  for each row execute function public.orders_platform_fees();

-- Registration fee when a tanker joins the platform (registered, or adopted from the NWS register).
create function public.tankers_platform_fee()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.on_platform and (tg_op = 'INSERT' or not old.on_platform) then
    perform public.accrue_platform_fee('tanker_registration', new.company_id, null, new.id, null, null, 'reg:' || new.id);
  end if;
  return new;
end $$;
create trigger tankers_platform_fee after insert or update of on_platform on public.tankers
  for each row execute function public.tankers_platform_fee();

-- Monthly subscriptions: one per active tanker company with an owner account, per Muscat month.
create function public.accrue_platform_subscriptions(p_month date default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare m date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Muscat')::date))::date; n integer := 0; c record;
begin
  if auth.uid() is not null then perform public.require_staff(array['finance']::public.staff_role[]); end if;
  for c in select co.id from public.companies co
            where co.status = 'active' and exists (select 1 from public.profiles p where p.company_id = co.id and p.role = 'owner') loop
    if public.accrue_platform_fee('owner_subscription', c.id, null, null, null, m, 'sub:' || c.id || ':' || to_char(m, 'YYYY-MM')) then n := n + 1; end if;
  end loop;
  return n;
end $$;

create function public.staff_update_platform_fee(p_key text, p_amount numeric, p_status text, p_notes text, p_reason text)
returns public.platform_fees
language plpgsql security definer set search_path = public
as $$
declare b public.platform_fees; a public.platform_fees; r text; amt numeric := round(coalesce(p_amount, -1), 3);
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.platform_fees where fee_key = p_key for update;
  if not found then raise exception 'not_found'; end if;
  if amt < 0 or amt > 10000 then raise exception 'invalid_value: amount must be 0–10,000 OMR'; end if;
  if coalesce(p_status, '') not in ('to_be_quoted', 'pending_clarification', 'confirmed') then raise exception 'invalid_value'; end if;
  update public.platform_fees
     set amount_omr = amt, status = p_status, notes = coalesce(left(btrim(p_notes), 500), notes), updated_at = now(), updated_by = auth.uid()
   where fee_key = p_key returning * into a;
  perform public.write_audit('pricing.platform_fee_update', 'platform_fee', p_key, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- Accrued fees by Muscat month and fee (count and amount), for NWS.
create function public.staff_platform_fee_report(p_months integer default 12)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_since date := (date_trunc('month', (now() at time zone 'Asia/Muscat')::date) - make_interval(months => greatest(least(coalesce(p_months, 12), 36), 1) - 1))::date;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return jsonb_build_object(
    'since', v_since,
    'fees', (select jsonb_agg(to_jsonb(f) order by f.fee_key) from public.platform_fees f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'fee_key', fee_key, 'n', n, 'amount', amt) order by m desc, fee_key)
                        from (select to_char(coalesce(period_month, (accrued_at at time zone 'Asia/Muscat')::date), 'YYYY-MM') as m, fee_key,
                                     count(*) as n, sum(amount_omr) as amt
                                from public.platform_fee_ledger
                               where coalesce(period_month, (accrued_at at time zone 'Asia/Muscat')::date) >= v_since
                               group by 1, 2) x), '[]'::jsonb),
    'total', (select coalesce(sum(amount_omr), 0) from public.platform_fee_ledger
               where coalesce(period_month, (accrued_at at time zone 'Asia/Muscat')::date) >= v_since),
    'by_company', coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'company', name, 'n', n, 'amount', amt) order by amt desc, n desc)
                              from (select l.company_id, coalesce(c.name, 'Independent drivers') as name, count(*) as n, sum(l.amount_omr) as amt
                                      from public.platform_fee_ledger l left join public.companies c on c.id = l.company_id
                                     where coalesce(l.period_month, (l.accrued_at at time zone 'Asia/Muscat')::date) >= v_since
                                     group by 1, 2) y), '[]'::jsonb));
end $$;

-- The same, for the caller's own company (owner portal → Finance).
create function public.owner_platform_fees(p_months integer default 6)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare co uuid := public.my_company_id();
  v_since date := (date_trunc('month', (now() at time zone 'Asia/Muscat')::date) - make_interval(months => greatest(least(coalesce(p_months, 6), 36), 1) - 1))::date;
begin
  if co is null or public.my_role() is distinct from 'owner' then raise exception 'forbidden_for_role'; end if;
  return jsonb_build_object(
    'since', v_since,
    'fees', (select jsonb_agg(jsonb_build_object('fee_key', f.fee_key, 'kind', f.kind, 'service_type', f.service_type, 'amount_omr', f.amount_omr, 'status', f.status) order by f.fee_key)
               from public.platform_fees f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'fee_key', fee_key, 'n', n, 'amount', amt) order by m desc, fee_key)
                        from (select to_char(coalesce(period_month, (accrued_at at time zone 'Asia/Muscat')::date), 'YYYY-MM') as m, fee_key,
                                     count(*) as n, sum(amount_omr) as amt
                                from public.platform_fee_ledger
                               where company_id = co and coalesce(period_month, (accrued_at at time zone 'Asia/Muscat')::date) >= v_since
                               group by 1, 2) x), '[]'::jsonb),
    'owed', (select coalesce(sum(amount_omr), 0) from public.platform_fee_ledger where company_id = co));
end $$;

-- 1st of each month, 04:05 Muscat (00:05 UTC).
select public.nama_schedule('nama-platform-subscriptions', '5 0 1 * *', 'select public.accrue_platform_subscriptions()');

-- ===========================================================================
-- #2 "Driver asked for more money"
-- ===========================================================================
insert into public.complaint_sla (category, label, hours, team) values
  ('overcharge', 'Driver asked for more money', 12, 'Fleet compliance')
on conflict (category) do nothing;

alter table public.complaints
  add column if not exists priority text not null default 'normal' check (priority in ('high', 'normal')),
  add column if not exists demanded_omr numeric(10,3) check (demanded_omr is null or (demanded_omr > 0 and demanded_omr <= 1000));
create index if not exists complaints_priority_idx on public.complaints (priority, due_at) where state <> 'resolved';

insert into public.penalty_rules (code, label, party, amount, amount_kind, compensation, active) values
  ('driver_overcharge', 'Driver asked the customer for more than the app price', 'driver', 0, 'omr', 'Any extra the customer paid is refunded', false)
on conflict (code) do nothing;

create function public.report_overcharge(p_order_id uuid, p_amount numeric default null, p_note text default null)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare o public.orders; tk public.tankers; c public.complaints; s public.complaint_sla; amt numeric := round(p_amount, 3);
  note text := nullif(left(btrim(coalesce(p_note, '')), 1000), ''); prior integer; descr text;
begin
  if public.my_role() is distinct from 'customer' then raise exception 'forbidden_for_role'; end if;
  select * into o from public.orders where id = p_order_id and customer_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.tanker_id is null
     or not (o.status in ('accepted', 'arriving', 'arrived', 'collected') or (o.status = 'delivered' and o.delivered_at > now() - interval '72 hours')) then
    raise exception 'cannot_report: only an active order, or one delivered in the last 72 hours';
  end if;
  if amt is not null and (amt <= 0 or amt > 1000) then raise exception 'invalid_amount'; end if;
  if exists (select 1 from public.complaints where order_id = o.id and category = 'overcharge') then raise exception 'already_reported'; end if;
  select * into s from public.complaint_sla where category = 'overcharge';
  select * into tk from public.tankers where id = o.tanker_id;

  descr := 'The driver asked for more money than the app price'
           || case when amt is not null then ' (' || to_char(amt, 'FM9990.000') || ' OMR demanded)' else '' end || '.'
           || case when note is not null then ' ' || note else '' end;
  insert into public.complaints (order_id, customer_id, category, description, channel, owner_team, sla_hours, due_at, priority, demanded_omr)
  values (o.id, auth.uid(), 'overcharge', descr, 'app', s.team, s.hours, now() + make_interval(hours => s.hours), 'high', amt)
  returning * into c;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body) values (c.id, auth.uid(), 'customer', descr);

  perform public.raise_alert(o.tanker_id, o.id, 'Overcharge reported', 'high',
    format('%s: customer on TO-%s reports the driver asked for %s', coalesce(tk.plate, o.tanker_plate, 'tanker'), o.order_no,
           case when amt is not null then to_char(amt, 'FM9990.000') || ' OMR' else 'more money' end),
    tk.last_lat, tk.last_lng, 'overcharge:' || o.id);

  if o.driver_id is not null then
    select count(*) into prior from public.complaints k join public.orders x on x.id = k.order_id
     where k.category = 'overcharge' and x.driver_id = o.driver_id and k.id <> c.id and k.created_at > now() - interval '90 days';
    insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key)
    values ('Driver asked for more money', 'driver', o.driver_id::text,
            format('TO-%s (%s): %s%s', o.order_no, coalesce(o.driver_name, 'driver'),
                   case when amt is not null then to_char(amt, 'FM9990.000') || ' OMR demanded' else 'extra payment demanded' end,
                   case when prior > 0 then format('; %s earlier report(s) in 90 days', prior) else '' end),
            case when prior >= 2 then 95 when prior = 1 then 85 else 70 end, 'overcharge:' || o.id)
    on conflict (dedupe_key) do nothing;
  end if;

  perform public.notify(auth.uid(), 'complaint_update', o.id, jsonb_build_object('case', 'C-' || c.case_no, 'status', 'received', 'status_ar', 'قيد المراجعة'));
  return c;
end $$;

-- The generic complaint form lists every category: an "overcharge" picked there takes the same
-- path (priority, alert, fraud flag). The rest is the 0012 body.
create or replace function public.file_complaint(p_order_id uuid, p_category text, p_description text, p_photo_path text default null)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare s public.complaint_sla; c public.complaints; r public.user_role := public.my_role();
begin
  if r not in ('customer', 'business') then raise exception 'forbidden_for_role'; end if;
  if p_category = 'overcharge' and r = 'customer' then
    if p_order_id is null then raise exception 'cannot_report: choose the order the driver asked more money for'; end if;
    c := public.report_overcharge(p_order_id, null, p_description);
    if p_photo_path is not null then update public.complaints set photo_path = p_photo_path where id = c.id returning * into c; end if;
    return c;
  end if;
  select * into s from public.complaint_sla where category = p_category;
  if not found then raise exception 'invalid_category'; end if;
  if p_order_id is not null and not public.can_see_order(p_order_id) then raise exception 'not_found'; end if;
  insert into public.complaints (order_id, customer_id, category, description, photo_path, channel, owner_team, sla_hours, due_at)
  values (p_order_id, auth.uid(), p_category, btrim(p_description), p_photo_path, case when r = 'business' then 'business' else 'app' end,
          s.team, s.hours, now() + make_interval(hours => s.hours))
  returning * into c;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body) values (c.id, auth.uid(), r::text, btrim(p_description));
  perform public.notify(auth.uid(), 'complaint_update', p_order_id, jsonb_build_object('case', 'C-' || c.case_no, 'status', 'received', 'status_ar', 'قيد المراجعة'));
  return c;
end $$;

-- Overcharge reports per driver (fraud and driver metrics): count and last report.
create function public.staff_overcharge_by_driver(p_days integer default 90)
returns table (driver_id uuid, driver_name text, reports bigint, demanded numeric, last_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select o.driver_id, max(o.driver_name), count(*), coalesce(sum(k.demanded_omr), 0), max(k.created_at)
      from public.complaints k join public.orders o on o.id = k.order_id
     where k.category = 'overcharge' and o.driver_id is not null and k.created_at > now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
     group by o.driver_id
     order by 3 desc, 5 desc;
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function
  public.accrue_platform_fee(text, uuid, uuid, uuid, uuid, date, text),
  public.orders_platform_fees(), public.tankers_platform_fee()
from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'accrue_platform_subscriptions(date)',
    'staff_update_platform_fee(text, numeric, text, text, text)',
    'staff_platform_fee_report(integer)',
    'owner_platform_fees(integer)',
    'report_overcharge(uuid, numeric, text)',
    'staff_overcharge_by_driver(integer)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
