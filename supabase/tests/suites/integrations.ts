// Tender gaps, batch A part 3 (0028): incident matrix (working days, escalation, breaches),
// integration API keys (scopes, rate limit, log), API endpoints, IVMS ingestion and
// simulator, GPS accuracy grades, the notification gateway seam and signed webhooks.
import { createHmac } from "node:crypto";
import { verifyWebhook } from "../../../lib/webhooks";
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder, setOnline } from "../lib/world";

type Row = Record<string, unknown>;

export async function integrationsSuite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const AD = await mkStaff("in-ad", "admin");
  const OP = await mkStaff("in-op", "operator");
  const w = await makeWorld(t, "int");
  const { C1, D1, D2 } = w;

  // ===================================================================== J6 incidents
  r.start("INCIDENT tender matrix, working days, escalation (0028)");
  const tg = await t.admin<{ priority: string; response_min: number; resolve_min: number; response_wd: number | null; resolve_wd: number | null; penalty_pct: string }>(
    "select * from incident_targets order by priority");
  const by = Object.fromEntries(tg.map((x) => [x.priority, x]));
  r.check("P1 15 min / 2 h, P2 1 h / 4 h, P3 4 h / 1 working day, P4 1 / 2 working days; penalties 3/3/2/2 %",
    by.P1.response_min === 15 && by.P1.resolve_min === 120 && by.P2.response_min === 60 && by.P2.resolve_min === 240 &&
      by.P3.response_min === 240 && by.P3.resolve_wd === 1 && by.P4.response_wd === 1 && by.P4.resolve_wd === 2 &&
      [by.P1, by.P2, by.P3, by.P4].map((x) => Number(x.penalty_pct)).join() === "3,3,2,2", tg);
  const [wd] = await t.admin<{ thu: string; fri: string }>(
    `select to_char(add_working_days('2026-10-29 10:00+04', 1) at time zone 'Asia/Muscat', 'Dy HH24:MI') as thu,
            to_char(add_working_days('2026-10-30 10:00+04', 1) at time zone 'Asia/Muscat', 'Dy HH24:MI') as fri`);
  r.check("working days skip Friday and Saturday (Thu 10:00 + 1 → Sun 10:00; Fri + 1 → Mon 00:00)", wd.thu === "Sun 10:00" && wd.fri === "Mon 00:00", wd);
  const inc = await one<{ id: string }>(OP.id, "select id from staff_open_incident('P1', 'TEST payment gateway down', 'Payments')");
  await t.admin("update incidents set opened_at = now() - interval '10 minutes' where id = $1", [inc.id]);
  await t.admin("select incident_scan()");
  const esc1 = await t.admin("select 1 from incident_escalations where incident_id = $1", [inc.id]);
  const opNote = await t.admin("select 1 from notifications where user_id = $1 and event = 'incident_escalated'", [OP.id]);
  r.check("an open P1 past half its response time escalates once to the control room (notified)", esc1.length === 1 && opNote.length >= 1, { esc1, opNote });
  await t.admin("update incidents set opened_at = now() - interval '20 minutes' where id = $1", [inc.id]);
  await t.admin("select incident_scan()");
  await t.admin("select incident_scan()");
  const esc2 = await t.admin("select stage, level from incident_escalations where incident_id = $1", [inc.id]);
  r.check("past the target it escalates to Super admins — each level once", esc2.length === 2 && (await t.admin("select 1 from notifications where user_id = $1 and event = 'incident_escalated'", [AD.id])).length >= 1, esc2);
  const [st] = await t.as<{ response_breached: boolean; resolve_breached: boolean; penalty_pct: string; escalation_level: number }>(OP.id, "select * from incident_status() where id = $1", [inc.id]);
  r.check("incident_status flags the response breach (not yet the 2 h resolution) and the 3 % penalty", st.response_breached && !st.resolve_breached && Number(st.penalty_pct) === 3 && st.escalation_level === 2, st);
  await r.denies("customers can't read incident status", () => one(C1.id, "select * from incident_status()"), "not_staff");
  await one(OP.id, "select * from staff_incident_action($1, 'resolve', 'TEST fixed')", [inc.id]);

  // ===================================================================== G11 API keys
  r.start("API integration keys, scopes, rate limit and endpoints (0028)");
  await r.denies("only admins create API keys", () => one(OP.id, "select staff_create_api_key('TEST BI', array['orders:read'])"), "forbidden_for_role");
  await r.denies("unknown scopes are refused", () => one(AD.id, "select staff_create_api_key('TEST BI', array['orders:delete'])"), "invalid_value");
  const k1 = await one<{ k: { key: string; id: string; prefix: string } }>(AD.id, "select staff_create_api_key('TEST BI warehouse', array['orders:read', 'tankers:read', 'permits:read', 'permits:write', 'events:write']) as k");
  const KEY = k1.k.key;
  r.check("the key is returned once; only its hash is stored", KEY.startsWith("nama_live_") &&
    (await t.admin<{ key_hash: string }>("select key_hash from api_keys where id = $1", [k1.k.id]))[0].key_hash !== KEY, k1.k.prefix);
  await r.denies("nobody reads key hashes through the API", () => t.as(AD.id, "select key_hash from api_keys"), "permission denied");
  await placeOrder(t, C1.id, "DW", 1000);
  const page1 = await one<{ r: { data: Row[]; next_cursor: string | null } }>(null, "select api_v1_orders($1, now() - interval '1 hour', null, 1) as r", [KEY]);
  r.check("GET orders (anon + key): paged, without customer identity or exact location",
    page1.r.data.length === 1 && !!page1.r.next_cursor && !("customer_id" in page1.r.data[0]) && !("lat" in page1.r.data[0]) && "area" in page1.r.data[0], page1.r.data[0]);
  const page2 = await one<{ r: { data: { id: string }[] } }>(null, "select api_v1_orders($1, now() - interval '1 hour', null, 1, $2) as r", [KEY, page1.r.next_cursor]);
  r.check("the cursor returns the next order", page2.r.data.length === 1 && page2.r.data[0].id !== (page1.r.data[0] as { id: string }).id);
  const tz = await t.admin<{ n: number }>("select count(*)::int as n from orders where is_test and created_at > now() - interval '1 hour'");
  const allApi = await one<{ r: { data: { is_test: boolean }[] } }>(null, "select api_v1_orders($1, now() - interval '1 hour', null, 500) as r", [KEY]);
  r.check("test-zone orders stay out unless asked for", allApi.r.data.every((x) => !x.is_test), { tz: tz[0].n });
  await r.denies("a wrong key is refused", () => one(null, "select api_v1_orders('nama_live_nope')"), "api_unauthorized");
  const k2 = await one<{ k: { key: string; id: string } }>(AD.id, "select staff_create_api_key('TEST IVMS', array['ivms:write'], 2) as k");
  await r.denies("a key without the scope is refused", () => one(null, "select api_v1_orders($1)", [k2.k.key]), "api_forbidden");
  await r.denies("signed-in users can't use the API RPC helpers directly", () => one(C1.id, "select api_auth('x', 'orders:read', 'GET', '/')"), "permission denied");
  const tk = await one<{ r: { data: { plate: string; permit_valid: boolean }[] } }>(null, "select api_v1_tankers($1, 1000) as r", [KEY]);
  r.check("GET tankers lists plates, permit validity and the last fix", tk.r.data.some((x) => x.plate === w.plate("D1") && x.permit_valid === true));
  const [pm] = await t.admin<{ permit_no: string }>("select permit_no from permits where tanker_id = $1", [w.tk.D2]);
  const pr = await one<{ r: { data: { permit_no: string; effective_status: string }[] } }>(null, "select api_v1_permits($1, 'approved', null, 1000) as r", [KEY]);
  r.check("GET permits", pr.r.data.some((x) => x.permit_no === pm.permit_no && x.effective_status === "approved"));
  await r.denies("a permit update needs a reason", () => one(null, "select api_v1_permit_update($1, $2, 'rejected', '')", [KEY, pm.permit_no]), "reason_required");
  await t.adminRollback(async (q) => {
    await q("set local role anon");
    const [u] = await q<{ u: { status: string } }>("select api_v1_permit_update($1, $2, 'rejected', 'TEST TAS: inspection failed') as u", [KEY, pm.permit_no]);
    await q("reset role");
    const [au] = await q<{ actor_email: string }>("select actor_email from audit_log where action = 'permit.api_rejected' and reason = 'TEST TAS: inspection failed'");
    r.check("PATCH a permit from a TAS-style system: status changed and audited as the integration", u.u.status === "rejected" && au?.actor_email === "api:TEST BI warehouse", { u, au });
  });

  await setOnline(t, D1.id, true);
  const job = await placeOrder(t, C1.id, "DW", 1000);
  await one(D1.id, "select * from accept_order($1)", [job.id]);
  const ev = await one<{ r: { verified: boolean } }>(null, "select api_v1_event($1, $2) as r",
    [KEY, JSON.stringify({ kind: "fill", order_no: `TO-${job.order_no}`, site_code: "FS-SEB", meter_gal: 800 })]);
  r.check("POST a station meter event: recorded as evidence; 20 % short is not verified and raises an alert",
    ev.r.verified === false && (await t.admin("select 1 from alerts where order_id = $1 and type = 'Station meter mismatch'", [job.id])).length === 1, ev.r);
  const logged = await t.admin<{ n: number }>("select count(*)::int as n from api_requests where key_id = $1", [k1.k.id]);
  r.check("every call is in the API request log", logged[0].n >= 6, logged[0]);

  // Rate limit: 2 per minute.
  await one(null, "select api_v1_ivms_fixes($1, '[]')", [k2.k.key]);
  await one(null, "select api_v1_ivms_fixes($1, '[]')", [k2.k.key]);
  await r.denies("past its per-minute limit a key is refused", () => one(null, "select api_v1_ivms_fixes($1, '[]')", [k2.k.key]), "api_rate_limited");
  await one(AD.id, "select staff_revoke_api_key($1, 'TEST rotate')", [k2.k.id]);
  await r.denies("a revoked key is refused", () => one(null, "select api_v1_ivms_fixes($1, '[]')", [k2.k.key]), "api_unauthorized");
  await one(null, "select api_log_failure($1, 'POST', '/api/v1/ivms/fixes', 401, 'api_unauthorized')", [k2.k.key]);
  r.check("route handlers log refused calls against the key", (await t.admin("select 1 from api_requests where key_id = $1 and status = 401", [k2.k.id])).length === 1);

  // ===================================================================== C1/C5 IVMS + accuracy
  r.start("IVMS feed, simulator and accuracy grades (0028)");
  const k3 = await one<{ k: { key: string; id: string } }>(AD.id, "select staff_create_api_key('TEST IVMS vendor', array['ivms:write']) as k");
  await r.denies("only operators register devices", () => one(C1.id, "select * from staff_register_device('IV-55501', $1)", [w.tk.D2]), "not_staff");
  await one(OP.id, "select * from staff_register_device('IV-55501', $1, $2)", [w.tk.D2, k3.k.id]);
  const fixAt = new Date(Date.now() - 5000).toISOString();
  const ing = await one<{ r: { accepted: number; rejected: { error: string }[] } }>(null, "select api_v1_ivms_fixes($1, $2) as r", [k3.k.key, JSON.stringify([
    { device_id: "IV-55501", plate: w.plate("D2"), lat: 23.6, lng: 58.21, accuracy_m: 3, speed_kmh: 42, heading: 90, recorded_at: fixAt, ignition: true },
    { device_id: "IV-55501", plate: "WRONG 1", lat: 23.6, lng: 58.21, accuracy_m: 3, recorded_at: fixAt },
    { device_id: "IV-99999", lat: 23.6, lng: 58.21, accuracy_m: 3, recorded_at: fixAt },
  ])]);
  const [tkr] = await t.admin<{ last_fix_source: string; last_accuracy_m: number }>("select last_fix_source, last_accuracy_m from tankers where id = $1", [w.tk.D2]);
  const [gf] = await t.admin<{ source: string; heading: string; ignition: boolean }>("select source, heading, ignition from gps_fixes where tanker_id = $1 order by id desc limit 1", [w.tk.D2]);
  r.check("an IVMS fix moves the tanker and is stored with its source, heading and ignition",
    ing.r.accepted === 1 && tkr.last_fix_source === "ivms" && gf.source === "ivms" && Number(gf.heading) === 90 && gf.ignition === true, { ing: ing.r, tkr, gf });
  r.check("a wrong plate or an unregistered device is rejected per fix", ing.r.rejected.map((x) => x.error).sort().join() === "plate_mismatch,unknown_device", ing.r.rejected);
  const again = await one<{ r: { accepted: number; ignored_older: number } }>(null, "select api_v1_ivms_fixes($1, $2) as r", [k3.k.key, JSON.stringify([
    { device_id: "IV-55501", lat: 23.7, lng: 58.3, accuracy_m: 3, recorded_at: new Date(Date.now() - 60000).toISOString() }])]);
  r.check("an older fix doesn't move the tanker back", again.r.ignored_older === 1 && again.r.accepted === 0, again.r);
  await setOnline(t, D2.id, true);
  await one(D2.id, "select report_location(23.9, 58.9, 5, now())");
  const [still] = await t.admin<{ last_lat: number; last_fix_source: string }>("select last_lat, last_fix_source from tankers where id = $1", [w.tk.D2]);
  r.check("while IVMS is live, the phone doesn't overwrite the tanker's position", still.last_fix_source === "ivms" && still.last_lat === 23.6, still);

  await r.denies("phone fixes beyond 100 m are still refused", () => one(D1.id, "select report_location(23.6, 58.2, 150, now())"), "inaccurate_fix");
  await one(D1.id, "select report_location(23.6031, 58.3871, 25, now())");
  await one(D1.id, "select driver_topup_fill_credit(20)");
  const low = await one<Row>(D1.id, "select * from confirm_fill($1)", [job.id]);
  const [se] = await t.admin<{ verified: boolean; evidence_grade: string; note: string }>("select verified, evidence_grade, note from source_events where order_id = $1 and source = 'tfs' and note not like '%via API%'", [job.id]);
  r.check("a 25 m phone fix inside the station geofence: filled, but graded low accuracy (evidence needs ±10 m)",
    low.fill_verified === true && se.evidence_grade === "low_accuracy" && /evidence needs ±10 m/.test(se.note), se);
  const [grades] = await t.admin<{ a: string; b: string; c: string }>("select fix_grade('ivms', 3) as a, fix_grade('phone', 8) as b, fix_grade('phone', 11) as c");
  r.check("grades: IVMS ±3 m = ivms, phone 8 m = gps_precise, phone 11 m = low_accuracy", grades.a === "ivms" && grades.b === "gps_precise" && grades.c === "low_accuracy", grades);

  // The simulator.
  await r.denies("customers can't start the simulator", () => one(C1.id, "select * from staff_ivms_sim_start($1, '[[23.6,58.2],[23.61,58.21]]')", [w.tk.D3]), "not_staff");
  await one(OP.id, "select * from staff_ivms_sim_start($1, '[[23.60,58.20],[23.62,58.22],[23.64,58.24]]', 60)", [w.tk.D3]);
  const [s1] = await t.admin<{ last_lat: number; last_fix_source: string }>("select last_lat, last_fix_source from tankers where id = $1", [w.tk.D3]);
  await t.admin("update ivms_sim set last_tick = now() - interval '60 seconds' where tanker_id = $1", [w.tk.D3]);
  await one(OP.id, "select staff_ivms_sim_tick()");
  const [s2] = await t.admin<{ last_lat: number }>("select last_lat from tankers where id = $1", [w.tk.D3]);
  r.check("the simulator registers a device and moves the tanker along its route as IVMS fixes", s1.last_fix_source === "ivms" && s2.last_lat > s1.last_lat, { s1, s2 });
  await one(OP.id, "select staff_ivms_sim_stop($1)", [w.tk.D3]);
  r.check("… and stops", (await t.admin("select 1 from ivms_sim where tanker_id = $1", [w.tk.D3])).length === 0);

  // ===================================================================== notification gateway seam
  r.start("GATEWAY external notification worker (0028)");
  const C5 = await t.createUser("in-c5", { role: "customer", full_name: "Test Gateway", phone: "+968 9333 1122" });
  const k4 = await one<{ k: { key: string } }>(AD.id, "select staff_create_api_key('TEST SMS gateway', array['notify:send']) as k");
  await r.denies("a channel not set to external can't be claimed", () => one(null, "select api_v1_notifications_claim($1, 'sms')", [k4.k.key]), "invalid_state");
  await t.admin(`update app_settings set value = jsonb_set(value::jsonb, '{providers,sms}', '"external"')::text where key = 'NOTIFY'`);
  try {
    await placeOrder(t, C5.id, "DW", 600);
    const cl = await one<{ r: { data: { id: number; to: string; body: string }[] } }>(null, "select api_v1_notifications_claim($1, 'sms', 500) as r", [k4.k.key]);
    const mine = cl.r.data.find((x) => x.to === "+96893331122");
    r.check("the worker claims queued SMS with the real number (only through the API)", !!mine && mine.body.length > 0, cl.r.data.length);
    const again2 = await one<{ r: { data: unknown[] } }>(null, "select api_v1_notifications_claim($1, 'sms', 10) as r", [k4.k.key]);
    r.check("a claimed message isn't handed out twice while it is being sent", again2.r.data.length === 0, again2.r);
    const rep = await one<{ r: { status: string } }>(null, "select api_v1_notifications_report($1, $2, true, 'SMSC-123', '{\"ok\": true}') as r", [k4.k.key, mine!.id]);
    r.check("the worker reports the provider's answer: sent", rep.r.status === "sent", rep.r);
  } finally {
    await t.admin(`update app_settings set value = jsonb_set(value::jsonb, '{providers,sms}', '"simulated"')::text where key = 'NOTIFY'`);
  }

  // ===================================================================== webhooks
  r.start("WEBHOOK signed outgoing webhooks (0028)");
  await r.denies("plain http URLs are refused", () => one(AD.id, "select staff_create_webhook('TEST', 'http://example.com/hook', array['order.created'])"), "invalid_value");
  const wh = await one<{ w: { id: string; secret: string } }>(AD.id, "select staff_create_webhook('TEST receiver', 'simulate://receiver', array['order.created', 'order.cancelled']) as w");
  await r.denies("nobody reads webhook secrets through the API", () => t.as(AD.id, "select secret_enc from webhook_endpoints"), "permission denied");
  const o2 = await placeOrder(t, C1.id, "DW", 600);
  const [q1] = await t.admin<{ id: string; status: string; payload: { data: { order_no: string } } }>("select id, status, payload from webhook_deliveries where endpoint_id = $1 order by id desc limit 1", [wh.w.id]);
  r.check("an order event queues a delivery for the subscribed endpoint", q1?.status === "queued" && q1.payload.data.order_no === `TO-${o2.order_no}`, q1);
  await t.admin("select webhook_dispatch()");
  const [d1] = await t.admin<{ status: string; signature: string; body: string; response_status: number }>("select status, signature, payload::text as body, response_status from webhook_deliveries where id = $1", [q1.id]);
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(d1.signature);
  const expect = m ? createHmac("sha256", wh.w.secret).update(`${m[1]}.${d1.body}`).digest("hex") : "";
  r.check("it is delivered with an HMAC-SHA256 signature a receiver can verify with the secret", d1.status === "sent" && d1.response_status === 200 && !!m && m[2] === expect, d1.signature);
  r.check("lib/webhooks verifyWebhook accepts it, and rejects a tampered body", verifyWebhook(wh.w.secret, d1.signature, d1.body) && !verifyWebhook(wh.w.secret, d1.signature, d1.body + " "));
  const bad = await one<{ w: { id: string } }>(AD.id, "select staff_create_webhook('TEST failing', 'simulate://fail', array['order.cancelled']) as w");
  await t.admin("update orders set status = 'cancelled' where id = $1", [o2.id]);
  await t.admin("select webhook_dispatch()");
  const [d2] = await t.admin<{ status: string; attempts: number; next_attempt_at: string }>("select status, attempts, next_attempt_at from webhook_deliveries where endpoint_id = $1", [bad.w.id]);
  r.check("a failing receiver is retried later with backoff", d2.status === "queued" && d2.attempts === 1 && Date.parse(d2.next_attempt_at) > Date.now(), d2);
  await one(AD.id, "select staff_set_webhook($1, false)", [bad.w.id]);
  await one(AD.id, "select staff_set_webhook($1, false)", [wh.w.id]);
}
