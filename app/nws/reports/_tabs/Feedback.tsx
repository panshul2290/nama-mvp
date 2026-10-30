"use client";

import { useEffect, useMemo, useState } from "react";
import { BarList, LineChart } from "@/components/nws/admin/charts";
import { dayKey, dayKeys, dayLabel, Empty, fetchPaged, groupBy, int, Kpi, pct, sinceIso } from "@/components/nws/admin/ui";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";
import { ROW_CAP, type ORow } from "./data";

export const stars = (n: number) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));

export default function Feedback({ rows, days }: { rows: ORow[]; days: number }) {
  const [cx, setCx] = useState<{ category: string; label: string }[] | null>(null);

  useEffect(() => {
    const db = supabase();
    Promise.all([
      // Test-zone orders stay out of reports; complaints without an order are kept.
      fetchPaged<{ category: string; order: { is_test: boolean } | { is_test: boolean }[] | null }>((a, b) =>
        db.from("complaints").select("category, order:orders(is_test)").gte("created_at", sinceIso(days)).order("id").range(a, b), ROW_CAP),
      db.from("complaint_sla").select("category, label"),
    ]).then(([c, sla]) => {
      const labels = new Map(((sla.data ?? []) as { category: string; label: string }[]).map((r) => [r.category, r.label]));
      const test = (o: { is_test: boolean } | { is_test: boolean }[] | null) => (Array.isArray(o) ? o[0]?.is_test : o?.is_test) === true;
      setCx(c.rows.filter((r) => !test(r.order)).map((r) => ({ category: r.category, label: labels.get(r.category) ?? r.category })));
    });
  }, [days]);

  const s = useMemo(() => {
    const rated = rows.filter((o) => o.rating != null);
    const avg = rated.length ? rated.reduce((a, o) => a + o.rating!, 0) / rated.length : null;
    const dist = [5, 4, 3].map((n) => ({ label: `${n} stars`, value: rated.filter((o) => o.rating === n).length }));
    dist.push({ label: "1–2 stars", value: rated.filter((o) => o.rating! <= 2).length });
    const keys = dayKeys(days);
    const perDay = groupBy(rated, (o) => dayKey(o.rated_at ?? o.created_at), () => ({ n: 0, sum: 0 }), (a, o) => { a.n++; a.sum += o.rating!; });
    const trend = keys.map((k) => { const d = perDay.get(k); return d ? d.sum / d.n : null; });
    const comments = rated.filter((o) => o.rating_comment?.trim()).sort((a, b) => (b.rated_at ?? "").localeCompare(a.rated_at ?? "")).slice(0, 8);
    const drivers = [...groupBy(rated.filter((o) => o.driver_id), (o) => o.driver_id!, () => ({ name: "", n: 0, sum: 0, low: 0 }), (a, o) => {
      a.name ||= o.driver_name ?? ""; a.n++; a.sum += o.rating!; if (o.rating! <= 2) a.low++;
    })].map(([id, v]) => ({ id, ...v, avg: v.sum / v.n })).sort((a, b) => a.avg - b.avg || b.n - a.n).slice(0, 8);
    return { rated, avg, dist, keys, trend, comments, drivers };
  }, [rows, days]);

  const byCat = cx ? [...groupBy(cx, (c) => c.label, () => ({ n: 0 }), (a) => a.n++)].sort((a, b) => b[1].n - a[1].n) : [];
  const five = s.rated.length ? s.dist[0].value / s.rated.length : null;

  return (
    <>
      <div className="okpis">
        <Kpi label="Average rating" value={s.avg == null ? "—" : `${s.avg.toFixed(2)} ★`} sub={`${int(s.rated.length)} ratings`} tone={s.avg == null ? undefined : s.avg >= 4.5 ? "ok" : s.avg < 4 ? "bad" : "warn"} />
        <Kpi label="Five-star share" value={five == null ? "—" : pct(five, 0)} />
        <Kpi label="Rated deliveries" value={rows.filter((o) => o.status === "delivered").length ? pct(s.rated.length / rows.filter((o) => o.status === "delivered").length, 0) : "—"} sub="of delivered orders" />
        <Kpi label="Complaints" value={cx ? int(cx.length) : "…"} sub="filed in range" tone={cx && cx.length ? "warn" : undefined} />
      </div>

      <div className="half">
        <div className="panel">
          <h2>Driver ratings <small>distribution</small></h2>
          <BarList rows={s.dist.map((d, i) => ({ ...d, color: i === 3 ? "var(--bad)" : i === 2 ? "var(--warn)" : "var(--accent)" }))} fmt={(v) => (s.rated.length ? pct(v / s.rated.length, 0) : "0%")} empty="No ratings in this range." />
        </div>
        <div className="panel">
          <h2>Average rating <small>per day</small></h2>
          <LineChart labels={s.keys.map(dayLabel)} series={[{ name: "Average rating", color: "var(--warn)", values: s.trend }]} yMax={5} fmt={(v) => v.toFixed(1)} height={170} />
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>What customers mention <small>latest rating comments</small></h2>
          {s.comments.length === 0 && <div className="empty">No comments in this range.</div>}
          {s.comments.map((o) => (
            <div className="quote" key={o.id}>
              <span className="stars">{stars(o.rating!)}</span> “{o.rating_comment}”
              <small>TO-{o.order_no} · {o.driver_name ?? "Driver"} · {o.area} · {fmtDateTime(o.rated_at)}</small>
            </div>
          ))}
        </div>
        <div className="stack">
          <div className="panel">
            <h2>Complaints by category</h2>
            {cx ? <BarList rows={byCat.map(([l, v]) => ({ label: l, value: v.n, color: "var(--warn)" }))} empty="No complaints in this range." /> : <div className="empty">Loading…</div>}
          </div>
          <div className="panel">
            <h2>Lowest-rated drivers</h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>Driver</th><th className="num">Ratings</th><th className="num">Average</th><th className="num">1–2 stars</th></tr></thead>
                <tbody>
                  {s.drivers.length === 0 && <Empty cols={4}>No ratings in this range.</Empty>}
                  {s.drivers.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name || "Driver"}</td>
                      <td className="num">{d.n}</td>
                      <td className="num"><span className={`st ${d.avg < 3.5 ? "bad" : d.avg < 4.3 ? "warn" : "ok"}`}>{d.avg.toFixed(2)}</span></td>
                      <td className="num">{d.low}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
