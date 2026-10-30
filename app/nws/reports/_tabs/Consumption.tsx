"use client";

import { BarList, Donut, PALETTE, SERVICE_COLOR, Sparkline } from "@/components/nws/admin/charts";
import { Empty, int, Kpi, omr } from "@/components/nws/admin/ui";
import { fmtDate } from "@/components/nws/StaffContext";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { ReportState, useReport } from "./report";

const SEGMENT_LABEL: Record<string, string> = { household: "Residential", commercial: "Commercial", farm: "Farms", government: "Government" };

type Pred = { key: string; customer_id: string; name: string | null; property_id: string | null; label: string | null; area: string; due_in: number | null; next_at: string | null };
/** report_consumption (0029): totals over every delivery in range; refill predictions over 180 days. */
type Cons = {
  trips: number; gallons: number; tracked: number; alerts_count: number;
  by_area: { area: string; gallons: number }[];
  by_service: Partial<Record<ServiceType, number>>;
  segments: Record<string, number>;
  top_consumers: { customer_id: string; name: string | null; segment: string | null; trips: number; gallons: number; omr: number }[];
  alerts: (Pred & { avg_days: number; last_at: string })[];
  top_properties: (Pred & { tank_gal: number | null; per_week: number; weeks: number[]; deliveries: number })[];
};

const due = (d: number | null) =>
  d == null ? <span className="mut">—</span> : d < 0 ? <span className="st bad">Overdue {Math.ceil(-d)} d</span> : d <= 3 ? <span className="st warn">Due in {Math.max(0, Math.round(d))} d</span> : <span className="st ok">In {Math.round(d)} d</span>;
const place = (p: Pred) => (p.property_id ? (p.label ?? "Property") : "No saved property");

export default function Consumption({ days }: { days: number }) {
  const { data: s, error } = useReport<Cons>("report_consumption", days);
  if (!s) return <ReportState error={error} what="consumption" />;
  const total = s.gallons;

  return (
    <>
      <div className="okpis">
        <Kpi label="Water delivered" value={`${int(total)} gal`} sub={`${int(s.trips)} trips in range`} />
        <Kpi label="Average per trip" value={s.trips ? `${int(total / s.trips)} gal` : "—"} />
        <Kpi label="Refill alerts due" value={int(s.alerts_count)} sub="refill expected within 3 days" tone={s.alerts_count ? "warn" : undefined} />
        <Kpi label="Properties tracked" value={int(s.tracked)} sub="2 or more drinking-water deliveries in 180 days" />
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>Water delivered by area <small>gallons</small></h2>
          <BarList rows={s.by_area.map((a) => ({ label: a.area, value: a.gallons }))} />
        </div>
        <div className="panel">
          <h2>By service <small>gallons</small></h2>
          <Donut
            slices={(["DW", "WW", "TE"] as ServiceType[]).map((sv) => ({ label: SERVICE_LABEL[sv], value: s.by_service[sv] ?? 0, color: SERVICE_COLOR[sv] }))}
            center={total >= 1e6 ? `${(total / 1e6).toFixed(1)} M` : `${Math.round(total / 1e3)} k`}
            sub="gallons"
          />
        </div>
        <div className="panel">
          <h2>Customer segments <small>accounts</small></h2>
          <Donut slices={Object.entries(s.segments).map(([k, v], i) => ({ label: SEGMENT_LABEL[k] ?? k, value: v, color: PALETTE[i % PALETTE.length] }))} sub="customers" />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>Top consumers <small>delivered in range</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Customer</th><th className="num">Trips</th><th className="num">Gallons</th><th className="num">OMR</th></tr></thead>
              <tbody>
                {s.top_consumers.length === 0 && <Empty cols={4}>No deliveries in this range.</Empty>}
                {s.top_consumers.map((c) => (
                  <tr key={c.customer_id}>
                    <td>{c.name || "Customer"}<small style={{ display: "block" }}>{SEGMENT_LABEL[c.segment ?? ""] ?? ""}</small></td>
                    <td className="num">{c.trips}</td>
                    <td className="num">{int(c.gallons)}</td>
                    <td className="num">{omr(c.omr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>Predictive refill alerts <small>refill expected within 3 days</small></h2>
          <div className="tblwrap scroll">
            <table>
              <thead><tr><th>Customer · property</th><th className="num">Every</th><th>Last delivery</th><th>Expected</th><th>Alert</th></tr></thead>
              <tbody>
                {s.alerts.length === 0 && <Empty cols={5}>No refills due in the next 3 days.</Empty>}
                {s.alerts.map((p) => (
                  <tr key={p.key}>
                    <td>{p.name || "Customer"}<small style={{ display: "block" }}>{place(p)} · {p.area}</small></td>
                    <td className="num">{Number(p.avg_days).toFixed(1)} d</td>
                    <td>{fmtDate(p.last_at)}</td>
                    <td>{p.next_at ? fmtDate(p.next_at) : "—"}</td>
                    <td>{due(p.due_in)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">Average interval between a property&apos;s drinking-water deliveries over the last 180 days. Refill reminders go out automatically every morning (09:00) to customers who allow reminders, once per predicted refill, unless an order or contract is already open — see Settings → Notifications → Outbox (event refill_reminder).</p>
        </div>
      </div>

      <div className="panel">
        <h2>Consumption by property <small>usage trends, drinking water</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Property</th><th>Customer</th><th className="num">Gallons / week</th><th>Trend (8 weeks)</th><th className="num">Deliveries</th><th>Next predicted refill</th><th>Alert</th></tr>
            </thead>
            <tbody>
              {s.top_properties.length === 0 && <Empty cols={7}>Not enough delivery history yet.</Empty>}
              {s.top_properties.map((p) => (
                <tr key={p.key}>
                  <td>{place(p)}<small style={{ display: "block" }}>{p.area}{p.tank_gal ? ` · tank ${int(p.tank_gal)} gal` : ""}</small></td>
                  <td>{p.name || "Customer"}</td>
                  <td className="num">{int(p.per_week)}</td>
                  <td><Sparkline values={p.weeks.map(Number)} /></td>
                  <td className="num">{p.deliveries}</td>
                  <td>{p.next_at ? fmtDate(p.next_at) : "—"}</td>
                  <td>{due(p.due_in)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
