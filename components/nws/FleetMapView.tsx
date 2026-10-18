"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export type MapTanker = { id: string; lat: number; lng: number; type: "DW" | "WW" | "TE"; stale: boolean; blocked: boolean; label: string };
export type MapOrder = { id: string; lat: number; lng: number; type: "DW" | "WW" | "TE"; label: string };

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

export default function FleetMapView({ tankers, orders, onSelect }: { tankers: MapTanker[]; orders: MapOrder[]; onSelect?: (kind: "tanker" | "order", id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const fitted = useRef(false);
  const onSel = useRef(onSelect);
  const data = useRef({ tankers, orders });
  const applyRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    onSel.current = onSelect;
    data.current = { tankers, orders };
  });

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({ container: box.current, style: STYLE, center: [58.38, 23.59], zoom: 10.5, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("orders", { type: "geojson", data: fc([]) });
      m.addSource("tankers", { type: "geojson", data: fc([]) });
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
      for (const layer of ["orders", "tankers"] as const) {
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
      fitted.current = false;
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const apply = () => {
      const m = map.current;
      if (!m || !ready.current) return;
      const { tankers, orders } = data.current;
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
      const pts = [...tankers, ...orders];
      if (!fitted.current && pts.length) {
        fitted.current = true;
        const b = new maplibregl.LngLatBounds([pts[0].lng, pts[0].lat], [pts[0].lng, pts[0].lat]);
        for (const p of pts) b.extend([p.lng, p.lat]);
        m.fitBounds(b, { padding: 80, maxZoom: 13, duration: 0 });
      }
    };
    applyRef.current = apply;
    apply();
  }, [tankers, orders]);

  return <div ref={box} className="mapfill" />;
}
