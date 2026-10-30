"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder, type BizProperty } from "@/components/business/BizContext";
import { OPEN, TRACKABLE, WINDOWS, etaText, muscatToday, slotFor, slotText, type WindowKey } from "@/components/business/data";
import { BIZ } from "@/components/business/i18n";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, useAction, useLive } from "@/components/portal/kit";
import { useT } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import { type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { addDaysKey } from "@/lib/time";
import { ref } from "@/lib/types";

type Loc = { order_id: string; lat: number; lng: number };
type LiveTanker = { id: string; plate: string; last_lat: number | null; last_lng: number | null; last_seen_at: string | null };
type Filter = "all" | "approval" | "open" | "delivered" | "cancelled";
// [filter, dictionary key]
const FILTERS: [Filter, string][] = [
  ["all", "all"],
  ["approval", "fApproval"],
  ["open", "fOpen"],
  ["delivered", "fDelivered"],
  ["cancelled", "fCancelled"],
];
const WIN_KEY: Record<WindowKey, string> = { morning: "wMorning", afternoon: "wAfternoon", evening: "wEvening" };
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
  const t = useT(BIZ);
  const f = useFmt();

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
    run(`d${o.id}`, async () => supabase().rpc("org_decide_order", { p_order_id: o.id, p_approve: approve, p_reason: reason ?? null }), t(approve ? "approvedT" : "declinedT", { order: ref.order(o.order_no) }), load);

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          {t("errPage", { error: loadError })}
        </div>
      )}
      {role === "finance" ? (
        <div className="banner info">{t("financeNote")}</div>
      ) : canOrder ? (
        <BulkOrder sites={sites} onPlaced={load} />
      ) : null}

      {isAdmin && approvals.length > 0 && (
        <div className="panel">
          <h2>
            {t("waitApproval")} <small>{t("aboveLimit", { amt: f.omr(org.approval_limit) })}</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("hOrder")}</th>
                  <th>{t("hSite")}</th>
                  <th>{t("hService")}</th>
                  <th className="num">{t("hGallons")}</th>
                  <th>{t("hWindow")}</th>
                  <th className="num">{t("hAmount")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {approvals.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <bdi dir="ltr">{ref.order(o.order_no)}</bdi>
                      {o.po_number && (
                        <small className="stack" dir="ltr">
                          {o.po_number}
                        </small>
                      )}
                    </td>
                    <td>{siteName(o.property_id)}</td>
                    <td>
                      <TypeTag type={o.service_type} />
                    </td>
                    <td className="num">{f.n(o.gallons)}</td>
                    <td>{f.ar && o.slot_start ? slotText(o.slot_start, o.slot_end, f.lang) : (o.slot_label ?? (o.slot_start ? f.dateTime(o.slot_start) : t("asap")))}</td>
                    <td className="num">{f.n3(o.total)}</td>
                    <td>
                      <div className="btns">
                        <button className="btn sm pri" disabled={!!busy} onClick={() => decide(o, true)}>
                          {t("approve")}
                        </button>
                        <button className="btn sm" disabled={!!busy} onClick={() => setDecline(o)}>
                          {t("decline")}
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
            {t("tracking")} <small>{t("trackingSub")}</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("hOrder")}</th>
                  <th>{t("hSite")}</th>
                  <th>{t("hTanker")}</th>
                  <th>{t("hDriver")}</th>
                  <th>{t("hStatus")}</th>
                  <th>{t("hEta")}</th>
                </tr>
              </thead>
              <tbody>
                {tracking.map((o) => {
                  const tk = tankers.find((x) => x.id === o.tanker_id) ?? null;
                  const l = locs.find((x) => x.order_id === o.id) ?? null;
                  return (
                    <tr key={o.id}>
                      <td>
                        <Link className="lk" href={`/business/orders/${o.id}`} dir="ltr">
                          {ref.order(o.order_no)}
                        </Link>
                      </td>
                      <td>{siteName(o.property_id)}</td>
                      <td>
                        <b dir="ltr">{o.tanker_plate ?? tk?.plate ?? "—"}</b>
                      </td>
                      <td>{o.driver_name ?? "—"}</td>
                      <td>
                        <StatusPill status={o.status} type={o.service_type} />
                      </td>
                      <td>{etaText(tk ? { lat: tk.last_lat, lng: tk.last_lng } : null, l, o.status, f.lang)}</td>
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
                {t(label)}
                {k === "approval" && approvals.length > 0 && <span className="tc">{f.n(approvals.length)}</span>}
              </button>
            ))}
          </div>
          <span className="mut" style={{ fontSize: 13 }}>
            {t("billedNet", { n: f.n(org.terms_days) })}
          </span>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("hOrder")}</th>
                <th>{t("hSite")}</th>
                <th>{t("hService")}</th>
                <th className="num">{t("hGallons")}</th>
                <th>{t("hWindow")}</th>
                <th>{t("hTanker")}</th>
                <th>{t("hStatus")}</th>
                <th className="num">{t("hAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link className="lk" href={`/business/orders/${o.id}`} dir="ltr">
                      {ref.order(o.order_no)}
                    </Link>
                    <small className="stack">{o.po_number ? <bdi dir="ltr">{o.po_number}</bdi> : o.contract_id ? t("contractDelivery") : f.dateTime(o.created_at)}</small>
                  </td>
                  <td>{siteName(o.property_id)}</td>
                  <td>
                    <TypeTag type={o.service_type} />
                  </td>
                  <td className="num">{f.n(o.gallons)}</td>
                  <td>{f.ar && o.slot_start ? slotText(o.slot_start, o.slot_end, f.lang) : (o.slot_label ?? (o.slot_start ? f.dateTime(o.slot_start) : t("asap")))}</td>
                  <td>{o.tanker_plate ? <bdi dir="ltr">{o.tanker_plate}</bdi> : <span className="mut">—</span>}</td>
                  <td>
                    <StatusPill status={o.status} type={o.service_type} />
                    {o.status === "cancelled" && o.cancel_reason && <small className="stack">{o.cancel_reason}</small>}
                  </td>
                  <td className="num">{f.n3(o.total)}</td>
                </tr>
              ))}
              {loaded && !shown.length && (
                <tr>
                  <td className="empty" colSpan={8}>
                    {filter === "all" ? t("noOrders") : t("noOrdersView")}
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
  const t = useT(BIZ);
  return (
    <Dialog title={t("declineQ", { order: ref.order(order.order_no) })} body={t("declineBody")} onClose={onClose}>
      <div className="fld">
        <label htmlFor="dr">{t("reason")}</label>
        <textarea id="dr" className="in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("phNotApproved")} autoFocus />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          {t("cancel")}
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
          {t("declineOrder")}
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
  const [date, setDate] = useState(() => addDaysKey(muscatToday(), 1)); // tomorrow in Muscat
  const [win, setWin] = useState<WindowKey>("morning");
  const [po, setPo] = useState("");
  const [note, setNote] = useState("");
  const [unit, setUnit] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAction();
  const t = useT(BIZ);
  const f = useFmt();
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
    org.status !== "active" ? t("blockedInactive") : org.paused ? t("blockedPaused") : Number(org.credit_limit) <= 0 ? t("blockedNoLimit") : null;
  // The window as the viewer reads it (slot.label stays English: it is stored on the order).
  const slotShown = f.ar ? slotText(slot.start, slot.end, f.lang) : slot.label;
  const overLimit = !blocked && total != null && total > left;
  // A window that has already ended today can't be booked.
  const passed = (w: WindowKey) => Date.parse(slotFor(date, w).end) <= now;

  if (!sites.length) {
    return (
      <div className="panel">
        <h2>{t("placeBulk")}</h2>
        <p className="note">
          {t("addSiteFirst")} <Link className="lk" href="/business/sites">{t("addASite")}</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>
        {t("placeBulk")} <small>{t("placeBulkSub")}</small>
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
            needsApproval
              ? t(count > 1 ? "sentForApprovalN" : "sentForApproval1", { n: f.n(count) })
              : t(count > 1 ? "bookedN" : "booked1", { n: f.n(count), slot: slotShown }),
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
            <label htmlFor="bSite">{t("hSite")}</label>
            <select id="bSite" className="in" value={siteId} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bType">{t("hService")}</label>
            <select id="bType" className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
              {(["DW", "WW", "TE"] as ServiceType[]).map((s) => (
                <option key={s} value={s}>
                  {s === "WW" ? t("wwPickup") : serviceLabel(s, f.lang)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bGal">{t("lGalPer")}</label>
            <input id="bGal" className="in" type="number" min={100} max={20000} step={100} list="bGalList" required value={gallons} onChange={(e) => setGallons(Number(e.target.value))} />
            <datalist id="bGalList">
              {GALLONS[type].map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div className="fld">
            <label htmlFor="bQty">{t("lNum")}</label>
            <select id="bQty" className="in" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {f.n(n)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bDate">{t("lDate")}</label>
            <input id="bDate" className="in" type="date" min={muscatToday()} required value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="bWin">{t("hWindow")}</label>
            <select id="bWin" className="in" value={win} onChange={(e) => setWin(e.target.value as WindowKey)}>
              {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
                <option key={w} value={w} disabled={passed(w)}>
                  {t(WIN_KEY[w])}
                  {passed(w) ? t("passed") : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="bPO">{t("lPo")}</label>
            <input id="bPO" className="in" dir="ltr" maxLength={40} value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO-2231" />
          </div>
          <div className="fld">
            <label htmlFor="bNote">{t("lNote")}</label>
            <input id="bNote" className="in" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("phNote")} />
          </div>
        </div>
        <div className="orderfoot">
          <div className="mut">
            {slotShown} · {f.n(count)} × {f.gal(gallons)}
            {total != null && (
              <>
                {" "}
                · {t("estimated")} <b className="ink">{f.omr(total)}</b> {t("inclVat")}
              </>
            )}
            {needsApproval && <span className="st warn" style={{ marginInlineStart: 8 }}>{t("needsAdmin")}</span>}
            {!blocked && <small className="stack">{t("creditLeft", { amt: f.omr(Math.max(0, left)) })}</small>}
            {blocked && <small className="stack" style={{ color: "var(--bad)" }}>{blocked}</small>}
            {overLimit && <small className="stack" style={{ color: "var(--bad)" }}>{t("overLimit")}</small>}
          </div>
          <button className="btn pri" disabled={busy === "order" || !siteId || !!blocked || overLimit || passed(win)}>
            {busy === "order" ? t("placing") : t("placeOnAccount", { n: f.n(org.terms_days) })}
          </button>
        </div>
      </form>
    </div>
  );
}
