-- Tender gaps, batch A (part 4 of 4):
--   H12  report aggregation moves into the database: report_operations, report_consumption
--        and report_feedback answer the NWS Reports tabs in one call each, over every row
--        (no browser caps or sums); a daily-orders materialised view, refreshed by pg_cron,
--        feeds long-range trends and the BI export.
--   F5   consumption trends per property (NWS Customers detail, the household's own
--        property) and per site (Business → Sites, honouring per-site access, 0027).
--   F8   feedback insights: ratings over time, by company and driver, the worst-rated
--        drivers, complaint categories and the reopen rate.
--   G11  GET /api/v1/reports/{dataset}: paged export for BI / a data warehouse.
-- Test-zone orders (is_test) never count. Days and weeks are Muscat days and weeks
-- (weeks start on Sunday).

-- Start of the Muscat day `p_days - 1` days ago (the first day of an N-day report).
create function public.report_since(p_days integer)
returns timestamptz language sql stable
as $$ select (date_trunc('day', now() at time zone 'Asia/Muscat') - make_interval(days => greatest(least(coalesce(p_days, 30), 3660), 1) - 1)) at time zone 'Asia/Muscat' $$;

create function public.muscat_day(p timestamptz)
returns date language sql immutable
as $$ select (p at time zone 'Asia/Muscat')::date $$;

-- Sunday of the Muscat week containing p.
create function public.muscat_week(p timestamptz)
returns date language sql immutable
as $$ select (p at time zone 'Asia/Muscat')::date - extract(dow from (p at time zone 'Asia/Muscat'))::integer $$;

-- ===========================================================================
-- H12 — Reports → Operations
-- ===========================================================================
create function public.report_operations(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_since timestamptz := public.report_since(p_days); out jsonb;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  with o as (select x.*, public.sla_state(x) as sla from public.orders x where not x.is_test and x.created_at >= v_since),
  d as (select * from o where status = 'delivered')
  select jsonb_build_object(
    'since', v_since,
    'placed', (select count(*) from o),
    'delivered', (select count(*) from d),
    'cancelled', (select count(*) from o where status = 'cancelled'),
    'on_time', (select count(*) from d where sla = 'on_time'),
    'timed', (select count(*) from d where sla in ('on_time', 'late')),
    'median_assign_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from accepted_at - coalesce(released_at, created_at)) / 60)::numeric, 1)
                            from o where accepted_at is not null and accepted_at >= coalesce(released_at, created_at)),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'service_type', service_type, 'n', n) order by day)
                           from (select public.muscat_day(coalesce(delivered_at, created_at)) as day, service_type, count(*) as n from d group by 1, 2) x), '[]'),
    'by_service', coalesce((select jsonb_object_agg(service_type, n) from (select service_type, count(*) as n from d group by 1) x), '{}'),
    'by_zone', coalesce((select jsonb_agg(jsonb_build_object('zone', coalesce(z.name, 'Outside service areas'), 'n', x.n, 'on_time', x.on_time, 'timed', x.timed) order by x.n desc)
                           from (select zone_id, count(*) as n, count(*) filter (where sla = 'on_time') as on_time, count(*) filter (where sla in ('on_time', 'late')) as timed
                                   from d group by 1) x left join public.zones z on z.id = x.zone_id), '[]'),
    'by_channel', coalesce((select jsonb_agg(jsonb_build_object('channel', channel, 'n', n) order by n desc) from (select channel, count(*) as n from o group by 1) x), '[]'),
    'year', (select jsonb_object_agg(s, (select count(*) from public.orders y where not y.is_test and y.service_type = s::public.service_type and y.status = 'delivered'
                                                                                and y.delivered_at >= now() - interval '365 days'))
               from unnest(array['DW', 'WW', 'TE']) s))
    into out;
  return out;
end $$;

-- ===========================================================================
-- H12 / F5 — Reports → Consumption and refill
-- ===========================================================================
create function public.report_consumption(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_since timestamptz := public.report_since(p_days); out jsonb; w0 date := public.muscat_week(now()) - 49;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  with d as (select * from public.orders x where not x.is_test and x.status = 'delivered' and x.created_at >= v_since),
  -- 180 days of drinking water drive the predictions, per property (or customer + area without one).
  h as (select coalesce(x.property_id::text, x.customer_id::text || '|' || x.area) as k, x.customer_id, x.property_id, x.area, x.gallons, x.delivered_at
          from public.orders x where not x.is_test and x.service_type = 'DW' and x.status = 'delivered' and x.delivered_at >= now() - interval '180 days'),
  p as (select k, min(customer_id::text)::uuid as customer_id, (array_agg(property_id))[1] as property_id, min(area) as area, count(*) as n,
               min(delivered_at) as first_at, max(delivered_at) as last_at,
               sum(gallons) filter (where delivered_at >= w0) / 8.0 as per_week,
               (select jsonb_agg(coalesce((select sum(h2.gallons) from h h2 where h2.k = h.k and public.muscat_week(h2.delivered_at) = w0 + 7 * g), 0) order by g)
                  from generate_series(0, 7) g) as weeks
          from h group by k having count(*) >= 2 and max(delivered_at) - min(delivered_at) >= (count(*) - 1) * interval '6 hours'),
  pr as (select p.*, extract(epoch from (last_at - first_at)) / (n - 1) / 86400 as avg_days,
                last_at + (last_at - first_at) / (n - 1) as next_at
           from p),
  pj as (select pr.*, extract(epoch from next_at - now()) / 86400 as due_in, pp.label, pp.tank_gal, c.full_name
           from pr left join public.properties pp on pp.id = pr.property_id left join public.profiles c on c.id = pr.customer_id)
  select jsonb_build_object(
    'since', v_since,
    'trips', (select count(*) from d),
    'gallons', (select coalesce(sum(gallons), 0) from d),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'gallons', g) order by g desc) from (select coalesce(nullif(area, ''), '—') as area, sum(gallons) as g from d group by 1 order by 2 desc limit 10) x), '[]'),
    'by_service', coalesce((select jsonb_object_agg(service_type, g) from (select service_type, sum(gallons) as g from d group by 1) x), '{}'),
    'segments', coalesce((select jsonb_object_agg(seg, n) from (select coalesce(segment, 'household') as seg, count(*) as n from public.profiles where role = 'customer' group by 1) x), '{}'),
    'top_consumers', coalesce((select jsonb_agg(jsonb_build_object('customer_id', x.customer_id, 'name', c.full_name, 'segment', c.segment, 'trips', x.n, 'gallons', x.g, 'omr', x.omr) order by x.g desc)
                                 from (select customer_id, count(*) as n, sum(gallons) as g, sum(total) as omr from d group by 1 order by 3 desc limit 10) x
                                 left join public.profiles c on c.id = x.customer_id), '[]'),
    'tracked', (select count(*) from pj),
    'alerts_count', (select count(*) from pj where due_in <= 3),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'customer_id', customer_id, 'name', full_name, 'property_id', property_id, 'label', label, 'area', area,
                                                            'avg_days', round(avg_days::numeric, 1), 'last_at', last_at, 'next_at', next_at, 'due_in', round(due_in::numeric, 1)) order by due_in)
                          from (select * from pj where due_in <= 3 order by due_in limit 50) x), '[]'),
    'top_properties', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'customer_id', customer_id, 'name', full_name, 'property_id', property_id, 'label', label, 'area', area,
                                                                    'tank_gal', tank_gal, 'per_week', round(coalesce(per_week, 0)), 'weeks', weeks, 'deliveries', n,
                                                                    'next_at', next_at, 'due_in', round(due_in::numeric, 1)) order by coalesce(per_week, 0) desc)
                                  from (select * from pj order by coalesce(per_week, 0) desc limit 25) x), '[]'))
    into out;
  return out;
end $$;

-- ===========================================================================
-- F8 — Reports → Feedback insights
-- ===========================================================================
create function public.report_feedback(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_since timestamptz := public.report_since(p_days); out jsonb;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  with r as (select x.*, coalesce(c.name, case when x.tanker_id is null then 'Not assigned' else 'Independent' end) as company
               from public.orders x left join public.tankers t on t.id = x.tanker_id left join public.companies c on c.id = t.company_id
              where not x.is_test and x.rating is not null and coalesce(x.rated_at, x.created_at) >= v_since),
  cx as (select k.* from public.complaints k left join public.orders o on o.id = k.order_id
          where k.created_at >= v_since and not coalesce(o.is_test, false)),
  reopened as (select distinct a.target_id from public.audit_log a where a.action = 'complaint.reopen' and a.at >= v_since)
  select jsonb_build_object(
    'since', v_since,
    'ratings', (select count(*) from r),
    'average', (select round(avg(rating)::numeric, 2) from r),
    'delivered', (select count(*) from public.orders x where not x.is_test and x.status = 'delivered' and x.created_at >= v_since),
    'distribution', jsonb_build_object('5', (select count(*) from r where rating = 5), '4', (select count(*) from r where rating = 4),
                                       '3', (select count(*) from r where rating = 3), '1-2', (select count(*) from r where rating <= 2)),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'n', n, 'average', a) order by day)
                           from (select public.muscat_day(coalesce(rated_at, created_at)) as day, count(*) as n, round(avg(rating)::numeric, 2) as a from r group by 1) x), '[]'),
    'per_week', coalesce((select jsonb_agg(jsonb_build_object('week', wk, 'n', n, 'average', a) order by wk)
                            from (select public.muscat_week(coalesce(rated_at, created_at)) as wk, count(*) as n, round(avg(rating)::numeric, 2) as a from r group by 1) x), '[]'),
    'by_company', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'n', n, 'average', a, 'low', low) order by a)
                              from (select company, count(*) as n, round(avg(rating)::numeric, 2) as a, count(*) filter (where rating <= 2) as low from r group by 1) x), '[]'),
    'worst_drivers', coalesce((select jsonb_agg(jsonb_build_object('driver_id', driver_id, 'name', name, 'company', company, 'n', n, 'average', a, 'low', low) order by a, n desc)
                                 from (select driver_id, max(driver_name) as name, max(company) as company, count(*) as n, round(avg(rating)::numeric, 2) as a,
                                              count(*) filter (where rating <= 2) as low
                                         from r where driver_id is not null group by 1 order by 5, 4 desc limit 10) x), '[]'),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'order_no', order_no, 'rating', rating, 'comment', rating_comment, 'driver', driver_name, 'area', area, 'rated_at', rated_at) order by rated_at desc)
                            from (select * from r where coalesce(btrim(rating_comment), '') <> '' order by rated_at desc nulls last limit 8) x), '[]'),
    'complaints', (select count(*) from cx),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', x.category, 'label', coalesce(s.label, x.category), 'n', x.n, 'open', x.open) order by x.n desc)
                               from (select category, count(*) as n, count(*) filter (where state <> 'resolved') as open from cx group by 1) x
                               left join public.complaint_sla s on s.category = x.category), '[]'),
    'resolved', (select count(*) from cx where state = 'resolved'),
    'reopened', (select count(*) from cx where id::text in (select target_id from reopened)),
    'reopen_rate', (select round(count(*) filter (where id::text in (select target_id from reopened))::numeric / nullif(count(*) filter (where state = 'resolved' or id::text in (select target_id from reopened)), 0), 3) from cx))
    into out;
  return out;
end $$;

-- ===========================================================================
-- F5 — consumption trend for one property (staff, its household, or the business members
-- allowed on that site)
-- ===========================================================================
create function public.property_trend(p_property uuid, p_weeks integer default 12)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare p public.properties; n integer := greatest(least(coalesce(p_weeks, 12), 104), 4); w0 date; out jsonb;
begin
  select * into p from public.properties where id = p_property;
  if not found or not (public.is_staff() or p.customer_id = auth.uid() or public.org_order_visible(p.org_id, p.id)) then raise exception 'not_found'; end if;
  w0 := public.muscat_week(now()) - 7 * (n - 1);
  with d as (select * from public.orders o where o.property_id = p.id and not o.is_test and o.status = 'delivered' and o.delivered_at >= w0::timestamp at time zone 'Asia/Muscat')
  select jsonb_build_object(
    'property_id', p.id, 'label', p.label, 'tank_gal', p.tank_gal,
    'weeks', (select jsonb_agg(jsonb_build_object('week', w0 + 7 * g,
                                                  'dw', coalesce((select sum(gallons) from d where service_type = 'DW' and public.muscat_week(delivered_at) = w0 + 7 * g), 0),
                                                  'te', coalesce((select sum(gallons) from d where service_type = 'TE' and public.muscat_week(delivered_at) = w0 + 7 * g), 0),
                                                  'ww', coalesce((select sum(gallons) from d where service_type = 'WW' and public.muscat_week(delivered_at) = w0 + 7 * g), 0),
                                                  'deliveries', (select count(*) from d where public.muscat_week(delivered_at) = w0 + 7 * g)) order by g)
                from generate_series(0, n - 1) g),
    'total_gal', (select coalesce(sum(gallons), 0) from d where service_type <> 'WW'),
    'deliveries', (select count(*) from d),
    'refill', (select jsonb_build_object('deliveries', r.deliveries, 'avg_gap_days', r.avg_gap_days, 'last_delivered_at', r.last_delivered_at, 'next_due_at', r.next_due_at)
                 from public.refill_predictions() r where r.property_id = p.id))
    into out;
  return out;
end $$;

-- Business → Sites: every site the member may see, with a weekly gallons series.
create function public.org_sites_trends(p_weeks integer default 12)
returns table (property_id uuid, label text, weeks jsonb, total_gal bigint, deliveries integer, avg_gap_days numeric, next_due_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
declare n integer := greatest(least(coalesce(p_weeks, 12), 52), 4); w0 date := public.muscat_week(now()) - 7 * (greatest(least(coalesce(p_weeks, 12), 52), 4) - 1);
begin
  if public.my_org_id() is null then raise exception 'forbidden_for_role'; end if;
  return query
    select p.id, p.label,
           (select jsonb_agg(coalesce((select sum(o.gallons) from public.orders o where o.property_id = p.id and not o.is_test and o.status = 'delivered'
                                         and o.service_type <> 'WW' and public.muscat_week(o.delivered_at) = w0 + 7 * g), 0) order by g)
              from generate_series(0, n - 1) g),
           (select coalesce(sum(o.gallons), 0)::bigint from public.orders o where o.property_id = p.id and not o.is_test and o.status = 'delivered' and o.service_type <> 'WW'
              and o.delivered_at >= w0::timestamp at time zone 'Asia/Muscat'),
           (select count(*)::int from public.orders o where o.property_id = p.id and not o.is_test and o.status = 'delivered' and o.delivered_at >= w0::timestamp at time zone 'Asia/Muscat'),
           r.avg_gap_days, r.next_due_at
      from public.properties p
      left join public.refill_predictions() r on r.property_id = p.id
     where p.org_id = public.my_org_id() and public.org_order_visible(p.org_id, p.id)
     order by p.label;
end $$;

-- ===========================================================================
-- H12 — daily orders materialised view (pg_cron), for long-range trends and BI
-- ===========================================================================
create materialized view public.mv_orders_daily as
  select public.muscat_day(o.created_at) as day,
         coalesce(z.name, 'Outside service areas') as zone,
         o.service_type::text as service_type,
         o.channel,
         count(*)::int as orders,
         count(*) filter (where o.status = 'delivered')::int as delivered,
         count(*) filter (where o.status = 'cancelled')::int as cancelled,
         coalesce(sum(o.gallons) filter (where o.status = 'delivered'), 0)::bigint as gallons,
         coalesce(sum(o.total - o.short_credit) filter (where o.status = 'delivered'), 0)::numeric(14,3) as revenue_omr,
         count(*) filter (where o.status = 'delivered' and public.sla_served_at(o) <= coalesce(o.slot_end, coalesce(o.released_at, o.created_at) + interval '120 minutes'))::int as on_time
    from public.orders o left join public.zones z on z.id = o.zone_id
   where not o.is_test
   group by 1, 2, 3, 4;
create unique index mv_orders_daily_key on public.mv_orders_daily (day, zone, service_type, channel);
revoke all on public.mv_orders_daily from public, anon, authenticated;

create table public.report_refresh_log (
  view_name    text primary key,
  refreshed_at timestamptz not null
);
alter table public.report_refresh_log enable row level security;
revoke all on public.report_refresh_log from anon, authenticated;
grant select on public.report_refresh_log to authenticated;
create policy report_refresh_log_staff on public.report_refresh_log for select to authenticated using (public.is_staff());

create function public.refresh_report_views()
returns timestamptz
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'not_staff'; end if;
  begin
    refresh materialized view concurrently public.mv_orders_daily;
  exception when others then
    refresh materialized view public.mv_orders_daily;
  end;
  insert into public.report_refresh_log (view_name, refreshed_at) values ('mv_orders_daily', now())
  on conflict (view_name) do update set refreshed_at = excluded.refreshed_at;
  return now();
end $$;
insert into public.report_refresh_log (view_name, refreshed_at) values ('mv_orders_daily', now()) on conflict do nothing;

-- Long-range trend (months) from the view: orders and on-time share per Muscat month.
create function public.report_monthly(p_months integer default 12)
returns table (month date, orders bigint, delivered bigint, gallons bigint, revenue_omr numeric, on_time bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select date_trunc('month', v.day)::date, sum(v.orders)::bigint, sum(v.delivered)::bigint, sum(v.gallons)::bigint, sum(v.revenue_omr), sum(v.on_time)::bigint
      from public.mv_orders_daily v
     where v.day >= (date_trunc('month', now() at time zone 'Asia/Muscat') - make_interval(months => greatest(least(coalesce(p_months, 12), 60), 1) - 1))::date
     group by 1 order by 1;
end $$;

-- ===========================================================================
-- G11 — GET /api/v1/reports/{dataset} (scope reports:read), offset-paged
-- ===========================================================================
create function public.api_v1_report(p_key text, p_dataset text, p_from date default null, p_to date default null, p_limit integer default 1000, p_cursor text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare k public.api_keys; lim integer := greatest(least(coalesce(p_limit, 1000), 5000), 1); off integer := coalesce(nullif(p_cursor, '')::integer, 0);
  f date := coalesce(p_from, (now() at time zone 'Asia/Muscat')::date - 30); t date := coalesce(p_to, (now() at time zone 'Asia/Muscat')::date); out_rows jsonb;
begin
  k := public.api_auth(p_key, 'reports:read', 'GET', '/api/v1/reports/' || coalesce(p_dataset, ''));
  if off < 0 then raise exception 'invalid_value: cursor'; end if;
  if p_dataset = 'orders_daily' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.day, x.zone, x.service_type, x.channel), '[]') into out_rows
      from (select * from public.mv_orders_daily v where v.day between f and t order by v.day, v.zone, v.service_type, v.channel offset off limit lim) x;
  elsif p_dataset = 'orders' then
    select coalesce(jsonb_agg(jsonb_build_object('order_no', 'TO-' || x.order_no, 'day', public.muscat_day(x.created_at), 'status', x.status, 'service_type', x.service_type,
                                                 'gallons', x.gallons, 'area', x.area, 'zone', z.name, 'channel', x.channel, 'total', x.total, 'tanker_plate', x.tanker_plate,
                                                 'created_at', x.created_at, 'delivered_at', x.delivered_at, 'sla', public.sla_state(x), 'rating', x.rating) order by x.created_at, x.id), '[]') into out_rows
      from (select * from public.orders o where not o.is_test and public.muscat_day(o.created_at) between f and t order by o.created_at, o.id offset off limit lim) x
      left join public.zones z on z.id = x.zone_id;
  elsif p_dataset = 'complaints' then
    select coalesce(jsonb_agg(jsonb_build_object('case_no', 'C-' || x.case_no, 'day', public.muscat_day(x.created_at), 'category', x.category, 'channel', x.channel, 'state', x.state,
                                                 'sla_hours', x.sla_hours, 'due_at', x.due_at, 'resolved_at', x.resolved_at, 'refund_amount', x.refund_amount,
                                                 'order_no', case when o.order_no is not null then 'TO-' || o.order_no end) order by x.created_at, x.id), '[]') into out_rows
      from (select * from public.complaints c where public.muscat_day(c.created_at) between f and t order by c.created_at, c.id offset off limit lim) x
      left join public.orders o on o.id = x.order_id
     where not coalesce(o.is_test, false);
  elsif p_dataset = 'ratings' then
    select coalesce(jsonb_agg(jsonb_build_object('order_no', 'TO-' || x.order_no, 'day', public.muscat_day(x.rated_at), 'rating', x.rating,
                                                 'driver_ref', left(md5(coalesce(x.driver_id::text, '')), 10), 'company', c.name, 'service_type', x.service_type) order by x.rated_at, x.id), '[]') into out_rows
      from (select * from public.orders o where not o.is_test and o.rating is not null and public.muscat_day(o.rated_at) between f and t order by o.rated_at, o.id offset off limit lim) x
      left join public.tankers tk on tk.id = x.tanker_id left join public.companies c on c.id = tk.company_id;
  else
    raise exception 'invalid_value: dataset must be orders_daily, orders, complaints or ratings';
  end if;
  update public.api_requests set rows = jsonb_array_length(out_rows) where id = (select max(id) from public.api_requests where key_id = k.id);
  return jsonb_build_object('dataset', p_dataset, 'from', f, 'to', t, 'data', out_rows,
                            'refreshed_at', case when p_dataset = 'orders_daily' then (select refreshed_at from public.report_refresh_log where view_name = 'mv_orders_daily') end,
                            'next_cursor', case when jsonb_array_length(out_rows) = lim then (off + lim)::text end);
end $$;

-- ===========================================================================
-- Access
-- ===========================================================================
revoke execute on function public.report_since(integer), public.muscat_day(timestamptz), public.muscat_week(timestamptz), public.refresh_report_views()
  from public, anon, authenticated;
grant execute on function public.report_since(integer), public.muscat_day(timestamptz), public.muscat_week(timestamptz) to authenticated;
do $$
declare f text;
begin
  foreach f in array array['report_operations(integer)', 'report_consumption(integer)', 'report_feedback(integer)', 'property_trend(uuid, integer)',
                           'org_sites_trends(integer)', 'report_monthly(integer)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.api_v1_report(text, text, date, date, integer, text) from public;
grant execute on function public.api_v1_report(text, text, date, date, integer, text) to anon, authenticated;

-- Staff can refresh on demand (Reports); pg_cron every 15 minutes.
create function public.staff_refresh_reports()
returns timestamptz
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return public.refresh_report_views();
end $$;
revoke execute on function public.staff_refresh_reports() from public, anon;
grant execute on function public.staff_refresh_reports() to authenticated;

select public.nama_schedule('nama-report-views', '*/15 * * * *', 'select public.refresh_report_views()');
