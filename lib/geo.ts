import type { LngLat } from "./types";

// Muscat, used when the browser has no GPS fix.
export const DEFAULT_CENTER: LngLat = { lat: 23.588, lng: 58.3829 };

export function distanceKm(a: LngLat, b: LngLat): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Rough bounding box of Oman (incl. Musandam and Dhofar). NWS serves only Oman.
export const inOman = (p: LngLat) => p.lat >= 16.5 && p.lat <= 26.6 && p.lng >= 51.8 && p.lng <= 60.0;

// The device's position for pre-filling a delivery pin; null when unavailable or
// outside the service area: Oman, or an active test zone such as "Test – India"
// (lib/testArea.ts). The pin then stays in Muscat for the customer to drag.
export function currentPosition(timeoutMs = 8000): Promise<LngLat | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const here = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (inOman(here)) return resolve(here);
        import("./testArea")
          .then(async ({ testAreas, inTestArea }) => resolve(inTestArea(here, await testAreas()) ? here : null))
          .catch(() => resolve(null));
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    ),
  );
}

// Best-effort neighbourhood name from OpenStreetMap Nominatim (light use only).
export async function reverseGeocodeArea(p: LngLat, signal?: AbortSignal): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${p.lat}&lon=${p.lng}`;
    const res = await fetch(url, { signal, headers: { "Accept-Language": "en" } });
    if (!res.ok) return null;
    const a = (await res.json()).address ?? {};
    return a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district ?? a.village ?? a.town ?? a.city ?? null;
  } catch {
    return null;
  }
}
