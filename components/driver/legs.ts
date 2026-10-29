// Multi-leg trips, as in the prototype's buildRoute():
//   DW / TE: fill at the nearest NWS filling station → deliver to the customer
//   WW:      collect at the customer → discharge at the nearest approved site
// Test orders (0020, "Test – India") fill and discharge wherever the tanker is:
// the leg targets a virtual site at the tanker's position, as confirm_fill and
// confirm_discharge accept them there.
import { distanceKm } from "@/lib/geo";
import type { LngLat, Order, OrderLocation, Site } from "@/lib/types";

export type LegKind = "fill" | "cust" | "discharge";
export type Leg = { kind: LegKind; target: LngLat | null; site: Site | null };

/** Nearest active site of a kind that serves the order's service, from `near` (or the first one). */
export function nearestSite(sites: Site[], kind: Site["kind"], service: Order["service_type"], near: LngLat | null): Site | null {
  const ok = sites.filter((s) => s.kind === kind && s.active && !s.is_test && s.service_types.includes(service));
  if (!near) return ok[0] ?? null;
  return ok.reduce<Site | null>((best, s) => (!best || distanceKm(near, s) < distanceKm(near, best) ? s : best), null);
}

/** Names for the virtual test sites, in the driver's language. */
export type TestSiteNames = { fill: string; discharge: string };

/** The test site of a kind, moved to the tanker's position (where the server accepts the step). */
function testSite(sites: Site[], kind: Site["kind"], me: LngLat | null, names?: TestSiteNames): Site | null {
  const s = sites.find((x) => x.is_test && x.kind === kind);
  if (!s) return null;
  return { ...s, name: names?.[kind] ?? s.name, ...(me ? { lat: me.lat, lng: me.lng } : {}) };
}

export function tripLegs(order: Order, loc: OrderLocation | null, sites: Site[], me: LngLat | null, testNames?: TestSiteNames): Leg[] {
  const cust: Leg = { kind: "cust", target: loc ? { lat: loc.lat, lng: loc.lng } : null, site: null };
  const near = loc ?? me;
  if (order.is_test) {
    const kind = order.service_type === "WW" ? "discharge" : "fill";
    const site: Leg = { kind, target: me, site: testSite(sites, kind, me, testNames) };
    return kind === "discharge" ? [cust, site] : [site, cust];
  }
  const real = sites.filter((x) => !x.is_test);
  if (order.service_type === "WW") {
    // A site the tanker is already inside wins (confirm_discharge verifies against the site nearest the tanker).
    const here = order.status === "collected" ? real.find((x) => x.kind === "discharge" && x.active && x.service_types.includes("WW") && insideGeofence(x, me)) : undefined;
    const s = here ?? nearestSite(sites, "discharge", "WW", near);
    return [cust, { kind: "discharge", target: s ? { lat: s.lat, lng: s.lng } : null, site: s }];
  }
  // The fill site the server records wins once filling is confirmed. Before that, a station the
  // tanker is already inside wins (confirm_fill verifies against the station nearest the tanker).
  const here = real.find((x) => x.kind === "fill" && x.active && x.service_types.includes(order.service_type) && insideGeofence(x, me));
  const s = (order.fill_site_id && real.find((x) => x.id === order.fill_site_id)) || here || nearestSite(real, "fill", order.service_type, near);
  return [{ kind: "fill", target: s ? { lat: s.lat, lng: s.lng } : null, site: s }, cust];
}

/** Index of the leg in progress. */
export function legIndex(order: Order): number {
  if (order.service_type === "WW") return order.status === "collected" ? 1 : 0;
  return !order.filled_at && (order.status === "accepted" || order.status === "arriving") ? 0 : 1;
}

/** Metres from a point to a site's centre, or null without a fix. */
export const metresTo = (site: Site | null, p: LngLat | null) => (site && p ? distanceKm(p, site) * 1000 : null);

export const insideGeofence = (site: Site | null, p: LngLat | null) => {
  const m = metresTo(site, p);
  return m != null && site != null && m <= site.radius_m;
};
