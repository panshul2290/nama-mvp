"use client";

// Service-disruption notices (0038) on the Business dashboard, for the organisation's sites.
// my_service_notices() matches the notice's zones / clusters against the sites and lists the
// site names it covers. Nothing shows before the migration (the RPC is missing).
import { useEffect, useState } from "react";
import { BIZ } from "@/components/business/i18n";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { ServiceNotice } from "@/lib/types";

const TONE: Record<ServiceNotice["severity"], string> = { info: "info", warning: "", critical: "badb" };

export function SiteNotices() {
  const t = useT(BIZ);
  const f = useFmt();
  const [list, setList] = useState<ServiceNotice[]>([]);
  useEffect(() => {
    let live = true;
    supabase()
      .rpc("my_service_notices")
      .then(({ data, error }) => {
        if (live) setList(error ? [] : ((data ?? []) as ServiceNotice[]));
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      {list.map((n) => {
        const title = f.ar ? n.title_ar : n.title_en;
        const body = [f.ar ? n.body_ar : n.body_en, n.ends_at ? t("ntUntil", { t: f.time(n.ends_at) }) : ""].filter(Boolean).join(" ");
        return (
          <div key={n.id} className={`banner ${TONE[n.severity]}`} role={n.severity === "critical" ? "alert" : "status"}>
            <b>{title}</b>
            {body ? ` — ${body}` : ""}
            <small style={{ display: "block", marginTop: 2 }}>{n.scope === "all" ? t("ntAll") : t("noticeSites", { s: n.sites.join(f.ar ? "، " : ", ") })}</small>
          </div>
        );
      })}
    </>
  );
}
