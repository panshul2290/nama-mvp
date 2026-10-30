"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { downloadCsv } from "@/components/nws/admin/ui";
import { SETTINGS } from "@/components/nws/i18n/settings";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { omanDayEndIso, omanDayStartIso } from "@/lib/time";

const PAGE = 300;

type Row = {
  id: number; at: string; actor_email: string | null; actor_role: string | null; action: string;
  target_type: string; target_id: string; before: unknown; after: unknown; reason: string | null;
};

// Action filter: value prefix → SETTINGS key.
const ACTIONS: [string, string][] = [
  ["tanker.", "aTanker"], ["alert.", "aAlert"], ["company.", "aCompany"], ["document.", "aDocument"], ["inspection.", "aInspection"],
  ["org.", "aOrg"], ["report.", "aReport"], ["permit.", "aPermit"], ["staff.", "aStaff"], ["order.", "aOrder"], ["customer.", "aCustomer"],
  ["complaint", "aComplaint"], ["penalty", "aPenalty"], ["pricing.", "aPricing"], ["promotion.", "aPromotion"], ["setting.", "aSetting"],
  ["emergency.", "aEmergency"], ["zone.", "aZone"], ["site.", "aSite"], ["template.", "aTemplate"], ["payout.", "aPayout"], ["fraud.", "aFraud"],
  ["data_request.", "aDataRequest"], ["incident.", "aIncident"],
];

export default function AuditLogPage() {
  const t = useT(SETTINGS);
  const f = useFmt();
  const { lang } = useLang();
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    let query = supabase().from("audit_log").select("*").order("id", { ascending: false }).limit(limit);
    const term = q.trim().replace(/[%,()]/g, " ");
    if (term) query = query.or(`actor_email.ilike.%${term}%,target_id.ilike.%${term}%,reason.ilike.%${term}%,action.ilike.%${term}%`);
    if (action) query = query.like("action", `${action}%`);
    if (from) query = query.gte("at", omanDayStartIso(from));
    if (to) query = query.lte("at", omanDayEndIso(to));
    const { data, error } = await query;
    setErr(error ? friendlyError(error, lang) : null);
    setRows((data ?? []) as Row[]);
  }, [q, action, from, to, limit, lang]);

  function exportCsv() {
    if (!rows?.length) return;
    downloadCsv("audit_log", [
      ["When", "Actor", "Role", "Action", "Target type", "Target", "Reason", "Before", "After"],
      ...rows.map((r) => [r.at, r.actor_email, r.actor_role, r.action, r.target_type, r.target_id, r.reason, JSON.stringify(r.before), JSON.stringify(r.after)]),
    ]);
    void supabase().rpc("staff_log_export", { p_what: "audit log", p_rows: rows.length });
  }

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>{t("navAudit")}</h1>
          <p>{t("auditSub")}</p>
        </div>
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="filters">
            <input className="in" placeholder={t("auditSearch")} value={q} onChange={(e) => { setLimit(PAGE); setQ(e.target.value); }} aria-label={t("search")} style={{ width: 260 }} />
            <select className="in" value={action} onChange={(e) => { setLimit(PAGE); setAction(e.target.value); }} aria-label={t("action")}>
              <option value="">{t("allActions")}</option>
              {ACTIONS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
            </select>
            <label className="mut" style={{ fontSize: 12.5 }}>
              {t("from")} <input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="mut" style={{ fontSize: 12.5 }}>
              {t("to")} <input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <span className="btns" style={{ alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 12.5 }}>
              {rows ? `${t(rows.length === 1 ? "entries1" : "entriesN", { n: f.n(rows.length) })}${rows.length === limit ? t("latestN", { n: f.n(limit) }) : ""}` : t("loading")}
            </span>
            <button className="btn sm" disabled={!rows?.length} onClick={exportCsv}>{t("exportCsv")}</button>
          </span>
        </div>
        {err && <div className="banner badb" role="alert">{t("auditErr", { err })}</div>}
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("when")}</th>
                <th>{t("actor")}</th>
                <th>{t("action")}</th>
                <th>{t("target")}</th>
                <th>{t("reason")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && !err && (
                <tr><td colSpan={6} className="empty">{t("noAudit")}</td></tr>
              )}
              {rows?.map((r) => (
                <Fragment key={r.id}>
                  <tr className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td><small>{f.dateTime(r.at)}</small></td>
                    <td>
                      {r.actor_email ? <bdi dir="ltr">{r.actor_email}</bdi> : "—"}
                      {r.actor_role ? <small style={{ display: "block" }}>{label("staff", r.actor_role, lang)}</small> : null}
                    </td>
                    <td><code dir="ltr">{r.action}</code></td>
                    <td>
                      <bdi dir="ltr">{r.target_type}</bdi>
                      <small style={{ display: "block" }} dir="ltr">{r.target_id}</small>
                    </td>
                    <td>{r.reason ?? <span className="mut">—</span>}</td>
                    <td>
                      <button type="button" className="lk" aria-expanded={open === r.id} onClick={(e) => { e.stopPropagation(); setOpen(open === r.id ? null : r.id); }}>
                        {open === r.id ? t("hide") : t("beforeAfter")}
                      </button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={6}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <div>
                            <small>{t("before")}</small>
                            <pre className="json" dir="ltr">{JSON.stringify(r.before, null, 2) ?? "null"}</pre>
                          </div>
                          <div>
                            <small>{t("after")}</small>
                            <pre className="json" dir="ltr">{JSON.stringify(r.after, null, 2) ?? "null"}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {rows && rows.length === limit && (
          <div className="pad" style={{ textAlign: "center" }}>
            <button className="btn sm" onClick={() => setLimit((l) => l + PAGE)}>{t("loadMoreN", { n: f.n(PAGE) })}</button>
          </div>
        )}
      </div>
    </>
  );
}
