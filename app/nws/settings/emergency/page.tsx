"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited, useRun } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Emergency = { on: boolean; zone: string | null; reason: string | null; since: string | null };
type Hist = { id: number; at: string; actor_email: string | null; action: string; reason: string | null; before: Emergency | null; after: Emergency | null };

export default function EmergencyPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [em, setEm] = useState<Emergency | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [zone, setZone] = useState("");
  const [reason, setReason] = useState("");
  const [hist, setHist] = useState<Hist[] | null>(null);
  const editor = can("admin", "operator");

  const load = useCallback(() => {
    const db = supabase();
    db.from("app_settings").select("value").eq("key", "EMERGENCY").maybeSingle().then(({ data }) => {
      const v = data?.value ? (JSON.parse(data.value as string) as Emergency) : { on: false, zone: null, reason: null, since: null };
      setEm(v);
      if (v.zone) setZone(v.zone);
    });
    db.from("zones").select("name").eq("active", true).eq("is_test", false).order("name").then(({ data }) => {
      const names = ((data ?? []) as { name: string }[]).map((z) => z.name);
      setZones(names);
      setZone((z) => z || names[0] || "");
    });
    db.from("audit_log").select("id, at, actor_email, action, reason, before, after").like("action", "emergency.%").order("id", { ascending: false }).limit(10)
      .then(({ data }) => setHist((data ?? []) as Hist[]));
  }, []);
  useEffect(load, [load]);

  async function activate() {
    if (await run(supabase().rpc("staff_set_emergency", { p_on: true, p_zone: zone, p_reason: reason.trim() }), t("emActiveOk", { zone }))) {
      setReason("");
      load();
    }
  }
  function deactivate() {
    ask({
      title: t("emEnd"),
      body: t("emEndB", { zone: em?.zone ?? t("emTheZone") }),
      confirm: t("emEnd"),
      ok: t("emEndedOk"),
      run: (r) => supabase().rpc("staff_set_emergency", { p_on: false, p_zone: null, p_reason: r }),
      done: load,
    });
  }

  return (
    <>
      <PageHead title={t("emTitle")} sub={t("emSub")} />
      {!editor && <ReadOnlyNote who={t("whoAdminOps")} />}
      {em?.on && (
        <div className="banner badb">
          <b>{t("emActiveIn", { zone: em.zone ?? "" })}</b> {t("emSince", { at: f.dateTime(em.since) })} — «{em.reason}»
        </div>
      )}
      <div className="half">
        <div className="panel">
          <h2>
            <span>{t("emTitle")} {em == null ? null : em.on ? <span className="st bad">{t("active")}</span> : <span className="st">{t("off")}</span>}</span>
          </h2>
          <div className="pad">
            {em?.on ? (
              <>
                <dl className="kv" style={{ padding: "4px 0 14px" }}>
                  <dt>{t("emZone")}</dt><dd>{em.zone}</dd>
                  <dt>{t("emSinceL")}</dt><dd>{f.dateTime(em.since)}</dd>
                  <dt>{t("reason")}</dt><dd>{em.reason}</dd>
                </dl>
                <button className="btn" disabled={!editor} onClick={deactivate}>{t("emEnd")}</button>
              </>
            ) : (
              <>
                <div className="fld">
                  <label htmlFor="em-zone">{t("emZone")}</label>
                  <select id="em-zone" className="in" value={zone} disabled={!editor} onChange={(e) => setZone(e.target.value)}>
                    {zones.map((z) => <option key={z}>{z}</option>)}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="em-reason">{t("emReasonL")}</label>
                  <input id="em-reason" className="in" value={reason} disabled={!editor} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t("emReasonHint")} />
                </div>
                <button className="btn pri" disabled={!editor || !zone || reason.trim().length < 3} onClick={activate}>{t("emActivate")}</button>
              </>
            )}
          </div>
        </div>
        <div className="panel">
          <h2>{t("emWhat")}</h2>
          <ul className="plain">
            {["emW1", "emW2", "emW3", "emW4", "emW5"].map((k) => <li key={k}>{t(k)}</li>)}
          </ul>
        </div>
      </div>
      <div className="panel">
        <h2>{t("emHistory")}</h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("emWhen")}</th><th>{t("emAction")}</th><th>{t("zone")}</th><th>{t("payBy")}</th><th>{t("reason")}</th></tr></thead>
            <tbody>
              {hist?.length === 0 && <Empty cols={5}>{t("emNone")}</Empty>}
              {hist?.map((h) => (
                <tr key={h.id}>
                  <td><small>{f.dateTime(h.at)}</small></td>
                  <td>{h.action === "emergency.activate" ? <span className="st bad">{t("emActivated")}</span> : <span className="st">{t("emEnded")}</span>}</td>
                  <td>{(h.action === "emergency.activate" ? h.after?.zone : h.before?.zone) ?? "—"}</td>
                  <td><bdi dir="ltr">{h.actor_email ?? "—"}</bdi></td>
                  <td>{h.reason}</td>
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
