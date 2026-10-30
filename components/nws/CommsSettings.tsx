"use client";

// Panels of the sign-in, messaging and support batch on NWS settings pages:
//   <SenderIds />       Notifications: transactional / marketing SMS sender IDs and the marketing rules (0038)
//   <DelayMessages />   Notifications: thresholds of the automatic delay messages (DELAY_NOTICES, 0038)
//   <IdentityRule />    Privacy: which orders need an ID on the account (IDENTITY_REQUIRED_FOR, 0037)
// Every change is audited (asks for a reason).
import { useCallback, useEffect, useState } from "react";
import { useAudited, useRun } from "@/components/nws/admin/ui";
import { SUPPORT } from "@/components/nws/i18n/support";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

/** An app_settings JSON value; fallback is JSON text (a stable dependency). */
function useSetting<T>(key: string, fallback: string) {
  const [v, setV] = useState<T | null>(null);
  const load = useCallback(() => {
    supabase()
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle<{ value: string }>()
      .then(({ data }) => {
        try {
          setV(JSON.parse(data ? data.value : fallback) as T);
        } catch {
          setV(JSON.parse(fallback) as T);
        }
      });
  }, [key, fallback]);
  useEffect(load, [load]);
  return [v, load] as const;
}

type Notify = { sender_id?: string; sender_ids?: { transactional?: string; marketing?: string }; quiet_hours?: { start?: number; end?: number } };

export function SenderIds() {
  const t = useT(SUPPORT);
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const admin = can("admin");
  const [cfg, reload] = useSetting<Notify>("NOTIFY", "{}");
  const [tr, setTr] = useState<string | null>(null);
  const [mk, setMk] = useState<string | null>(null);
  const trV = tr ?? cfg?.sender_ids?.transactional ?? cfg?.sender_id ?? "";
  const mkV = mk ?? cfg?.sender_ids?.marketing ?? "";
  const q = cfg?.quiet_hours ?? {};
  function save() {
    ask({
      title: t("sSaveQ"),
      confirm: t("sSave"),
      ok: t("sSaved"),
      run: (reason) => supabase().rpc("staff_set_sender_ids", { p_transactional: trV.trim(), p_marketing: mkV.trim(), p_reason: reason }),
      done: () => {
        setTr(null);
        setMk(null);
        reload();
      },
    });
  }
  return (
    <div className="panel">
      <h2>
        {t("sendersT")} <small>{t("sendersSub")}</small>
      </h2>
      <div className="pad">
        <div className="row2">
          <div className="fld">
            <label htmlFor="snd-t">{t("sTrans")}</label>
            <input id="snd-t" className="in" dir="ltr" maxLength={11} disabled={!admin} value={trV} onChange={(e) => setTr(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="snd-m">{t("sMkt")}</label>
            <input id="snd-m" className="in" dir="ltr" maxLength={11} disabled={!admin} value={mkV} onChange={(e) => setMk(e.target.value)} />
          </div>
        </div>
        {admin && (
          <button className="btn" disabled={!cfg || (tr == null && mk == null)} onClick={save}>
            {t("sSave")}
          </button>
        )}
        <p className="note">{t("quietNote", { s: String(q.start ?? 21), e: String(q.end ?? 8).padStart(2, "0") })}</p>
      </div>
      {dialog}
    </div>
  );
}

type Delay = { enabled: boolean; unassigned_min: number; eta_slip_min: number; fill_min: number };
const DELAY_DEFAULT: Delay = { enabled: true, unassigned_min: 20, eta_slip_min: 15, fill_min: 20 };

export function DelayMessages() {
  const t = useT(SUPPORT);
  const f = useFmt();
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const admin = can("admin");
  const [cfg, reload] = useSetting<Delay>("DELAY_NOTICES", JSON.stringify(DELAY_DEFAULT));
  const [edit, setEdit] = useState<Delay | null>(null);
  const v = edit ?? { ...DELAY_DEFAULT, ...(cfg ?? {}) };
  const num = (k: keyof Omit<Delay, "enabled">, label: string, min: number, max: number) => (
    <div className="fld">
      <label htmlFor={`dl-${k}`}>{label}</label>
      <input id={`dl-${k}`} className="in" type="number" min={min} max={max} disabled={!admin} value={v[k]} onChange={(e) => setEdit({ ...v, [k]: Number(e.target.value) })} />
    </div>
  );
  async function scan() {
    const { data, error } = await supabase().rpc("scan_delay_notices");
    const r = (data ?? {}) as { enabled?: boolean; unassigned?: number; eta_slip?: number; late?: number; dispatch?: number };
    await run(
      Promise.resolve({ error }),
      r.enabled === false ? t("dOff") : t("dRan", { u: f.n(r.unassigned ?? 0), e: f.n(r.eta_slip ?? 0), l: f.n(r.late ?? 0), d: f.n(r.dispatch ?? 0) }),
    );
  }
  return (
    <div className="panel">
      <h2>
        {t("delayT")} <small>{t("delaySub")}</small>
      </h2>
      <div className="pad">
        <label style={{ display: "block", marginBottom: 10, fontSize: 13.5 }}>
          <input type="checkbox" disabled={!admin} checked={v.enabled} onChange={(e) => setEdit({ ...v, enabled: e.target.checked })} /> {t("dEnabled")}
        </label>
        <div className="row2">
          {num("unassigned_min", t("dUnassigned"), 5, 240)}
          {num("eta_slip_min", t("dSlip"), 5, 180)}
        </div>
        <div className="row2">{num("fill_min", t("dFill"), 0, 120)}</div>
        <div className="btns">
          {admin && (
            <button
              className="btn pri"
              disabled={!edit}
              onClick={() =>
                ask({
                  title: t("dSaveQ"),
                  confirm: t("dSave"),
                  ok: t("dSaved"),
                  run: (reason) => supabase().rpc("staff_update_comms_setting", { p_key: "DELAY_NOTICES", p_value: v, p_reason: reason }),
                  done: () => {
                    setEdit(null);
                    reload();
                  },
                })
              }
            >
              {t("dSave")}
            </button>
          )}
          {can("operator") && (
            <button className="btn" onClick={scan}>
              {t("dRun")}
            </button>
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}

const SCOPES = ["all", "household", "business", "scheduled", "emergency"] as const;

export function IdentityRule() {
  const t = useT(SUPPORT);
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const admin = can("admin");
  const [cfg, reload] = useSetting<string[]>("IDENTITY_REQUIRED_FOR", "[]");
  const [edit, setEdit] = useState<string[] | null>(null);
  const v = edit ?? (Array.isArray(cfg) ? cfg : []);
  const toggle = (s: string, on: boolean) => setEdit(on ? [...v.filter((x) => x !== s), s] : v.filter((x) => x !== s));
  return (
    <div className="panel">
      <h2>
        {t("idT")} <small>{t("idSub")}</small>
      </h2>
      <div className="pad">
        <div className="checks" style={{ marginBottom: 12 }}>
          {SCOPES.map((s) => (
            <label key={s}>
              <input type="checkbox" disabled={!admin} checked={v.includes(s)} onChange={(e) => toggle(s, e.target.checked)} /> {t(`id_${s}`)}
            </label>
          ))}
        </div>
        {v.length === 0 && <p className="note">{t("idNone")}</p>}
        {admin && (
          <button
            className="btn pri"
            disabled={!edit}
            onClick={() =>
              ask({
                title: t("idSaveQ"),
                confirm: t("idSave"),
                ok: t("idSaved"),
                run: (reason) => supabase().rpc("staff_update_comms_setting", { p_key: "IDENTITY_REQUIRED_FOR", p_value: v, p_reason: reason }),
                done: () => {
                  setEdit(null);
                  reload();
                },
              })
            }
          >
            {t("idSave")}
          </button>
        )}
      </div>
      {dialog}
    </div>
  );
}
