"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { HEADING_ICON_SVG, ORDER_ICON_SVG, SITE_ICON_SVG, TANKER_ICON_SVG, svgImage } from "@/components/map/glyphs";
import { distanceKm, inOman } from "@/lib/geo";
import { MAP_COLORS, MAP_STYLE, bearing, brandStyle, circlePolygon, localizeLabels, type MapTheme } from "@/lib/mapStyle";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export type MapTanker = { id: string; lat: number; lng: number; type: "DW" | "WW" | "TE"; stale: boolean; blocked: boolean; label: string };
export type MapOrder = { id: string; lat: number; lng: number; type: "DW" | "WW" | "TE"; label: string };
/** Filling station or discharge site, drawn with its geofence radius. */
export type MapSite = { id: string; lat: number; lng: number; kind: "fill" | "discharge"; radius_m: number; label: string };
export type LatLng = { lat: number; lng: number };

const TANKER_KEYS = ["DW", "WW", "TE", "stale", "blocked"] as const;
type TankerKey = (typeof TANKER_KEYS)[number];
const GLIDE_MS = 4000; // tankers glide to each new fix instead of jumping
const HEADING_MIN_M = 8;

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const pt = (lng: number, lat: number, properties: Record<string, unknown>): GeoJSON.Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties });

/** Map icons, drawn from the shared SVG glyphs at 2× (tankers, heading arrows, delivery points, sites). */
async function loadIcons(m: maplibregl.Map) {
  const jobs: [string, string][] = [
    ...TANKER_KEYS.map((k): [string, string] => [`tkr-${k}`, TANKER_ICON_SVG(MAP_COLORS[k])]),
    ...TANKER_KEYS.map((k): [string, string] => [`hdg-${k}`, HEADING_ICON_SVG(MAP_COLORS[k])]),
    ...(["DW", "WW", "TE"] as const).map((k): [string, string] => [`ord-${k}`, ORDER_ICON_SVG(MAP_COLORS[k])]),
    ["site-fill", SITE_ICON_SVG("fill")],
    ["site-discharge", SITE_ICON_SVG("discharge")],
  ];
  await Promise.all(
    jobs.map(async ([id, svg]) => {
      const img = await svgImage(svg);
      if (!m.hasImage(id)) m.addImage(id, img, { pixelRatio: 2 });
    }),
  );
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
  theme?: MapTheme;
};

const NO_SITES: MapSite[] = [];
const NO_RINGS: LatLng[] = [];

export default function FleetMapView({ tankers, orders, sites = NO_SITES, trail = null, selectedId = null, alerts = NO_RINGS, onSelect, theme = "dark" }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const known = useRef(new Set<string>()); // ids already framed
  const userMoved = useRef(false); // the operator panned or zoomed: stop auto-framing
  const onSel = useRef(onSelect);
  const data = useRef({ tankers, orders, sites, trail, selectedId, alerts });
  const applyRef = useRef<() => void>(() => undefined);
  const framedTrail = useRef<LatLng[] | null>(null);
  // Where each tanker is drawn now, where it is heading, and which way it faces.
  const shown = useRef(new Map<string, LatLng>());
  const target = useRef(new Map<string, LatLng>());
  const heading = useRef(new Map<string, number>());
  const glide = useRef(0);
  useEffect(() => {
    onSel.current = onSelect;
    data.current = { tankers, orders, sites, trail, selectedId, alerts };
  });

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current,
      style: MAP_STYLE[theme],
      center: [58.38, 23.59],
      zoom: 10.5,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 150,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // Only user gestures (and the zoom buttons) carry an originalEvent; fitBounds doesn't.
    m.on("movestart", (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) userMoved.current = true;
    });
    m.on("load", async () => {
      brandStyle(m, theme);
      localizeLabels(m, "en");
      try {
        await loadIcons(m);
      } catch {
        /* icons failed to decode: the circle fallback below still shows every tanker */
      }
      if (!map.current) return; // unmounted while the icons loaded
      const casing = theme === "dark" ? "#04161c" : "#ffffff";
      for (const id of ["geofences", "sites", "trail", "rings", "orders", "tankers"]) m.addSource(`nama-${id}`, { type: "geojson", data: fc([]) });
      m.addLayer({ id: "nama-geofences", type: "fill", source: "nama-geofences", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.1 } });
      m.addLayer({ id: "nama-geofences-line", type: "line", source: "nama-geofences", paint: { "line-color": ["get", "color"], "line-width": 1.4, "line-opacity": 0.75, "line-dasharray": [3, 2] } });
      m.addLayer({ id: "nama-trail-casing", type: "line", source: "nama-trail", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": casing, "line-width": 7, "line-opacity": 0.9 } });
      m.addLayer({ id: "nama-trail", type: "line", source: "nama-trail", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": MAP_COLORS.accent, "line-width": 3.5 } });
      m.addLayer({
        id: "nama-sites",
        type: "symbol",
        source: "nama-sites",
        layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-ignore-placement": true },
      });
      m.addLayer({
        id: "nama-orders",
        type: "symbol",
        source: "nama-orders",
        layout: { "icon-image": ["get", "icon"], "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-ignore-placement": true },
      });
      m.addLayer({
        id: "nama-rings",
        type: "circle",
        source: "nama-rings",
        paint: { "circle-radius": 22, "circle-color": "rgba(229,72,77,0.12)", "circle-stroke-width": 2.5, "circle-stroke-color": MAP_COLORS.blocked },
      });
      m.addLayer({
        id: "nama-tankers-sel",
        type: "circle",
        source: "nama-tankers",
        filter: ["==", ["get", "sel"], true],
        paint: { "circle-radius": 25, "circle-color": "rgba(23,179,198,0.18)", "circle-stroke-width": 2.5, "circle-stroke-color": MAP_COLORS.accent },
      });
      m.addLayer({
        id: "nama-tankers-hdg",
        type: "symbol",
        source: "nama-tankers",
        filter: ["has", "hdg"],
        layout: {
          "icon-image": ["concat", "hdg-", ["get", "key"]],
          "icon-rotate": ["get", "hdg"],
          "icon-rotation-alignment": "map",
          "icon-offset": [0, -22],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      m.addLayer({
        id: "nama-tankers",
        type: "symbol",
        source: "nama-tankers",
        layout: {
          "icon-image": ["concat", "tkr-", ["get", "key"]],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": ["step", ["zoom"], "", 11.5, ["get", "plate"]],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-offset": [0, 1.75],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "icon-opacity": ["case", ["get", "stale"], 0.85, 1],
          "text-color": theme === "dark" ? "#e8f1f2" : "#0e2329",
          "text-halo-color": theme === "dark" ? "#061a21" : "#ffffff",
          "text-halo-width": 1.6,
        },
      });
      for (const layer of ["nama-orders", "nama-tankers"] as const) {
        m.on("click", layer, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) onSel.current?.(layer === "nama-orders" ? "order" : "tanker", String(id));
        });
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 18 });
      for (const layer of ["nama-orders", "nama-tankers", "nama-sites"] as const) {
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
    const shownNow = shown.current;
    const targetNow = target.current;
    const headingNow = heading.current;
    return () => {
      ready.current = false;
      cancelAnimationFrame(glide.current);
      known.current = new Set();
      userMoved.current = false;
      shownNow.clear();
      targetNow.clear();
      headingNow.clear();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Tankers as features at their drawn (gliding) positions.
    const drawTankers = () => {
      const m = map.current;
      if (!m || !ready.current) return;
      const { tankers, selectedId } = data.current;
      (m.getSource("nama-tankers") as maplibregl.GeoJSONSource).setData(
        fc(
          tankers.map((t) => {
            const p = shown.current.get(t.id) ?? t;
            const key: TankerKey = t.blocked ? "blocked" : t.stale ? "stale" : t.type;
            const hdg = heading.current.get(t.id);
            return pt(p.lng, p.lat, { id: t.id, label: t.label, plate: t.label.split(" · ")[0], stale: t.stale, key, sel: t.id === selectedId, ...(hdg != null ? { hdg } : {}) });
          }),
        ),
      );
    };

    const apply = () => {
      const m = map.current;
      if (!m || !ready.current) return;
      const { tankers, orders, sites, trail, alerts } = data.current;
      (m.getSource("nama-geofences") as maplibregl.GeoJSONSource).setData(
        fc(sites.map((s) => ({ type: "Feature", geometry: circlePolygon(s.lat, s.lng, s.radius_m), properties: { color: s.kind === "fill" ? MAP_COLORS.DW : MAP_COLORS.WW } }))),
      );
      (m.getSource("nama-sites") as maplibregl.GeoJSONSource).setData(fc(sites.map((s) => pt(s.lng, s.lat, { label: s.label, icon: `site-${s.kind}` }))));
      (m.getSource("nama-trail") as maplibregl.GeoJSONSource).setData(
        fc(trail && trail.length > 1 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: trail.map((p) => [p.lng, p.lat]) }, properties: {} }] : []),
      );
      (m.getSource("nama-rings") as maplibregl.GeoJSONSource).setData(fc(alerts.map((a) => pt(a.lng, a.lat, {}))));
      (m.getSource("nama-orders") as maplibregl.GeoJSONSource).setData(fc(orders.map((o) => pt(o.lng, o.lat, { id: o.id, label: o.label, icon: `ord-${o.type}` }))));

      // New fixes: work out the heading, then glide every tanker from where it is drawn.
      const ids = new Set(tankers.map((t) => t.id));
      for (const id of [...shown.current.keys()]) if (!ids.has(id)) shown.current.delete(id);
      for (const t of tankers) {
        const prev = target.current.get(t.id);
        if (prev && distanceKm(prev, t) * 1000 > HEADING_MIN_M) heading.current.set(t.id, bearing(prev, t));
        target.current.set(t.id, { lat: t.lat, lng: t.lng });
        if (!shown.current.has(t.id)) shown.current.set(t.id, { lat: t.lat, lng: t.lng });
      }
      for (const id of [...target.current.keys()]) if (!ids.has(id)) target.current.delete(id);
      cancelAnimationFrame(glide.current);
      const moved = [...target.current].some(([id, to]) => {
        const at = shown.current.get(id);
        return !at || at.lat !== to.lat || at.lng !== to.lng;
      });
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (moved && !reduced) {
        const from = new Map(shown.current);
        const start = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - start) / GLIDE_MS);
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out
          for (const [id, to] of target.current) {
            const a = from.get(id) ?? to;
            shown.current.set(id, { lat: a.lat + (to.lat - a.lat) * e, lng: a.lng + (to.lng - a.lng) * e });
          }
          drawTankers();
          if (k < 1) glide.current = requestAnimationFrame(step);
        };
        glide.current = requestAnimationFrame(step);
      } else {
        for (const [id, to] of target.current) shown.current.set(id, to);
        drawTankers();
      }

      // A new route history takes over the view.
      if (trail && trail.length > 1 && framedTrail.current !== trail) {
        framedTrail.current = trail;
        const b = new maplibregl.LngLatBounds([trail[0].lng, trail[0].lat], [trail[0].lng, trail[0].lat]);
        for (const p of trail) b.extend([p.lng, p.lat]);
        m.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
        userMoved.current = true;
        return;
      }
      // Frame everything whenever a new tanker or order appears (not on every GPS move),
      // until the operator takes over the view.
      const pts = [...tankers, ...orders];
      const first = known.current.size === 0;
      const added = pts.filter((p) => !known.current.has(p.id));
      for (const p of added) known.current.add(p.id);
      if (added.length && !userMoved.current) {
        // NWS serves Oman: a tanker reporting from far outside (bad GPS) is drawn but doesn't drag the view.
        const local = pts.filter(inOman);
        const frame = local.length ? local : pts;
        const b = new maplibregl.LngLatBounds([frame[0].lng, frame[0].lat], [frame[0].lng, frame[0].lat]);
        for (const p of frame) b.extend([p.lng, p.lat]);
        m.fitBounds(b, { padding: 80, maxZoom: 13, duration: first ? 0 : 600 });
      }
    };
    applyRef.current = apply;
    apply();
  }, [tankers, orders, sites, trail, selectedId, alerts]);

  return <div ref={box} className={`mapfill nm ${theme}`} />;
}
