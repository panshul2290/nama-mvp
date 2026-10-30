"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { SITE_ICON_SVG, svgImage } from "@/components/map/glyphs";
import { localDigits, useLang, type Lang } from "@/lib/i18n";
import { MAP_COLORS, MAP_STYLE, brandStyle, circlePolygon, localizeLabels } from "@/lib/mapStyle";
import type { Site, Zone } from "@/lib/types";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

// Service areas and approved fill/discharge geofences, drawn as circles.
const siteColor = (s: Site) => (!s.active ? MAP_COLORS.stale : s.kind === "discharge" ? MAP_COLORS.WW : s.service_types.includes("TE") ? MAP_COLORS.TE : MAP_COLORS.DW);
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });

// A zone with a bounding box (the test zone, 0020) is drawn as that box.
const zoneShape = (z: Zone): GeoJSON.Polygon =>
  z.min_lat != null && z.max_lat != null && z.min_lng != null && z.max_lng != null
    ? { type: "Polygon", coordinates: [[[z.min_lng, z.min_lat], [z.max_lng, z.min_lat], [z.max_lng, z.max_lat], [z.min_lng, z.max_lat], [z.min_lng, z.min_lat]]] }
    : circlePolygon(z.center_lat, z.center_lng, Number(z.radius_km) * 1000);
// Popup wording in the portal language.
const W = {
  en: { test: "TEST zone · box", radius: "radius {n} km", disabled: " · disabled", fill: "Filling", discharge: "Discharge", m: "m" },
  ar: { test: "منطقة اختبار · مربع", radius: "نصف القطر {n} كم", disabled: " · معطّلة", fill: "تعبئة", discharge: "تفريغ", m: "م" },
};
const zoneInfo = (z: Zone, l: Lang) => `${z.is_test ? W[l].test : `${z.governorate} · ${W[l].radius.replace("{n}", localDigits(Number(z.radius_km), l))}`}${z.active ? "" : W[l].disabled}`;
const siteInfo = (s: Site, l: Lang) => `${s.kind === "fill" ? W[l].fill : W[l].discharge} · ${s.service_types.join(", ")} · ${localDigits(s.radius_m, l)} ${W[l].m}${s.active ? "" : W[l].disabled}`;

function data(zones: Zone[], sites: Site[], l: Lang) {
  return {
    zones: fc(zones.map((z) => ({ type: "Feature", geometry: zoneShape(z), properties: { name: z.name, active: z.active, info: zoneInfo(z, l) } }))),
    // Geofences are a few hundred metres: draw them at least 600 m so they show at city zoom.
    sites: fc(sites.map((s) => ({ type: "Feature", geometry: circlePolygon(s.lat, s.lng, Math.max(600, s.radius_m)), properties: { name: `${s.code} · ${s.name}`, color: siteColor(s), info: siteInfo(s, l) } }))),
    points: fc(sites.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] }, properties: { name: `${s.code} · ${s.name}`, icon: `site-${s.kind}`, active: s.active, info: siteInfo(s, l) } }))),
  };
}

export default function ZoneMap({ zones, sites }: { zones: Zone[]; sites: Site[] }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const { lang } = useLang();
  const latest = useRef({ zones, sites, lang });

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({ container: box.current, style: MAP_STYLE.dark, center: [58.4, 23.6], zoom: 9, attributionControl: false, dragRotate: false, pitchWithRotate: false });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    m.on("load", async () => {
      brandStyle(m, "dark");
      localizeLabels(m, latest.current.lang);
      await Promise.all(
        (["fill", "discharge"] as const).map(async (k) => {
          const img = await svgImage(SITE_ICON_SVG(k)).catch(() => null);
          if (img && !m.hasImage(`site-${k}`)) m.addImage(`site-${k}`, img, { pixelRatio: 2 });
        }),
      );
      if (!map.current) return;
      const d = data(latest.current.zones, latest.current.sites, latest.current.lang);
      m.addSource("zones", { type: "geojson", data: d.zones });
      m.addSource("sites", { type: "geojson", data: d.sites });
      m.addSource("points", { type: "geojson", data: d.points });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": ["case", ["get", "active"], MAP_COLORS.accent, MAP_COLORS.blocked], "fill-opacity": 0.08 } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": ["case", ["get", "active"], MAP_COLORS.accent, MAP_COLORS.blocked], "line-width": 1.6, "line-opacity": 0.8, "line-dasharray": [3, 2] } });
      m.addLayer({ id: "sites-fill", type: "fill", source: "sites", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.22 } });
      m.addLayer({ id: "sites-line", type: "line", source: "sites", paint: { "line-color": ["get", "color"], "line-width": 1.4 } });
      m.addLayer({
        id: "sites-icon",
        type: "symbol",
        source: "points",
        minzoom: 9.5,
        layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-ignore-placement": true },
        paint: { "icon-opacity": ["case", ["get", "active"], 1, 0.5] },
      });
      for (const layer of ["sites-icon", "sites-fill", "zones-fill"]) {
        m.on("click", layer, (e) => {
          const f = e.features?.[0];
          if (!f || e.defaultPrevented) return;
          e.preventDefault(); // one popup per click, topmost layer first
          // Zone and site names come from the database: build DOM nodes rather than HTML.
          const box = document.createElement("div");
          box.appendChild(document.createElement("b")).textContent = String(f.properties.name ?? "");
          box.appendChild(document.createElement("br"));
          box.appendChild(document.createElement("small")).textContent = String(f.properties.info ?? "");
          new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setDOMContent(box).addTo(m);
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
    latest.current = { zones, sites, lang };
    const m = map.current;
    if (!m || !ready.current) return;
    localizeLabels(m, lang);
    const d = data(zones, sites, lang);
    (m.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(d.zones);
    (m.getSource("sites") as maplibregl.GeoJSONSource | undefined)?.setData(d.sites);
    (m.getSource("points") as maplibregl.GeoJSONSource | undefined)?.setData(d.points);
  }, [zones, sites, lang]);

  return <div ref={box} className="mapfill nm dark" />;
}
