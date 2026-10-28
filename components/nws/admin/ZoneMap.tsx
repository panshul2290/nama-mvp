"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Site, Zone } from "@/lib/types";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

// Service areas and approved fill/discharge geofences, drawn as circles.
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
    { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.85, "raster-brightness-max": 0.42, "raster-contrast": 0.15 } },
  ],
};

function circle(lat: number, lng: number, km: number): GeoJSON.Polygon {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lng + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 110.574) * Math.sin(a)]);
  }
  return { type: "Polygon", coordinates: [pts] };
}

const siteColor = (s: Site) => (!s.active ? "#5E7479" : s.kind === "discharge" ? "#C08E35" : s.service_types.includes("TE") ? "#2FA36B" : "#3B82F6");

function data(zones: Zone[], sites: Site[]) {
  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
  return {
    zones: fc(zones.map((z) => ({ type: "Feature", geometry: circle(z.center_lat, z.center_lng, Number(z.radius_km)), properties: { name: z.name, active: z.active, info: `${z.governorate} · radius ${Number(z.radius_km)} km${z.active ? "" : " · disabled"}` } }))),
    // Geofences are a few hundred metres: draw them at least 600 m so they show at city zoom.
    sites: fc(sites.map((s) => ({ type: "Feature", geometry: circle(s.lat, s.lng, Math.max(0.6, s.radius_m / 1000)), properties: { name: `${s.code} · ${s.name}`, color: siteColor(s), info: `${s.kind === "fill" ? "Filling" : "Discharge"} · ${s.service_types.join(", ")} · ${s.radius_m} m${s.active ? "" : " · disabled"}` } }))),
  };
}

export default function ZoneMap({ zones, sites }: { zones: Zone[]; sites: Site[] }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const latest = useRef({ zones, sites });

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({ container: box.current, style: STYLE, center: [58.4, 23.6], zoom: 9, attributionControl: { compact: true } });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      const d = data(latest.current.zones, latest.current.sites);
      m.addSource("zones", { type: "geojson", data: d.zones });
      m.addSource("sites", { type: "geojson", data: d.sites });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": ["case", ["get", "active"], "#17b3c6", "#e5484d"], "fill-opacity": 0.12 } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": ["case", ["get", "active"], "#17b3c6", "#e5484d"], "line-width": 1.5, "line-dasharray": [3, 2] } });
      m.addLayer({ id: "sites-fill", type: "fill", source: "sites", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.55 } });
      m.addLayer({ id: "sites-line", type: "line", source: "sites", paint: { "line-color": ["get", "color"], "line-width": 1.5 } });
      for (const layer of ["sites-fill", "zones-fill"]) {
        m.on("click", layer, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${f.properties.name}</b><br><small>${f.properties.info}</small>`).addTo(m);
        });
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      ready.current = true;
    });
    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = { zones, sites };
    const m = map.current;
    if (!m || !ready.current) return;
    const d = data(zones, sites);
    (m.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(d.zones);
    (m.getSource("sites") as maplibregl.GeoJSONSource | undefined)?.setData(d.sites);
  }, [zones, sites]);

  return <div ref={box} className="mapfill" />;
}
