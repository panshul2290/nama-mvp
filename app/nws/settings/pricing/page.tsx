"use client";

import { useCallback, useEffect, useState } from "react";
import { DeliveryChargesPanel, PlatformFeesPanel, TariffClassesPanel, useTariff } from "@/components/nws/admin/TariffPanels";
import { PageHead, ReadOnlyNote } from "@/components/nws/admin/ui";
import { MONEY } from "@/components/nws/i18n/money";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { fmtNumber, useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import { SERVICE_LABEL, type RuleStatus, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

type Rule = { rule_key: string; value: string; status: RuleStatus; source: string; notes: string; updated_at: string };
// Status → [dictionary key, tone].
const BADGE: Record<RuleStatus, [string, string]> = {
  confirmed: ["stConfirmed", "ok"],
  pending_clarification: ["stPending", "warn"],
  assumption: ["stAssumption", "warn"],
};

// Display order and labels (dictionary keys), as in the prototype's pricing screen.
// The delivery charge itself is per zone and capacity class (0034, DeliveryChargesPanel).
const FEE_ENGINE: [string, string][] = [
  ["peak_multiplier", "prPeak"],
  ["priority_multiplier", "prPriority"],
  ["discount_monthly", "prDiscMonthly"],
  ["discount_yearly", "prDiscYearly"],
  ["driver_share", "prDriverShare"],
  ["vat_rate", "prVat"],
  ["cancel_fee_omr", "prCancelFee"],
];
// Dynamic factors (0026): distance and demand multiply the delivery fee next to peak and priority.
const DYNAMIC: [string, string, string][] = [
  ["distance_free_km", "prDistFree", "uKm"],
  ["distance_per_km", "prDistPerKm", "uPerKm"],
  ["distance_cap", "prDistCap", "uX"],
  ["demand_min_open", "prDemandMin", "uOpenReq"],
  ["demand_ratio_threshold", "prDemandStart", "uReqPerTanker"],
  ["demand_step", "prDemandStep", "uX"],
  ["demand_cap", "prDemandCap", "uX"],
  ["dynamic_cap", "prDynCap", "uX"],
];

type Factors = { base_fee: number; multiplier: number; peak_mult: number; priority_mult: number; distance_km: number | null; distance_mult: number; demand_ratio: number; demand_mult: number; located: boolean };
type QuoteRes = { water_charge: number; delivery_fee: number; discount: number; vat: number; total: number; driver_earnings: number; total_status: RuleStatus; peak: boolean; priority: boolean; discount_pct: number; promo_label: string | null; factors?: Factors;
  tariff?: { code: string }; delivery?: { is_default: boolean; zone: string | null } };

export default function PricingPage() {
  const { can } = useStaff();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [edit, setEdit] = useState<Rule | null>(null);
  const editor = can("admin", "finance");
  const tariff = useTariff();

  const load = useCallback(() => {
    const db = supabase();
    Promise.all([
      db.from("pricing_rules").select("rule_key, value, status, source, notes, updated_at").order("rule_key"),
      db.from("app_settings").select("value").eq("key", "BILLING_MODE").maybeSingle(),
    ]).then(([r, m]) => {
      setRules((r.data ?? []) as Rule[]);
      setMode((m.data?.value as string) ?? null);
    });
  }, []);
  useEffect(load, [load]);

  const byKey = new Map(rules?.map((r) => [r.rule_key, r]));
  // Rules, tariff classes and delivery charges all carry a status.
  const count = (s: RuleStatus) =>
    (rules?.filter((r) => r.status === s).length ?? 0) +
    (tariff.classes?.filter((c) => c.active && c.status === s).length ?? 0) +
    tariff.charges.filter((d) => d.status === s).length;
  const row = (key: string, label: React.ReactNode, unit = "") => {
    const r = byKey.get(key);
    if (!r) return null;
    const named = r.value === "slab" || r.value === "whole_volume";
    return (
      <tr key={key}>
        <td>
          {label}
          <small style={{ display: "block" }} title={r.notes}>{t("prSourceUpdated", { source: r.source, at: f.dateTime(r.updated_at) })}</small>
        </td>
        <td><span className={`st ${BADGE[r.status][1]}`}>{t(BADGE[r.status][0])}</span></td>
        <td className="num">
          <b dir={named ? undefined : "ltr"}>{r.value === "slab" ? t("prSlab") : r.value === "whole_volume" ? t("prWhole") : r.value}</b>
          {unit && <small> {t(unit)}</small>}
        </td>
        <td className="num">{editor && <button className="btn sm" onClick={() => setEdit(r)}>{t("edit")}</button>}</td>
      </tr>
    );
  };

  return (
    <>
      <PageHead title={t("prTitle")} sub={t("prSub")} />
      {!editor && <ReadOnlyNote who={t("whoAdminFinance")} />}
      <div className="okpis">
        <div className="okpi">
          {/* i18n-ignore: setting name */}
          <span>BILLING_MODE</span>
          <b dir="ltr">{mode ?? "—"}</b>
          <small className={mode === "production" ? "ok" : "warn"}>{mode === "production" ? t("prModeProd") : t("prModeOther")}</small>
        </div>
        <div className="okpi"><span>{t("stConfirmed")}</span><b>{f.n(count("confirmed"))}</b><small className="ok">{t("prFromTender")}</small></div>
        <div className="okpi"><span>{t("prPendingKpi")}</span><b>{f.n(count("pending_clarification"))}</b><small className="warn">{t("prAwaitingNws")}</small></div>
        <div className="okpi"><span>{t("prAssumptionsKpi")}</span><b>{f.n(count("assumption"))}</b><small className="warn">{t("prNoBasis")}</small></div>
      </div>

      <div className="two">
        <div className="panel">
          <h2>{t("prEngine")} <small>{t("prEngineSub")}</small></h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {!rules && <tr><td className="empty">{t("loading")}</td></tr>}
                {FEE_ENGINE.map(([k, l]) => row(k, t(l)))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="stack">
          <TariffClassesPanel classes={tariff.classes} editor={editor} onChanged={tariff.reload} basisRow={row("tariff_basis", t("prUpperTier"))} />
          <DeliveryChargesPanel classes={tariff.classes} charges={tariff.charges} zones={tariff.zones} editor={editor} onChanged={tariff.reload} />
          <div className="panel">
            <h2>{t("prDynamic")} <small>{t("prDynamicSub")}</small></h2>
            <div className="tblwrap">
              <table>
                <tbody>{DYNAMIC.map(([k, l, u]) => row(k, t(l), u))}</tbody>
              </table>
            </div>
            <p className="note">{t("prDynamicNote")}</p>
          </div>
          <PriceCheck />
        </div>
      </div>
      <PlatformFeesPanel editor={editor} />
      {edit && <EditRule rule={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
    </>
  );
}

function EditRule({ rule, onClose, onDone }: { rule: Rule; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const [value, setValue] = useState(rule.value);
  const [status, setStatus] = useState<RuleStatus>(rule.status);
  const [source, setSource] = useState(rule.source);
  return (
    <ReasonDialog
      title={t("prEditTitle", { key: rule.rule_key })}
      body={rule.notes}
      confirm={t("prSaveRule")}
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pr-v">{t("prValue")}</label>
              {rule.rule_key === "tariff_basis" ? (
                <select id="pr-v" className="in" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="slab">{t("prSlab")}</option>
                  <option value="whole_volume">{t("prWhole")}</option>
                </select>
              ) : (
                <input id="pr-v" className="in" inputMode="decimal" dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} />
              )}
            </div>
            <div className="fld">
              <label htmlFor="pr-s">{t("status")}</label>
              <select id="pr-s" className="in" value={status} onChange={(e) => setStatus(e.target.value as RuleStatus)}>
                {(Object.keys(BADGE) as RuleStatus[]).map((s) => <option key={s} value={s}>{t(BADGE[s][0])}</option>)}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="pr-src">{t("prSource")}</label>
            <input id="pr-src" className="in" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t("prSourceHint")} />
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_update_pricing_rule", { p_rule_key: rule.rule_key, p_value: value.trim(), p_status: status, p_source: source, p_reason: reason });
        if (error) return toast(friendlyError(error, lang), true);
        toast(t("prUpdated"));
        onDone();
      }}
    />
  );
}

function PriceCheck() {
  const { lang } = useLang();
  const t = useT(SETTINGS_OPS);
  const tm = useT(MONEY);
  const f = useFmt();
  const [service, setService] = useState<ServiceType>("DW");
  const [gallons, setGallons] = useState("3000");
  const [peak, setPeak] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [promo, setPromo] = useState("");
  const [pin, setPin] = useState("");
  const [q, setQ] = useState<QuoteRes | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    // quote_order decides "peak" from the slot time: 18:30 Muscat for peak, 10:00 otherwise.
    const d = new Date();
    d.setUTCHours(peak ? 14 : 6, peak ? 30 : 0, 0, 0);
    const m = pin.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (pin.trim() && !m) return setErr(t("pcPinBad"));
    const { data, error } = await supabase().rpc("quote_order", {
      p_service_type: service, p_gallons: Number(gallons), p_slot_start: d.toISOString(), p_emergency: emergency, p_promo_code: promo.trim() || null,
      p_lat: m ? Number(m[1]) : null, p_lng: m ? Number(m[2]) : null,
    });
    setErr(error ? friendlyError(error, lang) : null);
    setQ(error ? null : (data as QuoteRes));
  }

  // A multiplier as it comes from the database ("1.25×"), in the portal's digits.
  const x = (v: number) => `${fmtNumber(v, lang, { maximumFractionDigits: 3 })}×`;
  return (
    <div className="panel pcheck">
      <h2>{t("pcTitle")} <small>{t("pcSub")}</small></h2>
      <div className="pad">
        <div className="form">
          <div className="fld">
            <label htmlFor="pc-s">{t("service")}</label>
            <select id="pc-s" className="in" value={service} onChange={(e) => setService(e.target.value as ServiceType)}>
              {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((s) => <option key={s} value={s}>{serviceLabel(s, lang)}</option>)}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="pc-g">{t("gallons")}</label>
            <input id="pc-g" className="in" type="number" dir="ltr" min={1} max={20000} value={gallons} onChange={(e) => setGallons(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="pc-p">{t("pmCode")}</label>
            <input id="pc-p" className="in" dir="ltr" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder={t("optionalCap")} />
          </div>
          <div className="fld">
            <label htmlFor="pc-pin">{t("pcPin")}</label>
            <input id="pc-pin" className="in" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={t("pcPinHint")} dir="ltr" />
          </div>
        </div>
        <div className="checks" style={{ display: "flex", gap: 16, margin: "10px 0", fontSize: 13.5 }}>
          <label><input type="checkbox" checked={peak} onChange={(e) => setPeak(e.target.checked)} /> {t("pcPeak")}</label>
          <label><input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} /> {t("pcEmergency")}</label>
        </div>
        <button className="btn pri" onClick={check}>{t("pcCalc")}</button>
        {err && <div className="banner badb" style={{ marginTop: 12 }}>{err}</div>}
      </div>
      {q && (
        <div className="bill">
          <div><span>{t("pcWater")}</span><span>{f.n3(q.water_charge)}</span></div>
          <div><span>{t("pcFee")}{q.peak ? ` · ${t("pcPeakTag")}` : ""}{q.priority ? ` · ${t("pcEmergencyTag")}` : ""}</span><span>{f.n3(q.delivery_fee)}</span></div>
          {Number(q.discount) > 0 && <div><span>{t("pcDiscount", { pct: f.pct(q.discount_pct, 0) })}{q.promo_label ? ` · ${q.promo_label}` : ""}</span><span>−{f.n3(q.discount)}</span></div>}
          <div><span>{t("prVat")}</span><span>{f.n3(q.vat)}</span></div>
          <div className="tot"><span>{t("pcTotal")} {q.total_status !== "confirmed" && <span className={`st ptag ${BADGE[q.total_status][1]}`}>{t(BADGE[q.total_status][0])}</span>}</span><span>{f.n3(q.total)}</span></div>
          <div className="mut"><span>{t("pcDriver")}</span><span>{f.n3(q.driver_earnings)}</span></div>
          {q.tariff && q.delivery && (
            <div className="mut" style={{ display: "block", fontSize: 12.5 }}>
              {tm("adjClass", { code: q.tariff.code, zone: q.delivery.is_default ? tm("dcDefault") : (q.delivery.zone ?? "") })}
            </div>
          )}
          {q.factors && (
            <div className="mut" style={{ display: "block", fontSize: 12.5 }}>
              {t("pcFactors", {
                fee: f.n3(q.factors.base_fee),
                mult: f.n(q.factors.multiplier, 3),
                peak: x(q.factors.peak_mult),
                priority: x(q.factors.priority_mult),
                distance: x(q.factors.distance_mult),
              })}
              {q.factors.distance_km != null ? ` (${fmtNumber(q.factors.distance_km, lang, { maximumFractionDigits: 2 })} ${t("uKm")})` : ""}
              {" · "}
              {t("pcDemand", { demand: x(q.factors.demand_mult), ratio: fmtNumber(q.factors.demand_ratio, lang, { maximumFractionDigits: 2 }) })}
              {!q.factors.located && ` — ${t("pcAddPin")}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
