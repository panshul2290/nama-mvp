"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { gal, omr3, tshort, windowText } from "@/components/customer/fmt";
import { useNow } from "@/components/customer/hooks";
import { ChatButton, ChatSheet, useChatHub, useOrderChat, type ChatLabels } from "@/components/chat/OrderChat";
import { CancelSheet, DriverCard, PodCard, RateCard, ReschedSheet, useVerification } from "@/components/customer/OrderParts";
import { Bill, fillPending, orderToBill, StatusTag, TimelineH, useUnread } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { Map } from "@/components/Map";
import { BackButton, Loading } from "@/components/Shell";
import { useRoadEta } from "@/components/useRoadEta";
import { usePricingRules } from "@/components/usePricingRules";
import { useToast } from "@/components/useToast";
import { announceGone } from "@/lib/feed";
import { initials, kmText } from "@/lib/format";
import { DEFAULT_CENTER } from "@/lib/geo";
import { STALE_AFTER_S } from "@/lib/gps";
import { localDigits } from "@/lib/i18n";
import { ruleNumber } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";
import { ON_JOB_STATUSES, ref, type LngLat, type Order, type OrderLocation, type Tanker } from "@/lib/types";

// The customer may see the tanker's position while it is on its way (RLS: tankers_customer_active_order).
const TRACKED = ["accepted", "arriving", "arrived"];
const WAITING = ["requested", "scheduled", "pending_approval"];
const NO_TANKER_AFTER_MS = 10 * 60_000;
const isolate = (s: string) => `${String.fromCharCode(0x2068)}${s}${String.fromCharCode(0x2069)}`; // first-strong isolate

export default function OrderPage() {
  return (
    <Suspense fallback={<Loading />}>
      <OrderDetail />
    </Suspense>
  );
}

function OrderDetail() {
  const id = useSearchParams().get("id") ?? "";
  const profile = useCustomer();
  const { t, lang, dir } = useCx();
  const toast = useToast();
  const chat = useOrderChat(id, "customer");
  const hub = useChatHub();
  const { refresh: refreshUnread } = useUnread();
  const [chatTapped, setChatTapped] = useState(false);
  // Open from the button here, or from a message banner / inbox tap elsewhere in the app.
  const chatOpen = chatTapped || (Boolean(id) && hub.pending === id);
  const { setActive } = hub;
  useEffect(() => {
    if (!chatOpen) return;
    setActive(id);
    return () => setActive(null);
  }, [chatOpen, id, setActive]);
  // Marking messages read also clears their inbox notifications: refresh the badge.
  const { markRead } = chat;
  const markReadAndRefresh = useCallback(() => markRead().then(refreshUnread), [markRead, refreshUnread]);
  const now = useNow(5_000);
  const { rules } = usePricingRules();
  const [order, setOrder] = useState<Order | null>(null);
  const [loc, setLoc] = useState<OrderLocation | null>(null);
  const [propLabel, setPropLabel] = useState<string | null>(null);
  // fixAt: when the fix reached the server, on this device's clock.
  const [tankerFix, setTankerFix] = useState<{ tankerId: string; pos: LngLat; fixAt: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const [sheet, setSheet] = useState<"cancel" | "resched" | null>(null);

  const load = useCallback(() => {
    if (!id) return Promise.resolve();
    const db = supabase();
    return Promise.all([db.from("orders").select("*").eq("id", id).maybeSingle(), db.from("order_locations").select("*").eq("order_id", id).maybeSingle()]).then(
      ([{ data: o }, { data: l }]) => {
        if (!o) return setMissing(true);
        setOrder(o as Order);
        setLoc(l as OrderLocation | null);
      },
    );
  }, [id]);

  // Order row: initial load, live updates, and a catch-up on tab focus.
  useEffect(() => {
    load();
    if (!id) return;
    const db = supabase();
    const ch = db
      .channel(`order-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${id}` }, (payload) =>
        setOrder((prev) => ({ ...prev, ...(payload.new as Order) })),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") load(); // close the gap between first fetch and subscribe
      });
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      db.removeChannel(ch);
    };
  }, [profile.id, id, load]);

  const propertyId = order?.property_id ?? null;
  useEffect(() => {
    if (!propertyId) return;
    supabase()
      .from("properties")
      .select("label")
      .eq("id", propertyId)
      .maybeSingle<{ label: string }>()
      .then(({ data }) => setPropLabel(data?.label ?? null));
  }, [propertyId]);

  // Tanker position, only while a driver is on the way (RLS allows nothing else).
  const tankerId = order && TRACKED.includes(order.status) ? order.tanker_id : null;
  useEffect(() => {
    if (!tankerId) return;
    const db = supabase();
    let seen: string | null | undefined; // last_seen_at of the fix we're showing
    const apply = (tk: Partial<Tanker>, ageS: number) => {
      if (tk.last_lat == null || tk.last_lng == null || tk.last_seen_at === seen) return; // not a new fix (e.g. online toggle)
      seen = tk.last_seen_at;
      setTankerFix({ tankerId, pos: { lat: tk.last_lat, lng: tk.last_lng }, fixAt: Date.now() - ageS * 1000 });
    };
    db.from("tankers")
      .select("last_lat, last_lng, last_seen_at, location_age_s")
      .eq("id", tankerId)
      .maybeSingle<Partial<Tanker> & { location_age_s: number | null }>()
      .then(({ data }) => data && apply(data, data.location_age_s ?? 0));
    const ch = db
      .channel(`tanker-${tankerId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tankers", filter: `id=eq.${tankerId}` }, (payload) => apply(payload.new as Tanker, 0))
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [tankerId]);

  // Road ETA from the tanker to the delivery point (computed before any early return: hooks rule).
  const etaFrom = order && TRACKED.includes(order.status) && tankerFix?.tankerId === order.tanker_id ? tankerFix.pos : null;
  const etaTo = loc ? { lat: loc.lat, lng: loc.lng } : null;
  const eta = useRoadEta(order?.status === "arrived" ? null : etaFrom, etaTo, { withPath: true });
  const verification = useVerification(id, order?.tanker_id ?? null);

  function changed(o: Order) {
    setOrder(o);
    setSheet(null);
  }
  function cancelled(o: Order) {
    const wasOpen = order?.status === "requested";
    changed(o);
    if (wasOpen) announceGone(o.id);
    toast.show(t("cancelled"));
  }

  const back = (
    <div className="rq-h">
      <BackButton href="/customer/orders" label={t("back")} />
      <div>
        <h3>{order ? ref.order(order.order_no) : t("notFound")}</h3>
        {order && (
          <small>
            {t(`${order.service_type}q`)} · {gal(order.gallons, lang)} · {propLabel || order.area}
          </small>
        )}
      </div>
    </div>
  );

  if (missing || !id) return <main className="screen">{back}</main>;
  if (!order) return <Loading />;

  const today = omanToday(now);
  const bill = { ...orderToBill(order), vatPct: rules ? Math.round(ruleNumber(rules, "vat_rate") * 1000) / 10 : null };
  const feeOmr = rules ? ruleNumber(rules, "cancel_fee_omr") : 1;
  const place = [propLabel, order.area, loc?.address].filter(Boolean).join(" · ");
  const canCancel = WAITING.includes(order.status) || order.status === "accepted" || order.status === "arriving";
  const live = ON_JOB_STATUSES.includes(order.status);
  const plate = order.tanker_plate ?? verification?.plate ?? null;
  const chatLabels: ChatLabels = {
    title: order.driver_id ? (order.driver_name ?? t("driver")) : t("nwsSupport"),
    // Plate and order number isolated so they read correctly inside Arabic text.
    subtitle: [order.driver_id ? t("chatDrvSub") : null, plate && isolate(plate), isolate(ref.order(order.order_no))].filter(Boolean).join(" · "),
    initials: order.driver_id ? initials(order.driver_name) : undefined,
    placeholder: t("typeMsg"),
    send: t("send"),
    close: t("close"),
    call: t("call"),
    masked: t("masked"),
    empty: t("chatEmpty"),
    closedNote: order.status === "delivered" || order.status === "cancelled" ? t("chatClosedAfter") : t("chatClosedBefore"),
    sent: t("chatSent"),
    read: t("chatRead"),
    nws: t("chatNws"),
    quickTitle: t("chatQuick"),
  };
  const closeChat = () => {
    setChatTapped(false);
    hub.clearPending();
  };
  const callDriver = () => toast.show(t("calling"));
  const sheets = (
    <>
      {chatOpen && (
        <ChatSheet
          chat={{ ...chat, markRead: markReadAndRefresh }}
          me="customer"
          lang={lang}
          dir={dir}
          labels={chatLabels}
          quick={["qm1", "qm2", "qm3", "qm4"].map((k) => ({ text: t(k), prefill: k === "qm2" }))}
          canSend={live}
          onClose={closeChat}
          onCall={live && order.driver_id ? callDriver : undefined}
          onError={toast.show}
        />
      )}
      {sheet === "cancel" && <CancelSheet order={order} feeOmr={feeOmr} feeStatus={rules?.cancel_fee_omr?.status} onClose={() => setSheet(null)} onDone={cancelled} />}
      {sheet === "resched" && <ReschedSheet order={order} now={now} onClose={() => setSheet(null)} onDone={changed} />}
      {toast.node}
    </>
  );

  // ---------------------------------------------------------------- cancelled
  if (order.status === "cancelled") {
    const payFail = order.payment_status === "failed";
    return (
      <>
        <main className="screen">
          {back}
          <div className={`banner ${payFail ? "badb" : ""}`}>
            {payFail
              ? t("payFailOrder")
              : Number(order.cancel_fee) > 0
                ? t("cancelledFee", { fee: omr3(order.cancel_fee ?? 0, lang) })
                : order.cancelled_by === "customer"
                  ? t("cancelled")
                  : t("cancelledBy", { r: order.cancel_reason ?? "" })}
          </div>
          {chat.msgs.length > 0 && (
            <div className="oc-actions" style={{ marginBottom: 12 }}>
              <ChatButton label={`${t("chatHistory")} (${localDigits(chat.msgs.length, lang)})`} unread={chat.unread} lang={lang} onClick={() => setChatTapped(true)} className="sec" />
            </div>
          )}
          <div className="rq-card pad">
            <Bill bill={bill} gallons={order.gallons} />
          </div>
          <Link href={`/customer/request?type=${order.service_type}&gallons=${order.gallons}${order.property_id ? `&property=${order.property_id}` : ""}`} className="cta">
            {t("again")}
          </Link>
        </main>
        {sheets}
      </>
    );
  }

  // ---------------------------------------------------------------- delivered / completed
  if (order.status === "delivered") {
    return (
      <>
        <main className="screen">
          {back}
          <div className="done-hero">
            <Icon name="check" />
            <div>
              <b>{t(order.service_type === "WW" ? "st_completed" : "st_delivered")}</b>
              <small>
                {tshort(order.delivered_at, lang)}
                {order.driver_name ? ` · ${order.driver_name}` : ""}
                {order.tanker_plate ? ` · ${order.tanker_plate}` : ""}
              </small>
            </div>
          </div>
          <TimelineH order={order} />
          <PodCard order={order} />
          <RateCard order={order} onRated={setOrder} />
          {order.tanker_id && (
            <DriverCard order={order} v={verification} today={today}>
              {chat.msgs.length > 0 && (
                <div className="oc-actions">
                  <ChatButton label={`${t("chatHistory")} (${localDigits(chat.msgs.length, lang)})`} unread={chat.unread} lang={lang} onClick={() => setChatTapped(true)} className="sec" />
                </div>
              )}
            </DriverCard>
          )}
          <div className="rq-card pad">
            <Bill bill={bill} gallons={order.gallons} />
          </div>
          <Link href={`/customer/complaint?order=${order.id}`} className="cta sec">
            {t("report")}
          </Link>
          <Link href={`/customer/request?type=${order.service_type}&gallons=${order.gallons}${order.property_id ? `&property=${order.property_id}` : ""}`} className="cta">
            {t("again")}
          </Link>
        </main>
        {sheets}
      </>
    );
  }

  // ---------------------------------------------------------------- live: waiting, on the way, at the door
  const dest = loc ? { lat: loc.lat, lng: loc.lng } : null;
  const fix = tankerId && tankerFix?.tankerId === tankerId ? tankerFix : null;
  const ageS = fix ? Math.max(0, (now - fix.fixAt) / 1000) : null;
  const delayed = ageS != null && ageS > STALE_AFTER_S;
  const waitingSince = new Date(order.released_at ?? order.created_at).getTime();
  const slow = order.status === "requested" && now - waitingSince > NO_TANKER_AFTER_MS;
  const onJob = ON_JOB_STATUSES.includes(order.status);
  const toFill = fillPending(order);
  const ago = (s: number) => (s < 60 ? t("agoS", { n: localDigits(Math.floor(s), lang) }) : t("agoM", { n: localDigits(Math.floor(s / 60), lang) }));

  return (
    <>
      <main className="screen flush">
        <div className="tr-map">
          <Map
            center={dest ?? DEFAULT_CENTER}
            destination={dest}
            tanker={fix?.pos ?? null}
            service={order.service_type}
            route={eta?.path ?? null}
            tankerNote={ageS != null ? `${t("lastUpd")} ${ago(ageS)}` : undefined}
            tankerStale={delayed}
            follow
            padBottom={30}
          />
          {order.status === "requested" && <span className="radar" aria-hidden="true" />}
          <Link href="/customer" className="tr-chip">
            <Icon name="back" />
            <b>{ref.order(order.order_no)}</b>
          </Link>
        </div>

        <div className="sheet2">
          <i className="grab" aria-hidden="true" />
          {order.status === "scheduled" || order.status === "pending_approval" ? (
            <>
              <div className="row">
                <h3 className="tj-t">{t(order.status === "scheduled" ? "schedT" : "st_pending_approval")}</h3>
                <StatusTag order={order} />
              </div>
              <p className="mut" style={{ margin: "0 0 4px" }}>
                {windowText(order.slot_start, order.slot_end, lang)}
              </p>
              <p className="mut small" style={{ margin: 0 }}>
                {t("schedS")}
              </p>
            </>
          ) : order.status === "requested" ? (
            <div className="srch-row">
              <span className="spin sm" role="img" aria-label={t("searching")} />
              <div>
                <h3 className="tj-t">{slow ? t("slowT") : t("searching")}</h3>
                <p className="mut" style={{ margin: 0 }}>
                  {slow ? t("slowS") : t("searchingS")}
                </p>
              </div>
            </div>
          ) : (
            <div className="tr-eta">
              {toFill ? (
                // Driving to (or at) the filling station: the distance to the customer isn't the trip yet.
                <div>
                  <small>{t("st_accepted")}</small>
                  <strong>{t("fillingT")}</strong>
                  <small>{t("fillingS")}</small>
                </div>
              ) : (
                <div>
                  <small>{order.status === "arrived" ? t("yourTanker") : order.status === "collected" ? t("tl_disNow") : t("tankerIs")}</small>
                  <strong>
                    {order.status === "arrived"
                      ? t("atDoor")
                      : order.status === "collected"
                        ? t("toPlant")
                        : eta
                          ? localDigits(kmText(eta.km), lang)
                          : order.status === "accepted"
                            ? t("starting")
                            : t("st_arriving")}
                  </strong>
                  {eta && TRACKED.includes(order.status) && order.status !== "arrived" && (
                    <small>{t(eta.source === "osrm" ? "etaRoad" : "etaLine", { m: localDigits(eta.minutes, lang) })}</small>
                  )}
                </div>
              )}
              <StatusTag order={order} />
            </div>
          )}

          {delayed && (
            <div className="banner" role="status">
              <b>{t("delayedT")}</b> — {t("delayedS", { a: ago(ageS ?? 0) })}
            </div>
          )}
          {order.is_emergency && <div className="banner info">{t("emergOn")}</div>}

          <TimelineH order={order} />

          {slow && (
            <button className="cta sec" onClick={() => setSheet("resched")}>
              {t("schedInstead")}
            </button>
          )}

          {onJob && order.tanker_id ? (
            <DriverCard order={order} v={verification} today={today}>
              <div className="oc-actions">
                <ChatButton label={t("msgDriver")} unread={chat.unread} lang={lang} onClick={() => setChatTapped(true)} />
                <button type="button" className="oc-btn sec" onClick={callDriver}>
                  <Icon name="phone" />
                  {t("call")}
                </button>
              </div>
              <p className="tr-note" style={{ margin: "8px 0 0" }}>
                {t("masked")}
              </p>
            </DriverCard>
          ) : (
            // No driver yet, so nobody to message: only NWS messages, if any, can be opened.
            chat.msgs.length > 0 && (
              <div className="oc-actions" style={{ marginBottom: 12 }}>
                <ChatButton label={t("nwsMsgs")} unread={chat.unread} lang={lang} onClick={() => setChatTapped(true)} className="sec" />
              </div>
            )
          )}

          {order.driver_note && (
            <p className="mut small">
              {t("noteDrv")}: {order.driver_note}
            </p>
          )}

          <div className="rq-card pad">
            <Bill bill={bill} gallons={order.gallons} />
          </div>

          {(order.status === "scheduled" || order.status === "requested") && (
            <div className="tr-act">
              <button className="cta sec" onClick={() => setSheet("resched")}>
                {t("resched")}
              </button>
              <button className="cta danger" onClick={() => setSheet("cancel")}>
                {t("cancel")}
              </button>
            </div>
          )}
          {canCancel && order.status !== "scheduled" && order.status !== "requested" && (
            <button className="cta danger" onClick={() => setSheet("cancel")}>
              {t("cancel")}
            </button>
          )}
          {onJob && (
            <Link href={`/customer/complaint?order=${order.id}`} className="cta sec" style={{ marginTop: 10 }}>
              {t("report")}
            </Link>
          )}
          <p className="tr-note">{place}</p>
        </div>
      </main>
      {sheets}
    </>
  );
}
