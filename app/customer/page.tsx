"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { dshort, gal, windowText } from "@/components/customer/fmt";
import { useEmergency, useNow, useOnline, useProperties } from "@/components/customer/hooks";
import { fillPending, Progress5, StatusTag, statusKey, useUnread } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { firstName } from "@/lib/format";
import { LangToggle } from "@/lib/i18n";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ACTIVE_STATUSES, ref, type Contract, type Order, type OrderStatus, type Property } from "@/lib/types";

const OPEN: OrderStatus[] = [...ACTIVE_STATUSES, "scheduled", "pending_approval"];
const DAY = 86_400_000;

/** Predictive refill: average gap between the last drinking-water deliveries to one property. */
function refillDue(orders: Order[], props: Property[], now: number) {
  const byProp = new Map<string, Order[]>();
  for (const o of orders) {
    if (o.service_type !== "DW" || o.status !== "delivered" || !o.delivered_at) continue;
    const k = o.property_id ?? "pin";
    byProp.set(k, [...(byProp.get(k) ?? []), o]);
  }
  let best: { prop: Property | null; days: number; due: number; gallons: number } | null = null;
  for (const [k, list] of byProp) {
    if (list.length < 2) continue;
    const ts = list.map((o) => new Date(o.delivered_at!).getTime()).sort((a, b) => b - a).slice(0, 8);
    const gap = (ts[0] - ts[ts.length - 1]) / (ts.length - 1);
    if (gap < DAY) continue;
    const due = ts[0] + gap;
    if (due - DAY > now) continue; // not due yet
    if (!best || due < best.due) best = { prop: props.find((p) => p.id === k) ?? null, days: Math.round(gap / DAY), due, gallons: list[0].gallons };
  }
  return best;
}

const muscatHour = (now: number) => new Date(now + 4 * 3600_000).getUTCHours();

export default function CustomerHome() {
  const profile = useCustomer();
  const { t, lang } = useCx();
  const { unread } = useUnread();
  const online = useOnline();
  const emergency = useEmergency();
  const now = useNow(60_000);
  const { props } = useProperties(profile.id);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [delivered, setDelivered] = useState<number | null>(null);

  useEffect(() => {
    const db = supabase();
    db.from("orders")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(40)
      .then(({ data }) => setOrders((data ?? []) as Order[]));
    db.from("contracts")
      .select("*")
      .eq("customer_id", profile.id)
      .in("status", ["active", "paused", "pending_owner"])
      .then(({ data }) => setContracts((data ?? []) as Contract[]));
    db.from("orders")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", profile.id)
      .eq("status", "delivered")
      .then(({ count }) => setDelivered(count ?? 0));
  }, [profile.id]);

  const active = useMemo(() => (orders ?? []).filter((o) => OPEN.includes(o.status)), [orders]);
  const refill = useMemo(
    () => (orders && props && !active.some((o) => o.service_type === "DW") ? refillDue(orders, props, now) : null),
    [orders, props, active, now],
  );
  const propLabel = (id: string | null | undefined) => props?.find((p) => p.id === id)?.label;
  const h = muscatHour(now);

  return (
    <main className="screen">
      <div className="ch-head">
        <div>
          <small>{t(h < 12 ? "gmM" : h < 17 ? "gmA" : "gmE")}</small>
          <h3>{profile.full_name ? firstName(profile.full_name) : t("there")}</h3>
        </div>
        <div className="ch-tools">
          <Link href="/customer/inbox" className="rb" aria-label={t("inbox")}>
            <Icon name="bell" />
            {unread > 0 && <span className="dot" />}
          </Link>
          <LangToggle />
        </div>
      </div>

      {!online && (
        <div className="banner badb" role="status">
          {t("offline")}
        </div>
      )}
      {emergency && (
        <div className="banner badb" role="alert">
          {t("emBan", { z: emergency.zone || t("allZones"), r: emergency.reason || "" })}
        </div>
      )}

      <div className="ch-hero">
        <h4>{t("needW")}</h4>
        <p>{t("needS")}</p>
        <Link href="/customer/request" className="cta">
          {t("reqTanker")}
        </Link>
        <div className="svcq">
          {(["DW", "WW", "TE"] as ServiceType[]).map((k) => (
            <Link key={k} href={`/customer/request?type=${k}`}>
              <i className={k} />
              {t(`${k}q`)}
            </Link>
          ))}
        </div>
      </div>

      {active.map((o) => (
        <Link key={o.id} href={`/customer/order?id=${o.id}`} className="ch-active">
          <span className="row">
            <b>{ref.order(o.order_no)}</b>
            <StatusTag order={o} />
          </span>
          <small>
            {t(`${o.service_type}q`)} · {gal(o.gallons, lang)} · {propLabel(o.property_id) || o.area}
          </small>
          <Progress5 order={o} />
          <span className="row">
            <strong>{o.status === "scheduled" ? windowText(o.slot_start, o.slot_end, lang) : t(fillPending(o) ? "st_toFill" : statusKey(o))}</strong>
            <span className="lk">{t("track")}</span>
          </span>
        </Link>
      ))}

      {refill && (
        <div className="ch-refill">
          <span className="ri">
            <Icon name="drop" />
          </span>
          <div>
            <b>{t("refill")}</b>
            <p>{t("refillM", { p: refill.prop?.label ?? t("yourHome"), d: refill.days, day: dshort(new Date(refill.due).toISOString(), lang) })}</p>
          </div>
          <Link className="btn sm pri" href={`/customer/request?type=DW&gallons=${refill.gallons}${refill.prop ? `&property=${refill.prop.id}` : ""}`}>
            {t("orderG", { g: gal(refill.gallons, lang) })}
          </Link>
        </div>
      )}

      {delivered === 0 && <div className="ch-promo">{t("promoBan")}</div>}

      <h4 className="ch-sec" style={{ marginTop: 16 }}>
        {t("yourProps")}
      </h4>
      {props && props.length > 0 && (
        <div className="ch-list">
          {props.map((p) => (
            <div key={p.id} className="lrow">
              <span>
                <b>{p.label}</b>
                <small>
                  {[p.area, p.address].filter(Boolean).join(" · ")} · {gal(p.tank_gal, lang)}
                </small>
              </span>
              {contracts.some((k) => k.property_id === p.id && k.status === "active") ? (
                <span className="st ok">{t("contractTag")}</span>
              ) : (
                <Link className="lk" href={`/customer/request?property=${p.id}`}>
                  {t("request")}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
      {props && props.length === 0 && (
        <div className="ch-list">
          <div className="lrow">
            <span>
              {t("noProps")}
              <small>{t("propS")}</small>
            </span>
            <Link className="lk" href="/customer/account?add=property">
              {t("addProp")}
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
