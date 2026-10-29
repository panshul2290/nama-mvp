// Test zone "Test – India" (0020): Indian cities resolve to it, Omani points never
// do; orders there are flagged is_test, priced like Muscat, and their fill and
// discharge legs are accepted at the tanker's position; Oman geofences and
// penalties are unchanged; NWS can switch the zone off.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, setOnline } from "../lib/world";

type Row = Record<string, unknown>;

export const INDIA_CITIES: [string, number, number][] = [
  ["Delhi", 28.6139, 77.209],
  ["Mumbai", 19.076, 72.8777],
  ["Bengaluru", 12.9716, 77.5946],
  ["Chennai", 13.0827, 80.2707],
  ["Kolkata", 22.5726, 88.3639],
  ["Hyderabad", 17.385, 78.4867],
  ["Pune", 18.5204, 73.8567],
  ["Ahmedabad", 23.0225, 72.5714],
  ["Jaipur", 26.9124, 75.7873],
  ["Lucknow", 26.8467, 80.9462],
  ["Kochi", 9.9312, 76.2673],
  ["Guwahati", 26.1445, 91.7362],
  ["Chandigarh", 30.7333, 76.7794],
  ["Srinagar", 34.0837, 74.7973],
];
const DELHI = { lat: 28.6139, lng: 77.209 };

export async function testZoneSuite(t: Target, r: Reporter) {
  r.start("TZ test zone (India)");

  // ---- zone matching ------------------------------------------------------------
  const cities = await t.admin<{ city: string; name: string | null; is_test: boolean | null }>(
    `select c.city, z.name, z.is_test from unnest($1::text[], $2::float8[], $3::float8[]) as c(city, lat, lng)
       left join lateral (select (public.zone_at(c.lat, c.lng, true)).*) z on true`,
    [INDIA_CITIES.map((c) => c[0]), INDIA_CITIES.map((c) => c[1]), INDIA_CITIES.map((c) => c[2])],
  );
  const missed = cities.filter((c) => c.name !== "Test – India" || c.is_test !== true);
  r.check(`all ${INDIA_CITIES.length} major Indian cities resolve to "Test – India"`, missed.length === 0, missed);

  const [reach] = await t.admin<{ east: number; box: number; n: number }>(
    `select max(center_lng + radius_km / (111.32 * cos(radians(center_lat))))::float8 as east,
            (select min(min_lng) from zones where is_test)::float8 as box, count(*)::int as n
       from zones where not is_test`,
  );
  r.check("no Omani zone circle reaches the test zone's box (easternmost reach < box west edge)", reach.n >= 19 && reach.east < reach.box, reach);

  // Centre and 8 points at 95% radius of every real zone, plus a 0.2° grid over the Oman box.
  const [edge] = await t.admin<{ total: number; bad: number }>(
    `with p as (
       select z.center_lat + case when k = 0 then 0 else 0.95 * z.radius_km / 111.32 * sin(radians(k * 45)) end as lat,
              z.center_lng + case when k = 0 then 0 else 0.95 * z.radius_km / (111.32 * cos(radians(z.center_lat))) * cos(radians(k * 45)) end as lng
         from zones z cross join generate_series(0, 8) k where not z.is_test)
     select count(*)::int as total, count(*) filter (where (public.zone_at(lat, lng, true)).is_test is distinct from false)::int as bad from p`,
  );
  r.check(`points across every Omani zone (${edge.total}) resolve to an Omani zone, never the test zone`, edge.total > 0 && edge.bad === 0, edge);
  const [grid] = await t.admin<{ total: number; test: number }>(
    `select count(*)::int as total, count(*) filter (where (public.zone_at(lat, lng, true)).is_test)::int as test
       from generate_series(16.5, 26.6, 0.2) lat cross join generate_series(51.8, 60.0, 0.2) lng`,
  );
  r.check(`a ${grid.total}-point grid over Oman never resolves to the test zone`, grid.test === 0, grid);
  const [dxb] = await t.admin<{ id: string | null }>("select (public.zone_at(25.2, 55.27, true)).id");
  r.check("Dubai is still outside every zone", dxb.id === null, dxb);

  // ---- orders, pricing and trip legs in the test zone ----------------------------------
  const w = await makeWorld(t, "tz");
  const { C1, D1, D3 } = w;
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const order = (uid: string, type: string, gal: number, at: { lat: number; lng: number }) =>
    one<Row>(uid, "select * from create_order(p_service_type => $1, p_gallons => $2, p_lat => $3, p_lng => $4, p_area => 'TEST area', p_address => 'TEST address', p_pay_method => 'card')",
      [type, gal, at.lat, at.lng]);
  const fix = (uid: string, at: { lat: number; lng: number }) => t.as(uid, "select report_location($1, $2, 8, now())", [at.lat, at.lng]);

  const delhi = await order(C1.id, "DW", 1000, DELHI);
  const seeb = await order(C1.id, "DW", 1000, { lat: 23.6, lng: 58.2 });
  const [zn] = await t.admin<{ name: string }>("select name from zones where id = $1", [delhi.zone_id]);
  r.check("an order in Delhi is accepted, in the test zone, flagged is_test", delhi.status === "requested" && zn?.name === "Test – India" && delhi.is_test === true, { delhi, zn });
  r.check("an order in Seeb is not a test order", seeb.is_test === false, seeb.is_test);
  r.check("the test order is priced exactly like the Muscat one (same rules, OMR)",
    ["water_charge", "delivery_fee", "vat", "total", "driver_earnings"].every((k) => String(delhi[k]) === String(seeb[k])), { delhi: delhi.total, seeb: seeb.total });
  await t.admin("update orders set status = 'cancelled', cancelled_at = now() where id = $1", [seeb.id]);

  await setOnline(t, D1.id, true);
  await fix(D1.id, { lat: 28.62, lng: 77.22 });
  const offarea = await t.admin("select 1 from alerts where tanker_id = $1 and type like 'Off-premise%'", [w.tk.D1]);
  r.check("a driver reporting GPS from Delhi raises no 'outside service area' alert", offarea.length === 0, offarea);
  const open = await t.as<{ id: string; is_test: boolean; distance_km: string }>(D1.id, "select id, is_test, distance_km from open_requests_near(28.62, 77.22) where id = $1", [delhi.id]);
  r.check("open_requests_near from Delhi lists the test order, nearby and tagged is_test", open.length === 1 && open[0].is_test === true && Number(open[0].distance_km) < 5, open);
  await one(D1.id, "select * from accept_order($1)", [delhi.id]);
  const filled = await one<Row>(D1.id, "select * from confirm_fill($1)", [delhi.id]);
  const [fs] = await t.admin<{ code: string }>("select code from sites where id = $1", [filled.fill_site_id]);
  r.check("confirm_fill on a test order, far from any station: verified at the tanker's position (Test station)", filled.fill_verified === true && fs?.code === "TEST-FILL", { filled: filled.fill_verified, fs });
  await one(D1.id, "select * from mark_arrived($1)", [delhi.id]);
  const done = await one<Row>(D1.id, "select * from submit_pod($1, 900, $2, 'tz-hash-1', '<svg/>')", [delhi.id, await t.evidencePhoto(D1.id)]);
  const pen1 = await t.admin("select 1 from penalties where order_id = $1", [delhi.id]);
  r.check("the test DW trip completes (delivered); delivering 10% short issues no penalty", done.status === "delivered" && pen1.length === 0, { status: done.status, pen1 });
  const alerts1 = await t.admin("select type from alerts where order_id = $1 and type like 'Filling%'", [delhi.id]);
  r.check("… and no 'Filling outside designated station' alert", alerts1.length === 0, alerts1);

  const ww = await order(C1.id, "WW", 3000, { lat: 19.08, lng: 72.88 });
  await setOnline(t, D3.id, true);
  await fix(D3.id, { lat: 19.07, lng: 72.87 });
  await one(D3.id, "select * from accept_order($1)", [ww.id]);
  await one(D3.id, "select * from mark_arrived($1)", [ww.id]);
  await one(D3.id, "select * from submit_pod($1, 3000, $2, 'tz-hash-2', '<svg/>')", [ww.id, await t.evidencePhoto(D3.id)]);
  const dis = await one<Row>(D3.id, "select * from confirm_discharge($1)", [ww.id]);
  const [ds] = await t.admin<{ code: string }>("select code from sites where id = $1", [dis.discharge_site_id]);
  const pen2 = await t.admin("select 1 from penalties where order_id = $1", [ww.id]);
  r.check("confirm_discharge on a test WW order: delivered, verified at the tanker's position (Test plant), no penalty",
    dis.status === "delivered" && dis.discharge_verified === true && ds?.code === "TEST-DIS" && pen2.length === 0, { dis: dis.discharge_verified, ds, pen2 });

  // ---- Oman rules unchanged --------------------------------------------------------------
  const om = await order(C1.id, "DW", 1000, { lat: 23.6, lng: 58.2 });

  // ---- sides never cross (0021) ------------------------------------------------------------
  // D1's tanker is in Delhi: it neither sees nor takes the Omani order.
  const fromDelhi = await t.as<{ id: string }>(D1.id, "select id from open_requests_near(28.62, 77.22) where id = $1", [om.id]);
  r.check("open_requests_near from Delhi does not list an Omani order", fromDelhi.length === 0, fromDelhi);
  await r.denies("a tanker in the test zone cannot accept an Omani order → not_eligible", () => one(D1.id, "select * from accept_order($1)", [om.id]), "not_eligible");
  // From Oman, it neither sees nor takes a test order.
  const delhi2 = await order(C1.id, "DW", 1000, DELHI);
  await t.admin("update tankers set last_lat = 23.6, last_lng = 58.2, last_fix_at = now() where id = $1", [w.tk.D1]);
  const fromSeeb = await t.as<{ id: string }>(D1.id, "select id from open_requests_near(23.6, 58.2) where id in ($1, $2)", [om.id, delhi2.id]);
  r.check("open_requests_near from Seeb lists the Omani order, not the test one", fromSeeb.length === 1 && fromSeeb[0].id === om.id, fromSeeb);
  await r.denies("a tanker in Oman cannot accept a test-zone order → not_eligible", () => one(D1.id, "select * from accept_order($1)", [delhi2.id]), "not_eligible");
  await t.admin("update orders set status = 'cancelled', cancelled_at = now() where id = $1", [delhi2.id]);

  await one(D1.id, "select * from accept_order($1)", [om.id]);
  // The tanker then moves to India (inside the test zone, next to nothing Omani).
  await t.admin("update tankers set last_lat = 28.62, last_lng = 77.22, last_fix_at = now() where id = $1", [w.tk.D1]);
  const omFill = await one<Row>(D1.id, "select * from confirm_fill($1)", [om.id]);
  const [omSite] = await t.admin<{ code: string; is_test: boolean }>("select code, is_test from sites where id = $1", [omFill.fill_site_id]);
  r.check("an Omani order filled from India is NOT verified and never uses a test site", omFill.fill_verified === false && omSite?.is_test === false, { omFill: omFill.fill_verified, omSite });
  const omAlert = await t.admin("select 1 from alerts where order_id = $1 and type = 'Filling outside designated station'", [om.id]);
  r.check("… and raises 'Filling outside designated station'", omAlert.length === 1, omAlert);
  await one(D1.id, "select * from mark_arrived($1)", [om.id]);
  await one(D1.id, "select * from submit_pod($1, 1000, $2, 'tz-hash-3', '<svg/>')", [om.id, await t.evidencePhoto(D1.id)]);

  const om2 = await order(C1.id, "DW", 1000, { lat: 23.6, lng: 58.2 });
  await t.admin("update tankers set last_lat = 23.6030, last_lng = 58.3870, last_fix_at = now() where id = $1", [w.tk.D1]);
  await one(D1.id, "select * from accept_order($1)", [om2.id]);
  const omOk = await one<Row>(D1.id, "select * from confirm_fill($1)", [om2.id]);
  const [ghb] = await t.admin<{ code: string }>("select code from sites where id = $1", [omOk.fill_site_id]);
  r.check("an Omani order filled inside Al Ghubrah is still verified there", omOk.fill_verified === true && ghb?.code === "FS-GHB", { omOk: omOk.fill_verified, ghb });
  await one(D1.id, "select * from mark_arrived($1)", [om2.id]);
  await one(D1.id, "select * from submit_pod($1, 1000, $2, 'tz-hash-4', '<svg/>')", [om2.id, await t.evidencePhoto(D1.id)]);

  const omWw = await order(C1.id, "WW", 3000, { lat: 23.6, lng: 58.2 });
  await t.admin("update tankers set last_lat = 23.6, last_lng = 58.2, last_fix_at = now() where id = $1", [w.tk.D3]);
  await one(D3.id, "select * from accept_order($1)", [omWw.id]);
  await one(D3.id, "select * from mark_arrived($1)", [omWw.id]);
  await one(D3.id, "select * from submit_pod($1, 3000, $2, 'tz-hash-5', '<svg/>')", [omWw.id, await t.evidencePhoto(D3.id)]);
  await t.admin("update tankers set last_lat = 19.07, last_lng = 72.87, last_fix_at = now() where id = $1", [w.tk.D3]);
  const omDis = await one<Row>(D3.id, "select * from confirm_discharge($1)", [omWw.id]);
  const omPen = await t.admin<{ rule_code: string }>("select rule_code from penalties where order_id = $1", [omWw.id]);
  r.check("an Omani WW order discharged from India: unverified, with the 500 OMR discharge penalty", omDis.discharge_verified === false && omPen.some((p) => p.rule_code === "discharge_outside"), { omDis: omDis.discharge_verified, omPen });

  const [manual] = await t.admin<{ id: string | null }>("select (public.issue_penalty('late_delivery', $1, $2, 'TEST late')).id", [delhi.id, w.tk.D1]);
  r.check("no penalty can be issued on a test order (e.g. late delivery)", manual.id === null, manual);

  // ---- the switch: NWS disables the test zone ---------------------------------------------------
  if (!t.fresh) {
    r.skip("disabling the test zone refuses new orders in India", "changes a live zone; run on the fresh PGlite build");
    return;
  }
  const AD = await t.createUser("tz-ad", { role: "customer", full_name: "Test Zone Admin" });
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'operator' where id = $1", [AD.id]);
  const [tz] = await t.admin<{ id: string }>("select id from zones where is_test");
  await one(AD.id, "select staff_set_active('zone', $1, false, 'TEST production cut-over')", [tz.id]);
  await r.denies("with the test zone disabled, an order in Delhi → zone_disabled", () => order(C1.id, "DW", 1000, DELHI), "zone_disabled");
  const stillOman = await order(C1.id, "DW", 1000, { lat: 23.6, lng: 58.2 });
  r.check("… while Oman orders are unaffected", stillOman.status === "requested" && stillOman.is_test === false, stillOman.status);
  await one(AD.id, "select staff_set_active('zone', $1, true, 'TEST re-enable')", [tz.id]);
  const back = await order(C1.id, "DW", 1000, DELHI);
  r.check("re-enabled: orders in Delhi are accepted again", back.status === "requested" && back.is_test === true, back.status);
}
