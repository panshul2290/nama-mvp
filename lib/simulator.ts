// Demo trip simulator: plays back a road route in Muscat as if a phone were
// driving it. Positions are fed into the same fix handler and send cadence as
// real GPS, so the customer view behaves exactly as with a real driver.
// Only offered when NEXT_PUBLIC_DEMO_MODE=true.
import { distanceKm } from "./geo";
import { routeEta } from "./routing";
import type { LngLat } from "./types";

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const AVG_SPEED_MS = 10; // ≈ 36 km/h, city traffic

export type SimRoute = { points: LngLat[]; cum: number[]; totalM: number; source: "osrm" | "straight-line" };

/** Road route from a start point ~3 km north-west of the destination (OSRM), or a straight line. */
export async function buildDemoRoute(dest: LngLat): Promise<SimRoute> {
  const start = { lat: dest.lat + 0.02, lng: dest.lng - 0.02 };
  const r = await routeEta(start, dest, { withPath: true });
  const raw = r.source === "osrm" && r.path && r.path.length > 1 ? r.path.map(([lng, lat]) => ({ lat, lng })) : straight(start, dest, 40);
  const points = [...raw, dest]; // end exactly at the customer's pin
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
