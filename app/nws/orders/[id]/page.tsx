"use client";

import "../../ops.css";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatBubbles } from "@/components/chat/OrderChat";
import { FleetMap } from "@/components/nws/FleetMap";
import type { LatLng, MapSite } from "@/components/nws/FleetMapView";
import { MONEY } from "@/components/nws/i18n/money";
import { ORD } from "@/components/nws/i18n/orders";
import { CHANNEL_LABEL, maskPhone, n3, one, orderSla, St, useNow, useRealtime, useRpc, useSignedUrl } from "@/components/nws/ops";
import { useCreditRpc } from "@/components/nws/credits";
import { PodLocation } from "@/components/PodLocation";
import { SignatureSvg } from "@/components/SignatureSvg";
import { DispatchSuggestions } from "@/components/nws/DispatchSuggestions";
import { PenaltyDialog } from "@/components/nws/PenaltyDialog";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { OrderBill, statusText } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { usePricingRules } from "@/components/usePricingRules";
import { detailParts, useWilayats } from "@/lib/address";
import { ADDR } from "@/lib/addressI18n";
import { friendlyError } from "@/lib/errors";
import { orderNo } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { label, freqLabel } from "@/lib/labels";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ref, type Order, type OrderLocation, type OrderMessage, type Pod as BasePod } from "@/lib/types";

type One<T> = T | T[] | null;
type Detail = Order & {
  filled_at: string | null; collected_at: string | null; discharged_at: string | null; released_at: string | null; approved_at: string | null;
  fill_meter_gal: number | null; fill_verified: boolean | null; discharge_verified: boolean | null; cancelled_by: string | null; cancel_reason: string | null;
  rating: number | null; rating_comment: string | null; tip: string; rated_at: string | null; cancel_fee: string; short_credit: string;
  customer: { id: string; full_name: string; phone: string | null } | null;
  driver: { full_name: string; phone: string | null } | null;
  tanker: { id: string; plate: string; service_type: string; capacity_gal: number; blocked: boolean; last_lat: number | null; last_lng: number | null } | null;
  zone: One<{ name: string }>;
  contract: One<{ contract_no: number; frequency: string }>;
  org: One<{ name: string }>;
  fill_site: One<{ code: string; name: string }>;
  discharge_site: One<{ code: string; name: string }>;
};
type Audit = { id: number; at: string; action: string; actor_email: string | null; reason: string | null };
type Payment = { id: string; method: string; amount: string; wallet_amount: string; card_amount: string; card_last4: string | null; status: string; gateway_ref: string | null; failure_reason: string | null; refunded_amount: string; created_at: string; captured_at: string | null };
type WalletTx = { id: number; kind: string; amount: string; memo: string; created_at: string };
// The proof's location fields come from lib/types (0024); these are the NWS-only extras.
type Pod = BasePod & { signature_path: string | null; rejected_reason: string | null };
type SourceEvent = { id: number; source: string; kind: string; meter_gal: number | null; verified: boolean; note: string; created_at: string; evidence_grade?: string | null; site: One<{ code: string; name: string }> };
type Message = OrderMessage & { sender: One<{ full_name: string }> };
// Keys of ORD (components/nws/i18n/orders).
const ROLE: Record<OrderMessage["sender_role"], string> = { customer: "roleCustomer", driver: "roleDriver", staff: "nws" };
type Complaint = { id: string; case_no: number; category: string; state: string; created_at: string; due_at: string };
type Penalty = { id: string; penalty_no: number; amount: string; state: string; reason: string; created_at: string; rule: One<{ label: string }> };
type Verification = { company: string | null; permit_no: string | null; permit_valid_to: string | null; water_test: { cert_no: string; passed: boolean; tested_at: string } | null; device: string | null } | null;
type Dlg = "reschedule" | "cancel" | "refund" | "penalty" | "adjust" | null;

// Payment methods (pm_*), sources (src_*) and evidence grades (gr_*, the tender's ±10 m, 0028) are worded in ORD.
const PAY_TONE: Record<string, string> = { pending: "warn", authorized: "act", captured: "ok", refunded: "warn", partially_refunded: "warn", failed: "bad", on_account: "act" };
const ON_JOB = ["accepted", "arriving", "arrived", "collected"];

/** Tomorrow 08:00–10:00 Muscat time (UTC+4, no daylight saving). */
function tomorrowMorning() {
  const m = new Date(Date.now() + 4 * 3_600_000);
  const start = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + 1, 4, 0));
  // `label` is stored on the order (English); `at` lets the screen word it in the portal language.
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 3_600_000).toISOString(), at: start, label: `${start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Muscat" })} 8–10 am` };
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { rules } = usePricingRules();
  const { can, toast, staff } = useStaff();
  const t = useT(ORD);
  const tm = useT(MONEY);
  const f = useFmt();
  const { lang } = useLang();
  // A lookup in ORD with the raw value as fallback (data values not in the dictionary).
  const tk = (prefix: string, v: string) => (ORD[`${prefix}${v}`] ? t(`${prefix}${v}`) : v);
  const readOnly = staff.staff_role === "viewer";
  const rpc = useRpc();
  const creditRpc = useCreditRpc();
  const now = useNow(30_000);
  const [o, setO] = useState<Detail | null>(null);
  const [loc, setLoc] = useState<OrderLocation | null>(null);
  const [sponsor, setSponsor] = useState<{ anonymous: boolean; site: { name: string } | null } | null>(null);
  const ta = useT(ADDR);
  const wil = useWilayats();
  const [audit, setAudit] = useState<Audit[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<WalletTx[]>([]);
  const [pod, setPod] = useState<Pod | null>(null);
  const [events, setEvents] = useState<SourceEvent[]>([]);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [verify, setVerify] = useState<Verification>(null);
  const [trail, setTrail] = useState<LatLng[] | null>(null);
  const [sites, setSites] = useState<MapSite[]>([]);
  const [missing, setMissing] = useState(false);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [amount, setAmount] = useState("");
  const [body, setBody] = useState("");

  const load = useCallback(async () => {
    const db = supabase();
    const [a, b, c, p, w, d, e, m, cx, pen, fx] = await Promise.all([
      db
        .from("orders")
        .select(
          "*, customer:profiles!orders_customer_id_fkey(id, full_name, phone:phone_masked), driver:profiles!orders_driver_id_fkey(full_name, phone:phone_masked), tanker:tankers!orders_tanker_id_fkey(id, plate, service_type, capacity_gal, blocked, last_lat, last_lng), zone:zones!orders_zone_id_fkey(name), contract:contracts!orders_contract_id_fkey(contract_no, frequency), org:organizations!orders_org_id_fkey(name), fill_site:sites!orders_fill_site_id_fkey(code, name), discharge_site:sites!orders_discharge_site_id_fkey(code, name)",
        )
        .eq("id", id)
        .maybeSingle(),
      db.from("order_locations").select("*").eq("order_id", id).maybeSingle(),
      db.from("audit_log").select("id, at, action, actor_email, reason").eq("target_type", "order").eq("target_id", id).order("at"),
      db.from("payments").select("*").eq("order_id", id).order("created_at"),
      db.from("wallet_tx").select("id, kind, amount, memo, created_at").eq("order_id", id).order("created_at"),
      db.from("pods").select("*").eq("order_id", id).maybeSingle(),
      db.from("source_events").select("id, source, kind, meter_gal, verified, note, created_at, evidence_grade, site:sites(code, name)").eq("order_id", id).order("created_at"),
      db.from("order_messages").select("id, order_id, sender_id, sender_role, body, created_at, read_at, sender:profiles!order_messages_sender_id_fkey(full_name)").eq("order_id", id).order("created_at"),
      db.from("complaints").select("id, case_no, category, state, created_at, due_at").eq("order_id", id).order("created_at"),
      db.from("penalties").select("id, penalty_no, amount, state, reason, created_at, rule:penalty_rules(label)").eq("order_id", id).order("created_at"),
      db.from("gps_fixes").select("lat, lng").eq("order_id", id).order("recorded_at").limit(1000),
    ]);
    if (a.error) return toast(friendlyError(a.error, lang), true);
    if (!a.data) return setMissing(true);
    setO(a.data as unknown as Detail);
    setLoc(b.data as OrderLocation | null);
    db.from("sponsorships")
      .select("anonymous, site:beneficiary_sites(name)")
      .eq("order_id", id)
      .maybeSingle()
      .then(({ data }) => setSponsor((data as unknown as { anonymous: boolean; site: { name: string } | null }) ?? null));
    setAudit((c.data ?? []) as Audit[]);
    setPayments((p.data ?? []) as Payment[]);
    setRefunds(((w.data ?? []) as WalletTx[]).filter((x) => x.kind === "refund" || x.kind === "goodwill" || x.kind === "cancel_fee"));
    setPod(d.data as Pod | null);
    setEvents((e.data ?? []) as unknown as SourceEvent[]);
    setMsgs((m.data ?? []) as unknown as Message[]);
    setComplaints((cx.data ?? []) as Complaint[]);
    setPenalties((pen.data ?? []) as unknown as Penalty[]);
    // Keep the same trail object unless it grew, so realtime reloads don't re-frame the map.
    const pts = (fx.data ?? []) as LatLng[];
    setTrail((prev) => (prev && prev.length === pts.length ? prev : pts.length > 1 ? pts : null));
    if ((a.data as Detail).tanker_id) {
      const v = await db.rpc("order_verification", { p_order_id: id });
      setVerify((v.data ?? null) as Verification);
    }
  }, [id, toast, lang]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    supabase()
      .from("sites")
      .select("id, code, kind, name, lat, lng, radius_m")
      .eq("active", true)
      .eq("is_test", false)
      .then(({ data }) => setSites(((data ?? []) as (MapSite & { code: string; name: string })[]).map((s) => ({ ...s, label: `${s.code} · ${s.name}` }))));
    return () => clearTimeout(t);
  }, [load]);
  useRealtime(`nws-order-${id}`, ["orders", "order_messages"], load, 800, { orders: `id=eq.${id}`, order_messages: `order_id=eq.${id}` });

  const photo = useSignedUrl(pod?.photo_path);
  const sigFile = useSignedUrl(pod?.signature_svg ? null : pod?.signature_path);

  async function act(action: "assign" | "cancel" | "reschedule" | "refund", reason: string, extra: Record<string, unknown>, ok: string) {
    if (await rpc("staff_order_action", { p_order_id: id, p_action: action, p_reason: reason, ...extra }, ok)) {
      setDlg(null);
      load();
    }
  }

  async function send() {
    const text = body.trim();
    if (!text || readOnly) return;
    if (await rpc("send_message", { p_order_id: id, p_body: text })) {
      setBody("");
      load();
    }
  }

  const mapTankers = useMemo(
    () => (o?.tanker?.last_lat != null && o.tanker.last_lng != null ? [{ id: o.tanker.id, lat: o.tanker.last_lat, lng: o.tanker.last_lng, type: o.tanker.service_type as ServiceType, stale: false, blocked: o.tanker.blocked, label: o.tanker.plate }] : []),
    [o],
  );
  const mapOrders = useMemo(() => (o && loc ? [{ id: o.id, lat: loc.lat, lng: loc.lng, type: o.service_type, label: `${orderNo(o.order_no)} · ${t("deliveryPoint")}` }] : []), [o, loc, t]);

  if (missing) return <div className="empty">{t("notFoundOrder")}</div>;
  if (!o) return <div className="empty">{t("loading")}</div>;

  // Timeline from the order's own status timestamps, plus any staff (audit) actions on it.
  const ww = o.service_type === "WW";
  const channelText = label("channel", o.channel ?? "app", lang, CHANNEL_LABEL[o.channel ?? "app"] ?? o.channel);
  const timeline = [
    { at: o.created_at, text: `${t("tlVia", { what: t(o.status === "scheduled" || o.slot_label ? "tlBooked" : "tlRequested"), channel: channelText })}${o.slot_label ? t("tlFor", { slot: o.slot_label }) : ""}`, cls: "done" },
    { at: o.approved_at, text: t("tlApproved"), cls: "done" },
    { at: o.released_at, text: t("tlReleased"), cls: "done" },
    { at: o.accepted_at, text: `${t("tlAccepted", { driver: o.driver_name ?? t("driver") })}${o.tanker_plate ? ` · ${o.tanker_plate}` : ""}`, cls: "done" },
    { at: o.filled_at, text: `${t("tlFilled", { site: one(o.fill_site)?.name ?? t("tlStation") })}${o.fill_meter_gal ? ` · ${f.gal(o.fill_meter_gal)}` : ""}`, cls: o.fill_verified === false ? "bad" : "done" },
    { at: o.arriving_at, text: t("tlOnWay"), cls: "done" },
    { at: o.arrived_at, text: t("tlArrived"), cls: "done" },
    { at: o.collected_at, text: t("tlCollected"), cls: "done" },
    { at: o.discharged_at, text: t("tlDischarged", { site: one(o.discharge_site)?.name ?? t("tlPlant") }), cls: o.discharge_verified === false ? "bad" : "done" },
    { at: o.delivered_at, text: ww ? t("tlComplete") : t("tlDelivered"), cls: "done" },
    { at: o.cancelled_at, text: `${t("tlCancelled", { who: o.cancelled_by ?? t("tlTheCustomer") })}${o.cancel_reason ? ` — ${o.cancel_reason}` : ""}`, cls: "bad" },
    { at: o.rated_at, text: `${t("tlRated", { stars: "★".repeat(o.rating ?? 0) })}${o.rating_comment ? ` — “${o.rating_comment}”` : ""}${Number(o.tip) > 0 ? t("tlTip", { amt: f.omr3(o.tip) }) : ""}`, cls: "done" },
    ...audit.map((a) => ({ at: a.at, text: `${t("tlBy", { action: a.action, who: a.actor_email ?? t("tlStaff") })}${a.reason ? ` — ${a.reason}` : ""}`, cls: "done" })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const pay = payments[payments.length - 1] ?? null;
  const refundable = pay ? Number(pay.amount) - Number(pay.refunded_amount) : 0;
  const sla = orderSla(o, now, lang);
  const [stText, stTone] = statusText(o.status, o.service_type, lang);
  const isOp = can("operator");
  const canRefund = can("operator", "finance", "complaints_agent");
  const opTip = isOp ? undefined : t("opsOnly");
  const short = pod && pod.meter_gal < o.gallons * 0.95;
  const slot = tomorrowMorning();
  const slotText = lang === "en" ? slot.label : t("slotMorning", { day: f.fmt(slot.at, { weekday: "short", day: "numeric", month: "short" }) });
  const ord = orderNo(o.order_no);
  const signed = Boolean(pod?.signature_svg?.trim() || sigFile);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>
            <bdi dir="ltr">{ord}</bdi> <span className={`st ${stTone}`}>{stText}</span> {o.is_emergency && <span className="st bad">{t("priorityCap")}</span>}{" "}
            {o.is_test && <span className="st warn" title={t("testTipFull")}>{t("test")}</span>}{" "}
            {sponsor && <span className="st ok">{t("sponsoredTag")}</span>}{" "}
            {o.payment_followup && !o.payment_followup_resolved_at && <span className="st warn">{t("payFollowTag")}</span>}
          </h1>
          <p>
            <span className={`tag ${o.service_type}`}>{o.service_type}</span> {f.gal(o.gallons)} · {o.area}
            {one(o.zone) ? ` · ${one(o.zone)!.name}` : ""} · {t("created", { at: f.dateTime(o.created_at) })} · {t("slaX")} {sla.tone ? <St tone={sla.tone}>{sla.text}</St> : "—"}
          </p>
        </div>
        <div className="btns">
          {o.status === "requested" && (
            <button className="btn pri" disabled={!isOp} title={opTip} onClick={() => document.getElementById("dispatch")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              {t("assign")}
            </button>
          )}
          {["requested", "scheduled"].includes(o.status) && (
            <button className="btn" disabled={!isOp} title={opTip} onClick={() => setDlg("reschedule")}>
              {t("moveTomorrow")}
            </button>
          )}
          {!["delivered", "cancelled"].includes(o.status) && (
            <button className="btn bad" disabled={!isOp} title={opTip} onClick={() => setDlg("cancel")}>
              {t("cancelOrder")}
            </button>
          )}
          {pay && refundable > 0 && o.billing !== "account" && !(pay.method === "cash" && pay.status === "authorized") && (
            <button
              className="btn"
              disabled={!canRefund}
              title={canRefund ? undefined : t("refundRoles")}
              onClick={() => {
                setAmount(n3(refundable));
                setDlg("refund");
              }}
            >
              {t("refundWallet")}
            </button>
          )}
          {o.status !== "cancelled" && !o.invoice_id && Number(o.delivery_fee) > 0 && (
            <button
              className="btn"
              disabled={!can("finance")}
              title={can("finance") ? undefined : t("refundRoles")}
              onClick={() => {
                setAmount(n3(Number(o.delivery_fee)));
                setDlg("adjust");
              }}
            >
              {tm("adjTitle")}
            </button>
          )}
          <Link href="/nws/orders" className="btn">
            {t("allOrders")}
          </Link>
        </div>
      </div>

      {o.status === "requested" && (
        <div id="dispatch">
          <DispatchSuggestions orderId={o.id} orderLabel={ord} canAssign={isOp} onAssigned={load} />
        </div>
      )}

      <div className="two">
        <div>
          <div className="panel">
            <h2>{t("timeline")}</h2>
            <ul className="tl">
              {timeline.map((e, i) => (
                <li key={i} className={e.cls}>
                  {e.text}
                  <small>{f.dateTime(e.at)}</small>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h2>
              {t("route")} <small>{trail ? t("nFixes", { n: f.n(trail.length) }) : t("noTrail")}</small>
            </h2>
            <div className="pad">
              <div className="minimap" style={{ height: 300 }}>
                <FleetMap tankers={mapTankers} orders={mapOrders} sites={sites} trail={trail} />
              </div>
              <dl className="kv" style={{ padding: 0 }}>
                <dt>{t("address")}</dt>
                <dd>{loc?.address || "—"}</dd>
                {loc && (detailParts(loc, lang, wil?.wilayats, ta).length > 0 || loc.landmark) && (
                  <>
                    <dt>{t("addrDetails")}</dt>
                    <dd>
                      {detailParts(loc, lang, wil?.wilayats, ta).join(" · ")}
                      {loc.landmark && <small className="d-block mut">{loc.landmark}</small>}
                    </dd>
                  </>
                )}
                {loc?.contact_phone && (
                  <>
                    <dt>{t("deliveryContact")}</dt>
                    <dd>
                      {loc.contact_name || "—"} · <bdi dir="ltr">{maskPhone(loc.contact_phone)}</bdi>
                      {loc.call_ahead && <St tone="warn">{t("callAhead")}</St>}
                    </dd>
                  </>
                )}
                {sponsor && (
                  <>
                    <dt>{t("sponsoredFor")}</dt>
                    <dd>
                      {sponsor.site?.name ?? "—"}
                      {sponsor.anonymous ? ` · ${t("sponsorAnon")}` : ""}
                    </dd>
                  </>
                )}
                {o.payment_followup && (
                  <>
                    <dt>{t("payFollowTag")}</dt>
                    <dd>
                      {t(`pf_${o.payment_followup}`)}
                      {o.payment_followup_resolved_at ? ` · ${t("pfResolved")}` : ""}
                    </dd>
                  </>
                )}
                <dt>{t("coords")}</dt>
                <dd>{loc ? <bdi dir="ltr">{`${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`}</bdi> : "—"}</dd>
                {o.driver_note && (
                  <>
                    <dt>{t("noteDriver")}</dt>
                    <dd>{o.driver_note}</dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          <div className="panel">
            <h2>
              {t("sourceVer")} <small>{t("sourceVerSub")}</small>
            </h2>
            {events.length === 0 ? (
              <p className="note">{ww ? t("noCollect") : t("noFill")}</p>
            ) : (
              <div className="tblwrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("time")}</th>
                      <th>{t("thEvent")}</th>
                      <th>{t("thSite")}</th>
                      <th className="num">{t("thMeter")}</th>
                      <th>{t("thCheck")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td><small>{f.dateTime(e.created_at)}</small></td>
                        <td>
                          {t(e.kind === "fill" ? "evFill" : e.kind === "discharge" ? "evDischarge" : e.kind === "valve_open" ? "evValve" : "evSignal")}
                          <small style={{ display: "block" }}>{tk("src_", e.source)}</small>
                        </td>
                        <td>{one(e.site)?.name ?? "—"}</td>
                        <td className="num">{e.meter_gal != null ? f.n(e.meter_gal) : "—"}</td>
                        <td>
                          <St tone={e.verified ? "ok" : "bad"}>{e.verified ? t("verified") : t("mismatch")}</St>{" "}
                          {e.evidence_grade && <St tone={e.evidence_grade === "low_accuracy" ? "warn" : "ok"}>{tk("gr_", e.evidence_grade)}</St>}
                          {e.note && <small style={{ display: "block" }}>{e.note}</small>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>
              {t("messages")} <small>{t("messagesSub")}</small>
            </h2>
            {msgs.length === 0 ? (
              <p className="note">{t("noMessages")}</p>
            ) : (
              <ChatBubbles
                msgs={msgs}
                me="staff"
                lang={lang}
                allTicks
                labels={{ sent: t("msgSent"), read: t("msgRead"), nws: t("nws") }}
                who={(m) => `${one((m as Message).sender)?.full_name || t(ROLE[m.sender_role])} · ${t(ROLE[m.sender_role])}`}
              />
            )}
            <div className="sendrow">
              <input className="in" placeholder={t("msgPh")} value={body} maxLength={500} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} aria-label={t("message")} />
              <button className="btn pri" disabled={!body.trim() || readOnly} title={readOnly ? t("readOnlyRole") : undefined} onClick={send}>
                {t("send")}
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>{t("people")}</h2>
            <dl className="kv">
              <dt>{t("customer")}</dt>
              <dd>
                {o.customer ? (
                  <Link className="lk" href={`/nws/customers?id=${o.customer.id}`}>
                    {o.customer.full_name || t("customer")}
                  </Link>
                ) : (
                  "—"
                )}
                {o.customer?.phone ? <small className="mut"> · <bdi dir="ltr">{maskPhone(o.customer.phone)}</bdi></small> : null}
              </dd>
              {one(o.org) && (
                <>
                  <dt>{t("bizAccount")}</dt>
                  <dd>
                    {one(o.org)!.name}
                    {o.po_number ? <small className="mut"> · <bdi dir="ltr">{ref.po(o.po_number)}</bdi></small> : null}
                  </dd>
                </>
              )}
              <dt>{t("plan")}</dt>
              <dd>
                {one(o.contract) ? `${t("contractX", { n: one(o.contract)!.contract_no })} · ${freqLabel(one(o.contract)!.frequency, lang)}` : channelText}
                {o.genesys_id ? <small className="mut"> · {t("genesys", { id: o.genesys_id })}</small> : null}
              </dd>
              <dt>{t("driver")}</dt>
              <dd>
                {o.driver?.full_name || o.driver_name || "—"}
                {o.driver?.phone ? <small className="mut"> · <bdi dir="ltr">{maskPhone(o.driver.phone)}</bdi></small> : null}
              </dd>
              <dt>{t("tanker")}</dt>
              <dd>
                {o.tanker ? (
                  <Link className="lk" href={`/nws/fleet?tanker=${o.tanker.id}`} dir="ltr">
                    {o.tanker.plate}
                  </Link>
                ) : (
                  o.tanker_plate || "—"
                )}
                {o.tanker ? <small className="mut"> · {o.tanker.service_type} · {f.gal(o.tanker.capacity_gal)}{o.tanker.blocked ? t("suspendedLc") : ""}</small> : null}
              </dd>
              {verify && (
                <>
                  <dt>{t("company")}</dt>
                  <dd>{verify.company ?? t("independent")}</dd>
                  <dt>{t("permit")}</dt>
                  <dd>{verify.permit_no ? t("permitTo", { no: verify.permit_no, date: f.date(verify.permit_valid_to) }) : t("noneOnFile")}</dd>
                  {o.service_type === "DW" && (
                    <>
                      <dt>{t("waterTest")}</dt>
                      <dd>
                        {verify.water_test ? (
                          <>
                            <bdi dir="ltr">{verify.water_test.cert_no}</bdi> <St tone={verify.water_test.passed ? "ok" : "bad"}>{verify.water_test.passed ? t("passed") : t("failed")}</St>{" "}
                            <small className="mut">{f.date(verify.water_test.tested_at)}</small>
                          </>
                        ) : (
                          t("noTest")
                        )}
                      </dd>
                    </>
                  )}
                  <dt>{t("ivmsDevice")}</dt>
                  <dd>{verify.device ? <bdi dir="ltr">{verify.device}</bdi> : t("none")}</dd>
                </>
              )}
            </dl>
          </div>

          <div className="panel">
            <h2>
              {t("price")} <small>{t("priceSub")}</small>
            </h2>
            <OrderBill order={o} rules={rules} />
            {o.price_basis?.tariff && (
              <p className="note" style={{ margin: "0 12px 8px" }}>
                {tm("adjLocked")}
                {o.price_basis.locked_at ? ` · ${f.dateTime(o.price_basis.locked_at)}` : ""} ·{" "}
                {tm("adjClass", { code: o.price_basis.tariff.code, zone: o.price_basis.delivery?.is_default === false ? (o.price_basis.delivery.zone ?? "") : tm("dcDefault") })}
                {(o.price_basis.adjustments ?? []).map((a) => (
                  <span key={a.at} style={{ display: "block" }}>
                    {tm("adjHistory", { at: f.dateTime(a.at), from: f.n3(a.delivery_fee[0]), to: f.n3(a.delivery_fee[1]), reason: a.reason })}
                  </span>
                ))}
              </p>
            )}
            <dl className="kv" style={{ paddingTop: 0 }}>
              {Number(o.discount ?? 0) > 0 && (
                <>
                  <dt>{t("discount")}</dt>
                  <dd>
                    −{f.omr3(o.discount ?? 0)}
                    {o.promo_code ? (
                      <>
                        {" "}
                        (<bdi dir="ltr">{o.promo_code}</bdi>)
                      </>
                    ) : null}
                  </dd>
                </>
              )}
              <dt>{t("driverEarnings")}</dt>
              <dd>{f.omr3(o.driver_earnings)}</dd>
              {Number(o.cancel_fee) > 0 && (
                <>
                  <dt>{t("cancelFee")}</dt>
                  <dd>{f.omr3(o.cancel_fee)}</dd>
                </>
              )}
              <dt>{t("pricedMode")}</dt>
              <dd>{o.price_basis?.mode ?? "—"}</dd>
            </dl>
          </div>

          <div className="panel">
            <h2>
              {t("payment")} {pay && <St tone={PAY_TONE[pay.status]}>{ORD[`pay_${pay.status}`] ? t(`pay_${pay.status}`) : pay.status.replace("_", " ")}</St>}
            </h2>
            {!pay ? (
              <p className="note">{o.billing === "account" ? t("billedAccount") : t("noPayment")}</p>
            ) : (
              <dl className="kv">
                <dt>{t("method")}</dt>
                <dd>
                  {tk("pm_", pay.method)}
                  {pay.card_last4 ? (
                    <>
                      {" ·"}
                      <bdi dir="ltr">{`••• ${pay.card_last4}`}</bdi>
                    </>
                  ) : null}
                </dd>
                <dt>{t("amount")}</dt>
                <dd>
                  {f.omr3(pay.amount)}
                  {Number(pay.wallet_amount) > 0 && Number(pay.card_amount) > 0 ? <small className="mut">{t("walletCard", { w: f.n3(pay.wallet_amount), c: f.n3(pay.card_amount) })}</small> : null}
                </dd>
                <dt>{t("reference")}</dt>
                <dd>{pay.gateway_ref ? <bdi dir="ltr">{pay.gateway_ref}</bdi> : "—"}</dd>
                <dt>{t("authorised")}</dt>
                <dd>{f.dateTime(pay.created_at)}</dd>
                <dt>{t("captured")}</dt>
                <dd>{f.dateTime(pay.captured_at)}</dd>
                {pay.failure_reason && (
                  <>
                    <dt>{t("failure")}</dt>
                    <dd style={{ color: "var(--bad)" }}>{pay.failure_reason}</dd>
                  </>
                )}
                <dt>{t("refunded")}</dt>
                <dd>{f.omr3(pay.refunded_amount)}</dd>
              </dl>
            )}
            {refunds.length > 0 && (
              <ul className="tl">
                {refunds.map((r) => (
                  <li key={r.id} className="done">
                    {r.kind === "cancel_fee" ? t("fee") : t("walletCredit")} {f.omr3(r.amount)} — {r.memo}
                    <small>{f.dateTime(r.created_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <h2>
              {pod?.kind === "collection" ? t("proofCollection") : t("proofDelivery")} {pod && <St tone={pod.status === "accepted" ? "ok" : "bad"}>{tk("pod_", pod.status)}</St>}
            </h2>
            {!pod ? (
              <p className="note">{t("notSubmitted")}</p>
            ) : (
              <div className="pad">
                {pod.status === "rejected" && pod.rejected_reason && <div className="banner badb">{t("rejectedX", { reason: pod.rejected_reason })}</div>}
                {short && (
                  <div className="banner">
                    {t("shortVol", { m: f.gal(pod.meter_gal), o: f.gal(o.gallons) })}
                    {Number(o.short_credit ?? 0) > 0 && t(o.billing === "account" ? "shortAccount" : "shortWallet", { amt: f.omr3(o.short_credit ?? 0) })}
                  </div>
                )}
                <dl className="kv" style={{ padding: "0 0 12px" }}>
                  <dt>{t("meterReading")}</dt>
                  <dd>{f.gal(pod.meter_gal)}</dd>
                  <dt>{t("submitted")}</dt>
                  <dd>{f.dateTime(pod.created_at)}</dd>
                  <dt>{t("signature")}</dt>
                  <dd>{pod.no_signature ? <St tone="warn">{t("noSign")}</St> : signed ? t("signed") : "—"}</dd>
                  {pod.left_at_tank && (
                    <>
                      <dt>{t("leftAtTank")}</dt>
                      <dd>{t("yes")}</dd>
                    </>
                  )}
                </dl>
                <PodLocation pod={pod} site={loc} />
                <div className="grid2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not optimisable */}
                  {photo ? <img className="pod-img" src={photo} alt={t("podAlt", { order: ord })} /> : <span className="mut" style={{ fontSize: 13 }}>{pod.photo_path ? t("loadingPhoto") : t("noPhoto")}</span>}
                  {signed && !pod.no_signature && (
                    <div className="sig">
                      {pod.signature_svg?.trim() ? (
                        <SignatureSvg value={pod.signature_svg} label={t("custSignature")} style={{ width: "100%", color: "#0e2329" }} />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                        <img src={sigFile!} alt={t("custSignature")} style={{ width: "100%" }} />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>
              {t("complaintsPenalties")}
              <button className="btn sm" disabled={!can("operator", "inspector", "admin") || !o.tanker_id} title={o.tanker_id ? undefined : t("noTankerOrder")} onClick={() => setDlg("penalty")}>
                {t("issuePenalty")}
              </button>
            </h2>
            {complaints.length === 0 && penalties.length === 0 && <p className="note">{t("noneOnOrder")}</p>}
            {complaints.length > 0 && (
              <div className="alist">
                {complaints.map((c) => (
                  <div key={c.id}>
                    <Link className="lk" href={`/nws/complaints?id=${c.id}`} dir="ltr">
                      C-{c.case_no}
                    </Link>{" "}
                    {c.category.replace(/_/g, " ")} <St tone={c.state === "resolved" ? "ok" : c.state === "escalated" ? "bad" : "warn"}>{tk("cs_", c.state)}</St>
                    <span className="mut" style={{ display: "block" }}>{t("openedDue", { at: f.dateTime(c.created_at), due: f.dateTime(c.due_at) })}</span>
                  </div>
                ))}
              </div>
            )}
            {penalties.length > 0 && (
              <div className="alist">
                {penalties.map((p) => (
                  <div key={p.id}>
                    <b>
                      <bdi dir="ltr">V-{p.penalty_no}</bdi> · {one(p.rule)?.label ?? t("penaltyWord")} · {f.omr3(p.amount)}{" "}
                      <St tone={p.state === "cancelled" ? "" : p.state === "upheld" ? "bad" : "warn"}>{label("penalty", p.state, lang, p.state)}</St>
                    </b>
                    <span className="mut">
                      {p.reason} · {f.dateTime(p.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {dlg === "reschedule" && (
        <ReasonDialog
          title={t("moveTitle", { order: ord, slot: slotText })}
          body={t("moveBody")}
          confirm={t("moveOrder")}
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("reschedule", r, { p_slot_start: slot.start, p_slot_end: slot.end, p_slot_label: slot.label }, t("movedTo", { order: ord, slot: slotText }))}
        />
      )}
      {dlg === "cancel" && (
        <ReasonDialog
          title={t("cancelTitle", { order: ord })}
          body={ON_JOB.includes(o.status) ? t("cancelOnJob", { status: lang === "en" ? stText.toLowerCase() : stText }) : t("cancelBody")}
          confirm={t("cancelOrder")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("cancel", r, {}, t("cancelledX", { order: ord }))}
        />
      )}
      {dlg === "refund" && (
        <ReasonDialog
          title={t("refundTitle", { order: ord })}
          body={t("refundBody", { amt: f.omr3(refundable) })}
          confirm={t("refund")}
          extra={
            <div className="fld">
              <label htmlFor="ra">{t("amountOmr")}</label>
              <input id="ra" className="in" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={async (r) => {
            const amt = Number(amount);
            if (!(amt > 0)) return toast(t("badAmount"), true);
            // Above STAFF_CREDIT_LIMITS the database asks for a second approver: filed for finance (0051).
            const a = Math.min(amt, refundable);
            if (await creditRpc("staff_order_action", { p_order_id: id, p_action: "refund", p_reason: r, p_amount: a }, t("refundedX", { amt: f.omr3(a) }),
                                { kind: "order_refund", customer: o.customer_id, amount: a, reason: r, order: id })) {
              setDlg(null);
              load();
            }
          }}
        />
      )}
      {dlg === "adjust" && (
        <ReasonDialog
          title={tm("adjTitle")}
          body={tm("adjBody")}
          confirm={tm("adjSave")}
          extra={
            <div className="fld">
              <label htmlFor="adj-fee">{tm("adjNewFee")}</label>
              <input id="adj-fee" className="in" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={async (r) => {
            const fee = Number(amount);
            if (!(fee >= 0)) return toast(t("badAmount"), true);
            const { data, error } = await supabase().rpc("staff_adjust_order_price", { p_order_id: id, p_delivery_fee: fee, p_reason: r }).single<{ total: string }>();
            if (error) return toast(friendlyError(error, lang), true);
            toast(tm("adjDone", { total: f.omr3(data?.total ?? 0) }));
            setDlg(null);
            load();
          }}
        />
      )}
      {dlg === "penalty" && <PenaltyDialog title={t("penaltyTitle", { x: ord })} tankerId={o.tanker_id} orderId={o.id} onClose={() => setDlg(null)} onDone={load} />}
    </>
  );
}
