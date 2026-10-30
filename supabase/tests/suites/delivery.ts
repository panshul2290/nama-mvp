// Tender gaps, batch A part 1 (0026): notification delivery pipeline, push tokens,
// expiry and refill reminders, dynamic pricing, auto-dispatch, independent drivers'
// filling credit and the shared SLA rule.
import type { Reporter, Target } from "../lib/harness";
import { giveTanker, makeWorld, placeOrder, setOnline, deliver } from "../lib/world";

type Row = Record<string, unknown>;

export async function deliverySuite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const AD = await mkStaff("dl-ad", "admin");
  const OP = await mkStaff("dl-op", "operator");
  const FI = await mkStaff("dl-fi", "finance");
  const w = await makeWorld(t, "dlv");
  const { C1, D1, D2 } = w;
  const C2 = await t.createUser("dl-c2", { role: "customer", full_name: "Test Notify Customer", phone: "+968 9123 4567" });
  const C3 = await t.createUser("dl-c3", { role: "customer", full_name: "Test Unreachable", phone: "+968 9100 0000" });
  const outbox = (uid: string, event?: string) =>
    t.admin<{ id: string; channel: string; status: string; destination: string | null; destination_masked: string | null; attempts: number; error: string | null; provider_response: Row | null }>(
      `select id, channel, status, destination, destination_masked, attempts, error, provider_response from notification_outbox where user_id = $1 ${event ? "and event = $2" : ""} order by id`,
      event ? [uid, event] : [uid]);

  // ===================================================================== E13 notifications
  r.start("NOTIFY notification outbox, preferences and dispatcher (0026)");
  const o1 = await placeOrder(t, C2.id, "DW", 1000);
  let ob = await outbox(C2.id, "order_confirmed");
  r.check("an order confirmation queues SMS to the account's number (masked on screen) and records push as failed: no device",
    ob.some((x) => x.channel === "sms" && x.status === "queued" && x.destination === "+96891234567" && x.destination_masked === "+968 •••• 4567") &&
      ob.some((x) => x.channel === "push" && x.status === "failed" && /no push token/i.test(x.error ?? "")), ob);
  const [inApp] = await t.admin<{ channels: string[] }>("select channels from notifications where user_id = $1 and event = 'order_confirmed' order by id desc limit 1", [C2.id]);
  r.check("the in-app notification lists the channels it went out on", JSON.stringify(inApp?.channels) === JSON.stringify(["push", "sms"]), inApp);

  await r.denies("anon can't register a push token", () => t.as(null, "select register_push_token('tok-anon-0000000001', 'android')"), "permission denied");
  await r.denies("an unknown platform is refused", () => one(C2.id, "select register_push_token('tok-c2-000000000001', 'symbian')"), "invalid_platform");
  const reg = await one<{ r: Row }>(C2.id, "select register_push_token('fcm-test-c2-0000000001', 'android', 'customer') as r");
  r.check("register_push_token stores the caller's device", reg.r.platform === "android" && (await t.as(C2.id, "select 1 from push_tokens")).length === 1, reg);
  r.check("other users can't see the token", (await t.as(C1.id, "select 1 from push_tokens")).length === 0);
  await one(C1.id, "select register_push_token('fcm-test-c2-0000000001', 'android')");
  r.check("a token registered again by another account moves to that account",
    (await t.admin<{ user_id: string }>("select user_id from push_tokens where token = 'fcm-test-c2-0000000001'"))[0].user_id === C1.id);
  await one(C2.id, "select register_push_token('fcm-test-c2-0000000002', 'android', 'customer')");
  await one(C2.id, "select register_push_token('invalid-test-c2-00000003', 'ios', 'customer')");

  await one(C2.id, "select * from cancel_order($1)", [o1.id]);
  ob = await outbox(C2.id, "order_cancelled");
  r.check("with devices registered, push is queued once per device (token hidden on screen)",
    ob.filter((x) => x.channel === "push" && x.status === "queued").length === 2 && ob.every((x) => x.channel !== "push" || !x.destination_masked?.includes("fcm-test-c2-0000000002")), ob);

  await r.denies("customers can't run the dispatcher", () => one(C2.id, "select dispatch_notifications()"), "not_staff");
  const run1 = await one<{ d: { sent: number; failed: number } }>(OP.id, "select dispatch_notifications() as d");
  ob = await outbox(C2.id, "order_cancelled");
  const sentSms = ob.find((x) => x.channel === "sms");
  r.check("the dispatcher sends through the simulated adapter and records the provider response",
    run1.d.sent >= 2 && sentSms?.status === "sent" && sentSms.provider_response?.simulated === true && sentSms.provider_response?.accepted === true, { run1, sentSms });
  const bad = ob.find((x) => x.channel === "push" && x.status === "failed");
  r.check("an unregistered push token fails for good and the token is revoked",
    /UNREGISTERED/.test(bad?.error ?? "") && (await t.admin("select 1 from push_tokens where token = 'invalid-test-c2-00000003' and revoked_at is not null")).length === 1, bad);

  // Preferences: SMS off — routine messages skip SMS, critical ones still go.
  await t.as(C2.id, "update profiles set prefs = '{\"sms\": false}' where id = auth.uid()");
  const o2 = await placeOrder(t, C2.id, "DW", 600);
  r.check("SMS switched off: the order confirmation goes by push only", !(await outbox(C2.id, "order_confirmed")).some((x) => x.channel === "sms" && x.status === "queued"));
  await one(C2.id, "select * from cancel_order($1)", [o2.id]);
  r.check("… but an order-critical message (cancellation) still goes by SMS",
    (await outbox(C2.id, "order_cancelled")).filter((x) => x.channel === "sms").length === 2);
  await t.as(C2.id, "update profiles set prefs = '{}' where id = auth.uid()");

  // Retries: the simulator can't reach numbers ending 0000.
  await placeOrder(t, C3.id, "DW", 600);
  for (let i = 0; i < 3; i++) {
    await t.admin("update notification_outbox set next_attempt_at = now() where user_id = $1 and status = 'queued'", [C3.id]);
    await one(AD.id, "select dispatch_notifications()");
  }
  const unreachable = (await outbox(C3.id, "order_confirmed")).find((x) => x.channel === "sms");
  r.check("an unreachable number is retried with backoff, then marked failed after 3 attempts", unreachable?.status === "failed" && unreachable.attempts === 3, unreachable);
  const retried = await one<Row>(OP.id, "select * from staff_notify_retry($1)", [unreachable!.id]);
  r.check("staff can retry a failed message (queued again, audited)",
    retried.status === "queued" && (await t.admin("select 1 from audit_log where action = 'notification.retry' and target_id = $1", [String(unreachable!.id)])).length === 1, retried);
  await r.denies("finance can't retry messages", () => one(FI.id, "select * from staff_notify_retry($1)", [unreachable!.id]), "forbidden_for_role");

  // Who sees the outbox.
  r.check("customers can't read the outbox", (await t.as(C2.id, "select id from notification_outbox")).length === 0);
  await r.denies("nobody reads the raw destination through the API", () => t.as(AD.id, "select destination from notification_outbox limit 1"), "permission denied");
  r.check("admins read the outbox with masked destinations", (await t.as(AD.id, "select id, destination_masked from notification_outbox where user_id = $1", [C2.id])).length > 0);
  r.check("finance can't read the outbox (RLS)", (await t.as(FI.id, "select id from notification_outbox")).length === 0);
  const stats = await t.as<{ channel: string; status: string; n: number }>(AD.id, "select * from staff_outbox_stats(7)");
  r.check("outbox counts are aggregated in the database", stats.some((s) => s.channel === "sms" && s.status === "sent" && s.n >= 1), stats);
  const test = await one<Row>(AD.id, "select * from staff_notify_test('email')");
  r.check("an admin's test email fails visibly when the account has an email… or queues", test.channel === "email" && ["queued", "failed"].includes(String(test.status)), test);
  await r.denies("only admins send test messages", () => one(OP.id, "select * from staff_notify_test('sms')"), "forbidden_for_role");

  // Channel off in settings.
  await t.adminRollback(async (q) => {
    await q(`update app_settings set value = jsonb_set(value::jsonb, '{providers,sms}', '"off"')::text where key = 'NOTIFY'`);
    await q("update notification_outbox set status = 'queued', attempts = 0, next_attempt_at = now() where id = $1", [unreachable!.id]);
    await q("select dispatch_notifications()");
    const [x] = await q<{ status: string; error: string }>("select status, error from notification_outbox where id = $1", [unreachable!.id]);
    r.check("a channel switched off in NWS settings fails its messages with that reason", x.status === "failed" && /switched off/.test(x.error), x);
    await q(`update app_settings set value = jsonb_set(value::jsonb, '{providers,sms}', '"external"')::text where key = 'NOTIFY'`);
    await q("update notification_outbox set status = 'queued', attempts = 0, next_attempt_at = now() where id = $1", [unreachable!.id]);
    const [d] = await q<{ d: { external: number } }>("select dispatch_notifications() as d");
    const [y] = await q<{ status: string }>("select status from notification_outbox where id = $1", [unreachable!.id]);
    r.check("an 'external' channel is left queued for the outside worker", y.status === "queued" && d.d.external >= 1, { d, y });
  });

  await r.denies("NOTIFY: an unknown provider is refused", () => one(AD.id, `select staff_update_setting('NOTIFY', '{"providers": {"push": "fcm", "sms": "simulated", "whatsapp": "simulated", "email": "simulated"}, "max_attempts": 3}', 'TEST')`), "invalid_value");
  await r.denies("DISPATCH: out-of-range weights are refused", () => one(AD.id, `select staff_update_setting('DISPATCH', '{"speed_kmh": 0, "max_km": 40, "weight_jobs": 6, "weight_rating": 5, "max_offers": 5}', 'TEST')`), "invalid_value");
  await r.denies("only admins change delivery settings", () => one(OP.id, `select staff_update_setting('SLA', '{"asap_minutes": 90, "target_pct": 0.9}', 'TEST')`), "forbidden_for_role");

  // ===================================================================== D12 / F6 reminders
  r.start("REMIND permit, document and refill reminders (0026)");
  await t.admin("update permits set expires_at = now() + interval '10 days' where tanker_id = $1 and status = 'approved'", [w.tk.D1]);
  await t.admin("insert into tanker_documents (tanker_id, kind, ref_no, valid_to) values ($1, 'insurance', 'TST-INS', current_date + 5)", [w.tk.D1]);
  const j1 = await one<{ j: { permits: number; documents: number } }>(AD.id, "select run_daily_jobs() as j");
  const pexp = await t.admin("select 1 from notifications where user_id = $1 and event = 'permit_expiring'", [D1.id]);
  const dexp = await t.admin("select 1 from notifications where user_id = $1 and event = 'document_expiring'", [D1.id]);
  r.check("an independent tanker's permit expiring in 10 days reminds its driver", j1.j.permits >= 1 && pexp.length === 1, { j1, pexp });
  r.check("an insurance document expiring in 5 days reminds the driver", dexp.length === 1, dexp);
  await one(AD.id, "select run_daily_jobs()");
  r.check("running the job again sends no duplicate (one reminder per stage)",
    (await t.admin("select 1 from notifications where user_id = $1 and event in ('permit_expiring', 'document_expiring')", [D1.id])).length === 2);
  await r.denies("operators can't run the daily jobs by hand", () => one(OP.id, "select run_daily_jobs()"), "forbidden_for_role");
  await t.admin("update permits set expires_at = now() + interval '365 days' where tanker_id = $1 and status = 'approved'", [w.tk.D1]);

  const prop = await one<{ id: string }>(C2.id, "select id from save_property(null, 'TEST villa', 'TEST address', 'Seeb', 23.6, 58.2, 3000)");
  for (const daysAgo of [21, 14, 7]) {
    await t.admin("insert into orders (customer_id, service_type, gallons, area, property_id, status, delivered_at) values ($1, 'DW', 1000, 'TEST automated check', $2, 'delivered', now() - make_interval(days => $3))",
      [C2.id, prop.id, daysAgo]);
  }
  const [pred] = await t.admin<{ avg_gap_days: string; deliveries: number }>("select * from refill_predictions() where property_id = $1", [prop.id]);
  r.check("refill prediction: 3 deliveries a week apart → usual interval 7 days", pred?.deliveries === 3 && Number(pred.avg_gap_days) === 7, pred);
  await one(AD.id, "select run_daily_jobs()");
  const rem = await t.admin<{ body: string }>("select body from notifications where user_id = $1 and event = 'refill_reminder'", [C2.id]);
  r.check("a property due for its refill gets a reminder naming the property and interval", rem.length === 1 && rem[0].body.includes("TEST villa") && rem[0].body.includes("7 days"), rem);
  await one(AD.id, "select run_daily_jobs()");
  r.check("… once per predicted refill", (await t.admin("select 1 from notifications where user_id = $1 and event = 'refill_reminder'", [C2.id])).length === 1);
  const prop2 = await one<{ id: string }>(C3.id, "select id from save_property(null, 'TEST flat', 'TEST address', 'Seeb', 23.6, 58.2, 3000)");
  for (const daysAgo of [20, 10]) {
    await t.admin("insert into orders (customer_id, service_type, gallons, area, property_id, status, delivered_at) values ($1, 'DW', 1000, 'TEST automated check', $2, 'delivered', now() - make_interval(days => $3))",
      [C3.id, prop2.id, daysAgo]);
  }
  await t.as(C3.id, "update profiles set prefs = '{\"reminders\": false}' where id = auth.uid()");
  await one(AD.id, "select run_daily_jobs()");
  r.check("no reminder without consent (reminders switched off)", (await t.admin("select 1 from notifications where user_id = $1 and event = 'refill_reminder'", [C3.id])).length === 0);

  // ===================================================================== E18 / D14 pricing
  r.start("DYNPRICE distance and demand pricing (0026)");
  const offPeak = "(current_date + 1 + time '06:00') at time zone 'UTC'";
  const near = await one<{ q: Row & { factors: Row } }>(C1.id, `select quote_order('DW', 1000, ${offPeak}, false, null, 23.6, 58.2) as q`);
  r.check("near a station (Seeb, ~7 km): distance factor 1, fee unchanged (3.500)", near.q.delivery_fee === 3.5 && near.q.factors.distance_mult === 1 && Number(near.q.factors.distance_km) < 15, near.q.factors);
  const far = await one<{ q: Row & { factors: Row } }>(C1.id, `select quote_order('DW', 1000, ${offPeak}, false, null, 23.2, 58.0) as q`);
  r.check("~48 km from the nearest station: distance factor capped at 1.5 → fee 5.250, earnings 4.463",
    far.q.factors.distance_mult === 1.5 && far.q.delivery_fee === 5.25 && far.q.driver_earnings === 4.463 && (far.q.rules_used as string[]).includes("distance_per_km"), far.q);
  const noPin = await one<{ q: Row & { factors: Row } }>(C1.id, `select quote_order('DW', 1000, ${offPeak}) as q`);
  r.check("without a pin the quote is neutral and says so", noPin.q.factors.located === false && noPin.q.factors.distance_mult === 1, noPin.q.factors);
  const [farOrder] = await t.as<Row & { price_basis: { factors: Row } }>(C1.id,
    `select * from create_order('DW', 1000, 23.2, 58.0, 'TEST automated check', 'TEST', null, ${offPeak}, ${offPeak} + interval '1 hour', 'TEST slot', false, null, 'card', '4417')`);
  r.check("the order is priced with the same factors as its quote (fee 5.250, factors in price_basis)",
    farOrder.delivery_fee === "5.250" && farOrder.price_basis.factors.distance_mult === 1.5 && farOrder.driver_earnings === "4.463", { fee: farOrder.delivery_fee, f: farOrder.price_basis.factors });
  await t.admin("update orders set status = 'cancelled' where id = $1", [farOrder.id]);

  await t.adminRollback(async (q) => {
    await q("update pricing_rules set value = '1' where rule_key = 'demand_min_open'");
    await q("update pricing_rules set value = '0.5' where rule_key = 'demand_ratio_threshold'");
    await q("insert into orders (customer_id, service_type, gallons, area, zone_id, status) select $1, 'TE', 3000, 'TEST automated check', (zone_at(23.6, 58.2)).id, 'requested' from generate_series(1, 3)", [C1.id]);
    const [f] = await q<{ f: { open_requests: number; online_tankers: number; demand_ratio: number; demand_mult: number } }>("select price_factors('TE', 23.6, 58.2, null) as f");
    const expect = Math.min(1 + (f.f.demand_ratio - 0.5) * 0.1, 1.3);
    r.check("demand: open requests per online tanker above the threshold raise the fee (capped)",
      f.f.open_requests >= 3 && f.f.demand_mult > 1 && Math.abs(f.f.demand_mult - Math.round(expect * 1000) / 1000) < 0.0011, f.f);
    await q("update app_settings set value = 'production' where key = 'BILLING_MODE'");
    await q("update pricing_rules set status = 'confirmed' where rule_key in ('vat_rate', 'driver_share', 'peak_multiplier')");
    await q("update delivery_charges set status = 'confirmed' where service_type = 'TE'");
    let err = "";
    try {
      await q("savepoint s");
      await q("insert into orders (customer_id, service_type, gallons, area, zone_id) values ($1, 'TE', 3000, 'TEST automated check', (zone_at(23.6, 58.2)).id)", [C1.id]);
    } catch (e) {
      err = (e as Error).message;
      await q("rollback to savepoint s");
    }
    r.check("production mode names the demand rules when they price an order", err.includes("pricing_unconfirmed") && err.includes("demand_step"), err);
  });

  await r.denies("a cap outside its bounds is refused", () => one(FI.id, "select * from staff_update_pricing_rule('distance_cap', '9', 'assumption', 'TEST', 'TEST reason')"), "invalid_value");
  await t.adminRollback(async (q) => {
    await q("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [FI.id, JSON.stringify({ sub: FI.id, role: "authenticated" })]);
    await q("set local role authenticated");
    const [x] = await q<{ value: string }>("select value from staff_update_pricing_rule('demand_cap', '1.2', 'assumption', 'TEST', 'TEST reason')");
    r.check("finance edits a demand cap within bounds", x.value === "1.2", x);
  });
  await r.denies("customers can't edit pricing", () => one(C1.id, "select * from staff_update_pricing_rule('distance_cap', '1.2', 'assumption', 'TEST', 'TEST')"), "not_staff");

  // ===================================================================== I6 auto-dispatch
  r.start("DISPATCH ranking and auto-offer (0026)");
  for (const d of [D1, D2]) await setOnline(t, d.id, true);
  // Other test tankers from earlier suites go quiet (stale fix), so the ranking below is about D1 and D2.
  await t.admin("update tankers set last_fix_at = now() - interval '1 hour' where plate like 'TST%' and id <> all($1::uuid[])", [[w.tk.D1, w.tk.D2]]);
  await t.admin("update tankers set last_lat = 23.605, last_lng = 58.205, last_fix_at = now() where id = $1", [w.tk.D1]); // ~0.7 km
  await t.admin("update tankers set last_lat = 23.65, last_lng = 58.25, last_fix_at = now() where id = $1", [w.tk.D2]);   // ~7 km
  const job = await placeOrder(t, C1.id, "DW", 1000);
  const cand = await t.as<{ tanker_id: string; eligible: boolean; reasons: string[]; blockers: string[] }>(OP.id, "select * from dispatch_candidates($1, 50)", [job.id]);
  r.check("dispatch_candidates ranks the nearest eligible tanker first, with reasons", cand[0]?.tanker_id === w.tk.D1 && cand[0].eligible && cand[0].reasons.some((x) => /km · ETA/.test(x)), cand.slice(0, 2));
  r.check("other services are never candidates", !cand.some((c) => c.tanker_id === w.tk.D3));
  const big = await placeOrder(t, C1.id, "DW", 4000);
  const cb = await t.as<{ tanker_id: string; eligible: boolean; blockers: string[] }>(OP.id, "select * from dispatch_candidates($1, 50)", [big.id]);
  r.check("a tanker too small for the order is listed as ineligible with the reason",
    cb.some((c) => c.tanker_id === w.tk.D1 && !c.eligible && c.blockers.some((b) => b.startsWith("Capacity"))), cb.filter((c) => c.tanker_id === w.tk.D1));
  await t.admin("update orders set status = 'cancelled' where id = $1", [big.id]);
  await r.denies("customers can't see the ranking", () => one(C1.id, "select * from dispatch_candidates($1)", [job.id]), "not_staff");

  const [zone] = await t.admin<{ id: string }>("select (zone_at(23.6, 58.2)).id as id");
  if (t.name === "supabase") {
    // Switching auto-offer on a real zone would offer real orders to test tankers.
    r.skip("auto-offer rounds", "changes a real zone's dispatch setting; PGlite only");
    await one(D2.id, "select * from accept_order($1)", [job.id]);
  } else {
  await r.denies("finance can't change zone dispatch", () => one(FI.id, "select * from staff_set_zone_dispatch($1, true, 30, 'TEST')", [zone.id]), "forbidden_for_role");
  await one(OP.id, "select * from staff_set_zone_dispatch($1, true, 30, 'TEST auto-offer on')", [zone.id]);
  await t.admin("select advance_offers()"); // as pg_cron runs it
  const [offered] = await t.admin<{ offer_state: string; offer_tanker_id: string }>("select offer_state, offer_tanker_id from orders where id = $1", [job.id]);
  r.check("with auto-offer on, the order is offered to the best tanker first", offered.offer_state === "offering" && offered.offer_tanker_id === w.tk.D1, offered);
  r.check("the driver is told (job_offered)", (await t.admin("select 1 from notifications where user_id = $1 and event = 'job_offered' and order_id = $2", [D1.id, job.id])).length === 1);
  const d1sees = await one<{ offer_expires_at: string | null }>(D1.id, "select offer_expires_at from open_requests_near(23.605, 58.205) where id = $1", [job.id]);
  r.check("the offered driver sees it with its deadline", !!d1sees?.offer_expires_at, d1sees);
  r.check("other drivers don't see it while it's on offer", (await t.as(D2.id, "select 1 from open_requests_near(23.65, 58.25) where id = $1", [job.id])).length === 0);
  await r.denies("another driver can't take it during the offer", () => one(D2.id, "select * from accept_order($1)", [job.id]), "offered_to_another_tanker");
  await one(D1.id, "select decline_offer($1)", [job.id]);
  const [next] = await t.admin<{ offer_tanker_id: string }>("select offer_tanker_id from orders where id = $1", [job.id]);
  r.check("declining passes it to the next tanker", next.offer_tanker_id === w.tk.D2, next);
  await t.admin("update orders set offer_expires_at = now() - interval '1 second' where id = $1", [job.id]);
  await t.admin("select advance_offers()"); // as pg_cron runs it
  const [pool] = await t.admin<{ offer_state: string; offered_tankers: string[] }>("select offer_state, offered_tankers from orders where id = $1", [job.id]);
  r.check("when every eligible tanker has had its turn, the order goes to the open pool", pool.offer_state === "pool" && pool.offered_tankers.length === 2, pool);
  const took = await one<Row>(D2.id, "select * from accept_order($1)", [job.id]);
  r.check("from the pool any eligible driver can take it; the offer is cleared", took.status === "accepted" && took.offer_tanker_id === null, took);
  await one(OP.id, "select * from staff_set_zone_dispatch($1, false, 45, 'TEST auto-offer off')", [zone.id]);
  }
  await one(D2.id, "select * from mark_arrived($1)", [job.id]);
  await deliver(t, D2.id, job.id);

  // ===================================================================== D8 filling credit
  r.start("FILLCREDIT independent drivers' filling credit (0026)");
  const fc0 = await one<{ c: { independent: boolean; balance: number } }>(D1.id, "select my_fill_credit() as c");
  r.check("an independent driver has a filling-credit balance (0)", fc0.c.independent === true && Number(fc0.c.balance) === 0, fc0);
  await r.denies("a declined card doesn't top up", () => one(D1.id, "select driver_topup_fill_credit(20, '0002')"), "card_declined");
  await r.denies("customers can't top up filling credit", () => one(C1.id, "select driver_topup_fill_credit(20)"), "not_a_driver");
  await r.denies("top-ups below the minimum are refused", () => one(D1.id, "select driver_topup_fill_credit(1)"), "invalid_amount");
  const fc1 = await one<{ c: { balance: number } }>(D1.id, "select driver_topup_fill_credit(20) as c");
  r.check("a simulated card top-up credits the ledger", Number(fc1.c.balance) === 20, fc1);
  const fillJob = await placeOrder(t, C1.id, "DW", 1000);
  await one(D1.id, "select * from accept_order($1)", [fillJob.id]);
  await one(D1.id, "select * from confirm_fill($1)", [fillJob.id]);
  const fc2 = await one<{ c: { balance: number; recent: { kind: string; amount: number }[] } }>(D1.id, "select my_fill_credit() as c");
  r.check("confirm_fill deducts the water charge (1.700) from the driver's credit", Number(fc2.c.balance) === 18.3 && fc2.c.recent[0].kind === "fill_charge", fc2.c);
  r.check("other drivers can't see the ledger", (await t.as(D2.id, "select 1 from driver_tx where driver_id = $1", [D1.id])).length === 0);
  const D4 = await t.createUser("dl-d4", { role: "driver", full_name: "Test Driver Four" });
  await giveTanker(t, D4.id, w.plate("D4"), "DW", 5000);
  await setOnline(t, D4.id, true);
  await t.admin("update tankers set last_lat = 23.6, last_lng = 58.2, last_fix_at = now() where id = (select tanker_id from tanker_assignments where driver_id = $1 and unassigned_at is null)", [D4.id]);
  const dry = await placeOrder(t, C1.id, "DW", 1000);
  await one(D4.id, "select * from accept_order($1)", [dry.id]);
  await r.denies("without enough credit an independent driver can't confirm a fill", () => one(D4.id, "select * from confirm_fill($1)", [dry.id]), "insufficient_fill_credit");
  const list = await t.as<{ driver_id: string; balance: string }>(FI.id, "select * from staff_driver_fill_credit()");
  r.check("NWS finance lists independent drivers' balances", list.some((x) => x.driver_id === D1.id && Number(x.balance) === 18.3) && list.some((x) => x.driver_id === D4.id), list.length);
  await r.denies("customers can't list balances", () => one(C1.id, "select * from staff_driver_fill_credit()"), "not_staff");

  // ===================================================================== E17 SLA
  r.start("SLA one on-time rule (0026)");
  const s1 = await one<{ s: { state: string; basis: string; due_at: string } }>(C1.id, "select my_order_sla($1) as s", [dry.id]);
  r.check("my_order_sla: an ASAP order is due 120 min after it was placed", s1.s.basis === "asap" && ["on_track", "at_risk"].includes(s1.s.state), s1.s);
  await r.denies("another customer can't read it", () => one(C2.id, "select my_order_sla($1)", [dry.id]), "not_found");
  await t.admin("update orders set slot_end = delivered_at - interval '10 minutes' where id = $1", [job.id]);
  const s2 = await one<{ s: { state: string; minutes_late: number } }>(C1.id, "select my_order_sla($1) as s", [job.id]);
  r.check("delivered 10 minutes after the slot ended → late by 10 min", s2.s.state === "late" && s2.s.minutes_late === 10, s2.s);
  const s3 = await one<{ s: { state: string } }>(D2.id, "select my_order_sla($1) as s", [job.id]);
  r.check("the driver sees the same SLA state", s3.s.state === "late", s3.s);
  const [col] = await t.as<{ sla_state: string }>(C1.id, "select public.sla_state(o) as sla_state from orders o where o.id = $1", [job.id]);
  r.check("the same rule is available as a computed column for portal queries", col.sla_state === "late", col);
}
