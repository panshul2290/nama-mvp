// Billing never blocks a delivery, fallback contacts, delivery windows, scheduled and recurring
// orders, charity sponsorship (0043–0045).
import type { Reporter, Target } from "../lib/harness";
import { deliver, makeWorld, setOnline } from "../lib/world";

type Row = Record<string, unknown>;
type O = Row & { id: string; order_no: number; status: string; payment_status: string; payment_followup: string | null; total: string };
const LAT = 23.6;
const LNG = 58.2;

export async function resilienceSuite(t: Target, r: Reporter) {
  r.start("PAY billing never blocks delivery; SCH windows, scheduled and recurring orders; CHR sponsorship (0043–0045)");
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const w = await makeWorld(t, "res");
  const FI = await t.createUser("res-fi", { role: "customer", full_name: "Test Res Finance" });
  const OP = await t.createUser("res-op", { role: "customer", full_name: "Test Res Operator" });
  const AD = await t.createUser("res-ad", { role: "customer", full_name: "Test Res Admin" });
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'finance' where id = $1", [FI.id]);
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'operator' where id = $1", [OP.id]);
  await t.admin("update profiles set role = 'nws_staff', staff_role = 'admin' where id = $1", [AD.id]);
  const order = (uid: string, method: string, card: string | null = null, slot: [string, string] | null = null) =>
    one<O>(uid, `select * from create_order(p_service_type => 'DW', p_gallons => 1000, p_lat => $1, p_lng => $2, p_area => 'TEST area', p_address => 'TEST address',
                 p_pay_method => $3, p_card_last4 => $4, p_slot_start => $5, p_slot_end => $6)`, [LAT, LNG, method, card, slot?.[0] ?? null, slot?.[1] ?? null]);
  const wallet = async (uid: string) => Number((await one<{ w: { balance: string } }>(uid, "select my_wallet() as w")).w.balance);
  await setOnline(t, w.D1.id, true);
  await t.as(w.D1.id, "select report_location($1, $2, 8, now())", [LAT + 0.01, LNG]);
  let fixN = 1;
  const ping = () => t.as(w.D1.id, `select report_location($1, $2, 8, now() + interval '${fixN++} seconds')`, [LAT + 0.01, LNG]);
  const visible = async (id: string) => (await t.as<{ id: string }>(w.D1.id, "select id from open_requests_near($1, $2)", [LAT, LNG])).some((x) => x.id === id);
  const eligible = async (id: string) => (await t.as<{ tanker_id: string; eligible: boolean }>(OP.id, "select tanker_id, eligible from dispatch_candidates($1, 20)", [id])).find((c) => c.tanker_id === w.tk.D1)?.eligible === true;

  // ---- #26 settings ---------------------------------------------------------------------------------------
  const [mode] = await t.admin<{ value: string }>("select value from app_settings where key = 'PAYMENT_OUTAGE_MODE'");
  r.check("PAYMENT_OUTAGE_MODE is off by default", mode?.value === "off", mode);
  await r.denies("customers can't switch it", () => t.as(w.C1.id, "select staff_set_payment_outage(true, 'test')"), "not_staff");
  await r.denies("operators can't switch it (finance and admins)", () => t.as(OP.id, "select staff_set_payment_outage(true, 'test')"), "forbidden_for_role");
  await r.denies("it only takes on/off", () => t.admin("update app_settings set value = 'maybe' where key = 'PAYMENT_OUTAGE_MODE'"), "app_settings_payment_outage_mode");

  // An explicit card decline at checkout is still the customer's choice to retry.
  const dec = await order(w.C1.id, "card", "0002");
  r.check("outside an outage, a declined card at checkout cancels the order (the customer retries)", dec.status === "cancelled" && dec.payment_status === "failed", dec);

  // ---- dispatch is never blocked by payment state --------------------------------------------------------
  for (const st of ["pending", "authorized", "on_account", "failed", "captured"]) {
    const o = await order(w.C2.id, "card");
    await t.admin("update orders set payment_status = $2 where id = $1", [o.id, st]);
    r.check(`an open order with payment ${st} is offered to drivers and ranked eligible`, (await visible(o.id)) && (await eligible(o.id)));
    await t.as(w.C2.id, "select cancel_order($1)", [o.id]);
  }

  // ---- outage: pay later, the order proceeds through every step -------------------------------------------
  await t.as(FI.id, "select staff_set_payment_outage(true, 'Gateway outage drill')");
  let paid: O;
  try {
    const pl = await order(w.C1.id, "card", "0002");
    r.check("during an outage a card order goes ahead as pay later (no decline possible), flagged for finance", pl.status === "requested" && pl.payment_status === "pending" && pl.payment_followup === "outage_pay_later", pl);
    const [pay] = await t.admin<{ status: string; gateway_ref: string }>("select status, gateway_ref from payments where order_id = $1", [pl.id]);
    r.check("its payment is queued (PAYLATER-…), not sent to the gateway", pay.status === "pending" && pay.gateway_ref.startsWith("PAYLATER-"), pay);
    r.check("the customer is told it's going ahead", (await t.admin("select 1 from notifications where order_id = $1 and event = 'pay_later'", [pl.id])).length === 1);
    await t.admin("select confirm_simulated_payments()");
    const [still] = await t.admin<{ status: string }>("select status from payments where order_id = $1", [pl.id]);
    r.check("the simulated gateway doesn't confirm pay-later payments by itself", still.status === "pending", still);
    r.check("dispatch: offered and eligible", (await visible(pl.id)) && (await eligible(pl.id)));
    await r.allows("acceptance proceeds", () => t.as(w.D1.id, "select * from accept_order($1)", [pl.id]));
    await ping();
    await r.allows("arrival proceeds", () => t.as(w.D1.id, "select status from mark_arrived($1)", [pl.id]));
    const dl = await deliver(t, w.D1.id, pl.id);
    r.check("proof of delivery completes the job", dl?.status === "delivered", dl);
    paid = (await t.admin<O>("select * from orders where id = $1", [pl.id]))[0];
    r.check("delivered with the payment still pending and the follow-up open", paid.payment_status === "pending" && paid.payment_followup === "outage_pay_later", paid);

    // wallet + card: the wallet part is taken, the card part waits; cancelling gives the wallet part back.
    // Exactly 2 OMR in the wallet (earlier cancellations refunded into it).
    await t.admin("insert into wallet_tx (customer_id, kind, amount, memo) values ($1, 'adjustment', 2 - public.wallet_balance($1), 'TEST set balance')", [w.C2.id]);
    const wc = await order(w.C2.id, "wallet_card");
    const [wcp] = await t.admin<{ wallet_amount: string; card_amount: string; status: string }>("select wallet_amount, card_amount, status from payments where order_id = $1", [wc.id]);
    r.check("wallet + card during an outage: 2 OMR from the wallet, the rest pay later", Number(wcp.wallet_amount) === 2 && Number(wcp.card_amount) > 0 && wcp.status === "pending" && (await wallet(w.C2.id)) === 0, wcp);
    await t.as(w.C2.id, "select cancel_order($1)", [wc.id]);
    const [wco] = await t.admin<O & { payment_followup_resolved_at: string | null }>("select * from orders where id = $1", [wc.id]);
    r.check("cancelled before payment: the wallet part is refunded and the follow-up closes", (await wallet(w.C2.id)) === 2 && wco.payment_followup_resolved_at !== null, wco);
  } finally {
    await t.as(FI.id, "select staff_set_payment_outage(false, 'Gateway back')");
  }
  r.check("switching the mode is audited", (await t.admin("select 1 from audit_log where target_id = 'PAYMENT_OUTAGE_MODE'")).length === 2);

  // ---- confirming payments (card 0003) and the follow-up scan ---------------------------------------------
  const cf = await order(w.C2.id, "card", "0003");
  r.check("a payment the gateway confirms later: the order is open for dispatch meanwhile", cf.payment_status === "pending" && (await visible(cf.id)));
  await t.admin("update orders set created_at = now() - interval '15 minutes' where id = $1", [cf.id]);
  await t.admin("select scan_payment_followups()");
  r.check("still pending after 10 minutes → flagged 'payment_pending'", (await t.admin<O>("select * from orders where id = $1", [cf.id]))[0].payment_followup === "payment_pending");
  await t.admin("update payments set created_at = now() - interval '1 minute' where order_id = $1", [cf.id]);
  await t.admin("select confirm_simulated_payments()");
  await t.admin("select scan_payment_followups()");
  const [cfo] = await t.admin<{ payment_followup_resolved_at: string | null; payment_status: string }>("select payment_followup_resolved_at, payment_status from orders where id = $1", [cf.id]);
  r.check("once the payment is confirmed the follow-up closes by itself", cfo.payment_status === "authorized" && cfo.payment_followup_resolved_at !== null, cfo);
  await t.as(w.C2.id, "select cancel_order($1)", [cf.id]);

  // ---- finance view --------------------------------------------------------------------------------------
  await r.denies("customers can't see the follow-ups", () => t.as(w.C1.id, "select * from staff_payment_followups()"), "not_staff");
  const open = await t.as<{ order_id: string; reason: string; delivered_at: string | null }>(FI.id, "select order_id, reason, delivered_at from staff_payment_followups('open')");
  r.check("finance lists the open follow-ups (the delivered pay-later order)", open.some((x) => x.order_id === paid.id && x.reason === "outage_pay_later" && x.delivered_at), open);
  await r.denies("resolving needs a reason", () => t.as(FI.id, "select * from staff_resolve_payment_followup($1, 'paid', '')", [paid.id]), "reason");
  await r.denies("operators can't resolve", () => t.as(OP.id, "select * from staff_resolve_payment_followup($1, 'paid', 'Collected by phone')", [paid.id]), "forbidden_for_role");
  const res = await one<O>(FI.id, "select * from staff_resolve_payment_followup($1, 'paid', 'Collected by card link')", [paid.id]);
  const [cap] = await t.admin<{ status: string }>("select status from payments where order_id = $1", [paid.id]);
  r.check("finance marks it paid: the payment is captured and the follow-up resolved", res.payment_status === "captured" && cap.status === "captured", { res, cap });
  await r.denies("it can't be resolved twice", () => t.as(FI.id, "select * from staff_resolve_payment_followup($1, 'waived', 'again')", [paid.id]), "invalid_state");

  // ---- contract auto-pay failure ----------------------------------------------------------------------------
  const [co] = await t.admin<{ id: string }>("insert into companies (name, cr_no) values ('TST Res Transport', $1) returning id", [`TSTRES${t.runId.slice(-5)}`]);
  await t.admin("update tankers set company_id = $1 where id = $2", [co.id, w.tk.D2]);
  const pr = await one<{ id: string }>(w.C2.id, "select id from save_property(null, 'Farm', 'TEST', 'TEST area', $1, $2, 5000)", [LAT, LNG]);
  await t.admin("insert into payment_methods (customer_id, brand, last4, is_default) values ($1, 'Visa', '0002', true)", [w.C2.id]);
  const [k] = await t.admin<{ id: string }>(
    "insert into contracts (customer_id, property_id, company_id, service_type, gallons, frequency, plan, start_date, end_date, status) values ($1, $2, $3, 'DW', 1000, 'weekly', 'monthly', current_date + 1, current_date + 60, 'active') returning id",
    [w.C2.id, pr.id, co.id]);
  await t.admin("select generate_contract_orders($1)", [k.id]);
  const ko = await t.admin<O>("select * from orders where contract_id = $1", [k.id]);
  r.check("a household contract delivery with a declined saved card is still booked, payment pending, follow-up 'autopay_failed'",
    ko.length >= 1 && ko.every((x) => x.status === "scheduled" && x.payment_status === "pending" && x.payment_followup === "autopay_failed"), ko);
  r.check("…and the customer is told", (await t.admin("select 1 from notifications where user_id = $1 and event = 'autopay_failed'", [w.C2.id])).length >= 1);
  await t.admin("update contracts set status = 'ended' where id = $1", [k.id]);
  await t.admin("update orders set status = 'cancelled', cancelled_at = now() where contract_id = $1", [k.id]);

  // ---- #27 support contacts ----------------------------------------------------------------------------------
  const [sc] = await t.admin<{ value: string }>("select value from app_settings where key = 'SUPPORT_CONTACTS'");
  r.check("the call centre is 1442 by default and the WhatsApp number is empty until NWS sets it", JSON.parse(sc.value).call_centre === "1442" && JSON.parse(sc.value).whatsapp === "", sc);
  r.check("the apps can read the contacts", (await t.as(w.C1.id, "select value from app_settings where key = 'SUPPORT_CONTACTS'")).length === 1);
  await r.denies("a WhatsApp number must be a mobile", () => t.as(AD.id, "select staff_set_support_contacts('{\"call_centre\": \"1442\", \"whatsapp\": \"12\"}'::jsonb, 'test')"), "invalid_phone");
  await r.denies("the public address must be https", () => t.as(AD.id, "select staff_set_support_contacts('{\"call_centre\": \"1442\", \"public_url\": \"http://x.om\"}'::jsonb, 'test')"), "invalid_value");
  const scs = await one<{ v: { whatsapp: string; public_url: string } }>(AD.id, "select staff_set_support_contacts('{\"call_centre\": \"1442\", \"whatsapp\": \"9000 1442\", \"public_url\": \"https://tanker.nama.om/\"}'::jsonb, 'Booking line') as v");
  r.check("an admin sets them (WhatsApp normalised, trailing slash dropped)", scs?.v.whatsapp === "+96890001442" && scs.v.public_url === "https://tanker.nama.om", scs);
  await t.admin("update app_settings set value = $1 where key = 'SUPPORT_CONTACTS'", [sc.value]);

  // ---- #38 delivery windows ---------------------------------------------------------------------------------
  const wins = await t.as<{ day: string; starts_at: string; ends_at: string; template_code: string }>(w.C1.id, "select day::text, starts_at, ends_at, template_code from delivery_windows(7)");
  const friday = wins.filter((x) => new Date(x.day + "T12:00:00Z").getUTCDay() === 5);
  r.check("the customer gets a week of windows from the active template", wins.length >= 7 && wins.every((x) => x.template_code), wins.length);
  r.check("none overlaps Friday prayer (11:30–13:30)", friday.every((x) => {
    const s = new Date(x.starts_at).getTime(); const e = new Date(x.ends_at).getTime();
    const b0 = Date.parse(`${x.day}T11:30:00+04:00`); const b1 = Date.parse(`${x.day}T13:30:00+04:00`);
    return e <= b0 || s >= b1;
  }), friday);
  const [{ fri }] = await t.admin<{ fri: string }>("select (public.muscat_day(now()) + ((5 - extract(dow from now() at time zone 'Asia/Muscat')::int + 7) % 7) + 7)::text as fri");
  await r.denies("an app order in a blocked time is refused", () => order(w.C1.id, "card", null, [`${fri}T12:00:00+04:00`, `${fri}T14:00:00+04:00`]), "slot_blocked");
  await r.denies("customers can't edit templates", () => t.as(w.C1.id, "select staff_save_window_template(null, '{}'::jsonb, 'test')"), "not_staff");
  const tpl = { code: "test-ramadan", name_en: "TEST Ramadan", name_ar: "رمضان تجريبي", kind: "ramadan", starts_on: "2031-01-01", ends_on: "2031-01-03", windows: [{ from: "21:00", to: "23:00" }], blocked: [{ from: "17:00", to: "19:00", label_en: "Iftar", label_ar: "الإفطار" }] };
  await r.denies("a window that ends before it starts is refused", () => t.as(OP.id, "select staff_save_window_template(null, $1::jsonb, 'test')", [JSON.stringify({ ...tpl, windows: [{ from: "10:00", to: "09:00" }] })]), "invalid_value");
  const saved = await one<{ id: string }>(OP.id, "select (staff_save_window_template(null, $1::jsonb, 'Ramadan test')).id as id", [JSON.stringify(tpl)]);
  const pick = await one<{ code: string }>(w.C1.id, "select (window_template_for('2031-01-02')).code as code");
  const pick2 = await one<{ code: string }>(w.C1.id, "select (window_template_for('2031-01-05')).code as code");
  r.check("a dated template wins inside its dates; the normal one applies outside", pick?.code === "test-ramadan" && pick2?.code === "normal", { pick, pick2 });
  const blk = await one<{ b: string | null }>(w.C1.id, "select slot_blocked('2031-01-02T17:30:00+04:00', '2031-01-02T19:30:00+04:00') as b");
  r.check("its blocked time (iftar) applies on those days", blk?.b === "Iftar", blk);
  const [normal] = await t.admin<{ id: string }>("select id from delivery_window_templates where code = 'normal'");
  await r.denies("the undated normal template can't be removed", () => t.as(OP.id, "select staff_delete_window_template($1, 'test')", [normal.id]), "invalid_value");
  await t.as(OP.id, "select staff_delete_window_template($1, 'Remove test template')", [saved.id]);

  // ---- #37 scheduled and recurring orders -----------------------------------------------------------------------
  const [rec0] = await t.admin<{ value: string }>("select value from app_settings where key = 'RECURRING'");
  await t.admin("update app_settings set value = '{\"notice_hours\": 48, \"create_hours\": 48}' where key = 'RECURRING'");
  try {
    const tomorrow = (await t.admin<{ d: string }>("select (public.muscat_day(now()) + 1)::text as d"))[0].d;
    const plan = (x: Row) => one<Row & { id: string; plan_no: number }>(w.C1.id, "select * from save_recurring_order($1::jsonb)",
      [JSON.stringify({ lat: LAT, lng: LNG, area: "TEST farm", service_type: "DW", gallons: 2000, every_n: 1, unit: "weeks", window_from: "08:00", window_to: "10:00", start_on: tomorrow, max_count: 4, pay_method: "card", details: { landmark: "TEST gate 2" }, ...x })]);
    await r.denies("a plan needs an end date or a count", () => plan({ max_count: null }), "invalid_value");
    await r.denies("drivers can't make plans", () => t.as(w.D1.id, "select save_recurring_order('{}'::jsonb)"), "not_a_customer");
    const p1 = (await plan({}))!;
    const p2 = (await plan({ gallons: 1000 }))!;
    const p3 = (await plan({ card_last4: "0002" }))!;
    await one(w.C1.id, "select recurring_action($1, 'skip')", [p2.id]);
    await r.denies("another customer can't touch the plan", () => t.as(w.C2.id, "select recurring_action($1, 'pause')", [p1.id]), "not_found");
    const run = await t.admin<{ x: { notified: number; created: number; failed: number } }>("select run_recurring_orders() as x");
    const made = await t.admin<O & { slot_start: string; recurring_id: string; channel: string }>("select * from orders where recurring_id = $1", [p1.id]);
    r.check("pg_cron creates the occurrence as a normal app order for the window, priced at creation", made.length === 1 && made[0].status === "scheduled" && made[0].channel === "app" && Number(made[0].total) > 0 && Date.parse(made[0].slot_start) === Date.parse(`${tomorrow}T08:00:00+04:00`), { made, run });
    const [ml] = await t.admin<{ landmark: string }>("select landmark from order_locations where order_id = $1", [made[0].id]);
    r.check("…with the plan's address details", ml?.landmark === "TEST gate 2", ml);
    r.check("the customer is told in advance (skip or pause)", (await t.admin("select 1 from notifications where user_id = $1 and event = 'recurring_upcoming'", [w.C1.id])).length >= 2);
    r.check("a skipped delivery is not created", (await t.admin("select 1 from orders where recurring_id = $1", [p2.id])).length === 0);
    const [p3o] = await t.admin<O>("select * from orders where recurring_id = $1", [p3.id]);
    r.check("a saved card that declines doesn't stop it: booked with a payment follow-up", p3o?.status === "scheduled" && p3o.payment_status === "pending" && p3o.payment_followup === "autopay_failed", p3o);
    const run2 = await t.admin<{ x: { created: number } }>("select run_recurring_orders() as x");
    r.check("running again creates nothing twice", run2[0].x.created === 0, run2);
    const mine = await t.as<{ next_on: string; next_state: string }>(w.C1.id, "select next_on::text, next_state from my_recurring_orders() where (plan).id = $1", [p1.id]);
    r.check("the app shows the next delivery (a week later)", mine[0]?.next_on > tomorrow, mine);
    await one(w.C1.id, "select recurring_action($1, 'pause')", [p1.id]);
    await r.denies("a paused plan can't be paused again", () => one(w.C1.id, "select recurring_action($1, 'pause')", [p1.id]), "invalid_transition");
    const vol = await t.as<{ day: string; orders: number; recurring_planned: number }>(OP.id, "select day::text, orders, recurring_planned from staff_scheduled_volume(14)");
    r.check("NWS sees the scheduled volume per day, booked and planned", (vol.find((v) => v.day === tomorrow)?.orders ?? 0) >= 2 && vol.some((v) => v.recurring_planned > 0), vol.slice(0, 9));
    await r.denies("customers can't see it", () => t.as(w.C1.id, "select * from staff_scheduled_volume()"), "not_staff");
    for (const p of [p1, p2, p3]) await one(w.C1.id, "select recurring_action($1, 'end')", [p.id]).catch(() => undefined);
    await t.admin("update orders set status = 'cancelled', cancelled_at = now() where recurring_id = any($1)", [[p1.id, p2.id, p3.id]]);
  } finally {
    await t.admin("update app_settings set value = $1 where key = 'RECURRING'", [rec0.value]);
  }
  r.check("the recurring job is registered for pg_cron", (await t.admin("select 1 from cron_wanted where name = 'nama-recurring-orders'")).length === 1);

  // ---- #39 sponsorship ------------------------------------------------------------------------------------------
  const site = { name: "TEST Masjid Al Noor", name_ar: "مسجد النور التجريبي", kind: "mosque", wilayat_code: "mus-04", lat: LAT + 0.002, lng: LNG, address: "TEST", contact_name: "Imam", contact_phone: "9200 1122" };
  await r.denies("customers can't add sites", () => t.as(w.C1.id, "select staff_save_beneficiary_site(null, $1::jsonb, 'test')", [JSON.stringify(site)]), "not_staff");
  const s1 = await one<{ id: string }>(OP.id, "select (staff_save_beneficiary_site(null, $1::jsonb, 'New mosque')).id as id", [JSON.stringify(site)]);
  r.check("an unverified site isn't offered", !(await t.as<{ id: string }>(w.C1.id, "select id from charity_sites()")).some((x) => x.id === s1.id));
  await t.as(OP.id, "select staff_save_beneficiary_site($1, $2::jsonb, 'Verified by visit')", [s1.id, JSON.stringify({ ...site, verified: true })]);
  const list = await t.as<Row>(w.C1.id, "select * from charity_sites('MUS-04')");
  r.check("verified, it is offered by name, kind and wilayat only (no location, no contact)", list.some((x) => x.id === s1.id) && !("lat" in list[0]) && !("contact_phone" in list[0]), list);
  r.check("customers can't read the sites table", (await t.as(w.C1.id, "select * from beneficiary_sites")).length === 0);
  await r.denies("wastewater can't be sponsored", () => t.as(w.C1.id, "select * from sponsor_order($1, null, 'WW', 1000)", [s1.id]), "invalid_value");
  await r.denies("a wilayat with no approved site is refused", () => t.as(w.C1.id, "select * from sponsor_order(null, 'DHO-10', 'DW', 1000)"), "no_charity_site");
  const sp = await one<O & { area: string }>(w.C1.id, "select * from sponsor_order($1, null, 'DW', 1000, 'card', null, false, 'For Ramadan')", [s1.id]);
  const [spl] = await t.admin<{ contact_phone: string; lat: number }>("select contact_phone, lat from order_locations where order_id = $1", [sp.id]);
  r.check("a sponsored order is a normal paid order delivered to the site, whose contact is the delivery contact", sp.status === "requested" && sp.payment_status === "authorized" && sp.area === site.name && spl.contact_phone === "+96892001122" && spl.lat === site.lat, { sp, spl });
  const anyw = await one<O>(w.C2.id, "select * from sponsor_order(null, 'mus-04', 'DW', 1000, 'card', null, true)");
  r.check("'any approved site in a wilayat' picks one", !!anyw?.id && (await t.admin("select 1 from sponsorships where order_id = $1 and any_in_wilayat and anonymous", [anyw.id])).length === 1);
  await t.as(w.D1.id, "select * from accept_order($1)", [sp.id]);
  const [sms] = await t.admin<{ body: string; user_id: string | null }>("select body, user_id from notification_outbox where order_id = $1 and event = 'contact_sponsored'", [sp.id]);
  r.check("the site's contact is told the sponsor's first name", sms?.user_id === null && sms.body.includes("sponsored by Test"), sms);
  await ping();
  await t.as(w.D1.id, "select status from mark_arrived($1)", [sp.id]);
  await deliver(t, w.D1.id, sp.id);
  r.check("on delivery the sponsor is thanked with the delivery proof and gets the receipt",
    (await t.admin("select 1 from notifications where user_id = $1 and event = 'sponsor_thanks' and order_id = $2", [w.C1.id, sp.id])).length === 1
      && (await t.admin("select 1 from receipts where order_id = $1 and customer_id = $2", [sp.id, w.C1.id])).length === 1);
  await t.as(w.D1.id, "select * from accept_order($1)", [anyw.id]);
  const [anon] = await t.admin<{ body: string }>("select body from notification_outbox where order_id = $1 and event = 'contact_sponsored'", [anyw.id]);
  r.check("an anonymous sponsor stays anonymous to the beneficiary", !!anon && anon.body.includes("a sponsor") && !anon.body.includes("Test Customer"), anon);
  r.check("the sponsor sees their sponsorships; another customer doesn't", (await t.as(w.C1.id, "select * from my_sponsorships()")).length === 1 && (await t.as(w.C1.id, "select * from sponsorships where order_id = $1", [anyw.id])).length === 0);
  const rep = await t.as<{ orders: number; delivered: number }>(OP.id, "select orders, delivered from staff_sponsorship_report(1)");
  r.check("NWS sees sponsored deliveries per month", rep[0]?.orders >= 2 && rep[0].delivered >= 1, rep);
  await t.admin("update orders set status = 'cancelled', cancelled_at = now() where id = $1", [anyw.id]);
  await setOnline(t, w.D1.id, false);
}
