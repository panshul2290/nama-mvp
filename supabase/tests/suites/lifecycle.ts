// Order lifecycle, pricing and order numbers. Every assertion is scoped to rows
// this suite created, so it is safe to run against a live project.
import { quote as jsQuote, type PricingRule } from "../../../lib/pricing";
import type { Reporter, Target } from "../lib/harness";
import { makeWorld, placeOrder, setOnline } from "../lib/world";

export async function lifecycleSuite(t: Target, r: Reporter) {
  r.start("PRICE pricing");
  const q = async (type: string, g: number) => (await t.admin<Record<string, string>>("select * from price_quote($1, $2)", [type, g]))[0];
  const cases: [string, number, string[]][] = [
    ["DW", 650, ["0.650", "3.500", "0.208", "4.358", "2.975"]],
    ["DW", 1000, ["1.700", "3.500", "0.260", "5.460", "2.975"]],
    ["DW", 3000, ["7.700", "3.500", "0.560", "11.760", "2.975"]],
    ["WW", 3000, ["3.000", "6.000", "0.450", "9.450", "5.100"]],
    ["TE", 10000, ["0.500", "8.000", "0.425", "8.925", "6.800"]],
  ];
  for (const [type, g, want] of cases) {
    const p = await q(type, g);
    const got = [p.water_charge, p.delivery_fee, p.vat, p.total, p.driver_earnings].map(String);
    r.check(`price_quote ${type} ${g} gal = ${want[3]} OMR (water/fee/VAT/total/earnings)`, JSON.stringify(got) === JSON.stringify(want), got);
  }
  // lib/pricing.ts must reproduce price_quote() from the same rules table.
  const rules = Object.fromEntries((await t.admin<PricingRule>("select rule_key, value, status, source, notes from pricing_rules")).map((x) => [x.rule_key, x]));
  let mismatch = 0;
  const first: unknown[] = [];
  for (const type of ["DW", "WW", "TE"] as const) {
    for (const g of [1, 2, 3, 9, 10, 11, 19, 20, 21, 99, 649, 650, 651, 652, 999, 1234, 3333, 5000, 9999, 10001, 19999]) {
      const p = await q(type, g);
      const js = jsQuote(type, g, rules);
      const sql = [...[p.water_charge, p.delivery_fee, p.vat, p.total, p.driver_earnings].map((v) => Math.round(Number(v) * 1000)), p.water_status, p.fee_status, p.vat_status, p.total_status, p.earnings_status];
      const mine = [js.water, js.fee, js.vat, js.total, js.driverEarnings, js.status.water, js.status.fee, js.status.vat, js.status.total, js.status.earnings];
      if (JSON.stringify(sql) !== JSON.stringify(mine)) {
        mismatch++;
        if (first.length < 3) first.push({ type, g, sql, mine });
      }
    }
  }
  r.check("lib/pricing.ts reproduces price_quote() amounts and line statuses from the rules table (63 type/volume pairs)", mismatch === 0, first);

  r.start("LIFE order lifecycle");
  const w = await makeWorld(t, "life");
  const { C1, D1, D2, D3 } = w;

  const o1 = await placeOrder(t, C1.id, "DW", 1000);
  r.check("place_order prices on the server (DW 1,000 gal = 5.460) and starts as requested", o1.total === "5.460" && o1.status === "requested", o1);
  r.check("the order gets an order_no ≥ 48200", Number(o1.order_no) >= 48200, o1.order_no);

  const mine = async (driver: string) => (await t.as<{ id: string }>(driver, "select id from open_requests_near(23.6, 58.2)")).map((x) => x.id);
  r.check("offline driver sees no requests", !(await mine(D1.id)).includes(o1.id));
  for (const d of [D1, D2, D3]) await setOnline(t, d.id, true);
  r.check("online matching driver sees the request", (await mine(D1.id)).includes(o1.id));
  r.check("driver of another service type does not", !(await mine(D3.id)).includes(o1.id));

  const big = await placeOrder(t, C1.id, "DW", 4000);
  r.check("capacity filter: 3,000-gal tanker doesn't see a 4,000-gal request; 5,000-gal tanker does", !(await mine(D1.id)).includes(big.id) && (await mine(D2.id)).includes(big.id));
  await r.denies("ineligible driver accepting it → not_eligible", () => t.as(D1.id, "select * from accept_order($1)", [big.id]), "not_eligible");

  const [acc] = await t.as<{ status: string; tanker_plate: string; driver_name: string }>(D1.id, "select * from accept_order($1)", [o1.id]);
  r.check("first driver accepts; plate and name are snapshotted on the order", acc.status === "accepted" && acc.tanker_plate === w.plate("D1") && acc.driver_name === "Test Driver One", acc);
  await r.denies("second driver → already_taken", () => t.as(D2.id, "select * from accept_order($1)", [o1.id]), "already_taken");
  const o2 = await placeOrder(t, C1.id, "DW", 500);
  await r.denies("busy driver cannot take a second job → driver_busy", () => t.as(D1.id, "select * from accept_order($1)", [o2.id]), "driver_busy");
  await r.denies("customer cannot cancel once accepted → cannot_cancel", () => t.as(C1.id, "select * from cancel_order($1)", [o1.id]), "cannot_cancel");

  await t.as(D1.id, "select report_location(23.59, 58.17)");
  const [st] = await t.as<{ status: string }>(C1.id, "select status from orders where id = $1", [o1.id]);
  r.check("first GPS ping moves the job to arriving", st.status === "arriving", st);
  const [arr] = await t.as<{ status: string }>(D1.id, "select status from mark_arrived($1)", [o1.id]);
  const [del] = await t.as<{ status: string }>(D1.id, "select status from mark_delivered($1)", [o1.id]);
  r.check("arrived → delivered", arr.status === "arrived" && del.status === "delivered");
  const [snap] = await t.as<{ tanker_plate: string }>(C1.id, "select tanker_plate from orders where id = $1", [o1.id]);
  r.check("customer keeps the plate snapshot after delivery", snap.tanker_plate === w.plate("D1"));
  const [free] = await t.as<{ status: string }>(D1.id, "select status from accept_order($1)", [o2.id]);
  r.check("driver is free for the next job after delivery", free.status === "accepted");
  const [cx] = await t.as<{ status: string }>(C1.id, "select status from cancel_order($1)", [big.id]);
  r.check("customer cancels an open request", cx.status === "cancelled");
  await r.denies("a cancelled request can't be accepted → already_taken", () => t.as(D2.id, "select * from accept_order($1)", [big.id]), "already_taken");

  r.start("ONUM order numbers");
  const nums: number[] = [];
  for (let i = 0; i < 25; i++) nums.push(Number((await placeOrder(t, C1.id, "WW", 50)).order_no));
  r.check("25 orders in a row get 25 distinct, increasing numbers", new Set(nums).size === 25 && nums.every((v, i) => i === 0 || v > nums[i - 1]), nums);
  const [dup] = await t.admin<{ n: number }>("select count(*)::int - count(distinct order_no)::int as n from orders");
  r.check("no two orders in the database share a number", dup.n === 0, dup);
  const [forced] = await t.admin<{ order_no: string }>(
    "insert into orders (customer_id, service_type, gallons, area, water_charge, delivery_fee, vat, total, driver_earnings, order_no) values ($1,'WW',1,'TEST automated check',0,0,0,0,0,$2) returning order_no",
    [C1.id, nums[0]],
  );
  r.check("a number supplied on insert is ignored, even by a privileged role (no duplicate possible)", Number(forced.order_no) > nums[24], forced);
  for (const [role, uid] of [["customer", C1.id], ["driver", D1.id]] as const) {
    await r.denies(`${role} cannot change an order_no`, () => t.as(uid, "update orders set order_no = 1 where id = $1", [o1.id]), "permission denied");
    await r.denies(`${role} cannot call nextval on the sequence`, () => t.as(uid, "select nextval('orders_order_no_seq')"), "permission denied");
    await r.denies(`${role} cannot setval the sequence`, () => t.as(uid, "select setval('orders_order_no_seq', 1)"), "permission denied");
  }
  await r.denies("order_no is frozen even for privileged updates", () => t.admin("update orders set order_no = order_no + 100000 where id = $1", [o1.id]), "order_no_immutable");
  const [ret] = await t.as<{ order_no: string }>(C1.id, "select order_no from cancel_order($1)", [(await placeOrder(t, C1.id, "DW", 100)).id]);
  r.check("RPCs return order_no (cancel_order)", Number(ret.order_no) > 0);
  const [onr] = await t.as<{ order_no: string }>(D2.id, "select order_no from open_requests_near(23.6, 58.2) where id = $1", [(await placeOrder(t, C1.id, "DW", 100)).id]);
  r.check("RPCs return order_no (open_requests_near)", Number(onr?.order_no) > 0, onr);
}
