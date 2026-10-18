// Road routing for ETAs (and the demo trip simulator), behind one function.
// The demo uses the public OSRM server; point NEXT_PUBLIC_OSRM_URL at a
// self-hosted OSRM for anything beyond a demo. Any failure falls back to a
// straight-line estimate.
import { distanceKm } from "./geo";
import type { LngLat } from "./types";

export const OSRM_URL = (process.env.NEXT_PUBLIC_OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
const TIMEOUT_MS = 5_000;
const CITY_KMH = 25; // straight-line fallback speed

export type RouteEta = {
  km: number;
  minutes: number;
  source: "osrm" | "straight-line";
  /** Road geometry as [lng, lat] pairs, when requested and available. */
  path?: [number, number][];
};

export function routeEtaFallback(from: LngLat, to: LngLat): RouteEta {
  const km = distanceKm(from, to);
  return { km, minutes: Math.max(1, Math.round((km / CITY_KMH) * 60)), source: "straight-line" };
}

/** Driving distance and time from `from` to `to`. Never throws. */
export async function routeEta(from: LngLat, to: LngLat, opts: { withPath?: boolean; fetchImpl?: typeof fetch } = {}): Promise<RouteEta> {
  const f = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
    const q = opts.withPath ? "overview=full&geometries=geojson" : "overview=false";
    const res = await f(`${OSRM_URL}/route/v1/driving/${coords}?${q}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const body = await res.json();
    const route = body?.code === "Ok" ? body.routes?.[0] : null;
    if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) throw new Error(`OSRM ${body?.code ?? "no route"}`);
    return {
      km: route.distance / 1000,
      minutes: Math.max(1, Math.round(route.duration / 60)),
      source: "osrm",
      path: opts.withPath ? (route.geometry?.coordinates as [number, number][] | undefined) : undefined,
    };
  } catch {
    return routeEtaFallback(from, to);
  } finally {
    clearTimeout(timer);
  }
}
