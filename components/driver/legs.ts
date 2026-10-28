// Multi-leg trips, as in the prototype's buildRoute():
//   DW / TE: fill at the nearest NWS filling station → deliver to the customer
//   WW:      collect at the customer → discharge at the nearest approved site
import { distanceKm } from "@/lib/geo";
import type { LngLat, Order, OrderLocation, Site } from "@/lib/types";

export type LegKind = "fill" | "cust" | "discharge";
export type Leg = { kind: LegKind; target: LngLat | null; site: Site | null };

/** Nearest active site of a kind that serves the order's service, from `near` (or the first one). */
export function nearestSite(sites: Site[], kind: Site["kind"], service: Order["service_type"], near: LngLat | null): Site | null {
  const ok = sites.filter((s) => s.kind === kind && s.active && s.service_types.includes(service));
  if (!near) return ok[0] ?? null;
  return ok.reduce<Site | null>((best, s) => (!best || distanceKm(near, s) < distanceKm(near, best) ? s : best), null);
}

export function tripLegs(order: Order, loc: OrderLocation | null, sites: Site[], me: LngLat | null): Leg[] {
  const cust: Leg = { kind: "cust", target: loc ? { lat: loc.lat, lng: loc.lng } : null, site: null };
  const near = loc ?? me;
  if (order.service_type === "WW") {
    const s = nearestSite(sites, "discharge", "WW", near);
    return [cust, { kind: "discharge", target: s ? { lat: s.lat, lng: s.lng } : null, site: s }];
  }
  // The fill site the server records wins once filling is confirmed.
  const s = (order.fill_site_id && sites.find((x) => x.id === order.fill_site_id)) || nearestSite(sites, "fill", order.service_type, near);
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
