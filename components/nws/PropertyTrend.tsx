"use client";

import { useEffect, useState } from "react";
import { LineChart, SERVICE_COLOR } from "@/components/nws/admin/charts";
import { dayLabel } from "@/components/nws/admin/ui";
import { fmtDate } from "@/components/nws/StaffContext";
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
  useEffect(() => {
    supabase()
      .rpc("property_trend", { p_property: propertyId, p_weeks: weeks })
      .then(({ data, error }) => {
        setErr(!!error);
        setT((data as Trend | null) ?? null);
      });
  }, [propertyId, weeks]);
  if (err) return <p className="mut" style={{ fontSize: 12.5 }}>Trend unavailable.</p>;
  if (!t) return <p className="mut" style={{ fontSize: 12.5 }}>Loading trend…</p>;
  const has = (k: "dw" | "te" | "ww") => t.weeks.some((w) => Number(w[k]) > 0);
  const series = [
    { name: "Drinking water", color: SERVICE_COLOR.DW, values: t.weeks.map((w) => Number(w.dw)), on: has("dw") || !(has("te") || has("ww")) },
    { name: "Treated effluent", color: SERVICE_COLOR.TE, values: t.weeks.map((w) => Number(w.te)), on: has("te") },
    { name: "Wastewater", color: SERVICE_COLOR.WW, values: t.weeks.map((w) => Number(w.ww)), on: has("ww") },
  ].filter((s) => s.on);
  const perWeek = t.total_gal / Math.max(t.weeks.length, 1);
  return (
    <div>
      <LineChart labels={t.weeks.map((w) => dayLabel(w.week))} series={series} height={120} />
      <small className="mut">
        {Math.round(perWeek).toLocaleString()} gal / week over {t.weeks.length} weeks · {t.deliveries} deliveries
        {t.tank_gal ? ` · tank ${t.tank_gal.toLocaleString()} gal (${Math.round((perWeek / t.tank_gal) * 100)}% a week)` : ""}
        {t.refill ? ` · usual interval ${Number(t.refill.avg_gap_days).toFixed(1)} d, next ≈ ${fmtDate(t.refill.next_due_at)}` : ""}
      </small>
    </div>
  );
}
