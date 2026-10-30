// Addresses, delivery contacts, driver photo, Naql vehicle fields, availability, tiers, SOS and
// route sharing (0040–0042).
import type { Reporter, Target } from "../lib/harness";
import { deliver, makeWorld, setOnline } from "../lib/world";

type Row = Record<string, unknown>;
const LAT = 23.6;
const LNG = 58.2;

export async function addressFleetSuite(t: Target, r: Reporter) {
  r.start("ADR addresses, delivery contact, driver photo; FLT vehicle papers, availability, tiers; SOS (0040–0042)");
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const w = await makeWorld(t, "adr");
  const OP = await t.createUser("adr-op", { role: "customer", full_name: "Test Adr Operator" });
  const PO = await t.createUser("adr-po", { role: "customer", full_name: "Test Adr Permits" });
  const AD = await t.createUser("adr-ad", { role: "customer", full_name: "Test Adr Admin" });
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'operator' where id = $1", [OP.id]);
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'permit_officer' where id = $1", [PO.id]);
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'admin' where id = $1", [AD.id]);
  const order = (uid: string, extra: { property?: string | null; card?: string | null } = {}) =>
    one<Row & { id: string; order_no: number; status: string }>(
      uid,
      "select * from create_order(p_service_type => 'DW', p_gallons => 1000, p_lat => $1, p_lng => $2, p_area => 'TEST area', p_address => 'TEST address', p_property_id => $3, p_pay_method => 'card', p_card_last4 => $4)",
      [LAT, LNG, extra.property ?? null, extra.card ?? null],
    );
  const outbox = (orderId: string, event: string) =>
    t.admin<{ user_id: string | null; destination: string | null; message_class: string; body: string; channel: string; is_test: boolean }>(
      "select user_id, destination, message_class, body, channel, is_test from notification_outbox where order_id = $1 and event = $2", [orderId, event]);

  // ---- #16 wilayats and address details -----------------------------------------------------------
  const [{ n }] = await t.admin<{ n: number }>("select count(*)::int as n from wilayats");
  r.check("61 wilayats are listed, each in a governorate", n === 61, n);
  const seeb = await t.as<{ name_ar: string }>(w.C1.id, "select name_ar from wilayats where code = 'MUS-04'");
  r.check("signed-in users read the wilayat list (with Arabic names)", seeb[0]?.name_ar === "السيب", seeb);
  await r.denies("signed-out visitors can't read it", () => t.as(null, "select * from wilayats"), "permission denied");

  const prop = await one<{ id: string }>(w.C1.id, "select id from save_property(null, 'Farm', 'TEST farm road', 'TEST area', $1, $2, 5000)", [LAT, LNG]);
  const details = { wilayat: "mus-04", village: "Al Hail", way_no: "1234", house_no: "56", national_address_id: "NA-778", landmark: "Behind the green mosque", contact_name: "Ravi (caretaker)", contact_phone: "9123 4567", call_ahead: true };
  const p1 = await one<Row>(w.C1.id, "select * from set_property_details($1, $2::jsonb)", [prop.id, JSON.stringify(details)]);
  r.check("a customer saves the optional address and contact (wilayat upper-cased, mobile normalised to +968)", p1.wilayat_code === "MUS-04" && p1.contact_phone === "+96891234567" && p1.call_ahead === true && p1.way_no === "1234", p1);
  await r.allows("every field is optional (an empty object clears them)", () => one(w.C2.id, "select id from save_property(null, 'Villa', '', 'TEST area', $1, $2, 3000)", [LAT, LNG]).then((x) => one(w.C2.id, "select * from set_property_details($1, '{}'::jsonb)", [(x as Row).id])));
  await r.denies("an unknown wilayat is refused", () => one(w.C1.id, "select * from set_property_details($1, '{\"wilayat\": \"XXX-99\"}'::jsonb)", [prop.id]), "unknown wilayat");
  await r.denies("a bad contact mobile is refused", () => one(w.C1.id, "select * from set_property_details($1, '{\"contact_phone\": \"12\"}'::jsonb)", [prop.id]), "invalid_phone");
  await r.denies("another customer can't edit the property", () => one(w.C2.id, "select * from set_property_details($1, '{}'::jsonb)", [prop.id]), "not_found");
  await r.denies("drivers can't edit properties", () => one(w.D1.id, "select * from set_property_details($1, '{}'::jsonb)", [prop.id]), "forbidden_for_role");

  const o1 = await order(w.C1.id, { property: prop.id });
  const [l1] = await t.admin<Row>("select * from order_locations where order_id = $1", [o1.id]);
  r.check("an order for the property starts with its address details and contact", l1.wilayat_code === "MUS-04" && l1.contact_name === "Ravi (caretaker)" && l1.landmark === "Behind the green mosque" && l1.call_ahead === true, l1);
  const o2 = await order(w.C2.id);
  const l2 = await one<Row>(w.C2.id, "select * from set_order_details($1, $2::jsonb)", [o2.id, JSON.stringify({ wilayat: "MUS-03", contact_name: "Gate guard", contact_phone: "+968 7123 4567" })]);
  r.check("the request flow sets details on its order", l2.wilayat_code === "MUS-03" && l2.contact_phone === "+96871234567" && l2.call_ahead === false, l2);
  await r.denies("another customer can't set them", () => one(w.C1.id, "select * from set_order_details($1, '{}'::jsonb)", [o2.id]), "not_found");
  const [price] = await t.admin<{ total: string; basis: string }>("select total, price_basis::text as basis from orders where id = $1", [o2.id]);
  r.check("the order keeps its locked price", Number(price.total) > 0 && price.basis.includes("version"), price);

  // ---- #17 the driver sees the contact; the contact gets the arrival SMS -----------------------------
  r.check("an unassigned driver can't read the contact", (await t.as(w.D1.id, "select contact_phone from order_locations where order_id = $1", [o1.id])).length === 0);
  await setOnline(t, w.D1.id, true);
  await t.as(w.D1.id, "select report_location($1, $2, 8, now())", [LAT + 0.01, LNG]);
  await t.as(w.D1.id, "select * from accept_order($1)", [o1.id]);
  const seen = await one<Row>(w.D1.id, "select contact_name, contact_phone, call_ahead, landmark, way_no from order_locations where order_id = $1", [o1.id]);
  r.check("the assigned driver sees the contact, the call-ahead flag and the landmark", seen?.contact_phone === "+96891234567" && seen.call_ahead === true && seen.way_no === "1234", seen);
  const [otw] = await outbox(o1.id, "contact_on_the_way");
  r.check("the contact (not a user) gets one transactional SMS on assignment, with the plate and the call-ahead line", !!otw && otw.user_id === null && otw.channel === "sms" && otw.destination === "+96891234567" && otw.message_class === "transactional" && otw.body.includes(w.plate("D1")) && otw.body.includes("call you"), otw);
  const nn = await t.admin("select 1 from notifications where order_id = $1 and event = 'contact_on_the_way'", [o1.id]);
  r.check("no in-app notification is created for a non-user", nn.length === 0);
  await t.as(w.D1.id, "select status from mark_arrived($1)", [o1.id]);
  r.check("…and one on arrival", (await outbox(o1.id, "contact_arrived")).length === 1);
  const mk = await t.admin<{ id: string | null }>("select public.notify_contact($1, 'promo_offer') as id", [o1.id]);
  r.check("a marketing template is never sent to a delivery contact", mk[0].id === null, mk);
  await r.denies("clients can't call the contact sender", () => t.as(w.C1.id, "select notify_contact($1, 'contact_arrived')", [o1.id]), "permission denied");
  await t.as(w.D1.id, "select report_location($1, $2, 8, now() + interval '1 second')", [LAT, LNG]);

  // ---- #23 driver photo and the customer's card ------------------------------------------------------
  await r.denies("customers can't set a driver photo", () => one(w.C1.id, "select * from set_driver_photo('x/y.jpg')"), "not_a_driver");
  await r.denies("a driver can't point at another driver's folder", () => one(w.D1.id, "select * from set_driver_photo($1)", [`${w.D2.id}/me.jpg`]), "invalid_path");
  const ph = await one<Row>(w.D1.id, "select * from set_driver_photo($1)", [`${w.D1.id}/profile-1.jpg`]);
  r.check("a driver sets their photo in their own folder", ph?.photo_path === `${w.D1.id}/profile-1.jpg`, ph);
  const card = await one<{ c: Row | null }>(w.C1.id, "select order_driver_card($1) as c", [o1.id]);
  r.check("the customer's card shows first name, photo, plate and tier as soon as a driver is assigned (no surname, no phone)",
    card?.c?.first_name === "Test" && card.c.photo_path === ph.photo_path && card.c.plate === w.plate("D1") && card.c.tier === "bronze" && !("phone" in (card.c ?? {})), card);
  r.check("another customer gets nothing", (await one<{ c: Row | null }>(w.C2.id, "select order_driver_card($1) as c", [o1.id]))?.c === null);
  const can = async (uid: string) => (await one<{ ok: boolean }>(uid, "select driver_photo_readable($1) as ok", [w.D1.id]))?.ok;
  r.check("the photo is readable by the driver, staff and the customer of the active job, not another customer",
    (await can(w.D1.id)) === true && (await can(OP.id)) === true && (await can(w.C1.id)) === true && (await can(w.C2.id)) === false);
  r.check("customers can't read driver_profiles rows", (await t.as(w.C1.id, "select * from driver_profiles")).length === 0);
  await deliver(t, w.D1.id, o1.id);
  r.check("after delivery the customer can no longer read the photo or the card",
    (await can(w.C1.id)) === false && (await one<{ c: Row | null }>(w.C1.id, "select order_driver_card($1) as c", [o1.id]))?.c === null);
  await r.denies("details can't change on a delivered order", () => one(w.C1.id, "select * from set_order_details($1, '{}'::jsonb)", [o1.id]), "invalid_state");

  // ---- #28 vehicle papers ---------------------------------------------------------------------------
  const veh = { naql_reg_no: "NQ-5521", op_card_no: "OC-778", op_card_expiry: "2030-01-31", vin: "1hgcm82633a004352", make: "Mercedes", model: "Actros", model_year: 2019, tank_capacity_gal: 3000, insurance_company: "Dhofar Insurance", insurance_policy_no: "POL-9", insurance_expiry: "2030-01-31", tracking_device_id: "iv-1234" };
  const sv = await one<Row>(w.D1.id, "select * from save_tanker_vehicle($1, $2::jsonb)", [w.tk.D1, JSON.stringify(veh)]);
  r.check("an independent driver saves the Naql, operating card, VIN, insurance and device fields (sent to NWS)", sv.vin === "1HGCM82633A004352" && sv.tracking_device_id === "IV-1234" && sv.vehicle_status === "submitted" && sv.model_year === 2019, sv);
  await r.denies("a bad VIN is refused", () => one(w.D1.id, "select * from save_tanker_vehicle($1, '{\"vin\": \"IOQ\"}'::jsonb)", [w.tk.D1]), "invalid_value");
  await r.denies("another driver can't edit the tanker", () => one(w.D2.id, "select * from save_tanker_vehicle($1, '{}'::jsonb)", [w.tk.D1]), "not_found");
  await r.denies("operators can't verify vehicles", () => one(OP.id, "select * from staff_verify_tanker_vehicle($1, 'verify')", [w.tk.D1]), "forbidden_for_role");
  await r.denies("a rejection needs a reason", () => one(PO.id, "select * from staff_verify_tanker_vehicle($1, 'reject')", [w.tk.D1]), "reason");
  const vf = await one<Row>(PO.id, "select * from staff_verify_tanker_vehicle($1, 'verify', 2950, 'Measured at the depot')", [w.tk.D1]);
  r.check("a permit officer verifies it with the measured capacity (audited)", vf.vehicle_status === "verified" && vf.capacity_verified_gal === 2950, vf);
  r.check("the verification is in the audit log", (await t.admin("select 1 from audit_log where action = 'tanker.vehicle_verify' and target_id = $1", [w.tk.D1])).length === 1);

  // Expired insurance: can't go online; dispatch shows why; accepting is refused.
  await t.admin("update tankers set insurance_expiry = current_date - 3 where id = $1", [w.tk.D2]);
  await r.denies("a tanker with expired insurance can't go online", () => setOnline(t, w.D2.id, true), "vehicle_documents_expired");
  await t.admin("update tankers set insurance_expiry = null where id = $1", [w.tk.D2]);
  await setOnline(t, w.D2.id, true);
  await t.as(w.D2.id, "select report_location($1, $2, 8, now())", [LAT + 0.02, LNG]);
  await t.admin("update tankers set op_card_expiry = current_date - 1 where id = $1", [w.tk.D2]);
  const o3 = await order(w.C2.id);
  const cand = await t.as<{ tanker_id: string; eligible: boolean; blockers: string[] }>(OP.id, "select tanker_id, eligible, blockers from dispatch_candidates($1, 20)", [o3.id]);
  const c2 = cand.find((c) => c.tanker_id === w.tk.D2);
  r.check("dispatch_candidates shows the expired operating card as the reason", c2?.eligible === false && c2.blockers.includes("Vehicle operating card expired"), c2);
  await r.denies("…and accepting is refused", () => t.as(w.D2.id, "select * from accept_order($1)", [o3.id]), "vehicle_documents_expired");
  await r.denies("…and so is an NWS assignment", () => t.as(OP.id, "select * from staff_order_action($1, 'assign', 'test', $2)", [o3.id, w.tk.D2]), "vehicle_documents_expired");
  await t.admin("update tankers set op_card_expiry = (now() at time zone 'Asia/Muscat')::date + 7 where id = $1", [w.tk.D1]);
  const rem = await t.admin<{ x: { vehicles: number; taken_offline: number } }>("select send_expiry_reminders() as x");
  const rem2 = await t.admin<{ x: { vehicles: number } }>("select send_expiry_reminders() as x");
  const dn = await t.admin<{ body: string }>("select body from notifications where user_id = $1 and event = 'document_expiring' order by id desc limit 1", [w.D1.id]);
  r.check("send_expiry_reminders reminds the driver of the operating card once, and takes the expired tanker offline",
    rem[0].x.vehicles >= 1 && rem2[0].x.vehicles === 0 && dn[0]?.body.includes("Vehicle operating card") && rem[0].x.taken_offline >= 1, { rem, rem2, dn });
  const [d2t] = await t.admin<{ is_online: boolean }>("select is_online from tankers where id = $1", [w.tk.D2]);
  r.check("the tanker with the expired card is offline", d2t.is_online === false, d2t);
  await t.admin("update tankers set op_card_expiry = null where id = $1", [w.tk.D2]);

  // ---- #30 availability --------------------------------------------------------------------------------
  const [{ dow, h }] = await t.admin<{ dow: number; h: number }>("select extract(dow from now() at time zone 'Asia/Muscat')::int as dow, extract(hour from now() at time zone 'Asia/Muscat')::int as h");
  // Hours that exclude the current hour (two hours from now, one hour long; wrapping is allowed).
  const pad = (x: number) => `${String(x % 24).padStart(2, "0")}:00`;
  await r.denies("an owner-less driver can't set another driver's hours", () => one(w.D1.id, "select * from set_availability_hours(1, true, '08:00', '12:00', $1)", [w.D2.id]), "not_found");
  await r.denies("a start without an end is refused", () => one(w.D2.id, "select * from set_availability_hours(1, true, '08:00', null)"), "invalid_value");
  await one(w.D2.id, "select * from set_availability_hours($1, true, $2::time, $3::time)", [dow, pad(h + 2), pad(h + 3)]);
  const av = await one<{ a: { available: boolean; note: string } }>(w.D2.id, "select my_availability_now() as a");
  r.check("outside their hours the driver is unavailable, with a note", av?.a.available === false && /Outside availability/.test(av.a.note), av);
  await r.allows("going online outside the hours is still allowed", () => setOnline(t, w.D2.id, true));
  await t.as(w.D2.id, "select report_location($1, $2, 8, now() + interval '2 seconds')", [LAT + 0.02, LNG]);
  const cand2 = await t.as<{ tanker_id: string; eligible: boolean; blockers: string[] }>(OP.id, "select tanker_id, eligible, blockers from dispatch_candidates($1, 20)", [o3.id]);
  const c3 = cand2.find((c) => c.tanker_id === w.tk.D2);
  r.check("dispatch (and auto-offer, which uses the same ranking) skips the driver outside their hours", c3?.eligible === false && c3.blockers.some((b) => b.startsWith("Outside availability")), c3);
  await one(w.D2.id, "select * from set_availability_hours($1, true, null, null)", [dow]);
  await one(w.D2.id, "select * from set_unavailable_until((now() at time zone 'Asia/Muscat')::date + 3)");
  const cand3 = await t.as<{ tanker_id: string; blockers: string[] }>(OP.id, "select tanker_id, blockers from dispatch_candidates($1, 20)", [o3.id]);
  r.check("'not available until' a date skips them too, naming the date", cand3.find((c) => c.tanker_id === w.tk.D2)?.blockers.some((b) => b.startsWith("Not available until")) === true, cand3);
  await r.denies("a date in the past is refused", () => one(w.D2.id, "select * from set_unavailable_until(current_date - 1)"), "invalid_value");
  await one(w.D2.id, "select * from set_unavailable_until(null)");
  const cand4 = await t.as<{ tanker_id: string; eligible: boolean }>(OP.id, "select tanker_id, eligible from dispatch_candidates($1, 20)", [o3.id]);
  r.check("cleared, the driver is eligible again", cand4.find((c) => c.tanker_id === w.tk.D2)?.eligible === true, cand4);

  // ---- #31 tiers -----------------------------------------------------------------------------------------
  const [tiers0] = await t.admin<{ value: string }>("select value from app_settings where key = 'DRIVER_TIERS'");
  r.check("tier thresholds are an NWS setting", !!JSON.parse(tiers0.value).gold && !!JSON.parse(tiers0.value).boost, tiers0);
  await r.denies("customers can't run the tier job", () => t.as(w.C1.id, "select compute_driver_tiers()"), "not_staff");
  await r.denies("operators can't change the thresholds", () => t.as(OP.id, "select staff_set_driver_tiers($1::jsonb, 'x')", [tiers0.value]), "forbidden_for_role");
  const easy = JSON.parse(tiers0.value);
  easy.silver = { on_time_pct: 0, rating: 0, acceptance_pct: 0, jobs_30d: 1, max_overcharge: 5, max_penalties: 5 };
  easy.min_rated = 0;
  await r.denies("gold asking less than silver is refused", () => t.as(AD.id, "select staff_set_driver_tiers($1::jsonb, 'Test check')", [JSON.stringify({ ...easy, gold: { ...easy.gold, jobs_30d: 0 }, silver: { ...easy.silver, jobs_30d: 5 } })]), "invalid_value");
  const q0 = await one<{ q: Row }>(w.C1.id, "select quote_order('DW', 1000, null, false, null) as q");
  const s0 = (await t.as<{ tanker_id: string; score: string }>(OP.id, "select tanker_id, score from dispatch_candidates($1, 20)", [o3.id])).find((c) => c.tanker_id === w.tk.D1);
  await t.as(AD.id, "select staff_set_driver_tiers($1::jsonb, 'Test thresholds')", [JSON.stringify(easy)]);
  try {
    const run = await one<{ x: { drivers: number; changed: number } }>(AD.id, "select compute_driver_tiers() as x");
    const [dp] = await t.admin<{ tier: string; tier_stats: { jobs_30d: number } }>("select tier, tier_stats from driver_profiles where driver_id = $1", [w.D1.id]);
    r.check("the nightly job puts a driver with a completed job on silver (stats stored)", dp?.tier === "silver" && dp.tier_stats.jobs_30d >= 1 && run.x.drivers >= 3, { dp, run });
    r.check("the driver is told about the new tier", (await t.admin("select 1 from notifications where user_id = $1 and event = 'tier_changed'", [w.D1.id])).length === 1);
    const mine = await one<{ x: { tier: string; next: string; needs: { metric: string }[] } }>(w.D1.id, "select my_driver_tier() as x");
    r.check("the driver app shows the tier and what gold still needs", mine?.x.tier === "silver" && mine.x.next === "gold" && mine.x.needs.length > 0, mine);
    const s1 = (await t.as<{ tanker_id: string; score: string; reasons: string[]; tier: string }>(OP.id, "select tanker_id, score, reasons, tier from dispatch_candidates($1, 20)", [o3.id])).find((c) => c.tanker_id === w.tk.D1);
    r.check("the tier boosts the dispatch score by the setting's minutes and is shown", !!s0 && !!s1 && Math.abs(Number(s0.score) - Number(s1.score) - easy.boost.silver) < 0.01 && s1.tier === "silver" && s1.reasons.some((x) => x.includes("Silver tier")), { s0, s1 });
    const q1 = await one<{ q: Row }>(w.C1.id, "select quote_order('DW', 1000, null, false, null) as q");
    r.check("tiers never change prices", JSON.stringify(q0.q.total) === JSON.stringify(q1.q.total) && JSON.stringify(q0.q.driver_earnings) === JSON.stringify(q1.q.driver_earnings), { q0, q1 });
  } finally {
    await t.admin("update app_settings set value = $1 where key = 'DRIVER_TIERS'", [tiers0.value]);
  }
  r.check("the tier job is registered for pg_cron", (await t.admin("select 1 from cron_wanted where name = 'nama-driver-tiers'")).length === 1);

  // ---- #24 SOS and route sharing -------------------------------------------------------------------------
  await setOnline(t, w.D3.id, false);
  await r.denies("an offline driver with no job can't raise an SOS (nothing to locate)", () => one(w.D3.id, "select * from driver_sos(23.6, 58.2)"), "sos_not_on_duty");
  await r.denies("customers can't raise a driver SOS", () => one(w.C1.id, "select * from driver_sos()"), "not_a_driver");
  const sos = await one<{ id: number; type: string; severity: string; lat: number }>(w.D2.id, "select * from driver_sos(23.611, 58.222, 'Followed by a car')");
  const sos2 = await one<{ id: number; lat: number }>(w.D2.id, "select * from driver_sos(23.612, 58.223)");
  r.check("an SOS raises one high-severity alert with the position; pressing again updates it", sos.type === "SOS" && sos.severity === "high" && sos.lat === 23.611 && sos2.id === sos.id && sos2.lat === 23.612, { sos, sos2 });
  r.check("NWS sees it", (await t.as(OP.id, "select 1 from alerts where id = $1", [sos.id])).length === 1);

  await r.denies("a link can't last more than 12 hours", () => one(w.D1.id, "select * from driver_share_route(13)"), "invalid_value");
  const o4 = await order(w.C2.id);
  await t.as(w.D1.id, "select * from accept_order($1)", [o4.id]);
  const share = await one<{ id: string; token: string; expires_at: string }>(w.D1.id, "select * from driver_share_route(4)");
  r.check("a driver creates a 4-hour share link", /^[0-9a-f]{36}$/.test(share.token) && Date.parse(share.expires_at) - Date.now() > 3.9 * 3600e3, share);
  const pub = await one<{ s: { state: string; plate: string; job: { lat: number; area: string }; position: unknown } }>(null, "select shared_route($1) as s", [share.token]);
  const [exact] = await t.admin<{ lat: number }>("select lat from order_locations where order_id = $1", [o4.id]);
  const text = JSON.stringify(pub?.s ?? {});
  r.check("anyone with the link sees the tanker and the destination area, rounded (not the pin, not names)",
    pub?.s.state === "live" && pub.s.plate === w.plate("D1") && pub.s.job.area === "TEST area" && pub.s.job.lat === Math.round(exact.lat * 100) / 100 && !text.includes("Test Customer") && !text.includes("Test Driver"), pub);
  await r.denies("signed-out visitors can't list share links", () => t.as(null, "select * from route_shares"), "permission denied");
  await r.denies("another user can't revoke it", () => one(w.D2.id, "select * from driver_revoke_route_share($1)", [share.id]), "not_found");
  await one(w.D1.id, "select * from driver_revoke_route_share($1)", [share.id]);
  r.check("a revoked link shows nothing", (await one<{ s: { state: string } }>(null, "select shared_route($1) as s", [share.token]))?.s.state === "revoked");
  const sh2 = await one<{ id: string; token: string }>(w.D1.id, "select * from driver_share_route(1)");
  await t.admin("update route_shares set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1", [sh2.id]);
  r.check("an expired link shows nothing", (await one<{ s: { state: string } }>(null, "select shared_route($1) as s", [sh2.token]))?.s.state === "expired");
  r.check("a made-up token shows nothing", (await one<{ s: { state: string } }>(null, "select shared_route('abc') as s"))?.s.state === "invalid");
  await t.as(w.C2.id, "select cancel_order_with_fee($1, 'test')", [o4.id]).catch(() => t.admin("update orders set status = 'cancelled', cancelled_at = now() where id = $1", [o4.id]));
  await t.as(w.C2.id, "select cancel_order($1)", [o3.id]).catch(() => undefined);
  await t.as(w.C2.id, "select cancel_order($1)", [o2.id]).catch(() => undefined);
  for (const d of [w.D1.id, w.D2.id]) await setOnline(t, d, false).catch(() => undefined);
}
