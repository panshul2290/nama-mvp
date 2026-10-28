"use client";

import { useCallback, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { dueBy } from "@/components/business/data";
import { Kpis, useLive } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";

type Row = { id: string; property_id: string | null; gallons: number; slot_end: string | null; created_at: string; delivered_at: string | null };
type Pod = { order_id: string; meter_gal: number };
type Stat = { label: string; n: number; onTime: number; lateMin: number[]; ordered: number; metered: number; withPod: number };

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

  const load = useCallback(async () => {
    const db = supabase();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [o, p, c] = await Promise.all([
      db.from("orders").select("id, property_id, gallons, slot_end, created_at, delivered_at").eq("org_id", org.id).eq("status", "delivered").gte("delivered_at", since).limit(2000),
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
      db.from("complaints").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString()),
    ]);
    const orders = (o.data ?? []) as Row[];
    const sites = (p.data ?? []) as BizProperty[];
    const pods: Pod[] = [];
    for (let i = 0; i < orders.length; i += 200) {
      const { data } = await db.from("pods").select("order_id, meter_gal").in("order_id", orders.slice(i, i + 200).map((x) => x.id));
      pods.push(...((data ?? []) as Pod[]));
    }
    const podOf = new Map(pods.map((x) => [x.order_id, x.meter_gal]));
    const by = new Map<string, Stat>();
    for (const s of sites) by.set(s.id, { label: s.label, n: 0, onTime: 0, lateMin: [], ordered: 0, metered: 0, withPod: 0 });
    for (const r of orders) {
      const key = r.property_id && by.has(r.property_id) ? r.property_id : "other";
      if (!by.has(key)) by.set(key, { label: "Other / removed sites", n: 0, onTime: 0, lateMin: [], ordered: 0, metered: 0, withPod: 0 });
      const s = by.get(key)!;
      s.n += 1;
      const late = Date.parse(r.delivered_at!) - dueBy(r);
      if (late <= 0) s.onTime += 1;
      else s.lateMin.push(late / 60_000);
      const m = podOf.get(r.id);
      if (m != null) {
        s.withPod += 1;
        s.ordered += r.gallons;
        s.metered += m;
      }
    }
    setStats([...by.values()]);
    setComplaints(c.count ?? 0);
    setLoaded(true);
  }, [org.id, days]);

  useLive(`biz-sla-${days}`, ["orders"], load, 120_000);

  const total = stats.reduce((a, s) => a + s.n, 0);
  const onTime = stats.reduce((a, s) => a + s.onTime, 0);
  const late = stats.flatMap((s) => s.lateMin);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
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
      <Kpis
        items={[
          { label: "Delivered within window", value: total ? `${((onTime / total) * 100).toFixed(1)}%` : "—", sub: `${total} deliveries`, tone: total && onTime / total < 0.9 ? "warn" : "ok" },
          { label: "Average delay when late", value: late.length ? `${avg(late)} min` : "—", sub: `${late.length} late deliveries` },
          { label: "Volume variance", value: fmtVar(variance(all)), sub: "Flow meter vs ordered gallons" },
          { label: "Complaints this quarter", value: complaints },
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
                      <td className="num">{s.lateMin.length ? `${avg(s.lateMin)} min` : s.n ? "0 min" : "—"}</td>
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
          On time = delivered before the end of the booked window (or within 2 hours for as-soon-as-possible orders). Volume variance compares the tanker&apos;s flow-meter
          reading on the proof of delivery with the gallons ordered; more than 5% short is a penalty for the tanker company and is refunded.
        </p>
      </div>
    </>
  );
}
