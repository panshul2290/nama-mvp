"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { gal, omr3 } from "@/components/customer/fmt";
import { useDeliveryWindows, useNow, useOnline, usePaymentMethods, usePrefs, useProperties, useWallet, type PayMethodRow } from "@/components/customer/hooks";
import { householdKey, recoFor, RecoCard } from "@/components/customer/Reco";
import { FeeFactors, type Factors } from "@/components/customer/FeeFactors";
import { PropertySheet } from "@/components/customer/PropertySheet";
import { ServiceNotices } from "@/components/customer/ServiceNotices";
import { slotOptions, windowsFromRows, type Slot, type Window } from "@/components/customer/slots";
import { AddressDetailsForm } from "@/components/AddressDetailsForm";
import { FallbackCard } from "@/components/FallbackCard";
import { Bill, quoteToBill, SvcTag, Toggle } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { Map } from "@/components/Map";
import { BackButton, Loading } from "@/components/Shell";
import { usePricingRules } from "@/components/usePricingRules";
import { contactPhoneOk, detailParts, detailsFromRow, detailsPayload, EMPTY_DETAILS, hasDetails, useWilayats, type DetailsForm } from "@/lib/address";
import { ADDR } from "@/lib/addressI18n";
import { errorCode, friendlyError } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { useSupport } from "@/lib/support";
import { currentPosition, DEFAULT_CENTER, reverseGeocodeArea } from "@/lib/geo";
import { ruleNumber, VOLUME_PRESETS, type ServiceType } from "@/lib/pricing";
import { isMissing } from "@/lib/rpcCompat";
import { supabase } from "@/lib/supabase/client";
import { inTestArea, useTestAreas } from "@/lib/testArea";
import { ref, type LngLat, type Order } from "@/lib/types";

const TYPES: ServiceType[] = ["DW", "WW", "TE"];
const COLOR: Record<ServiceType, string> = { DW: "var(--dw)", WW: "var(--ww)", TE: "var(--te)" };
type Plan = "one" | "monthly" | "yearly";
// Errors the customer fixes in the app; anything else (network, zone off, outside the area) also offers 1442 / WhatsApp.
const FIXABLE = ["insufficient_wallet", "invalid_promo", "identity_required", "slot_blocked", "account_blocked"];
const dayLabel = (day: string, lang: string) =>
  new Intl.DateTimeFormat(lang === "ar" ? "ar-OM" : "en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));

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
  const profile = useCustomer();
  const { t, lang } = useCx();
  const online = useOnline();
  const now = useNow(60_000);
  const { rules } = usePricingRules();
  const { props, reload: reloadProps } = useProperties(profile.id);
  const { wallet } = useWallet();
  const { methods } = usePaymentMethods(profile.id);
  const { prefs, set: setPrefs } = usePrefs(profile.id);
  const ta = useT(ADDR);
  const support = useSupport();
  const windowRows = useDeliveryWindows(7);

  const initialType = TYPES.includes(params.get("type") as ServiceType) ? (params.get("type") as ServiceType) : "DW";
  const paramGallons = Number(params.get("gallons"));
  const [step, setStep] = useState(1);
  const [type, setType] = useState<ServiceType>(initialType);
  // "pin" = drop a pin instead of a saved property; null = not chosen yet (defaults below).
  const [propChoice, setPropChoice] = useState<string | null>(params.get("property"));
  const [addingProp, setAddingProp] = useState(false);
  const [gallons, setGallons] = useState(paramGallons > 0 ? paramGallons : 3000);
  const gallonsTouched = useRef(paramGallons > 0);
  const [plan, setPlan] = useState<Plan>("one");
  const [slotId, setSlotId] = useState("now");
  const [emergency, setEmergency] = useState(false);
  const [note, setNote] = useState("");
  const [promoIn, setPromoIn] = useState("");
  const [promo, setPromo] = useState<string | null>(null);
  const [promoMsg, setPromoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pay, setPay] = useState<string | null>(null);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Order | null>(null);
  const [history, setHistory] = useState<Order[]>([]);

  // Pin mode (as before): GPS fix, draggable pin, suggested area name.
  const [center, setCenter] = useState<LngLat>(DEFAULT_CENTER);
  const [point, setPoint] = useState<LngLat>(DEFAULT_CENTER);
  const [gpsNote, setGpsNote] = useState(false);
  const [area, setArea] = useState("");
  const areaTouched = useRef(false);
  const [address, setAddress] = useState("");

  // Test zones: the device's own position, to warn when it and the delivery point are on
  // different sides of a test zone (testers in India would never see an Oman order, and the other way round).
  const testAreas = useTestAreas();
  const [here, setHere] = useState<LngLat | null>(null);
  useEffect(() => {
    if (!testAreas.length) return;
    let live = true;
    currentPosition().then((p) => live && setHere(p));
    return () => {
      live = false;
    };
  }, [testAreas.length]);

  const prop = props && propChoice !== "pin" ? (props.find((p) => p.id === propChoice) ?? (propChoice === null ? props[0] : undefined)) : undefined;
  const pinMode = props !== null && !prop;
  // Optional address details and delivery contact (0040): the property's, editable for this order.
  const [detailsFor, setDetailsFor] = useState<{ key: string; v: DetailsForm }>({ key: "", v: EMPTY_DETAILS });
  const detailsKey = prop?.id ?? "pin";
  const details = detailsFor.key === detailsKey ? detailsFor.v : prop ? detailsFromRow(prop) : EMPTY_DETAILS;
  const setDetails = (v: DetailsForm) => setDetailsFor({ key: detailsKey, v });
  const wil = useWilayats();
  // The review step repeats the optional details and the delivery contact before payment.
  const reviewParts = detailParts(
    { wilayat_code: details.wilayat || null, village: details.village.trim() || null, way_no: details.way_no.trim() || null, house_no: details.house_no.trim() || null, national_address_id: details.national_address_id.trim() || null },
    lang,
    wil?.wilayats,
    ta,
  );

  function applyPosition(p: LngLat | null) {
    setGpsNote(!p);
    if (!p) return;
    setCenter(p);
    setPoint(p);
  }
  const locate = () => currentPosition().then(applyPosition);
  useEffect(() => {
    if (!pinMode) return;
    currentPosition().then((p) => {
      setGpsNote(!p);
      if (!p) return;
      setCenter(p);
      setPoint(p);
    });
  }, [pinMode]);
  useEffect(() => {
    if (!pinMode || areaTouched.current) return;
    const ctl = new AbortController();
    const tm = setTimeout(async () => {
      const name = await reverseGeocodeArea(point, ctl.signal);
      if (name && !areaTouched.current) setArea(name);
    }, 600);
    return () => {
      clearTimeout(tm);
      ctl.abort();
    };
  }, [point, pinMode]);

  // Past deliveries power the volume suggestion.
  useEffect(() => {
    supabase()
      .from("orders")
      .select("id, property_id, service_type, gallons, delivered_at, status")
      .eq("customer_id", profile.id)
      .eq("status", "delivered")
      .order("delivered_at", { ascending: false })
      .limit(40)
      .then(({ data }) => setHistory((data ?? []) as Order[]));
  }, [profile.id]);

  // NWS window templates (0044) for the next 7 days; the built-in windows if they can't be loaded.
  const windows = useMemo<Window[] | null>(() => (windowRows && windowRows.length ? windowsFromRows(windowRows as never) : null), [windowRows]);
  const days = useMemo(() => (windows ? [...new Set(windows.map((w) => w.day))] : []), [windows]);
  const [dayPick, setDayPick] = useState<string | null>(null);
  const day = dayPick && days.includes(dayPick) ? dayPick : (days[0] ?? null);
  const slots: Slot[] = useMemo(() => (windows ? [...slotOptions(now).slice(0, 1), ...windows] : slotOptions(now)), [now, windows]);
  const slot = slots.find((s) => s.id === slotId) ?? slots[0];
  const slotText = (s: Slot | undefined) => {
    if (!s) return "";
    if (s.key) return t(s.key);
    const w = s as Window;
    return `${dayLabel(w.day, lang)} · ${w.from}–${w.to}`;
  };

  // Smart recommendation (E11): size and frequency from the tank, the household and past deliveries.
  const household = prefs?.household;
  const { reco, people } = useMemo(() => recoFor(type, prop, history, household), [type, prop, history, household]);
  const suggestion = { g: reco.gallons };
  const setPeople = (n: number) => {
    const next = { ...(household ?? {}) };
    if (n > 0) next[householdKey(prop)] = n;
    else delete next[householdKey(prop)];
    setPrefs({ household: next });
  };

  // Live quote on the review step (peak, priority and promotion included).
  const slotStart = slot?.start ?? null;
  // The delivery point goes into the quote, so it has the same distance and demand factors as the order (0026).
  const destLat = prop ? prop.lat : point.lat;
  const destLng = prop ? prop.lng : point.lng;
  const quoteArgs = useMemo(
    () => ({ p_service_type: type, p_gallons: gallons, p_slot_start: slotStart, p_emergency: emergency, p_promo_code: promo, p_lat: destLat, p_lng: destLng }),
    [type, gallons, slotStart, emergency, promo, destLat, destLng],
  );
  useEffect(() => {
    if (step !== 4) return;
    let live = true;
    quoteOrder(quoteArgs).then(({ data, error }) => {
        if (!live) return;
        if (error) {
          if (errorCode(error) === "invalid_promo") {
            setPromo(null);
            setPromoMsg({ ok: false, text: t("promoBad") });
          } else setError({ code: errorCode(error), text: friendlyError(error) });
          return;
        }
        setQuote(data as Record<string, unknown>);
    });
    return () => {
      live = false;
    };
  }, [step, quoteArgs, t]);

  async function applyPromo() {
    const code = promoIn.trim().toUpperCase();
    if (!code) {
      setPromo(null);
      setPromoMsg(null);
      return;
    }
    const { data, error } = await quoteOrder({ ...quoteArgs, p_promo_code: code });
    if (error) return setPromoMsg({ ok: false, text: errorCode(error) === "invalid_promo" ? t("promoBad") : friendlyError(error) });
    setPromo(code);
    setQuote(data as Record<string, unknown>);
    setPromoMsg({ ok: true, text: t("promoOk", { c: code, l: String((data as { promo_label?: string }).promo_label ?? "") }) });
  }

  // Payment choice: wallet, a saved card, or OmanNet.
  const cards = (methods ?? []).filter((m) => m.brand !== "OmanNet");
  const omannetCard = (methods ?? []).find((m) => m.brand === "OmanNet");
  const defaultCard: PayMethodRow | undefined = cards.find((m) => m.is_default) ?? cards[0];
  const total = quote ? Number(quote.total) : null;
  const balance = wallet?.balance ?? 0;
  const payKey = pay ?? (balance > 0 ? "wallet" : defaultCard ? `card:${defaultCard.id}` : "card");
  const walletShort = payKey === "wallet" && total != null && balance < total;

  function payment(): { method: string; last4: string | null } {
    if (payKey === "wallet") return walletShort ? { method: "wallet_card", last4: defaultCard?.last4 ?? null } : { method: "wallet", last4: null };
    if (payKey === "omannet") return { method: "omannet", last4: omannetCard?.last4 ?? null };
    const card = cards.find((c) => `card:${c.id}` === payKey);
    return { method: "card", last4: card?.last4 ?? null };
  }

  function pickType(k: ServiceType) {
    setType(k);
    if (!gallonsTouched.current) setGallons(k === "DW" ? 3000 : k === "WW" ? 3000 : 10000);
  }

  function next() {
    if (step === 1 && !gallonsTouched.current) setGallons(suggestion.g);
    setError(null);
    setStep(step + 1);
  }

  async function place() {
    setBusy(true);
    setError(null);
    const { method, last4 } = payment();
    const loc = prop
      ? { p_lat: prop.lat, p_lng: prop.lng, p_area: prop.area || prop.label, p_address: [prop.label, prop.address].filter(Boolean).join(" · ") }
      : { p_lat: point.lat, p_lng: point.lng, p_area: area.trim(), p_address: address.trim() };
    const { data, error } = await supabase()
      .rpc("create_order", {
        p_service_type: type,
        p_gallons: gallons,
        ...loc,
        p_property_id: prop?.id ?? null,
        p_slot_start: slot?.start ?? null,
        p_slot_end: slot?.end ?? null,
        p_slot_label: slot?.start ? slot.label : null,
        p_emergency: emergency,
        p_driver_note: note.trim() || null,
        p_pay_method: method,
        p_card_last4: last4,
        p_promo_code: promo,
      })
      .single<Order>();
    setBusy(false);
    if (error || !data) {
      const code = errorCode(error);
      // quote_order doesn't check a promotion's audience (e.g. first order only); create_order does.
      if (code === "invalid_promo") {
        setPromo(null);
        setPromoMsg({ ok: false, text: t("promoBad") });
      }
      return setError({ code, text: friendlyError(error) });
    }
    if (data.status === "cancelled" && data.payment_status === "failed") return setFailed(data);
    // The optional details go on the order (the property's are copied already; this sends any edits).
    if (hasDetails(details) || (prop && hasDetails(detailsFromRow(prop)))) {
      await supabase().rpc("set_order_details", { p_order: data.id, p_details: detailsPayload(details) });
    }
    router.replace(`/customer/order?id=${data.id}`);
  }

  const dest = { lat: destLat, lng: destLng };
  const zoneMismatch = testAreas.length > 0 && here !== null ? (inTestArea(here, testAreas) === inTestArea(dest, testAreas) ? null : inTestArea(here, testAreas) ? "realDest" : "testDest") : null;
  async function pickHere() {
    if (!here) return;
    areaTouched.current = true;
    setPropChoice("pin");
    setCenter(here);
    setPoint(here);
    const name = await reverseGeocodeArea(here);
    setArea(name ?? "");
    setAddress("");
    if (!name) setStep(1); // the area name is needed: let the customer type it
  }

  const validGallons = Number.isInteger(gallons) && gallons >= 1 && gallons <= 20000;
  const canNext = step === 1 ? props !== null && (!pinMode || area.trim().length > 0) && contactPhoneOk(details) : step === 2 ? validGallons : true;
  const vatPct = rules ? Math.round(ruleNumber(rules, "vat_rate") * 1000) / 10 : null;
  const prioMult = rules ? ruleNumber(rules, "priority_multiplier") : NaN;

  // ---------------------------------------------------------------- payment failed
  if (failed) {
    const { last4 } = payment();
    return (
      <main className="screen">
        <div className="rq-h">
          <BackButton onClick={() => setFailed(null)} label={t("back")} />
          <div>
            <h3>{t("payFailT")}</h3>
            <small>{ref.order(failed.order_no)}</small>
          </div>
        </div>
        <div className="fail-hero">
          <Icon name="x" />
          <div>
            <b>{t("payFailT")}</b>
            <small>{last4 ? t("payFailCard", { l: last4 }) : t("payFailS")}</small>
          </div>
        </div>
        <p className="mut small">{t("payFailNote")}</p>
        <button className="cta" disabled={busy} onClick={() => (setFailed(null), place())}>
          {busy ? t("paying") : t("retryPay")}
        </button>
        <button className="cta sec" onClick={() => setFailed(null)}>
          {t("otherMethod")}
        </button>
      </main>
    );
  }

  return (
    <>
      <main className="screen">
        <div className="rq-h">
          <BackButton label={t("back")} onClick={() => (step > 1 ? setStep(step - 1) : router.push("/customer"))} />
          <div>
            <h3>{step === 4 ? t("s4") : t("reqTanker")}</h3>
            <small>
              {t("stepOf", { n: lang === "ar" ? "١٢٣٤"[step - 1] : step })}
              {step < 4 ? ` · ${t(`s${step}`)}` : ""}
            </small>
          </div>
        </div>
        <div className="wiz" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={n <= step ? "on" : ""} />
          ))}
        </div>

        {!online && <div className="banner badb">{t("offline")}</div>}
        {/* Service-disruption notices (0038) for the delivery point, once one is set. */}
        {prop ? <ServiceNotices lat={prop.lat} lng={prop.lng} /> : pinMode && point !== DEFAULT_CENTER ? <ServiceNotices lat={point.lat} lng={point.lng} /> : <ServiceNotices />}

        {step === 1 && (
          <>
            <div className="svc" role="radiogroup" aria-label={t("s1")}>
              {TYPES.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={type === k} className={type === k ? "on" : ""} onClick={() => pickType(k)}>
                  <i style={{ background: COLOR[k] }} />
                  <div>
                    <b>{t(k)}</b>
                    <span>{t(`${k}s`)}</span>
                  </div>
                </button>
              ))}
            </div>
            <h4 className="ch-sec">{t("property")}</h4>
            {props === null ? (
              <div className="empty">{t("loading")}</div>
            ) : (
              <div className="rq-card" role="radiogroup" aria-label={t("property")}>
                {props.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={prop?.id === p.id} className="pm" onClick={() => setPropChoice(p.id)}>
                    <span>
                      <b>{p.label}</b>
                      <small>{[p.area, p.address].filter(Boolean).join(" · ") || gal(p.tank_gal, lang)}</small>
                    </span>
                    <i className={`radio ${prop?.id === p.id ? "on" : ""}`} />
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={pinMode} className="pm" onClick={() => setPropChoice("pin")}>
                  <span>
                    <b>{t("dropPin")}</b>
                    <small>{t("dropPinS")}</small>
                  </span>
                  <i className={`radio ${pinMode ? "on" : ""}`} />
                </button>
              </div>
            )}
            <button type="button" className="lk" onClick={() => setAddingProp(true)}>
              + {t("addProp")}
            </button>
            {props !== null && <AddressDetailsForm key={detailsKey} value={details} onChange={setDetails} />}
            {pinMode && (
              <div style={{ marginTop: 12 }}>
                <div className="rq-map">
                  <Map center={center} pick={{ value: point, onChange: setPoint }} hint={t("dragPin")} onLocate={locate} />
                </div>
                {gpsNote && <div className="banner">{t("noGps")}</div>}
                <div className="fld">
                  <label htmlFor="area">{t("area")}</label>
                  <input
                    id="area"
                    required
                    maxLength={120}
                    placeholder={t("areaPh")}
                    value={area}
                    onChange={(e) => {
                      areaTouched.current = true;
                      setArea(e.target.value);
                    }}
                  />
                </div>
                <div className="fld">
                  <label htmlFor="addr">{t("bldg")}</label>
                  <input id="addr" maxLength={300} placeholder={t("addressPh")} value={address} onChange={(e) => setAddress(e.target.value)} />
                </div>
                <p className="mut small" style={{ marginTop: -4 }}>
                  {t("areaOnly")}
                </p>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h4 className="ch-sec">{t("volume")}</h4>
            <div className="opts">
              {VOLUME_PRESETS[type].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`opt ${gallons === v ? "on" : ""}`}
                  onClick={() => {
                    gallonsTouched.current = true;
                    setGallons(v);
                  }}
                >
                  {v.toLocaleString("en-US")}
                </button>
              ))}
            </div>
            <div className="fld" style={{ marginTop: 12 }}>
              <label htmlFor="gal">{t("orAmount")}</label>
              <input
                id="gal"
                type="number"
                inputMode="numeric"
                min={1}
                max={20000}
                step={1}
                value={gallons || ""}
                onChange={(e) => {
                  gallonsTouched.current = true;
                  setGallons(Math.floor(Number(e.target.value)));
                }}
              />
            </div>
            <RecoCard
              service={type}
              prop={prop}
              reco={reco}
              people={people}
              picked={gallons === reco.gallons}
              onPick={() => {
                gallonsTouched.current = true;
                setGallons(reco.gallons);
              }}
              onPeople={prefs ? setPeople : undefined}
            />
            <h4 className="ch-sec">{t("plan")}</h4>
            <div className="seg" role="tablist">
              {(["one", "monthly", "yearly"] as Plan[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={plan === k} className={plan === k ? "on" : ""} onClick={() => setPlan(k)}>
                  {t(k === "one" ? "one" : k === "monthly" ? "month" : "year")}
                </button>
              ))}
            </div>
            {plan !== "one" && <div className="reco">{t("planNote")}</div>}
            <p className="mut small">
              {t("recurQ")}{" "}
              <Link className="lk" href={`/customer/recurring?new=1&type=${type}&gallons=${gallons}${prop ? `&property=${prop.id}` : ""}`}>
                {t("recurSet")}
              </Link>
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <h4 className="ch-sec">{t("slot")}</h4>
            {windows && days.length > 1 && (
              <div className="seg" role="tablist" aria-label={t("slotDay")}>
                {days.map((d) => (
                  <button key={d} type="button" role="tab" aria-selected={d === day} className={d === day ? "on" : ""} onClick={() => setDayPick(d)}>
                    {dayLabel(d, lang)}
                  </button>
                ))}
              </div>
            )}
            <div className="opts">
              {slots
                .filter((s) => !windows || s.key || (s as Window).day === day)
                .map((s) => (
                  <button key={s.id} type="button" className={`opt ${slot?.id === s.id ? "on" : ""}`} onClick={() => setSlotId(s.id)}>
                    {s.key ? t(s.key) : `${(s as Window).from}–${(s as Window).to}`}
                    {s.peak ? ` · ${t("peak")}` : ""}
                  </button>
                ))}
            </div>
            {windows && <p className="mut small">{t("slotRule")}</p>}
            {slot?.start && new Date(slot.start).getTime() - now > 2 * 3600_000 && <p className="mut small">{t("willSchedule")}</p>}
            <div className="rq-card rq-split" style={{ marginTop: 14 }}>
              <div>
                <b>{t("emerg")}</b>
                <small>
                  {t("emergS")}
                  {Number.isFinite(prioMult) ? ` (× ${prioMult})` : ""}
                </small>
              </div>
              <Toggle on={emergency} onChange={setEmergency} label={t("emerg")} />
            </div>
            <div className="fld">
              <label htmlFor="drvNote">{t("noteDrv")}</label>
              <input id="drvNote" maxLength={300} value={note} placeholder={t("notePh")} onChange={(e) => setNote(e.target.value)} />
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="rq-card">
              <div className="rq-ch">
                <b>{t("yourReq")}</b>
                <SvcTag type={type} />
              </div>
              <div className="rq-r">
                <span>{t("property")}</span>
                <b>{prop ? [prop.label, prop.area].filter(Boolean).join(" · ") : [area, address].filter(Boolean).join(" · ")}</b>
              </div>
              {(reviewParts.length > 0 || details.landmark.trim()) && (
                <div className="rq-r">
                  <span>{ta("more")}</span>
                  <b>
                    {[...reviewParts, details.landmark.trim()].filter(Boolean).join(" · ")}
                  </b>
                </div>
              )}
              {(details.contact_name.trim() || details.contact_phone.trim()) && (
                <div className="rq-r">
                  <span>{ta("contact")}</span>
                  <b>
                    {details.contact_name.trim()}
                    {details.contact_name.trim() && details.contact_phone.trim() ? " · " : ""}
                    {details.contact_phone.trim() && <bdi dir="ltr">{details.contact_phone.trim()}</bdi>}
                  </b>
                </div>
              )}
              {details.call_ahead && (
                <div className="rq-r">
                  <span>{ta("callFirst")}</span>
                  <b>✓</b>
                </div>
              )}
              <div className="rq-r">
                <span>{t("volume")}</span>
                <b>
                  {gallons.toLocaleString("en-US")} {t("gallons")}
                </b>
              </div>
              <div className="rq-r">
                <span>{t("slot")}</span>
                <b>{slotText(slot)}</b>
              </div>
              {emergency && (
                <div className="rq-r">
                  <span>{t("emerg")}</span>
                  <b>✓</b>
                </div>
              )}
              {note.trim() && (
                <div className="rq-r">
                  <span>{t("noteDrv")}</span>
                  <b>{note}</b>
                </div>
              )}
            </div>

            <div className="rq-card pad">
              {quote ? <Bill bill={{ ...quoteToBill(quote, promo), vatPct }} gallons={gallons} /> : <div className="empty">{t("pricing")}</div>}
              {quote && <FeeFactors factors={quote.factors as Factors | undefined} />}
              {quote && quote.total_status !== "confirmed" && <p className="mut small" style={{ margin: "8px 0 0" }}>{t("taggedNote")}</p>}
              <div className="promo">
                <input
                  value={promoIn}
                  dir="ltr"
                  placeholder={`${t("promo")} · WELCOME10`}
                  aria-label={t("promo")}
                  onChange={(e) => setPromoIn(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyPromo()}
                />
                <button type="button" className="btn sm" onClick={applyPromo}>
                  {t("apply")}
                </button>
              </div>
              {promoMsg && <p className={`small ${promoMsg.ok ? "okt" : "badt"}`}>{promoMsg.text}</p>}
            </div>

            <h4 className="ch-sec">{t("payWith")}</h4>
            <div className="rq-card" role="radiogroup" aria-label={t("payWith")}>
              <PayRow on={payKey === "wallet"} onPick={() => setPay("wallet")} title={t("walletBal")} sub={`${t("balanceL")} ${omr3(balance, lang)}`} />
              {cards.map((c) => (
                <PayRow
                  key={c.id}
                  on={payKey === `card:${c.id}`}
                  onPick={() => setPay(`card:${c.id}`)}
                  title={`${c.brand} ••${c.last4}`}
                  sub={c.is_default ? t("defaultCard") : t("savedCard")}
                />
              ))}
              {cards.length === 0 && <PayRow on={payKey === "card"} onPick={() => setPay("card")} title={t("cardGeneric")} sub={t("cardGenericS")} />}
              <PayRow
                on={payKey === "omannet"}
                onPick={() => setPay("omannet")}
                title={t("omannet")}
                sub={omannetCard ? `••${omannetCard.last4}` : t("omannetS")}
              />
            </div>
            {zoneMismatch && (
              <div className="banner" role="note">
                {t(zoneMismatch === "realDest" ? "zoneRealDest" : "zoneTestDest")}{" "}
                <button type="button" className="lk" onClick={pickHere}>
                  {t("useHere")}
                </button>
              </div>
            )}
            {walletShort && <div className="banner">{t("walletShort")}</div>}
            {support.outage && payment().method !== "wallet" && <div className="banner info">{ta("outageNote")}</div>}
            {error && (
              <div className="banner badb">
                {error.text}
                {error.code === "insufficient_wallet" && (
                  <>
                    {" "}
                    <Link className="lk" href="/customer/wallet">
                      {t("topup")}
                    </Link>
                  </>
                )}
                {(error.code === "outside_service_area" || error.code === "zone_disabled") && (
                  <>
                    {" "}
                    <button type="button" className="lk" onClick={() => (setError(null), setStep(1))}>
                      {t("changeLoc")}
                    </button>
                  </>
                )}
              </div>
            )}
            {(!online || (error && !FIXABLE.includes(error.code ?? ""))) && (
              <FallbackCard service={type} gallons={gallons} point={{ lat: destLat, lng: destLng }} />
            )}
            <div className="paybar">
              <button className="cta" disabled={busy || total == null || !online} onClick={place}>
                {busy ? t("paying") : total != null ? `${t("pay")} ${omr3(total, lang)}` : t("pay")}
              </button>
              <small>
                <Icon name="shield" />
                {t("cancelFree")}
              </small>
            </div>
          </>
        )}

        {step < 4 && (
          <div className="rq-next">
            {step === 2 && plan !== "one" ? (
              <Link
                className="cta"
                href={`/customer/contract?type=${type}&gallons=${gallons}&plan=${plan}${prop ? `&property=${prop.id}` : ""}`}
              >
                {t("toContract")}
              </Link>
            ) : (
              <button className="cta" disabled={!canNext} onClick={next}>
                {t("next")}
              </button>
            )}
          </div>
        )}
      </main>
      {addingProp && (
        <PropertySheet
          onClose={() => setAddingProp(false)}
          onSaved={(p) => {
            setAddingProp(false);
            reloadProps();
            setPropChoice(p.id);
          }}
        />
      )}
    </>
  );
}

/** quote_order with the delivery point; the older signature (before 0026) without it. */
async function quoteOrder(args: Record<string, unknown>) {
  const res = await supabase().rpc("quote_order", args);
  if (!res.error || !isMissing(res.error)) return res;
  const { p_lat: _lat, p_lng: _lng, ...old } = args;
  void _lat;
  void _lng;
  return supabase().rpc("quote_order", old);
}

function PayRow({ on, onPick, title, sub }: { on: boolean; onPick: () => void; title: string; sub: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="pm" onClick={onPick}>
      <span>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
      <i className={`radio ${on ? "on" : ""}`} />
    </button>
  );
}
