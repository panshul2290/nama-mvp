"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { LngLat } from "@/lib/types";

maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const OSM_STYLE: maplibregl.StyleSpecification = {
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
  // Muted to sit closer to the prototype's pale schematic map.
  layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.45, "raster-contrast": -0.08, "raster-brightness-min": 0.06 } }],
};

const PIN_SVG = `<svg viewBox="0 0 30 40" width="30" height="40" aria-hidden="true"><path d="M15 39s13-13.2 13-23.5C28 7.5 22.2 1.5 15 1.5S2 7.5 2 15.5C2 25.8 15 39 15 39z" fill="#0A7C88" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="15.5" r="5" fill="#fff"/></svg>`;
const TRUCK_SVG = `<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M2 6h11v9H2zM13 9h4l3 3.5V15h-7z"/><circle cx="6" cy="17" r="2.2"/><circle cx="16.5" cy="17" r="2.2"/></svg>`;

function el(className: string, html = "") {
  const d = document.createElement("div");
  d.className = className;
  d.innerHTML = html;
  return d;
}

const toArr = (p: LngLat): [number, number] => [p.lng, p.lat];
const ANIM_MS = 9000; // just under the 10 s ping interval, so motion looks continuous

type Props = {
  center: LngLat;
  /** Editable delivery point: draggable pin, click the map to move it. */
  pick?: { value: LngLat; onChange: (p: LngLat) => void };
  destination?: LngLat | null;
  tanker?: LngLat | null;
  /** Small label under the tanker marker, e.g. "Last updated 12 s ago". */
  tankerNote?: string;
  /** Grey the tanker marker out (location delayed). */
  tankerStale?: boolean;
  me?: LngLat | null;
  /** Keep destination + tanker/me in view as they change. */
  follow?: boolean;
  hint?: string;
  onLocate?: () => void;
  /** Extra bottom padding when framing, e.g. for a sheet overlapping the map. */
  padBottom?: number;
};

export default function MapView({ center, pick, destination, tanker, tankerNote, tankerStale, me, follow, hint, onLocate, padBottom = 0 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const pickMarker = useRef<maplibregl.Marker | null>(null);
  const destMarker = useRef<maplibregl.Marker | null>(null);
  const tankerMarker = useRef<maplibregl.Marker | null>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const anim = useRef<number>(0);
  const onPick = useRef(pick?.onChange);
  useEffect(() => {
    onPick.current = pick?.onChange;
  });

  // Create the map once.
  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current,
      style: OSM_STYLE,
      center: toArr(center),
      zoom: 14,
      attributionControl: { compact: true },
    });
    m.on("click", (e) => onPick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    map.current = m;
    return () => {
      cancelAnimationFrame(anim.current);
      // Drop markers with the map so they're rebuilt on the next one
      // (React Strict Mode mounts effects twice in development).
      for (const ref of [pickMarker, destMarker, tankerMarker, meMarker]) {
        ref.current?.remove();
        ref.current = null;
      }
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const mk = new maplibregl.Marker({ element: el("pin", PIN_SVG), anchor: "bottom", draggable: true })
        .setLngLat(toArr(pick.value))
        .addTo(m);
      mk.on("dragend", () => {
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

  // Fixed destination pin.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!destination) {
      destMarker.current?.remove();
      destMarker.current = null;
      return;
    }
    destMarker.current ??= new maplibregl.Marker({ element: el("pin", PIN_SVG), anchor: "bottom" }).setLngLat(toArr(destination)).addTo(m);
    destMarker.current.setLngLat(toArr(destination));
  }, [destination?.lat, destination?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tanker: glide from where it is now to the new fix.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!tanker) {
      tankerMarker.current?.remove();
      tankerMarker.current = null;
      return;
    }
    if (!tankerMarker.current) {
      const wrap = el("tkr", `<div class="truck">${TRUCK_SVG}</div><div class="tkr-label"></div>`);
      tankerMarker.current = new maplibregl.Marker({ element: wrap }).setLngLat(toArr(tanker)).addTo(m);
      return;
    }
    const mk = tankerMarker.current;
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

  // Tanker label and delayed state.
  useEffect(() => {
    const node = tankerMarker.current?.getElement();
    if (!node) return;
    node.classList.toggle("stale", Boolean(tankerStale));
    const label = node.querySelector(".tkr-label");
    if (label) label.textContent = tankerNote ?? "";
  });

  // Driver's own position.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!me) {
      meMarker.current?.remove();
      meMarker.current = null;
      return;
    }
    meMarker.current ??= new maplibregl.Marker({ element: el("me") }).setLngLat(toArr(me)).addTo(m);
    meMarker.current.setLngLat(toArr(me));
  }, [me?.lat, me?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame destination and the moving point together.
  useEffect(() => {
    const m = map.current;
    if (!m || !follow || !destination) return;
    const other = tanker ?? me;
    if (!other) {
      m.easeTo({ center: toArr(destination), zoom: 14, duration: 600 });
      return;
    }
    const b = new maplibregl.LngLatBounds(toArr(destination), toArr(destination)).extend(toArr(other));
    m.fitBounds(b, { padding: { top: 84, left: 50, right: 50, bottom: 50 + padBottom }, maxZoom: 16, duration: 800 });
  }, [follow, padBottom, destination?.lat, destination?.lng, tanker?.lat, tanker?.lng, me?.lat, me?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mapfill">
      <div ref={box} className="ml" />
      {hint && <div className="hint">{hint}</div>}
      {onLocate && (
        <button type="button" className="locate" onClick={onLocate}>
          ◎ Use my location
        </button>
      )}
    </div>
  );
}
