// Money and price integrity (0034–0036): tariff classes and delivery charges per zone, the
// price locked at booking, what the driver collects, platform fees and their ledger, the
// "driver asked for more money" report, e-receipts, Fawtara-ready invoices and payments that
// confirm at once. Anything that changes shared reference data (tariff, charges, fees, the
// seller) runs inside a rolled-back transaction, so a live project never sees it.
import type { Reporter, Target } from "../lib/harness";
import { deliver, makeWorld, peakNow, placeOrder, setOnline, TEST_AREA } from "../lib/world";

type Row = Record<string, unknown>;
type Q = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** Run sql as a user inside the current (rolled-back) transaction; rows or the error message. */
async function asUserIn(q: Q, uid: string, sql: string, params: unknown[] = []): Promise<{ rows?: Row[]; error?: string }> {
  await q("savepoint s");
  try {
    await q("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [uid, JSON.stringify({ sub: uid, role: "authenticated" })]);
    await q("set local role authenticated");
    const rows = await q<Row>(sql, params);
    await q("reset role");
    await q("release savepoint s");
    return { rows };
  } catch (e) {
    await q("rollback to savepoint s");
    await q("reset role");
    return { error: (e as Error).message };
  }
}

const LAT = 23.6;
const LNG = 58.2; // inside the Seeb service zone

export async function moneySuite(t: Target, r: Reporter) {
  const one = async <T = Row>(uid: string | null, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const mkStaff = async (label: string, role: string) => {
    const u = await t.createUser(label, { role: "customer", full_name: `Test ${label}` });
    await t.admin("update profiles set role = 'nws_staff', staff_role = $2 where id = $1", [u.id, role]);
    return u;
  };
  const w = await makeWorld(t, "money");
  const { C1, C2, D1, D2 } = w;
  const OP = await mkStaff("money-op", "operator");
  const FIN = await mkStaff("money-fin", "finance");
  const peak = await peakNow(t);
  const [{ zone }] = await t.admin<{ zone: string }>("select (zone_at($1, $2)).id as zone", [LAT, LNG]);

  // ===========================================================================================
  r.start("TARIFF tariff classes and delivery charges per zone (0034)");
  await r.denies("signed-out visitors can't read tariff classes", () => t.as(null, "select * from tariff_classes"), "permission denied");
  const seen = await t.as<Row>(C1.id, "select code from tariff_classes");
  r.check("signed-in users read the tariff classes (quotes show them)", seen.length >= 4, seen.length);
  const seenD = await t.as<Row>(D1.id, "select id from delivery_charges");
  r.check("…and the delivery charges", seenD.length >= 4, seenD.length);
  for (const [who, uid] of [["customer", C1.id], ["driver", D1.id], ["operator", OP.id]] as const) {
    await r.denies(`${who} can't change a tariff class directly`, () => t.as(uid, "update tariff_classes set rate_baisa = 0"), "permission denied");
    await r.denies(`${who} can't change a delivery charge directly`, () => t.as(uid, "update delivery_charges set amount_omr = 0"), "permission denied");
  }
  const [dw1] = await t.admin<{ id: string }>("select id from tariff_classes where code = 'DW-1'");
  const [dw2] = await t.admin<{ id: string }>("select id from tariff_classes where code = 'DW-2'");
  await r.denies("an operator can't edit the tariff (admin and finance only)",
    () => one(OP.id, "select * from staff_save_delivery_charge(null, $1, $2, 5, 'confirmed', 'TEST', 'TEST reason')", [zone, dw1.id]), "forbidden_for_role");
  await r.denies("a driver can't edit the tariff", () => one(D1.id, "select * from staff_save_tariff_class(null, 'DW', 'DW-9', 7000, null, 1, 'confirmed', 'TEST', true, 'TEST reason')"), "not_staff");

  await t.adminRollback(async (q) => {
    // A zone charge for DW-1 in the order's zone, set by finance.
    const z = await asUserIn(q, FIN.id, "select * from staff_save_delivery_charge(null, $1, $2, 5, 'confirmed', 'TEST zone tariff', 'TEST NWS decision')", [zone, dw1.id]);
    r.check("finance adds a zone delivery charge (DW-1, 5.000 OMR)", !z.error && Number(z.rows?.[0]?.amount_omr) === 5, z.error ?? z.rows);
    const [aud] = await q<{ n: number }>("select count(*)::int n from audit_log where action = 'pricing.delivery_charge_add' and target_id = $1", [z.rows?.[0]?.id]);
    r.check("the change is audited", aud.n === 1, aud);
    const dup = await asUserIn(q, FIN.id, "select * from staff_save_delivery_charge(null, $1, $2, 6, 'confirmed', 'TEST', 'TEST reason')", [zone, dw1.id]);
    r.check("a second charge for the same zone and class is refused", dup.error?.includes("already_exists") === true, dup.error);
    const located = await asUserIn(q, C1.id, "select quote_order('DW', 600, null, false, null, $1, $2) as q", [LAT, LNG]);
    const lq = located.rows?.[0]?.q as Row | undefined;
    // The 0026 multipliers (peak, demand from other suites' open orders) still apply on top of the charge.
    const mult = Number(lq?.fee_multiplier ?? 1);
    r.check("the quote at a pin in the zone uses the zone's charge (and says which)",
      Number(lq?.base_fee) === 5 && Number((lq?.delivery as Row)?.amount) === 5 && Math.abs(Number(lq?.delivery_fee) - Math.round(5 * mult * 1000) / 1000) < 0.0005 &&
        (lq?.delivery as Row)?.is_default === false && (lq?.tariff as Row)?.code === "DW-1", lq);
    const plain = await asUserIn(q, C1.id, "select quote_order('DW', 600) as q");
    const pq = plain.rows?.[0]?.q as Row | undefined;
    r.check("without a pin the quote uses the default charge", Number(pq?.delivery_fee) === (peak ? 4.2 : 3.5) && (pq?.delivery as Row)?.is_default === true, pq);
    const placed = await asUserIn(q, C1.id, `select * from place_order('DW', 600, ${LAT}, ${LNG}, '${TEST_AREA}', 'TEST')`);
    const o = placed.rows?.[0];
    const pb = o?.price_basis as Row | undefined;
    r.check("an order in the zone is priced with it; driver earnings stay driver_share × the charge",
      Number((pb?.delivery as Row)?.amount) === 5 && Number((pb?.factors as Row)?.base_fee) === 5 &&
        Number(o?.driver_earnings) === Math.round(Number(o?.delivery_fee) * 0.85 * 1000) / 1000 && (pb?.delivery as Row)?.zone_id === zone, { o, pb });
    // Splitting a class keeps slab prices: DW-2 becomes 651–5,000 and DW-3 5,001+ at the same rate.
    const s1 = await asUserIn(q, FIN.id, "select * from staff_save_tariff_class($1, 'DW', 'DW-2', 651, 5000, 3, 'pending_clarification', 'Q05', true, 'TEST split')", [dw2.id]);
    const s2 = await asUserIn(q, FIN.id, "select * from staff_save_tariff_class(null, 'DW', 'dw-3', 5001, null, 3, 'pending_clarification', 'Q05', true, 'TEST split')");
    r.check("finance splits a class (codes are upper-cased)", !s1.error && s2.rows?.[0]?.code === "DW-3", s1.error ?? s2.error ?? s2.rows);
    const [nd] = await q<{ amount_omr: string; status: string }>("select amount_omr, status from delivery_charges where class_id = $1 and zone_id is null", [s2.rows?.[0]?.id]);
    r.check("a new class starts with a default delivery charge copied from the class below, as an assumption", Number(nd?.amount_omr) === 3.5 && nd.status === "assumption", nd);
    const [p6] = await q<{ water_charge: string }>("select water_charge from price_quote('DW', 6000)");
    r.check("slab prices are unchanged by the split (DW 6,000 gal water 16.700)", p6.water_charge === "16.700", p6);
    const ov = await asUserIn(q, FIN.id, "select * from staff_save_tariff_class(null, 'DW', 'DW-X', 4000, 7000, 2, 'confirmed', 'TEST', true, 'TEST overlap')");
    r.check("an overlapping class is refused", ov.error?.includes("tariff_class_overlap") === true, ov.error);
    await q("update pricing_rules set value = 'whole_volume' where rule_key = 'tariff_basis'");
    const [wv] = await q<{ water_charge: string; delivery_fee: string }>("select water_charge, delivery_fee from price_quote('DW', 6000)");
    r.check("whole volume: every gallon at the class the volume falls in (DW 6,000 gal at 3 baisa = 18.000)", wv.water_charge === "18.000", wv);
    const del = await asUserIn(q, FIN.id, "select staff_delete_delivery_charge(id, 'TEST') from delivery_charges where zone_id is null and class_id = $1", [dw1.id]);
    r.check("a default charge can't be removed", del.error?.includes("invalid_value") === true, del.error);
    const del2 = await asUserIn(q, FIN.id, "select staff_delete_delivery_charge($1, 'TEST zone back to default')", [z.rows?.[0]?.id]);
    r.check("a zone's own charge can be removed (back to the default)", !del2.error, del2.error);
  });
  const [still] = await t.admin<{ n: number }>("select count(*)::int n from delivery_charges where zone_id = $1", [zone]);
  r.check("after the rolled-back edits no zone charge is left", still.n === 0, still);

  // ===========================================================================================
  r.start("LOCK price locked at booking, collect amount (0034)");
  const o1 = await placeOrder(t, C1.id, "DW", 1000);
  const [b1] = await t.admin<{ pb: Row; total: string }>("select price_basis as pb, total from orders where id = $1", [o1.id]);
  const lines = b1.pb.lines as Row;
  r.check("the order stores the whole breakdown: lines, tariff class and slabs, delivery charge, VAT rate, driver share",
    b1.pb.version === 2 && Number(lines.total) === Number(b1.total) && (b1.pb.tariff as Row).code === "DW-2" && ((b1.pb.tariff as Row).slabs as Row[]).length === 2 &&
      typeof (b1.pb.delivery as Row).charge_id === "string" && Number(b1.pb.vat_rate) === 0.05 && Number(b1.pb.driver_share) === 0.85 && typeof b1.pb.locked_at === "string",
    b1.pb);
  await r.denies("the volume can't change after booking, even for a privileged role", () => t.admin("update orders set gallons = 2000 where id = $1", [o1.id]), "price_immutable");
  await r.denies("nor the service", () => t.admin("update orders set service_type = 'WW' where id = $1", [o1.id]), "price_immutable");
  await r.denies("nor the stored breakdown", () => t.admin("update orders set price_basis = price_basis || '{\"x\": 1}' where id = $1", [o1.id]), "price_immutable");
  await r.denies("a driver can't change the price (no write rights at all)", () => t.as(D1.id, "update orders set total = 1 where id = $1", [o1.id]), "permission denied");
  await r.denies("an operator can't adjust a price (finance only)", () => one(OP.id, "select * from staff_adjust_order_price($1, 2, 'TEST reason')", [o1.id]), "forbidden_for_role");
  await r.denies("a price can only go down", () => one(FIN.id, "select * from staff_adjust_order_price($1, 9, 'TEST reason')", [o1.id]), "price_increase_not_allowed");
  const before = await one<{ b: string }>(C1.id, "select my_wallet() ->> 'balance' as b");
  const adj = await one<Row>(FIN.id, "select * from staff_adjust_order_price($1, 2.5, 'TEST goodwill')", [o1.id]);
  const want = Math.round((1.7 + 2.5) * 1.05 * 1000) / 1000;
  r.check("finance lowers the delivery fee: VAT recomputed at the locked rate, the regulated water charge and driver earnings unchanged",
    Number(adj.delivery_fee) === 2.5 && Number(adj.total) === want && adj.water_charge === "1.700" && adj.driver_earnings === o1.driver_earnings && ((adj.price_basis as Row).adjustments as Row[]).length === 1, adj);
  const after = await one<{ b: string }>(C1.id, "select my_wallet() ->> 'balance' as b");
  r.check("the prepaid customer gets the difference back in the wallet", Math.abs(Number(after.b) - Number(before.b) - (Number(o1.total) - want)) < 0.0005, { before, after });
  r.check("the adjustment is audited", (await t.admin("select 1 from audit_log where action = 'order.price_adjust' and target_id = $1", [o1.id])).length === 1);

  await setOnline(t, D2.id, true);
  const [offer] = await t.as<{ collect_omr: string; pay_method: string }>(D2.id, "select collect_omr, pay_method from open_requests_near($1, $2) where id = $3", [LAT, LNG, o1.id]);
  r.check("the job offer says what to collect: nothing on an order paid in the app", offer?.collect_omr === "0.000" && offer.pay_method === "card", offer);
  const cod = await placeOrder(t, C1.id, "DW", 650);
  await t.admin("update payments set method = 'cash', card_amount = 0, card_last4 = null where order_id = $1", [cod.id]);
  await t.admin("update orders set pay_method = 'cash' where id = $1", [cod.id]);
  const [offer2] = await t.as<{ collect_omr: string }>(D2.id, "select collect_omr from open_requests_near($1, $2) where id = $3", [LAT, LNG, cod.id]);
  r.check("…and the total on a cash-on-delivery order", Number(offer2?.collect_omr) === Number(cod.total), offer2);
  await t.as(C1.id, "select * from cancel_order($1)", [cod.id]);

  // ===========================================================================================
  r.start("PFEE platform fees and their ledger (0035)");
  const fees = await t.admin<{ fee_key: string; amount_omr: string; status: string }>("select fee_key, amount_omr, status from platform_fees order by fee_key");
  r.check("six tender platform fees, none invented: 0 OMR, to be quoted in the bid",
    fees.length === 6 && fees.every((f) => Number(f.amount_omr) === 0 && f.status === "to_be_quoted"), fees);
  const [reg] = await t.admin<{ n: number }>("select count(*)::int n from platform_fee_ledger where fee_key = 'tanker_registration' and tanker_id = any($1::uuid[])", [[w.tk.D1, w.tk.D2, w.tk.D3]]);
  r.check("registering a tanker on the platform accrues the registration fee (once per tanker)", reg.n === 3, reg);
  await setOnline(t, D1.id, true);
  const o2 = await placeOrder(t, C2.id, "DW", 1000);
  await t.as(D1.id, "select * from accept_order($1)", [o2.id]);
  await t.as(D1.id, "select report_location($1, $2, 8, now())", [LAT, LNG]);
  await t.as(D1.id, "select status from mark_arrived($1)", [o2.id]);
  await deliver(t, D1.id, o2.id);
  const [trip] = await t.admin<{ fee_key: string; amount_omr: string; fee_status: string; driver_id: string }>("select fee_key, amount_omr, fee_status, driver_id from platform_fee_ledger where dedupe_key = $1", [`trip:${o2.id}`]);
  r.check("a delivery accrues the per-trip fee of its service, at the fee's amount and status then", trip?.fee_key === "trip_dw" && trip.fee_status === "to_be_quoted" && trip.driver_id === D1.id, trip);
  const o3 = await placeOrder(t, C2.id, "DW", 1000);
  await t.as(D1.id, "select * from accept_order($1)", [o3.id]);
  const cx = await one<Row>(C2.id, "select * from cancel_order_with_fee($1, 'TEST changed my mind')", [o3.id]);
  const [cf] = await t.admin<{ fee_key: string }>("select fee_key from platform_fee_ledger where dedupe_key = $1", [`cancel:${o3.id}`]);
  r.check("a chargeable cancellation (a fee was kept) accrues the cancellation fee", Number(cx.cancel_fee) > 0 && cf?.fee_key === "cancellation", { cx: cx.cancel_fee, cf });
  const o4 = await placeOrder(t, C2.id, "DW", 650);
  await t.as(C2.id, "select * from cancel_order($1)", [o4.id]);
  r.check("a free cancellation accrues nothing", (await t.admin("select 1 from platform_fee_ledger where order_id = $1", [o4.id])).length === 0);

  const OW = await t.createUser("money-ow", { role: "owner" as never, full_name: "Test Money Owner" });
  const comp = await one<Row>(OW.id, "select * from owner_register_company('TST Money Co', $1, '+968 9000 0001', 'Bank Muscat', 'OM12 TEST 0001')", [`TSTM${t.runId.slice(-5)}`]);
  const AD = await mkStaff("money-ad", "admin");
  await one(AD.id, "select staff_company_action($1, 'activate', 'TEST documents checked')", [comp.id]);
  await t.adminRollback(async (q) => {
    const [n1] = await q<{ n: number }>("select accrue_platform_subscriptions() as n");
    const [n2] = await q<{ n: number }>("select accrue_platform_subscriptions() as n");
    const [row] = await q<{ period_month: string }>("select period_month::text from platform_fee_ledger where fee_key = 'owner_subscription' and company_id = $1", [comp.id]);
    r.check("the monthly job accrues one subscription per active owner account, once per month", n1.n >= 1 && n2.n === 0 && /^\d{4}-\d{2}-01$/.test(row?.period_month ?? ""), { n1, n2, row });
    const own = await asUserIn(q, OW.id, "select owner_platform_fees() as f");
    const f = own.rows?.[0]?.f as Row | undefined;
    r.check("the owner sees the fees owed to the platform", (f?.rows as Row[])?.some((x) => x.fee_key === "owner_subscription") && Number(f?.owed) === 0, f);
    const sub = await asUserIn(q, OW.id, "select fee_key from platform_fee_ledger");
    r.check("an owner reads only their own company's ledger rows", (sub.rows ?? []).length === 1 && sub.rows?.[0]?.fee_key === "owner_subscription", sub.rows);
    const up = await asUserIn(q, FIN.id, "select * from staff_update_platform_fee('trip_dw', 0.25, 'confirmed', null, 'TEST bid figure')");
    r.check("finance sets a fee (audited)", !up.error && Number(up.rows?.[0]?.amount_omr) === 0.25 &&
      (await q("select 1 from audit_log where action = 'pricing.platform_fee_update' and target_id = 'trip_dw'")).length === 1, up.error ?? up.rows);
    await q("select accrue_platform_fee('trip_dw', null, null, null, null, null, 'TEST:fee')");
    const [acc] = await q<{ amount_omr: string; fee_status: string }>("select amount_omr, fee_status from platform_fee_ledger where dedupe_key = 'TEST:fee'");
    r.check("later accruals use the new amount and status", Number(acc?.amount_omr) === 0.25 && acc.fee_status === "confirmed", acc);
    const bad = await asUserIn(q, OP.id, "select * from staff_update_platform_fee('trip_dw', 1, 'confirmed', null, 'TEST')");
    r.check("an operator can't set platform fees", bad.error?.includes("forbidden_for_role") === true, bad.error);
  });
  r.check("customers see no platform fee ledger rows", (await t.as(C1.id, "select 1 from platform_fee_ledger")).length === 0);
  const rep = await one<{ r: Row }>(FIN.id, "select staff_platform_fee_report(12) as r");
  r.check("NWS report: accrued fees by month and fee type", Array.isArray(rep.r.rows) && (rep.r.rows as Row[]).some((x) => x.fee_key === "trip_dw") && Array.isArray(rep.r.fees), rep.r);
  await r.denies("customers can't open the NWS report", () => one(C1.id, "select staff_platform_fee_report(12)"), "not_staff");
  await r.denies("customers can't open an owner's fees", () => one(C1.id, "select owner_platform_fees()"), "forbidden_for_role");
  await r.denies("signed-out visitors can't run the subscription job", () => t.as(null, "select accrue_platform_subscriptions()"), "permission denied");
  const cron = (await t.admin<{ name: string }>("select name from cron_wanted where name in ('nama-platform-subscriptions', 'nama-confirm-payments')")).map((x) => x.name).sort();
  r.check("the monthly subscription and payment-confirmation jobs are registered for pg_cron", JSON.stringify(cron) === JSON.stringify(["nama-confirm-payments", "nama-platform-subscriptions"]), cron);

  // ===========================================================================================
  r.start("OVER driver asked for more money (0035)");
  const o5 = await placeOrder(t, C1.id, "DW", 1000);
  await r.denies("not before a driver is on the job", () => one(C1.id, "select * from report_overcharge($1, 5, null)", [o5.id]), "cannot_report");
  await t.as(D2.id, "select * from accept_order($1)", [o5.id]);
  await r.denies("another customer can't report on the order", () => one(C2.id, "select * from report_overcharge($1, 5, null)", [o5.id]), "not_found");
  await r.denies("a driver can't file it", () => one(D2.id, "select * from report_overcharge($1, 5, null)", [o5.id]), "forbidden_for_role");
  await r.denies("an amount must be positive", () => one(C1.id, "select * from report_overcharge($1, -1, null)", [o5.id]), "invalid_amount");
  const oc = await one<Row>(C1.id, "select * from report_overcharge($1, 5, 'TEST asked for 5 OMR extra in cash')", [o5.id]);
  r.check("the customer reports it: an overcharge complaint with high priority and the amount demanded",
    oc.category === "overcharge" && oc.priority === "high" && Number(oc.demanded_omr) === 5 && oc.owner_team === "Fleet compliance" && Number(oc.sla_hours) === 12, oc);
  const [al] = await t.admin<{ severity: string; tanker_id: string }>("select severity, tanker_id from alerts where dedupe_key = $1", [`overcharge:${o5.id}`]);
  r.check("a high alert is raised on the tanker", al?.severity === "high" && al.tanker_id === w.tk.D2, al);
  const [ff] = await t.admin<{ subject_type: string; subject_id: string; score: number }>("select subject_type, subject_id, score from fraud_flags where dedupe_key = $1", [`overcharge:${o5.id}`]);
  r.check("it counts in fraud metrics: a flag on the driver", ff?.subject_type === "driver" && ff.subject_id === D2.id && ff.score >= 70, ff);
  await r.denies("one report per order", () => one(C1.id, "select * from report_overcharge($1, null, null)", [o5.id]), "already_reported");
  const byDrv = await t.as<{ driver_id: string; reports: string }>(FIN.id, "select driver_id, reports from staff_overcharge_by_driver(90)");
  r.check("and in driver metrics: reports per driver", byDrv.some((x) => x.driver_id === D2.id && Number(x.reports) >= 1), byDrv);
  await r.denies("customers can't list overcharge metrics", () => t.as(C1.id, "select * from staff_overcharge_by_driver(90)"), "not_staff");
  const [rule] = await t.admin<{ active: boolean; amount: string }>("select active, amount from penalty_rules where code = 'driver_overcharge'");
  r.check("a matching penalty rule exists for NWS to set (off, 0 OMR until NWS decides)", rule?.active === false && Number(rule.amount) === 0, rule);
  await t.admin("update orders set delivered_at = now() - interval '80 hours' where id = $1", [o2.id]);
  await r.denies("not more than 72 hours after delivery", () => one(C2.id, "select * from report_overcharge($1, null, null)", [o2.id]), "cannot_report");
  const [lbl] = await t.admin<{ label: string }>("select label from complaint_sla where category = 'overcharge'");
  r.check("the category has its label", lbl?.label === "Driver asked for more money", lbl);

  // ===========================================================================================
  r.start("RCPT e-receipts for household deliveries (0036)");
  const [rc] = await t.admin<{ receipt_no: string; year: number; seq: number; total: string }>("select receipt_no, year, seq, total from receipts where order_id = $1", [o2.id]);
  r.check("a delivered household order gets a receipt numbered from the year's sequence", /^RCT-\d{4}-\d{6}$/.test(rc?.receipt_no ?? "") && rc.receipt_no.startsWith(`RCT-${rc.year}-`), rc);
  const [nt] = await t.admin<{ title: string }>("select title from notifications where user_id = $1 and event = 'receipt_ready' and order_id = $2", [C2.id, o2.id]);
  r.check("the customer is told the receipt is ready", nt?.title === "Your receipt is ready", nt);
  const o6 = await placeOrder(t, C2.id, "DW", 650);
  await t.as(D1.id, "select * from accept_order($1)", [o6.id]);
  await t.as(D1.id, "select status from mark_arrived($1)", [o6.id]);
  await deliver(t, D1.id, o6.id);
  const [rc2] = await t.admin<{ year: number; seq: number }>("select year, seq from receipts where order_id = $1", [o6.id]);
  r.check("the next receipt takes the next number", rc2?.year === rc.year && rc2.seq === rc.seq + 1, { rc, rc2 });
  const gen = await one<Row>(C2.id, "select * from file_complaint($1, 'overcharge', 'TEST paid 2 OMR extra', null)", [o6.id]);
  r.check("an overcharge picked on the generic complaint form takes the same path (high priority, alert on the tanker)",
    gen.category === "overcharge" && gen.priority === "high" && (await t.admin("select 1 from alerts where dedupe_key = $1", [`overcharge:${o6.id}`])).length === 1, gen);
  const doc = await one<{ d: Row }>(C2.id, "select order_receipt($1) as d", [o2.id]);
  const d = doc.d;
  r.check("the receipt page gets seller, customer, order, payment, delivery proof and the VAT flag",
    (d.receipt as Row).receipt_no === rc.receipt_no && ((d.receipt as Row).seller as Row).name_ar === "نماء لخدمات المياه" && (d.customer as Row).name === "Test Customer Two" &&
      (d.order as Row).order_no != null && (d.payment as Row)?.gateway_ref != null && (d.pod as Row)?.meter_gal != null && d.vat_pending === true, d);
  await r.denies("another customer can't open it", () => one(C1.id, "select order_receipt($1)", [o2.id]), "not_found");
  r.check("…nor read the receipt row", (await t.as(C1.id, "select 1 from receipts where order_id = $1", [o2.id])).length === 0);
  r.check("NWS staff can open it", (await one<{ d: Row }>(FIN.id, "select order_receipt($1) as d", [o2.id])).d != null);
  await r.denies("no receipt before delivery", () => one(C1.id, "select order_receipt($1)", [o5.id]), "receipt_not_ready");
  await r.denies("nobody writes receipts directly", () => t.as(C2.id, "update receipts set total = 0"), "permission denied");

  // ===========================================================================================
  r.start("EINV business invoices ready for Fawtara (0036)");
  const BA = await t.createUser("money-ba", { role: "business" as never, full_name: "Test Money Biz" });
  const org = await one<Row>(BA.id, "select * from org_register('TST Money Hotel', $1, 'commercial')", [`TSTV${t.runId.slice(-5)}`]);
  await r.denies("a VAT number has the Omani format", () => one(BA.id, "select * from org_set_vat_number('12345')"), "invalid_vat_number");
  const vat = await one<Row>(BA.id, "select * from org_set_vat_number('om 1234-567890')");
  r.check("the business admin records the organisation's VAT number (normalised)", vat.vat_number === "OM1234567890", vat.vat_number);
  await r.denies("a customer can't set an organisation's VAT number", () => one(C1.id, "select * from org_set_vat_number('OM1234567890')"), "forbidden_for_role");
  const sv = await one<Row>(FIN.id, "select * from staff_set_org_vat_number($1, 'OM1234567891', 'TEST certificate checked')", [org.id]);
  r.check("NWS finance can set it too (audited)", sv.vat_number === "OM1234567891" && (await t.admin("select 1 from audit_log where action = 'org.vat_number' and target_id = $1", [org.id])).length === 1, sv.vat_number);
  const [prop] = await t.as<{ id: string }>(BA.id, "select id from save_property(null, 'TEST money site', 'TEST', 'Seeb', $1, $2, 20000)", [LAT, LNG]);
  const [bo] = await t.admin<{ id: string; total: string; vat: string }>(
    `insert into orders (customer_id, org_id, property_id, service_type, gallons, area, zone_id, status, billing, pay_method, payment_status, delivered_at)
     values ($1, $2, $3, 'DW', 3000, $4, (zone_at($5, $6)).id, 'delivered', 'account', 'account', 'on_account', now()) returning id, total, vat`,
    [BA.id, org.id, prop.id, TEST_AREA, LAT, LNG]);
  r.check("business account orders get no household receipt", (await t.admin("select 1 from receipts where order_id = $1", [bo.id])).length === 0);
  const [inv] = await t.admin<Row>("select * from invoice_org($1)", [org.id]);
  r.check("the invoice carries type code 380, currency OMR, the buyer's VAT number and name, and the VAT rate",
    inv.type_code === "380" && inv.currency === "OMR" && inv.buyer_vatin === "OM1234567891" && inv.buyer_name === "TST Money Hotel" && Number(inv.vat_rate) === 0.05 && inv.seller_name === "Nama Water Services", inv);
  const il = await t.as<{ net_amount: string; vat_amount: string; line_total: string; vat_category: string; quantity: string; unit_code: string }>(BA.id, "select * from invoice_lines where invoice_id = $1", [inv.id]);
  r.check("one line per order: gallons, net, VAT category S at the rate, line total",
    il.length === 1 && il[0].vat_category === "S" && Number(il[0].quantity) === 3000 && il[0].unit_code === "GLL" &&
      Math.abs(Number(il[0].net_amount) + Number(il[0].vat_amount) - Number(il[0].line_total)) < 0.0005 && Number(il[0].line_total) === Number(inv.total), il);
  r.check("other users can't read the invoice lines", (await t.as(C1.id, "select 1 from invoice_lines where invoice_id = $1", [inv.id])).length === 0);
  await t.adminRollback(async (q) => {
    const bad = await asUserIn(q, FIN.id, "select staff_update_seller('{\"vat_number\": \"OM12\"}', 'TEST')");
    r.check("the platform's VAT number is validated", bad.error?.includes("invalid_vat_number") === true, bad.error);
    const ok = await asUserIn(q, FIN.id, "select staff_update_seller('{\"vat_number\": \"OM1100000000\"}', 'TEST registration') as s");
    r.check("finance records the platform's VAT number (audited)", (ok.rows?.[0]?.s as Row)?.vat_number === "OM1100000000" &&
      (await q("select 1 from audit_log where action = 'setting.update' and target_id = 'SELLER'")).length === 1, ok.error ?? ok.rows);
    const op = await asUserIn(q, OP.id, "select staff_update_seller('{\"vat_number\": \"\"}', 'TEST')");
    r.check("an operator can't", op.error?.includes("forbidden_for_role") === true, op.error);
  });

  // ===========================================================================================
  r.start("PAY payments confirm at once, pending shown, live (0036)");
  const bal = async (uid: string) => Number((await one<{ b: string }>(uid, "select my_wallet() ->> 'balance' as b")).b);
  // Balances are 3-decimal OMR; compare in baisa so b0 + 10 never trips over binary floats
  // (b0 depends on earlier orders, e.g. 1.2x peak prices between 18:00 and 20:00 Muscat).
  const same = (a: unknown, b: number) => Math.round(Number(a) * 1000) === Math.round(b * 1000);
  const b0 = await bal(C1.id);
  const top = await one<{ w: Row }>(C1.id, "select wallet_topup(10, 'card', '4417') as w");
  const tu = top.w.topup as Row;
  r.check("a top-up is confirmed at once, with a reference", tu?.status === "confirmed" && /^SIM-TU-\d+$/.test(String(tu.gateway_ref)) && same(top.w.balance, b0 + 10), top.w);
  const [memo] = await t.admin<{ memo: string }>("select memo from wallet_tx where id = $1", [tu.wallet_tx_id]);
  r.check("the wallet line names the top-up reference", memo?.memo.includes(`TU-${tu.topup_no}`) === true, memo);
  const pend = await one<{ w: Row }>(C1.id, "select wallet_topup(5, 'card', '0003') as w");
  r.check("a gateway that answers later leaves the top-up pending, not yet in the balance", (pend.w.topup as Row).status === "pending" && same(pend.w.balance, b0 + 10), pend.w);
  await t.admin("update topups set created_at = now() - interval '1 minute' where id = $1", [(pend.w.topup as Row).id]);
  await t.admin("select confirm_simulated_payments()");
  const [tu2] = await t.as<{ status: string; confirmed_at: string | null }>(C1.id, "select status, confirmed_at from topups where id = $1", [(pend.w.topup as Row).id]);
  r.check("the gateway's answer confirms it and credits the wallet", tu2?.status === "confirmed" && tu2.confirmed_at != null && same(await bal(C1.id), b0 + 15), { tu2, b: await bal(C1.id) });
  await r.denies("a declined card is refused", () => one(C1.id, "select wallet_topup(5, 'card', '0002')"), "payment_failed");
  r.check("another customer sees none of these top-ups", (await t.as(C2.id, "select 1 from topups where customer_id = $1", [C1.id])).length === 0);
  await r.denies("customers can't write top-ups", () => t.as(C1.id, "update topups set status = 'confirmed'"), "permission denied");

  const po = await one<Row>(C1.id, `select * from create_order('DW', 1000, ${LAT}, ${LNG}, '${TEST_AREA}', 'TEST', null, null, null, null, false, null, 'card', '0003')`);
  const [pp] = await t.admin<{ status: string }>("select status from payments where order_id = $1", [po.id]);
  r.check("a card order with a slow gateway is placed with its payment pending", po.payment_status === "pending" && pp?.status === "pending" && po.status === "requested", { po: po.payment_status, pp });
  const seenBy = await t.as<{ id: string }>(D2.id, "select id from open_requests_near($1, $2)", [LAT, LNG]);
  r.check("…and is dispatched all the same (nothing waits for the payment)", seenBy.some((x) => x.id === po.id), seenBy.length);
  await t.admin("update payments set created_at = now() - interval '1 minute' where order_id = $1", [po.id]);
  await t.admin("select confirm_simulated_payments()");
  const [pp2] = await t.admin<{ status: string; confirmed_at: string | null; ps: string }>("select p.status, p.confirmed_at, o.payment_status as ps from payments p join orders o on o.id = p.order_id where p.order_id = $1", [po.id]);
  r.check("the gateway's answer authorises it", pp2?.status === "authorized" && pp2.confirmed_at != null && pp2.ps === "authorized", pp2);
  const qo = await placeOrder(t, C1.id, "DW", 650);
  const [qp] = await t.admin<{ status: string; confirmed_at: string | null }>("select status, confirmed_at from payments where order_id = $1", [qo.id]);
  r.check("a normal card payment is confirmed at once (with the time)", qp?.status === "authorized" && qp.confirmed_at != null, qp);
  await t.as(C1.id, "select * from cancel_order($1)", [qo.id]);
  await t.as(C1.id, "select * from cancel_order($1)", [po.id]);
  const pub = (await t.admin<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")).map((x) => x.tablename);
  r.check("payments, top-ups and wallet lines update live (realtime publication)", ["payments", "topups", "wallet_tx"].every((x) => pub.includes(x)), pub);
  await r.denies("signed-out visitors can't run the confirmation job", () => t.as(null, "select confirm_simulated_payments()"), "permission denied");
  await r.denies("customers can't run it either", () => t.as(C1.id, "select confirm_simulated_payments()"), "not_staff");
}
