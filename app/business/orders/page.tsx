"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder, type BizProperty } from "@/components/business/BizContext";
import { OPEN, TRACKABLE, WINDOWS, etaText, muscatToday, slotFor, type WindowKey } from "@/components/business/data";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { Dialog, fmtDateTime, gal, n3, omr, useAction, useLive } from "@/components/portal/kit";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ref } from "@/lib/types";

type Loc = { order_id: string; lat: number; lng: number };
type LiveTanker = { id: string; plate: string; last_lat: number | null; last_lng: number | null; last_seen_at: string | null };
type Filter = "all" | "approval" | "open" | "delivered" | "cancelled";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["approval", "Needs approval"],
  ["open", "Open"],
  ["delivered", "Delivered"],
  ["cancelled", "Cancelled"],
];
const GALLONS: Record<ServiceType, number[]> = { DW: [3000, 5000, 10000], WW: [3000, 5000, 10000], TE: [5000, 10000, 20000] };

export default function BusinessOrders() {
  const { org, isAdmin, canOrder, role } = useBiz();
  const [orders, setOrders] = useState<BizOrder[]>([]);
  const [sites, setSites] = useState<BizProperty[]>([]);
  const [locs, setLocs] = useState<Loc[]>([]);
  const [tankers, setTankers] = useState<LiveTanker[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loaded, setLoaded] = useState(false);
  const [decline, setDecline] = useState<BizOrder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const db = supabase();
    const [o, p] = await Promise.all([
      db.from("orders").select(ORDER_COLS).eq("org_id", org.id).order("created_at", { ascending: false }).limit(300),
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
    ]);
    setLoadError(o.error?.message ?? p.error?.message ?? null);
    if (o.error) return setLoaded(true); // keep what is on screen
    const list = (o.data ?? []) as BizOrder[];
    setOrders(list);
    setSites((p.data ?? []) as BizProperty[]);
    const live = list.filter((x) => TRACKABLE.includes(x.status));
    if (live.length) {
      const tids = [...new Set(live.map((x) => x.tanker_id).filter(Boolean))] as string[];
      const [l, t] = await Promise.all([
        db.from("order_locations").select("order_id, lat, lng").in("order_id", live.map((x) => x.id)),
        tids.length ? db.from("tankers").select("id, plate, last_lat, last_lng, last_seen_at").in("id", tids) : Promise.resolve({ data: [] }),
      ]);
      setLocs((l.data ?? []) as Loc[]);
      setTankers((t.data ?? []) as LiveTanker[]);
    } else {
      setLocs([]);
      setTankers([]);
    }
    setLoaded(true);
  }, [org.id]);

  useLive("biz-orders", ["orders", "tankers"], load, 30_000);

  const siteName = (id: string | null) => sites.find((s) => s.id === id)?.label ?? "—";
  const shown = orders.filter((o) =>
    filter === "all" ? true : filter === "approval" ? o.status === "pending_approval" : filter === "open" ? OPEN.includes(o.status) && o.status !== "pending_approval" : o.status === filter,
  );
  const tracking = orders.filter((o) => TRACKABLE.includes(o.status));
  const approvals = orders.filter((o) => o.status === "pending_approval");

  const decide = (o: BizOrder, approve: boolean, reason?: string) =>
    run(`d${o.id}`, async () => supabase().rpc("org_decide_order", { p_order_id: o.id, p_approve: approve, p_reason: reason ?? null }), approve ? `${ref.order(o.order_no)} approved` : `${ref.order(o.order_no)} declined`, load);

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          Couldn’t load this page: {loadError}. It retries automatically.
        </div>
      )}
      {role === "finance" ? (
        <div className="banner info">Finance users see orders (with proof of delivery) and invoices. Ask an account admin or site manager to place orders.</div>
      ) : canOrder ? (
        <BulkOrder sites={sites} onPlaced={load} />
      ) : null}

      {isAdmin && approvals.length > 0 && (
        <div className="panel">
          <h2>
            Waiting for your approval <small>above the approval limit of {omr(org.approval_limit)}</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Site</th>
                  <th>Service</th>
                  <th className="num">Gallons</th>
                  <th>Window</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {approvals.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {ref.order(o.order_no)}
                      {o.po_number && <small className="stack">{o.po_number}</small>}
                    </td>
                    <td>{siteName(o.property_id)}</td>
                    <td>
                      <TypeTag type={o.service_type} />
                    </td>
                    <td className="num">{gal(o.gallons)}</td>
                    <td>{o.slot_label ?? "As soon as possible"}</td>
                    <td className="num">{n3(o.total)}</td>
                    <td>
                      <div className="btns">
                        <button className="btn sm pri" disabled={!!busy} onClick={() => decide(o, true)}>
                          Approve
                        </button>
                        <button className="btn sm" disabled={!!busy} onClick={() => setDecline(o)}>
                          Decline
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tracking.length > 0 && (
        <div className="panel">
          <h2>
            Tracking <small>live — tankers on the way to your sites</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Site</th>
                  <th>Tanker</th>
                  <th>Driver</th>
                  <th>Status</th>
                  <th>ETA</th>
                </tr>
              </thead>
              <tbody>
                {tracking.map((o) => {
                  const t = tankers.find((x) => x.id === o.tanker_id) ?? null;
                  const l = locs.find((x) => x.order_id === o.id) ?? null;
                  return (
                    <tr key={o.id}>
                      <td>
                        <Link className="lk" href={`/business/orders/${o.id}`}>
                          {ref.order(o.order_no)}
                        </Link>
                      </td>
                      <td>{siteName(o.property_id)}</td>
                      <td>
                        <b>{o.tanker_plate ?? t?.plate ?? "—"}</b>
                      </td>
                      <td>{o.driver_name ?? "—"}</td>
                      <td>
                        <StatusPill status={o.status} type={o.service_type} />
                      </td>
                      <td>{etaText(t ? { lat: t.last_lat, lng: t.last_lng } : null, l, o.status)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="toolbar">
          <div className="chips">
            {FILTERS.map(([k, label]) => (
              <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {label}
                {k === "approval" && approvals.length > 0 && <span className="tc">{approvals.length}</span>}
              </button>
            ))}
          </div>
          <span className="mut" style={{ fontSize: 13 }}>
            Billed to your account · Net {org.terms_days}
          </span>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Site</th>
                <th>Service</th>
                <th className="num">Gallons</th>
                <th>Window</th>
                <th>Tanker</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link className="lk" href={`/business/orders/${o.id}`}>
                      {ref.order(o.order_no)}
                    </Link>
                    <small className="stack">{o.po_number ?? (o.contract_id ? "Contract delivery" : fmtDateTime(o.created_at))}</small>
                  </td>
                  <td>{siteName(o.property_id)}</td>
                  <td>
                    <TypeTag type={o.service_type} />
                  </td>
                  <td className="num">{gal(o.gallons)}</td>
                  <td>{o.slot_label ?? (o.slot_start ? fmtDateTime(o.slot_start) : "As soon as possible")}</td>
                  <td>{o.tanker_plate ?? <span className="mut">—</span>}</td>
                  <td>
                    <StatusPill status={o.status} type={o.service_type} />
                    {o.status === "cancelled" && o.cancel_reason && <small className="stack">{o.cancel_reason}</small>}
                  </td>
                  <td className="num">{n3(o.total)}</td>
                </tr>
              ))}
              {loaded && !shown.length && (
                <tr>
                  <td className="empty" colSpan={8}>
                    {filter === "all" ? "No orders yet — deliveries on contract appear here too." : "No orders in this view."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {decline && <DeclineDialog order={decline} onClose={() => setDecline(null)} onConfirm={(r) => decide(decline, false, r).then((ok) => ok && setDecline(null))} />}
    </>
  );
}

function DeclineDialog({ order, onClose, onConfirm }: { order: BizOrder; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Decline ${ref.order(order.order_no)}?`} body="The order is cancelled and the person who placed it is told why." onClose={onClose}>
      <div className="fld">
        <label htmlFor="dr">Reason</label>
        <textarea id="dr" className="in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not approved" autoFocus />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn bad"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm(reason.trim());
            setBusy(false);
          }}
        >
          Decline order
        </button>
      </div>
    </Dialog>
  );
}

function BulkOrder({ sites, onPlaced }: { sites: BizProperty[]; onPlaced: () => void }) {
  const { org, isAdmin } = useBiz();
  const [site, setSite] = useState("");
  const [type, setType] = useState<ServiceType>("DW");
  const [gallons, setGallons] = useState(5000);
  const [count, setCount] = useState(2);
  const [date, setDate] = useState(() => {
    const t = new Date(`${muscatToday()}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  });
  const [win, setWin] = useState<WindowKey>("morning");
  const [po, setPo] = useState("");
  const [note, setNote] = useState("");
  const [unit, setUnit] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAction();
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const siteId = site || sites[0]?.id || "";
  const slot = useMemo(() => slotFor(date, win), [date, win]);

  useEffect(() => {
    let cancelled = false;
    supabase()
      .rpc("quote_order", { p_service_type: type, p_gallons: gallons, p_slot_start: slot.start })
      .then(({ data }) => {
        if (!cancelled) setUnit(data ? Number((data as { total: number }).total) : null);
      });
    return () => {
      cancelled = true;
    };
  }, [type, gallons, slot.start]);

  const total = unit != null ? unit * count : null;
  const needsApproval = !isAdmin && total != null && total > Number(org.approval_limit);
  // The database refuses orders on an inactive account or past the credit limit; say so before submitting.
  const left = Number(org.credit_limit) - Number(org.credit_used);
  const blocked =
    org.status !== "active" ? "The account isn’t active yet — NWS sets the credit limit when it approves it." : org.paused ? "Ordering is paused on this account." : Number(org.credit_limit) <= 0 ? "No credit limit is set yet — contact NWS finance." : null;
  const overLimit = !blocked && total != null && total > left;
  // A window that has already ended today can't be booked.
  const passed = (w: WindowKey) => Date.parse(slotFor(date, w).end) <= now;

  if (!sites.length) {
    return (
      <div className="panel">
        <h2>Place a bulk order</h2>
        <p className="note">
          Add a site first — orders are delivered to your registered sites. <Link className="lk" href="/business/sites">Add a site</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>
        Place a bulk order <small>one tanker per load · billed on account</small>
      </h2>
      <form
        className="pad"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            "order",
            async () =>
              supabase().rpc("org_create_orders", {
                p_property_id: siteId,
                p_service_type: type,
                p_gallons: gallons,
                p_count: count,
                p_slot_start: slot.start,
                p_slot_end: slot.end,
                p_slot_label: slot.label,
                p_po_number: po.trim() || null,
                p_note: note.trim() || null,
              }),
            needsApproval ? `${count} order${count > 1 ? "s" : ""} sent to your account admin for approval` : `${count} tanker${count > 1 ? "s" : ""} booked for ${slot.label}`,
            () => {
              setPo("");
              setNote("");
              onPlaced();
            },
          );
        }}
      >
        <div className="form">
          <div className="fld">
            <label htmlFor="bSite">Site</label>
            <select id="bSite" className="in" value={siteId} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bType">Service</label>
            <select id="bType" className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
              {(["DW", "WW", "TE"] as ServiceType[]).map((t) => (
                <option key={t} value={t}>
                  {t === "WW" ? "Wastewater pickup" : SERVICE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bGal">Gallons per tanker</label>
            <input id="bGal" className="in" type="number" min={100} max={20000} step={100} list="bGalList" required value={gallons} onChange={(e) => setGallons(Number(e.target.value))} />
            <datalist id="bGalList">
              {GALLONS[type].map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div className="fld">
            <label htmlFor="bQty">Number of tankers</label>
            <select id="bQty" className="in" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bDate">Delivery date</label>
            <input id="bDate" className="in" type="date" min={muscatToday()} required value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="bWin">Window</label>
            <select id="bWin" className="in" value={win} onChange={(e) => setWin(e.target.value as WindowKey)}>
              {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
                <option key={w} value={w} disabled={passed(w)}>
                  {WINDOWS[w].label}
                  {passed(w) ? " (passed)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bPO">Purchase order (optional)</label>
            <input id="bPO" className="in" maxLength={40} value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO-2231" />
          </div>
          <div className="fld">
            <label htmlFor="bNote">Note for the driver (optional)</label>
            <input id="bNote" className="in" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Gate 3, ask for maintenance" />
          </div>
        </div>
        <div className="orderfoot">
          <div className="mut">
            {slot.label} · {count} × {gal(gallons)} gal
            {total != null && (
              <>
                {" "}
                · estimated <b className="ink">{omr(total)}</b> incl. VAT
              </>
            )}
            {needsApproval && <span className="st warn" style={{ marginLeft: 8 }}>Needs admin approval</span>}
            {!blocked && <small className="stack">Credit left on the account: {omr(Math.max(0, left))}</small>}
            {blocked && <small className="stack" style={{ color: "var(--bad)" }}>{blocked}</small>}
            {overLimit && <small className="stack" style={{ color: "var(--bad)" }}>This is more than the credit left. Pay an invoice or ask NWS to raise the limit.</small>}
          </div>
          <button className="btn pri" disabled={busy === "order" || !siteId || !!blocked || overLimit || passed(win)}>
            {busy === "order" ? "Placing…" : `Place order on account (Net ${org.terms_days})`}
          </button>
        </div>
      </form>
    </div>
  );
}
