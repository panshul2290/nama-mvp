"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { SignatureSvg } from "@/components/SignatureSvg";
import { friendlyError } from "@/lib/errors";
import { initials } from "@/lib/format";
import { localDigits } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { Order, OrderMessage, Pod } from "@/lib/types";
import { useCx } from "./i18n";
import { amt3, ddate, dshort, dtshort, gal, omr3, tshort } from "./fmt";
import { slotOptions } from "./slots";
import { RuleFlag, Sheet } from "./ui";

// ---------------------------------------------------------------- driver verification
type WaterTest = { cert_no: string; tested_at: string; passed: boolean; chlorine: number; turbidity: number; tds: number; ph: number; ecoli: string; coliforms: string };
export type Verification = {
  company: string | null;
  company_rating: number | null;
  permit_no: string | null;
  permit_valid_to: string | null;
  licence_valid_to: string | null;
  tank_cleaned: string | null;
  water_test: WaterTest | null;
  device: string | null;
  capacity_gal: number | null;
  plate: string | null;
} | null;

export function useVerification(orderId: string, tankerId: string | null) {
  const [v, setV] = useState<Verification>(null);
  useEffect(() => {
    if (!tankerId) return;
    supabase()
      .rpc("order_verification", { p_order_id: orderId })
      .then(({ data }) => setV((data as Verification) ?? null));
  }, [orderId, tankerId]);
  return tankerId ? v : null;
}

/** Driver + tanker card with the NWS verification grid (prototype driverCard). */
export function DriverCard({ order, v, today }: { order: Order; v: Verification; today: string }) {
  const { t, lang } = useCx();
  const [cert, setCert] = useState(false);
  const valid = (d: string | null | undefined) => Boolean(d && d.slice(0, 10) >= today);
  const wt = v?.water_test;
  const water = order.service_type !== "WW";
  const plate = order.tanker_plate ?? v?.plate;
  return (
    <div className="dcard">
      <div className="dc-top">
        <span className="av">{initials(order.driver_name)}</span>
        <div>
          <b>{order.driver_name ?? t("driver")}</b>
          <small>
            {[v?.company, v?.company_rating != null ? `${localDigits(Number(v.company_rating).toFixed(1), lang)} ★` : null, v?.capacity_gal ? gal(v.capacity_gal, lang) : null]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        {plate && <span className="plate">{plate}</span>}
      </div>
      {v && (
        <>
          <div className="vf">
            <Icon name="shield" />
            {t("verNWS")}
          </div>
          <div className="vgrid">
            <Check ok={valid(v.permit_valid_to)} text={v.permit_valid_to ? `${t("permitTo")} ${ddate(v.permit_valid_to, lang)}` : t("permitNone")} />
            <Check ok={valid(v.licence_valid_to)} text={valid(v.licence_valid_to) ? t("lic") : t("licNone")} />
            {water && <Check ok={valid(v.tank_cleaned)} text={v.tank_cleaned ? t("cleanedTo", { d: ddate(v.tank_cleaned, lang) }) : t("cleanedNone")} />}
            {water && <Check ok={Boolean(wt?.passed)} text={wt ? (wt.passed ? t("wqPass", { d: ddate(wt.tested_at, lang) }) : t("wqFail")) : t("wqNone")} />}
          </div>
          {water && wt && (
            <button type="button" className="lk" onClick={() => setCert(true)}>
              {t("cert")}
            </button>
          )}
        </>
      )}
      {cert && wt && <CertSheet wt={wt} plate={plate ?? ""} onClose={() => setCert(false)} />}
    </div>
  );
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={ok ? "" : "no"}>
      <Icon name={ok ? "check" : "alert"} />
      {text}
    </span>
  );
}

function CertSheet({ wt, plate, onClose }: { wt: WaterTest; plate: string; onClose: () => void }) {
  const { t, lang } = useCx();
  const n = (v: number | string) => localDigits(String(v), lang);
  const nd = (s: string) => /not detected/i.test(s);
  const rows: [string, string, string, boolean][] = [
    [t("wqCl"), `${n(wt.chlorine)} mg/L`, "0.2–1.0", Number(wt.chlorine) >= 0.2 && Number(wt.chlorine) <= 1],
    [t("wqTurb"), `${n(wt.turbidity)} NTU`, "< 1", Number(wt.turbidity) < 1],
    [t("wqTds"), `${n(wt.tds)} ppm`, "< 1000", Number(wt.tds) < 1000],
    [t("wqPh"), n(wt.ph), "6.5–8.5", Number(wt.ph) >= 6.5 && Number(wt.ph) <= 8.5],
    [t("wqEcoli"), nd(wt.ecoli) ? t("notDetected") : wt.ecoli, "0 / 100 mL", nd(wt.ecoli)],
    [t("wqColi"), nd(wt.coliforms) ? t("notDetected") : wt.coliforms, "0 / 100 mL", nd(wt.coliforms)],
  ];
  return (
    <Sheet title={t("certT")} onClose={onClose}>
      <p className="mut small" style={{ marginTop: 0 }}>
        {plate} · {t("nwsLab")} · {ddate(wt.tested_at, lang)} · {wt.cert_no}
      </p>
      <table className="cx-table">
        <tbody>
          {rows.map(([a, b, c, ok]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>{b}</td>
              <td className="mut" dir="ltr">
                {c}
              </td>
              <td>
                <span className={`st ${ok ? "ok" : "bad"}`}>{t(ok ? "pass" : "fail")}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mut small">{t("wqStd")}</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------- masked chat
const QUICK = ["qm1", "qm2", "qm3", "qm4"];

export function Chat({ order, open, onToast }: { order: Order; open: boolean; onToast: (m: string) => void }) {
  const { t, lang } = useCx();
  const [msgs, setMsgs] = useState<OrderMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      supabase()
        .from("order_messages")
        .select("*")
        .eq("order_id", order.id)
        .order("created_at")
        .then(({ data }) => setMsgs((data ?? []) as OrderMessage[])),
    [order.id],
  );
  useEffect(() => {
    load();
    const db = supabase();
    const ch = db
      .channel(`chat-${order.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "order_messages", filter: `order_id=eq.${order.id}` }, (p) =>
        setMsgs((m) => (m.some((x) => x.id === (p.new as OrderMessage).id) ? m : [...m, p.new as OrderMessage])),
      )
      .subscribe((s) => {
        if (s === "SUBSCRIBED") load();
      });
    return () => {
      db.removeChannel(ch);
    };
  }, [order.id, load]);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [msgs.length]);

  async function send(body: string) {
    if (!body.trim()) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("send_message", { p_order_id: order.id, p_body: body.trim() }).single<OrderMessage>();
    setBusy(false);
    if (error || !data) return onToast(friendlyError(error));
    setText("");
    setMsgs((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
  }

  if (!open && msgs.length === 0) return null;
  return (
    <div className="cx-chat">
      {msgs.length > 0 && (
        <div className="chat">
          {msgs.map((m) => (
            <div key={m.id} className={`bub ${m.sender_role === "customer" ? "me" : ""}`}>
              {m.sender_role === "staff" && <b className="who">{t("nwsSupport")}</b>}
              {m.body}
              <small>{tshort(m.created_at, lang)}</small>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
      {open && (
        <>
          <div className="opts qm">
            {QUICK.map((k) => (
              <button key={k} type="button" className="opt" disabled={busy} onClick={() => send(t(k))}>
                {t(k)}
              </button>
            ))}
          </div>
          <div className="promo">
            <input value={text} maxLength={500} placeholder={t("typeMsg")} aria-label={t("typeMsg")} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(text)} />
            <button type="button" className="btn sm" disabled={busy || !text.trim()} onClick={() => send(text)}>
              {t("send")}
            </button>
          </div>
          <div className="tr-act" style={{ marginTop: 10 }}>
            <button type="button" className="cta sec" onClick={() => onToast(t("calling"))}>
              <Icon name="phone" /> {t("call")}
            </button>
            <button type="button" className="cta sec" disabled={busy} onClick={() => send(t("qm1"))}>
              <Icon name="chat" /> {t("msg")}
            </button>
          </div>
          <p className="tr-note">{t("masked")}</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- proof of delivery
export function PodCard({ order }: { order: Order }) {
  const { t, lang } = useCx();
  const [pod, setPod] = useState<Pod | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    supabase()
      .from("pods")
      .select("*")
      .eq("order_id", order.id)
      .maybeSingle<Pod>()
      .then(({ data }) => {
        setPod(data);
        if (data?.photo_path)
          supabase()
            .storage.from("evidence")
            .createSignedUrl(data.photo_path, 3600)
            .then(({ data: s }) => setPhoto(s?.signedUrl ?? null));
      });
  }, [order.id]);
  if (!pod) return null;
  const short = pod.meter_gal < order.gallons * 0.95;
  return (
    <div className="rq-card pad">
      <div className="row">
        <b>{t(pod.kind === "collection" ? "poc" : "pod")}</b>
        {pod.status === "rejected" && <span className="st bad">{t("podRejected")}</span>}
      </div>
      <div className="photo pod-photo">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={t("podPhoto")} />
        ) : (
          <svg viewBox="0 0 300 110" width="100%" height="100%" role="img" aria-label={t("podPhoto")}>
            <rect width="300" height="110" fill="#dfeaec" />
            <rect x="110" y="22" width="80" height="70" rx="6" fill="var(--dw)" opacity=".55" />
            <circle cx="150" cy="38" r="10" fill="#fff" />
            {pod.lat != null && pod.lng != null && (
              <text x="8" y="102" fontSize="10" fill="#0e2329">
                {pod.lat.toFixed(4)}°N {pod.lng.toFixed(4)}°E
              </text>
            )}
          </svg>
        )}
      </div>
      <div className="rq-kv">
        <span>{t("meter")}</span>
        <b className={short ? "badt" : ""}>
          {gal(pod.meter_gal, lang)}
          {short ? ` (${t("ordered")} ${gal(order.gallons, lang)})` : ""}
        </b>
      </div>
      <div className="rq-kv">
        <span>{t("time")}</span>
        <b>{dtshort(pod.created_at, lang)}</b>
      </div>
      {pod.lat != null && pod.lng != null && (
        <div className="rq-kv">
          <span>{t("coords")}</span>
          <b dir="ltr">
            {pod.lat.toFixed(5)}, {pod.lng.toFixed(5)}
          </b>
        </div>
      )}
      {Number(order.short_credit ?? 0) > 0 && (
        <div className="banner" role="status">
          {t(order.billing === "account" ? "shortCreditAcct" : "shortCredit", {
            got: gal(pod.meter_gal, lang),
            of: gal(order.gallons, lang),
            amt: omr3(order.short_credit ?? 0, lang),
          })}
        </div>
      )}
      {pod.left_at_tank && <p className="mut small">{t("leftAtTank")}</p>}
      <div className="sig">
        <span className="mut small">{t("signature")}</span>
        {pod.signature_svg?.trim() ? <SignatureSvg value={pod.signature_svg} label={t("signature")} style={{ color: "#0e2329" }} /> : <p className="mut small">{t("noSig")}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rating and tip
const TIPS = [0, 0.5, 1, 2];

export function RateCard({ order, onRated }: { order: Order; onRated: (o: Order) => void }) {
  const { t, lang } = useCx();
  const [stars, setStars] = useState(0);
  const [tip, setTip] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (order.rated_at) {
    return (
      <div className="banner okb">
        {t("thanks")} · {localDigits(order.rating ?? 0, lang)}★{Number(order.tip) > 0 ? ` · ${t("tipL")} ${omr3(order.tip ?? 0, lang)}` : ""}
      </div>
    );
  }
  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase()
      .rpc("rate_order", { p_order_id: order.id, p_rating: stars, p_comment: comment.trim() || null, p_tip: tip, p_tip_method: "wallet" })
      .single<Order>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    onRated(data);
  }
  return (
    <div className="rq-card pad">
      <b>{t("rate")}</b>
      <div className="stars" role="radiogroup" aria-label={t("rate")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={stars === n} className={n <= stars ? "on" : ""} aria-label={`${n}`} onClick={() => setStars(n)}>
            ★
          </button>
        ))}
      </div>
      <div className="fld">
        <span className="lbl">{t("tip")}</span>
        <div className="opts">
          {TIPS.map((v) => (
            <button key={v} type="button" className={`opt ${tip === v ? "on" : ""}`} onClick={() => setTip(v)}>
              {v ? omr3(v, lang) : t("noTip")}
            </button>
          ))}
        </div>
        {tip > 0 && <p className="mut small" style={{ margin: "6px 0 0" }}>{t("tipWallet")}</p>}
      </div>
      <div className="fld">
        <label htmlFor="rc">{t("comment")}</label>
        <input id="rc" maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || !stars} onClick={submit}>
        {busy ? t("sending") : t("submit")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- cancel / reschedule sheets
export function CancelSheet({ order, feeOmr, feeStatus, onClose, onDone }: { order: Order; feeOmr: number; feeStatus?: string; onClose: () => void; onDone: (o: Order) => void }) {
  const { t, lang } = useCx();
  const withFee = order.status === "accepted" || order.status === "arriving";
  const fee = Math.min(feeOmr, Number(order.total));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function cancel() {
    setBusy(true);
    setError(null);
    const db = supabase();
    const { data, error } = withFee
      ? await db.rpc("cancel_order_with_fee", { p_order_id: order.id, p_reason: reason.trim() || null }).single<Order>()
      : await db.rpc("cancel_order", { p_order_id: order.id }).single<Order>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    onDone(data);
  }
  return (
    <Sheet title={t("cancel")} onClose={onClose}>
      {withFee ? (
        <>
          <p>
            {t("cancelFee", { fee: omr3(fee, lang) })} <RuleFlag status={feeStatus} />
          </p>
          <p className="mut small">{t("cancelRefund", { r: amt3(Math.max(0, Number(order.total) - fee), lang) })}</p>
          <div className="fld">
            <label htmlFor="cr">{t("cancelWhy")}</label>
            <input id="cr" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </>
      ) : (
        <p>{t("cancelFree")}</p>
      )}
      {error && <div className="banner badb">{error}</div>}
      <button className="cta danger" disabled={busy} onClick={cancel}>
        {busy ? t("cancelling") : t("cancelYes")}
      </button>
      <button className="cta sec" onClick={onClose}>
        {t("keep")}
      </button>
    </Sheet>
  );
}

export function ReschedSheet({ order, now, onClose, onDone }: { order: Order; now: number; onClose: () => void; onDone: (o: Order) => void }) {
  const { t, lang } = useCx();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The price was fixed at booking, so only windows with the same evening-peak class are offered
  // (the server refuses others with reschedule_changes_price).
  const slots = slotOptions(now, false).filter((s) => s.peak === Boolean(order.slot_peak));
  async function pick(id: string) {
    const s = slots.find((x) => x.id === id);
    if (!s) return;
    setBusy(id);
    setError(null);
    const { data, error } = await supabase()
      .rpc("reschedule_order", { p_order_id: order.id, p_slot_start: s.start, p_slot_end: s.end, p_slot_label: s.label })
      .single<Order>();
    setBusy(null);
    if (error || !data) return setError(friendlyError(error));
    onDone(data);
  }
  return (
    <Sheet title={t("resched")} onClose={onClose}>
      {order.slot_start && (
        <p className="mut small" style={{ marginTop: 0 }}>
          {t("currentSlot")}: {dshort(order.slot_start, lang)} {tshort(order.slot_start, lang)}
        </p>
      )}
      <div className="opts" style={{ marginBottom: 14 }}>
        {slots.map((s) => (
          <button key={s.id} type="button" className={`opt ${order.slot_start && s.start && new Date(order.slot_start).getTime() === new Date(s.start).getTime() ? "on" : ""}`} disabled={busy !== null} onClick={() => pick(s.id)}>
            {t(s.key)}
            {s.peak ? ` · ${t("peak")}` : ""}
          </button>
        ))}
      </div>
      {!slots.length && <p className="small">{t("reschedNone")}</p>}
      <p className="mut small">
        {t("reschedNote")} {t("reschedPeakNote")}
      </p>
      {error && <div className="banner badb">{error}</div>}
    </Sheet>
  );
}
