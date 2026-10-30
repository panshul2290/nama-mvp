"use client";

import { useEffect, useState } from "react";
import { BarList } from "@/components/nws/admin/charts";
import { downloadCsv, int, Kpi, pct } from "@/components/nws/admin/ui";
import { GeoFilter, useGeo } from "@/components/nws/register/geo";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { ReportState } from "./report";

// Reports → Clusters (report_clusters, 0033): per cluster and governorate, tankers in the NWS
// register and on the platform, permits, tankers online now, and the period's orders (by the
// order's zone → governorate). Counted in the database; test-zone orders excluded.

type Line = {
  in_register: number; on_platform: number; register_on_platform: number; online: number; permitted: number; pending: number;
  placed: number; delivered: number; cancelled: number; on_time: number; timed: number; gallons: number;
};
type Rep = {
  by_governorate: (Line & { code: string; name: string; cluster_code: string | null })[];
  by_cluster: (Line & { cluster_code: string | null; name: string; governorates: number })[];
  unassigned: { on_platform: number; online: number };
  orders_unmapped: number;
};

const T = {
  inRegister: "In NWS register", inRegisterSub: (n: number) => `${int(n)} of them registered on the platform`,
  onPlatform: "Registered on platform", onPlatformSub: (n: number) => `${int(n)} online now`,
  permitted: "Valid permits", permittedSub: (n: number) => `${int(n)} applications in review`,
  delivered: "Trips completed", deliveredSub: (n: number) => `of ${int(n)} orders placed`,
  onTime: "On-time delivery",
  byCluster: "By cluster",
  byGov: "By governorate",
  cols: ["Governorate", "Cluster", "In register", "On platform", "Online", "Valid permits", "In review", "Orders", "Delivered", "On time", "Gallons delivered"],
  unassigned: (t: number, o: number) => `${int(t)} platform tankers have no governorate yet (registered in an app, not matched to the register)${o ? ` — ${int(o)} online now` : ""}.`,
  unmapped: (n: number) => `${int(n)} orders in this period were outside a governorate's zones.`,
  export: "Export CSV",
  barsTitle: "Register tankers registered on the platform",
};

export default function Clusters({ days }: { days: number }) {
  const geo = useGeo();
  const [f, setF] = useState({ cluster: "", governorate: "" });
  const [state, setState] = useState<{ key: string; data: Rep | null; error: string | null } | null>(null);
  const key = `${days}:${f.cluster}:${f.governorate}`;
  useEffect(() => {
    let live = true;
    supabase()
      .rpc("report_clusters", { p_days: days, p_cluster: f.cluster || null, p_governorate: f.governorate || null })
      .then(({ data, error }) => {
        if (live) setState({ key, data: (data as Rep | null) ?? null, error: error ? friendlyError(error) : null });
      });
    return () => {
      live = false;
    };
  }, [days, f.cluster, f.governorate, key]);

  const cur = state?.key === key ? state : null;
  const filters = (
    <div className="rangebar" style={{ paddingTop: 0 }}>
      <div className="filters" style={{ display: "flex", gap: 8 }}>
        <GeoFilter geo={geo} cluster={f.cluster} governorate={f.governorate} onChange={setF} />
      </div>
    </div>
  );
  if (!cur?.data) return <>{filters}<ReportState error={cur?.error ?? null} what="clusters" /></>;
  const r = cur.data;
  const sum = (k: keyof Line) => r.by_cluster.reduce((a, x) => a + Number(x[k] ?? 0), 0);
  const onPct = sum("timed") ? sum("on_time") / sum("timed") : null;

  function exportCsv() {
    downloadCsv("clusters", [
      T.cols,
      ...r.by_governorate.map((g) => [g.name, geo.clusterName(g.cluster_code), g.in_register, g.on_platform, g.online, g.permitted, g.pending, g.placed, g.delivered,
        g.timed ? Math.round((g.on_time / g.timed) * 1000) / 10 : "", g.gallons]),
    ]);
  }

  return (
    <>
      {filters}
      <div className="okpis">
        <Kpi label={T.inRegister} value={int(sum("in_register"))} sub={T.inRegisterSub(sum("register_on_platform"))} />
        <Kpi label={T.onPlatform} value={int(sum("on_platform"))} sub={T.onPlatformSub(sum("online"))} />
        <Kpi label={T.permitted} value={int(sum("permitted"))} sub={T.permittedSub(sum("pending"))} />
        <Kpi label={T.delivered} value={int(sum("delivered"))} sub={T.deliveredSub(sum("placed"))} />
        <Kpi label={T.onTime} value={onPct == null ? "—" : pct(onPct)} sub="delivered by the slot end, or within 2 h" tone={onPct == null ? undefined : onPct >= 0.9 ? "ok" : "warn"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <div className="panel">
          <h2>{T.byCluster}</h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Cluster</th><th className="num">Governorates</th><th className="num">In register</th><th className="num">On platform</th><th className="num">Valid permits</th><th className="num">Delivered</th><th className="num">On time</th></tr></thead>
              <tbody>
                {r.by_cluster.map((c) => (
                  <tr key={c.cluster_code ?? "none"} className="click" onClick={() => setF({ cluster: c.cluster_code ?? "none", governorate: "" })}>
                    <td><b>{c.name}</b></td>
                    <td className="num">{c.governorates}</td>
                    <td className="num">{int(c.in_register)}</td>
                    <td className="num">{int(c.on_platform)}</td>
                    <td className="num">{int(c.permitted)}</td>
                    <td className="num">{int(c.delivered)}</td>
                    <td className="num">{c.timed ? pct(c.on_time / c.timed) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>{T.barsTitle}</h2>
          <BarList rows={r.by_cluster.map((c) => ({ label: c.name, value: c.in_register ? Math.round((c.register_on_platform / c.in_register) * 1000) / 10 : 0, key: c.cluster_code ?? "none" }))} max={100} fmt={(v) => `${v}%`} />
        </div>
      </div>

      <div className="panel">
        <div className="toolbar">
          <h2 style={{ margin: 0, padding: 0, border: 0 }}>{T.byGov}</h2>
          <button className="btn sm" onClick={exportCsv}>{T.export}</button>
        </div>
        <div className="tblwrap">
          <table>
            <thead><tr>{T.cols.map((c, i) => <th key={c} className={i > 1 ? "num" : undefined}>{c}</th>)}</tr></thead>
            <tbody>
              {r.by_governorate.map((g) => (
                <tr key={g.code} className="click" onClick={() => setF({ cluster: f.cluster, governorate: g.code })}>
                  <td><b>{g.name}</b></td>
                  <td>{geo.clusterName(g.cluster_code)}</td>
                  <td className="num">{int(g.in_register)}</td>
                  <td className="num">{int(g.on_platform)}</td>
                  <td className="num">{int(g.online)}</td>
                  <td className="num">{int(g.permitted)}</td>
                  <td className="num">{int(g.pending)}</td>
                  <td className="num">{int(g.placed)}</td>
                  <td className="num">{int(g.delivered)}</td>
                  <td className="num">{g.timed ? pct(g.on_time / g.timed) : "—"}</td>
                  <td className="num">{int(g.gallons)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(r.unassigned.on_platform > 0 || r.orders_unmapped > 0) && (
          <p className="note">
            {r.unassigned.on_platform > 0 && T.unassigned(r.unassigned.on_platform, r.unassigned.online)} {r.orders_unmapped > 0 && T.unmapped(r.orders_unmapped)}
          </p>
        )}
      </div>
    </>
  );
}
