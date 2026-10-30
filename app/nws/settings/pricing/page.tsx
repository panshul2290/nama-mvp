"use client";

import { useCallback, useEffect, useState } from "react";
import { omr, PageHead, ReadOnlyNote } from "@/components/nws/admin/ui";
import { fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { SERVICE_LABEL, type RuleStatus, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

type Rule = { rule_key: string; value: string; status: RuleStatus; source: string; notes: string; updated_at: string };
const BADGE: Record<RuleStatus, [string, string]> = {
  confirmed: ["Confirmed", "ok"],
  pending_clarification: ["Pending NWS clarification", "warn"],
  assumption: ["Assumption", "warn"],
};

// Display order and labels, as in the prototype's pricing screen.
const FEE_ENGINE: [string, string][] = [
  ["fee_dw_omr", "Base fee — drinking water (OMR)"],
  ["fee_ww_omr", "Base fee — wastewater (OMR)"],
  ["fee_te_omr", "Base fee — treated effluent (OMR)"],
  ["peak_multiplier", "Evening peak multiplier (6–8 pm)"],
  ["priority_multiplier", "Priority / emergency multiplier"],
  ["discount_monthly", "Monthly plan discount on fee"],
  ["discount_yearly", "Yearly plan discount on fee"],
  ["driver_share", "Driver share of fee"],
  ["vat_rate", "VAT"],
  ["cancel_fee_omr", "Cancellation fee after assignment (OMR)"],
];
// Dynamic factors (0026): distance and demand multiply the delivery fee next to peak and priority.
const DYNAMIC: [string, string, string][] = [
  ["distance_free_km", "Distance included in the base fee", "km"],
  ["distance_per_km", "Added per km beyond it", "× per km"],
  ["distance_cap", "Distance multiplier cap", "×"],
  ["demand_min_open", "Demand pricing needs at least", "open requests"],
  ["demand_ratio_threshold", "Starts above", "requests per online tanker"],
  ["demand_step", "Added per extra request per tanker", "×"],
  ["demand_cap", "Demand multiplier cap", "×"],
  ["dynamic_cap", "Cap on the combined multiplier", "×"],
];
const TARIFF: [string, React.ReactNode, string][] = [
  ["dw_tier_threshold_gal", <><span className="tag DW">DW</span> first tier ends at</>, "gal"],
  ["dw_rate_upto_650", <><span className="tag DW">DW</span> up to 650 gal</>, "baisa / gal"],
  ["dw_rate_above_650", <><span className="tag DW">DW</span> above 650 gal</>, "baisa / gal"],
  ["dw_above_650_basis", <><span className="tag DW">DW</span> how the upper tier applies</>, ""],
  ["ww_rate", <><span className="tag WW">WW</span> all</>, "baisa / gal"],
  ["te_rate", <><span className="tag TE">TE</span> all</>, "baisa / gal"],
];

type Factors = { base_fee: number; multiplier: number; peak_mult: number; priority_mult: number; distance_km: number | null; distance_mult: number; demand_ratio: number; demand_mult: number; located: boolean };
type QuoteRes = { water_charge: number; delivery_fee: number; discount: number; vat: number; total: number; driver_earnings: number; total_status: RuleStatus; peak: boolean; priority: boolean; discount_pct: number; promo_label: string | null; factors?: Factors };

export default function PricingPage() {
  const { can } = useStaff();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [edit, setEdit] = useState<Rule | null>(null);
  const editor = can("admin", "finance");

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
  const count = (s: RuleStatus) => rules?.filter((r) => r.status === s).length ?? 0;
  const row = (key: string, label: React.ReactNode, unit = "") => {
    const r = byKey.get(key);
    if (!r) return null;
    return (
      <tr key={key}>
        <td>
          {label}
          <small style={{ display: "block" }} title={r.notes}>{r.source} · updated {fmtDateTime(r.updated_at)}</small>
        </td>
        <td><span className={`st ${BADGE[r.status][1]}`}>{BADGE[r.status][0]}</span></td>
        <td className="num"><b>{r.value === "slab" ? "Slab (only gallons above)" : r.value === "whole_volume" ? "Whole volume" : r.value}</b>{unit && <small> {unit}</small>}</td>
        <td className="num">{editor && <button className="btn sm" onClick={() => setEdit(r)}>Edit</button>}</td>
      </tr>
    );
  };

  return (
    <>
      <PageHead title="Pricing" sub="Every price is computed by the database from these rules. Lines priced from a rule that isn’t confirmed are tagged on quotes and orders." />
      {!editor && <ReadOnlyNote who="Super admins and Finance" />}
      <div className="okpis">
        <div className="okpi">
          <span>BILLING_MODE</span>
          <b>{mode ?? "—"}</b>
          <small className={mode === "production" ? "ok" : "warn"}>{mode === "production" ? "orders using unconfirmed rules are refused" : "unconfirmed rules are allowed and flagged"}</small>
        </div>
        <div className="okpi"><span>Confirmed</span><b>{count("confirmed")}</b><small className="ok">from the tender tariff table</small></div>
        <div className="okpi"><span>Pending clarification</span><b>{count("pending_clarification")}</b><small className="warn">awaiting NWS answers</small></div>
        <div className="okpi"><span>Assumptions</span><b>{count("assumption")}</b><small className="warn">no tender basis yet</small></div>
      </div>

      <div className="two">
        <div className="panel">
          <h2>Delivery fee engine <small>changes apply to new orders immediately</small></h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {!rules && <tr><td className="empty">Loading…</td></tr>}
                {FEE_ENGINE.map(([k, l]) => row(k, l))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="stack">
          <div className="panel">
            <h2>Water tariff <small>regulated, from tender</small></h2>
            <div className="tblwrap">
              <table>
                <tbody>{TARIFF.map(([k, l, u]) => row(k, l, u))}</tbody>
              </table>
            </div>
            <p className="note">Open question for NWS (Q05): whether 3 baisa applies to the whole volume above 650 gal or only to the part above it. BILLING_MODE is changed by the database owner (see README → Pricing).</p>
          </div>
          <div className="panel">
            <h2>Dynamic pricing <small>distance and demand, capped</small></h2>
            <div className="tblwrap">
              <table>
                <tbody>{DYNAMIC.map(([k, l, u]) => row(k, l, u))}</tbody>
              </table>
            </div>
            <p className="note">
              Distance: from the nearest active filling station (wastewater: treatment plant) to the customer&apos;s pin. Demand: open requests for the service in the zone against online tankers with a fresh fix there.
              Both are 1× inside the free distance and below the threshold, so existing prices hold; test-zone orders use no distance factor. The order keeps the breakdown, and the driver&apos;s earnings are their share of the multiplied fee.
            </p>
          </div>
          <PriceCheck />
        </div>
      </div>
      {edit && <EditRule rule={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
    </>
  );
}

function EditRule({ rule, onClose, onDone }: { rule: Rule; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const [value, setValue] = useState(rule.value);
  const [status, setStatus] = useState<RuleStatus>(rule.status);
  const [source, setSource] = useState(rule.source);
  return (
    <ReasonDialog
      title={`Edit ${rule.rule_key}`}
      body={rule.notes}
      confirm="Save rule"
      extra={
        <>
          <div className="row2">
            <div className="fld">
              <label htmlFor="pr-v">Value</label>
              {rule.rule_key === "dw_above_650_basis" ? (
                <select id="pr-v" className="in" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="slab">slab</option>
                  <option value="whole_volume">whole_volume</option>
                </select>
              ) : (
                <input id="pr-v" className="in" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              )}
            </div>
            <div className="fld">
              <label htmlFor="pr-s">Status</label>
              <select id="pr-s" className="in" value={status} onChange={(e) => setStatus(e.target.value as RuleStatus)}>
                {(Object.keys(BADGE) as RuleStatus[]).map((s) => <option key={s} value={s}>{BADGE[s][0]}</option>)}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="pr-src">Source</label>
            <input id="pr-src" className="in" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Tender tariff table, Q05 answer" />
          </div>
        </>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_update_pricing_rule", { p_rule_key: rule.rule_key, p_value: value.trim(), p_status: status, p_source: source, p_reason: reason });
        if (error) return toast(friendlyError(error), true);
        toast("Pricing rule updated — applies to new orders");
        onDone();
      }}
    />
  );
}

function PriceCheck() {
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
    if (pin.trim() && !m) return setErr("Delivery pin: latitude, longitude — e.g. 23.59, 58.41");
    const { data, error } = await supabase().rpc("quote_order", {
      p_service_type: service, p_gallons: Number(gallons), p_slot_start: d.toISOString(), p_emergency: emergency, p_promo_code: promo.trim() || null,
      p_lat: m ? Number(m[1]) : null, p_lng: m ? Number(m[2]) : null,
    });
    setErr(error ? friendlyError(error) : null);
    setQ(error ? null : (data as QuoteRes));
  }

  return (
    <div className="panel pcheck">
      <h2>Price check <small>live from the rules</small></h2>
      <div className="pad">
        <div className="form">
          <div className="fld">
            <label htmlFor="pc-s">Service</label>
            <select id="pc-s" className="in" value={service} onChange={(e) => setService(e.target.value as ServiceType)}>
              {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((s) => <option key={s} value={s}>{SERVICE_LABEL[s]}</option>)}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="pc-g">Gallons</label>
            <input id="pc-g" className="in" type="number" min={1} max={20000} value={gallons} onChange={(e) => setGallons(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="pc-p">Promo code</label>
            <input id="pc-p" className="in" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="Optional" />
          </div>
          <div className="fld">
            <label htmlFor="pc-pin">Delivery pin (lat, lng)</label>
            <input id="pc-pin" className="in" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Optional, e.g. 23.59, 58.41" dir="ltr" />
          </div>
        </div>
        <div className="checks" style={{ display: "flex", gap: 16, margin: "10px 0", fontSize: 13.5 }}>
          <label><input type="checkbox" checked={peak} onChange={(e) => setPeak(e.target.checked)} /> Evening peak slot</label>
          <label><input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} /> Emergency</label>
        </div>
        <button className="btn pri" onClick={check}>Calculate</button>
        {err && <div className="banner badb" style={{ marginTop: 12 }}>{err}</div>}
      </div>
      {q && (
        <div className="bill">
          <div><span>Water charge</span><span>{omr(q.water_charge)}</span></div>
          <div><span>Delivery fee{q.peak ? " · peak" : ""}{q.priority ? " · emergency" : ""}</span><span>{omr(q.delivery_fee)}</span></div>
          {Number(q.discount) > 0 && <div><span>Discount {Math.round(q.discount_pct * 100)}%{q.promo_label ? ` · ${q.promo_label}` : ""}</span><span>−{omr(q.discount)}</span></div>}
          <div><span>VAT</span><span>{omr(q.vat)}</span></div>
          <div className="tot"><span>Total (OMR) {q.total_status !== "confirmed" && <span className={`st ptag ${BADGE[q.total_status][1]}`}>{BADGE[q.total_status][0]}</span>}</span><span>{omr(q.total)}</span></div>
          <div className="mut"><span>Driver earnings</span><span>{omr(q.driver_earnings)}</span></div>
          {q.factors && (
            <div className="mut" style={{ display: "block", fontSize: 12.5 }}>
              Fee {omr(q.factors.base_fee)} × {Number(q.factors.multiplier).toFixed(3)}: peak {q.factors.peak_mult}× · priority {q.factors.priority_mult}× · distance {q.factors.distance_mult}×
              {q.factors.distance_km != null ? ` (${q.factors.distance_km} km)` : ""} · demand {q.factors.demand_mult}× ({q.factors.demand_ratio} requests per tanker)
              {!q.factors.located && " — add a pin for distance and demand"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
