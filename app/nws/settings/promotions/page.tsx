"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";
import type { Promotion } from "@/lib/types";

type Loyalty = { points_per_omr: number; redeem_points: number; redeem_omr: number };
// Audience → dictionary key.
const AUDIENCE: Record<string, string> = { all: "pmAudAll", new: "pmAudNew", household: "pmAudHousehold", business: "pmAudBusiness" };
const upsert = (p: Omit<Promotion, "uses" | "pct"> & { pct: number }, reason: string) =>
  supabase().rpc("staff_upsert_promotion", {
    p_code: p.code, p_label: p.label, p_pct: p.pct, p_audience: p.audience, p_max_uses: p.max_uses, p_active: p.active, p_valid_to: p.valid_to || null, p_reason: reason,
  });

export default function PromotionsPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [promos, setPromos] = useState<Promotion[] | null>(null);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [form, setForm] = useState<Loyalty | null>(null);
  const [edit, setEdit] = useState<Promotion | "new" | null>(null);
  const promoEditor = can("admin", "finance");
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("promotions").select("*").order("active", { ascending: false }).order("code").then(({ data }) => setPromos((data ?? []) as Promotion[]));
    db.from("app_settings").select("value").eq("key", "LOYALTY").maybeSingle().then(({ data }) => {
      const v = data?.value ? (JSON.parse(data.value as string) as Loyalty) : { points_per_omr: 1, redeem_points: 100, redeem_omr: 1 };
      setLoyalty(v);
      setForm(v);
    });
  }, []);
  useEffect(load, [load]);

  function toggle(p: Promotion) {
    ask({
      title: t(p.active ? "pmPauseT" : "pmActivateT", { code: p.code }),
      body: p.active ? t("pmPauseB") : t("pmActivateB"),
      confirm: p.active ? t("pmPauseC") : t("pmActivateC"),
      ok: p.active ? t("pmPausedOk") : t("pmActiveOk"),
      run: (reason) => upsert({ ...p, pct: Number(p.pct), active: !p.active }, reason),
      done: load,
    });
  }

  function saveLoyalty() {
    if (!form) return;
    ask({
      title: t("lyUpdateT"),
      body: t("lyUpdateB", { earn: f.n(form.points_per_omr, 1), points: f.n(form.redeem_points), omr: f.n3(form.redeem_omr) }),
      confirm: t("lySave"),
      ok: t("lySaved"),
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "LOYALTY", p_value: form, p_reason: reason }),
      done: load,
    });
  }

  const dirty = form && loyalty && JSON.stringify(form) !== JSON.stringify(loyalty);
  const num = (k: keyof Loyalty, step = 1) => (
    <input className="inl" type="number" min={0} step={step} dir="ltr" aria-label={t(`ly_${k}`)} disabled={!admin} value={form?.[k] ?? ""} onChange={(e) => form && setForm({ ...form, [k]: Number(e.target.value) })} />
  );

  return (
    <>
      <PageHead title={t("pmTitle")} sub={t("pmSub")} />
      {!promoEditor && <ReadOnlyNote who={t("whoAdminFinance")} />}
      <div className="wide">
        <div className="panel">
          <div className="toolbar">
            <b style={{ fontSize: 15 }}>{t("pmCampaigns")}</b>
            {promoEditor && <button className="btn pri" onClick={() => setEdit("new")}>{t("pmNew")}</button>}
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>{t("pmCodeH")}</th><th className="num">{t("pmDiscount")}</th><th>{t("pmAudience")}</th><th className="num">{t("pmUses")}</th><th>{t("pmValidTo")}</th><th>{t("active")}</th><th></th></tr>
              </thead>
              <tbody>
                {!promos && <Empty cols={7}>{t("loading")}</Empty>}
                {promos?.length === 0 && <Empty cols={7}>{t("pmNone")}</Empty>}
                {promos?.map((p) => {
                  const expired = p.valid_to != null && p.valid_to < omanToday();
                  return (
                    <tr key={p.code}>
                      <td><b dir="ltr">{p.code}</b><small style={{ display: "block" }}>{p.label}</small></td>
                      <td className="num">{f.pct(Number(p.pct), 0)}</td>
                      <td>{AUDIENCE[p.audience] ? t(AUDIENCE[p.audience]) : p.audience}</td>
                      <td className="num">{f.n(p.uses)} <small>/ {f.n(p.max_uses)}</small></td>
                      <td>{p.valid_to ? <>{f.date(p.valid_to)}{expired && <span className="st warn ptag">{t("expired")}</span>}</> : <span className="mut">{t("pmNoEnd")}</span>}</td>
                      <td><Switch on={p.active} disabled={!promoEditor} label={p.active ? t("active") : t("pmPaused")} onClick={() => toggle(p)} /></td>
                      <td className="num">{promoEditor && <button className="btn sm" onClick={() => setEdit(p)}>{t("edit")}</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">{t("pmNote")}</p>
        </div>

        <div className="panel">
          <h2>{t("lyTitle")}</h2>
          <div className="tblwrap">
            <table>
              <tbody>
                <tr><td>{t("ly_points_per_omr")} <span className="st warn ptag">{t("stAssumption")}</span></td><td className="num">{num("points_per_omr", 0.5)}</td></tr>
                <tr><td>{t("ly_redeem_points")}</td><td className="num">{num("redeem_points", 10)}</td></tr>
                <tr><td>{t("ly_redeem_omr")}</td><td className="num">{num("redeem_omr", 0.5)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="pad" style={{ paddingTop: 12 }}>
            {admin ? (
              <button className="btn pri" disabled={!dirty} onClick={saveLoyalty}>{t("lySave")}</button>
            ) : (
              <small className="mut">{t("lyByAdmin")}</small>
            )}
          </div>
          <p className="note">{t("lyNote")}</p>
        </div>
      </div>
      {edit && <PromoDialog promo={edit === "new" ? null : edit} taken={(promos ?? []).map((x) => x.code)} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      {dialog}
    </>
  );
}

function PromoDialog({ promo, taken, onClose, onDone }: { promo: Promotion | null; taken: string[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const [code, setCode] = useState(promo?.code ?? "");
  const [label, setLabel] = useState(promo?.label ?? "");
  const [pctV, setPct] = useState(promo ? String(Math.round(Number(promo.pct) * 100)) : "10");
  const [audience, setAudience] = useState(promo?.audience ?? "all");
  const [maxUses, setMaxUses] = useState(String(promo?.max_uses ?? 1000));
  const [validTo, setValidTo] = useState(promo?.valid_to ?? "");
  const [active, setActive] = useState(promo?.active ?? true);
  return (
    <ReasonDialog
      title={promo ? t("prEditTitle", { key: promo.code }) : t("pmNew")}
      confirm={promo ? t("pmSaveC") : t("pmCreateC")}
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pm-code">{t("pmCodeH")}</label>
              <input id="pm-code" className="in" dir="ltr" value={code} disabled={!!promo} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="SUMMER10" />
            </div>
            <div className="fld">
              <label htmlFor="pm-pct">{t("pmPctL")}</label>
              <input id="pm-pct" className="in" type="number" dir="ltr" min={1} max={50} value={pctV} onChange={(e) => setPct(e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <label htmlFor="pm-label">{t("pmLabelL")}</label>
            <input id="pm-label" className="in" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pm-aud">{t("pmAudience")}</label>
              <select id="pm-aud" className="in" value={audience} onChange={(e) => setAudience(e.target.value)}>
                {Object.entries(AUDIENCE).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="pm-max">{t("pmMax")}</label>
              <input id="pm-max" className="in" type="number" dir="ltr" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </div>
          </div>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pm-to">{t("pmValidToOpt")}</label>
              <input id="pm-to" className="in" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
            <div className="fld">
              <label>{t("status")}</label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, paddingTop: 6 }}>
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t("active")}
              </label>
            </div>
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const pct = Number(pctV) / 100;
        if (!/^[A-Z0-9]{3,20}$/.test(code)) return toast(t("pmBadCode"), true);
        // Saving is an upsert, so a new campaign with an existing code would overwrite it.
        if (!promo && taken.includes(code)) return toast(t("pmTaken", { code }), true);
        if (!label.trim()) return toast(t("pmNoLabel"), true);
        if (!(pct > 0 && pct <= 0.5)) return toast(t("pmBadPct"), true);
        const { error } = await upsert({ code, label: label.trim(), pct, audience, max_uses: Math.max(1, Number(maxUses) || 1), active, valid_to: validTo || null }, reason);
        if (error) return toast(friendlyError(error, lang), true);
        toast(promo ? t("pmSavedOk") : t("pmCreatedOk", { code }));
        onDone();
      }}
    />
  );
}
