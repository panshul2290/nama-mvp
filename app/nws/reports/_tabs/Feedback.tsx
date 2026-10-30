"use client";

import { BarList, LineChart } from "@/components/nws/admin/charts";
import { dayKeys, dayLabel, Empty, int, Kpi, pct } from "@/components/nws/admin/ui";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { ReportState, useReport } from "./report";

export const stars = (n: number) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));

/** report_feedback (0029): feedback insights over every rating and complaint in range (F8). */
type Fb = {
  ratings: number; average: number | null; delivered: number;
  distribution: { "5": number; "4": number; "3": number; "1-2": number };
  per_day: { day: string; n: number; average: number }[];
  per_week: { week: string; n: number; average: number }[];
  by_company: { company: string; n: number; average: number; low: number }[];
  worst_drivers: { driver_id: string; name: string | null; company: string; n: number; average: number; low: number }[];
  comments: { id: string; order_no: number; rating: number; comment: string; driver: string | null; area: string; rated_at: string | null }[];
  complaints: number; resolved: number; reopened: number; reopen_rate: number | null;
  by_category: { category: string; label: string; n: number; open: number }[];
};

const tone = (avg: number) => (avg < 3.5 ? "bad" : avg < 4.3 ? "warn" : "ok");

export default function Feedback({ days }: { days: number }) {
  const { data: s, error } = useReport<Fb>("report_feedback", days);
  if (!s) return <ReportState error={error} what="feedback" />;

  const keys = dayKeys(days);
  const byDay = new Map(s.per_day.map((d) => [d.day, Number(d.average)]));
  const dist = [
    { label: "5 stars", value: s.distribution["5"] },
    { label: "4 stars", value: s.distribution["4"] },
    { label: "3 stars", value: s.distribution["3"] },
    { label: "1–2 stars", value: s.distribution["1-2"] },
  ];
  const five = s.ratings ? s.distribution["5"] / s.ratings : null;

  return (
    <>
      <div className="okpis">
        <Kpi label="Average rating" value={s.average == null ? "—" : `${Number(s.average).toFixed(2)} ★`} sub={`${int(s.ratings)} ratings · ${five == null ? "—" : pct(five, 0)} five-star`} tone={s.average == null ? undefined : s.average >= 4.5 ? "ok" : s.average < 4 ? "bad" : "warn"} />
        <Kpi label="Rated deliveries" value={s.delivered ? pct(s.ratings / s.delivered, 0) : "—"} sub="of delivered orders" />
        <Kpi label="Complaints" value={int(s.complaints)} sub={`${int(s.by_category.reduce((a, c) => a + c.open, 0))} still open`} tone={s.complaints ? "warn" : undefined} />
        <Kpi label="Reopen rate" value={s.reopen_rate == null ? "—" : pct(Number(s.reopen_rate))} sub={`${s.reopened} of ${s.resolved} resolved cases reopened`} tone={s.reopen_rate != null && s.reopen_rate > 0.1 ? "warn" : undefined} />
      </div>

      <div className="half">
        <div className="panel">
          <h2>Average rating over time <small>per day</small></h2>
          <LineChart labels={keys.map(dayLabel)} series={[{ name: "Average rating", color: "var(--warn)", values: keys.map((k) => byDay.get(k) ?? null) }]} yMax={5} fmt={(v) => v.toFixed(1)} height={170} />
          {s.per_week.length > 1 && (
            <p className="note">By week: {s.per_week.map((w) => `${dayLabel(w.week)} ${Number(w.average).toFixed(2)} (${w.n})`).join(" · ")}</p>
          )}
        </div>
        <div className="panel">
          <h2>Driver ratings <small>distribution</small></h2>
          <BarList rows={dist.map((d, i) => ({ ...d, color: i === 3 ? "var(--bad)" : i === 2 ? "var(--warn)" : "var(--accent)" }))} fmt={(v) => (s.ratings ? pct(v / s.ratings, 0) : "0%")} empty="No ratings in this range." />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>Ratings by company</h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Company</th><th className="num">Ratings</th><th className="num">Average</th><th className="num">1–2 stars</th></tr></thead>
              <tbody>
                {s.by_company.length === 0 && <Empty cols={4}>No ratings in this range.</Empty>}
                {s.by_company.map((c) => (
                  <tr key={c.company}>
                    <td>{c.company}</td>
                    <td className="num">{c.n}</td>
                    <td className="num"><span className={`st ${tone(Number(c.average))}`}>{Number(c.average).toFixed(2)}</span></td>
                    <td className="num">{c.low}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>Worst-rated drivers <small>lowest average first</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Driver</th><th>Company</th><th className="num">Ratings</th><th className="num">Average</th><th className="num">1–2 stars</th></tr></thead>
              <tbody>
                {s.worst_drivers.length === 0 && <Empty cols={5}>No ratings in this range.</Empty>}
                {s.worst_drivers.map((d) => (
                  <tr key={d.driver_id}>
                    <td>{d.name || "Driver"}</td>
                    <td>{d.company}</td>
                    <td className="num">{d.n}</td>
                    <td className="num"><span className={`st ${tone(Number(d.average))}`}>{Number(d.average).toFixed(2)}</span></td>
                    <td className="num">{d.low}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>Complaints by category</h2>
          <BarList rows={s.by_category.map((c) => ({ label: c.label, value: c.n, color: "var(--warn)" }))} empty="No complaints in this range." />
        </div>
        <div className="panel">
          <h2>What customers mention <small>latest rating comments</small></h2>
          {s.comments.length === 0 && <div className="empty">No comments in this range.</div>}
          {s.comments.map((o) => (
            <div className="quote" key={o.id}>
              <span className="stars">{stars(o.rating)}</span> “{o.comment}”
              <small>TO-{o.order_no} · {o.driver ?? "Driver"} · {o.area} · {fmtDateTime(o.rated_at)}</small>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
