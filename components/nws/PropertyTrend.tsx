"use client";

import { useEffect, useState } from "react";
import { LineChart, SERVICE_COLOR } from "@/components/nws/admin/charts";
import { CUSTOMERS } from "@/components/nws/i18n/customers";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";

// F5: a property's weekly consumption (property_trend, 0029), for NWS Customers.
type Trend = {
  weeks: { week: string; dw: number; te: number; ww: number; deliveries: number }[];
  total_gal: number; deliveries: number; tank_gal: number;
  refill: { avg_gap_days: number; next_due_at: string } | null;
};

export function PropertyTrend({ propertyId, weeks = 12 }: { propertyId: string; weeks?: number }) {
  const [t, setT] = useState<Trend | null>(null);
  const [err, setErr] = useState(false);
  const t0 = useT(CUSTOMERS);
  const f = useFmt();
  useEffect(() => {
    supabase()
      .rpc("property_trend", { p_property: propertyId, p_weeks: weeks })
      .then(({ data, error }) => {
        setErr(!!error);
        setT((data as Trend | null) ?? null);
      });
  }, [propertyId, weeks]);
  if (err) return <p className="mut" style={{ fontSize: 12.5 }}>{t0("trendNa")}</p>;
  if (!t) return <p className="mut" style={{ fontSize: 12.5 }}>{t0("trendLoading")}</p>;
  const has = (k: "dw" | "te" | "ww") => t.weeks.some((w) => Number(w[k]) > 0);
  const series = [
    { name: label("svc", "DW", f.lang), color: SERVICE_COLOR.DW, values: t.weeks.map((w) => Number(w.dw)), on: has("dw") || !(has("te") || has("ww")) },
    { name: label("svc", "TE", f.lang), color: SERVICE_COLOR.TE, values: t.weeks.map((w) => Number(w.te)), on: has("te") },
    { name: label("svc", "WW", f.lang), color: SERVICE_COLOR.WW, values: t.weeks.map((w) => Number(w.ww)), on: has("ww") },
  ].filter((s) => s.on);
  const perWeek = t.total_gal / Math.max(t.weeks.length, 1);
  return (
    <div>
      <LineChart labels={t.weeks.map((w) => f.day(w.week))} series={series} height={120} />
      <small className="mut">
        {t0("trendLine", { gal: f.n(perWeek), weeks: f.n(t.weeks.length), n: f.n(t.deliveries) })}
        {t.tank_gal ? t0("trendTank", { gal: f.n(t.tank_gal), pct: f.pct(Math.round((perWeek / t.tank_gal) * 100) / 100, 0) }) : ""}
        {t.refill ? t0("trendRefill", { d: f.n(Number(t.refill.avg_gap_days), 1), date: f.date(t.refill.next_due_at) }) : ""}
      </small>
    </div>
  );
}
