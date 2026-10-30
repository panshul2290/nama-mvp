"use client";

import { useCallback, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { Kpis, useLive } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";

// Aggregated in the database with the shared SLA rule (org_sla_summary, 0026/0027): no row cap,
// and members limited to some sites see only those.
type Summary = { property_id: string | null; label: string; deliveries: number; on_time: number; late: number; late_minutes_avg: number | null; ordered_gal: number; metered_gal: number; with_pod: number };
type Stat = { label: string; n: number; onTime: number; late: number; lateAvg: number | null; ordered: number; metered: number };

const PERIODS = [
  [30, "Last 30 days"],
  [90, "Last 90 days"],
  [365, "Last 12 months"],
] as const;

export default function ServiceLevels() {
  const { org } = useBiz();
  const [days, setDays] = useState<number>(90);
  const [stats, setStats] = useState<Stat[]>([]);
  const [complaints, setComplaints] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [o, p, c] = await Promise.all([
      db.rpc("org_sla_summary", { p_days: days }),
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
      // Org admins see every complaint on the organisation's orders (complaints_org, 0023); others see their own.
      db.from("complaints").select("id, order:orders!inner(org_id)", { count: "exact", head: true }).eq("order.org_id", org.id).gte("created_at", since),
    ]);
    const failed = o.error ?? p.error;
    setError(failed ? failed.message : null);
    if (failed) return setLoaded(true); // keep the figures already on screen
    const sites = (p.data ?? []) as BizProperty[];
    const rows = (o.data ?? []) as Summary[];
    const by = new Map<string, Stat>();
    for (const s of sites) by.set(s.id, { label: s.label, n: 0, onTime: 0, late: 0, lateAvg: null, ordered: 0, metered: 0 });
    for (const r of rows) {
      const key = r.property_id && by.has(r.property_id) ? r.property_id : "other";
      const s = by.get(key) ?? { label: "Other / removed sites", n: 0, onTime: 0, late: 0, lateAvg: null, ordered: 0, metered: 0 };
      const lateMin = (s.lateAvg ?? 0) * s.late + Number(r.late_minutes_avg ?? 0) * r.late;
      s.n += r.deliveries;
      s.onTime += r.on_time;
      s.late += r.late;
      s.lateAvg = s.late ? lateMin / s.late : null;
      s.ordered += Number(r.ordered_gal);
      s.metered += Number(r.metered_gal);
      by.set(key, s);
    }
    setStats([...by.values()]);
    setComplaints(c.count ?? 0);
    setLoaded(true);
  }, [org.id, days]);

  useLive(`biz-sla-${days}`, ["orders"], load, 120_000);

  const total = stats.reduce((a, s) => a + s.n, 0);
  const onTime = stats.reduce((a, s) => a + s.onTime, 0);
  const lateN = stats.reduce((a, s) => a + s.late, 0);
  const lateAvg = lateN ? Math.round(stats.reduce((a, s) => a + (s.lateAvg ?? 0) * s.late, 0) / lateN) : null;
  const variance = (s: { ordered: number; metered: number }) => (s.ordered ? ((s.metered - s.ordered) / s.ordered) * 100 : null);
  const fmtVar = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`);
  const all = stats.reduce((a, s) => ({ ordered: a.ordered + s.ordered, metered: a.metered + s.metered }), { ordered: 0, metered: 0 });

  return (
    <>
      <div className="chips" style={{ marginBottom: 16 }}>
        {PERIODS.map(([d, label]) => (
          <button key={d} className={`chip ${days === d ? "on" : ""}`} onClick={() => setDays(d)}>
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner badb" role="alert">
          Couldn’t load service levels: {error}. It will retry automatically.
        </div>
      )}
      <Kpis
        items={[
          { label: "Delivered within window", value: total ? `${((onTime / total) * 100).toFixed(1)}%` : "—", sub: `${total} deliveries`, tone: total && onTime / total < 0.9 ? "warn" : "ok" },
          { label: "Average delay when late", value: lateAvg != null ? `${lateAvg} min` : "—", sub: `${lateN} late deliveries` },
          { label: "Volume variance", value: fmtVar(variance(all)), sub: "Flow meter vs ordered gallons" },
          { label: "Complaints", value: complaints, sub: PERIODS.find((p) => p[0] === days)?.[1].toLowerCase() },
        ]}
      />
      <div className="panel">
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th className="num">Deliveries</th>
                <th className="num">On time</th>
                <th className="num">Avg delay</th>
                <th className="num">Volume variance</th>
              </tr>
            </thead>
            <tbody>
              {stats
                .filter((s) => s.n > 0 || s.label !== "Other / removed sites")
                .map((s) => {
                  const v = variance(s);
                  return (
                    <tr key={s.label}>
                      <td>{s.label}</td>
                      <td className="num">{s.n}</td>
                      <td className="num">{s.n ? `${((s.onTime / s.n) * 100).toFixed(1)}%` : "—"}</td>
                      <td className="num">{s.lateAvg != null ? `${Math.round(s.lateAvg)} min` : s.n ? "0 min" : "—"}</td>
                      <td className={`num ${v != null && v < -5 ? "badt" : ""}`}>{fmtVar(v)}</td>
                    </tr>
                  );
                })}
              {loaded && !stats.length && (
                <tr>
                  <td className="empty" colSpan={5}>
                    No deliveries in this period yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">
          On time = delivered (wastewater: collected) before the end of the booked window, or within 2 hours for as-soon-as-possible orders. Volume variance compares the tanker&apos;s flow-meter
          reading on the proof of delivery with the gallons ordered; more than 5% short is a penalty for the tanker company and is refunded.
        </p>
      </div>
    </>
  );
}
