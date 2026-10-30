"use client";

// NWS → Permits → Register: every tanker — on the platform and in the NWS register (~11,000) —
// with its governorate, cluster, owner and current permit. Filtered and paged in the database
// (staff_register_tankers); owner numbers are masked unless the viewer is privileged (0027).
import { useCallback, useEffect, useState } from "react";
import { REG } from "@/components/nws/i18n/register";
import { DAY, downloadCsv, Kpi, St, SERVICE_NAME, useNow } from "@/components/nws/ops";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { issuesTable, type Issue } from "@/lib/importRegister";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey } from "@/lib/time";
import { cleanFilter, fetchAllRegister, fetchRegister, STAGE_LABEL, type RegFilter, type RegPage, type RegRow } from "./data";
import { GeoFilter, type Geo } from "./geo";
import { ImportRegister } from "./ImportRegister";

const PAGE = 100;

// Filter options: values with their dictionary keys (REG, components/nws/i18n/register).
const SOURCES = ["all", "platform", "register", "register_only"] as const;
const PERMITS = [["", "perm.any"], ["valid", "perm.valid"], ["expiring", "perm.expiring"], ["blocked", "perm.blocked"], ["expired", "perm.expired"], ["pending", "perm.pending"], ["none", "perm.none"]] as const;
const SERVICES = ["", "DW", "WW", "TE"] as const;
const COLS = ["colTanker", "colType", "governorate", "colOwner", "colOnPlatform", "colPermitNo", "colValidUntil", "status", "colEffect", ""];

type Batch = { id: string; file_name: string; source: string; status: string; total_rows: number; counts: Record<string, number>; chunks: number; created_at: string; finished_at: string | null };

export function RegisterPanel({ geo, canImport, onOpen, onTotal }: { geo: Geo; canImport: boolean; onOpen: (permitId: string) => void; onTotal?: (n: number) => void }) {
  const now = useNow(60_000);
  const t = useT(REG);
  const f = useFmt();
  const { lang } = useLang();
  const [filter, setFilter] = useState<RegFilter>({ source: "all", cluster: "", governorate: "", service: "", permit: "", q: "" });
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ key: string; page: RegPage | null; error: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [tick, setTick] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilter((f) => (f.q === q ? f : { ...f, q }));
      setPage(0);
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  const key = `${JSON.stringify(cleanFilter(filter))}:${page}:${tick}`;
  useEffect(() => {
    let live = true;
    fetchRegister(filter, PAGE, page * PAGE, lang).then(({ data: p, error }) => {
      if (!live) return;
      setData({ key, page: p, error });
      if (p && onTotal && !cleanFilter(filter).q && Object.keys(cleanFilter(filter)).length === 0) onTotal(p.total);
    });
    return () => {
      live = false;
    };
  }, [filter, page, key, onTotal, lang]);

  const loadBatches = useCallback(() => {
    supabase().from("import_batches").select("id, file_name, source, status, total_rows, counts, chunks, created_at, finished_at").order("created_at", { ascending: false }).limit(10)
      .then(({ data: b }) => setBatches((b ?? []) as Batch[]));
  }, []);
  useEffect(() => {
    const t = setTimeout(loadBatches, 0);
    return () => clearTimeout(t);
  }, [loadBatches, tick]);

  const cur = data?.key === key ? data : null;
  const p = cur?.page ?? null;
  const set = (patch: Partial<RegFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  async function exportCsv() {
    setExporting(t("exporting", { n: f.n(0), total: f.n(p?.total ?? 0) }));
    const all = await fetchAllRegister(filter, 20000, (n, tot) => setExporting(t("exporting", { n: f.n(n), total: f.n(tot) })), lang);
    setExporting(null);
    downloadCsv(`tanker-register-${omanDateKey(new Date())}`, [
      ["Plate", "Service", "Governorate", "Cluster", "Owner", "Owner mobile", "Company", "On platform", "In NWS register", "Capacity (gal)", "Register permit status",
        "Permit no.", "Permit valid until", "Permit valid", "Application", "Application stage", "Campaign stage"],
      ...all.rows.map((r) => [
        r.plate, r.service_type, geo.govName(r.governorate), geo.clusterName(r.cluster), r.owner_name ?? "", r.phone ?? "", r.company ?? "",
        r.on_platform ? "yes" : "no", r.in_register ? "yes" : "no", r.capacity_known ? r.capacity_gal : "unknown", r.register_permit_status ?? "",
        r.permit_no ?? "", r.permit_expires ? omanDateKey(r.permit_expires) : "", r.permit_valid ? "yes" : "no", r.pending_no ?? "", r.pending_stage ?? "", STAGE_LABEL[r.stage],
      ]),
    ]);
  }

  async function report(b: Batch) {
    const { data: row } = await supabase().from("import_batches").select("errors").eq("id", b.id).maybeSingle<{ errors: Issue[] }>();
    downloadCsv(`register-import-report-${omanDateKey(b.created_at)}`, issuesTable(row?.errors ?? []));
  }

  const state = (r: RegRow): [string, string] => {
    if (r.permit_valid) return r.permit_expires && Date.parse(r.permit_expires) - now < 30 * DAY ? [t("expiring"), "warn"] : [t("validL"), "ok"];
    if (r.permit_id) return [t("expiredL"), "bad"];
    return [t("noPermit"), "bad"];
  };

  const k = p?.kpis;
  const from = p && p.total ? page * PAGE + 1 : 0;
  const to = p ? Math.min((page + 1) * PAGE, p.total) : 0;
  return (
    <>
      <div className="okpis">
        <Kpi label={t("kValid")} value={k ? f.n(k.valid) : "…"} sub={t("kValidSub")} tone="ok" />
        <Kpi label={t("kExp")} value={k ? f.n(k.expiring_30) : "…"} sub={t("kExpSub")} tone={k?.expiring_30 ? "warn" : ""} />
        <Kpi label={t("kBlocked")} value={k ? f.n(k.blocked) : "…"} sub={t("kBlockedSub")} tone="bad" />
        <Kpi label={t("kPending")} value={k ? f.n(k.pending) : "…"} sub={t("kPendingSub")} />
        <Kpi label={t("kPlatform")} value={k ? f.n(k.on_platform) : "…"} sub={k ? t("kPlatformSub", { n: f.n(k.register_only) }) : ""} />
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="filters" style={{ flexWrap: "wrap" }}>
            <select className="in" aria-label={t("source")} value={filter.source} onChange={(e) => set({ source: e.target.value as RegFilter["source"] })} style={{ width: 230 }}>
              {SOURCES.map((v) => <option key={v} value={v}>{t(`src.${v}`)}</option>)}
            </select>
            <GeoFilter geo={geo} cluster={filter.cluster ?? ""} governorate={filter.governorate ?? ""} onChange={(g) => set(g)} />
            <select className="in" aria-label={t("serviceType")} value={filter.service} onChange={(e) => set({ service: e.target.value as RegFilter["service"] })} style={{ width: 150 }}>
              {SERVICES.map((v) => <option key={v} value={v}>{v ? label("svc", v, lang) : t("allTypes")}</option>)}
            </select>
            <select className="in" aria-label={t("permitState")} value={filter.permit} onChange={(e) => set({ permit: e.target.value as RegFilter["permit"] })} style={{ width: 190 }}>
              {PERMITS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
            </select>
            <input className="in" placeholder={t("searchPh")} aria-label={t("searchPh")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 170 }} />
          </div>
          <div className="btns">
            <button className="btn sm" disabled={!p?.total || !!exporting} onClick={exportCsv}>{exporting ?? t("exportCsv")}</button>
            <button className="btn pri sm" disabled={!canImport} title={canImport ? undefined : t("importTitle")} onClick={() => setImporting(true)}>{t("importBtn")}</button>
          </div>
        </div>
        {cur?.error && <div className="banner badb" role="alert">{cur.error}</div>}
        <div className="tblwrap" style={{ maxHeight: 560, overflowY: "auto" }}>
          <table>
            <thead><tr>{COLS.map((c, i) => <th key={i}>{c ? t(c) : ""}</th>)}</tr></thead>
            <tbody>
              {!cur && <tr><td colSpan={10} className="empty">{t("loading")}</td></tr>}
              {p && p.rows.length === 0 && <tr><td colSpan={10} className="empty">{t("noMatch")}</td></tr>}
              {p?.rows.map((r) => {
                const [s, tone] = state(r);
                return (
                  <tr key={r.tanker_id}>
                    <td className={`stripe ${r.service_type}`} style={{ whiteSpace: "nowrap" }}>
                      <b dir="ltr">{r.plate}</b>
                      <small style={{ display: "block" }}>{r.capacity_known ? f.gal(r.capacity_gal) : t("capUnknown")}</small>
                    </td>
                    <td><span className={`tag ${r.service_type}`}>{label("svc", r.service_type, lang, SERVICE_NAME[r.service_type as ServiceType])}</span></td>
                    <td>
                      {geo.govName(r.governorate)}
                      <small style={{ display: "block" }}>{r.governorate ? geo.clusterName(r.cluster) : ""}</small>
                    </td>
                    <td>
                      {r.company ?? r.owner_name ?? <span className="mut">{r.on_platform ? t("independent") : t("noOwner")}</span>}
                      {r.owner_name && (
                        <small style={{ display: "block" }} dir="ltr">{[r.company ? r.owner_name : null, r.phone, r.claimed ? t("claimed") : null].filter(Boolean).join(" · ")}</small>
                      )}
                    </td>
                    <td>{r.on_platform ? <St tone="ok">{t("onPlatform")}</St> : <St>{t("registerOnly")}</St>}</td>
                    <td style={{ whiteSpace: "nowrap" }} dir="ltr">{r.permit_no ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.permit_expires ? f.date(r.permit_expires) : "—"}</td>
                    <td>
                      <St tone={tone}>{s}</St>
                      {r.pending_no && <small style={{ display: "block" }}>{t("inReview", { no: r.pending_no })}</small>}
                    </td>
                    <td>{!r.on_platform ? <span className="mut">{t("noDriver")}</span> : r.permit_valid ? t("canWork") : <span style={{ color: "var(--bad)" }}>{t("blockedWork")}</span>}</td>
                    <td>
                      {(r.pending_id || r.permit_id) && (
                        <button className="btn sm" onClick={() => onOpen((r.pending_id ?? r.permit_id)!)}>{r.pending_id ? t("reviewApp") : t("viewPermit")}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p && p.total > 0 && (
          <div className="regpager">
            <span>{t("pager", { a: f.n(from), b: f.n(to), n: f.n(p.total) })}</span>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>{t("prev")}</button>
            <button className="btn sm" disabled={to >= p.total} onClick={() => setPage((x) => x + 1)}>{t("next")}</button>
          </div>
        )}
        <p className="note">{t("regNote")}</p>
      </div>

      <div className="panel">
        <h2>{t("imports")} <small>{t("importsSub")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("colFile")}</th><th>{t("colStarted")}</th><th>{t("status")}</th><th className="num">{t("colRows")}</th><th className="num">{t("colCreated")}</th><th className="num">{t("colUpdated")}</th><th className="num">{t("colIssues")}</th><th></th></tr></thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={8} className="empty">{t("noImports")}</td></tr>}
              {batches.map((b) => (
                <tr key={b.id}>
                  <td><bdi dir="ltr">{b.file_name}</bdi><small style={{ display: "block" }}>{b.source === "script" ? t("importScript") : t("uploadL")}</small></td>
                  <td>{f.dateTime(b.created_at)}</td>
                  <td><St tone={b.status === "completed" ? "ok" : b.status === "running" ? "act" : "bad"}>{REG[`batch.${b.status}`] ? t(`batch.${b.status}`) : b.status}</St></td>
                  <td className="num">{f.n(b.total_rows)}</td>
                  <td className="num">{f.n(b.counts.tankers_created ?? 0)}</td>
                  <td className="num">{f.n(b.counts.tankers_updated ?? 0)}</td>
                  <td className="num">{f.n((b.counts.warnings ?? 0) + (b.counts.errors ?? 0))}</td>
                  <td><button className="btn sm" onClick={() => report(b)}>{t("errReport")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {importing && <ImportRegister geo={geo} onClose={() => setImporting(false)} onImported={() => setTick((n) => n + 1)} />}
    </>
  );
}
