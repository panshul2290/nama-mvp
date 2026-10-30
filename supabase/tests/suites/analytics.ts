// Tender gaps, batch A part 4 (0029): server-side report aggregation, per-property and
// per-site consumption trends, feedback insights and the BI reporting export.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder } from "../lib/world";

type Row = Record<string, unknown>;

export async function analyticsSuite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const AD = await mkStaff("an-ad", "admin");
  const VW = await mkStaff("an-vw", "viewer");
  const w = await makeWorld(t, "ana");
  const { C1, C2, D1 } = w;

  r.start("REPORTS server-side aggregation (0029)");
  type Ops = { placed: number; delivered: number; by_zone: { zone: string; n: number }[]; year: Record<string, number>; per_day: unknown[] };
  const ops0 = await one<{ r: Ops }>(VW.id, "select report_operations(30) as r");
  const [tz] = await t.admin<{ id: string }>("select id from zones where is_test limit 1");
  await t.admin("insert into orders (customer_id, service_type, gallons, area, zone_id, status) values ($1, 'DW', 1000, 'TEST automated check', $2, 'requested')", [C1.id, tz.id]);
  const ops1 = await one<{ r: Ops }>(VW.id, "select report_operations(30) as r");
  r.check("a test-zone order doesn't count in reports", ops1.r.placed === ops0.r.placed, { before: ops0.r.placed, after: ops1.r.placed });
  // Three delivered orders for one property, a week apart, rated for D1.
  const prop = await one<{ id: string }>(C1.id, "select id from save_property(null, 'TEST trend villa', 'TEST', 'Seeb', 23.6, 58.2, 3000)");
  const ids: string[] = [];
  for (const [daysAgo, rating] of [[14, 2], [7, 3], [1, 5]] as const) {
    const [o] = await t.admin<{ id: string }>(
      `insert into orders (customer_id, service_type, gallons, area, property_id, zone_id, status, driver_id, driver_name, delivered_at, rating, rating_comment, rated_at)
       values ($1, 'DW', 2000, 'TEST automated check', $2, (zone_at(23.6, 58.2)).id, 'delivered', $3, 'Test Driver One', now() - make_interval(days => $4), $5, 'TEST comment', now() - make_interval(days => $4))
       returning id`, [C1.id, prop.id, D1.id, daysAgo, rating]);
    ids.push(o.id);
  }
  const ops2 = await one<{ r: Ops }>(VW.id, "select report_operations(30) as r");
  r.check("operations: counted in the database over every row (placed +3, delivered +3, per-day series and zones)",
    ops2.r.placed === ops1.r.placed + 3 && ops2.r.delivered === ops1.r.delivered + 3 && ops2.r.per_day.length > 0 && ops2.r.by_zone.length > 0 && typeof ops2.r.year.DW === "number", ops2.r);
  await r.denies("customers can't run reports", () => one(C1.id, "select report_operations(30)"), "not_staff");

  const cons = await one<{ r: { gallons: number; top_consumers: { customer_id: string; gallons: number }[]; top_properties: { property_id: string; weeks: number[]; deliveries: number }[] } }>(
    VW.id, "select report_consumption(30) as r");
  const tp = cons.r.top_properties.find((p) => p.property_id === prop.id);
  r.check("consumption: top consumers and per-property weekly trend computed in the database",
    cons.r.top_consumers.some((c) => c.customer_id === C1.id && c.gallons >= 6000) && !!tp && tp.weeks.length === 8 && tp.deliveries === 3, { tp });

  const fb = await one<{ r: { worst_drivers: { driver_id: string; average: number; low: number }[]; by_company: { company: string }[]; per_week: unknown[]; by_category: { category: string; n: number }[]; reopen_rate: number | null } }>(
    VW.id, "select report_feedback(30) as r");
  const d1 = fb.r.worst_drivers.find((d) => d.driver_id === D1.id);
  r.check("feedback: worst-rated drivers with their average and 1–2-star count, by company, over time",
    !!d1 && Math.abs(d1.average - 3.33) < 0.01 && d1.low === 1 && fb.r.by_company.some((c) => c.company === "Not assigned" || c.company === "Independent") && fb.r.per_week.length > 0, { d1 });
  const [cmp] = await t.admin<{ id: string }>("insert into complaints (customer_id, order_id, category, description, sla_hours, due_at, state, resolved_at) values ($1, $2, 'late_delivery', 'TEST late', 24, now() + interval '1 day', 'resolved', now()) returning id", [C1.id, ids[0]]);
  await t.admin("insert into audit_log (action, target_type, target_id) values ('complaint.reopen', 'complaint', $1)", [cmp.id]);
  const fb2 = await one<{ r: { by_category: { category: string; n: number }[]; reopened: number; reopen_rate: number } }>(VW.id, "select report_feedback(30) as r");
  r.check("feedback: complaint categories and the reopen rate", fb2.r.by_category.some((c) => c.category === "late_delivery" && c.n >= 1) && fb2.r.reopened >= 1 && fb2.r.reopen_rate > 0, fb2.r);

  r.start("TRENDS per-property and per-site consumption (0029)");
  const tr = await one<{ r: { weeks: { dw: number }[]; total_gal: number; deliveries: number; refill: { avg_gap_days: number } | null } }>(C1.id, "select property_trend($1, 12) as r", [prop.id]);
  r.check("a household sees its property's weekly trend and refill interval", tr.r.weeks.length === 12 && tr.r.total_gal === 6000 && tr.r.deliveries === 3 && Number(tr.r.refill?.avg_gap_days) === 6.5, tr.r);
  const st = await one<{ r: { total_gal: number } }>(VW.id, "select property_trend($1, 26) as r", [prop.id]);
  r.check("NWS staff see it too (Customers detail)", st.r.total_gal === 6000);
  await r.denies("another customer can't", () => one(C2.id, "select property_trend($1)", [prop.id]), "not_found");

  const BA = await t.createUser("an-ba", { role: "business" as never, full_name: "Test Trend Admin" });
  const BM = await t.createUser("an-bm", { role: "business" as never, full_name: "Test Trend Manager" });
  const org = await one<{ id: string }>(BA.id, "select * from org_register('TST Trend Co', $1, 'commercial')", [`TSTT${t.runId.slice(-5)}`]);
  await t.admin("update organizations set status = 'active', credit_limit = 1000 where id = $1", [org.id]);
  await t.admin("update profiles set org_id = $2, org_role = 'site_manager' where id = $1", [BM.id, org.id]);
  const S1 = await one<{ id: string }>(BA.id, "select id from save_property(null, 'TEST trend site 1', 'TEST', 'Seeb', 23.6, 58.2, 9000)");
  const S2 = await one<{ id: string }>(BA.id, "select id from save_property(null, 'TEST trend site 2', 'TEST', 'Seeb', 23.6, 58.2, 9000)");
  await t.admin("insert into orders (customer_id, org_id, service_type, gallons, area, property_id, status, delivered_at, billing) values ($1, $2, 'DW', 5000, 'TEST automated check', $3, 'delivered', now() - interval '2 days', 'account')", [BA.id, org.id, S1.id]);
  await one(BA.id, "select org_set_member_sites($1, array[$2]::uuid[])", [BM.id, S2.id]);
  const all = await t.as<{ property_id: string; total_gal: number; weeks: number[] }>(BA.id, "select * from org_sites_trends(12)");
  const lim = await t.as<{ property_id: string }>(BM.id, "select * from org_sites_trends(12)");
  r.check("Business → Sites: weekly trend per site; a member limited to one site sees only it",
    all.length === 2 && all.find((x) => x.property_id === S1.id)?.total_gal === 5000 && all[0].weeks.length === 12 && lim.length === 1 && lim[0].property_id === S2.id, { all: all.length, lim });

  r.start("BIEXPORT materialised view and reporting export (0029)");
  await r.denies("customers can't refresh report views", () => one(C1.id, "select staff_refresh_reports()"), "not_staff");
  await one(VW.id, "select staff_refresh_reports()");
  const [mv] = await t.admin<{ n: number; test: number }>("select coalesce(sum(orders), 0)::int as n, (select count(*)::int from mv_orders_daily where zone like 'Test%') as test from mv_orders_daily");
  r.check("the daily view is refreshed and leaves the test zone out", mv.n > 0 && mv.test === 0, mv);
  await r.denies("signed-in users can't read the view directly", () => t.as(AD.id, "select * from mv_orders_daily limit 1"), "permission denied");
  const months = await t.as<{ orders: number }>(VW.id, "select * from report_monthly(12)");
  r.check("monthly trend from the view", months.length >= 1 && months.some((m) => Number(m.orders) > 0), months);
  const key = await one<{ k: { key: string } }>(AD.id, "select staff_create_api_key('TEST DWH', array['reports:read']) as k");
  const daily = await one<{ r: { data: { day: string; delivered: number }[]; refreshed_at: string } }>(null, "select api_v1_report($1, 'orders_daily') as r", [key.k.key]);
  r.check("GET reports/orders_daily for the warehouse (with the refresh time)", daily.r.data.length > 0 && !!daily.r.refreshed_at, daily.r.data.length);
  const p1 = await one<{ r: { data: unknown[]; next_cursor: string | null } }>(null, "select api_v1_report($1, 'orders', null, null, 2) as r", [key.k.key]);
  const p2 = await one<{ r: { data: unknown[] } }>(null, "select api_v1_report($1, 'orders', null, null, 2, $2) as r", [key.k.key, p1.r.next_cursor]);
  r.check("GET reports/orders is paged, without customer identity", p1.r.data.length === 2 && p1.r.next_cursor === "2" && p2.r.data.length >= 1 && !JSON.stringify(p1.r.data).includes(C1.id), p1.r.next_cursor);
  const rt = await one<{ r: { data: { driver_ref: string }[] } }>(null, "select api_v1_report($1, 'ratings') as r", [key.k.key]);
  r.check("GET reports/ratings carries a pseudonymous driver reference, not the id", rt.r.data.length > 0 && rt.r.data.every((x) => x.driver_ref.length === 10) && !JSON.stringify(rt.r.data).includes(D1.id));
  await r.denies("an unknown dataset is refused", () => one(null, "select api_v1_report($1, 'customers')", [key.k.key]), "invalid_value");
  await placeOrder(t, C2.id, "DW", 600);
}
