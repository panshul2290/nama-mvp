"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { Icon } from "@/components/icons";
import { Progress, SERVICE_SHORT, StatusPill, STATUS_TEXT } from "@/components/OrderBits";
import { firstName, greeting, orderCode } from "@/lib/format";
import { omrValue, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ACTIVE_STATUSES, type Order } from "@/lib/types";

export default function CustomerHome() {
  const profile = useCustomer();
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    supabase()
      .from("orders")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(8)
      .then(({ data }) => setOrders((data ?? []) as Order[]));
  }, [profile.id]);

  const active = (orders ?? []).filter((o) => ACTIVE_STATUSES.includes(o.status));
  const past = (orders ?? []).filter((o) => !ACTIVE_STATUSES.includes(o.status)).slice(0, 4);

  return (
    <main className="screen">
      <div className="ch-head">
        <div>
          <small>{greeting()}</small>
          <h3>{firstName(profile.full_name)}</h3>
        </div>
      </div>

      <div className="ch-hero">
        <h4>Need water at home?</h4>
        <p>Permitted tankers, transparent prices and live tracking to your door.</p>
        <Link href="/customer/request" className="cta">
          Request a tanker
        </Link>
        <div className="svcq">
          {(["DW", "WW", "TE"] as ServiceType[]).map((t) => (
            <Link key={t} href={`/customer/request?type=${t}`}>
              <i className={t} />
              {SERVICE_SHORT[t]}
            </Link>
          ))}
        </div>
      </div>

      {active.map((o) => (
        <Link key={o.id} href={`/customer/orders/${o.id}`} className="ch-active">
          <span className="row">
            <b>{orderCode(o.id)}</b>
            <StatusPill status={o.status} />
          </span>
          <small>
            {SERVICE_SHORT[o.service_type]} · {o.gallons.toLocaleString()} gal · {o.area}
          </small>
          <Progress status={o.status} />
          <span className="row">
            <strong>{STATUS_TEXT[o.status][0]}</strong>
            <span className="lk">Track</span>
          </span>
        </Link>
      ))}

      {active.length === 0 && (
        <div className="ch-tip">
          <span className="ri">
            <Icon name="drop" />
          </span>
          <div>
            <b>Know the price before you order</b>
            <p>Drinking water is 1 baisa a gallon for the first 650 gal. Delivery and 5% VAT are shown upfront.</p>
          </div>
        </div>
      )}

      {past.length > 0 && (
        <>
          <h4 className="ch-sec">Recent orders</h4>
          <div className="ch-list">
            {past.map((o) => (
              <Link key={o.id} href={`/customer/orders/${o.id}`} className="lrow">
                <span>
                  <b>
                    {SERVICE_SHORT[o.service_type]} · {o.gallons.toLocaleString()} gal
                  </b>
                  <small>
                    {o.area} · {new Date(o.created_at).toLocaleDateString()} · {omrValue(o.total)}
                  </small>
                </span>
                <StatusPill status={o.status} />
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
