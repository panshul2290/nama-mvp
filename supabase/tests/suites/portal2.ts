// Second round of portal fixes and proof-of-delivery location (0024).
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder, setOnline } from "../lib/world";

type Row = Record<string, unknown>;

export async function portal2Suite(t: Target, r: Reporter) {
  r.start("PORTAL2 settings, exports and proof-of-delivery location (0024)");
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const AD = await mkStaff("p2-ad", "admin");
  const OP = await mkStaff("p2-op", "operator");
  const VW = await mkStaff("p2-vw", "viewer");
  const C1 = await t.createUser("p2-c1", { role: "customer", full_name: "Test P2 Customer" });

  // ---- Settings → Users -------------------------------------------------------------------------
  const dir = await t.as<{ id: string; email: string }>(AD.id, "select * from staff_directory()");
  r.check("admins see staff emails", dir.some((d) => d.id === OP.id && d.email === OP.email) && !dir.some((d) => d.id === C1.id), dir.length);
  await r.denies("other staff can't list emails", () => one(OP.id, "select * from staff_directory()"), "forbidden_for_role");
  const [zone] = await t.admin<{ name: string }>("select name from zones where not is_test order by name limit 1");
  const z = await one<Row>(AD.id, "select * from staff_set_zones($1, $2, 'TEST night shift')", [OP.id, [zone.name]]);
  r.check("admin edits a staff member's zones (audited)",
    JSON.stringify(z.staff_zones) === JSON.stringify([zone.name]) && (await t.admin("select 1 from audit_log where action = 'staff.zones' and target_id = $1", [OP.id])).length === 1, z.staff_zones);
  await r.denies("an unknown zone is refused", () => one(AD.id, "select * from staff_set_zones($1, array['Atlantis'], 'TEST')", [OP.id]), "invalid_value");
  await r.denies("only admins edit zones", () => one(OP.id, "select * from staff_set_zones($1, '{}', 'TEST')", [OP.id]), "forbidden_for_role");
  await r.denies("zones can't be set on a customer", () => one(AD.id, "select * from staff_set_zones($1, '{}', 'TEST')", [C1.id]), "not_found");

  // ---- exports are audited ----------------------------------------------------------------------
  await t.as(VW.id, "select staff_log_export('TEST report: orders by zone', 12)");
  const [ex] = await t.admin<{ actor_id: string; after: { rows: number } }>("select actor_id, after from audit_log where action = 'report.export' and target_id = 'TEST report: orders by zone'");
  r.check("an export is written to the audit log with its row count", ex?.actor_id === VW.id && ex.after.rows === 12, ex);
  await r.denies("customers can't write export entries", () => t.as(C1.id, "select staff_log_export('x', 1)"), "not_staff");

  // ---- privacy consent count --------------------------------------------------------------------
  await t.admin("update profiles set prefs = coalesce(prefs, '{}'::jsonb) || '{\"share_usage\": true}'::jsonb where id = $1", [C1.id]);
  const cs = await one<{ customers: number; sharing: number }>(VW.id, "select * from staff_consent_stats()");
  r.check("consent stats count customers and those sharing usage data", cs.customers >= 1 && cs.sharing >= 1 && cs.sharing <= cs.customers, cs);
  await r.denies("customers can't read consent stats", () => one(C1.id, "select * from staff_consent_stats()"), "not_staff");

  // ---- company portal: a rejected document keeps the reason --------------------------------------
  const PO = await mkStaff("p2-po", "permit_officer");
  const OW = await t.createUser("p2-ow", { role: "owner" as never, full_name: "Test P2 Owner" });
  const comp = await one<Row>(OW.id, "select * from owner_register_company('TST P2 Owner Co', $1, '+968 9000 0002', 'Bank Muscat', 'OM12 TEST 0002')", [`TSTR${t.runId.slice(-5)}`]);
  await one(AD.id, "select staff_company_action($1, 'activate', 'TEST documents checked')", [comp.id]);
  const tk = await one<{ id: string }>(OW.id, "select * from owner_register_tanker($1, 'DW', 4000)", [`TSTP2${t.runId.slice(-4)}`]);
  const [doc] = await t.admin<{ id: string }>("insert into tanker_documents (tanker_id, kind, ref_no, valid_to, status) values ($1, 'insurance', 'TEST', current_date + 200, 'pending_review') returning id", [tk.id]);
  await r.denies("rejecting a document needs a reason", () => one(PO.id, "select * from staff_review_document($1, false, null)", [doc.id]), "reason_required");
  await one(PO.id, "select * from staff_review_document($1, false, 'TEST policy number unreadable')", [doc.id]);
  const seen = await one<{ status: string; review_note: string | null }>(OW.id, "select status, review_note from tanker_documents where id = $1", [doc.id]);
  r.check("the owner sees the rejection and NWS's reason", seen?.status === "rejected" && seen.review_note === "TEST policy number unreadable", seen);
  const ok = await one<{ status: string; review_note: string | null }>(PO.id, "select * from staff_review_document($1, true, null)", [doc.id]);
  r.check("approving clears the reason", ok.status === "valid" && ok.review_note === null, ok);

  // ---- proof of delivery: device location, photo location, distance from the pin -----------------
  const w = await makeWorld(t, "p2pod");
  await setOnline(t, w.D1.id, true);
  // Arrive at an order: accept, one GPS fix near the pin (23.6, 58.2), mark arrived.
  const arrive = async (gallons: number) => {
    const o = await placeOrder(t, w.C1.id, "DW", gallons);
    await t.as(w.D1.id, "select * from accept_order($1)", [o.id]);
    await t.as(w.D1.id, "select report_location(23.6003, 58.2002, 9, now())");
    await t.as(w.D1.id, "select status from mark_arrived($1)", [o.id]);
    return o;
  };
  const pod = async (orderId: string) => (await t.admin<Row>("select * from pods where order_id = $1", [orderId]))[0];
  const SUBMIT = `select status from submit_pod(p_order_id => $1, p_meter_gal => $2, p_photo_path => $3, p_photo_hash => 'TEST-hash', p_signature_svg => '<svg/>',
                    p_lat => $4, p_lng => $5, p_accuracy_m => $6, p_fix_at => $7, p_photo_lat => $8, p_photo_lng => $9, p_photo_accuracy_m => $10, p_photo_at => $11, p_photo_source => $12)`;
  const now = new Date().toISOString();

  const o1 = await arrive(1000);
  const photo = await t.evidencePhoto(w.D1.id);
  await r.denies("a fix with a latitude but no longitude is refused", () =>
    t.as(w.D1.id, SUBMIT, [o1.id, 1000, photo, 23.6, null, 8, now, null, null, null, null, "camera"]), "invalid_pod_location");
  await r.denies("a fix from the future is refused", () =>
    t.as(w.D1.id, SUBMIT, [o1.id, 1000, photo, 23.6, 58.2, 8, new Date(Date.now() + 3600e3).toISOString(), null, null, null, null, "camera"]), "invalid_pod_location");
  await r.denies("an unknown photo source is refused", () =>
    t.as(w.D1.id, SUBMIT, [o1.id, 1000, photo, 23.6, 58.2, 8, now, null, null, null, null, "scanner"]), "invalid_value");
  const [d1] = await t.as<{ status: string }>(w.D1.id, SUBMIT, [o1.id, 1000, await t.evidencePhoto(w.D1.id), 23.6001, 58.2001, 7.5, now, 23.6002, 58.2, 11, now, "camera"]);
  const p1 = await pod(o1.id);
  r.check("the phone's fix, accuracy and time are stored, with the distance from the pin",
    d1.status === "delivered" && p1.location_source === "device" && Number(p1.accuracy_m) === 7.5 && p1.fix_at !== null && Number(p1.distance_m) < 30, p1);
  r.check("the photo's own fix and source are stored", Number(p1.photo_lat) === 23.6002 && p1.photo_source === "camera" && Number(p1.photo_distance_m) < 40, p1);
  r.check("the customer reads the location on their receipt", (await t.as<Row>(w.C1.id, "select distance_m, accuracy_m from pods where order_id = $1", [o1.id]))[0]?.distance_m === p1.distance_m);
  r.check("another customer can't", (await t.as(w.C2.id, "select 1 from pods where order_id = $1", [o1.id])).length === 0);

  const o2 = await arrive(1000);
  await t.as(w.D1.id, SUBMIT, [o2.id, 1000, await t.evidencePhoto(w.D1.id), 23.61, 58.2, 6, now, 23.61, 58.2, 6, now, "gallery"]);
  const p2 = await pod(o2.id);
  r.check("a proof recorded ~1.1 km away shows the distance (flagged in the apps above 300 m)", Number(p2.distance_m) > 1000 && Number(p2.distance_m) < 1200 && p2.photo_source === "gallery", p2.distance_m);

  const o3 = await arrive(1000);
  await t.as(w.D1.id, "select status from submit_pod($1, 900, $2, 'TEST-hash', '<svg/>')", [o3.id, await t.evidencePhoto(w.D1.id)]);
  const p3 = await pod(o3.id);
  const [tkr] = await t.admin<{ last_lat: number }>("select last_lat from tankers where id = $1", [w.tk.D1]);
  r.check("without a phone fix the tanker's last GPS fix is recorded (source 'tanker')", p3.location_source === "tanker" && Number(p3.lat) === Number(tkr.last_lat) && p3.photo_lat === null, p3);
  const [o3row] = await t.admin<{ short_credit: string }>("select short_credit from orders where id = $1", [o3.id]);
  r.check("short delivery still credits the customer", Number(o3row.short_credit) > 0, o3row);
}
