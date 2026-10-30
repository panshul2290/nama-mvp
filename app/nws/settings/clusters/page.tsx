"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited } from "@/components/nws/admin/ui";
import { reloadGeo, type Cluster, type Governorate } from "@/components/nws/register/geo";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

// Settings → Clusters (0031): which operating cluster each governorate belongs to. The NWS
// register puts every governorate in exactly one cluster, so a tanker's cluster is its
// governorate's. Admins can move a governorate (audited, with a reason). Cluster and governorate
// names come from the database as they are.

const COLS = ["znGov", "clCluster", "clZones", "clInRegister", "clOnPlatform", "clServed"];

export default function ClustersPage() {
  const { can } = useStaff();
  const admin = can("admin");
  const { ask, dialog } = useAudited();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [govs, setGovs] = useState<Governorate[] | null>(null);
  const [zones, setZones] = useState<Map<string, number>>(new Map());
  const [counts, setCounts] = useState<Map<string, { reg: number; plat: number }>>(new Map());

  const load = useCallback(() => {
    const db = supabase();
    db.from("clusters").select("code, name, sort").order("sort").then(({ data }) => setClusters((data ?? []) as Cluster[]));
    db.from("governorates").select("code, name, cluster_code, nws_served, sort, aliases").order("sort").then(({ data }) => setGovs((data ?? []) as Governorate[]));
    db.from("zones").select("governorate_code").eq("is_test", false).then(({ data }) => {
      const m = new Map<string, number>();
      for (const z of (data ?? []) as { governorate_code: string | null }[]) if (z.governorate_code) m.set(z.governorate_code, (m.get(z.governorate_code) ?? 0) + 1);
      setZones(m);
    });
    // Per-governorate tanker counts from the cluster report (counted in the database).
    db.rpc("report_clusters", { p_days: 1 }).then(({ data }) => {
      const m = new Map<string, { reg: number; plat: number }>();
      for (const g of ((data as { by_governorate?: { code: string; in_register: number; on_platform: number }[] } | null)?.by_governorate ?? [])) m.set(g.code, { reg: g.in_register, plat: g.on_platform });
      setCounts(m);
    });
  }, []);
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const name = (c: string | null) => clusters.find((x) => x.code === c)?.name ?? t("clNone");
  function move(g: Governorate, to: string) {
    ask({
      title: t("clMoveT", { g: g.name }),
      body: t("clMoveB", { from: name(g.cluster_code), to: name(to || null) }),
      confirm: t("clMoveC"),
      ok: t("clMovedOk", { g: g.name, to: name(to || null) }),
      run: (reason) => supabase().rpc("staff_set_governorate_cluster", { p_governorate: g.code, p_cluster: to || null, p_reason: reason }),
      done: () => {
        reloadGeo();
        load();
      },
    });
  }

  return (
    <>
      <PageHead title={t("clTitle")} sub={t("clSub")} />
      {!admin && <ReadOnlyNote who={t("clAdmins")} />}
      <div className="panel">
        <div className="tblwrap">
          <table>
            <thead><tr>{COLS.map((c, i) => <th key={c} className={i >= 2 && i <= 4 ? "num" : undefined}>{t(c)}</th>)}</tr></thead>
            <tbody>
              {!govs && <Empty cols={6}>{t("loading")}</Empty>}
              {govs?.map((g) => (
                <tr key={g.code}>
                  <td><b>{g.name}</b><small style={{ display: "block" }} className="mut" dir="ltr">{g.code}</small></td>
                  <td>
                    <select className="in" aria-label={t("clOf", { g: g.name })} value={g.cluster_code ?? ""} disabled={!admin} onChange={(e) => move(g, e.target.value)} style={{ width: 160 }}>
                      <option value="">{t("clNone")}</option>
                      {clusters.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="num">{f.n(zones.get(g.code) ?? 0)}</td>
                  <td className="num">{f.n(counts.get(g.code)?.reg ?? 0)}</td>
                  <td className="num">{f.n(counts.get(g.code)?.plat ?? 0)}</td>
                  <td>{g.nws_served ? t("yes") : t("clNoOwn")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {dialog}
    </>
  );
}
