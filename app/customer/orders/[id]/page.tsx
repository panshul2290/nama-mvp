"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Map } from "@/components/Map";
import { OrderPriceLines, StatusPill, Timeline, TypeTag } from "@/components/OrderBits";
import { Loading, TopBar } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { useToast } from "@/components/useToast";
import { errorCode, friendlyError } from "@/lib/errors";
import { announceGone } from "@/lib/feed";
import { distanceKm } from "@/lib/geo";
import { supabase } from "@/lib/supabase/client";
import type { LngLat, Order, OrderLocation, Tanker } from "@/lib/types";

const ON_JOB = ["accepted", "arriving", "arrived"];

export default function OrderTracking() {
  const { id } = useParams<{ id: string }>();
  const profile = useProfile("customer");
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
    if (!profile) return;
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
  }, [profile, id, load]);

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
      <>
        <TopBar subtitle="Order" />
        <main className="screen">
          <div className="empty">Order not found.</div>
          <Link href="/customer" className="cta sec">
            Back
          </Link>
        </main>
      </>
    );
  }
  if (!profile || !order) return <Loading />;

  const tanker = driverId && tankerFix?.driverId === driverId ? tankerFix.pos : null;
  const dest = loc ? { lat: loc.lat, lng: loc.lng } : null;
  const away = tanker && dest ? distanceKm(tanker, dest) : null;
  const finished = order.status === "delivered" || order.status === "cancelled";

  return (
    <>
      <TopBar subtitle={profile.full_name || "Customer"} />
      <main className="screen flush">
        <Map center={dest ?? { lat: 23.588, lng: 58.3829 }} destination={dest} tanker={tanker} follow className="tall" />
        <section className="sheet">
          <div className="ptop">
            <div>
              <h3>
                <TypeTag type={order.service_type} /> {order.gallons.toLocaleString()} gal
              </h3>
              <span className="sub">
                {order.area}
                {loc?.address ? ` · ${loc.address}` : ""}
              </span>
            </div>
            <StatusPill status={order.status} />
          </div>

          {order.status === "cancelled" ? (
            <div className="note bad">You cancelled this request.</div>
          ) : (
            <div className="card">
              <Timeline order={order} />
            </div>
          )}

          {order.tanker_plate && (
            <div className="card hl">
              <div className="row">
                <div>
                  <h4>{order.driver_name ?? "Your driver"}</h4>
                  <p>{away != null && !finished ? `${away < 1 ? `${Math.round(away * 1000)} m` : `${away.toFixed(1)} km`} away` : "Assigned driver"}</p>
                </div>
                <span className="plate">{order.tanker_plate}</span>
              </div>
            </div>
          )}

          <div className="card">
            <OrderPriceLines order={order} />
          </div>

          {order.status === "requested" && (
            <button className="cta danger" disabled={busy} onClick={cancel}>
              {busy ? "Cancelling…" : "Cancel request"}
            </button>
          )}
          {finished && (
            <Link href="/customer" className="cta">
              New request
            </Link>
          )}
        </section>
        {toast.node}
      </main>
    </>
  );
}
