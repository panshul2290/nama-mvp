"use client";

import "../../ops.css";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatBubbles } from "@/components/chat/OrderChat";
import { FleetMap } from "@/components/nws/FleetMap";
import type { LatLng, MapSite } from "@/components/nws/FleetMapView";
import { CHANNEL_LABEL, maskPhone, n3, omr3, one, orderSla, St, useNow, useRealtime, useRpc, useSignedUrl } from "@/components/nws/ops";
import { PodLocation } from "@/components/PodLocation";
import { SignatureSvg } from "@/components/SignatureSvg";
import { DispatchSuggestions } from "@/components/nws/DispatchSuggestions";
import { PenaltyDialog } from "@/components/nws/PenaltyDialog";
import { fmtDate, fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { OrderBill, STATUS_TEXT, statusText } from "@/components/OrderBits";
import { usePricingRules } from "@/components/usePricingRules";
import { friendlyError } from "@/lib/errors";
import { orderNo } from "@/lib/format";
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
const ROLE: Record<OrderMessage["sender_role"], string> = { customer: "Customer", driver: "Driver", staff: "NWS" };
type Complaint = { id: string; case_no: number; category: string; state: string; created_at: string; due_at: string };
type Penalty = { id: string; penalty_no: number; amount: string; state: string; reason: string; created_at: string; rule: One<{ label: string }> };
type Verification = { company: string | null; permit_no: string | null; permit_valid_to: string | null; water_test: { cert_no: string; passed: boolean; tested_at: string } | null; device: string | null } | null;
type Dlg = "reschedule" | "cancel" | "refund" | "penalty" | null;

const PAY_LABEL: Record<string, string> = { wallet: "Wallet", card: "Card", omannet: "OmanNet", wallet_card: "Wallet + card", account: "On account (B2B)", cash: "Cash on delivery" };
const PAY_TONE: Record<string, string> = { authorized: "act", captured: "ok", refunded: "warn", partially_refunded: "warn", failed: "bad", on_account: "act" };
const SOURCE_LABEL: Record<string, string> = { tfs: "Filling station (TFS)", ivms: "IVMS", stp: "Treatment plant (STP)", tas: "TAS" };
// Evidence grade of a geofence check (0028): the tender's ±10 m.
const GRADE: Record<string, string> = { ivms: "IVMS ±10 m", gps_precise: "GPS ±10 m", low_accuracy: "Low accuracy", test_zone: "Test zone" };
const ON_JOB = ["accepted", "arriving", "arrived", "collected"];

/** Tomorrow 08:00–10:00 Muscat time (UTC+4, no daylight saving). */
function tomorrowMorning() {
  const m = new Date(Date.now() + 4 * 3_600_000);
  const start = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + 1, 4, 0));
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 3_600_000).toISOString(), label: `${start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Muscat" })} 8–10 am` };
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { rules } = usePricingRules();
  const { can, toast, staff } = useStaff();
  const readOnly = staff.staff_role === "viewer";
  const rpc = useRpc();
  const now = useNow(30_000);
  const [o, setO] = useState<Detail | null>(null);
  const [loc, setLoc] = useState<OrderLocation | null>(null);
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
          "*, customer:profiles!orders_customer_id_fkey(id, full_name, phone), driver:profiles!orders_driver_id_fkey(full_name, phone), tanker:tankers(id, plate, service_type, capacity_gal, blocked, last_lat, last_lng), zone:zones!orders_zone_id_fkey(name), contract:contracts!orders_contract_id_fkey(contract_no, frequency), org:organizations!orders_org_id_fkey(name), fill_site:sites!orders_fill_site_id_fkey(code, name), discharge_site:sites!orders_discharge_site_id_fkey(code, name)",
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
    if (a.error) return toast(friendlyError(a.error), true);
    if (!a.data) return setMissing(true);
    setO(a.data as unknown as Detail);
    setLoc(b.data as OrderLocation | null);
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
  }, [id, toast]);

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
  const mapOrders = useMemo(() => (o && loc ? [{ id: o.id, lat: loc.lat, lng: loc.lng, type: o.service_type, label: `${orderNo(o.order_no)} · delivery point` }] : []), [o, loc]);

  if (missing) return <div className="empty">Order not found.</div>;
  if (!o) return <div className="empty">Loading…</div>;

  // Timeline from the order's own status timestamps, plus any staff (audit) actions on it.
  const ww = o.service_type === "WW";
  const timeline = [
    { at: o.created_at, text: `${o.status === "scheduled" || o.slot_label ? "Booked" : "Requested"} via ${CHANNEL_LABEL[o.channel ?? "app"] ?? o.channel}${o.slot_label ? ` for ${o.slot_label}` : ""}`, cls: "done" },
    { at: o.approved_at, text: "Approved by the business account", cls: "done" },
    { at: o.released_at, text: "Released to dispatch", cls: "done" },
    { at: o.accepted_at, text: `Accepted by ${o.driver_name ?? "driver"}${o.tanker_plate ? ` · ${o.tanker_plate}` : ""}`, cls: "done" },
    { at: o.filled_at, text: `Filled at ${one(o.fill_site)?.name ?? "station"}${o.fill_meter_gal ? ` · ${o.fill_meter_gal.toLocaleString()} gal` : ""}`, cls: o.fill_verified === false ? "bad" : "done" },
    { at: o.arriving_at, text: "On the way (first GPS fix)", cls: "done" },
    { at: o.arrived_at, text: "Arrived", cls: "done" },
    { at: o.collected_at, text: "Wastewater collected", cls: "done" },
    { at: o.discharged_at, text: `Discharged at ${one(o.discharge_site)?.name ?? "plant"}`, cls: o.discharge_verified === false ? "bad" : "done" },
    { at: o.delivered_at, text: ww ? "Job complete" : "Delivered", cls: "done" },
    { at: o.cancelled_at, text: `Cancelled by ${o.cancelled_by ?? "the customer"}${o.cancel_reason ? ` — ${o.cancel_reason}` : ""}`, cls: "bad" },
    { at: o.rated_at, text: `Rated ${"★".repeat(o.rating ?? 0)}${o.rating_comment ? ` — “${o.rating_comment}”` : ""}${Number(o.tip) > 0 ? ` · tip ${omr3(o.tip)}` : ""}`, cls: "done" },
    ...audit.map((a) => ({ at: a.at, text: `${a.action} by ${a.actor_email ?? "staff"}${a.reason ? ` — ${a.reason}` : ""}`, cls: "done" })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const pay = payments[payments.length - 1] ?? null;
  const refundable = pay ? Number(pay.amount) - Number(pay.refunded_amount) : 0;
  const sla = orderSla(o, now);
  const isOp = can("operator");
  const canRefund = can("operator", "finance", "complaints_agent");
  const opTip = isOp ? undefined : "Control room operators only";
  const short = pod && pod.meter_gal < o.gallons * 0.95;
  const slot = tomorrowMorning();
  const signed = Boolean(pod?.signature_svg?.trim() || sigFile);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>
            {orderNo(o.order_no)} <span className={`st ${statusText(o.status, o.service_type)[1]}`}>{statusText(o.status, o.service_type)[0]}</span> {o.is_emergency && <span className="st bad">Priority</span>}{" "}
            {o.is_test && <span className="st warn" title="Test zone order: not counted in KPIs, reports or invoices; no penalties">TEST</span>}
          </h1>
          <p>
            <span className={`tag ${o.service_type}`}>{o.service_type}</span> {o.gallons.toLocaleString()} gal · {o.area}
            {one(o.zone) ? ` · ${one(o.zone)!.name}` : ""} · created {fmtDateTime(o.created_at)} · SLA {sla.tone ? <St tone={sla.tone}>{sla.text}</St> : "—"}
          </p>
        </div>
        <div className="btns">
          {o.status === "requested" && (
            <button className="btn pri" disabled={!isOp} title={opTip} onClick={() => document.getElementById("dispatch")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              Assign
            </button>
          )}
          {["requested", "scheduled"].includes(o.status) && (
            <button className="btn" disabled={!isOp} title={opTip} onClick={() => setDlg("reschedule")}>
              Move to tomorrow 8–10 am
            </button>
          )}
          {!["delivered", "cancelled"].includes(o.status) && (
            <button className="btn bad" disabled={!isOp} title={opTip} onClick={() => setDlg("cancel")}>
              Cancel order
            </button>
          )}
          {pay && refundable > 0 && o.billing !== "account" && !(pay.method === "cash" && pay.status === "authorized") && (
            <button
              className="btn"
              disabled={!canRefund}
              title={canRefund ? undefined : "Operators, finance and complaints agents"}
              onClick={() => {
                setAmount(n3(refundable));
                setDlg("refund");
              }}
            >
              Refund to wallet
            </button>
          )}
          <Link href="/nws/orders" className="btn">
            ← All orders
          </Link>
        </div>
      </div>

      {o.status === "requested" && (
        <div id="dispatch">
          <DispatchSuggestions orderId={o.id} orderLabel={orderNo(o.order_no)} canAssign={isOp} onAssigned={load} />
        </div>
      )}

      <div className="two">
        <div>
          <div className="panel">
            <h2>Status timeline</h2>
            <ul className="tl">
              {timeline.map((e, i) => (
                <li key={i} className={e.cls}>
                  {e.text}
                  <small>{fmtDateTime(e.at)}</small>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h2>
              Route and delivery point <small>{trail ? `${trail.length} GPS fixes on this job` : "no GPS trail recorded for this job"}</small>
            </h2>
            <div className="pad">
              <div className="minimap" style={{ height: 300 }}>
                <FleetMap tankers={mapTankers} orders={mapOrders} sites={sites} trail={trail} />
              </div>
              <dl className="kv" style={{ padding: 0 }}>
                <dt>Address</dt>
                <dd>{loc?.address || "—"}</dd>
                <dt>Coordinates</dt>
                <dd>{loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : "—"}</dd>
                {o.driver_note && (
                  <>
                    <dt>Note to driver</dt>
                    <dd>{o.driver_note}</dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          <div className="panel">
            <h2>
              Source verification <small>station, plant and IVMS events</small>
            </h2>
            {events.length === 0 ? (
              <p className="note">{ww ? "No collection or discharge events yet." : "No filling events yet."}</p>
            ) : (
              <div className="tblwrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Site</th>
                      <th className="num">Meter</th>
                      <th>Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td><small>{fmtDateTime(e.created_at)}</small></td>
                        <td>
                          {e.kind === "fill" ? "Fill" : e.kind === "discharge" ? "Discharge" : e.kind === "valve_open" ? "Valve opened" : "Signal"}
                          <small style={{ display: "block" }}>{SOURCE_LABEL[e.source] ?? e.source}</small>
                        </td>
                        <td>{one(e.site)?.name ?? "—"}</td>
                        <td className="num">{e.meter_gal != null ? e.meter_gal.toLocaleString() : "—"}</td>
                        <td>
                          <St tone={e.verified ? "ok" : "bad"}>{e.verified ? "Verified" : "Mismatch"}</St>{" "}
                          {e.evidence_grade && <St tone={e.evidence_grade === "low_accuracy" ? "warn" : "ok"}>{GRADE[e.evidence_grade] ?? e.evidence_grade}</St>}
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
              Messages <small>customer, driver and NWS</small>
            </h2>
            {msgs.length === 0 ? (
              <p className="note">No messages on this order.</p>
            ) : (
              <ChatBubbles
                msgs={msgs}
                me="staff"
                lang="en"
                allTicks
                labels={{ sent: "Sent, not read yet", read: "Read", nws: "NWS" }}
                who={(m) => `${one((m as Message).sender)?.full_name || ROLE[m.sender_role]} · ${ROLE[m.sender_role]}`}
              />
            )}
            <div className="sendrow">
              <input className="in" placeholder="Message the customer and driver as NWS…" value={body} maxLength={500} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} aria-label="Message" />
              <button className="btn pri" disabled={!body.trim() || readOnly} title={readOnly ? "Read-only role" : undefined} onClick={send}>
                Send
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>People and tanker</h2>
            <dl className="kv">
              <dt>Customer</dt>
              <dd>
                {o.customer ? (
                  <Link className="lk" href={`/nws/customers?id=${o.customer.id}`}>
                    {o.customer.full_name || "Customer"}
                  </Link>
                ) : (
                  "—"
                )}
                {o.customer?.phone ? <small className="mut"> · {maskPhone(o.customer.phone)}</small> : null}
              </dd>
              {one(o.org) && (
                <>
                  <dt>Business account</dt>
                  <dd>
                    {one(o.org)!.name}
                    {o.po_number ? <small className="mut"> · {ref.po(o.po_number)}</small> : null}
                  </dd>
                </>
              )}
              <dt>Plan</dt>
              <dd>
                {one(o.contract) ? `Contract CT-${one(o.contract)!.contract_no} · ${one(o.contract)!.frequency}` : (CHANNEL_LABEL[o.channel ?? "app"] ?? o.channel)}
                {o.genesys_id ? <small className="mut"> · Genesys {o.genesys_id}</small> : null}
              </dd>
              <dt>Driver</dt>
              <dd>
                {o.driver?.full_name || o.driver_name || "—"}
                {o.driver?.phone ? <small className="mut"> · {maskPhone(o.driver.phone)}</small> : null}
              </dd>
              <dt>Tanker</dt>
              <dd>
                {o.tanker ? (
                  <Link className="lk" href={`/nws/fleet?tanker=${o.tanker.id}`}>
                    {o.tanker.plate}
                  </Link>
                ) : (
                  o.tanker_plate || "—"
                )}
                {o.tanker ? <small className="mut"> · {o.tanker.service_type} · {o.tanker.capacity_gal.toLocaleString()} gal{o.tanker.blocked ? " · suspended" : ""}</small> : null}
              </dd>
              {verify && (
                <>
                  <dt>Company</dt>
                  <dd>{verify.company ?? "Independent"}</dd>
                  <dt>Permit</dt>
                  <dd>{verify.permit_no ? `${verify.permit_no} · to ${fmtDate(verify.permit_valid_to)}` : "None on file"}</dd>
                  {o.service_type === "DW" && (
                    <>
                      <dt>Water test</dt>
                      <dd>
                        {verify.water_test ? (
                          <>
                            {verify.water_test.cert_no} <St tone={verify.water_test.passed ? "ok" : "bad"}>{verify.water_test.passed ? "Passed" : "Failed"}</St>{" "}
                            <small className="mut">{fmtDate(verify.water_test.tested_at)}</small>
                          </>
                        ) : (
                          "No test on file"
                        )}
                      </dd>
                    </>
                  )}
                  <dt>IVMS device</dt>
                  <dd>{verify.device ?? "None"}</dd>
                </>
              )}
            </dl>
          </div>

          <div className="panel">
            <h2>
              Price <small>tags show lines priced from rules NWS hasn’t confirmed</small>
            </h2>
            <OrderBill order={o} rules={rules} />
            <dl className="kv" style={{ paddingTop: 0 }}>
              {Number(o.discount ?? 0) > 0 && (
                <>
                  <dt>Discount</dt>
                  <dd>−{n3(o.discount)} OMR{o.promo_code ? ` (${o.promo_code})` : ""}</dd>
                </>
              )}
              <dt>Driver earnings</dt>
              <dd>{n3(o.driver_earnings)} OMR</dd>
              {Number(o.cancel_fee) > 0 && (
                <>
                  <dt>Cancellation fee</dt>
                  <dd>{n3(o.cancel_fee)} OMR</dd>
                </>
              )}
              <dt>Priced in mode</dt>
              <dd>{o.price_basis?.mode ?? "—"}</dd>
            </dl>
          </div>

          <div className="panel">
            <h2>
              Payment {pay && <St tone={PAY_TONE[pay.status]}>{pay.status.replace("_", " ")}</St>}
            </h2>
            {!pay ? (
              <p className="note">{o.billing === "account" ? "Billed to the business account on its next invoice." : "No payment recorded."}</p>
            ) : (
              <dl className="kv">
                <dt>Method</dt>
                <dd>
                  {PAY_LABEL[pay.method] ?? pay.method}
                  {pay.card_last4 ? ` ·••• ${pay.card_last4}` : ""}
                </dd>
                <dt>Amount</dt>
                <dd>
                  {omr3(pay.amount)}
                  {Number(pay.wallet_amount) > 0 && Number(pay.card_amount) > 0 ? <small className="mut"> · wallet {n3(pay.wallet_amount)} + card {n3(pay.card_amount)}</small> : null}
                </dd>
                <dt>Reference</dt>
                <dd>{pay.gateway_ref ?? "—"}</dd>
                <dt>Authorised</dt>
                <dd>{fmtDateTime(pay.created_at)}</dd>
                <dt>Captured</dt>
                <dd>{fmtDateTime(pay.captured_at)}</dd>
                {pay.failure_reason && (
                  <>
                    <dt>Failure</dt>
                    <dd style={{ color: "var(--bad)" }}>{pay.failure_reason}</dd>
                  </>
                )}
                <dt>Refunded</dt>
                <dd>{omr3(pay.refunded_amount)}</dd>
              </dl>
            )}
            {refunds.length > 0 && (
              <ul className="tl">
                {refunds.map((r) => (
                  <li key={r.id} className="done">
                    {r.kind === "cancel_fee" ? "Fee" : "Wallet credit"} {n3(r.amount)} OMR — {r.memo}
                    <small>{fmtDateTime(r.created_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <h2>
              Proof of {pod?.kind === "collection" ? "collection" : "delivery"} {pod && <St tone={pod.status === "accepted" ? "ok" : "bad"}>{pod.status}</St>}
            </h2>
            {!pod ? (
              <p className="note">Not submitted yet.</p>
            ) : (
              <div className="pad">
                {pod.status === "rejected" && pod.rejected_reason && <div className="banner badb">Rejected: {pod.rejected_reason}</div>}
                {short && (
                  <div className="banner">
                    Meter reading {pod.meter_gal.toLocaleString()} gal is more than 5% under the {o.gallons.toLocaleString()} gal ordered (short volume).
                    {Number(o.short_credit ?? 0) > 0 &&
                      ` ${omr3(o.short_credit ?? 0)} ${o.billing === "account" ? "credited against the account invoice" : "refunded to the customer’s wallet"}.`}
                  </div>
                )}
                <dl className="kv" style={{ padding: "0 0 12px" }}>
                  <dt>Meter reading</dt>
                  <dd>{pod.meter_gal.toLocaleString()} gal</dd>
                  <dt>Submitted</dt>
                  <dd>{fmtDateTime(pod.created_at)}</dd>
                  <dt>Signature</dt>
                  <dd>{pod.no_signature ? <St tone="warn">Customer not available to sign</St> : signed ? "Signed" : "—"}</dd>
                  {pod.left_at_tank && (
                    <>
                      <dt>Left at tank</dt>
                      <dd>Yes</dd>
                    </>
                  )}
                </dl>
                <PodLocation pod={pod} site={loc} />
                <div className="grid2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not optimisable */}
                  {photo ? <img className="pod-img" src={photo} alt={`Proof of delivery for ${orderNo(o.order_no)}`} /> : <span className="mut" style={{ fontSize: 13 }}>{pod.photo_path ? "Loading photo…" : "No photo"}</span>}
                  {signed && !pod.no_signature && (
                    <div className="sig">
                      {pod.signature_svg?.trim() ? (
                        <SignatureSvg value={pod.signature_svg} label="Customer signature" style={{ width: "100%", color: "#0e2329" }} />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                        <img src={sigFile!} alt="Customer signature" style={{ width: "100%" }} />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>
              Complaints and penalties
              <button className="btn sm" disabled={!can("operator", "inspector", "admin") || !o.tanker_id} title={o.tanker_id ? undefined : "No tanker on this order"} onClick={() => setDlg("penalty")}>
                Issue penalty
              </button>
            </h2>
            {complaints.length === 0 && penalties.length === 0 && <p className="note">None on this order.</p>}
            {complaints.length > 0 && (
              <div className="alist">
                {complaints.map((c) => (
                  <div key={c.id}>
                    <Link className="lk" href={`/nws/complaints?id=${c.id}`}>
                      C-{c.case_no}
                    </Link>{" "}
                    {c.category.replace(/_/g, " ")} <St tone={c.state === "resolved" ? "ok" : c.state === "escalated" ? "bad" : "warn"}>{c.state}</St>
                    <span className="mut" style={{ display: "block" }}>Opened {fmtDateTime(c.created_at)} · due {fmtDateTime(c.due_at)}</span>
                  </div>
                ))}
              </div>
            )}
            {penalties.length > 0 && (
              <div className="alist">
                {penalties.map((p) => (
                  <div key={p.id}>
                    <b>
                      V-{p.penalty_no} · {one(p.rule)?.label ?? "Penalty"} · {omr3(p.amount)} <St tone={p.state === "cancelled" ? "" : p.state === "upheld" ? "bad" : "warn"}>{p.state}</St>
                    </b>
                    <span className="mut">
                      {p.reason} · {fmtDateTime(p.created_at)}
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
          title={`Move ${orderNo(o.order_no)} to ${slot.label}`}
          body="The order becomes scheduled and is released to dispatch 90 minutes before the slot. The customer keeps the same price."
          confirm="Move order"
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("reschedule", r, { p_slot_start: slot.start, p_slot_end: slot.end, p_slot_label: slot.label }, `${orderNo(o.order_no)} moved to ${slot.label}`)}
        />
      )}
      {dlg === "cancel" && (
        <ReasonDialog
          title={`Cancel ${orderNo(o.order_no)}`}
          body={
            ON_JOB.includes(o.status)
              ? `A driver is on this job (${STATUS_TEXT[o.status][0].toLowerCase()}). Cancelling stops the trip; the customer is notified and the full payment is refunded to their wallet.`
              : "The customer is notified and any payment is refunded to their wallet."
          }
          confirm="Cancel order"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => act("cancel", r, {}, `${orderNo(o.order_no)} cancelled`)}
        />
      )}
      {dlg === "refund" && (
        <ReasonDialog
          title={`Refund ${orderNo(o.order_no)} to wallet`}
          body={`Up to ${omr3(refundable)} can still be refunded. The customer is notified.`}
          confirm="Refund"
          extra={
            <div className="fld">
              <label htmlFor="ra">Amount (OMR)</label>
              <input id="ra" className="in" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={(r) => {
            const amt = Number(amount);
            if (!(amt > 0)) return toast("Enter a valid amount.", true);
            return act("refund", r, { p_amount: Math.min(amt, refundable) }, `${omr3(Math.min(amt, refundable))} refunded to the customer’s wallet`);
          }}
        />
      )}
      {dlg === "penalty" && <PenaltyDialog title={`Issue penalty — ${orderNo(o.order_no)}`} tankerId={o.tanker_id} orderId={o.id} onClose={() => setDlg(null)} onDone={load} />}
    </>
  );
}
