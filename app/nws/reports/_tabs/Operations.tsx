"use client";

import { useEffect, useMemo, useState } from "react";
import { BarList, Donut, LineChart, SERVICE_COLOR } from "@/components/nws/admin/charts";
import { dayKey, dayKeys, dayLabel, groupBy, int, Kpi, median, pct } from "@/components/nws/admin/ui";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { assignMinutes, CHANNEL_LABEL, onTime, zoneName, type ORow, type Ref } from "./data";

const SERVICES: ServiceType[] = ["DW", "WW", "TE"];
// Annual trips in the tender's tables; drinking water is still to be confirmed by NWS.
const TENDER_ANNUAL: Record<ServiceType, number | null> = { DW: null, WW: 718745, TE: 77668 };

export default function Operations({ rows, refData, days }: { rows: ORow[]; refData: Ref | null; days: number }) {
  const [year, setYear] = useState<Record<ServiceType, number> | null>(null);

  // Platform trips over the last 365 days, counted in the database (no row transfer).
  useEffect(() => {
    const db = supabase();
    const from = new Date(Date.now() - 365 * 86400_000).toISOString();
    Promise.all(
      SERVICES.map((s) => db.from("orders").select("id", { count: "exact", head: true }).eq("service_type", s).eq("status", "delivered").gte("delivered_at", from)),
    ).then((res) => setYear({ DW: res[0].count ?? 0, WW: res[1].count ?? 0, TE: res[2].count ?? 0 }));
  }, []);

  const s = useMemo(() => {
    const delivered = rows.filter((o) => o.status === "delivered");
    const timed = delivered.map(onTime).filter((v): v is boolean => v != null);
    const cancelled = rows.filter((o) => o.status === "cancelled").length;
    const assign = median(rows.map(assignMinutes).filter((v): v is number => v != null && v >= 0));
    const keys = dayKeys(days);
    const perDay = groupBy(delivered, (o) => `${dayKey(o.delivered_at ?? o.created_at)}|${o.service_type}`, () => ({ n: 0 }), (a) => a.n++);
    const series = SERVICES.map((sv) => ({ name: SERVICE_LABEL[sv], color: SERVICE_COLOR[sv], values: keys.map((k) => perDay.get(`${k}|${sv}`)?.n ?? 0) }));
    const total = { name: "All trips", color: "var(--accent)", values: keys.map((_, i) => series.reduce((a, x) => a + (x.values[i] ?? 0), 0)) };
    const byZone = groupBy(delivered, (o) => zoneName(refData, o.zone_id), () => ({ n: 0, on: 0, timed: 0 }), (a, o) => {
      a.n++;
      const t = onTime(o);
      if (t != null) { a.timed++; if (t) a.on++; }
    });
    const byChannel = groupBy(rows, (o) => CHANNEL_LABEL[o.channel] ?? o.channel, () => ({ n: 0 }), (a) => a.n++);
    return { delivered, timed, cancelled, assign, keys, series: [total, ...series], byZone, byChannel };
  }, [rows, refData, days]);

  const onPct = s.timed.length ? s.timed.filter(Boolean).length / s.timed.length : null;
  return (
    <>
      <div className="okpis">
        <Kpi label="Trips completed" value={int(s.delivered.length)} sub={`of ${int(rows.length)} orders placed`} />
        <Kpi label="On-time delivery" value={onPct == null ? "—" : pct(onPct)} sub="arrived within the slot, or within 2 h" tone={onPct == null ? undefined : onPct >= 0.9 ? "ok" : "warn"} />
        <Kpi label="Median time to assign" value={s.assign == null ? "—" : s.assign < 60 ? `${Math.round(s.assign)} min` : `${(s.assign / 60).toFixed(1)} h`} sub="request to tanker accepted" />
        <Kpi label="Cancellations" value={int(s.cancelled)} sub={rows.length ? `${pct(s.cancelled / rows.length)} of orders` : "—"} tone={rows.length && s.cancelled / rows.length > 0.1 ? "bad" : undefined} />
      </div>

      <div className="panel">
        <h2>Trips per day <small>delivered, by service</small></h2>
        <LineChart labels={s.keys.map(dayLabel)} series={s.series} />
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>Trips by service</h2>
          <Donut slices={SERVICES.map((sv) => ({ label: SERVICE_LABEL[sv], value: s.delivered.filter((o) => o.service_type === sv).length, color: SERVICE_COLOR[sv] }))} sub="trips" />
        </div>
        <div className="panel">
          <h2>Trips by zone</h2>
          <BarList rows={[...s.byZone].sort((a, b) => b[1].n - a[1].n).map(([z, v]) => ({ label: z, value: v.n }))} />
        </div>
        <div className="panel">
          <h2>Orders by channel</h2>
          <BarList rows={[...s.byChannel].sort((a, b) => b[1].n - a[1].n).map(([c, v]) => ({ label: c, value: v.n }))} />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>Delivered within slot <small>by zone</small></h2>
          <BarList
            max={100}
            fmt={(v) => `${v.toFixed(1)}%`}
            rows={[...s.byZone].filter(([, v]) => v.timed > 0).sort((a, b) => b[1].on / b[1].timed - a[1].on / a[1].timed).map(([z, v]) => ({ label: z, value: (v.on / v.timed) * 100, color: v.on / v.timed >= 0.9 ? "var(--ok)" : "var(--warn)" }))}
          />
        </div>
        <div className="panel">
          <h2>Annual trips by service <small>tender figures</small></h2>
          <BarList
            max={TENDER_ANNUAL.WW!}
            fmt={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : `${Math.round(v / 1e3)} k`)}
            rows={SERVICES.map((sv) => ({ label: SERVICE_LABEL[sv], value: TENDER_ANNUAL[sv], color: SERVICE_COLOR[sv] }))}
          />
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Service</th><th className="num">Tender (per year)</th><th className="num">On the platform, last 12 months</th></tr>
              </thead>
              <tbody>
                {SERVICES.map((sv) => (
                  <tr key={sv}>
                    <td><span className={`tag ${sv}`}>{SERVICE_LABEL[sv]}</span></td>
                    <td className="num">{TENDER_ANNUAL[sv] == null ? <span className="st warn">TBC</span> : int(TENDER_ANNUAL[sv]!)}</td>
                    <td className="num">{year ? int(year[sv]) : "…"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">Drinking water: TBC (assumption) — the earlier 9.6 M (800,000 a month) was an extrapolation, not a tender figure.</p>
        </div>
      </div>
    </>
  );
}
