"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { SET_ADMIN } from "@/components/nws/i18n/settingsAdmin";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { staffRoleLabel } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { ref, type DataRequest, type StaffRole } from "@/lib/types";

type Privacy = {
  mask_phone: boolean; mask_id: boolean; mask_address: boolean; usage_data_default: boolean;
  retention_gps_days: number; retention_chat_days: number; retention_photo_days: number; retention_orders_years: number;
  privileged_roles: StaffRole[]; hosting?: string;
};
type Req = DataRequest & { customer: { full_name: string } | null; result_note?: string | null };
type Retention = { gps_fixes: number; chat_messages: number; delivery_media: number; complaint_photos: number; addresses: number };
type Run = { id: number; ran_at: string; dry_run: boolean; result: Retention };

// Screen text: keys of SET_ADMIN (components/nws/i18n/settingsAdmin.ts).
const KIND: Record<DataRequest["kind"], string> = { access: "kAccess", delete: "kDelete", correct: "kCorrect" };
const DUE_DAYS = 30; // statutory response window (assumption)
const ROLES: StaffRole[] = ["admin", "operator", "permit_officer", "inspector", "complaints_agent", "finance"];
const RET_LABEL: Record<keyof Retention, string> = {
  gps_fixes: "retGps", chat_messages: "retChat", delivery_media: "retMedia", complaint_photos: "retComplaint", addresses: "retAddr",
};

export default function PrivacyPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const t = useT(SET_ADMIN);
  const f = useFmt();
  const { lang } = useLang();
  const [saved, setSaved] = useState<Privacy | null>(null);
  const [p, setP] = useState<Privacy | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [now, setNow] = useState(0); // time of the last load, for due dates
  const [consent, setConsent] = useState<{ share: number; n: number } | null>(null);
  const [preview, setPreview] = useState<Retention | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("app_settings").select("value").eq("key", "PRIVACY").maybeSingle().then(({ data }) => {
      const v = data?.value ? (JSON.parse(data.value as string) as Privacy) : null;
      setSaved(v);
      setP(v);
    });
    db.from("data_requests").select("*, customer:profiles!data_requests_customer_id_fkey(full_name)").order("created_at", { ascending: false }).limit(100)
      .then(({ data }) => {
        setNow(Date.now());
        setReqs((data ?? []) as Req[]);
      });
    // Counted in the database (0024), so no customer's private fields come to the browser.
    db.rpc("staff_consent_stats").then(({ data }) => {
      const s = (data as { customers: number; sharing: number }[] | null)?.[0];
      setConsent(s ? { share: s.sharing, n: s.customers } : null);
    });
    db.from("retention_runs").select("id, ran_at, dry_run, result").order("id", { ascending: false }).limit(5).then(({ data }) => setRuns((data ?? []) as Run[]));
    if (admin) db.rpc("staff_run_retention", { p_dry: true }).then(({ data }) => setPreview((data as Retention | null) ?? null));
  }, [admin]);
  useEffect(load, [load]);

  // "12 GPS fixes, 3 chat messages, …" in the viewer's language.
  const retList = (r: Retention) =>
    (Object.keys(RET_LABEL) as (keyof Retention)[]).map((k) => t("countOf", { n: f.n(r[k] ?? 0), what: t(RET_LABEL[k]).toLocaleLowerCase(lang === "ar" ? "ar" : "en") })).join(lang === "ar" ? "، " : ", ");

  function save() {
    if (!p) return;
    ask({
      title: t("saveCtlT"),
      body: t("saveCtlB"),
      confirm: t("saveCtl"),
      ok: t("ctlSaved"),
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "PRIVACY", p_value: p, p_reason: reason }),
      done: load,
    });
  }
  function runRetention() {
    ask({
      title: t("runRetT"),
      body: preview ? t("runRetB", { list: retList(preview) }) : t("runRetB0"),
      confirm: t("runRet"),
      danger: true,
      ok: t("retDone"),
      run: () => supabase().rpc("staff_run_retention", { p_dry: false }),
      done: load,
    });
  }
  function process(r: Req) {
    const vars = { name: r.customer?.full_name ?? t("theCustomer"), ref: ref.dataRequest(r.ref_no) };
    ask({
      title: r.kind === "access" ? t("prepFor", vars) : t("eraseFor", vars),
      body: r.kind === "access" ? t("prepB") : t("eraseB"),
      confirm: r.kind === "access" ? t("prepExport") : t("eraseData"),
      danger: r.kind === "delete",
      ok: r.kind === "access" ? t("exportReady") : t("erased"),
      run: (reason) => supabase().rpc("staff_process_data_request", { p_request_id: r.id, p_reason: reason }),
      done: load,
    });
  }
  function close(r: Req, state: "completed" | "rejected") {
    const rf = ref.dataRequest(r.ref_no);
    ask({
      title: state === "completed" ? t("completeT", { ref: rf }) : t("rejectT", { ref: rf }),
      body: t("closeB", { kind: t(KIND[r.kind]), name: r.customer?.full_name ?? t("theCustomer"), tail: state === "completed" ? t("closeDone") : t("closeRej") }),
      confirm: state === "completed" ? t("markCompleted") : t("rejectReq"),
      danger: state === "rejected",
      ok: state === "completed" ? t("reqCompleted") : t("reqRejected"),
      run: (reason) => supabase().rpc("staff_close_data_request", { p_request_id: r.id, p_state: state, p_reason: reason }),
      done: load,
    });
  }

  const dirty = p && saved && JSON.stringify(p) !== JSON.stringify(saved);
  type NumKey = "retention_gps_days" | "retention_chat_days" | "retention_photo_days" | "retention_orders_years";
  const sel = (k: NumKey, opts: [number, string][], aria: string) => (
    <select className="inl" aria-label={aria} disabled={!admin || !p} value={p?.[k] ?? ""} onChange={(e) => p && setP({ ...p, [k]: Number(e.target.value) })}>
      {opts.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
    </select>
  );
  const sw = (k: "mask_phone" | "mask_id" | "usage_data_default", label: string) => (
    <Switch on={!!p?.[k]} disabled={!admin || !p} label={label} onClick={() => p && setP({ ...p, [k]: !p[k] })} />
  );
  // Option labels are SET_ADMIN keys.
  const days: [number, string][] = [[30, "d30"], [90, "d90"], [180, "d180"], [365, "y1"], [730, "y2"]];
  const toggleRole = (role: StaffRole) => {
    if (!p || role === "admin") return;
    const has = p.privileged_roles.includes(role);
    setP({ ...p, privileged_roles: has ? p.privileged_roles.filter((x) => x !== role) : [...p.privileged_roles, role] });
  };
  const sub = (s: string) => <small style={{ display: "block" }}>{s}</small>;

  return (
    <>
      <PageHead title={t("navPrivacy")} sub={t("privSub")} />
      {!admin && <ReadOnlyNote who={t("superAdmin")} />}
      <div className="half">
        <div className="panel">
          <h2>{t("controls")} <small>{t("enforced")}</small></h2>
          <div className="tblwrap">
            <table>
              <tbody>
                <tr><td>{t("cMaskPhone")}{sub(t("cMaskPhoneS"))}</td><td className="num">{sw("mask_phone", t("cMaskPhoneL"))}</td></tr>
                <tr><td>{t("cMaskId")}{sub(t("cMaskIdS"))}</td><td className="num">{sw("mask_id", t("cMaskId"))}</td></tr>
                <tr><td>{t("cAddr")}{sub(t("cAddrS"))}</td><td className="num"><span className="st ok">{t("alwaysOn")}</span></td></tr>
                <tr><td>{t("cUsage")}{sub(t("cUsageS"))}</td><td className="num">{sw("usage_data_default", t("cUsageL"))}</td></tr>
                <tr><td>{t("cGps")}{sub(t("cGpsS"))}</td><td className="num">{sel("retention_gps_days", days, t("cGps"))}</td></tr>
                <tr><td>{t("cChat")}{sub(t("cChatS"))}</td><td className="num">{sel("retention_chat_days", days.filter(([d]) => d >= 30), t("cChat"))}</td></tr>
                <tr><td>{t("cPhotos")}{sub(t("cPhotosS"))}</td><td className="num">{sel("retention_photo_days", [[90, "d90"], [180, "d180"], [365, "y1"], [730, "y2"], [1825, "y5"]], t("cPhotos"))}</td></tr>
                <tr><td>{t("cAddrKeep")}{sub(t("cAddrKeepS"))}</td><td className="num">{sel("retention_orders_years", [[5, "y5"], [7, "y7"], [10, "y10"]], t("cAddrKeep"))}</td></tr>
                <tr>
                  <td>{t("cReveal")}{sub(t("cRevealS"))}</td>
                  <td className="num">
                    <div className="checks" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", fontSize: 12.5 }}>
                      {ROLES.map((role) => (
                        <label key={role}>
                          <input type="checkbox" disabled={!admin || !p || role === "admin"} checked={!!p?.privileged_roles?.includes(role)} onChange={() => toggleRole(role)} /> {staffRoleLabel(role, lang)}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {admin && (
            <div className="pad" style={{ paddingTop: 12 }}>
              <div className="btns">
                <button className="btn pri" disabled={!dirty} onClick={save}>{t("saveChanges")}</button>
                {dirty && <button className="btn" onClick={() => setP(saved)}>{t("discard")}</button>}
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="panel">
            <h2>{t("hostingTitle")}</h2>
            <dl className="kv" style={{ paddingTop: 8 }}>
              <dt>{t("hosting")}</dt><dd>{t("hostingV")}</dd>
              <dt>{t("owner")}</dt><dd>{t("ownerV")}</dd>
              <dt>{t("encryption")}</dt><dd>{t("encryptionV")}</dd>
              <dt>{t("sharing")}</dt><dd>{consent ? (consent.n ? t("sharingV", { pct: f.pct(consent.share / consent.n), n: f.n(consent.share), total: f.n(consent.n) }) : "—") : "…"}</dd>
              <dt>{t("reminders")}</dt><dd>{t("remindersV")}</dd>
              <dt>{t("staffAccess")}</dt><dd>{t("staffAccessV")}</dd>
            </dl>
            <p className="note">{t("pdplNote", { n: f.n(DUE_DAYS) })}</p>
          </div>
          <div className="panel">
            <h2>{t("retJob")} <small>{t("retJobS")}</small></h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>{t("dueRemoval")}</th><th className="num">{t("items")}</th></tr></thead>
                <tbody>
                  {!admin && <Empty cols={2}>{t("visibleAdmins")}</Empty>}
                  {admin && !preview && <Empty cols={2}>{t("counting")}</Empty>}
                  {preview && (Object.keys(RET_LABEL) as (keyof Retention)[]).map((k) => (
                    <tr key={k}><td>{t(RET_LABEL[k])}</td><td className="num">{f.n(preview[k] ?? 0)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs && runs.length > 0 && (
              <p className="note">{t("lastRun", { at: f.dateTime(runs[0].ran_at), list: retList(runs[0].result) })}</p>
            )}
            {admin && <div className="pad"><button className="btn bad" onClick={runRetention}>{t("runRetT")}</button></div>}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>{t("dataReqs")} <small>{t("nOpen", { n: f.n(reqs?.filter((r) => r.state === "open").length ?? 0) })}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("request")}</th><th>{t("customer")}</th><th>{t("type")}</th><th>{t("received")}</th><th>{t("status")}</th><th></th></tr></thead>
            <tbody>
              {!reqs && <Empty cols={6}>{t("loading")}</Empty>}
              {reqs?.length === 0 && <Empty cols={6}>{t("noDataReqs")}</Empty>}
              {reqs?.map((r) => {
                const due = Math.ceil((new Date(r.created_at).getTime() + DUE_DAYS * 86400_000 - now) / 86400_000);
                return (
                  <tr key={r.id}>
                    <td><b dir="ltr">{ref.dataRequest(r.ref_no)}</b>{r.details && <small style={{ display: "block" }}>{r.details}</small>}</td>
                    <td>{r.customer?.full_name || t("customer")}</td>
                    <td>{t(KIND[r.kind])}</td>
                    <td><small>{f.dateTime(r.created_at)}</small></td>
                    <td>
                      {r.state === "open" ? (
                        <span className={`st ${due < 0 ? "bad" : due <= 7 ? "warn" : "act"}`}>{due < 0 ? t("overdue", { n: f.n(-due) }) : t("dueIn", { n: f.n(due) })}</span>
                      ) : (
                        <span className={`st ${r.state === "completed" ? "ok" : ""}`}>{t(r.state === "completed" ? "completedOn" : "rejectedOn", { date: f.date(r.closed_at) })}</span>
                      )}
                      {r.result_note && <small style={{ display: "block" }}>{r.result_note}</small>}
                    </td>
                    <td className="num">
                      {admin && r.state === "open" && (
                        <div className="btns" style={{ justifyContent: "flex-end" }}>
                          {r.kind === "correct" ? (
                            <button className="btn sm pri" onClick={() => close(r, "completed")}>{t("complete")}</button>
                          ) : (
                            <button className={`btn sm ${r.kind === "delete" ? "bad" : "pri"}`} onClick={() => process(r)}>{r.kind === "access" ? t("prepExport") : t("eraseShort")}</button>
                          )}
                          <button className="btn sm" onClick={() => close(r, "rejected")}>{t("reject")}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {dialog}
    </>
  );
}
