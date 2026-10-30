"use client";

// Clusters and governorates (0031) for the NWS screens: names, the cluster of a governorate,
// and the cluster / governorate filter used on Fleet, Permits and Reports.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export type Cluster = { code: string; name: string; sort: number };
export type Governorate = { code: string; name: string; cluster_code: string | null; nws_served: boolean; sort: number; aliases: string[] };

export const GEO_T = {
  allClusters: "All clusters",
  noCluster: "No cluster",
  allGovernorates: "All governorates",
  cluster: "Cluster",
  governorate: "Governorate",
  unknownGov: "—",
};

export type Geo = {
  clusters: Cluster[];
  governorates: Governorate[];
  govName: (code: string | null | undefined) => string;
  clusterName: (code: string | null | undefined) => string;
  clusterOf: (gov: string | null | undefined) => string | null;
};

let cache: Promise<{ clusters: Cluster[]; governorates: Governorate[] }> | null = null;
function loadGeo() {
  cache ??= Promise.all([
    supabase().from("clusters").select("code, name, sort").order("sort"),
    supabase().from("governorates").select("code, name, cluster_code, nws_served, sort, aliases").order("sort"),
  ]).then(([c, g]) => {
    if (c.error || g.error) cache = null; // retry next time
    return { clusters: (c.data ?? []) as Cluster[], governorates: (g.data ?? []) as Governorate[] };
  });
  return cache;
}
/** Forget the cached names (after an admin moves a governorate to another cluster). */
export const reloadGeo = () => {
  cache = null;
};

export function useGeo(version = 0): Geo {
  const [data, setData] = useState<{ clusters: Cluster[]; governorates: Governorate[] }>({ clusters: [], governorates: [] });
  useEffect(() => {
    let live = true;
    loadGeo().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [version]);
  return useMemo(() => {
    const gov = new Map(data.governorates.map((g) => [g.code, g]));
    const cl = new Map(data.clusters.map((c) => [c.code, c]));
    return {
      ...data,
      govName: (code) => (code ? (gov.get(code)?.name ?? code) : GEO_T.unknownGov),
      clusterName: (code) => (code ? (cl.get(code)?.name ?? code) : GEO_T.noCluster),
      clusterOf: (code) => (code ? (gov.get(code)?.cluster_code ?? null) : null),
    };
  }, [data]);
}

/** Cluster and governorate selects; choosing a cluster narrows the governorates. */
export function GeoFilter({
  geo, cluster, governorate, onChange, served = true,
}: {
  geo: Geo;
  cluster: string;
  governorate: string;
  onChange: (v: { cluster: string; governorate: string }) => void;
  /** Only governorates NWS serves. */
  served?: boolean;
}) {
  const govs = geo.governorates.filter((g) => (!served || g.nws_served) && (!cluster || (cluster === "none" ? !g.cluster_code : g.cluster_code === cluster)));
  return (
    <>
      <select className="in" aria-label={GEO_T.cluster} value={cluster} onChange={(e) => onChange({ cluster: e.target.value, governorate: "" })} style={{ width: 150 }}>
        <option value="">{GEO_T.allClusters}</option>
        {geo.clusters.map((c) => (
          <option key={c.code} value={c.code}>{c.name}</option>
        ))}
        <option value="none">{GEO_T.noCluster}</option>
      </select>
      <select className="in" aria-label={GEO_T.governorate} value={governorate} onChange={(e) => onChange({ cluster, governorate: e.target.value })} style={{ width: 180 }}>
        <option value="">{GEO_T.allGovernorates}</option>
        {govs.map((g) => (
          <option key={g.code} value={g.code}>{g.name}</option>
        ))}
      </select>
    </>
  );
}
