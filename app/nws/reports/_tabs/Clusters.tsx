"use client";

import { useEffect, useState } from "react";
import { BarList } from "@/components/nws/admin/charts";
import { downloadCsv, Kpi } from "@/components/nws/admin/ui";
import { REPORTS } from "@/components/nws/i18n/reports";
import { GeoFilter, useGeo } from "@/components/nws/register/geo";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
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

// CSV export header (exports keep English); the table shows COL_KEYS in the portal language.
const CSV_COLS = ["Governorate", "Cluster", "In register", "On platform", "Online", "Valid permits", "In review", "Orders", "Delivered", "On time", "Gallons delivered"];
const COL_KEYS = ["thGovernorate", "thCluster", "thInRegister", "thOnPlatform", "thOnline", "thValidPermits", "thInReview", "thOrders", "thDelivered", "thOnTime", "thGalDelivered"];

export default function Clusters({ days }: { days: number }) {
  const geo = useGeo();
  const t = useT(REPORTS);
  const fm = useFmt();
  const { lang } = useLang();
  const [f, setF] = useState({ cluster: "", governorate: "" });
  const [state, setState] = useState<{ key: string; data: Rep | null; error: { message?: string } | null } | null>(null);
  const key = `${days}:${f.cluster}:${f.governorate}`;
  useEffect(() => {
    let live = true;
    supabase()
      .rpc("report_clusters", { p_days: days, p_cluster: f.cluster || null, p_governorate: f.governorate || null })
      .then(({ data, error }) => {
        if (live) setState({ key, data: (data as Rep | null) ?? null, error: error ?? null });
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
  if (!cur?.data) return <>{filters}<ReportState error={cur?.error ? friendlyError(cur.error, lang) : null} what={t("whatClu")} /></>;
  const r = cur.data;
  const sum = (k: keyof Line) => r.by_cluster.reduce((a, x) => a + Number(x[k] ?? 0), 0);
  const onPct = sum("timed") ? sum("on_time") / sum("timed") : null;

  function exportCsv() {
    downloadCsv("clusters", [
      CSV_COLS,
      ...r.by_governorate.map((g) => [g.name, geo.clusterName(g.cluster_code), g.in_register, g.on_platform, g.online, g.permitted, g.pending, g.placed, g.delivered,
        g.timed ? Math.round((g.on_time / g.timed) * 1000) / 10 : "", g.gallons]),
    ]);
  }

  return (
    <>
      {filters}
      <div className="okpis">
        <Kpi label={t("inRegister")} value={fm.n(sum("in_register"))} sub={t("inRegisterSub", { n: fm.n(sum("register_on_platform")) })} />
        <Kpi label={t("onPlatform")} value={fm.n(sum("on_platform"))} sub={t("onlineNow", { n: fm.n(sum("online")) })} />
        <Kpi label={t("permitted")} value={fm.n(sum("permitted"))} sub={t("permittedSub", { n: fm.n(sum("pending")) })} />
        <Kpi label={t("tripsCompleted")} value={fm.n(sum("delivered"))} sub={t("ofPlaced", { n: fm.n(sum("placed")) })} />
        <Kpi label={t("onTimeDelivery")} value={onPct == null ? "—" : fm.pct(onPct)} sub={t("slotOrTwoH")} tone={onPct == null ? undefined : onPct >= 0.9 ? "ok" : "warn"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <div className="panel">
          <h2>{t("byCluster")}</h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("thCluster")}</th><th className="num">{t("thGovernorates")}</th><th className="num">{t("thInRegister")}</th><th className="num">{t("thOnPlatform")}</th><th className="num">{t("thValidPermits")}</th><th className="num">{t("thDelivered")}</th><th className="num">{t("thOnTime")}</th></tr></thead>
              <tbody>
                {r.by_cluster.map((c) => (
                  <tr key={c.cluster_code ?? "none"} className="click" onClick={() => setF({ cluster: c.cluster_code ?? "none", governorate: "" })}>
                    <td><b>{c.name}</b></td>
                    <td className="num">{fm.n(c.governorates)}</td>
                    <td className="num">{fm.n(c.in_register)}</td>
                    <td className="num">{fm.n(c.on_platform)}</td>
                    <td className="num">{fm.n(c.permitted)}</td>
                    <td className="num">{fm.n(c.delivered)}</td>
                    <td className="num">{c.timed ? fm.pct(c.on_time / c.timed) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>{t("barsTitle")}</h2>
          <BarList rows={r.by_cluster.map((c) => ({ label: c.name, value: c.in_register ? Math.round((c.register_on_platform / c.in_register) * 1000) / 10 : 0, key: c.cluster_code ?? "none" }))} max={100} fmt={(v) => fm.pct(v / 100)} />
        </div>
      </div>

      <div className="panel">
        <div className="toolbar">
          <h2 style={{ margin: 0, padding: 0, border: 0 }}>{t("byGov")}</h2>
          <button className="btn sm" onClick={exportCsv}>{t("exportCsv")}</button>
        </div>
        <div className="tblwrap">
          <table>
            <thead><tr>{COL_KEYS.map((c, i) => <th key={c} className={i > 1 ? "num" : undefined}>{t(c)}</th>)}</tr></thead>
            <tbody>
              {r.by_governorate.map((g) => (
                <tr key={g.code} className="click" onClick={() => setF({ cluster: f.cluster, governorate: g.code })}>
                  <td><b>{g.name}</b></td>
                  <td>{geo.clusterName(g.cluster_code)}</td>
                  <td className="num">{fm.n(g.in_register)}</td>
                  <td className="num">{fm.n(g.on_platform)}</td>
                  <td className="num">{fm.n(g.online)}</td>
                  <td className="num">{fm.n(g.permitted)}</td>
                  <td className="num">{fm.n(g.pending)}</td>
                  <td className="num">{fm.n(g.placed)}</td>
                  <td className="num">{fm.n(g.delivered)}</td>
                  <td className="num">{g.timed ? fm.pct(g.on_time / g.timed) : "—"}</td>
                  <td className="num">{fm.n(g.gallons)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(r.unassigned.on_platform > 0 || r.orders_unmapped > 0) && (
          <p className="note">
            {r.unassigned.on_platform > 0 && `${t("unassigned", { n: fm.n(r.unassigned.on_platform) })}${r.unassigned.online ? t("unassignedOnline", { n: fm.n(r.unassigned.online) }) : ""}.`}{" "}
            {r.orders_unmapped > 0 && t("unmapped", { n: fm.n(r.orders_unmapped) })}
          </p>
        )}
      </div>
    </>
  );
}
