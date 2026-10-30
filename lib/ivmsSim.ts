// Routes for the built-in IVMS simulator (C1): a road route from OSRM when it answers,
// else a straight line in ~200 m steps. The database (ivms_sim_tick, 0028) moves the
// tanker along it and reports IVMS fixes; the route is driven there and back.
import { distanceKm } from "./geo";
import { routeEta } from "./routing";
import type { LngLat } from "./types";

export type SimRoute = [number, number][]; // [lat, lng]

function straight(from: LngLat, to: LngLat): SimRoute {
  const steps = Math.max(2, Math.ceil(distanceKm(from, to) / 0.2));
  return Array.from({ length: steps + 1 }, (_, i) => [from.lat + ((to.lat - from.lat) * i) / steps, from.lng + ((to.lng - from.lng) * i) / steps] as [number, number]);
}

export async function simRoute(from: LngLat, to: LngLat): Promise<SimRoute> {
  const r = await routeEta(from, to, { withPath: true });
  const out: SimRoute = r.path && r.path.length > 1 ? r.path.map(([lng, lat]) => [lat, lng]) : straight(from, to);
  // Thin very long geometries (the database accepts up to 5,000 points).
  const step = Math.ceil(out.length / 2000);
  const thin = step > 1 ? out.filter((_, i) => i % step === 0 || i === out.length - 1) : out;
  return [...thin, ...thin.slice(0, -1).reverse()];
}

/** A point about `km` away in a random direction (a destination when the tanker has no job). */
export function nearby(from: LngLat, km = 3): LngLat {
  const a = Math.random() * 2 * Math.PI;
  return { lat: from.lat + (km / 111) * Math.cos(a), lng: from.lng + (km / (111 * Math.cos((from.lat * Math.PI) / 180))) * Math.sin(a) };
}
