"use client";

import { BarList, Donut, LineChart, SERVICE_COLOR } from "@/components/nws/admin/charts";
import { dayKeys, dayLabel, int, Kpi, pct } from "@/components/nws/admin/ui";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { CHANNEL_LABEL } from "./data";
import { ReportState, useReport } from "./report";

const SERVICES: ServiceType[] = ["DW", "WW", "TE"];
// Annual trips in the tender's tables; drinking water is still to be confirmed by NWS.
const TENDER_ANNUAL: Record<ServiceType, number | null> = { DW: null, WW: 718745, TE: 77668 };

/** report_operations (0029): counted in the database over every order in range. */
type Ops = {
  placed: number; delivered: number; cancelled: number; on_time: number; timed: number; median_assign_min: number | null;
  per_day: { day: string; service_type: ServiceType; n: number }[];
  by_service: Partial<Record<ServiceType, number>>;
  by_zone: { zone: string; n: number; on_time: number; timed: number }[];
  by_channel: { channel: string; n: number }[];
  year: Record<ServiceType, number>;
};

export default function Operations({ days }: { days: number }) {
  const { data: s, error } = useReport<Ops>("report_operations", days);
  if (!s) return <ReportState error={error} what="operations" />;

  const keys = dayKeys(days);
  const at = new Map(s.per_day.map((d) => [`${d.day}|${d.service_type}`, d.n]));
  const series = SERVICES.map((sv) => ({ name: SERVICE_LABEL[sv], color: SERVICE_COLOR[sv], values: keys.map((k) => at.get(`${k}|${sv}`) ?? 0) }));
  const total = { name: "All trips", color: "var(--accent)", values: keys.map((_, i) => series.reduce((a, x) => a + (x.values[i] ?? 0), 0)) };
  const onPct = s.timed ? s.on_time / s.timed : null;
  const assign = s.median_assign_min;

  return (
    <>
      <div className="okpis">
        <Kpi label="Trips completed" value={int(s.delivered)} sub={`of ${int(s.placed)} orders placed`} />
        <Kpi label="On-time delivery" value={onPct == null ? "—" : pct(onPct)} sub="delivered (wastewater: collected) by the slot end, or within 2 h" tone={onPct == null ? undefined : onPct >= 0.9 ? "ok" : "warn"} />
        <Kpi label="Median time to assign" value={assign == null ? "—" : assign < 60 ? `${Math.round(assign)} min` : `${(assign / 60).toFixed(1)} h`} sub="request to tanker accepted" />
        <Kpi label="Cancellations" value={int(s.cancelled)} sub={s.placed ? `${pct(s.cancelled / s.placed)} of orders` : "—"} tone={s.placed && s.cancelled / s.placed > 0.1 ? "bad" : undefined} />
      </div>

      <div className="panel">
        <h2>Trips per day <small>delivered, by service</small></h2>
        <LineChart labels={keys.map(dayLabel)} series={[total, ...series]} />
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>Trips by service</h2>
          <Donut slices={SERVICES.map((sv) => ({ label: SERVICE_LABEL[sv], value: s.by_service[sv] ?? 0, color: SERVICE_COLOR[sv] }))} sub="trips" />
        </div>
        <div className="panel">
          <h2>Trips by zone</h2>
          <BarList rows={s.by_zone.map((z) => ({ label: z.zone, value: z.n }))} />
        </div>
        <div className="panel">
          <h2>Orders by channel</h2>
          <BarList rows={s.by_channel.map((c) => ({ label: CHANNEL_LABEL[c.channel] ?? c.channel, value: c.n }))} />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>Delivered within slot <small>by zone</small></h2>
          <BarList
            max={100}
            fmt={(v) => `${v.toFixed(1)}%`}
            rows={s.by_zone.filter((z) => z.timed > 0).sort((a, b) => b.on_time / b.timed - a.on_time / a.timed).map((z) => ({ label: z.zone, value: (z.on_time / z.timed) * 100, color: z.on_time / z.timed >= 0.9 ? "var(--ok)" : "var(--warn)" }))}
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
                    <td className="num">{int(s.year[sv] ?? 0)}</td>
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
