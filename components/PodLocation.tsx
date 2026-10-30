"use client";

import { localDigits, useLang, useT, type Dict, type Lang } from "@/lib/i18n";
import { coords, mapLink, metres as metresEn, podCheck, POD_FAR_M } from "@/lib/podLocation";
import { omanLocale, omanTime } from "@/lib/time";
import type { Pod } from "@/lib/types";

const time = (iso: string | null | undefined, lang: Lang) => omanTime(iso, omanLocale(lang)) || null;
const metres = (m: number, lang: Lang) => (lang === "ar" ? localDigits(metresEn(m).replace(" km", " كم").replace(" m", " م"), lang) : metresEn(m));

export const POD_TEXT: Dict = {
  photoGallery: { en: "Photo added (from the phone’s gallery, not taken live)", ar: "صورة مضافة (من معرض الهاتف، لم تُلتقط مباشرة)" },
  photoTaken: { en: "Photo taken", ar: "التُقطت الصورة" },
  submittedTanker: { en: "Submitted (tanker’s last GPS fix — no phone fix)", ar: "أُرسل (آخر موقع GPS للصهريج — لا يوجد موقع من الهاتف)" },
  submitted: { en: "Submitted", ar: "أُرسل" },
  none: { en: "No location was recorded with this proof.", ar: "لم يُسجَّل أي موقع مع هذا الإثبات." },
  far: { en: "Recorded more than {d} from the delivery point — check before accepting.", ar: "سُجّل على بُعد أكثر من {d} من نقطة التوصيل — تحقّق قبل القبول." },
  fromPoint: { en: "{d} from the delivery point", ar: "{d} من نقطة التوصيل" },
  farTag: { en: "far", ar: "بعيد" },
  noLoc: { en: "No location", ar: "لا يوجد موقع" },
  diagram: { en: "Where the proof was recorded, relative to the delivery point", ar: "مكان تسجيل الإثبات بالنسبة إلى نقطة التوصيل" },
  legend: { en: "■ delivery point · dashed {d}", ar: "■ نقطة التوصيل · المتقطع {d}" },
};

/**
 * Where a proof of delivery was recorded (staff and business screens, English or Arabic): the photo's fix and
 * the submit fix with accuracy and time, the distance from the delivery point, a flag when it is
 * further than POD_FAR_M, and a small pin diagram (delivery point in the middle).
 */
export function PodLocation({ pod, site }: { pod: Pod; site?: { lat: number; lng: number } | null }) {
  const c = podCheck(pod);
  const t = useT(POD_TEXT);
  const { lang } = useLang();
  const rows: [string, number | null | undefined, number | null | undefined, number | null | undefined, string | null | undefined, number | null][] = [
    [t(pod.photo_source === "gallery" ? "photoGallery" : "photoTaken"), pod.photo_lat, pod.photo_lng, pod.photo_accuracy_m, pod.photo_at, c.photoDistance],
    [t(c.source === "tanker" ? "submittedTanker" : "submitted"), pod.lat, pod.lng, pod.accuracy_m, pod.fix_at ?? pod.created_at, c.distance],
  ];
  const any = rows.some((r) => r[1] != null && r[2] != null);
  if (!any) return <p className="mut" style={{ fontSize: 13, margin: "0 0 8px" }}>{t("none")}</p>;
  return (
    <div className="podloc">
      {c.far && (
        <div className="banner badb" role="status" style={{ margin: "0 0 8px" }}>
          {t("far", { d: metres(POD_FAR_M, lang) })}
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
  const t = useT(POD_TEXT);
  const { lang } = useLang();
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <a className="lk" href={mapLink(lat, lng)} target="_blank" rel="noreferrer" dir="ltr">
          {coords(lat, lng)}
        </a>
        <small className="mut" style={{ display: "block", fontWeight: 400 }}>
          {[acc != null ? `±${metres(Math.round(acc), lang)}` : null, time(at, lang), dist != null ? t("fromPoint", { d: metres(dist, lang) }) : null].filter(Boolean).join(" · ")}
          {dist != null && dist > POD_FAR_M && <b style={{ color: "var(--bad)" }}> · {t("farTag")}</b>}
        </small>
      </dd>
    </>
  );
}

function Missing({ label }: { label: string }) {
  const t = useT(POD_TEXT);
  return (
    <>
      <dt>{label}</dt>
      <dd className="mut" style={{ fontWeight: 400 }}>{t("noLoc")}</dd>
    </>
  );
}

/** Delivery point in the middle; the fixes placed around it to scale (at least ±100 m across). */
function PinDiagram({ site, pod }: { site: { lat: number; lng: number }; pod: Pod }) {
  const t = useT(POD_TEXT);
  const { lang } = useLang();
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
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("diagram")} style={{ background: "var(--bg, #eef3f4)", borderRadius: 8, flex: "none" }}>
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
      <text x={lang === "ar" ? W - 4 : 4} y={H - 4} fontSize={9} fill="currentColor" opacity={0.6} textAnchor={lang === "ar" ? "start" : undefined}>
        {t("legend", { d: metres(POD_FAR_M, lang) })}
      </text>
    </svg>
  );
}
