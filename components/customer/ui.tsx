"use client";

import { createContext, use, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import type { RuleStatus, ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { Order, OrderStatus } from "@/lib/types";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { useCx } from "./i18n";
import { amt3, omr3, tshort } from "./fmt";

/** Bottom sheet over the whole phone frame (portalled, so it can be opened from anywhere). Only ever opened by a tap, never in the first render. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t, dir } = useCx();
  const [host] = useState(() => (typeof document === "undefined" ? null : document.querySelector(".phone")));
  const trap = useFocusTrap(onClose);
  const node = (
    <div className="cx-modal" dir={dir} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={trap} className="cx-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cx-sh-h">
          <h3>{title}</h3>
          <button type="button" className="iconbtn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return host ? createPortal(node, host) : node;
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`tg ${on ? "on" : ""}`} aria-pressed={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

export const STATUS_TONE: Record<OrderStatus, "act" | "ok" | "warn" | "bad"> = {
  scheduled: "act",
  pending_approval: "warn",
  requested: "warn",
  accepted: "act",
  arriving: "act",
  arrived: "act",
  collected: "act",
  delivered: "ok",
  cancelled: "bad",
};

export function StatusTag({ order }: { order: Pick<Order, "status" | "service_type" | "payment_status"> }) {
  const { t } = useCx();
  const key = order.status === "cancelled" && order.payment_status === "failed" ? "st_payfail" : order.status === "delivered" && order.service_type === "WW" ? "st_completed" : `st_${order.status}`;
  return <span className={`st ${STATUS_TONE[order.status]}`}>{t(key)}</span>;
}

export function SvcTag({ type }: { type: ServiceType }) {
  const { t } = useCx();
  return <span className={`tag ${type}`}>{t(`${type}q`)}</span>;
}

/** Flags a price line that rests on a rule NWS hasn't confirmed. */
export function RuleFlag({ status }: { status?: RuleStatus | string | null }) {
  const { t } = useCx();
  if (!status || status === "confirmed") return null;
  return <span className="st warn ptag">{t(status === "assumption" ? "assumption" : "pendingNws")}</span>;
}

// ---------------------------------------------------------------- timeline
type Step = { key: string; at: string | null | undefined };

export function orderSteps(o: Order): Step[] {
  return o.service_type === "WW"
    ? [
        { key: "tl_req", at: o.created_at },
        { key: "tl_asg2", at: o.accepted_at },
        { key: "tl_arr2", at: o.arrived_at },
        { key: "tl_col", at: o.collected_at },
        { key: "tl_dis2", at: o.discharged_at ?? (o.status === "delivered" ? o.delivered_at : null) },
      ]
    : [
        { key: "tl_req", at: o.created_at },
        { key: "tl_asg2", at: o.accepted_at },
        { key: "tl_fill2", at: o.filled_at },
        { key: "tl_arr2", at: o.arrived_at },
        { key: "tl_del", at: o.delivered_at },
      ];
}

/** Steps done so far (a later step implies the earlier ones, e.g. a fill that wasn't recorded). */
export function stepsDone(o: Order) {
  const s = orderSteps(o);
  let n = 0;
  s.forEach((x, i) => {
    if (x.at) n = i + 1;
  });
  return n;
}

/** Horizontal 5-step tracker per service (prototype cTimelineH). */
export function TimelineH({ order }: { order: Order }) {
  const { t, lang } = useCx();
  const steps = orderSteps(order);
  const done = stepsDone(order);
  return (
    <div className="tlh">
      {steps.map((s, i) => {
        const state = i < done ? "done" : i === done && order.status !== "cancelled" ? "cur" : "";
        return (
          <div key={s.key} className={state}>
            <i>{state === "done" && <Icon name="check" />}</i>
            <b>{t(s.key)}</b>
            <small>{s.at ? tshort(s.at, lang) : state === "cur" ? t("now") : ""}</small>
          </div>
        );
      })}
    </div>
  );
}

/** 5-segment progress bar for the home active-order card. */
export function Progress5({ order }: { order: Order }) {
  const done = stepsDone(order);
  return (
    <span className="seg5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < done ? "on" : i === done ? "half" : ""} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- bill
export type BillData = {
  water: number | string;
  fee: number | string;
  discount: number | string;
  vat: number | string;
  total: number | string;
  status: { water?: string | null; fee?: string | null; vat?: string | null; total?: string | null };
  peak?: boolean;
  priority?: boolean;
  promo?: string | null;
  vatPct?: number | null;
};

export function quoteToBill(q: Record<string, unknown>, promo: string | null): BillData {
  return {
    water: q.water_charge as number,
    fee: q.delivery_fee as number,
    discount: q.discount as number,
    vat: q.vat as number,
    total: q.total as number,
    status: { water: q.water_status as string, fee: q.fee_status as string, vat: q.vat_status as string, total: q.total_status as string },
    peak: Boolean(q.peak),
    priority: Boolean(q.priority),
    promo,
  };
}

export function orderToBill(o: Order): BillData {
  const b = o.price_basis;
  return {
    water: o.water_charge,
    fee: o.delivery_fee,
    discount: o.discount ?? 0,
    vat: o.vat,
    total: o.total,
    status: { water: b?.water, fee: b?.fee, vat: b?.vat, total: b?.total },
    peak: Boolean(b?.peak),
    priority: Boolean(b?.priority),
    promo: o.promo_code ?? null,
  };
}

export function Bill({ bill, gallons }: { bill: BillData; gallons?: number }) {
  const { t, lang } = useCx();
  const extras = [bill.peak && t("peakFee"), bill.priority && t("priorityFee")].filter(Boolean).join(" · ");
  return (
    <div className="bill">
      <div>
        <span>
          {t("water")}
          {gallons ? ` · ${gallons.toLocaleString("en-US")}` : ""} <RuleFlag status={bill.status.water} />
        </span>
        <span>{amt3(bill.water, lang)}</span>
      </div>
      <div>
        <span>
          {t("fee")}
          {extras ? ` (${extras})` : ""} <RuleFlag status={bill.status.fee} />
        </span>
        <span>{amt3(bill.fee, lang)}</span>
      </div>
      {Number(bill.discount) > 0 && (
        <div className="gr">
          <span>{bill.promo ? `${t("promo")} ${bill.promo}` : t("disc")}</span>
          <span>−{amt3(bill.discount, lang)}</span>
        </div>
      )}
      <div>
        <span>
          {bill.vatPct != null ? t("vatN", { n: bill.vatPct }) : t("vatL")} <RuleFlag status={bill.status.vat} />
        </span>
        <span>{amt3(bill.vat, lang)}</span>
      </div>
      <div className="tot">
        <span>
          {t("total")} <RuleFlag status={bill.status.total} />
        </span>
        <span>{omr3(bill.total, lang)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- unread notifications
const UnreadCtx = createContext<{ unread: number; refresh: () => void }>({ unread: 0, refresh: () => {} });
export const useUnread = () => use(UnreadCtx);

/** Unread notification count for the tab badge and the bell; live on INSERT. */
export function UnreadProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    supabase()
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null)
      .then(({ count }) => setUnread(count ?? 0));
  }, [userId]);
  useEffect(() => {
    refresh();
    const db = supabase();
    const ch = db
      .channel(`notif-badge-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => setUnread((n) => n + 1))
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [userId, refresh]);
  return <UnreadCtx value={{ unread, refresh }}>{children}</UnreadCtx>;
}
