"use client";

// Service-disruption banner (#20, 0038): NWS posts a notice for all areas, some zones or some
// clusters; my_service_notices() returns the live ones for the customer's properties, recent
// orders and (on the request screen) the point being ordered for. Before the migration the
// RPC is missing and nothing shows.
//   <ServiceNotices />                  app home
//   <ServiceNotices lat={…} lng={…} />  request screen, for the chosen delivery point
import { useEffect, useState } from "react";
import { useCx } from "@/components/customer/i18n";
import { tshort } from "@/components/customer/fmt";
import { supabase } from "@/lib/supabase/client";
import type { ServiceNotice } from "@/lib/types";

// The plain banner is the warning tone.
const TONE: Record<ServiceNotice["severity"], string> = { info: "info", warning: "", critical: "badb" };

/** Live notices for the signed-in customer (and the point, when given). */
export function useServiceNotices(lat?: number | null, lng?: number | null) {
  const [list, setList] = useState<ServiceNotice[]>([]);
  // Round the point so a dragged pin doesn't query on every pixel.
  const la = lat == null ? null : Math.round(lat * 500) / 500;
  const lo = lng == null ? null : Math.round(lng * 500) / 500;
  useEffect(() => {
    let live = true;
    const args = la != null && lo != null ? { p_lat: la, p_lng: lo } : {};
    supabase()
      .rpc("my_service_notices", args)
      .then(({ data, error }) => {
        if (live) setList(error ? [] : ((data ?? []) as ServiceNotice[]));
      });
    return () => {
      live = false;
    };
  }, [la, lo]);
  return list;
}

/** One line per notice: "Supply disruption in Seeb — Expect delays until 18:00". */
export function noticeText(n: ServiceNotice, lang: "en" | "ar", until: (t: string) => string) {
  const title = lang === "ar" ? n.title_ar : n.title_en;
  const body = lang === "ar" ? n.body_ar : n.body_en;
  return [title, [body, n.ends_at ? until(n.ends_at) : ""].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
}

export function ServiceNotices({ lat, lng }: { lat?: number | null; lng?: number | null }) {
  const { t, lang } = useCx();
  const list = useServiceNotices(lat, lng);
  if (!list.length) return null;
  return (
    <>
      {list.map((n) => {
        const areas = n.scope === "all" ? t("ntAll") : (lang === "ar" ? n.areas.ar : n.areas.en).join(lang === "ar" ? "، " : ", ");
        return (
          <div key={n.id} className={`banner ${TONE[n.severity]}`} role={n.severity === "critical" ? "alert" : "status"}>
            <b>{noticeText(n, lang, (iso) => t("ntUntil", { t: tshort(iso, lang) }))}</b>
            {areas && <small style={{ display: "block", marginTop: 2 }}>{n.scope === "all" ? areas : t("ntAreas", { a: areas })}</small>}
          </div>
        );
      })}
    </>
  );
}
