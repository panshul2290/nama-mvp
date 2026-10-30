"use client";

// NWS → Permits → Register: every tanker — on the platform and in the NWS register (~11,000) —
// with its governorate, cluster, owner and current permit. Filtered and paged in the database
// (staff_register_tankers); owner numbers are masked unless the viewer is privileged (0027).
import { useCallback, useEffect, useState } from "react";
import { DAY, downloadCsv, Kpi, St, SERVICE_NAME, useNow } from "@/components/nws/ops";
import { fmtDate, fmtDateTime } from "@/components/nws/StaffContext";
import { issuesTable, type Issue } from "@/lib/importRegister";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey } from "@/lib/time";
import { cleanFilter, fetchAllRegister, fetchRegister, STAGE_LABEL, type RegFilter, type RegPage, type RegRow } from "./data";
import { GeoFilter, type Geo } from "./geo";
import { ImportRegister } from "./ImportRegister";

const PAGE = 100;

const T = {
  kValid: "Valid permits", kValidSub: "can take jobs and fill",
  kExp: "Expiring in 30 days", kExpSub: "owners get reminders",
  kBlocked: "No valid permit", kBlockedSub: "blocked from jobs and filling",
  kPending: "Applications in review", kPendingSub: "new permits and renewals",
  kPlatform: "Registered on platform", kPlatformSub: (n: number) => `${n.toLocaleString()} in the NWS register only`,
  sources: [["all", "All tankers"], ["platform", "On the platform"], ["register", "In NWS register"], ["register_only", "Register only (not on platform)"]] as const,
  permits: [["", "Any permit state"], ["valid", "Valid"], ["expiring", "Expiring in 30 days"], ["blocked", "No valid permit"], ["expired", "Expired"], ["pending", "Application in review"], ["none", "No permit on file"]] as const,
  services: [["", "All types"], ["DW", "Drinking water"], ["WW", "Wastewater"], ["TE", "Treated effluent"]] as const,
  search: "Plate or owner",
  import: "Import register",
  importTitle: "Permit officers and admins",
  export: "Export CSV",
  exporting: (n: number, t: number) => `Exporting ${n.toLocaleString()} / ${t.toLocaleString()}…`,
  none: "No tankers match.",
  loading: "Loading…",
  pager: (a: number, b: number, n: number) => `${a.toLocaleString()}–${b.toLocaleString()} of ${n.toLocaleString()}`,
  prev: "Previous", next: "Next",
  cols: ["Tanker", "Type", "Governorate", "Owner", "On platform", "Permit no.", "Valid until", "Status", "Effect on this platform", ""],
  onPlatform: "On platform", registerOnly: "Register only", capUnknown: "capacity unknown",
  independent: "Independent", noOwner: "No owner on file", claimed: "claimed",
  noPermit: "No permit", wrongType: "Expired", expiring: "Expiring", valid: "Valid", expired: "Expired",
  inReview: (no: string) => `${no} in review`,
  canWork: "Can take jobs and fill", blocked: "Blocked from jobs and filling", noDriver: "Not on the platform — no driver",
  review: "Review application", view: "View permit",
  note: "The platform enforces the register: a tanker without a valid permit for its service type can’t accept jobs or go online, and NWS stations refuse to fill it. Register-only tankers stay offline until their owner signs up with the same mobile number.",
  imports: "Imports", importsSub: "the latest register imports and their error reports",
  noImports: "No imports yet.",
  report: "Error report",
  status: { running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped" } as Record<string, string>,
};

type Batch = { id: string; file_name: string; source: string; status: string; total_rows: number; counts: Record<string, number>; chunks: number; created_at: string; finished_at: string | null };

export function RegisterPanel({ geo, canImport, onOpen, onTotal }: { geo: Geo; canImport: boolean; onOpen: (permitId: string) => void; onTotal?: (n: number) => void }) {
  const now = useNow(60_000);
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
    fetchRegister(filter, PAGE, page * PAGE).then(({ data: p, error }) => {
      if (!live) return;
      setData({ key, page: p, error });
      if (p && onTotal && !cleanFilter(filter).q && Object.keys(cleanFilter(filter)).length === 0) onTotal(p.total);
    });
    return () => {
      live = false;
    };
  }, [filter, page, key, onTotal]);

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
    setExporting(T.exporting(0, p?.total ?? 0));
    const all = await fetchAllRegister(filter, 20000, (n, t) => setExporting(T.exporting(n, t)));
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
    if (r.permit_valid) return r.permit_expires && Date.parse(r.permit_expires) - now < 30 * DAY ? [T.expiring, "warn"] : [T.valid, "ok"];
    if (r.permit_id) return [T.expired, "bad"];
    return [T.noPermit, "bad"];
  };

  const k = p?.kpis;
  const from = p && p.total ? page * PAGE + 1 : 0;
  const to = p ? Math.min((page + 1) * PAGE, p.total) : 0;
  return (
    <>
      <div className="okpis">
        <Kpi label={T.kValid} value={k ? k.valid.toLocaleString() : "…"} sub={T.kValidSub} tone="ok" />
        <Kpi label={T.kExp} value={k ? k.expiring_30.toLocaleString() : "…"} sub={T.kExpSub} tone={k?.expiring_30 ? "warn" : ""} />
        <Kpi label={T.kBlocked} value={k ? k.blocked.toLocaleString() : "…"} sub={T.kBlockedSub} tone="bad" />
        <Kpi label={T.kPending} value={k ? k.pending.toLocaleString() : "…"} sub={T.kPendingSub} />
        <Kpi label={T.kPlatform} value={k ? k.on_platform.toLocaleString() : "…"} sub={k ? T.kPlatformSub(k.register_only) : ""} />
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="filters" style={{ flexWrap: "wrap" }}>
            <select className="in" aria-label="Source" value={filter.source} onChange={(e) => set({ source: e.target.value as RegFilter["source"] })} style={{ width: 230 }}>
              {T.sources.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <GeoFilter geo={geo} cluster={filter.cluster ?? ""} governorate={filter.governorate ?? ""} onChange={(g) => set(g)} />
            <select className="in" aria-label="Service type" value={filter.service} onChange={(e) => set({ service: e.target.value as RegFilter["service"] })} style={{ width: 150 }}>
              {T.services.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className="in" aria-label="Permit state" value={filter.permit} onChange={(e) => set({ permit: e.target.value as RegFilter["permit"] })} style={{ width: 190 }}>
              {T.permits.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input className="in" placeholder={T.search} aria-label={T.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 170 }} />
          </div>
          <div className="btns">
            <button className="btn sm" disabled={!p?.total || !!exporting} onClick={exportCsv}>{exporting ?? T.export}</button>
            <button className="btn pri sm" disabled={!canImport} title={canImport ? undefined : T.importTitle} onClick={() => setImporting(true)}>{T.import}</button>
          </div>
        </div>
        {cur?.error && <div className="banner badb" role="alert">{cur.error}</div>}
        <div className="tblwrap" style={{ maxHeight: 560, overflowY: "auto" }}>
          <table>
            <thead><tr>{T.cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>
              {!cur && <tr><td colSpan={10} className="empty">{T.loading}</td></tr>}
              {p && p.rows.length === 0 && <tr><td colSpan={10} className="empty">{T.none}</td></tr>}
              {p?.rows.map((r) => {
                const [s, tone] = state(r);
                return (
                  <tr key={r.tanker_id}>
                    <td className={`stripe ${r.service_type}`} style={{ whiteSpace: "nowrap" }}>
                      <b>{r.plate}</b>
                      <small style={{ display: "block" }}>{r.capacity_known ? `${r.capacity_gal.toLocaleString()} gal` : T.capUnknown}</small>
                    </td>
                    <td><span className={`tag ${r.service_type}`}>{SERVICE_NAME[r.service_type as ServiceType]}</span></td>
                    <td>
                      {geo.govName(r.governorate)}
                      <small style={{ display: "block" }}>{r.governorate ? geo.clusterName(r.cluster) : ""}</small>
                    </td>
                    <td>
                      {r.company ?? r.owner_name ?? <span className="mut">{r.on_platform ? T.independent : T.noOwner}</span>}
                      {r.owner_name && (
                        <small style={{ display: "block" }} dir="ltr">{[r.company ? r.owner_name : null, r.phone, r.claimed ? T.claimed : null].filter(Boolean).join(" · ")}</small>
                      )}
                    </td>
                    <td>{r.on_platform ? <St tone="ok">{T.onPlatform}</St> : <St>{T.registerOnly}</St>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.permit_no ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.permit_expires ? fmtDate(r.permit_expires) : "—"}</td>
                    <td>
                      <St tone={tone}>{s}</St>
                      {r.pending_no && <small style={{ display: "block" }}>{T.inReview(r.pending_no)}</small>}
                    </td>
                    <td>{!r.on_platform ? <span className="mut">{T.noDriver}</span> : r.permit_valid ? T.canWork : <span style={{ color: "var(--bad)" }}>{T.blocked}</span>}</td>
                    <td>
                      {(r.pending_id || r.permit_id) && (
                        <button className="btn sm" onClick={() => onOpen((r.pending_id ?? r.permit_id)!)}>{r.pending_id ? T.review : T.view}</button>
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
            <span>{T.pager(from, to, p.total)}</span>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>{T.prev}</button>
            <button className="btn sm" disabled={to >= p.total} onClick={() => setPage((x) => x + 1)}>{T.next}</button>
          </div>
        )}
        <p className="note">{T.note}</p>
      </div>

      <div className="panel">
        <h2>{T.imports} <small>{T.importsSub}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>File</th><th>Started</th><th>Status</th><th className="num">Rows</th><th className="num">Created</th><th className="num">Updated</th><th className="num">Issues</th><th></th></tr></thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={8} className="empty">{T.noImports}</td></tr>}
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.file_name}<small style={{ display: "block" }}>{b.source === "script" ? "import script" : "upload"}</small></td>
                  <td>{fmtDateTime(b.created_at)}</td>
                  <td><St tone={b.status === "completed" ? "ok" : b.status === "running" ? "act" : "bad"}>{T.status[b.status] ?? b.status}</St></td>
                  <td className="num">{b.total_rows.toLocaleString()}</td>
                  <td className="num">{(b.counts.tankers_created ?? 0).toLocaleString()}</td>
                  <td className="num">{(b.counts.tankers_updated ?? 0).toLocaleString()}</td>
                  <td className="num">{((b.counts.warnings ?? 0) + (b.counts.errors ?? 0)).toLocaleString()}</td>
                  <td><button className="btn sm" onClick={() => report(b)}>{T.report}</button></td>
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
