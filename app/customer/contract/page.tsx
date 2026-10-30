"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { ddate, gal, omr3 } from "@/components/customer/fmt";
import { useNow, useProperties } from "@/components/customer/hooks";
import { PropertySheet } from "@/components/customer/PropertySheet";
import { RuleFlag, SvcTag } from "@/components/customer/ui";
import { BackButton, Loading } from "@/components/Shell";
import { usePricingRules } from "@/components/usePricingRules";
import { friendlyError } from "@/lib/errors";
import { localDigits } from "@/lib/i18n";
import { ruleNumber, VOLUME_PRESETS, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey } from "@/lib/time";
import type { Company, Contract } from "@/lib/types";

const TYPES: ServiceType[] = ["DW", "WW", "TE"];
const COLOR: Record<ServiceType, string> = { DW: "var(--dw)", WW: "var(--ww)", TE: "var(--te)" };
const FREQS: Contract["frequency"][] = ["weekly", "biweekly", "monthly"];
// Deliveries per month, as create_contract() estimates them.
const PER_MONTH: Record<Contract["frequency"], number> = { weekly: 4.33, biweekly: 2.17, monthly: 1 };
const MONTHS = [1, 3, 6, 12];

export default function ContractPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ContractWizard />
    </Suspense>
  );
}

function ContractWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const profile = useCustomer();
  const { t, lang } = useCx();
  const now = useNow(3600_000);
  const { rules } = usePricingRules();
  const { props, reload } = useProperties(profile.id);
  const p0 = params.get("plan");
  const g0 = Number(params.get("gallons"));

  const [step, setStep] = useState(1);
  const [type, setType] = useState<ServiceType>(TYPES.includes(params.get("type") as ServiceType) ? (params.get("type") as ServiceType) : "DW");
  const [propChoice, setPropChoice] = useState<string | null>(params.get("property"));
  const [adding, setAdding] = useState(false);
  const [gallons, setGallons] = useState(g0 >= 100 ? g0 : 3000);
  // A suggested frequency (smart recommendation, E11) arrives as ?frequency=.
  const [freq, setFreq] = useState<Contract["frequency"]>(() => FREQS.find((f) => f === params.get("frequency")) ?? "weekly");
  const [plan, setPlan] = useState<Contract["plan"]>(p0 === "yearly" ? "yearly" : "monthly");
  const [months, setMonths] = useState(p0 === "yearly" ? 12 : 1);
  const minDate = omanDateKey(now, 1); // Muscat dates
  const [start, setStart] = useState<string | null>(null);
  const startDate = start ?? omanDateKey(now, 2);
  const [slot, setSlot] = useState<Contract["slot"]>("morning");
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [quote, setQuote] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prop = props?.find((p) => p.id === propChoice) ?? (propChoice === null ? props?.[0] : undefined);
  const co = companies?.find((c) => c.id === company);

  useEffect(() => {
    supabase()
      .from("companies")
      .select("id, name, rating, since, status")
      .eq("status", "active")
      .order("rating", { ascending: false })
      .then(({ data }) => setCompanies((data ?? []) as Company[]));
  }, []);

  // Base price per delivery (evening slots are priced at peak), then the plan discount on the delivery fee.
  useEffect(() => {
    if (step !== 4) return;
    supabase()
      .rpc("quote_order", { p_service_type: type, p_gallons: gallons, p_slot_start: `${startDate}T${slot === "evening" ? "18" : "08"}:00:00+04:00`, p_emergency: false })
      .then(({ data }) => data && setQuote(data as Record<string, number>));
  }, [step, type, gallons, startDate, slot]);

  const est = useMemo(() => {
    if (!quote || !rules) return null;
    const pct = ruleNumber(rules, plan === "yearly" ? "discount_yearly" : "discount_monthly");
    const water = Number(quote.water_charge);
    const fee = Number(quote.delivery_fee);
    const disc = Math.round(fee * pct * 1000) / 1000;
    const net = water + fee - disc;
    const per = net + Math.round(net * ruleNumber(rules, "vat_rate") * 1000) / 1000;
    return { per, month: Math.round(per * PER_MONTH[freq] * 1000) / 1000, pct, status: rules[plan === "yearly" ? "discount_yearly" : "discount_monthly"]?.status };
  }, [quote, rules, plan, freq]);

  async function submit() {
    if (!prop || !company) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase()
      .rpc("create_contract", {
        p_property_id: prop.id,
        p_company_id: company,
        p_service_type: type,
        p_gallons: gallons,
        p_frequency: freq,
        p_plan: plan,
        p_slot: slot,
        p_start_date: startDate,
        p_months: months,
      })
      .single<Contract>();
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.replace("/customer/orders?tab=contracts");
  }

  const canNext = step === 1 ? Boolean(prop) : step === 2 ? gallons >= 100 && gallons <= 20000 && startDate >= minDate : step === 3 ? Boolean(company) : true;

  return (
    <>
      <main className="screen">
        <div className="rq-h">
          <BackButton label={t("back")} onClick={() => (step > 1 ? setStep(step - 1) : router.push("/customer/orders?tab=contracts"))} />
          <div>
            <h3>{step === 4 ? t("ctReview") : t("newContract")}</h3>
            <small>
              {t("stepOf", { n: lang === "ar" ? "١٢٣٤"[step - 1] : step })} · {t(["ctS1", "ctS2", "company", "ctReview"][step - 1])}
            </small>
          </div>
        </div>
        <div className="wiz" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={n <= step ? "on" : ""} />
          ))}
        </div>

        {step === 1 && (
          <>
            <div className="svc" role="radiogroup" aria-label={t("s1")}>
              {TYPES.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={type === k} className={type === k ? "on" : ""} onClick={() => setType(k)}>
                  <i style={{ background: COLOR[k] }} />
                  <div>
                    <b>{t(k)}</b>
                    <span>{t(`${k}s`)}</span>
                  </div>
                </button>
              ))}
            </div>
            <h4 className="ch-sec">{t("property")}</h4>
            {props && props.length > 0 ? (
              <div className="rq-card">
                {props.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={prop?.id === p.id} className="pm" onClick={() => setPropChoice(p.id)}>
                    <span>
                      <b>{p.label}</b>
                      <small>
                        {[p.area, p.address].filter(Boolean).join(" · ")} · {gal(p.tank_gal, lang)}
                      </small>
                    </span>
                    <i className={`radio ${prop?.id === p.id ? "on" : ""}`} />
                  </button>
                ))}
              </div>
            ) : (
              props && <p className="mut small">{t("ctNeedsProp")}</p>
            )}
            <button type="button" className="lk" onClick={() => setAdding(true)}>
              + {t("addProp")}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="fld">
              <span className="lbl">{t("volume")}</span>
              <div className="opts">
                {VOLUME_PRESETS[type].map((v) => (
                  <button key={v} type="button" className={`opt ${gallons === v ? "on" : ""}`} onClick={() => setGallons(v)}>
                    {v.toLocaleString("en-US")}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="lbl">{t("freq")}</span>
              <div className="seg" style={{ margin: 0 }}>
                {FREQS.map((f) => (
                  <button key={f} type="button" className={freq === f ? "on" : ""} onClick={() => setFreq(f)}>
                    {t(`fq_${f}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="lbl">{t("plan")}</span>
              <div className="seg" style={{ margin: 0 }}>
                {(["monthly", "yearly"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={plan === p ? "on" : ""}
                    onClick={() => {
                      setPlan(p);
                      setMonths(p === "yearly" ? 12 : 1);
                    }}
                  >
                    {t(p === "monthly" ? "month" : "year")}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="lbl">{t("duration")}</span>
              <div className="opts">
                {MONTHS.map((m) => (
                  <button key={m} type="button" className={`opt ${months === m ? "on" : ""}`} onClick={() => setMonths(m)}>
                    {t(m === 1 ? "m1" : m === 12 ? "y1" : "mN", { n: localDigits(m, lang) })}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <label htmlFor="ctStart">{t("startD")}</label>
              <input id="ctStart" type="date" min={minDate} value={startDate} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="fld">
              <span className="lbl">{t("slot")}</span>
              <div className="seg" style={{ margin: 0 }}>
                {(["morning", "evening"] as const).map((s) => (
                  <button key={s} type="button" className={slot === s ? "on" : ""} onClick={() => setSlot(s)}>
                    {t(s === "morning" ? "slotMorn" : "slotEve")}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p className="mut small" style={{ marginTop: 0 }}>
              {t("companyS")}
            </p>
            {companies === null ? (
              <div className="empty">{t("loading")}</div>
            ) : companies.length === 0 ? (
              <div className="empty">{t("noCompanies")}</div>
            ) : (
              <div className="rq-card">
                {companies.map((c) => (
                  <button key={c.id} type="button" role="radio" aria-checked={company === c.id} className="pm" onClick={() => setCompany(c.id)}>
                    <span>
                      <b>{c.name}</b>
                      <small>
                        ★ {localDigits(Number(c.rating).toFixed(1), lang)} · {t("since", { y: localDigits(c.since.slice(0, 4), lang) })}
                      </small>
                    </span>
                    <i className={`radio ${company === c.id ? "on" : ""}`} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {step === 4 && prop && (
          <>
            <div className="rq-card">
              <div className="rq-ch">
                <b>{t("ctReview")}</b>
                <SvcTag type={type} />
              </div>
              <Row k={t("property")} v={[prop.label, prop.area].filter(Boolean).join(" · ")} />
              <Row k={t("volume")} v={gal(gallons, lang)} />
              <Row k={t("freq")} v={t(`fq_${freq}`)} />
              <Row k={t("slot")} v={t(slot === "morning" ? "slotMorn" : "slotEve")} />
              <Row k={t("plan")} v={`${t(plan === "monthly" ? "month" : "year")} · ${t(months === 1 ? "m1" : months === 12 ? "y1" : "mN", { n: localDigits(months, lang) })}`} />
              <Row k={t("startD")} v={ddate(startDate, lang)} />
              <Row k={t("companyL")} v={co ? `${co.name} · ★ ${localDigits(Number(co.rating).toFixed(1), lang)}` : ""} />
            </div>
            <div className="rq-card pad">
              <div className="bill">
                {est && (
                  <div>
                    <span>{t("perDelivery")}</span>
                    <span>{omr3(est.per, lang)}</span>
                  </div>
                )}
                <div className="tot">
                  <span>
                    {t("estMonthly")} <RuleFlag status={est?.status} />
                  </span>
                  <span>{est ? omr3(est.month, lang) : "…"}</span>
                </div>
              </div>
              <p className="mut small" style={{ marginBottom: 0 }}>
                {t("autopayNote")} {est && est.pct > 0 ? t("planDisc", { p: localDigits(Math.round(est.pct * 100), lang) }) : ""}
              </p>
            </div>
            {error && <div className="banner badb">{error}</div>}
          </>
        )}

        <div className="rq-next">
          {step < 4 ? (
            <button className="cta" disabled={!canNext} onClick={() => setStep(step + 1)}>
              {t("next")}
            </button>
          ) : (
            <button className="cta" disabled={busy || !prop || !company} onClick={submit}>
              {busy ? t("sending") : t("ctConfirm")}
            </button>
          )}
        </div>
      </main>
      {adding && (
        <PropertySheet
          onClose={() => setAdding(false)}
          onSaved={(p) => {
            setAdding(false);
            reload();
            setPropChoice(p.id);
          }}
        />
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="rq-r">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}
