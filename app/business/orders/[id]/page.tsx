"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder } from "@/components/business/BizContext";
import { slotText } from "@/components/business/data";
import { BIZ } from "@/components/business/i18n";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { PodLocation } from "@/components/PodLocation";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, useAction, useLive } from "@/components/portal/kit";
import { SignatureSvg } from "@/components/SignatureSvg";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type Complaint, type OrderStatus, type Pod } from "@/lib/types";

// One business order: what was booked, where it is, the proof of delivery (photo, meter reading,
// signature and where it was taken), cancelling before a tanker is on the way, and reporting a problem.
const CANCELLABLE: OrderStatus[] = ["pending_approval", "scheduled", "requested"];
type Sla = { category: string; label: string; hours: number };
type Site = { label: string; address: string; area: string; lat: number; lng: number };

export default function BusinessOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { profile, role, isAdmin } = useBiz();
  const [o, setO] = useState<BizOrder | null | undefined>(undefined);
  const [pod, setPod] = useState<Pod | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [cases, setCases] = useState<Complaint[]>([]);
  const [dlg, setDlg] = useState<"cancel" | "report" | null>(null);
  const t = useT(BIZ);
  const f = useFmt();

  const load = useCallback(async () => {
    const db = supabase();
    const [r, p, c] = await Promise.all([
      db.from("orders").select(ORDER_COLS).eq("id", id).maybeSingle(),
      db.from("pods").select("*").eq("order_id", id).maybeSingle(),
      db.from("complaints").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    ]);
    const order = (r.data ?? null) as BizOrder | null;
    setO(order);
    setPod((p.data ?? null) as Pod | null);
    setCases((c.data ?? []) as Complaint[]);
    if (order?.property_id) {
      const { data } = await db.from("properties").select("label, address, area, lat, lng").eq("id", order.property_id).maybeSingle();
      setSite((data ?? null) as Site | null);
    }
    const path = (p.data as Pod | null)?.photo_path;
    // Short-lived signed URL: the evidence bucket is private (storage RLS: whoever can see the order).
    if (path) db.storage.from("evidence").createSignedUrl(path, 3600).then(({ data }) => setPhoto(data?.signedUrl ?? null));
  }, [id]);
  useLive(`biz-order-${id}`, ["orders", "complaints"], load, 30_000);

  useEffect(() => {
    if (o) document.title = t("docTitle", { order: ref.order(o.order_no) });
  }, [o, t]);

  if (o === undefined) return <div className="panel"><div className="empty">{t("loading")}</div></div>;
  if (!o)
    return (
      <div className="panel">
        <div className="empty">
          {t("orderNotFound")} <Link className="lk" href="/business/orders">{t("backToOrders")}</Link>
        </div>
      </div>
    );

  const ww = o.service_type === "WW";
  const own = o.customer_id === profile.id;
  // Same rule as org_cancel_order (0023): not finance; site managers only their own orders.
  const canCancel = CANCELLABLE.includes(o.status) && role !== "finance" && (isAdmin || own);
  const credit = Number(o.short_credit ?? 0);
  const steps: [string, string | null, boolean][] = [
    [t("stPlaced"), o.created_at, true],
    [t("stAssigned"), o.accepted_at, !!o.accepted_at],
    [t("stAtSite"), o.arrived_at, !!o.arrived_at],
    [ww ? t("stCollected") : t("stDelivered"), o.delivered_at, !!o.delivered_at],
  ];

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <Link className="lk" href="/business/orders">
          {t("backAll")}
        </Link>
      </div>
      <div className="half">
        <div className="panel">
          <h2>
            <span>
              <bdi dir="ltr">{ref.order(o.order_no)}</bdi> <StatusPill status={o.status} type={o.service_type} />
            </span>
            <small>{o.contract_id ? t("contractDelivery") : o.po_number ? <bdi dir="ltr">{ref.po(o.po_number)}</bdi> : t("bulkOrder")}</small>
          </h2>
          <dl className="kv" style={{ paddingTop: 8 }}>
            <dt>{t("hSite")}</dt>
            <dd>
              {site?.label ?? o.area}
              {site && <small className="stack mut">{[site.address, site.area].filter(Boolean).join(" · ")}</small>}
            </dd>
            <dt>{t("hService")}</dt>
            <dd>
              <TypeTag type={o.service_type} /> {f.gal(o.gallons)}
            </dd>
            <dt>{t("hWindow")}</dt>
            <dd>{f.ar && o.slot_start ? slotText(o.slot_start, o.slot_end, f.lang) : (o.slot_label ?? (o.slot_start ? f.dateTime(o.slot_start) : t("asap")))}</dd>
            <dt>{t("hTanker")}</dt>
            <dd>
              {o.tanker_plate ? (
                <>
                  <bdi dir="ltr">{o.tanker_plate}</bdi>
                  {o.driver_name ? ` · ${o.driver_name}` : ""}
                </>
              ) : (
                <span className="mut">{t("notAssigned")}</span>
              )}
            </dd>
            {o.driver_note && (
              <>
                <dt>{t("noteDriver")}</dt>
                <dd style={{ fontWeight: 400 }}>{o.driver_note}</dd>
              </>
            )}
            <dt>{t("hAmount")}</dt>
            <dd>
              {f.omr(o.total)} <small className="mut">{t("inclVatAmt", { amt: f.n3(o.vat) })}</small>
              {credit > 0 && <small className="stack" style={{ color: "var(--warn)" }}>{t("shortCredit", { amt: f.omr(credit) })}</small>}
            </dd>
            <dt>{t("billing")}</dt>
            <dd>{o.invoice_id ? <Link className="lk" href={`/business/invoice/${o.invoice_id}`} target="_blank">{t("onInvoice")}</Link> : o.status === "cancelled" ? t("notBilled") : t("onAccountNext")}</dd>
          </dl>
          {o.status === "cancelled" ? (
            <div className="banner badb" style={{ margin: "0 16px 16px" }}>
              {t("cancelledAt", { date: f.dateTime(o.cancelled_at) })}
              {o.cancel_reason ? ` — ${o.cancel_reason}` : ""}
            </div>
          ) : (
            <ul className="tl">
              {steps.map(([label, at, done]) => (
                <li key={label} className={done ? "done" : ""}>
                  {label}
                  {at && <small style={{ display: "block" }}>{f.dateTime(at)}</small>}
                </li>
              ))}
            </ul>
          )}
          <div className="pad btns">
            {CANCELLABLE.includes(o.status) && (
              <button className="btn bad" disabled={!canCancel} title={canCancel ? undefined : role === "finance" ? t("cantCancelFinance") : t("cantCancelOwner")} onClick={() => setDlg("cancel")}>
                {t("cancelOrder")}
              </button>
            )}
            <button className="btn" onClick={() => setDlg("report")}>
              {t("reportProblem")}
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>
            {ww ? t("proofCollection") : t("proofDelivery")} {pod && pod.status === "rejected" && <St tone="bad">{t("rejectedNws")}</St>}
          </h2>
          {!pod ? (
            <div className="empty">{o.status === "delivered" || o.status === "collected" ? t("noProof") : ww ? t("recordedCollection") : t("recordedDelivery")}</div>
          ) : (
            <>
              <dl className="kv" style={{ paddingTop: 8 }}>
                <dt>{t("flowMeter")}</dt>
                <dd>
                  {f.gal(pod.meter_gal)}
                  {!ww && pod.meter_gal < o.gallons * 0.95 && <small className="stack" style={{ color: "var(--warn)" }}>{t("shortOf", { gal: f.gal(o.gallons) })}</small>}
                </dd>
                <dt>{t("recorded")}</dt>
                <dd>{f.dateTime(pod.created_at)}</dd>
                <dt>{t("signature")}</dt>
                <dd>{pod.no_signature ? <St tone="warn">{t("noSigner")}{pod.left_at_tank ? (ww ? t("collectedFromTank") : t("leftAtTank")) : ""}</St> : t("signedOnSite")}</dd>
              </dl>
              <div className="pad">
                <PodLocation pod={pod} site={site} />
                {photo ? (
                  <a href={photo} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                    <img className="pod-img" src={photo} alt={t(ww ? "podAltCollection" : "podAltDelivery", { order: ref.order(o.order_no) })} style={{ marginTop: 10 }} />
                  </a>
                ) : (
                  pod.photo_path && <small className="mut">{t("loadingPhoto")}</small>
                )}
                {!pod.no_signature && pod.signature_svg?.trim() && <SignatureSvg value={pod.signature_svg} label={t("signature")} style={{ width: "100%", maxWidth: 320, color: "#0e2329", marginTop: 10 }} />}
              </div>
            </>
          )}
        </div>
      </div>

      {cases.length > 0 && (
        <div className="panel">
          <h2>{t("problems")}</h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td dir="ltr">C-{c.case_no}</td>
                    <td>{c.description}</td>
                    <td>
                      <St tone={c.state === "resolved" ? "ok" : c.state === "escalated" ? "bad" : "act"}>{c.state === "resolved" ? t("cResolved") : c.state === "new" ? t("cReceived") : t("cWithNws")}</St>
                      {c.resolution && <small className="stack">{c.resolution}</small>}
                    </td>
                    <td>{f.dateTime(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dlg === "cancel" && <CancelDialog order={o} onClose={() => setDlg(null)} onDone={load} />}
      {dlg === "report" && <ReportDialog order={o} onClose={() => setDlg(null)} onDone={load} />}
    </>
  );
}

function CancelDialog({ order, onClose, onDone }: { order: BizOrder; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [reason, setReason] = useState("");
  const t = useT(BIZ);
  return (
    <Dialog title={t("cancelQ", { order: ref.order(order.order_no) })} body={t("cancelBody")} onClose={onClose}>
      <div className="fld">
        <label htmlFor="cxr">{t("reasonOpt")}</label>
        <textarea id="cxr" className="in" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("phNotNeeded")} autoFocus />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          {t("keepOrder")}
        </button>
        <button
          className="btn bad"
          disabled={busy === "cx"}
          onClick={() =>
            run("cx", () => supabase().rpc("org_cancel_order", { p_order_id: order.id, p_reason: reason.trim() || null }), t("cancelledT", { order: ref.order(order.order_no) }), () => {
              onClose();
              onDone();
            })
          }
        >
          {busy === "cx" ? t("cancelling") : t("cancelOrder")}
        </button>
      </div>
    </Dialog>
  );
}

function ReportDialog({ order, onClose, onDone }: { order: BizOrder; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [slas, setSlas] = useState<Sla[]>([]);
  const [cat, setCat] = useState("");
  const [text, setText] = useState("");
  const t = useT(BIZ);
  const f = useFmt();
  useEffect(() => {
    supabase()
      .from("complaint_sla")
      .select("category, label, hours")
      .order("hours")
      .then(({ data }) => setSlas((data ?? []) as Sla[]));
  }, []);
  return (
    <Dialog title={t("reportTitle", { order: ref.order(order.order_no) })} body={t("reportBody")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("rp", () => supabase().rpc("file_complaint", { p_order_id: order.id, p_category: cat, p_description: text.trim(), p_photo_path: null }), t("reported"), () => {
            onClose();
            onDone();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="rpc">{t("whatWrong")}</label>
          <select id="rpc" className="in" required value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">{t("choose")}</option>
            {slas.map((s) => (
              <option key={s.category} value={s.category}>
                {t("answeredWithin", { label: BIZ[`cat_${s.category}`] ? t(`cat_${s.category}`) : s.label, h: f.n(s.hours) })}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="rpd">{t("details")}</label>
          <textarea id="rpd" className="in" rows={4} maxLength={1000} required minLength={3} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "rp" || !cat || text.trim().length < 3}>
            {busy === "rp" ? t("sending") : t("reportBtn")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
