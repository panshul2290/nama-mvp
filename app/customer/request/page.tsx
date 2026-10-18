"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Map } from "@/components/Map";
import { Bill, SERVICE_SHORT, TypeTag } from "@/components/OrderBits";
import { BackButton, Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { currentPosition, DEFAULT_CENTER, reverseGeocodeArea } from "@/lib/geo";
import { feeKey, omr, quote, ruleNumber, VOLUME_PRESETS, type PricingRules, type ServiceType } from "@/lib/pricing";
import { RuleTag } from "@/components/OrderBits";
import { usePricingRules } from "@/components/usePricingRules";
import { supabase } from "@/lib/supabase/client";
import type { LngLat, Order } from "@/lib/types";

const STEP_NAMES = ["Service", "Location", "Volume"];
const TYPES: ServiceType[] = ["DW", "WW", "TE"];
const TYPE_NOTE: Record<ServiceType, string> = {
  DW: "Potable water from NWS filling stations",
  WW: "Septic tank emptied, discharged at an approved STP",
  TE: "For irrigation and construction — not for drinking",
};
// Explains the tariff from the rules table (no figures are hard-coded).
function tariffNote(type: ServiceType, rules: PricingRules) {
  const n = (k: string) => ruleNumber(rules, k);
  const fee = `Delivery fee ${n(feeKey(type)).toFixed(3)} OMR.`;
  if (type === "DW") {
    const basis = rules.dw_above_650_basis?.value === "whole_volume" ? "on every gallon once over" : "on the gallons above";
    return `${n("dw_rate_upto_650")} baisa a gallon up to ${n("dw_tier_threshold_gal")} gal, ${n("dw_rate_above_650")} baisa a gallon ${basis} ${n("dw_tier_threshold_gal")}. ${fee}`;
  }
  return `${n(type === "WW" ? "ww_rate" : "te_rate")} baisa a gallon. ${fee}`;
}
const COLOR: Record<ServiceType, string> = { DW: "var(--dw)", WW: "var(--ww)", TE: "var(--te)" };

export default function RequestPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RequestWizard />
    </Suspense>
  );
}

function RequestWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const initialType = TYPES.includes(params.get("type") as ServiceType) ? (params.get("type") as ServiceType) : "DW";

  const [step, setStep] = useState(1);
  const [type, setType] = useState<ServiceType>(initialType);
  const [gallons, setGallons] = useState(VOLUME_PRESETS[initialType][1] ?? VOLUME_PRESETS[initialType][0]);
  const [center, setCenter] = useState<LngLat>(DEFAULT_CENTER);
  const [point, setPoint] = useState<LngLat>(DEFAULT_CENTER);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [area, setArea] = useState("");
  const areaTouched = useRef(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function applyPosition(p: LngLat | null) {
    if (!p) return setGpsNote("Couldn’t get your location — drag the pin or tap the map.");
    setGpsNote(null);
    setCenter(p);
    setPoint(p);
  }
  const locate = () => currentPosition().then(applyPosition);

  // Default the pin to the current GPS fix.
  useEffect(() => {
    currentPosition().then(applyPosition);
  }, []);

  // Suggest the area name from the pin; the customer can overwrite it.
  useEffect(() => {
    if (areaTouched.current) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const name = await reverseGeocodeArea(point, ctl.signal);
      if (name && !areaTouched.current) setArea(name);
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [point]);

  const { rules } = usePricingRules();
  const q = useMemo(() => (rules ? quote(type, gallons || 0, rules) : null), [type, gallons, rules]);
  const validGallons = Number.isInteger(gallons) && gallons >= 1 && gallons <= 20000;
  const canNext = step === 1 || (step === 2 && area.trim().length > 0) || (step === 3 && validGallons);

  function pickType(t: ServiceType) {
    setType(t);
    if (!VOLUME_PRESETS[t].includes(gallons)) setGallons(VOLUME_PRESETS[t][0]);
  }

  async function place() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase()
      .rpc("place_order", { p_service_type: type, p_gallons: gallons, p_lat: point.lat, p_lng: point.lng, p_area: area, p_address: address })
      .single<Order>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    router.replace(`/customer/orders/${data.id}`);
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton onClick={() => (step > 1 ? setStep(step - 1) : router.push("/customer"))} />
        <div>
          <h3>{step === 4 ? "Review and confirm" : "Request a tanker"}</h3>
          <small>
            Step {step} of 4{step < 4 ? ` · ${STEP_NAMES[step - 1]}` : ""}
          </small>
        </div>
      </div>
      <div className="wiz" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= step ? "on" : ""} />
        ))}
      </div>

      {step === 1 && (
        <div className="svc" role="radiogroup" aria-label="Service">
          {TYPES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "on" : ""} onClick={() => pickType(t)}>
              <i style={{ background: COLOR[t] }} />
              <div>
                <b>{t === "WW" ? "Wastewater pickup" : SERVICE_SHORT[t]}</b>
                <span>{TYPE_NOTE[t]}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <>
          <div className="rq-map">
            <Map center={center} pick={{ value: point, onChange: setPoint }} hint="Drag the pin or tap the map" onLocate={locate} />
          </div>
          {gpsNote && <div className="banner">{gpsNote}</div>}
          <div className="fld">
            <label htmlFor="area">Area</label>
            <input
              id="area"
              required
              maxLength={120}
              placeholder="e.g. Al Khoud"
              value={area}
              onChange={(e) => {
                areaTouched.current = true;
                setArea(e.target.value);
              }}
            />
          </div>
          <div className="fld">
            <label htmlFor="addr">Building, villa or landmark</label>
            <input id="addr" maxLength={300} placeholder="e.g. Villa 214, Way 3021" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <p className="mut small" style={{ marginTop: -4 }}>
            Drivers see only the area until they accept your request.
          </p>
        </>
      )}

      {step === 3 && (
        <>
          <h4 className="ch-sec">Volume (gallons)</h4>
          <div className="opts">
            {VOLUME_PRESETS[type].map((v) => (
              <button key={v} type="button" className={`opt ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
                {v.toLocaleString()}
              </button>
            ))}
          </div>
          <div className="fld" style={{ marginTop: 12 }}>
            <label htmlFor="gal">Or enter an amount</label>
            <input id="gal" type="number" inputMode="numeric" min={1} max={20000} step={1} value={gallons || ""} onChange={(e) => setGallons(Math.floor(Number(e.target.value)))} />
          </div>
          {rules && q && (
            <>
              <div className="reco">
                <b>Tariff:</b> {tariffNote(type, rules)}
                {q.status.water !== "confirmed" && (
                  <>
                    {" "}
                    <RuleTag status={q.status.water} /> {rules.dw_above_650_basis?.source}: how the higher rate applies is awaiting NWS.
                  </>
                )}
              </div>
              <div className="rq-card pad">
                <Bill quote={q} rules={rules} />
              </div>
            </>
          )}
        </>
      )}

      {step === 4 && (
        <>
          <div className="rq-card">
            <div className="rq-ch">
              <b>Your request</b>
              <TypeTag type={type} />
            </div>
            <div className="rq-r">
              <span>Location</span>
              <b>{[area, address].filter(Boolean).join(" · ")}</b>
            </div>
            <div className="rq-r">
              <span>Volume (gallons)</span>
              <b>{gallons.toLocaleString()} gallons</b>
            </div>
            <div className="rq-r">
              <span>Delivery</span>
              <b>As soon as possible</b>
            </div>
          </div>
          {rules && q && (
            <div className="rq-card pad">
              <Bill quote={q} rules={rules} />
              {q.status.total !== "confirmed" && (
                <p className="mut small" style={{ margin: "8px 0 0" }}>
                  Tagged lines use rates that NWS hasn’t confirmed yet.
                </p>
              )}
            </div>
          )}
          {error && <div className="banner badb">{error}</div>}
        </>
      )}

      <div className="rq-next">
        {step < 4 ? (
          <button className="cta" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <>
            <button className="cta" disabled={busy || !q} onClick={place}>
              {busy ? "Placing request…" : q ? `Place request · ${omr(q.total)}` : "Place request"}
            </button>
            <div className="rq-note">
              <Icon name="shield" />
              Free to cancel — no tanker assigned yet.
            </div>
          </>
        )}
      </div>
    </main>
  );
}
