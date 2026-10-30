// Where a proof of delivery was recorded, compared with the delivery point (0024). The distance
// is computed by submit_pod from the order's pin; the same threshold flags it on every screen.
import type { Pod } from "./types";

/** Further than this from the delivery point and the proof is flagged for a look. */
export const POD_FAR_M = 300;

export type PodCheck = {
  /** Distance of the submit fix from the delivery point, metres (null when unknown). */
  distance: number | null;
  /** Distance of the photo's fix from the delivery point, metres. */
  photoDistance: number | null;
  /** Either fix is further than POD_FAR_M from the delivery point. */
  far: boolean;
  /** "device": the phone's own fix; "tanker": the tanker's last reported fix (no device fix). */
  source: Pod["location_source"];
};

export function podCheck(pod: Pick<Pod, "distance_m" | "photo_distance_m" | "location_source">): PodCheck {
  const distance = pod.distance_m ?? null;
  const photoDistance = pod.photo_distance_m ?? null;
  return { distance, photoDistance, far: (distance ?? 0) > POD_FAR_M || (photoDistance ?? 0) > POD_FAR_M, source: pod.location_source ?? null };
}

/** "45 m" / "1.2 km". */
export const metres = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);

/** "23.62110, 58.20745" (5 decimals ≈ 1 m). */
export const coords = (lat: number, lng: number) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

/** An OpenStreetMap link with a marker at the point. */
export const mapLink = (lat: number, lng: number) => `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=17/${lat.toFixed(6)}/${lng.toFixed(6)}`;
