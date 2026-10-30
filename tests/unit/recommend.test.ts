// Unit tests for smart recommendations (lib/recommend.ts) and the household SLA reading
// (lib/orderSla.ts).  npm run test:unit
import { appSla, readSla, slaSummary } from "../../lib/orderSla";
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
eq("unreadable answer falls back to the app rule", readSla({ something: 1 }, o).source, "app");
eq("summary", slaSummary([appSla(o), appSla({ ...o, delivered_at: "2026-10-01T11:00:00Z" }), appSla({ ...o, delivered_at: null })]), { served: 2, onTime: 1, late: 1, pct: 50 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
