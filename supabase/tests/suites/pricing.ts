// Pricing governance: rule statuses, rules-driven pricing, BILLING_MODE.
// Anything that changes a rule or the billing mode runs inside a transaction
// that is always rolled back, so a live project never sees the change.
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, peakNow, placeOrder, setOnline, TEST_AREA } from "../lib/world";

type Q = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** Run sql as a user inside the current (rolled-back) transaction; returns rows or the error message. */
async function asUserIn(q: Q, uid: string, sql: string, params: unknown[] = []): Promise<{ rows?: Record<string, unknown>[]; error?: string }> {
  await q("savepoint s");
  try {
    await q("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [uid, JSON.stringify({ sub: uid, role: "authenticated" })]);
    await q("set local role authenticated");
    const rows = await q(sql, params);
    await q("reset role");
    await q("release savepoint s");
    return { rows };
  } catch (e) {
    await q("rollback to savepoint s");
    await q("reset role");
    return { error: (e as Error).message };
  }
}

async function adminIn(q: Q, sql: string, params: unknown[] = []): Promise<{ rows?: Record<string, unknown>[]; error?: string }> {
  await q("savepoint a");
  try {
    const rows = await q(sql, params);
    await q("release savepoint a");
    return { rows };
  } catch (e) {
    await q("rollback to savepoint a");
    return { error: (e as Error).message };
  }
}

const PLACE = `select * from place_order($1, $2, 23.6, 58.2, '${TEST_AREA}', 'TEST address')`;

export async function pricingSuite(t: Target, r: Reporter) {
  r.start("RULES pricing rules and billing mode");
  const w = await makeWorld(t, "price");
  const { C1, D2 } = w;

  // ---- the seeded rules
  const rules = await t.admin<{ rule_key: string; value: string; status: string; source: string }>("select rule_key, value, status, source from pricing_rules order by rule_key");
  const by = (s: string) => rules.filter((x) => x.status === s).map((x) => x.rule_key).sort();
  r.check("confirmed (tender tariff table): DW ≤650 gal 1 baisa, WW 1 baisa, TE 0.05 baisa (+ the 650 gal threshold)",
    JSON.stringify(by("confirmed")) === JSON.stringify(["dw_rate_upto_650", "dw_tier_threshold_gal", "te_rate", "ww_rate"]) &&
      rules.find((x) => x.rule_key === "dw_rate_upto_650")?.value === "1" && rules.find((x) => x.rule_key === "ww_rate")?.value === "1" && rules.find((x) => x.rule_key === "te_rate")?.value === "0.05" &&
      rules.filter((x) => x.status === "confirmed").every((x) => x.source === "Tender tariff table"),
    by("confirmed"));
  r.check("pending clarification: DW >650 gal basis (Q05: slab vs whole volume) and VAT application (Q07)",
    JSON.stringify(by("pending_clarification")) === JSON.stringify(["dw_above_650_basis", "dw_rate_above_650", "vat_rate"]) &&
      rules.find((x) => x.rule_key === "dw_above_650_basis")?.source === "Q05" && rules.find((x) => x.rule_key === "dw_rate_above_650")?.source === "Q05" &&
      rules.find((x) => x.rule_key === "vat_rate")?.source === "Q07",
    by("pending_clarification"));
  r.check("assumptions: base fees DW 3.5 / WW 6 / TE 8, driver share 0.85, peak 1.2, priority 1.5, monthly 0.10, yearly 0.15, cancel fee 1",
    JSON.stringify(rules.filter((x) => x.status === "assumption").map((x) => `${x.rule_key}=${x.value}`).sort()) ===
      JSON.stringify(["cancel_fee_omr=1", "demand_cap=1.3", "demand_min_open=10", "demand_ratio_threshold=3", "demand_step=0.1", "discount_monthly=0.10", "discount_yearly=0.15",
        "distance_cap=1.5", "distance_free_km=15", "distance_per_km=0.02", "driver_share=0.85", "dynamic_cap=2.5", "fee_dw_omr=3.5", "fee_te_omr=8", "fee_ww_omr=6",
        "peak_multiplier=1.2", "priority_multiplier=1.5"]),
    by("assumption"));
  const [mode] = await t.admin<{ value: string }>("select value from app_settings where key = 'BILLING_MODE'");
  r.check("BILLING_MODE defaults to demo", mode?.value === "demo", mode);

  // ---- demo mode: orders are priced and every line carries its rule status
  // (slot-less orders are peak-priced between 18:00 and 20:00 Muscat: expected figures follow)
  const peak = await peakNow(t);
  const small = await placeOrder(t, C1.id, "DW", 600);
  const big = await placeOrder(t, C1.id, "DW", 3000);
  const ww = await placeOrder(t, C1.id, "WW", 3000);
  const basis = async (id: string) => (await t.admin<{ price_basis: Record<string, unknown> }>("select price_basis from orders where id = $1", [id]))[0].price_basis;
  const b1 = await basis(small.id);
  r.check("demo: DW 600 gal is priced; water confirmed, fee assumption, VAT pending, total pending, earnings assumption",
    small.total === (peak ? "5.040" : "4.305") && b1.water === "confirmed" && b1.fee === "assumption" && b1.vat === "pending_clarification" && b1.total === "pending_clarification" && b1.earnings === "assumption" && b1.mode === "demo",
    { total: small.total, b1 });
  const b2 = await basis(big.id);
  r.check("demo: DW 3,000 gal (slab) = 11.760 and its water line is pending (Q05)", big.total === (peak ? "12.495" : "11.760") && b2.water === "pending_clarification", { total: big.total, b2 });
  const b3 = await basis(ww.id);
  r.check("demo: WW 3,000 gal water line is confirmed", b3.water === "confirmed" && ww.total === (peak ? "10.710" : "9.450"), { total: ww.total, b3 });
  await setOnline(t, D2.id, true);
  const [req] = await t.as<{ earnings_status: string }>(D2.id, "select earnings_status from open_requests_near(23.6, 58.2) where id = $1", [small.id]);
  r.check("driver's open-request list reports the earnings status (assumption)", req?.earnings_status === "assumption", req);

  // ---- prices come only from the rules table
  await t.adminRollback(async (q) => {
    await q("update pricing_rules set value = '4' where rule_key = 'fee_dw_omr'");
    const [a] = await q<{ delivery_fee: string; total: string }>("select delivery_fee, total from price_quote('DW', 600)");
    r.check("changing a rule changes the price (fee_dw_omr 3.5 → 4: DW 600 = 4.830)", a.delivery_fee === "4.000" && a.total === "4.830", a);
    await q("update pricing_rules set value = 'whole_volume' where rule_key = 'dw_above_650_basis'");
    const [b] = await q<{ water_charge: string }>("select water_charge from price_quote('DW', 3000)");
    r.check("switching Q05 to whole_volume prices DW 3,000 gal water at 9.000 (3 baisa on every gallon)", b.water_charge === "9.000", b);
  });

  const [forced] = await t.admin<{ water_charge: string; total: string }>(
    "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings) values ($1,'DW',600,$2,0,0,0,0.001,99) returning water_charge, total",
    [C1.id, TEST_AREA],
  );
  r.check("a price supplied on insert is replaced by the rules, even for a privileged role", forced.total === "4.305" && forced.water_charge === "0.600", forced);
  await r.denies("prices are frozen after insert (privileged update → price_immutable)", () => t.admin("update orders set total = 1 where id = $1", [small.id]), "price_immutable");

  // ---- production mode
  await t.adminRollback(async (q) => {
    await q("update app_settings set value = 'production' where key = 'BILLING_MODE'");
    const p1 = await asUserIn(q, C1.id, PLACE, ["DW", 600]);
    r.check("production: an order using unconfirmed rules is refused with a clear error",
      !!p1.error && p1.error.includes("pricing_unconfirmed") && p1.error.includes("fee_dw_omr (assumption") && p1.error.includes("vat_rate (pending_clarification, Q07)") && p1.error.includes("driver_share (assumption"),
      p1.error ?? p1.rows);
    const p2 = await asUserIn(q, C1.id, PLACE, ["DW", 3000]);
    r.check("production: the error also names the Q05 rules for DW above 650 gal",
      !!p2.error && p2.error.includes("dw_rate_above_650 (pending_clarification, Q05)") && p2.error.includes("dw_above_650_basis (pending_clarification, Q05)"), p2.error);
    const p3 = await adminIn(q, "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings) values ($1,'WW',100,$2,0,0,0,0,0)", [C1.id, TEST_AREA]);
    r.check("production: the trigger also refuses a privileged direct insert", !!p3.error && p3.error.includes("pricing_unconfirmed"), p3.error);

    await q(`update pricing_rules set status = 'confirmed' where rule_key in ('fee_dw_omr', 'vat_rate', 'driver_share'${peak ? ", 'peak_multiplier'" : ""})`);
    const p4 = await asUserIn(q, C1.id, PLACE, ["DW", 600]);
    const pb = p4.rows?.[0]?.price_basis as Record<string, unknown> | undefined;
    r.check("production: once every rule the order uses is confirmed, it is priced (DW 600 gal)",
      !p4.error && p4.rows?.[0]?.total === (peak ? "5.040" : "4.305") && pb?.mode === "production" && pb?.total === "confirmed", p4.error ?? pb);
    const p5 = await asUserIn(q, C1.id, PLACE, ["DW", 3000]);
    r.check("production: DW 3,000 gal is still refused while Q05 is pending — and only the Q05 rules are listed",
      !!p5.error && p5.error.includes("dw_rate_above_650") && !p5.error.includes("fee_dw_omr") && !p5.error.includes("vat_rate"), p5.error);
    const bad = await adminIn(q, "update app_settings set value = 'live' where key = 'BILLING_MODE'");
    r.check("BILLING_MODE only accepts demo or production", !!bad.error && bad.error.includes("check"), bad.error);
  });
  const [after] = await t.admin<{ value: string }>("select value from app_settings where key = 'BILLING_MODE'");
  const [feeStill] = await t.admin<{ status: string }>("select status from pricing_rules where rule_key = 'fee_dw_omr'");
  r.check("after the production-mode checks, BILLING_MODE and rule statuses are back as they were (rolled back)", after.value === "demo" && feeStill.status === "assumption", { after, feeStill });

  // ---- nobody but the database owner can change rules or the mode
  await r.denies("anon cannot read pricing_rules", () => t.as(null, "select * from pricing_rules"), "permission denied");
  await r.allows("signed-in users can read pricing_rules (for the quote screen)", () => t.as(C1.id, "select rule_key, status from pricing_rules"), (x) => x.length === rules.length);
  for (const [role, uid] of [["customer", C1.id], ["driver", D2.id]] as const) {
    await r.denies(`${role} cannot change a pricing rule`, () => t.as(uid, "update pricing_rules set value = '0' where rule_key = 'fee_dw_omr'"), "permission denied");
    await r.denies(`${role} cannot mark a rule confirmed`, () => t.as(uid, "update pricing_rules set status = 'confirmed'"), "permission denied");
    await r.denies(`${role} cannot add a pricing rule`, () => t.as(uid, "insert into pricing_rules (rule_key, value, status, source) values ('x', '0', 'confirmed', 'x')"), "permission denied");
    await r.denies(`${role} cannot change BILLING_MODE`, () => t.as(uid, "update app_settings set value = 'demo' where key = 'BILLING_MODE'"), "permission denied");
  }
}
