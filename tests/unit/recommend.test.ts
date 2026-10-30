// Unit tests for smart recommendations (lib/recommend.ts) and the household SLA reading
// (lib/orderSla.ts).  npm run test:unit
import { appSla, readSla, slaSummary } from "../../lib/orderSla";
import { feeFactorList, pickOffer } from "../../components/driver/offer";
import { pushRoute } from "../../lib/pushRoute";
import { contractFrequency, fitPreset, GAL_PER_PERSON_DAY, recommend } from "../../lib/recommend";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};
const eq = (name: string, got: unknown, want: unknown) => check(`${name} → ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), got);

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();
const dw = (g: number, d: number, property_id: string | null = "P1") => ({ service_type: "DW", gallons: g, delivered_at: day(d), property_id });

console.log("## UNIT smart recommendations");
eq("presets: the smallest that covers the need", fitPreset("DW", 2000), 3000);
eq("presets: never more than the tank holds", fitPreset("DW", 4000, 3500), 3000);
eq("presets: a tiny tank still gets the smallest preset", fitPreset("DW", 900, 500), 650);
{
  const r = recommend({ service: "DW", tankGal: 5000, history: [dw(3000, 0), dw(3000, 7), dw(1000, 14), dw(3000, 21)], propertyId: "P1" });
  eq("history: the usual volume", r.gallons, 3000);
  eq("history: the usual interval in days", r.everyDays, 7);
  eq("history: basis and count", [r.basis, r.orders], ["history", 4]);
}
{
  const r = recommend({ service: "DW", tankGal: 5000, history: [dw(3000, 0), dw(3000, 7), dw(3000, 14, "P2")], propertyId: "P2" });
  check("history: another property's deliveries don't count", r.basis !== "history", r);
}
{
  const r = recommend({ service: "DW", tankGal: 5000, household: 6, history: [] });
  eq("household: daily use", r.perDay, 6 * GAL_PER_PERSON_DAY);
  eq("household: a week's water rounded up to a preset", r.gallons, 3000);
  eq("household: how long that lasts", r.everyDays, Math.floor(3000 / (6 * GAL_PER_PERSON_DAY)));
}
{
  const r = recommend({ service: "DW", tankGal: 1000, household: 6, history: [] });
  eq("household: capped by the tank", r.gallons, 1000);
  check("household: a small tank means more frequent deliveries", r.everyDays !== null && r.everyDays <= 4, r);
}
eq("tank only: fill the tank", recommend({ service: "DW", tankGal: 2000, history: [] }).gallons, 2000);
eq("tank only: no frequency without history or household", recommend({ service: "DW", tankGal: 2000, history: [] }).everyDays, null);
eq("nothing known: a default", recommend({ service: "DW", history: [] }).basis, "default");
eq("wastewater default", recommend({ service: "WW", history: [] }).gallons, 3000);
eq("wastewater from one past collection", recommend({ service: "WW", history: [{ service_type: "WW", gallons: 5000, delivered_at: day(0) }] }).gallons, 5000);
eq("frequency: 7 days → weekly", contractFrequency(7), "weekly");
eq("frequency: 14 days → biweekly", contractFrequency(14), "biweekly");
eq("frequency: 30 days → monthly", contractFrequency(30), "monthly");

console.log("## UNIT household SLA (my_order_sla or the shared rule)");
const o = { service_type: "DW", created_at: "2026-10-01T06:00:00Z", slot_end: "2026-10-01T10:00:00Z", delivered_at: "2026-10-01T09:30:00Z" };
eq("app rule: delivered before the slot end is on time", appSla(o).onTime, true);
eq("app rule: open orders have no verdict", appSla({ ...o, delivered_at: null }).onTime, null);
eq("database boolean", readSla(false, o).onTime, false);
eq("database row with on_time", [readSla({ on_time: false, due_at: "2026-10-01T09:00:00Z" }, o).onTime, readSla({ on_time: false, due_at: "2026-10-01T09:00:00Z" }, o).source], [false, "db"]);
eq("database row: due time read", readSla([{ is_on_time: true, deadline: "2026-10-01T09:00:00Z" }], o).dueAt, Date.parse("2026-10-01T09:00:00Z"));
eq("my_order_sla state late", [readSla({ state: "late", due_at: "2026-10-01T09:00:00Z", served_at: "2026-10-01T09:30:00Z" }, o).onTime, readSla({ state: "late" }, o).source], [false, "db"]);
eq("my_order_sla open state has no verdict yet", readSla({ state: "at_risk", due_at: "2026-10-01T09:00:00Z" }, o).onTime, null);
eq("unreadable answer falls back to the app rule", readSla({ something: 1 }, o).source, "app");
eq("summary", slaSummary([appSla(o), appSla({ ...o, delivered_at: "2026-10-01T11:00:00Z" }), appSla({ ...o, delivered_at: null })]), { served: 2, onTime: 1, late: 1, pct: 50 });

console.log("## UNIT push notification taps");
eq("customer: an order update opens the order", pushRoute("customer", { order_id: "abc", event: "order_arriving" }), "/customer/order?id=abc");
eq("customer: a message opens the order's chat", pushRoute("customer", { order_id: "abc", event: "new_message" }), "/customer/order?id=abc&chat=1");
eq("driver: a new job opens Jobs", pushRoute("driver", { event: "new_job" }), "/driver/jobs");
eq("driver: a message opens the trip", pushRoute("driver", { order_id: "x", event: "new_message" }), "/driver/trip");
eq("an explicit route for the same app is used", pushRoute("driver", { route: "/driver/profile#permit" }), "/driver/profile#permit");
eq("a route into another app is ignored", pushRoute("customer", { route: "/nws/orders" }), "/customer/inbox");
eq("driver: an auto-dispatch offer opens Jobs", pushRoute("driver", { order_id: "x", event: "job_offered" }), "/driver/jobs");
eq("driver: low filling credit opens the top-up", pushRoute("driver", { event: "fill_credit_low" }), "/driver/earnings#fill");
eq("customer: a data export opens Account → Privacy", pushRoute("customer", { event: "data_export_ready" }), "/customer/account#data");

console.log("## UNIT driver offers");
{
  const now = Date.parse("2026-10-30T10:00:00Z");
  const row = (id: string, extra: object = {}) => ({ id, order_no: 1, service_type: "DW" as const, gallons: 1000, area: "A", distance_km: 1, driver_earnings: "1", earnings_status: null, created_at: "2026-10-30T09:59:00Z", ...extra });
  const server = pickOffer([row("a"), row("b", { offer_expires_at: "2026-10-30T10:00:25Z" })], { a: now - 1000, b: now - 1000 }, now);
  eq("a server offer to this tanker comes first, with its own countdown", [server?.job.id, server?.left, server?.server], ["b", 25, true]);
  const local = pickOffer([row("a")], { a: now - 10_000 }, now);
  eq("without one, the 60 s local offer", [local?.job.id, local?.left, local?.server], ["a", 50, false]);
  eq("an expired server offer isn't shown as an offer", pickOffer([row("b", { offer_expires_at: "2026-10-30T09:59:00Z" })], { b: now - 1000 }, now), null);
  eq("fee factors: only those that change the fee", feeFactorList({ distance_mult: 1.15, demand_mult: 1, peak_mult: "1.2" }), [["distance", 1.15], ["peak", 1.2]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
