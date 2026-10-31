// Sign-in, messaging and support (0037–0039): optional ID with an NWS rule, login codes by
// SMS or WhatsApp, transactional vs marketing messages, automatic delay messages, service
// notices, complaint escalation to 1442 and the refund message.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder, setOnline } from "../lib/world";

type Row = Record<string, unknown>;

export async function supportSuite(t: Target, r: Reporter) {
  r.start("SUP sign-in channels, identity rule, delay messages, notices, marketing, escalation (0037–0039)");
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const w = await makeWorld(t, "sup");
  const OP = await t.createUser("sup-op", { role: "customer", full_name: "Test Sup Operator" });
  const AD = await t.createUser("sup-ad", { role: "customer", full_name: "Test Sup Admin" });
  const AG = await t.createUser("sup-ag", { role: "customer", full_name: "Test Sup Agent" });
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'operator' where id = $1", [OP.id]);
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'admin' where id = $1", [AD.id]);
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'complaints_agent' where id = $1", [AG.id]);
  const events = async (uid: string, event: string, order?: string) =>
    t.admin<{ body: string; title: string; channels: string[] }>(
      `select body, title, channels from notifications where user_id = $1 and event = $2 ${order ? "and order_id = $3" : ""} order by id`,
      order ? [uid, event, order] : [uid, event],
    );

  // ---- #10 identity optional, NWS rule ---------------------------------------------------------
  const [idSet] = await t.admin<{ value: string }>("select value from app_settings where key = 'IDENTITY_REQUIRED_FOR'");
  r.check("ID is optional by default (IDENTITY_REQUIRED_FOR is empty)", idSet?.value === "[]", idSet);
  await r.allows("an unverified customer can place an order by default", () => placeOrder(t, w.C2.id, "DW", 1000));
  await r.denies("an unknown scope is refused by the setting", () => t.admin("update app_settings set value = '[\"everything\"]' where key = 'IDENTITY_REQUIRED_FOR'"), "app_settings_identity_required_for");
  await r.denies("customers can't change the rule", () => t.as(w.C1.id, "select staff_update_comms_setting('IDENTITY_REQUIRED_FOR', '[\"all\"]'::jsonb, 'test')"), "not_staff");
  await r.denies("operators can't change the rule (admins only)", () => t.as(OP.id, "select staff_update_comms_setting('IDENTITY_REQUIRED_FOR', '[\"all\"]'::jsonb, 'test')"), "forbidden_for_role");
  await t.as(AD.id, "select staff_update_comms_setting('IDENTITY_REQUIRED_FOR', '[\"household\", \"household\"]'::jsonb, 'Subsidised tariff needs ID')");
  try {
    const [now] = await t.admin<{ value: string }>("select value from app_settings where key = 'IDENTITY_REQUIRED_FOR'");
    r.check("an admin sets it (duplicates dropped, audited)", JSON.parse(now.value).length === 1 && JSON.parse(now.value)[0] === "household", now);
    await r.denies("with 'household' required, an unverified customer can't place an app order", () => placeOrder(t, w.C1.id, "DW", 1000), "identity_required");
    await r.denies("a passport number that is too short is refused", () => t.as(w.C1.id, "select verify_identity('passport', 'X1')"), "id_not_verified");
    const p = await one<{ id_type: string; id_verified: boolean; id_status: string }>(w.C1.id, "select id_type, id_verified, id_status from verify_identity('passport', 'ab 12-345')");
    r.check("a passport is accepted as identity, declared until NWS checks it (0050)", p?.id_type === "passport" && p.id_verified === false && p.id_status === "declared", p);
    await r.denies("a declared (unchecked) number doesn't pass the identity rule", () => placeOrder(t, w.C1.id, "DW", 1000), "identity_required");
    await t.as(AD.id, "select staff_customer_action($1, 'verify_id', 'TEST passport checked against the photo')", [w.C1.id]);
    const [pid] = await t.admin<{ id_no: string | null }>("select public.pii_decrypt(id_no_enc) as id_no from profiles where id = $1", [w.C1.id]);
    r.check("the passport number is stored upper-case without spaces or dashes", pid?.id_no === "AB12345", pid);
    await r.allows("once verified, the customer can order", () => placeOrder(t, w.C1.id, "DW", 1000));
    const cc = await one<{ id_type: string }>(w.C2.id, "select id_type from verify_identity('resident_card', '12345678')");
    r.check("a resident card number is accepted", cc?.id_type === "resident_card", cc);
  } finally {
    await t.admin("update app_settings set value = '[]' where key = 'IDENTITY_REQUIRED_FOR'");
  }

  // ---- #11 login codes by WhatsApp -------------------------------------------------------------
  const phone = "+96890007711";
  await r.denies("a bad number is refused", () => t.as(null, "select request_code_channel('123', 'whatsapp')"), "invalid_phone");
  await r.denies("an unknown channel is refused", () => t.as(null, "select request_code_channel($1, 'telegram')", [phone]), "invalid_channel");
  const ch = await one<{ c: string }>(null, "select request_code_channel('9000 7711', 'whatsapp', 'ar') as c");
  r.check("a signed-out visitor records WhatsApp for their number", ch?.c === "whatsapp", ch);
  await r.denies("clients can't read the channel requests", () => t.as(null, "select * from otp_channel_requests"), "permission denied");
  await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890007711" }, sms: { otp: "445566" } })]);
  const [wa] = await t.admin<{ channel: string; lang: string; body: string; sent_at: string | null; provider: string | null }>(
    "select channel, lang, body, sent_at, provider from sms_outbox where otp = '445566'",
  );
  r.check("the hook sends that code by WhatsApp, in Arabic, from the login_code template", wa?.channel === "whatsapp" && wa.lang === "ar" && wa.body.includes("445566") && wa.body.includes("نماء"), wa);
  r.check("the simulated WhatsApp provider marks it sent", wa?.sent_at != null && wa.provider === "simulated-whatsapp", wa);
  const [log] = await t.admin<{ channel: string; body: string; status: string; destination: string | null; destination_masked: string | null }>(
    "select channel, body, status, destination, destination_masked from notification_outbox where event = 'login_code' order by id desc limit 1",
  );
  r.check("NWS sees the delivery in the outbox with the code hidden and no full number", log?.channel === "whatsapp" && log.status === "sent" && !log.body.includes("445566") && log.body.includes("••••••") && log.destination === null && !!log.destination_masked, log);
  await t.admin("update notification_templates set whatsapp = false where event = 'login_code'");
  await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890007711" }, sms: { otp: "445577" } })]);
  await t.admin("update notification_templates set whatsapp = true where event = 'login_code'");
  const [fb] = await t.admin<{ channel: string }>("select channel from sms_outbox where otp = '445577'");
  r.check("with WhatsApp switched off on the template, the code goes by SMS", fb?.channel === "sms", fb);
  await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890007799" }, sms: { otp: "778899" } })]);
  const [plain] = await t.admin<{ channel: string; lang: string }>("select channel, lang from sms_outbox where otp = '778899'");
  r.check("without a choice the code goes by SMS in English, as before", plain?.channel === "sms" && plain.lang === "en", plain);
  await t.admin("update app_settings set value = 'on' where key = 'DEMO_SMS_CODES'");
  try {
    await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890007711" }, sms: { otp: "445588" } })]);
    const demo = await one<{ c: string | null }>(null, "select demo_sms_code($1) as c", [phone]);
    r.check("demo mode still shows a WhatsApp code on screen", demo?.c === "445588", demo);
  } finally {
    await t.admin("update app_settings set value = 'off' where key = 'DEMO_SMS_CODES'");
  }

  // ---- #21 transactional vs marketing ---------------------------------------------------------
  const cls = await t.admin<{ event: string; message_class: string }>("select event, message_class from notification_templates where event in ('promo_offer', 'tanker_assigned', 'refill_reminder')");
  const byEv = Object.fromEntries(cls.map((c) => [c.event, c.message_class]));
  r.check("every template has a class: marketing for offers, transactional for service and reminders", byEv.promo_offer === "marketing" && byEv.tanker_assigned === "transactional" && byEv.refill_reminder === "transactional", byEv);
  const vars = JSON.stringify({ title: "Weekend offer", body: "10% off the delivery fee" });
  await t.admin("select public.notify($1, 'promo_offer', null, $2::jsonb)", [w.C1.id, vars]);
  r.check("no marketing without the promotions consent", (await events(w.C1.id, "promo_offer")).length === 0);
  await t.admin("update profiles set phone = '+96890007733', prefs = coalesce(prefs, '{}'::jsonb) || '{\"promotions\": true}'::jsonb where id = $1", [w.C1.id]);
  const [{ h }] = await t.admin<{ h: number }>("select extract(hour from now() at time zone 'Asia/Muscat')::int as h");
  const [notify0] = await t.admin<{ value: string }>("select value from app_settings where key = 'NOTIFY'");
  const cfg0 = JSON.parse(notify0.value);
  r.check("NOTIFY has separate transactional and marketing sender IDs", cfg0.sender_ids?.transactional && cfg0.sender_ids?.marketing && cfg0.sender_ids.transactional !== cfg0.sender_ids.marketing, cfg0.sender_ids);
  // Quiet hours around the current Muscat hour, so the check works at any time of day (two hours
  // long: ending at the next full hour would be under a minute away when the run starts at hh:59).
  await t.admin("update app_settings set value = $1 where key = 'NOTIFY'", [JSON.stringify({ ...cfg0, quiet_hours: { start: h, end: (h + 2) % 24 } })]);
  try {
    await t.admin("select public.notify($1, 'promo_offer', null, $2::jsonb)", [w.C1.id, vars]);
    const [mk] = await events(w.C1.id, "promo_offer");
    r.check("with consent the offer is sent and carries the opt-out line", !!mk && mk.body.includes("10% off") && mk.body.includes("STOP"), mk);
    const out = await t.admin<{ channel: string; message_class: string; sender_id: string | null; status: string; later: boolean }>(
      "select channel, message_class, sender_id, status, next_attempt_at > now() + interval '1 minute' as later from notification_outbox where user_id = $1 and event = 'promo_offer'",
      [w.C1.id],
    );
    const sms = out.find((o) => o.channel === "sms");
    r.check("its outbox rows are marked marketing and the SMS uses the marketing sender ID", out.every((o) => o.message_class === "marketing") && sms?.sender_id === cfg0.sender_ids.marketing, out);
    r.check("during the quiet hours the marketing SMS waits for the morning", sms?.status === "queued" && sms.later === true, sms);
    await t.admin("update notification_outbox set next_attempt_at = now() where user_id = $1 and event = 'promo_offer' and channel = 'sms'", [w.C1.id]);
    await t.as(OP.id, "select dispatch_notifications()");
    const [after] = await t.admin<{ status: string; later: boolean }>(
      "select status, next_attempt_at > now() + interval '1 minute' as later from notification_outbox where user_id = $1 and event = 'promo_offer' and channel = 'sms'",
      [w.C1.id],
    );
    r.check("the dispatcher doesn't send it in the quiet hours either (it is put back to the morning)", after?.status === "queued" && after.later === true, after);
    await t.admin("select public.notify($1, 'tanker_assigned', null, '{}'::jsonb)", [w.C1.id]);
    const [tr] = await t.admin<{ sender_id: string | null; message_class: string; later: boolean }>(
      "select sender_id, message_class, next_attempt_at > now() + interval '1 minute' as later from notification_outbox where user_id = $1 and event = 'tanker_assigned' and channel = 'sms'",
      [w.C1.id],
    );
    r.check("transactional SMS goes out at once with the transactional sender ID", tr?.message_class === "transactional" && tr.sender_id === cfg0.sender_ids.transactional && tr.later === false, tr);
  } finally {
    await t.admin("update app_settings set value = $1 where key = 'NOTIFY'", [notify0.value]);
  }
  await r.denies("the same sender ID for both classes is refused", () => t.as(AD.id, "select staff_set_sender_ids('NamaWater', 'namawater', 'test')"), "invalid_sender_id");
  await r.denies("a sender ID longer than 11 characters is refused", () => t.as(AD.id, "select staff_set_sender_ids('NamaWaterServices', 'NamaOffers', 'test')"), "invalid_sender_id");
  await r.denies("operators can't change sender IDs", () => t.as(OP.id, "select staff_set_sender_ids('NamaWater', 'NamaOffers', 'test')"), "forbidden_for_role");
  await t.as(AD.id, "select staff_set_sender_ids('NamaWater', 'NamaPromo', 'Marketing sender registered')");
  const [notify1] = await t.admin<{ value: string }>("select value from app_settings where key = 'NOTIFY'");
  r.check("an admin sets them, keeping the providers", JSON.parse(notify1.value).sender_ids.marketing === "NamaPromo" && JSON.parse(notify1.value).providers?.sms != null);
  await t.admin("update app_settings set value = $1 where key = 'NOTIFY'", [notify0.value]);

  // ---- #19 delay messages -----------------------------------------------------------------------
  await r.denies("customers can't run the delay scan", () => t.as(w.C1.id, "select scan_delay_notices()"), "not_staff");
  const [cron] = await t.admin<{ n: number }>("select count(*)::int as n from cron_wanted where name = 'nama-delay-notices'");
  r.check("the delay scan is registered for pg_cron (cron_wanted)", cron?.n === 1, cron);
  // Unassigned for 30 minutes.
  const u1 = await placeOrder(t, w.C2.id, "DW", 1000);
  await t.admin("update orders set created_at = now() - interval '30 minutes', released_at = null where id = $1", [u1.id]);
  await t.as(OP.id, "select scan_delay_notices()");
  await t.as(OP.id, "select scan_delay_notices()");
  const un = await events(w.C2.id, "order_unassigned", u1.id);
  r.check("an order unassigned 30 minutes after release gets one 'still finding a tanker' message (not one per scan)", un.length === 1 && un[0].body.includes("30"), un);
  await t.as(w.C2.id, "select cancel_order($1)", [u1.id]);

  // ETA slipping on an assigned order.
  await setOnline(t, w.D1.id, true);
  await setOnline(t, w.D2.id, true);
  const e1 = await placeOrder(t, w.C1.id, "DW", 1000);
  await t.as(w.D1.id, "select * from accept_order($1)", [e1.id]);
  await t.as(w.D1.id, "select report_location(23.62, 58.25, 8, now())");
  const [prom] = await t.admin<{ n: number }>("select count(*)::int as n from order_eta_promises where order_id = $1", [e1.id]);
  r.check("assigning a tanker records the ETA promised to the customer", prom?.n === 1, prom);
  await t.admin("update order_eta_promises set promised_at = now() - interval '30 minutes' where order_id = $1", [e1.id]);
  await t.as(OP.id, "select scan_delay_notices()");
  await t.as(OP.id, "select scan_delay_notices()");
  const slip = await events(w.C1.id, "order_eta_slip", e1.id);
  r.check("an ETA that slips past the threshold gets one 'running late' message with the new estimate", slip.length === 1 && /\d\d:\d\d/.test(slip[0].body), slip);

  // Reassigned to another tanker by the control room.
  await t.admin("update orders set tanker_id = $2, driver_id = $3, tanker_plate = $4 where id = $1", [e1.id, w.tk.D2, w.D2.id, w.plate("D2")]);
  await t.as(OP.id, "select scan_delay_notices()");
  await t.as(OP.id, "select scan_delay_notices()");
  const re = await events(w.C1.id, "order_reassigned", e1.id);
  r.check("a reassignment to another tanker is announced once, with the new plate", re.length === 1 && re[0].body.includes(w.plate("D2")), re);

  // The driver gives the job back (breakdown): the status trigger already told the customer.
  await t.as(w.D2.id, "select report_trip_issue($1, 'breakdown', 'test')", [e1.id]);
  await t.as(OP.id, "select scan_delay_notices()");
  const back = await events(w.C1.id, "driver_reassigning", e1.id);
  const [rel] = await t.admin<{ sent: boolean }>("select sent from order_notices where order_id = $1 and kind = 'released'", [e1.id]);
  r.check("a job given back is recorded, and the customer gets one 'finding another tanker' message, not two", back.length === 1 && rel?.sent === false, { back, rel });
  await t.as(w.C1.id, "select cancel_order($1)", [e1.id]);

  // Past the SLA.
  const l1 = await placeOrder(t, w.C2.id, "DW", 1000);
  await t.as(w.D1.id, "select * from accept_order($1)", [l1.id]);
  await t.admin("update orders set created_at = now() - interval '5 hours', released_at = null where id = $1", [l1.id]);
  await t.as(OP.id, "select scan_delay_notices()");
  await t.as(OP.id, "select scan_delay_notices()");
  const late = await events(w.C2.id, "order_late", l1.id);
  r.check("an order past its SLA gets one 'running late' message", late.length === 1, late);
  await t.admin("update orders set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff' where id = $1", [l1.id]);
  await t.as(AD.id, "select staff_update_comms_setting('DELAY_NOTICES', '{\"enabled\": false, \"unassigned_min\": 20, \"eta_slip_min\": 15, \"fill_min\": 20}'::jsonb, 'Pause delay messages')");
  const off = await one<{ s: { enabled: boolean } }>(OP.id, "select scan_delay_notices() as s");
  r.check("NWS can switch the delay messages off", off?.s.enabled === false, off);
  await r.denies("thresholds out of range are refused", () => t.as(AD.id, "select staff_update_comms_setting('DELAY_NOTICES', '{\"enabled\": true, \"unassigned_min\": 1, \"eta_slip_min\": 15, \"fill_min\": 20}'::jsonb, 'test')"), "invalid_value");
  await t.as(AD.id, "select staff_update_comms_setting('DELAY_NOTICES', '{\"enabled\": true, \"unassigned_min\": 20, \"eta_slip_min\": 15, \"fill_min\": 20}'::jsonb, 'Resume')");
  await setOnline(t, w.D1.id, false);
  await setOnline(t, w.D2.id, false);

  // ---- #20 service notices ---------------------------------------------------------------------
  const [z] = await t.admin<{ id: string; name: string }>("select (zone_at(23.6, 58.2)).id as id, (zone_at(23.6, 58.2)).name as name");
  const [other] = await t.admin<{ id: string }>("select id from zones where id <> $1 and not is_test order by name limit 1", [z.id]);
  const n1 = await t.admin<{ zone_id: string | null }>("select zone_id from orders where customer_id = $1 and zone_id is not null limit 1", [w.C1.id]);
  if (!n1.length) await t.admin("update orders set zone_id = $2 where customer_id = $1", [w.C1.id, z.id]);
  const post = (uid: string, scope: string, zones: string[], clusters: string[], notify = false) =>
    t.as<{ id: string; notified: number }>(
      uid,
      "select id, notified from staff_post_notice('Supply disruption in Seeb', 'انقطاع الإمداد في السيب', 'Expect delays', 'توقع تأخيرات', 'warning', $1, $2::uuid[], $3::text[], null, now() + interval '3 hours', $4, 'Pipe burst at Seeb station')",
      [scope, zones, clusters, notify],
    );
  await r.denies("customers can't post notices", () => post(w.C1.id, "all", [], []), "not_staff");
  await r.denies("a zone notice needs zones", () => post(OP.id, "zones", [], []), "invalid_value");
  const [nz] = await post(OP.id, "zones", [z.id], [], true);
  const mine = await t.as<{ id: string; title_ar: string; sites: string[] }>(w.C1.id, "select id, title_ar, sites from my_service_notices()");
  r.check("a customer with orders in the zone sees the notice (with the Arabic text)", mine.some((m) => m.id === nz.id && m.title_ar.includes("السيب")), mine);
  const nobody = await t.as<{ id: string }>(w.D3.id, "select id from my_service_notices()");
  r.check("someone with nothing in the zone doesn't", !nobody.some((m) => m.id === nz.id), nobody);
  const here = await t.as<{ id: string }>(w.D3.id, "select id from my_service_notices(23.6, 58.2)");
  r.check("…until they order for a point in that zone (the request screen)", here.some((m) => m.id === nz.id), here);
  const told = await events(w.C1.id, "service_notice");
  r.check("with 'notify', affected customers get it as a message", told.length === 1 && told[0].title.includes("Seeb") && nz.notified >= 1, { told, nz });
  if (other) {
    const [no] = await post(OP.id, "zones", [other.id], []);
    const sees = await t.as<{ id: string }>(w.C1.id, "select id from my_service_notices()");
    r.check("a notice for another zone isn't shown", !sees.some((m) => m.id === no.id), sees);
    await t.as(OP.id, "select staff_end_notice($1, 'Test notice')", [no.id]);
  }
  await t.as(OP.id, "select staff_end_notice($1, 'Supply restored')", [nz.id]);
  const gone = await t.as<{ id: string }>(w.C1.id, "select id from my_service_notices()");
  r.check("an ended notice disappears", !gone.some((m) => m.id === nz.id), gone);
  await r.denies("a notice can't be ended twice", () => t.as(OP.id, "select staff_end_notice($1, 'again')", [nz.id]), "invalid_state");
  const [all] = await post(OP.id, "all", [], []);
  const allSees = await t.as<{ id: string }>(w.D3.id, "select id from my_service_notices()");
  r.check("an all-areas notice is shown to everyone", allSees.some((m) => m.id === all.id), allSees);
  await t.as(OP.id, "select staff_end_notice($1, 'Test notice')", [all.id]);
  const [cl] = await t.admin<{ code: string | null }>("select g.cluster_code as code from zones z join governorates g on g.code = z.governorate_code where z.id = $1", [z.id]);
  if (cl?.code) {
    const [nc] = await post(OP.id, "clusters", [], [cl.code]);
    const cs = await t.as<{ id: string; areas: { en: string[] } }>(w.C1.id, "select id, areas from my_service_notices()");
    r.check("a cluster notice reaches customers in the cluster's zones and names the cluster", cs.some((m) => m.id === nc.id && m.areas.en.length === 1), cs);
    await t.as(OP.id, "select staff_end_notice($1, 'Test notice')", [nc.id]);
  }
  r.check("customers read notices only through my_service_notices (no rows from the table)", (await t.as(w.C1.id, "select * from service_notices")).length === 0);

  // ---- #33/#34 complaint escalation --------------------------------------------------------------
  const o2 = await placeOrder(t, w.C1.id, "DW", 1000);
  const c = await one<{ id: string; sla_hours: number }>(w.C1.id, "select id, sla_hours from file_complaint($1, 'late_delivery', 'The tanker never came')", [o2.id]);
  r.check("a complaint carries its promised answer time", c?.sla_hours === 24, c);
  await r.denies("another customer can't escalate it", () => t.as(w.C2.id, "select escalate_complaint($1, 'x')", [c.id]), "not_found");
  await r.denies("drivers can't escalate complaints", () => t.as(w.D1.id, "select escalate_complaint($1, 'x')", [c.id]), "forbidden_for_role");
  const esc = await one<{ state: string; priority: string; escalated_by: string }>(w.C1.id, "select state, priority, escalated_by from escalate_complaint($1, 'Nobody called me back')", [c.id]);
  r.check("the customer escalates: escalated, high priority, by the customer", esc?.state === "escalated" && esc.priority === "high" && esc.escalated_by === "customer", esc);
  const rec = await t.as<{ reason: string; from_state: string }>(w.C1.id, "select reason, from_state from complaint_escalations where complaint_id = $1", [c.id]);
  r.check("the escalation is recorded and visible to the customer", rec.length === 1 && rec[0].reason === "Nobody called me back" && rec[0].from_state === "new", rec);
  r.check("another customer can't see it", (await t.as(w.C2.id, "select * from complaint_escalations where complaint_id = $1", [c.id])).length === 0);
  const thread = await t.as<{ body: string }>(w.C1.id, "select body from complaint_notes where complaint_id = $1 order by id", [c.id]);
  r.check("the thread shows the escalation", thread.some((n) => n.body.includes("1442")), thread);
  const agent = await events(AG.id, "complaint_escalated");
  r.check("the complaints agents are notified", agent.length >= 1 && agent[agent.length - 1].title.includes("1442"), agent);
  await r.denies("it can be escalated only once", () => t.as(w.C1.id, "select escalate_complaint($1, 'again')", [c.id]), "already_escalated");
  await t.as(AG.id, "select staff_case_action($1, 'resolve', 'Driver retrained, fee refunded')", [c.id]);
  const reopen = await one<{ state: string; resolved_at: string | null }>(w.C1.id, "select state, resolved_at from escalate_complaint($1, 'Not happy with the answer')", [c.id]);
  r.check("a resolved case escalated again reopens", reopen?.state === "escalated" && reopen.resolved_at === null, reopen);

  // ---- #35 refund message ----------------------------------------------------------------------
  const [ref] = await t.admin<{ title_en: string; body_en: string; body_ar: string }>("select title_en, body_en, body_ar from notification_templates where event = 'refund_issued'");
  r.check("the refund message says the money went to the Nama wallet (EN/AR)", /wallet/i.test(ref.title_en + ref.body_en) && ref.body_ar.includes("محفظ"), ref);
}
