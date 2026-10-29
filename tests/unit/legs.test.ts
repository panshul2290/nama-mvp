// Unit tests for driver trip legs (components/driver/legs.ts): test-zone orders (0020)
// target a virtual site at the tanker's position; Omani orders never use test sites.
//   npm run test:unit
import { insideGeofence, legIndex, nearestSite, tripLegs } from "../../components/driver/legs";
import type { Order, OrderLocation, Site } from "../../lib/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

const site = (code: string, kind: Site["kind"], lat: number, lng: number, extra: Partial<Site> = {}): Site => ({
  id: code, code, kind, name: code, service_types: kind === "fill" ? ["DW", "TE"] : ["WW"], lat, lng, radius_m: 300, operator: "NWS", active: true, ...extra,
});
const SITES: Site[] = [
  site("FS-GHB", "fill", 23.603, 58.387),
  site("ST-ANS", "discharge", 23.5655, 58.336),
  site("TEST-FILL", "fill", 22, 79, { is_test: true, radius_m: 5000, name: "Test station" }),
  site("TEST-DIS", "discharge", 22, 79, { is_test: true, radius_m: 5000, name: "Test plant" }),
];
const order = (o: Partial<Order>) => ({ id: "o", order_no: 1, service_type: "DW", gallons: 1000, area: "x", status: "accepted", ...o }) as Order;
const loc = (lat: number, lng: number) => ({ order_id: "o", lat, lng, address: "" }) as OrderLocation;
const DELHI = { lat: 28.62, lng: 77.22 };
const NAMES = { fill: "محطة تجريبية", discharge: "محطة معالجة تجريبية" };

console.log("## UNIT driver trip legs");
const dw = tripLegs(order({ is_test: true }), loc(28.6, 77.2), SITES, DELHI, NAMES);
check("test DW order: fill at the tanker's position, then the customer", dw[0].kind === "fill" && dw[0].target === DELHI && dw[1].kind === "cust", dw);
check("… the virtual site is the test station, at the tanker, named in the driver's language",
  dw[0].site?.code === "TEST-FILL" && dw[0].site.lat === DELHI.lat && dw[0].site.name === NAMES.fill, dw[0].site);
check("… and the tanker is inside its geofence, wherever it is", insideGeofence(dw[0].site, DELHI));
const ww = tripLegs(order({ is_test: true, service_type: "WW", status: "collected" }), loc(19.08, 72.88), SITES, DELHI, NAMES);
check("test WW order: customer, then discharge at the tanker's position (Test plant)",
  ww[0].kind === "cust" && ww[1].kind === "discharge" && ww[1].site?.code === "TEST-DIS" && insideGeofence(ww[1].site, DELHI) && legIndex(order({ service_type: "WW", status: "collected" })) === 1, ww);

const om = tripLegs(order({}), loc(23.6, 58.2), SITES, DELHI);
check("Omani DW order with the tanker in India: fill at a real Omani station, not a test site", om[0].site?.code === "FS-GHB" && !insideGeofence(om[0].site, DELHI), om[0].site);
const omWw = tripLegs(order({ service_type: "WW", status: "collected" }), loc(23.6, 58.2), SITES, { lat: 22.001, lng: 79.001 });
check("Omani WW order, tanker standing on the test site's nominal spot: still a real plant", omWw[1].site?.code === "ST-ANS", omWw[1].site);
check("nearestSite never returns a test site", nearestSite(SITES, "fill", "DW", { lat: 22, lng: 79 })?.code === "FS-GHB");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
