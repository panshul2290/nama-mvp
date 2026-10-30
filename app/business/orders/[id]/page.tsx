"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder } from "@/components/business/BizContext";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { PodLocation } from "@/components/PodLocation";
import { Dialog, St, fmtDateTime, gal, n3, useAction, useLive } from "@/components/portal/kit";
import { SignatureSvg } from "@/components/SignatureSvg";
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
    if (o) document.title = `${ref.order(o.order_no)} — Business portal`;
  }, [o]);

  if (o === undefined) return <div className="panel"><div className="empty">Loading…</div></div>;
  if (!o)
    return (
      <div className="panel">
        <div className="empty">
          Order not found. <Link className="lk" href="/business/orders">Back to orders</Link>
        </div>
      </div>
    );

  const ww = o.service_type === "WW";
  const own = o.customer_id === profile.id;
  // Same rule as org_cancel_order (0023): not finance; site managers only their own orders.
  const canCancel = CANCELLABLE.includes(o.status) && role !== "finance" && (isAdmin || own);
  const credit = Number(o.short_credit ?? 0);
  const steps: [string, string | null, boolean][] = [
    ["Order placed", o.created_at, true],
    ["Tanker assigned", o.accepted_at, !!o.accepted_at],
    ["Tanker at the site", o.arrived_at, !!o.arrived_at],
    [ww ? "Collected" : "Delivered", o.delivered_at, !!o.delivered_at],
  ];

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <Link className="lk" href="/business/orders">
          ← All orders
        </Link>
      </div>
      <div className="half">
        <div className="panel">
          <h2>
            <span>
              {ref.order(o.order_no)} <StatusPill status={o.status} type={o.service_type} />
            </span>
            <small>{o.contract_id ? "Contract delivery" : o.po_number ? `PO ${o.po_number}` : "Bulk order"}</small>
          </h2>
          <dl className="kv" style={{ paddingTop: 8 }}>
            <dt>Site</dt>
            <dd>
              {site?.label ?? o.area}
              {site && <small className="stack mut">{[site.address, site.area].filter(Boolean).join(" · ")}</small>}
            </dd>
            <dt>Service</dt>
            <dd>
              <TypeTag type={o.service_type} /> {gal(o.gallons)} gal
            </dd>
            <dt>Window</dt>
            <dd>{o.slot_label ?? (o.slot_start ? fmtDateTime(o.slot_start) : "As soon as possible")}</dd>
            <dt>Tanker</dt>
            <dd>{o.tanker_plate ? `${o.tanker_plate}${o.driver_name ? ` · ${o.driver_name}` : ""}` : <span className="mut">Not assigned yet</span>}</dd>
            {o.driver_note && (
              <>
                <dt>Note for the driver</dt>
                <dd style={{ fontWeight: 400 }}>{o.driver_note}</dd>
              </>
            )}
            <dt>Amount</dt>
            <dd>
              OMR {n3(o.total)} <small className="mut">incl. VAT {n3(o.vat)}</small>
              {credit > 0 && <small className="stack" style={{ color: "var(--warn)" }}>Short-delivery credit − OMR {n3(credit)} on the invoice</small>}
            </dd>
            <dt>Billing</dt>
            <dd>{o.invoice_id ? <Link className="lk" href={`/business/invoice/${o.invoice_id}`} target="_blank">On the invoice</Link> : o.status === "cancelled" ? "Not billed" : "On account — next invoice"}</dd>
          </dl>
          {o.status === "cancelled" ? (
            <div className="banner badb" style={{ margin: "0 16px 16px" }}>
              Cancelled {fmtDateTime(o.cancelled_at)}
              {o.cancel_reason ? ` — ${o.cancel_reason}` : ""}
            </div>
          ) : (
            <ul className="tl">
              {steps.map(([label, at, done]) => (
                <li key={label} className={done ? "done" : ""}>
                  {label}
                  {at && <small style={{ display: "block" }}>{fmtDateTime(at)}</small>}
                </li>
              ))}
            </ul>
          )}
          <div className="pad btns">
            {CANCELLABLE.includes(o.status) && (
              <button className="btn bad" disabled={!canCancel} title={canCancel ? undefined : role === "finance" ? "Finance users can’t cancel orders" : "Only the person who placed it or an account admin"} onClick={() => setDlg("cancel")}>
                Cancel order
              </button>
            )}
            <button className="btn" onClick={() => setDlg("report")}>
              Report a problem
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>
            Proof of {ww ? "collection" : "delivery"} {pod && pod.status === "rejected" && <St tone="bad">Rejected by NWS</St>}
          </h2>
          {!pod ? (
            <div className="empty">{o.status === "delivered" || o.status === "collected" ? "No proof recorded." : `Recorded by the driver at the ${ww ? "collection" : "delivery"}.`}</div>
          ) : (
            <>
              <dl className="kv" style={{ paddingTop: 8 }}>
                <dt>Flow meter</dt>
                <dd>
                  {gal(pod.meter_gal)} gal
                  {!ww && pod.meter_gal < o.gallons * 0.95 && <small className="stack" style={{ color: "var(--warn)" }}>Short of the {gal(o.gallons)} gal ordered</small>}
                </dd>
                <dt>Recorded</dt>
                <dd>{fmtDateTime(pod.created_at)}</dd>
                <dt>Signature</dt>
                <dd>{pod.no_signature ? <St tone="warn">Nobody available to sign{pod.left_at_tank ? (ww ? " — collected from the tank" : " — left at the tank") : ""}</St> : "Signed on site"}</dd>
              </dl>
              <div className="pad">
                <PodLocation pod={pod} site={site} />
                {photo ? (
                  <a href={photo} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                    <img className="pod-img" src={photo} alt={`Proof of ${ww ? "collection" : "delivery"} for ${ref.order(o.order_no)}`} style={{ marginTop: 10 }} />
                  </a>
                ) : (
                  pod.photo_path && <small className="mut">Loading photo…</small>
                )}
                {!pod.no_signature && pod.signature_svg?.trim() && <SignatureSvg value={pod.signature_svg} label="Signature" style={{ width: "100%", maxWidth: 320, color: "#0e2329", marginTop: 10 }} />}
              </div>
            </>
          )}
        </div>
      </div>

      {cases.length > 0 && (
        <div className="panel">
          <h2>Problems reported</h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>C-{c.case_no}</td>
                    <td>{c.description}</td>
                    <td>
                      <St tone={c.state === "resolved" ? "ok" : c.state === "escalated" ? "bad" : "act"}>{c.state === "resolved" ? "Resolved" : c.state === "new" ? "Received" : "With NWS"}</St>
                      {c.resolution && <small className="stack">{c.resolution}</small>}
                    </td>
                    <td>{fmtDateTime(c.created_at)}</td>
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
  return (
    <Dialog title={`Cancel ${ref.order(order.order_no)}?`} body="Orders on account aren’t charged until delivery, so there is nothing to refund. A tanker that is already on the way can’t be cancelled here — call NWS on 1442." onClose={onClose}>
      <div className="fld">
        <label htmlFor="cxr">Reason (optional)</label>
        <textarea id="cxr" className="in" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not needed any more" autoFocus />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          Keep the order
        </button>
        <button
          className="btn bad"
          disabled={busy === "cx"}
          onClick={() =>
            run("cx", () => supabase().rpc("org_cancel_order", { p_order_id: order.id, p_reason: reason.trim() || null }), `${ref.order(order.order_no)} cancelled`, () => {
              onClose();
              onDone();
            })
          }
        >
          {busy === "cx" ? "Cancelling…" : "Cancel order"}
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
  useEffect(() => {
    supabase()
      .from("complaint_sla")
      .select("category, label, hours")
      .order("hours")
      .then(({ data }) => setSlas((data ?? []) as Sla[]));
  }, []);
  return (
    <Dialog title={`Report a problem — ${ref.order(order.order_no)}`} body="The NWS complaints team opens a case and answers within the time shown for the category. You can follow it here." onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("rp", () => supabase().rpc("file_complaint", { p_order_id: order.id, p_category: cat, p_description: text.trim(), p_photo_path: null }), "Problem reported — NWS will get back to you", () => {
            onClose();
            onDone();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="rpc">What went wrong</label>
          <select id="rpc" className="in" required value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Choose…</option>
            {slas.map((s) => (
              <option key={s.category} value={s.category}>
                {s.label} · answered within {s.hours} h
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="rpd">Details</label>
          <textarea id="rpd" className="in" rows={4} maxLength={1000} required minLength={3} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "rp" || !cat || text.trim().length < 3}>
            {busy === "rp" ? "Sending…" : "Report problem"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
