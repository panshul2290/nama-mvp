"use client";

// NWS → Permits → Campaign: bringing the NWS register onto the platform. The funnel (counted in
// the database, report_permit_campaign) by cluster and governorate: in register → owner invited
// → registered on the platform → permit applied → under review → permitted, plus expiring soon.
// Each stage drills down to its tankers (paged), which export to CSV; owners not yet on the
// platform can be invited by SMS (selected rows, or everyone in the view).
import { useEffect, useState } from "react";
import { downloadCsv, Kpi, St, SERVICE_NAME } from "@/components/nws/ops";
import { fmtDate, fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey } from "@/lib/time";
import { cleanFilter, fetchAllRegister, fetchRegister, STAGE_LABEL, STAGE_TONE, type RegFilter, type RegPage, type RegRow } from "./data";
import { GeoFilter, type Geo } from "./geo";
import { InviteDialog } from "./InviteDialog";

const PAGE = 100;

type Counts = {
  in_register: number; invited: number; registered: number; applied: number; review: number; permitted: number;
  expiring_30: number; expiring_60: number; expired: number; no_phone: number; opted_out: number; invitable: number;
};
type Report = { total: Counts; by_cluster: (Counts & { cluster_code: string | null; name: string })[]; by_governorate: (Counts & { governorate_code: string; cluster_code: string | null; name: string })[] };
type Drill = { stage?: RegFilter["stage"]; permit?: RegFilter["permit"]; days?: number; label: string };

const T = {
  intro: "Bringing the NWS tanker register onto the platform: each tanker counts at the furthest step it has reached. Click a step to list its tankers.",
  steps: [
    ["in_register", "In NWS register", { label: "All register tankers" }],
    ["invited", "Owner contacted / invited", { stage: "reached_invited", label: "Owner invited or further" }],
    ["registered", "Registered on platform", { stage: "reached_registered", label: "Registered on the platform or further" }],
    ["applied", "Permit applied", { stage: "reached_applied", label: "Permit applied or further" }],
    ["review", "Under review", { stage: "reached_review", label: "Under review or permitted" }],
    ["permitted", "Permitted", { stage: "permitted", label: "Permitted" }],
  ] as [keyof Counts, string, Drill][],
  exact: [
    ["register", "Not contacted yet"], ["invited", "Invited, not registered"], ["registered", "Registered, no application"],
    ["applied", "Applied (submitted)"], ["review", "In review"], ["permitted", "Permitted"],
  ] as [RegRow["stage"], string][],
  kExp: "Expiring in 30 days", kExpSub: (n: number) => `${n.toLocaleString()} within 60 days`,
  kExpired: "Expired", kExpiredSub: "had a permit, now lapsed",
  kInvitable: "Can be invited", kInvitableSub: (p: number, o: number) => `${p.toLocaleString()} without a number · ${o.toLocaleString()} opted out`,
  kConv: "Permitted", kConvSub: "of the register",
  byGov: "By governorate",
  govCols: ["Governorate", "Cluster", "In register", "Invited", "Registered", "Applied", "In review", "Permitted", "% permitted", "Expiring 30 d"],
  services: [["", "All types"], ["DW", "Drinking water"], ["WW", "Wastewater"], ["TE", "Treated effluent"]] as const,
  list: "Tankers",
  selectAll: "Select the invitable tankers on this page",
  inviteSel: (n: number) => `Invite selected owners (${n})`,
  inviteAll: "Invite everyone not yet registered in this view",
  inviteAllOnly: "Choose a step before registration (not contacted, invited)",
  inviteSelWho: (n: number) => `${n.toLocaleString()} selected owners`,
  inviteAllWho: (l: string) => `every owner not yet on the platform in this view (${l})`,
  officers: "Permit officers and admins",
  export: "Export CSV",
  exporting: (n: number, t: number) => `Exporting ${n.toLocaleString()} / ${t.toLocaleString()}…`,
  cols: ["", "Tanker", "Governorate", "Owner", "Stage", "Invited", "Permit", ""],
  none: "No tankers at this step.",
  loading: "Loading…",
  never: "Not yet",
  times: (n: number) => (n === 1 ? "once" : `${n} times`),
  noPhone: "no mobile number", optedOut: "opted out",
  optOut: "Opt out", optIn: "Opt back in",
  optOutTitle: (n: string) => `Record that ${n} opted out of SMS`,
  optOutBody: "No more register invitations go to this number; any still queued are withdrawn.",
  optInTitle: (n: string) => `${n} may receive SMS again`,
  pager: (a: number, b: number, n: number) => `${a.toLocaleString()}–${b.toLocaleString()} of ${n.toLocaleString()}`,
  prev: "Previous", next: "Next",
  error: "Couldn’t load the campaign:",
};

const pctOf = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "—");

export function Campaign({ geo }: { geo: Geo }) {
  const { can, toast } = useStaff();
  const officer = can("permit_officer");
  const [geoF, setGeoF] = useState({ cluster: "", governorate: "" });
  const [service, setService] = useState<"" | ServiceType>("");
  const [report, setReport] = useState<{ key: string; r: Report | null; error: string | null } | null>(null);
  const [drill, setDrill] = useState<Drill>({ stage: "not_registered", label: "Not yet registered (register only or invited)" });
  const [page, setPage] = useState(0);
  const [list, setList] = useState<{ key: string; p: RegPage | null; error: string | null } | null>(null);
  const [sel, setSel] = useState<Map<string, string>>(new Map()); // tanker → owner
  const [invite, setInvite] = useState<null | "sel" | "all">(null);
  const [opt, setOpt] = useState<RegRow | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const base: RegFilter = { source: "register", cluster: geoF.cluster, governorate: geoF.governorate, service };
  const view: RegFilter = { ...base, stage: drill.stage ?? "", permit: drill.permit ?? "", days: drill.days };
  const baseJson = JSON.stringify(cleanFilter({ cluster: geoF.cluster, governorate: geoF.governorate, service }));
  const viewJson = JSON.stringify(cleanFilter(view));
  const rkey = `${baseJson}:${tick}`;
  const lkey = `${viewJson}:${page}:${tick}`;

  useEffect(() => {
    let live = true;
    supabase().rpc("report_permit_campaign", { p_filter: JSON.parse(baseJson) }).then(({ data, error }) => {
      if (live) setReport({ key: rkey, r: (data as Report | null) ?? null, error: error ? friendlyError(error) : null });
    });
    return () => {
      live = false;
    };
  }, [rkey, baseJson]);

  useEffect(() => {
    let live = true;
    fetchRegister(JSON.parse(viewJson) as RegFilter, PAGE, page * PAGE).then(({ data, error }) => {
      if (live) setList({ key: lkey, p: data, error });
    });
    return () => {
      live = false;
    };
  }, [lkey, viewJson, page]);

  const r = report?.key === rkey ? report.r : null;
  const rerr = report?.key === rkey ? report.error : null;
  const cur = list?.key === lkey ? list : null;
  const p = cur?.p ?? null;
  const total = r?.total;
  const invitable = (x: RegRow) => !!x.owner_id && x.has_phone && !x.opted_out && (x.stage === "register" || x.stage === "invited");
  const pick = (d: Drill) => {
    setDrill(d);
    setPage(0);
    setSel(new Map());
  };
  const geoChange = (g: { cluster: string; governorate: string }) => {
    setGeoF(g);
    setPage(0);
    setSel(new Map());
  };

  async function exportCsv() {
    setExporting(T.exporting(0, p?.total ?? 0));
    const all = await fetchAllRegister(view, 20000, (n, t) => setExporting(T.exporting(n, t)));
    setExporting(null);
    if (all.error) toast(all.error, true);
    downloadCsv(`permit-campaign-${omanDateKey(new Date())}`, [
      ["Plate", "Service", "Governorate", "Cluster", "Owner", "Owner mobile", "Stage", "Invited at", "Invitations", "Opted out", "On platform", "Permit no.", "Permit valid until", "Application", "Application stage"],
      ...all.rows.map((x) => [
        x.plate, x.service_type, geo.govName(x.governorate), geo.clusterName(x.cluster), x.owner_name ?? "", x.phone ?? "", STAGE_LABEL[x.stage],
        x.invited_at ? omanDateKey(x.invited_at) : "", x.invite_count, x.opted_out ? "yes" : "no", x.on_platform ? "yes" : "no",
        x.permit_no ?? "", x.permit_expires ? omanDateKey(x.permit_expires) : "", x.pending_no ?? "", x.pending_stage ?? "",
      ]),
    ]);
  }

  const from = p && p.total ? page * PAGE + 1 : 0;
  const to = p ? Math.min((page + 1) * PAGE, p.total) : 0;
  const pageInvitable = (p?.rows ?? []).filter(invitable);
  // "Invite everyone" only where the view is owners not yet on the platform.
  const inviteAllStage = !drill.permit && (!drill.stage || drill.stage === "register" || drill.stage === "invited" || drill.stage === "not_registered") ? (drill.stage || "not_registered") : null;
  const allSel = pageInvitable.length > 0 && pageInvitable.every((x) => sel.has(x.tanker_id));
  return (
    <>
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13, maxWidth: 560 }}>{T.intro}</span>
          <div className="filters">
            <GeoFilter geo={geo} cluster={geoF.cluster} governorate={geoF.governorate} onChange={geoChange} />
            <select className="in" aria-label="Service type" value={service} onChange={(e) => { setService(e.target.value as "" | ServiceType); setPage(0); setSel(new Map()); }} style={{ width: 150 }}>
              {T.services.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        {rerr && <div className="banner badb" role="alert">{T.error} {rerr}</div>}
        <div className="funnel">
          {T.steps.map(([k, label, d]) => {
            const n = total ? total[k] : 0;
            const on = drill.label === d.label;
            return (
              <button key={k} className={on ? "on" : ""} aria-pressed={on} onClick={() => pick(d)}>
                <span>{label}</span>
                <span className="track"><span className="fill" style={{ display: "block", width: `${total?.in_register ? (n / total.in_register) * 100 : 0}%` }} /></span>
                <span className="num"><b>{total ? n.toLocaleString() : "…"}</b><small>{total ? pctOf(n, total.in_register) : ""}</small></span>
              </button>
            );
          })}
        </div>
        <div className="toolbar" style={{ paddingTop: 0 }}>
          <div className="chips">
            {T.exact.map(([s, l]) => (
              <button key={s} className={`chip ${drill.stage === s ? "on" : ""}`} onClick={() => pick({ stage: s, label: l })}>{l}</button>
            ))}
            <button className={`chip ${drill.permit === "expiring" ? "on" : ""}`} onClick={() => pick({ permit: "expiring", days: 30, label: T.kExp })}>{T.kExp}<span className="tc">{total?.expiring_30 ?? 0}</span></button>
            <button className={`chip ${drill.permit === "expired" ? "on" : ""}`} onClick={() => pick({ permit: "expired", label: T.kExpired })}>{T.kExpired}<span className="tc">{total?.expired ?? 0}</span></button>
          </div>
        </div>
      </div>

      <div className="okpis">
        <Kpi label={T.kConv} value={total ? pctOf(total.permitted, total.in_register) : "…"} sub={T.kConvSub} tone="ok" />
        <Kpi label={T.kExp} value={total ? total.expiring_30.toLocaleString() : "…"} sub={total ? T.kExpSub(total.expiring_60) : ""} tone={total?.expiring_30 ? "warn" : ""} />
        <Kpi label={T.kExpired} value={total ? total.expired.toLocaleString() : "…"} sub={T.kExpiredSub} tone={total?.expired ? "bad" : ""} />
        <Kpi label={T.kInvitable} value={total ? total.invitable.toLocaleString() : "…"} sub={total ? T.kInvitableSub(total.no_phone, total.opted_out) : ""} />
      </div>

      <div className="panel">
        <h2>{T.byGov}</h2>
        <div className="tblwrap">
          <table>
            <thead><tr>{T.govCols.map((c, i) => <th key={c} className={i > 1 ? "num" : undefined}>{c}</th>)}</tr></thead>
            <tbody>
              {!r && !rerr && <tr><td colSpan={10} className="empty">{T.loading}</td></tr>}
              {r?.by_governorate.map((g) => (
                <tr key={g.governorate_code} className="click" onClick={() => geoChange({ cluster: geoF.cluster, governorate: g.governorate_code })}>
                  <td><b>{g.name}</b></td>
                  <td>{geo.clusterName(g.cluster_code)}</td>
                  {(["in_register", "invited", "registered", "applied", "review", "permitted"] as const).map((k) => <td key={k} className="num">{g[k].toLocaleString()}</td>)}
                  <td className="num">{pctOf(g.permitted, g.in_register)}</td>
                  <td className="num">{g.expiring_30.toLocaleString()}</td>
                </tr>
              ))}
              {r && r.by_cluster.length > 1 && r.by_cluster.map((c) => (
                <tr key={`c-${c.cluster_code}`} className="click" onClick={() => geoChange({ cluster: c.cluster_code ?? "none", governorate: "" })}>
                  <td><b>{c.name}</b> <small className="mut">all governorates</small></td>
                  <td></td>
                  {(["in_register", "invited", "registered", "applied", "review", "permitted"] as const).map((k) => <td key={k} className="num"><b>{c[k].toLocaleString()}</b></td>)}
                  <td className="num"><b>{pctOf(c.permitted, c.in_register)}</b></td>
                  <td className="num"><b>{c.expiring_30.toLocaleString()}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="toolbar">
          <h2 style={{ margin: 0, padding: 0, border: 0 }}>{T.list} <small>{drill.label}</small></h2>
          <div className="btns">
            <button className="btn sm" disabled={!p?.total || !!exporting} onClick={exportCsv}>{exporting ?? T.export}</button>
            <button className="btn sm" disabled={!officer || sel.size === 0} title={officer ? undefined : T.officers} onClick={() => setInvite("sel")}>{T.inviteSel(new Set(sel.values()).size)}</button>
            <button className="btn sm pri" disabled={!officer || !p?.total || !inviteAllStage} title={!officer ? T.officers : !inviteAllStage ? T.inviteAllOnly : undefined} onClick={() => setInvite("all")}>{T.inviteAll}</button>
          </div>
        </div>
        {cur?.error && <div className="banner badb" role="alert">{cur.error}</div>}
        <div className="tblwrap" style={{ maxHeight: 520, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" aria-label={T.selectAll} disabled={!officer || pageInvitable.length === 0} checked={allSel}
                    onChange={(e) => setSel((m) => {
                      const n = new Map(m);
                      for (const x of pageInvitable) {
                        if (e.target.checked) n.set(x.tanker_id, x.owner_id!);
                        else n.delete(x.tanker_id);
                      }
                      return n;
                    })} />
                </th>
                {T.cols.slice(1).map((c, i) => <th key={i}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {!cur && <tr><td colSpan={8} className="empty">{T.loading}</td></tr>}
              {p && p.rows.length === 0 && <tr><td colSpan={8} className="empty">{T.none}</td></tr>}
              {p?.rows.map((x) => (
                <tr key={x.tanker_id}>
                  <td>
                    <input type="checkbox" aria-label={`Select ${x.plate}`} disabled={!officer || !invitable(x)} checked={sel.has(x.tanker_id)}
                      onChange={(e) => setSel((m) => {
                        const n = new Map(m);
                        if (e.target.checked) n.set(x.tanker_id, x.owner_id!);
                        else n.delete(x.tanker_id);
                        return n;
                      })} />
                  </td>
                  <td className={`stripe ${x.service_type}`} style={{ whiteSpace: "nowrap" }}>
                    <b>{x.plate}</b>
                    <small style={{ display: "block" }}>{SERVICE_NAME[x.service_type as ServiceType]}</small>
                  </td>
                  <td>{geo.govName(x.governorate)}<small style={{ display: "block" }}>{geo.clusterName(x.cluster)}</small></td>
                  <td>
                    {x.company ?? x.owner_name ?? "—"}
                    <small style={{ display: "block" }} dir="ltr">{x.has_phone ? x.phone : T.noPhone}{x.opted_out ? ` · ${T.optedOut}` : ""}</small>
                  </td>
                  <td><St tone={STAGE_TONE[x.stage]}>{STAGE_LABEL[x.stage]}</St></td>
                  <td>{x.invited_at ? <>{fmtDateTime(x.invited_at)}<small style={{ display: "block" }}>{T.times(x.invite_count)}</small></> : <span className="mut">{T.never}</span>}</td>
                  <td>
                    {x.permit_no ? <>{x.permit_no}<small style={{ display: "block" }}>{x.permit_expires ? fmtDate(x.permit_expires) : ""}</small></> : x.pending_no ? <>{x.pending_no}<small style={{ display: "block" }}>{x.pending_stage}</small></> : <span className="mut">—</span>}
                  </td>
                  <td>
                    {x.owner_id && x.has_phone && (
                      <button className="btn sm" disabled={!officer} title={officer ? undefined : T.officers} onClick={() => setOpt(x)}>{x.opted_out ? T.optIn : T.optOut}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p && p.total > 0 && (
          <div className="regpager">
            <span>{T.pager(from, to, p.total)}</span>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>{T.prev}</button>
            <button className="btn sm" disabled={to >= p.total} onClick={() => setPage((n) => n + 1)}>{T.next}</button>
          </div>
        )}
      </div>

      {invite === "sel" && (
        <InviteDialog who={T.inviteSelWho(new Set(sel.values()).size)} owners={[...new Set(sel.values())]} onClose={() => setInvite(null)}
          onDone={() => { setSel(new Map()); setTick((n) => n + 1); }} />
      )}
      {invite === "all" && (
        <InviteDialog who={T.inviteAllWho(drill.label)} filter={{ ...view, stage: inviteAllStage ?? "not_registered" }}
          onClose={() => setInvite(null)} onDone={() => setTick((n) => n + 1)} />
      )}
      {opt && (
        <ReasonDialog
          title={opt.opted_out ? T.optInTitle(opt.owner_name ?? opt.plate) : T.optOutTitle(opt.owner_name ?? opt.plate)}
          body={opt.opted_out ? undefined : T.optOutBody}
          confirm={opt.opted_out ? T.optIn : T.optOut}
          danger={!opt.opted_out}
          defaultReason={opt.opted_out ? "" : "Owner replied STOP"}
          onCancel={() => setOpt(null)}
          onConfirm={async (reason) => {
            const { error } = await supabase().rpc("staff_registry_owner_opt_out", { p_owner_id: opt.owner_id, p_opt_out: !opt.opted_out, p_reason: reason });
            if (error) return toast(friendlyError(error), true);
            toast(opt.opted_out ? "Opted back in" : "Opt-out recorded");
            setOpt(null);
            setTick((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
