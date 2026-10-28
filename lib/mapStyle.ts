// Basemap styles for every map in the platform, in one place.
// Default: OpenFreeMap vector styles (free, no key, MapLibre-native). Production can point
// NEXT_PUBLIC_MAP_STYLE_LIGHT / NEXT_PUBLIC_MAP_STYLE_DARK at MapTiler or self-hosted tiles.
import type { ExpressionSpecification, Map as MlMap } from "maplibre-gl";

export type MapTheme = "light" | "dark";

export const MAP_STYLE: Record<MapTheme, string> = {
  light: process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT || "https://tiles.openfreemap.org/styles/positron",
  dark: process.env.NEXT_PUBLIC_MAP_STYLE_DARK || "https://tiles.openfreemap.org/styles/dark",
};

/** Brand palette used by markers and overlays (app/globals.css, prototype.html). */
export const MAP_COLORS = {
  DW: "#3B82F6",
  WW: "#C08E35",
  TE: "#2FA36B",
  stale: "#8A9A9E",
  blocked: "#E5484D",
  brand: "#0A7C88", // delivery destination
  accent: "#17B3C6", // route, "you", selection
  deep: "#0B2A33",
} as const;

// Light recolouring of the OpenFreeMap layers toward the Nama palette (teal water, a touch of
// teal in the dark land). Layers that don't exist (another style via the env override) are skipped.
const TWEAKS: Record<MapTheme, [layer: string, prop: string, value: string][]> = {
  light: [
    ["water", "fill-color", "#cfe5ea"],
    ["waterway", "line-color", "#bcdbe1"],
    ["park", "fill-color", "#e3ece4"],
  ],
  dark: [
    ["background", "background-color", "#08191f"],
    ["water", "fill-color", "#0d2c35"],
    ["waterway", "line-color", "#0d2c35"],
    ["building", "fill-color", "#0b2129"],
    ["building", "fill-outline-color", "#10303a"],
    ["landuse_residential", "fill-color", "#0b2028"],
    ["landuse_park", "fill-color", "#0c2329"],
    ["highway_minor", "line-color", "#13313a"],
    ["highway_major_inner", "line-color", "#173b45"],
    ["highway_major_casing", "line-color", "rgba(70,110,118,0.55)"],
    ["highway_motorway_inner", "line-color", "#1c4651"],
    ["highway_motorway_casing", "line-color", "rgba(90,140,150,0.55)"],
  ],
};

/** English: the English name, else the local one. Arabic: the Arabic name, else the local one. */
export function labelField(lang: "en" | "ar"): ExpressionSpecification {
  return lang === "ar"
    ? ["coalesce", ["get", "name:ar"], ["get", "name"]]
    : ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"]];
}

/** Point every name label of the loaded style at one language (route numbers and shields untouched). */
export function localizeLabels(m: MlMap, lang: "en" | "ar") {
  const layers = m.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type !== "symbol" || l.id.startsWith("nama-")) continue;
    const tf = l.layout?.["text-field"];
    if (tf == null || !/"name|\{name/.test(JSON.stringify(tf))) continue;
    m.setLayoutProperty(l.id, "text-field", labelField(lang));
  }
}

/** Apply the brand tweaks for a theme to the loaded style. */
export function brandStyle(m: MlMap, theme: MapTheme) {
  for (const [layer, prop, value] of TWEAKS[theme]) {
    if (!m.getLayer(layer)) continue;
    try {
      m.setPaintProperty(layer, prop as Parameters<MlMap["setPaintProperty"]>[1], value);
    } catch {
      /* a style without that property: leave it */
    }
  }
}

/** Geofence / radius ring as a 64-point polygon (radius in metres). */
export function circlePolygon(lat: number, lng: number, radiusM: number): GeoJSON.Polygon {
  const pts: [number, number][] = [];
  const dLat = radiusM / 110_574;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Polygon", coordinates: [pts] };
}

/** Compass bearing in degrees from a to b (0 = north, clockwise). */
export function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lng - a.lng)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
