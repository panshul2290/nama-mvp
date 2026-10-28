"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export type MapTanker = { id: string; lat: number; lng: number; type: "DW" | "WW" | "TE"; stale: boolean; blocked: boolean; label: string };
export type MapOrder = { id: string; lat: number; lng: number; type: "DW" | "WW" | "TE"; label: string };
/** Filling station or discharge site, drawn with its geofence radius. */
export type MapSite = { id: string; lat: number; lng: number; kind: "fill" | "discharge"; radius_m: number; label: string };
export type LatLng = { lat: number; lng: number };

const COLORS = { DW: "#3B82F6", WW: "#C08E35", TE: "#2FA36B", stale: "#5E7479", blocked: "#E5484D" };

// OSM raster, darkened to sit with the portal's dark theme.
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#03131a" } },
    { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.85, "raster-brightness-max": 0.42, "raster-contrast": 0.15, "raster-opacity": 0.95 } },
  ],
};

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });

// Geofence as a 48-point polygon around the site.
function circle(s: MapSite): GeoJSON.Feature {
  const pts: [number, number][] = [];
  const dLat = s.radius_m / 111_320;
  const dLng = dLat / Math.cos((s.lat * Math.PI) / 180);
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([s.lng + dLng * Math.cos(a), s.lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: { color: s.kind === "fill" ? COLORS.DW : COLORS.WW } };
}

type Props = {
  tankers: MapTanker[];
  orders: MapOrder[];
  sites?: MapSite[];
  /** Route history polyline (oldest first); the map frames it when it changes. */
  trail?: LatLng[] | null;
  /** Ring around one tanker (the selected one). */
  selectedId?: string | null;
  /** Red rings for open alerts. */
  alerts?: LatLng[];
  onSelect?: (kind: "tanker" | "order", id: string) => void;
};

const NO_SITES: MapSite[] = [];
const NO_RINGS: LatLng[] = [];

export default function FleetMapView({ tankers, orders, sites = NO_SITES, trail = null, selectedId = null, alerts = NO_RINGS, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const known = useRef(new Set<string>()); // ids already framed
  const userMoved = useRef(false); // the operator panned or zoomed: stop auto-framing
  const onSel = useRef(onSelect);
  const data = useRef({ tankers, orders, sites, trail, selectedId, alerts });
  const applyRef = useRef<() => void>(() => undefined);
  const framedTrail = useRef<LatLng[] | null>(null);
  useEffect(() => {
    onSel.current = onSelect;
    data.current = { tankers, orders, sites, trail, selectedId, alerts };
  });

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({ container: box.current, style: STYLE, center: [58.38, 23.59], zoom: 10.5, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // Only user gestures (and the zoom buttons) carry an originalEvent; fitBounds doesn't.
    m.on("movestart", (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) userMoved.current = true;
    });
    m.on("load", () => {
      m.addSource("geofences", { type: "geojson", data: fc([]) });
      m.addSource("sites", { type: "geojson", data: fc([]) });
      m.addSource("trail", { type: "geojson", data: fc([]) });
      m.addSource("rings", { type: "geojson", data: fc([]) });
      m.addSource("orders", { type: "geojson", data: fc([]) });
      m.addSource("tankers", { type: "geojson", data: fc([]) });
      m.addLayer({ id: "geofences", type: "fill", source: "geofences", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.12 } });
      m.addLayer({ id: "geofences-line", type: "line", source: "geofences", paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [2, 2] } });
      m.addLayer({
        id: "sites",
        type: "circle",
        source: "sites",
        paint: { "circle-radius": 5, "circle-color": ["get", "color"], "circle-stroke-width": 1.5, "circle-stroke-color": "#03131a" },
      });
      m.addLayer({ id: "trail", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#17b3c6", "line-width": 3.5, "line-opacity": 0.9 } });
      m.addLayer({
        id: "rings",
        type: "circle",
        source: "rings",
        paint: { "circle-radius": ["get", "r"], "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2.5, "circle-stroke-color": ["get", "color"] },
      });
      m.addLayer({
        id: "orders",
        type: "circle",
        source: "orders",
        paint: { "circle-radius": 6, "circle-color": "#061a21", "circle-stroke-width": 2.5, "circle-stroke-color": ["get", "color"] },
      });
      m.addLayer({
        id: "tankers",
        type: "circle",
        source: "tankers",
        paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-width": 2, "circle-stroke-color": "#E8F1F2", "circle-opacity": ["case", ["get", "stale"], 0.75, 1] },
      });
      for (const layer of ["orders", "tankers"] as const) {
        m.on("click", layer, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) onSel.current?.(layer === "orders" ? "order" : "tanker", String(id));
        });
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
      for (const layer of ["orders", "tankers", "sites"] as const) {
        m.on("mousemove", layer, (e) => {
          const f = e.features?.[0];
          if (f) popup.setLngLat(e.lngLat).setText(String(f.properties?.label ?? "")).addTo(m);
        });
        m.on("mouseleave", layer, () => popup.remove());
      }
      ready.current = true;
      applyRef.current();
    });
    map.current = m;
    return () => {
      ready.current = false;
      known.current = new Set();
      userMoved.current = false;
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const apply = () => {
      const m = map.current;
      if (!m || !ready.current) return;
      const { tankers, orders, sites, trail, selectedId, alerts } = data.current;
      (m.getSource("geofences") as maplibregl.GeoJSONSource).setData(fc(sites.map(circle)));
      (m.getSource("sites") as maplibregl.GeoJSONSource).setData(
        fc(sites.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] }, properties: { label: s.label, color: s.kind === "fill" ? COLORS.DW : COLORS.WW } }))),
      );
      (m.getSource("trail") as maplibregl.GeoJSONSource).setData(
        fc(trail && trail.length > 1 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: trail.map((p) => [p.lng, p.lat]) }, properties: {} }] : []),
      );
      const sel = tankers.find((t) => t.id === selectedId);
      (m.getSource("rings") as maplibregl.GeoJSONSource).setData(
        fc([
          ...alerts.map((a): GeoJSON.Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [a.lng, a.lat] }, properties: { r: 13, color: COLORS.blocked } })),
          ...(sel ? [{ type: "Feature", geometry: { type: "Point", coordinates: [sel.lng, sel.lat] }, properties: { r: 15, color: "#17b3c6" } } as GeoJSON.Feature] : []),
        ]),
      );
      // A new route history takes over the view.
      if (trail && trail.length > 1 && framedTrail.current !== trail) {
        framedTrail.current = trail;
        const b = new maplibregl.LngLatBounds([trail[0].lng, trail[0].lat], [trail[0].lng, trail[0].lat]);
        for (const p of trail) b.extend([p.lng, p.lat]);
        m.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
        userMoved.current = true;
        return;
      }
      (m.getSource("tankers") as maplibregl.GeoJSONSource).setData(
        fc(
          tankers.map((t) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [t.lng, t.lat] },
            properties: { id: t.id, label: t.label, stale: t.stale, color: t.blocked ? COLORS.blocked : t.stale ? COLORS.stale : COLORS[t.type] },
          })),
        ),
      );
      (m.getSource("orders") as maplibregl.GeoJSONSource).setData(
        fc(orders.map((o) => ({ type: "Feature", geometry: { type: "Point", coordinates: [o.lng, o.lat] }, properties: { id: o.id, label: o.label, color: COLORS[o.type] } }))),
      );
      // Frame everything whenever a new tanker or order appears (not on every GPS move),
      // until the operator takes over the view.
      const pts = [...tankers, ...orders];
      const first = known.current.size === 0;
      const added = pts.filter((p) => !known.current.has(p.id));
      for (const p of added) known.current.add(p.id);
      if (added.length && !userMoved.current) {
        const b = new maplibregl.LngLatBounds([pts[0].lng, pts[0].lat], [pts[0].lng, pts[0].lat]);
        for (const p of pts) b.extend([p.lng, p.lat]);
        m.fitBounds(b, { padding: 80, maxZoom: 13, duration: first ? 0 : 600 });
      }
    };
    applyRef.current = apply;
    apply();
  }, [tankers, orders, sites, trail, selectedId, alerts]);

  return <div ref={box} className="mapfill" />;
}
