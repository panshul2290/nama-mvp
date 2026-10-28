// Full platform (0009–0013): checkout and wallet, trip legs with proof of
// delivery, settlement, ratings, cancellation fees, wastewater discharge,
// complaints, alerts and penalties, payouts, companies, contracts, business
// accounts and invoices, staff order actions, notifications and RLS.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, setOnline } from "../lib/world";

type Row = Record<string, unknown>;
const LAT = 23.6;
const LNG = 58.2; // inside the Seeb service zone

export async function platformSuite(t: Target, r: Reporter) {
  r.start("PLAT full platform");
  const w = await makeWorld(t, "plat");
  const { C1, C2, D1, D3 } = w;
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${role}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const OP = await mkStaff("plat-op", "operator");
  const FIN = await mkStaff("plat-fin", "finance");
  const CA = await mkStaff("plat-ca", "complaints_agent");
  const AD = await mkStaff("plat-ad", "admin");
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const wallet = async (uid: string) => Number((await one<{ w: { balance: string } }>(uid, "select my_wallet() as w")).w.balance);

  // A company owns D1's and D3's tankers (settlement needs a company).
  const [co] = await t.admin<{ id: string }>("insert into companies (name, cr_no, iban) values ('TST Water Transport', $1, 'OM00TEST') returning id", [`TST${t.runId.slice(-6)}`]);
  await t.admin("update tankers set company_id = $1 where id = any($2)", [co.id, [w.tk.D1, w.tk.D3]]);
  await t.admin("update profiles set company_id = $1 where id = any($2)", [co.id, [D1.id, D3.id]]);

  // ---- checkout ----------------------------------------------------------------
  const order = (uid: string, type: string, gal: number, method: string, extra: Partial<Record<string, unknown>> = {}) =>
    one<Row>(uid, `select * from create_order(p_service_type => $1, p_gallons => $2, p_lat => $3, p_lng => $4, p_area => 'TEST area', p_address => 'TEST address',
                    p_pay_method => $5, p_card_last4 => $6, p_promo_code => $7, p_slot_start => $8, p_slot_end => $9, p_emergency => $10)`,
      [type, gal, extra.lat ?? LAT, extra.lng ?? LNG, method, extra.card ?? null, extra.promo ?? null, extra.slotStart ?? null, extra.slotEnd ?? null, extra.emergency ?? false]);

  await r.denies("create_order: wallet payment with an empty wallet → insufficient_wallet", () => order(C1.id, "DW", 1000, "wallet"), "insufficient_wallet");
  await r.denies("create_order: outside every service zone → outside_service_area", () => order(C1.id, "DW", 1000, "card", { lat: 21.0, lng: 57.0 }), "outside_service_area");
  await r.denies("wallet_topup: declined card → payment_failed", () => one(C1.id, "select wallet_topup(10, 'card', '0002')"), "payment_failed");
  await one(C1.id, "select wallet_topup(20, 'card', '4417')");
  r.check("wallet_topup adds 20 OMR to the wallet", (await wallet(C1.id)) === 20);

  const declined = await order(C1.id, "DW", 1000, "card", { card: "0002" });
  r.check("a declined card leaves the order cancelled with payment_status = failed", declined.status === "cancelled" && declined.payment_status === "failed", declined);

  const paid = await order(C1.id, "DW", 1000, "wallet");
  r.check("wallet checkout: order requested, payment authorized, wallet debited by the total", paid.status === "requested" && paid.payment_status === "authorized" && (await wallet(C1.id)) === 20 - Number(paid.total), paid);

  const q = await one<{ q: Row }>(C1.id, "select quote_order('DW', 1000, null, true, 'WELCOME10') as q");
  r.check("quote_order: emergency ×1.5 fee and WELCOME10 10% discount on the fee", q.q.delivery_fee === 5.25 && q.q.discount === 0.525, q.q);
  await r.denies("quote_order: unknown promo → invalid_promo", () => one(C1.id, "select quote_order('DW', 1000, null, false, 'NOPE99')"), "invalid_promo");

  const later = new Date(Date.now() + 26 * 3600e3).toISOString();
  const laterEnd = new Date(Date.now() + 28 * 3600e3).toISOString();
  const sched = await order(C2.id, "DW", 500, "card", { slotStart: later, slotEnd: laterEnd });
  r.check("a slot more than 2 h ahead creates a scheduled order", sched.status === "scheduled", sched.status);

  // ---- trip: fill → arrive → proof of delivery → settlement ----------------------
  await setOnline(t, D1.id, true);
  await one(D1.id, "select * from accept_order($1)", [paid.id]);
  await t.admin("update tankers set last_lat = 23.6030, last_lng = 58.3870, last_fix_at = now() where id = $1", [w.tk.D1]);
  const filled = await one<Row>(D1.id, "select * from confirm_fill($1)", [paid.id]);
  r.check("confirm_fill inside the Al Ghubrah geofence is verified", filled.fill_verified === true && filled.fill_meter_gal === 1000, filled);
  const fillCredit = await t.admin<{ s: string }>("select sum(amount)::text s from company_tx where company_id = $1 and bucket = 'fill_credit'", [co.id]);
  r.check("filling charges the company's filling credit by the water charge", Number(fillCredit[0].s) === -Number(paid.water_charge), fillCredit);
  await one(D1.id, "select * from mark_arrived($1)", [paid.id]);
  await r.denies("submit_pod without signature (and not 'no signature') → signature_required",
    () => one(D1.id, "select * from submit_pod($1, 1000, null, 'hash-1')", [paid.id]), "signature_required");
  const del = await one<Row>(D1.id, "select * from submit_pod($1, 1000, null, 'hash-1', '<svg/>')", [paid.id]);
  r.check("submit_pod completes a DW job (delivered) and captures the payment", del.status === "delivered" && del.payment_status === "captured", del);
  const earn = await t.admin<{ s: string }>("select sum(amount)::text s from company_tx where order_id = $1 and kind = 'earning'", [paid.id]);
  r.check("settlement credits the driver earnings to the tanker company", Number(earn[0].s) === Number(paid.driver_earnings), earn);
  const pts = await t.admin<{ loyalty_points: number }>("select loyalty_points from profiles where id = $1", [C1.id]);
  r.check("the customer earns loyalty points (1 per OMR)", pts[0].loyalty_points === Math.floor(Number(paid.total)), pts);
  const notes = await t.as<{ event: string }>(C1.id, "select event from notifications order by id");
  r.check("notifications: confirmed → tanker assigned → arrived → delivered", ["order_confirmed", "tanker_assigned", "arrived", "delivered"].every((e) => notes.some((n) => n.event === e)), notes);
  r.check("another customer sees none of C1's notifications or wallet", (await t.as(C2.id, "select 1 from notifications where user_id = $1", [C1.id])).length === 0 && (await t.as(C2.id, "select 1 from wallet_tx where customer_id = $1", [C1.id])).length === 0);

  const rated = await one<Row>(C1.id, "select * from rate_order($1, 5, 'TEST great', 1, 'wallet')", [paid.id]);
  r.check("rate_order stores the rating and the tip", rated.rating === 5 && Number(rated.tip) === 1, rated);
  await r.denies("rating twice → already_rated", () => one(C1.id, "select * from rate_order($1, 4)", [paid.id]), "already_rated");
  const tip = await t.admin<{ s: string }>("select sum(amount)::text s from company_tx where order_id = $1 and kind = 'tip'", [paid.id]);
  r.check("the tip is credited to the tanker company", Number(tip[0].s) === 1, tip);

  // ---- short volume → automatic penalty ------------------------------------------
  const p2 = await order(C1.id, "DW", 1000, "card");
  await one(D1.id, "select * from accept_order($1)", [p2.id]);
  await one(D1.id, "select * from mark_arrived($1)", [p2.id]);
  await one(D1.id, "select * from submit_pod($1, 800, null, 'hash-2', null, true)", [p2.id]);
  const pen = await t.admin<{ rule_code: string; amount: string; id: string }>("select rule_code, amount::text, id from penalties where order_id = $1", [p2.id]);
  r.check("delivering 20% short issues the short-volume penalty", pen[0]?.rule_code === "short_volume" && pen[0]?.amount === "10.000", pen);
  await one(D1.id, "select * from dispute_penalty($1, 'TEST meter was faulty')", [pen[0].id]);
  const cancelled = await one<Row>(OP.id, "select * from staff_decide_penalty($1, 'cancel', 'TEST meter fault confirmed')", [pen[0].id]);
  const rev = await t.admin<{ s: string }>("select sum(amount)::text s from company_tx where penalty_id = $1", [pen[0].id]);
  r.check("driver disputes; NWS cancels; the fine is reversed", cancelled.state === "cancelled" && Number(rev[0].s) === 0, { cancelled, rev });

  // ---- cancellation with fee -------------------------------------------------------
  const before = await wallet(C1.id);
  const p3 = await order(C1.id, "DW", 1000, "wallet");
  await one(D1.id, "select * from accept_order($1)", [p3.id]);
  await r.denies("cancel_order after assignment → cannot_cancel (unchanged)", () => one(C1.id, "select * from cancel_order($1)", [p3.id]), "cannot_cancel");
  const cx = await one<Row>(C1.id, "select * from cancel_order_with_fee($1, 'TEST changed my mind')", [p3.id]);
  r.check("cancel_order_with_fee keeps 1 OMR and refunds the rest to the wallet", cx.status === "cancelled" && Number(cx.cancel_fee) === 1 && (await wallet(C1.id)) === before - 1, { cx, w: await wallet(C1.id) });

  // ---- wastewater: collect → discharge ---------------------------------------------
  const ww = await order(C2.id, "WW", 3000, "card");
  await setOnline(t, D3.id, true);
  await one(D3.id, "select * from accept_order($1)", [ww.id]);
  await r.denies("confirm_fill on wastewater → no_fill_for_wastewater", () => one(D3.id, "select * from confirm_fill($1)", [ww.id]), "no_fill_for_wastewater");
  await one(D3.id, "select * from mark_arrived($1)", [ww.id]);
  const col = await one<Row>(D3.id, "select * from submit_pod($1, 3000, null, 'hash-3', '<svg/>')", [ww.id]);
  r.check("WW proof of collection → collected (job still active)", col.status === "collected", col.status);
  await r.denies("a driver with a collected job can't accept another", async () => {
    const x = await order(C2.id, "WW", 1000, "card");
    return one(D3.id, "select * from accept_order($1)", [x.id]);
  }, "driver_busy");
  await t.admin("update tankers set last_lat = 21.5, last_lng = 57.5, last_fix_at = now() where id = $1", [w.tk.D3]);
  const dis = await one<Row>(D3.id, "select * from confirm_discharge($1)", [ww.id]);
  r.check("discharge far from any plant: delivered but unverified", dis.status === "delivered" && dis.discharge_verified === false, dis);
  const al = await t.admin<{ type: string; severity: string }>("select type, severity from alerts where order_id = $1", [ww.id]);
  r.check("… raises a high 'Discharge outside approved zone' alert", al.some((a) => a.type === "Discharge outside approved zone" && a.severity === "high"), al);
  const dp = await t.admin<{ rule_code: string }>("select rule_code from penalties where order_id = $1", [ww.id]);
  r.check("… and the 500 OMR discharge penalty", dp.some((p) => p.rule_code === "discharge_outside"), dp);

  // ---- complaints ----------------------------------------------------------------------
  const cmp = await one<Row>(C1.id, "select * from file_complaint($1, 'incomplete_volume', 'TEST tank only half full', null)", [paid.id]);
  r.check("file_complaint sets the SLA from the category (48 h, Tanker operations)", cmp.sla_hours === 48 && cmp.owner_team === "Tanker operations" && cmp.state === "new", cmp);
  await r.denies("a customer can't complain about someone else's order", () => one(C2.id, "select * from file_complaint($1, 'late_delivery', 'TEST not mine')", [paid.id]), "not_found");
  await r.denies("a driver can't run staff case actions", () => one(D1.id, "select * from staff_case_action($1, 'resolve', 'TEST')", [cmp.id]), "not_staff");
  const w0 = await wallet(C1.id);
  await one(CA.id, "select * from staff_case_action($1, 'refund', 'TEST refund for short volume', null, 1)", [cmp.id]);
  const res = await one<Row>(CA.id, "select * from staff_case_action($1, 'resolve', 'TEST refunded 1 OMR, driver briefed')", [cmp.id]);
  r.check("complaints agent refunds 1 OMR to the wallet and resolves the case", res.state === "resolved" && Number(res.refund_amount) === 1 && (await wallet(C1.id)) === w0 + 1, res);
  const visible = await t.as<{ internal: boolean }>(C1.id, "select internal from complaint_notes where complaint_id = $1", [cmp.id]);
  r.check("the customer sees the case notes (none internal)", visible.length >= 2 && visible.every((n) => !n.internal), visible);

  // ---- control room ----------------------------------------------------------------------
  // staff_scan, payout batches and emergency mode act on every tanker / company / setting,
  // so on a live project they'd touch real data: run them only on a fresh database.
  const GLOBAL = "acts on all real tankers, companies or settings — covered by the fresh (PGlite) run";
  if (!t.fresh) {
    for (const n of ["staff_scan raises 'IVMS signal lost' for a silent online tanker", "… without duplicating an open alert", "operator acknowledges the alert (audited)",
                     "fraud scan flags a DW delivery without a filling event", "finance runs a payout batch; the company's earnings balance goes to zero"]) r.skip(n, GLOBAL);
  } else {
  await t.admin("update tankers set is_online = true, last_fix_at = now() - interval '10 minutes' where id = $1", [w.tk.D1]);
  await r.denies("a customer can't run staff_scan", () => one(C1.id, "select staff_scan()"), "not_staff");
  const scan = await one<{ s: Row }>(OP.id, "select staff_scan() as s");
  const sig = await t.admin<{ id: number }>("select id from alerts where tanker_id = $1 and type = 'IVMS signal lost' and state = 'open'", [w.tk.D1]);
  r.check("staff_scan raises 'IVMS signal lost' for a silent online tanker", sig.length === 1, scan.s);
  await one(OP.id, "select staff_scan()");
  r.check("… without duplicating an open alert", (await t.admin("select 1 from alerts where tanker_id = $1 and type = 'IVMS signal lost' and state = 'open'", [w.tk.D1])).length === 1);
  const ack = await one<Row>(OP.id, "select * from staff_alert_action($1, 'acknowledge', 'TEST calling driver')", [sig[0].id]);
  r.check("operator acknowledges the alert (audited)", ack.state === "acknowledged" && (await t.admin("select 1 from audit_log where action = 'alert.acknowledge' and target_id = $1", [String(sig[0].id)])).length === 1, ack);
  const flags = await t.admin<{ rule: string }>("select rule from fraud_flags where subject_id = $1", [p2.id]);
  r.check("fraud scan flags a DW delivery without a filling event", flags.some((f) => f.rule === "Delivery without filling"), flags);

  // ---- payouts ---------------------------------------------------------------------------
  await r.denies("an operator can't run a payout batch", () => one(OP.id, "select * from staff_run_payout_batch()"), "forbidden_for_role");
  // The 500 OMR discharge fine leaves the company in debit; finance cancels it on review.
  const [dpen] = await t.admin<{ id: string }>("select id from penalties where order_id = $1 and rule_code = 'discharge_outside'", [ww.id]);
  await one(FIN.id, "select * from staff_decide_penalty($1, 'cancel', 'TEST GPS drift confirmed by IVMS log')", [dpen.id]);
  const batch = await one<Row>(FIN.id, "select * from staff_run_payout_batch()");
  const bal = await t.admin<{ s: string }>("select coalesce(sum(amount), 0)::text s from company_tx where company_id = $1 and bucket = 'earnings'", [co.id]);
  r.check("finance runs a payout batch; the company's earnings balance goes to zero", Number(batch.companies) >= 1 && Number(bal[0].s) === 0, { batch, bal });
  }

  // ---- staff order actions and call-centre orders ----------------------------------------
  const call = await one<Row>(OP.id, "select * from staff_place_order($1, 'DW', 2000, $2, $3, 'TEST area', 'TEST caller address', 'GEN-1001')", [C2.id, LAT, LNG]);
  r.check("operator places a call-centre order (cash on delivery)", call.channel === "call_centre" && call.pay_method === "cash" && call.status === "requested", call);
  await t.admin("update tankers set is_online = false where id = $1", [w.tk.D1]);
  const asg = await one<Row>(OP.id, "select * from staff_order_action($1, 'assign', 'TEST nearest permitted tanker', $2)", [call.id, w.tk.D1]);
  r.check("operator assigns the order to a tanker (driver notified)", asg.status === "accepted" && asg.tanker_id === w.tk.D1, asg);
  const rel = await one<Row>(D1.id, "select * from report_trip_issue($1, 'breakdown', 'TEST flat tyre')", [call.id]);
  const back = await t.admin<{ status: string; driver_id: string | null }>("select status, driver_id from orders where id = $1", [call.id]);
  r.check("driver reports a breakdown: the job goes back to dispatch", rel.released === true && back[0].status === "requested" && back[0].driver_id === null, back);
  const sc = await one<Row>(OP.id, "select * from staff_order_action($1, 'cancel', 'TEST caller cancelled')", [call.id]);
  r.check("operator cancels the order (audited)", sc.status === "cancelled" && (await t.admin("select 1 from audit_log where action = 'order.cancel' and target_id = $1", [call.id])).length === 1);

  // ---- companies, drivers, contracts ------------------------------------------------------
  const OW = await t.createUser("plat-ow", { role: "owner" as never, full_name: "Test Owner" });
  const [owp] = await t.admin<{ role: string }>("select role from profiles where id = $1", [OW.id]);
  r.check("signing up as owner creates an owner profile", owp.role === "owner", owp);
  const comp = await one<Row>(OW.id, "select * from owner_register_company('TST Owner Co', $1, '+968 9000 0000', 'Bank Muscat', 'OM12 TEST 0000')", [`TSTO${t.runId.slice(-5)}`]);
  r.check("owner registers a company (pending NWS approval)", comp.status === "pending", comp);
  await one(AD.id, "select staff_company_action($1, 'activate', 'TEST documents checked')", [comp.id]);
  const tk = await one<Row>(OW.id, "select * from owner_register_tanker($1, 'DW', 4000)", [w.plate("OWN1")]);
  r.check("owner registers a tanker; it gets an IVMS device", tk.company_id === comp.id && (await t.admin("select 1 from devices where tanker_id = $1", [tk.id])).length === 1, tk);
  const DX = await t.createUser("plat-dx", { role: "driver", full_name: "Test Company Driver" });
  await one(OW.id, "select * from owner_add_driver($1)", [DX.email]);
  await one(OW.id, "select * from owner_assign_driver($1, $2)", [DX.id, tk.id]);
  r.check("owner adds a driver by email and assigns them the tanker", (await t.as(DX.id, "select id from tankers")).length === 1);
  r.check("another company's owner data is invisible to this owner", (await t.as(OW.id, "select 1 from company_tx where company_id = $1", [co.id])).length === 0);

  const [prop] = await t.as<{ id: string }>(C1.id, "select id from save_property(null, 'TEST villa', 'TEST address', 'Seeb', $1, $2, 3000)", [LAT, LNG]);
  const start = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const ct = await one<Row>(C1.id, "select * from create_contract($1, $2, 'DW', 3000, 'weekly', 'monthly', 'morning', $3, 3)", [prop.id, comp.id, start]);
  r.check("customer requests a weekly contract (pending owner acceptance, monthly estimate)", ct.status === "pending_owner" && Number(ct.monthly_est) > 0, ct);
  const ac = await one<Row>(OW.id, "select * from owner_decide_contract($1, true)", [ct.id]);
  const gen = await t.admin<{ n: number }>("select count(*)::int n from orders where contract_id = $1 and status = 'scheduled'", [ct.id]);
  r.check("owner accepts; the next week's contract orders are scheduled", ac.status === "active" && gen[0].n >= 1, gen);

  // ---- business accounts --------------------------------------------------------------------
  const BA = await t.createUser("plat-ba", { role: "business" as never, full_name: "Test Biz Admin" });
  const BM = await t.createUser("plat-bm", { role: "business" as never, full_name: "Test Site Manager" });
  const org = await one<Row>(BA.id, "select * from org_register('TST Hotel', $1, 'commercial')", [`TSTB${t.runId.slice(-5)}`]);
  await one(FIN.id, "select * from staff_org_action($1, 'activate', 'TEST verified')", [org.id]);
  await one(FIN.id, "select * from staff_org_action($1, 'raise_limit', 'TEST credit approved', 500)", [org.id]);
  await one(BA.id, "select * from org_add_member($1, 'site_manager')", [BM.email]);
  const [site] = await t.as<{ id: string }>(BA.id, "select id from save_property(null, 'TEST hotel main', 'TEST', 'Seeb', $1, $2, 20000)", [LAT, LNG]);
  const bulk = await t.as<Row>(BM.id, "select * from org_create_orders($1, 'DW', 5000, 3, null, null, null, 'PO-TEST-1')", [site.id]);
  r.check("site manager's bulk order above the approval limit waits for approval", bulk.length === 3 && bulk.every((o) => o.status === "pending_approval" && o.billing === "account"), bulk.map((o) => o.status));
  const appr = await one<Row>(BA.id, "select * from org_decide_order($1, true)", [bulk[0].id]);
  r.check("account admin approves one → requested", appr.status === "requested", appr.status);
  await t.admin("update orders set status = 'delivered', delivered_at = now() where id = $1", [bulk[0].id]);
  const inv = await one<Row>(BA.id, "select * from org_generate_invoice()");
  r.check("invoice covers the delivered account order", inv.orders === 1 && Number(inv.total) === Number(bulk[0].total), inv);
  const paidInv = await one<Row>(BA.id, "select * from org_pay_invoice($1)", [inv.id]);
  r.check("finance pays the invoice", paidInv.status === "paid", paidInv);
  r.check("business members can't see another customer's orders", (await t.as(BM.id, "select 1 from orders where customer_id = $1", [C1.id])).length === 0);

  // ---- settings ------------------------------------------------------------------------------
  await r.denies("an operator can't change pricing rules", () => one(OP.id, "select * from staff_update_pricing_rule('fee_dw_omr', '4', 'assumption', 'TEST', 'TEST reason')"), "forbidden_for_role");
  const pr = await t.adminRollback(async (qq) => {
    await qq("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: AD.id, role: "authenticated" })]);
    return (await qq<{ value: string }>("select value from staff_update_pricing_rule('fee_dw_omr', '4', 'assumption', 'TEST', 'TEST reason')"))[0];
  });
  r.check("admin can change a pricing rule (rolled back here)", pr.value === "4", pr);
  if (t.fresh) {
    const em = await one<{ e: Row }>(OP.id, "select staff_set_emergency(true, 'Seeb', 'TEST supply outage') as e");
    r.check("operator activates emergency mode for a zone", em.e.on === true && em.e.zone === "Seeb", em.e);
    await one(OP.id, "select staff_set_emergency(false, null, 'TEST restored')");
  } else r.skip("operator activates emergency mode for a zone", GLOBAL);
  const dr = await one<Row>(C1.id, "select * from file_data_request('access', 'TEST export my data')");
  r.check("customer files a data-access request", dr.state === "open", dr);
}
