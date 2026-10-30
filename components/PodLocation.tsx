"use client";

import { coords, mapLink, metres, podCheck, POD_FAR_M } from "@/lib/podLocation";
import { omanTime } from "@/lib/time";
import type { Pod } from "@/lib/types";

const time = (iso: string | null | undefined) => omanTime(iso) || null;

/**
 * Where a proof of delivery was recorded (staff and business screens, English): the photo's fix and
 * the submit fix with accuracy and time, the distance from the delivery point, a flag when it is
 * further than POD_FAR_M, and a small pin diagram (delivery point in the middle).
 */
export function PodLocation({ pod, site }: { pod: Pod; site?: { lat: number; lng: number } | null }) {
  const c = podCheck(pod);
  const rows: [string, number | null | undefined, number | null | undefined, number | null | undefined, string | null | undefined, number | null][] = [
    [pod.photo_source === "gallery" ? "Photo added (from the phone’s gallery, not taken live)" : "Photo taken", pod.photo_lat, pod.photo_lng, pod.photo_accuracy_m, pod.photo_at, c.photoDistance],
    [c.source === "tanker" ? "Submitted (tanker’s last GPS fix — no phone fix)" : "Submitted", pod.lat, pod.lng, pod.accuracy_m, pod.fix_at ?? pod.created_at, c.distance],
  ];
  const any = rows.some((r) => r[1] != null && r[2] != null);
  if (!any) return <p className="mut" style={{ fontSize: 13, margin: "0 0 8px" }}>No location was recorded with this proof.</p>;
  return (
    <div className="podloc">
      {c.far && (
        <div className="banner badb" role="status" style={{ margin: "0 0 8px" }}>
          Recorded more than {metres(POD_FAR_M)} from the delivery point — check before accepting.
        </div>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {site && <PinDiagram site={site} pod={pod} />}
        <dl className="kv" style={{ padding: 0, flex: "1 1 220px", gridTemplateColumns: "auto 1fr" }}>
          {rows.map(([label, lat, lng, acc, at, dist]) =>
            lat != null && lng != null ? (
              <FixRow key={label} label={label} lat={lat} lng={lng} acc={acc} at={at} dist={dist} />
            ) : (
              <Missing key={label} label={label} />
            ),
          )}
        </dl>
      </div>
    </div>
  );
}

function FixRow({ label, lat, lng, acc, at, dist }: { label: string; lat: number; lng: number; acc: number | null | undefined; at: string | null | undefined; dist: number | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <a className="lk" href={mapLink(lat, lng)} target="_blank" rel="noreferrer" dir="ltr">
          {coords(lat, lng)}
        </a>
        <small className="mut" style={{ display: "block", fontWeight: 400 }}>
          {[acc != null ? `±${Math.round(acc)} m` : null, time(at), dist != null ? `${metres(dist)} from the delivery point` : null].filter(Boolean).join(" · ")}
          {dist != null && dist > POD_FAR_M && <b style={{ color: "var(--bad)" }}> · far</b>}
        </small>
      </dd>
    </>
  );
}

function Missing({ label }: { label: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="mut" style={{ fontWeight: 400 }}>No location</dd>
    </>
  );
}

/** Delivery point in the middle; the fixes placed around it to scale (at least ±100 m across). */
function PinDiagram({ site, pod }: { site: { lat: number; lng: number }; pod: Pod }) {
  const W = 132;
  const H = 96;
  const pts = [
    pod.photo_lat != null && pod.photo_lng != null ? { lat: pod.photo_lat, lng: pod.photo_lng, acc: pod.photo_accuracy_m ?? 0, k: "photo" } : null,
    pod.lat != null && pod.lng != null ? { lat: pod.lat, lng: pod.lng, acc: pod.accuracy_m ?? 0, k: "submit" } : null,
  ].filter(Boolean) as { lat: number; lng: number; acc: number; k: string }[];
  // Metres east/north of the delivery point.
  const off = (p: { lat: number; lng: number }) => ({
    x: (p.lng - site.lng) * 111_320 * Math.cos((site.lat * Math.PI) / 180),
    y: (p.lat - site.lat) * 110_540,
  });
  const span = Math.max(100, ...pts.map((p) => Math.max(Math.abs(off(p).x), Math.abs(off(p).y)) * 1.25));
  const sx = (W / 2 - 10) / span;
  const sy = (H / 2 - 10) / span;
  const s = Math.min(sx, sy);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Where the proof was recorded, relative to the delivery point" style={{ background: "var(--bg, #eef3f4)", borderRadius: 8, flex: "none" }}>
      <circle cx={W / 2} cy={H / 2} r={POD_FAR_M * s} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeDasharray="3 3" />
      <rect x={W / 2 - 5} y={H / 2 - 5} width={10} height={10} rx={2} fill="var(--ink, #0e2329)" />
      {pts.map((p) => {
        const o = off(p);
        const x = W / 2 + o.x * s;
        const y = H / 2 - o.y * s;
        const far = Math.hypot(o.x, o.y) > POD_FAR_M;
        return (
          <g key={p.k}>
            {p.acc > 0 && <circle cx={x} cy={y} r={Math.max(3, p.acc * s)} fill={far ? "var(--bad)" : "var(--dw, #1f8fb0)"} fillOpacity={0.15} />}
            <circle cx={x} cy={y} r={p.k === "photo" ? 4 : 5} fill={far ? "var(--bad)" : p.k === "photo" ? "var(--act, #5b7cfa)" : "var(--dw, #1f8fb0)"} stroke="#fff" strokeWidth={1.5} />
          </g>
        );
      })}
      <text x={4} y={H - 4} fontSize={9} fill="currentColor" opacity={0.6}>
        ■ delivery point · dashed {metres(POD_FAR_M)}
      </text>
    </svg>
  );
}
