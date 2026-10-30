"use client";

// NWS → Permits → Campaign: bringing the NWS register onto the platform. The funnel (counted in
// the database, report_permit_campaign) by cluster and governorate: in register → owner invited
// → registered on the platform → permit applied → under review → permitted, plus expiring soon.
// Each stage drills down to its tankers (paged), which export to CSV; owners not yet on the
// platform can be invited by SMS (selected rows, or everyone in the view).
import { useEffect, useState } from "react";
import { REG } from "@/components/nws/i18n/register";
import { downloadCsv, Kpi, St, SERVICE_NAME } from "@/components/nws/ops";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { label as svcLabel } from "@/lib/labels";
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
/** label: a key of REG (components/nws/i18n/register), also the drill's identity. */
type Drill = { stage?: RegFilter["stage"]; permit?: RegFilter["permit"]; days?: number; label: string };

// Funnel steps: count, step name key, drill-down (label = REG key).
const STEPS: [keyof Counts, string, Drill][] = [
  ["in_register", "step.in_register", { label: "drill.in_register" }],
  ["invited", "step.invited", { stage: "reached_invited", label: "drill.invited" }],
  ["registered", "step.registered", { stage: "reached_registered", label: "drill.registered" }],
  ["applied", "step.applied", { stage: "reached_applied", label: "drill.applied" }],
  ["review", "step.review", { stage: "reached_review", label: "drill.review" }],
  ["permitted", "step.permitted", { stage: "permitted", label: "drill.permitted" }],
];
const EXACT: RegRow["stage"][] = ["register", "invited", "registered", "applied", "review", "permitted"];
const GOV_COLS = ["governorate", "cluster", "gInRegister", "gInvited", "gRegistered", "gApplied", "gInReview", "gPermitted", "gPct", "gExp30"];
const SERVICES = ["", "DW", "WW", "TE"] as const;
const COLS = ["", "colTanker", "governorate", "colOwner", "colStage", "colInvited", "colPermit", ""];

export function Campaign({ geo }: { geo: Geo }) {
  const { can, toast } = useStaff();
  const t = useT(REG);
  const f = useFmt();
  const { lang } = useLang();
  const pctOf = (n: number, d: number) => f.ratio(n, d);
  const officer = can("permit_officer");
  const [geoF, setGeoF] = useState({ cluster: "", governorate: "" });
  const [service, setService] = useState<"" | ServiceType>("");
  const [report, setReport] = useState<{ key: string; r: Report | null; error: string | null } | null>(null);
  const [drill, setDrill] = useState<Drill>({ stage: "not_registered", label: "drill.not_registered" });
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
      if (live) setReport({ key: rkey, r: (data as Report | null) ?? null, error: error ? friendlyError(error, lang) : null });
    });
    return () => {
      live = false;
    };
  }, [rkey, baseJson, lang]);

  useEffect(() => {
    let live = true;
    fetchRegister(JSON.parse(viewJson) as RegFilter, PAGE, page * PAGE, lang).then(({ data, error }) => {
      if (live) setList({ key: lkey, p: data, error });
    });
    return () => {
      live = false;
    };
  }, [lkey, viewJson, page, lang]);

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
    setExporting(t("exporting", { n: f.n(0), total: f.n(p?.total ?? 0) }));
    const all = await fetchAllRegister(view, 20000, (n, tot) => setExporting(t("exporting", { n: f.n(n), total: f.n(tot) })), lang);
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
          <span className="mut" style={{ fontSize: 13, maxWidth: 560 }}>{t("cIntro")}</span>
          <div className="filters">
            <GeoFilter geo={geo} cluster={geoF.cluster} governorate={geoF.governorate} onChange={geoChange} />
            <select className="in" aria-label={t("serviceType")} value={service} onChange={(e) => { setService(e.target.value as "" | ServiceType); setPage(0); setSel(new Map()); }} style={{ width: 150 }}>
              {SERVICES.map((v) => <option key={v} value={v}>{v ? svcLabel("svc", v, lang) : t("allTypes")}</option>)}
            </select>
          </div>
        </div>
        {rerr && <div className="banner badb" role="alert">{t("loadErr")} {rerr}</div>}
        <div className="funnel">
          {STEPS.map(([k, label, d]) => {
            const n = total ? total[k] : 0;
            const on = drill.label === d.label;
            return (
              <button key={k} className={on ? "on" : ""} aria-pressed={on} onClick={() => pick(d)}>
                <span>{t(label)}</span>
                <span className="track"><span className="fill" style={{ display: "block", width: `${total?.in_register ? (n / total.in_register) * 100 : 0}%` }} /></span>
                <span className="num"><b>{total ? f.n(n) : "…"}</b><small>{total ? pctOf(n, total.in_register) : ""}</small></span>
              </button>
            );
          })}
        </div>
        <div className="toolbar" style={{ paddingTop: 0 }}>
          <div className="chips">
            {EXACT.map((s) => (
              <button key={s} className={`chip ${drill.stage === s ? "on" : ""}`} onClick={() => pick({ stage: s, label: `exact.${s}` })}>{t(`exact.${s}`)}</button>
            ))}
            <button className={`chip ${drill.permit === "expiring" ? "on" : ""}`} onClick={() => pick({ permit: "expiring", days: 30, label: "kExp" })}>{t("kExp")}<span className="tc">{f.n(total?.expiring_30 ?? 0)}</span></button>
            <button className={`chip ${drill.permit === "expired" ? "on" : ""}`} onClick={() => pick({ permit: "expired", label: "cExpired" })}>{t("cExpired")}<span className="tc">{f.n(total?.expired ?? 0)}</span></button>
          </div>
        </div>
      </div>

      <div className="okpis">
        <Kpi label={t("cConv")} value={total ? pctOf(total.permitted, total.in_register) : "…"} sub={t("cConvSub")} tone="ok" />
        <Kpi label={t("kExp")} value={total ? f.n(total.expiring_30) : "…"} sub={total ? t("cExpSub", { n: f.n(total.expiring_60) }) : ""} tone={total?.expiring_30 ? "warn" : ""} />
        <Kpi label={t("cExpired")} value={total ? f.n(total.expired) : "…"} sub={t("cExpiredSub")} tone={total?.expired ? "bad" : ""} />
        <Kpi label={t("cInvitable")} value={total ? f.n(total.invitable) : "…"} sub={total ? t("cInvitableSub", { p: f.n(total.no_phone), o: f.n(total.opted_out) }) : ""} />
      </div>

      <div className="panel">
        <h2>{t("byGov")}</h2>
        <div className="tblwrap">
          <table>
            <thead><tr>{GOV_COLS.map((c, i) => <th key={c} className={i > 1 ? "num" : undefined}>{t(c)}</th>)}</tr></thead>
            <tbody>
              {!r && !rerr && <tr><td colSpan={10} className="empty">{t("loading")}</td></tr>}
              {r?.by_governorate.map((g) => (
                <tr key={g.governorate_code} className="click" onClick={() => geoChange({ cluster: geoF.cluster, governorate: g.governorate_code })}>
                  <td><b>{g.name}</b></td>
                  <td>{geo.clusterName(g.cluster_code)}</td>
                  {(["in_register", "invited", "registered", "applied", "review", "permitted"] as const).map((k) => <td key={k} className="num">{f.n(g[k])}</td>)}
                  <td className="num">{pctOf(g.permitted, g.in_register)}</td>
                  <td className="num">{f.n(g.expiring_30)}</td>
                </tr>
              ))}
              {r && r.by_cluster.length > 1 && r.by_cluster.map((c) => (
                <tr key={`c-${c.cluster_code}`} className="click" onClick={() => geoChange({ cluster: c.cluster_code ?? "none", governorate: "" })}>
                  <td><b>{c.name}</b> <small className="mut">{t("allGovs")}</small></td>
                  <td></td>
                  {(["in_register", "invited", "registered", "applied", "review", "permitted"] as const).map((k) => <td key={k} className="num"><b>{f.n(c[k])}</b></td>)}
                  <td className="num"><b>{pctOf(c.permitted, c.in_register)}</b></td>
                  <td className="num"><b>{f.n(c.expiring_30)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="toolbar">
          <h2 style={{ margin: 0, padding: 0, border: 0 }}>{t("list")} <small>{t(drill.label)}</small></h2>
          <div className="btns">
            <button className="btn sm" disabled={!p?.total || !!exporting} onClick={exportCsv}>{exporting ?? t("exportCsv")}</button>
            <button className="btn sm" disabled={!officer || sel.size === 0} title={officer ? undefined : t("importTitle")} onClick={() => setInvite("sel")}>{t("inviteSel", { n: f.n(new Set(sel.values()).size) })}</button>
            <button className="btn sm pri" disabled={!officer || !p?.total || !inviteAllStage} title={!officer ? t("importTitle") : !inviteAllStage ? t("inviteAllOnly") : undefined} onClick={() => setInvite("all")}>{t("inviteAll")}</button>
          </div>
        </div>
        {cur?.error && <div className="banner badb" role="alert">{cur.error}</div>}
        <div className="tblwrap" style={{ maxHeight: 520, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" aria-label={t("selectAll")} disabled={!officer || pageInvitable.length === 0} checked={allSel}
                    onChange={(e) => setSel((m) => {
                      const n = new Map(m);
                      for (const x of pageInvitable) {
                        if (e.target.checked) n.set(x.tanker_id, x.owner_id!);
                        else n.delete(x.tanker_id);
                      }
                      return n;
                    })} />
                </th>
                {COLS.slice(1).map((c, i) => <th key={i}>{c ? t(c) : ""}</th>)}
              </tr>
            </thead>
            <tbody>
              {!cur && <tr><td colSpan={8} className="empty">{t("loading")}</td></tr>}
              {p && p.rows.length === 0 && <tr><td colSpan={8} className="empty">{t("noneStep")}</td></tr>}
              {p?.rows.map((x) => (
                <tr key={x.tanker_id}>
                  <td>
                    <input type="checkbox" aria-label={t("selectX", { plate: x.plate })} disabled={!officer || !invitable(x)} checked={sel.has(x.tanker_id)}
                      onChange={(e) => setSel((m) => {
                        const n = new Map(m);
                        if (e.target.checked) n.set(x.tanker_id, x.owner_id!);
                        else n.delete(x.tanker_id);
                        return n;
                      })} />
                  </td>
                  <td className={`stripe ${x.service_type}`} style={{ whiteSpace: "nowrap" }}>
                    <b dir="ltr">{x.plate}</b>
                    <small style={{ display: "block" }}>{svcLabel("svc", x.service_type, lang, SERVICE_NAME[x.service_type as ServiceType])}</small>
                  </td>
                  <td>{geo.govName(x.governorate)}<small style={{ display: "block" }}>{geo.clusterName(x.cluster)}</small></td>
                  <td>
                    {x.company ?? x.owner_name ?? "—"}
                    <small style={{ display: "block" }}>{x.has_phone ? <bdi dir="ltr">{x.phone}</bdi> : t("noPhone")}{x.opted_out ? ` · ${t("optedOut")}` : ""}</small>
                  </td>
                  <td><St tone={STAGE_TONE[x.stage]}>{REG[`stage.${x.stage}`] ? t(`stage.${x.stage}`) : STAGE_LABEL[x.stage]}</St></td>
                  <td>{x.invited_at ? <>{f.dateTime(x.invited_at)}<small style={{ display: "block" }}>{x.invite_count === 1 ? t("once") : t("timesN", { n: f.n(x.invite_count) })}</small></> : <span className="mut">{t("never")}</span>}</td>
                  <td>
                    {x.permit_no ? <><bdi dir="ltr">{x.permit_no}</bdi><small style={{ display: "block" }}>{x.permit_expires ? f.date(x.permit_expires) : ""}</small></> : x.pending_no ? <><bdi dir="ltr">{x.pending_no}</bdi><small style={{ display: "block" }}>{x.pending_stage ? svcLabel("stage", x.pending_stage, lang) : ""}</small></> : <span className="mut">—</span>}
                  </td>
                  <td>
                    {x.owner_id && x.has_phone && (
                      <button className="btn sm" disabled={!officer} title={officer ? undefined : t("importTitle")} onClick={() => setOpt(x)}>{x.opted_out ? t("optIn") : t("optOut")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p && p.total > 0 && (
          <div className="regpager">
            <span>{t("pager", { a: f.n(from), b: f.n(to), n: f.n(p.total) })}</span>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>{t("prev")}</button>
            <button className="btn sm" disabled={to >= p.total} onClick={() => setPage((n) => n + 1)}>{t("next")}</button>
          </div>
        )}
      </div>

      {invite === "sel" && (
        <InviteDialog who={t("inviteSelWho", { n: f.n(new Set(sel.values()).size) })} owners={[...new Set(sel.values())]} onClose={() => setInvite(null)}
          onDone={() => { setSel(new Map()); setTick((n) => n + 1); }} />
      )}
      {invite === "all" && (
        <InviteDialog who={t("inviteAllWho", { l: t(drill.label) })} filter={{ ...view, stage: inviteAllStage ?? "not_registered" }}
          onClose={() => setInvite(null)} onDone={() => setTick((n) => n + 1)} />
      )}
      {opt && (
        <ReasonDialog
          title={opt.opted_out ? t("optInTitle", { n: opt.owner_name ?? opt.plate }) : t("optOutTitle", { n: opt.owner_name ?? opt.plate })}
          body={opt.opted_out ? undefined : t("optOutBody")}
          confirm={opt.opted_out ? t("optIn") : t("optOut")}
          danger={!opt.opted_out}
          defaultReason={opt.opted_out ? "" : t("optOutReason")}
          onCancel={() => setOpt(null)}
          onConfirm={async (reason) => {
            const { error } = await supabase().rpc("staff_registry_owner_opt_out", { p_owner_id: opt.owner_id, p_opt_out: !opt.opted_out, p_reason: reason });
            if (error) return toast(friendlyError(error, lang), true);
            toast(opt.opted_out ? t("optedBackIn") : t("optOutDone"));
            setOpt(null);
            setTick((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
