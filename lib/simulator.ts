// Demo trip simulator: plays back a road route in Muscat as if a phone were
// driving it. Positions are fed into the same fix handler and send cadence as
// real GPS, so the customer view behaves exactly as with a real driver.
// Trips are driven leg by leg (filling station → customer, or customer →
// discharge site), so each leg ends inside the site's geofence and the station
// and discharge checks pass exactly as they would for a real tanker.
// Only offered when NEXT_PUBLIC_DEMO_MODE=true.
import { distanceKm } from "./geo";
import { routeEta } from "./routing";
import type { LngLat } from "./types";

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const AVG_SPEED_MS = 10; // ≈ 36 km/h, city traffic
/** A leg starts from the tanker's current position when it is this close; otherwise from a nearby point. */
const MAX_START_KM = 40;

export type SimRoute = { points: LngLat[]; cum: number[]; totalM: number; source: "osrm" | "straight-line" };

/**
 * Road route to `dest` (OSRM, or a straight line), starting from `from` — the
 * tanker's current position — or, when that is unknown or far away, from a
 * point ~3 km north-west of the destination.
 */
export async function buildDemoRoute(dest: LngLat, from?: LngLat | null): Promise<SimRoute> {
  const start = from && distanceKm(from, dest) <= MAX_START_KM ? from : { lat: dest.lat + 0.02, lng: dest.lng - 0.02 };
  const r = await routeEta(start, dest, { withPath: true });
  const raw = r.source === "osrm" && r.path && r.path.length > 1 ? r.path.map(([lng, lat]) => ({ lat, lng })) : straight(start, dest, 40);
  const points = [...raw, dest]; // end exactly at the target (customer pin or site centre)
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceKm(points[i - 1], points[i]) * 1000);
  return { points, cum, totalM: cum[cum.length - 1], source: r.path ? "osrm" : "straight-line" };
}

function straight(a: LngLat, b: LngLat, n: number): LngLat[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n }));
}

/** Metres travelled after `elapsedS` seconds, with gentle speed variation (traffic). */
export function travelled(elapsedS: number): number {
  return AVG_SPEED_MS * elapsedS + 25 * Math.sin(elapsedS / 9) - 25 * Math.sin(0);
}

/** Position `m` metres along the route. */
export function positionAt(route: SimRoute, m: number): LngLat {
  if (m <= 0) return route.points[0];
  if (m >= route.totalM) return route.points[route.points.length - 1];
  let i = 1;
  while (route.cum[i] < m) i++;
  const seg = route.cum[i] - route.cum[i - 1] || 1;
  const f = (m - route.cum[i - 1]) / seg;
  const a = route.points[i - 1];
  const b = route.points[i];
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}
