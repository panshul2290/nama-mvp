"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { MAP_COLORS, MAP_STYLE, bearing, brandStyle, circlePolygon, localizeLabels, type MapTheme } from "@/lib/mapStyle";
import { distanceKm } from "@/lib/geo";
import { useLang } from "@/lib/i18n";
import type { LngLat } from "@/lib/types";
import { PIN_SVG, SITE_SVG, TRUCK_SVG } from "./map/glyphs";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

function el(className: string, html = "") {
  const d = document.createElement("div");
  d.className = className;
  d.innerHTML = html;
  return d;
}

const toArr = (p: LngLat): [number, number] => [p.lng, p.lat];
const ANIM_MS = 9000; // just under the 10 s ping interval, so motion looks continuous
const HEADING_MIN_M = 8; // ignore GPS jitter when working out which way the tanker is going
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const TEXT = {
  recentre: { en: "Re-centre the map", ar: "إعادة توسيط الخريطة" },
  locate: { en: "Use my location", ar: "استخدم موقعي" },
};

type Props = {
  center: LngLat;
  /** Editable delivery point: draggable pin, click the map to move it. */
  pick?: { value: LngLat; onChange: (p: LngLat) => void };
  destination?: LngLat | null;
  /** What the destination is: the customer's place (default), or a filling / discharge site. */
  destKind?: "home" | "fill" | "discharge";
  /** Geofence radius around the destination, in metres (filling station / discharge site). */
  geofenceM?: number | null;
  tanker?: LngLat | null;
  /** Colours the tanker marker by service. */
  service?: "DW" | "WW" | "TE";
  /** Small label under the tanker marker, e.g. "Last updated 12 s ago". */
  tankerNote?: string;
  /** Grey the tanker marker out (location delayed). */
  tankerStale?: boolean;
  me?: LngLat | null;
  /** Road geometry ([lng, lat] pairs) from the moving point to the destination; straight line without it. */
  route?: [number, number][] | null;
  /** Keep destination + tanker/me in view as they change. */
  follow?: boolean;
  hint?: string;
  onLocate?: () => void;
  /** Extra bottom padding when framing, e.g. for a sheet overlapping the map. */
  padBottom?: number;
  theme?: MapTheme;
};

export default function MapView({ center, pick, destination, destKind = "home", geofenceM, tanker, service = "DW", tankerNote, tankerStale, me, route, follow, hint, onLocate, padBottom = 0, theme = "light" }: Props) {
  const { lang } = useLang();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const pickMarker = useRef<maplibregl.Marker | null>(null);
  const destMarker = useRef<maplibregl.Marker | null>(null);
  const tankerMarker = useRef<maplibregl.Marker | null>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const anim = useRef<number>(0);
  const lastTanker = useRef<LngLat | null>(null);
  const lastMe = useRef<LngLat | null>(null);
  const userMoved = useRef(false);
  const [paused, setPaused] = useState(false); // the user panned: stop following until "re-centre"
  const [nonce, setNonce] = useState(0); // re-run framing on re-centre
  const onPick = useRef(pick?.onChange);
  const overlays = useRef<() => void>(() => undefined);
  const langRef = useRef(lang);
  useEffect(() => {
    onPick.current = pick?.onChange;
    langRef.current = lang;
  });

  // Create the map once.
  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current,
      style: MAP_STYLE[theme],
      center: toArr(center),
      zoom: 14,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 150,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    m.on("click", (e) => onPick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    // Only a gesture pauses following (fitBounds / easeTo don't fire dragstart).
    m.on("dragstart", () => {
      userMoved.current = true;
      setPaused(true);
    });
    m.on("load", () => {
      brandStyle(m, theme);
      localizeLabels(m, langRef.current);
      m.addSource("nama-geofence", { type: "geojson", data: fc([]) });
      m.addSource("nama-route", { type: "geojson", data: fc([]) });
      m.addLayer({ id: "nama-geofence-fill", type: "fill", source: "nama-geofence", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.1 } });
      m.addLayer({ id: "nama-geofence-line", type: "line", source: "nama-geofence", paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-opacity": 0.7, "line-dasharray": [3, 2] } });
      m.addLayer({
        id: "nama-route-casing",
        type: "line",
        source: "nama-route",
        filter: ["get", "road"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": theme === "dark" ? MAP_COLORS.deep : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 11], "line-opacity": 0.95 },
      });
      m.addLayer({
        id: "nama-route",
        type: "line",
        source: "nama-route",
        filter: ["get", "road"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": MAP_COLORS.brand, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6] },
      });
      m.addLayer({
        id: "nama-route-straight",
        type: "line",
        source: "nama-route",
        filter: ["!", ["get", "road"]],
        layout: { "line-cap": "round" },
        paint: { "line-color": MAP_COLORS.brand, "line-width": 3, "line-opacity": 0.75, "line-dasharray": [0.6, 1.8] },
      });
      ready.current = true;
      overlays.current();
    });
    map.current = m;
    return () => {
      cancelAnimationFrame(anim.current);
      ready.current = false;
      // Drop markers with the map so they're rebuilt on the next one
      // (React Strict Mode mounts effects twice in development).
      for (const ref of [pickMarker, destMarker, tankerMarker, meMarker]) {
        ref.current?.remove();
        ref.current = null;
      }
      lastTanker.current = null;
      lastMe.current = null;
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Street names follow the app language.
  useEffect(() => {
    const m = map.current;
    if (m && ready.current) localizeLabels(m, lang);
  }, [lang]);

  // Editable pin.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!pick) {
      pickMarker.current?.remove();
      pickMarker.current = null;
      return;
    }
    if (!pickMarker.current) {
      const node = el("nm-pin pick", `${PIN_SVG()}<i class="nm-shadow"></i>`);
      const mk = new maplibregl.Marker({ element: node, anchor: "bottom", draggable: true }).setLngLat(toArr(pick.value)).addTo(m);
      mk.on("dragstart", () => node.classList.add("lift"));
      mk.on("dragend", () => {
        node.classList.remove("lift");
        const p = mk.getLngLat();
        onPick.current?.({ lat: p.lat, lng: p.lng });
      });
      pickMarker.current = mk;
    } else {
      pickMarker.current.setLngLat(toArr(pick.value));
    }
  }, [pick]);

  // Recentre when the caller moves the starting point (e.g. GPS fix arrives).
  useEffect(() => {
    map.current?.easeTo({ center: toArr(center), duration: 600 });
  }, [center.lat, center.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fixed destination: the customer's place, or a filling / discharge site badge.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    destMarker.current?.remove();
    destMarker.current = null;
    if (!destination) return;
    const node = destKind === "home" ? el("nm-pin", PIN_SVG()) : el(`nm-site ${destKind}`, SITE_SVG(destKind, 34));
    destMarker.current = new maplibregl.Marker({ element: node, anchor: destKind === "home" ? "bottom" : "center" }).setLngLat(toArr(destination)).addTo(m);
  }, [destination?.lat, destination?.lng, destKind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tanker: glide from where it is now to the new fix, nose pointing the way it moved.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!tanker) {
      tankerMarker.current?.remove();
      tankerMarker.current = null;
      lastTanker.current = null;
      return;
    }
    const prev = lastTanker.current;
    lastTanker.current = tanker;
    if (!tankerMarker.current) {
      const wrap = el("nm-tkr", `<i class="nm-halo"></i><i class="nm-nose"></i><div class="nm-disc">${TRUCK_SVG("currentColor")}</div><div class="nm-label"></div>`);
      wrap.style.setProperty("--c", tankerStale ? MAP_COLORS.stale : MAP_COLORS[service]);
      tankerMarker.current = new maplibregl.Marker({ element: wrap }).setLngLat(toArr(tanker)).addTo(m);
      return;
    }
    const mk = tankerMarker.current;
    if (prev && distanceKm(prev, tanker) * 1000 > HEADING_MIN_M) {
      const node = mk.getElement();
      node.style.setProperty("--hdg", `${bearing(prev, tanker)}deg`);
      node.classList.add("has-hdg");
    }
    const from = mk.getLngLat();
    const start = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    cancelAnimationFrame(anim.current);
    const step = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / ANIM_MS);
      mk.setLngLat([from.lng + (tanker.lng - from.lng) * t, from.lat + (tanker.lat - from.lat) * t]);
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [tanker?.lat, tanker?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tanker colour, label and delayed state.
  useEffect(() => {
    const node = tankerMarker.current?.getElement();
    if (!node) return;
    node.classList.toggle("stale", Boolean(tankerStale));
    node.style.setProperty("--c", tankerStale ? MAP_COLORS.stale : MAP_COLORS[service]);
    const label = node.querySelector(".nm-label");
    if (label) label.textContent = tankerNote ?? "";
  });

  // Driver's own position, with a heading cone once it moves.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!me) {
      meMarker.current?.remove();
      meMarker.current = null;
      lastMe.current = null;
      return;
    }
    const prev = lastMe.current;
    lastMe.current = me;
    meMarker.current ??= new maplibregl.Marker({ element: el("nm-me", '<i class="nm-cone"></i><i class="nm-dot"></i>') }).setLngLat(toArr(me)).addTo(m);
    meMarker.current.setLngLat(toArr(me));
    if (prev && distanceKm(prev, me) * 1000 > HEADING_MIN_M) {
      const node = meMarker.current.getElement();
      node.style.setProperty("--hdg", `${bearing(prev, me)}deg`);
      node.classList.add("has-hdg");
    }
  }, [me?.lat, me?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Route line and geofence ring (map layers, drawn once the style is in).
  const moving = tanker ?? me ?? null;
  useEffect(() => {
    overlays.current = () => {
      const m = map.current;
      if (!m || !ready.current) return;
      const fence: GeoJSON.Feature[] =
        destination && destKind !== "home" && geofenceM
          ? [{ type: "Feature", geometry: circlePolygon(destination.lat, destination.lng, geofenceM), properties: { color: destKind === "fill" ? MAP_COLORS.DW : MAP_COLORS.WW } }]
          : [];
      (m.getSource("nama-geofence") as maplibregl.GeoJSONSource | undefined)?.setData(fc(fence));
      let line: GeoJSON.Feature[] = [];
      if (destination && moving && distanceKm(moving, destination) * 1000 > 40) {
        const road = Boolean(route && route.length > 1);
        // The road starts where the router snapped the moving point; join it to the marker.
        const coords = road ? [toArr(moving), ...(route as [number, number][])] : [toArr(moving), toArr(destination)];
        line = [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { road } }];
      }
      (m.getSource("nama-route") as maplibregl.GeoJSONSource | undefined)?.setData(fc(line));
    };
    overlays.current();
  }, [destination?.lat, destination?.lng, destKind, geofenceM, moving?.lat, moving?.lng, route]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame destination and the moving point together (and the road between them).
  useEffect(() => {
    const m = map.current;
    if (!m || !follow || !destination || userMoved.current) return;
    if (!moving) {
      m.easeTo({ center: toArr(destination), zoom: 14.5, duration: 600 });
      return;
    }
    const b = new maplibregl.LngLatBounds(toArr(destination), toArr(destination)).extend(toArr(moving));
    if (route) for (const p of route) b.extend(p);
    if (geofenceM && destKind !== "home") {
      const d = geofenceM / 111_000;
      b.extend([destination.lng - d, destination.lat - d]).extend([destination.lng + d, destination.lat + d]);
    }
    m.fitBounds(b, { padding: { top: 96, left: 60, right: 60, bottom: 56 + padBottom }, maxZoom: 16, duration: 800 });
  }, [follow, padBottom, destination?.lat, destination?.lng, moving?.lat, moving?.lng, route, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  function recentre() {
    userMoved.current = false;
    setPaused(false);
    setNonce((n) => n + 1);
  }

  return (
    <div className={`mapfill nm ${theme}`}>
      <div ref={box} className="ml" />
      {hint && <div className="hint">{hint}</div>}
      {follow && paused && destination && (
        <button type="button" className="nm-recentre" onClick={recentre} aria-label={TEXT.recentre[lang]} title={TEXT.recentre[lang]}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="currentColor" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      )}
      {onLocate && (
        <button type="button" className="locate" onClick={onLocate}>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M21 3 3 10.5l7.5 2.9L13.5 21z" fill="currentColor" />
          </svg>
          {TEXT.locate[lang]}
        </button>
      )}
    </div>
  );
}
