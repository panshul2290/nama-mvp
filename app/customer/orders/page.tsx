"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { SERVICE_SHORT, StatusPill } from "@/components/OrderBits";
import { orderNo } from "@/lib/format";
import { omrValue } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ACTIVE_STATUSES, type Order } from "@/lib/types";

export default function OrdersPage() {
  const profile = useCustomer();
  const [tab, setTab] = useState<"active" | "past">("active");
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    supabase()
      .from("orders")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => setOrders((data ?? []) as Order[]));
  }, [profile.id]);

  const list = (orders ?? []).filter((o) => (tab === "active") === ACTIVE_STATUSES.includes(o.status));

  return (
    <main className="screen">
      <div className="ptop">
        <h3>Orders</h3>
      </div>
      <div className="seg" role="tablist">
        {(["active", "past"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {k === "active" ? "Active" : "Past"}
          </button>
        ))}
      </div>
      {orders === null ? (
        <div className="empty">Loading…</div>
      ) : list.length === 0 ? (
        <div className="empty">
          {tab === "active" ? "No orders in progress." : "No past orders yet."}
          <br />
          <br />
          <Link href="/customer/request" className="btn pri">
            Request a tanker
          </Link>
        </div>
      ) : (
        list.map((o) => (
          <Link key={o.id} href={`/customer/orders/${o.id}`} className="card">
            <div className="row">
              <h4>{orderNo(o.order_no)}</h4>
              <StatusPill status={o.status} />
            </div>
            <p>
              {SERVICE_SHORT[o.service_type]} · {o.gallons.toLocaleString()} gal · {o.area}
              <br />
              {new Date(o.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {omrValue(o.total)}
            </p>
          </Link>
        ))
      )}
    </main>
  );
}
