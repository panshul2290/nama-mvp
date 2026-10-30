"use client";

import { useCallback, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { useFmt } from "@/components/portal/i18n";
import { Kpis, useLive } from "@/components/portal/kit";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

// Aggregated in the database with the shared SLA rule (org_sla_summary, 0026/0027): no row cap,
// and members limited to some sites see only those.
type Summary = { property_id: string | null; label: string; deliveries: number; on_time: number; late: number; late_minutes_avg: number | null; ordered_gal: number; metered_gal: number; with_pod: number };
type Stat = { label: string; n: number; onTime: number; late: number; lateAvg: number | null; ordered: number; metered: number };

// Period chips: [days, dictionary key]. The "other sites" row keeps an English internal label.
const PERIODS = [
  [30, "p30"],
  [90, "p90"],
  [365, "p365"],
] as const;
const OTHER = "Other / removed sites";

export default function ServiceLevels() {
  const { org } = useBiz();
  const [days, setDays] = useState<number>(90);
  const [stats, setStats] = useState<Stat[]>([]);
  const [complaints, setComplaints] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT(BIZ);
  const f = useFmt();

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
      const s = by.get(key) ?? { label: OTHER, n: 0, onTime: 0, late: 0, lateAvg: null, ordered: 0, metered: 0 };
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
  const fmtVar = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${f.pct(Math.abs(v) / 100)}`);
  const period = (k: string) => (f.lang === "en" ? t(k).toLowerCase() : t(k));
  const all = stats.reduce((a, s) => ({ ordered: a.ordered + s.ordered, metered: a.metered + s.metered }), { ordered: 0, metered: 0 });

  return (
    <>
      <div className="chips" style={{ marginBottom: 16 }}>
        {PERIODS.map(([d, label]) => (
          <button key={d} className={`chip ${days === d ? "on" : ""}`} onClick={() => setDays(d)}>
            {t(label)}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner badb" role="alert">
          {t("errSla", { error })}
        </div>
      )}
      <Kpis
        items={[
          { label: t("kWithinWindow"), value: total ? f.pct(onTime / total) : "—", sub: t("nDeliveries", { n: f.n(total) }), tone: total && onTime / total < 0.9 ? "warn" : "ok" },
          { label: t("kAvgDelay"), value: lateAvg != null ? t("minN", { n: f.n(lateAvg) }) : "—", sub: t("nLate", { n: f.n(lateN) }) },
          { label: t("kVolVar"), value: fmtVar(variance(all)), sub: t("kVolVarSub") },
          { label: t("kComplaints"), value: f.n(complaints), sub: period(PERIODS.find((p) => p[0] === days)?.[1] ?? "p90") },
        ]}
      />
      <div className="panel">
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("hSite")}</th>
                <th className="num">{t("hDeliveries")}</th>
                <th className="num">{t("hOnTime")}</th>
                <th className="num">{t("hAvgDelay")}</th>
                <th className="num">{t("kVolVar")}</th>
              </tr>
            </thead>
            <tbody>
              {stats
                .filter((s) => s.n > 0 || s.label !== OTHER)
                .map((s) => {
                  const v = variance(s);
                  return (
                    <tr key={s.label}>
                      <td>{s.label === OTHER ? t("otherSites") : s.label}</td>
                      <td className="num">{f.n(s.n)}</td>
                      <td className="num">{s.n ? f.pct(s.onTime / s.n) : "—"}</td>
                      <td className="num">{s.lateAvg != null ? t("minN", { n: f.n(Math.round(s.lateAvg)) }) : s.n ? t("minN", { n: f.n(0) }) : "—"}</td>
                      <td className={`num ${v != null && v < -5 ? "badt" : ""}`}>{fmtVar(v)}</td>
                    </tr>
                  );
                })}
              {loaded && !stats.length && (
                <tr>
                  <td className="empty" colSpan={5}>
                    {t("noDelPeriod")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">{t("slaNote")}</p>
      </div>
    </>
  );
}
