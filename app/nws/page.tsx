"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FleetMap } from "@/components/nws/FleetMap";
import { STATUS_TEXT } from "@/components/OrderBits";
import { agoText, STALE_AFTER_S } from "@/lib/gps";
import { orderNo } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";
import type { OrderStatus } from "@/lib/types";
import type { ServiceType } from "@/lib/pricing";

type LiveTanker = {
  id: string; plate: string; service_type: ServiceType; is_online: boolean; blocked: boolean;
  last_lat: number | null; last_lng: number | null; location_age_s: number | null;
};
type LiveOrder = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: OrderStatus;
  tanker_plate: string | null; created_at: string; loc: { lat: number; lng: number } | { lat: number; lng: number }[] | null;
};
const ACTIVE: OrderStatus[] = ["requested", "accepted", "arriving", "arrived"];
const TYPES: (ServiceType | "all")[] = ["all", "DW", "WW", "TE"];
const TYPE_LABEL = { all: "All", DW: "Drinking water", WW: "Wastewater", TE: "Treated effluent" };

export default function LiveOperations() {
  const [tankers, setTankers] = useState<LiveTanker[]>([]);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<ServiceType | "all">("all");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async () => {
    const db = supabase();
    const [t, o] = await Promise.all([
      db.from("tankers").select("id, plate, service_type, is_online, blocked, last_lat, last_lng, location_age_s").eq("is_online", true),
      db.from("orders").select("id, order_no, service_type, gallons, area, status, tanker_plate, created_at, loc:order_locations(lat, lng)").in("status", ACTIVE).order("created_at", { ascending: false }),
    ]);
    setTankers((t.data ?? []) as LiveTanker[]);
    setOrders((o.data ?? []) as LiveOrder[]);
    setFetchedAt(Date.now());
    setNow(Date.now());
    setLoaded(true);
  }, []);

  // Realtime: any change to tankers or orders refreshes the board (debounced); a slow poll is the safety net.
  useEffect(() => {
    const first = setTimeout(load, 0);
    const db = supabase();
    const soon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 600);
    };
    const ch = db
      .channel("nws-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "tankers" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, soon)
      .subscribe();
    const poll = setInterval(load, 30_000);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      clearTimeout(first);
      clearTimeout(timer.current);
      clearInterval(poll);
      clearInterval(tick);
      db.removeChannel(ch);
    };
  }, [load]);

  // Age = server age at fetch time + time since (no dependence on the browser clock vs the server's).
  const age = useCallback((t: LiveTanker) => (t.location_age_s == null ? null : t.location_age_s + (now - fetchedAt) / 1000), [now, fetchedAt]);
  const isStale = useCallback((t: LiveTanker) => {
    const a = age(t);
    return a == null || a > STALE_AFTER_S;
  }, [age]);

  const visibleTankers = tankers.filter((t) => filter === "all" || t.service_type === filter);
  const visibleOrders = orders.filter((o) => filter === "all" || o.service_type === filter);
  const stale = tankers.filter(isStale);
  const locOf = (o: LiveOrder) => (Array.isArray(o.loc) ? o.loc[0] : o.loc);

  const mapTankers = useMemo(
    () =>
      visibleTankers
        .filter((t) => t.last_lat != null && t.last_lng != null)
        .map((t) => {
          const a = age(t);
          return {
            id: t.id, lat: t.last_lat as number, lng: t.last_lng as number, type: t.service_type, stale: isStale(t), blocked: t.blocked,
            label: `${t.plate} · ${a == null ? "no fix yet" : `last fix ${agoText(a)}`}`,
          };
        }),
    [visibleTankers, age, isStale],
  );
  const mapOrders = useMemo(
    () =>
      visibleOrders
        .map((o) => ({ o, l: locOf(o) }))
        .filter(({ l }) => l)
        .map(({ o, l }) => ({ id: o.id, lat: l!.lat, lng: l!.lng, type: o.service_type, label: `${orderNo(o.order_no)} · ${STATUS_TEXT[o.status][0]} · ${o.gallons.toLocaleString()} gal` })),
    [visibleOrders],
  );

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Live operations</h1>
          <p>Online tankers and active orders, updated in real time. Tankers with no GPS fix for over {STALE_AFTER_S} s are shown grey.</p>
        </div>
      </div>

      <div className="okpis">
        <div className="okpi">
          <span>Active orders</span>
          <b>{loaded ? orders.length : "—"}</b>
          <small>{orders.filter((o) => o.status === "requested").length} waiting for a tanker</small>
        </div>
        <div className="okpi">
          <span>Online tankers</span>
          <b>{loaded ? tankers.length : "—"}</b>
          <small className="ok">{tankers.length - stale.length} reporting GPS</small>
        </div>
        <div className="okpi">
          <span>Stale tankers</span>
          <b>{loaded ? stale.length : "—"}</b>
          <small className={stale.length ? "bad" : ""}>no fix for over {STALE_AFTER_S} s</small>
        </div>
        <div className="okpi">
          <span>On a job</span>
          <b>{loaded ? orders.filter((o) => o.status !== "requested").length : "—"}</b>
          <small>accepted, on the way or arrived</small>
        </div>
      </div>

      <div className="ops-grid">
        <div className="mapcard">
          <FleetMap tankers={mapTankers} orders={mapOrders} />
          <div className="ov ov-tl chips" role="group" aria-label="Filter by service">
            {TYPES.map((k) => (
              <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {TYPE_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="ov ov-bl">
            <div className="legend2">
              <span><i style={{ background: "#3B82F6" }} />Drinking water</span>
              <span><i style={{ background: "#C08E35" }} />Wastewater</span>
              <span><i style={{ background: "#2FA36B" }} />Treated effluent</span>
              <span><i style={{ background: "#5E7479" }} />Stale GPS</span>
              <span><i style={{ background: "#E5484D" }} />Blocked</span>
              <span><i style={{ background: "#061a21", boxShadow: "inset 0 0 0 2px #93aeb3" }} />Active order (delivery point)</span>
            </div>
          </div>
        </div>

        <div className="ops-side">
          <div className="panel">
            <h2>
              Stale tankers <small>{stale.length}</small>
            </h2>
            <div className="alist">
              {stale.length === 0 ? (
                <div className="mut">All online tankers are reporting.</div>
              ) : (
                stale.map((t) => {
                  const a = age(t);
                  return (
                    <div key={t.id}>
                      <b>
                        {t.plate} <span className={`tag ${t.service_type}`}>{t.service_type}</span>
                      </b>
                      <span className="mut">{a == null ? "No GPS fix yet" : `Last fix ${agoText(a)}`}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="panel">
            <h2>
              Active orders <small>{orders.length}</small>
            </h2>
            <div className="alist">
              {orders.length === 0 ? (
                <div className="mut">No active orders.</div>
              ) : (
                orders.slice(0, 12).map((o) => (
                  <div key={o.id}>
                    <Link href={`/nws/orders/${o.id}`} className="lk">
                      {orderNo(o.order_no)}
                    </Link>{" "}
                    <span className={`st ${STATUS_TEXT[o.status][1]}`}>{STATUS_TEXT[o.status][0]}</span>
                    <span className="mut" style={{ display: "block" }}>
                      {o.service_type} · {o.gallons.toLocaleString()} gal · {o.area}
                      {o.tanker_plate ? ` · ${o.tanker_plate}` : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
