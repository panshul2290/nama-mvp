"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { Icon } from "@/components/icons";
import { Map } from "@/components/Map";
import { OrderBill, SERVICE_SHORT, StatusPill, Stepper } from "@/components/OrderBits";
import { BackButton, Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { errorCode, friendlyError } from "@/lib/errors";
import { announceGone } from "@/lib/feed";
import { DEFAULT_CENTER, distanceKm } from "@/lib/geo";
import { etaMinutes, hhmm, initials, kmText, orderCode } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";
import type { LngLat, Order, OrderLocation, Tanker } from "@/lib/types";

const ON_JOB = ["accepted", "arriving", "arrived"];

export default function OrderTracking() {
  const { id } = useParams<{ id: string }>();
  const profile = useCustomer();
  const toast = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [loc, setLoc] = useState<OrderLocation | null>(null);
  const [tankerFix, setTankerFix] = useState<{ driverId: string; pos: LngLat } | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const db = supabase();
    return Promise.all([
      db.from("orders").select("*").eq("id", id).maybeSingle(),
      db.from("order_locations").select("*").eq("order_id", id).maybeSingle(),
    ]).then(([{ data: o }, { data: l }]) => {
      if (!o) return setMissing(true);
      setOrder(o as Order);
      setLoc(l as OrderLocation | null);
    });
  }, [id]);

  // Order row: initial load, live updates, and a catch-up on tab focus.
  useEffect(() => {
    load();
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

  // Tanker position, only while a driver is on the job (RLS allows nothing else).
  const driverId = order && ON_JOB.includes(order.status) ? order.driver_id : null;
  useEffect(() => {
    if (!driverId) return;
    const db = supabase();
    const apply = (t: Partial<Tanker>) => {
      if (t.last_lat != null && t.last_lng != null) setTankerFix({ driverId, pos: { lat: t.last_lat, lng: t.last_lng } });
    };
    db.from("tankers").select("last_lat, last_lng").eq("driver_id", driverId).maybeSingle().then(({ data }) => data && apply(data));
    const ch = db
      .channel(`tanker-${driverId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tankers", filter: `driver_id=eq.${driverId}` }, (payload) =>
        apply(payload.new as Tanker),
      )
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [driverId]);

  async function cancel() {
    setBusy(true);
    const { data, error } = await supabase().rpc("cancel_order", { p_order_id: id }).single<Order>();
    setBusy(false);
    if (error) {
      toast.show(friendlyError(error));
      if (errorCode(error) === "cannot_cancel") load();
      return;
    }
    setOrder(data);
    announceGone(id);
  }

  if (missing) {
    return (
      <main className="screen">
        <div className="rq-h">
          <BackButton href="/customer/orders" />
          <div>
            <h3>Order not found</h3>
          </div>
        </div>
      </main>
    );
  }
  if (!order) return <Loading />;

  const code = orderCode(order.id);
  const dest = loc ? { lat: loc.lat, lng: loc.lng } : null;
  const tanker = driverId && tankerFix?.driverId === driverId ? tankerFix.pos : null;
  const away = tanker && dest ? distanceKm(tanker, dest) : null;
  const place = [order.area, loc?.address].filter(Boolean).join(" · ");
  const subtitle = `${SERVICE_SHORT[order.service_type]} · ${order.gallons.toLocaleString()} gal · ${place}`;

  // Finished orders: no map, just the outcome and the bill.
  if (order.status === "delivered" || order.status === "cancelled") {
    return (
      <main className="screen">
        <div className="rq-h">
          <BackButton href="/customer/orders" />
          <div>
            <h3>{code}</h3>
            <small>{subtitle}</small>
          </div>
        </div>
        {order.status === "delivered" ? (
          <div className="done-hero">
            <Icon name="check" />
            <div>
              <b>Delivered</b>
              <small>
                {hhmm(order.delivered_at)}
                {order.driver_name ? ` · ${order.driver_name}` : ""}
                {order.tanker_plate ? ` · ${order.tanker_plate}` : ""}
              </small>
            </div>
          </div>
        ) : (
          <div className="banner">You cancelled this request{order.cancelled_at ? ` at ${hhmm(order.cancelled_at)}` : ""}.</div>
        )}
        <div className="rq-card pad">
          <OrderBill order={order} />
        </div>
        <Link href={`/customer/request?type=${order.service_type}`} className="cta">
          Request again
        </Link>
      </main>
    );
  }

  return (
    <main className="screen flush">
      <div className="tr-map">
        <Map center={dest ?? DEFAULT_CENTER} destination={dest} tanker={tanker} follow padBottom={30} />
        {order.status === "requested" && <span className="radar" aria-hidden="true" />}
        <Link href="/customer" className="tr-chip">
          <Icon name="back" />
          <b>{code}</b>
        </Link>
      </div>

      <div className="sheet2">
        <i className="grab" aria-hidden="true" />
        {order.status === "requested" ? (
          <div className="srch-row">
            <span className="spin sm" role="img" aria-label="Searching" />
            <div>
              <h3 className="tj-t">Finding a permitted tanker near you</h3>
              <p className="mut" style={{ margin: 0 }}>
                We’ll update this screen the moment a driver accepts.
              </p>
            </div>
          </div>
        ) : (
          <div className="tr-eta">
            <div>
              <small>{order.status === "arrived" ? "Your tanker" : "Tanker is"}</small>
              <strong>
                {order.status === "arrived" ? "At your door" : away != null ? kmText(away) : order.status === "accepted" ? "Starting" : "On the way"}
              </strong>
              {away != null && order.status !== "arrived" && <small>about {etaMinutes(away)} min away</small>}
            </div>
            <StatusPill status={order.status} />
          </div>
        )}

        <Stepper order={order} />

        {order.tanker_plate && (
          <div className="dcard">
            <div className="dc-top">
              <span className="av">{initials(order.driver_name)}</span>
              <div>
                <b>{order.driver_name ?? "Your driver"}</b>
                <small>{SERVICE_SHORT[order.service_type]} tanker</small>
              </div>
              <span className="plate">{order.tanker_plate}</span>
            </div>
          </div>
        )}

        <div className="rq-card pad">
          <OrderBill order={order} />
        </div>

        {order.status === "requested" && (
          <div className="tr-act one">
            <button className="cta danger" disabled={busy} onClick={cancel}>
              {busy ? "Cancelling…" : "Cancel order"}
            </button>
          </div>
        )}
        <p className="tr-note">{place}</p>
      </div>
      {toast.node}
    </main>
  );
}
