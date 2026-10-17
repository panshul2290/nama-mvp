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

export function currentPosition(timeoutMs = 8000): Promise<LngLat | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
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
