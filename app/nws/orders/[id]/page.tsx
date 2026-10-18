"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { OrderBill, STATUS_TEXT } from "@/components/OrderBits";
import { usePricingRules } from "@/components/usePricingRules";
import { orderNo } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";
import type { Order, OrderLocation } from "@/lib/types";

type Detail = Order & {
  customer: { full_name: string; phone: string | null } | null;
  driver: { full_name: string; phone: string | null } | null;
  tanker: { id: string; plate: string; service_type: string; capacity_gal: number; blocked: boolean } | null;
};
type Audit = { id: number; at: string; action: string; actor_email: string | null; actor_role: string | null; reason: string | null };

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { rules } = usePricingRules();
  const [o, setO] = useState<Detail | null>(null);
  const [loc, setLoc] = useState<OrderLocation | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const db = supabase();
    Promise.all([
      db
        .from("orders")
        .select("*, customer:profiles!orders_customer_id_fkey(full_name, phone), driver:profiles!orders_driver_id_fkey(full_name, phone), tanker:tankers(id, plate, service_type, capacity_gal, blocked)")
        .eq("id", id)
        .maybeSingle(),
      db.from("order_locations").select("*").eq("order_id", id).maybeSingle(),
      db.from("audit_log").select("id, at, action, actor_email, actor_role, reason").eq("target_type", "order").eq("target_id", id).order("at"),
    ]).then(([a, b, c]) => {
      if (!a.data) return setMissing(true);
      setO(a.data as unknown as Detail);
      setLoc(b.data as OrderLocation | null);
      setAudit((c.data ?? []) as Audit[]);
    });
  }, [id]);

  if (missing) return <div className="empty">Order not found.</div>;
  if (!o) return <div className="empty">Loading…</div>;

  // Timeline from the order's own status timestamps, plus any staff (audit) actions on it.
  const events = [
    { at: o.created_at, text: "Requested", cls: "done" },
    { at: o.accepted_at, text: `Accepted by ${o.driver_name ?? "driver"}${o.tanker_plate ? ` · ${o.tanker_plate}` : ""}`, cls: "done" },
    { at: o.arriving_at, text: "On the way (first GPS fix)", cls: "done" },
    { at: o.arrived_at, text: "Arrived", cls: "done" },
    { at: o.delivered_at, text: "Delivered", cls: "done" },
    { at: o.cancelled_at, text: "Cancelled by the customer", cls: "bad" },
    ...audit.map((a) => ({ at: a.at, text: `${a.action} by ${a.actor_email ?? "staff"}${a.reason ? ` — ${a.reason}` : ""}`, cls: "done" })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return (
    <>
      <div className="vhead">
        <div>
          <h1>
            {orderNo(o.order_no)} <span className={`st ${STATUS_TEXT[o.status][1]}`}>{STATUS_TEXT[o.status][0]}</span>
          </h1>
          <p>
            <span className={`tag ${o.service_type}`}>{o.service_type}</span> {o.gallons.toLocaleString()} gal · {o.area} · created {fmtDateTime(o.created_at)}
          </p>
        </div>
        <Link href="/nws/orders" className="btn">
          ← All orders
        </Link>
      </div>
      <div className="two">
        <div>
          <div className="panel">
            <h2>Status timeline</h2>
            <ul className="tl">
              {events.map((e, i) => (
                <li key={i} className={e.cls}>
                  {e.text}
                  <small>{fmtDateTime(e.at)}</small>
                </li>
              ))}
            </ul>
          </div>
          <div className="panel">
            <h2>Delivery location</h2>
            <dl className="kv">
              <dt>Area</dt>
              <dd>{o.area}</dd>
              <dt>Address</dt>
              <dd>{loc?.address || "—"}</dd>
              <dt>Coordinates</dt>
              <dd>{loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : "—"}</dd>
            </dl>
          </div>
        </div>
        <div>
          <div className="panel">
            <h2>People and tanker</h2>
            <dl className="kv">
              <dt>Customer</dt>
              <dd>
                {o.customer?.full_name || "—"}
                {o.customer?.phone ? <small className="mut"> · {o.customer.phone}</small> : null}
              </dd>
              <dt>Driver</dt>
              <dd>
                {o.driver?.full_name || o.driver_name || "—"}
                {o.driver?.phone ? <small className="mut"> · {o.driver.phone}</small> : null}
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
                {o.tanker ? <small className="mut"> · {o.tanker.service_type} · {o.tanker.capacity_gal.toLocaleString()} gal{o.tanker.blocked ? " · blocked" : ""}</small> : null}
              </dd>
            </dl>
          </div>
          <div className="panel">
            <h2>
              Price <small>tags show lines priced from rules NWS hasn’t confirmed</small>
            </h2>
            <OrderBill order={o} rules={rules} />
            <dl className="kv" style={{ paddingTop: 0 }}>
              <dt>Driver earnings</dt>
              <dd>{Number(o.driver_earnings).toFixed(3)} OMR</dd>
              <dt>Priced in mode</dt>
              <dd>{o.price_basis?.mode ?? "—"}</dd>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
}
