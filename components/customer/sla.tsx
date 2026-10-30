"use client";

// E17: on-time status per order and a short on-time history for households.
import { useEffect, useState } from "react";
import { appSla, readSla, slaSummary, type OrderSla } from "@/lib/orderSla";
import { isMissing } from "@/lib/rpcCompat";
import type { SlaOrder } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import type { Order } from "@/lib/types";
import { useCx } from "./i18n";
import { dshort, tshort } from "./fmt";

// Which argument name my_order_sla() takes, once known; false = not in this database (use the app rule).
let rpcArg: string | false | null = null;

/** One order's SLA: my_order_sla() when the database has it, otherwise the shared lib/sla.ts rule. */
export async function fetchOrderSla(o: SlaOrder & { id: string }): Promise<OrderSla> {
  if (rpcArg === false) return appSla(o);
  for (const arg of rpcArg ? [rpcArg] : ["p_order_id"]) {
    const { data, error } = await supabase().rpc("my_order_sla", { [arg]: o.id });
    if (!error) {
      rpcArg = arg;
      return readSla(data, o);
    }
    if (!isMissing(error)) return appSla(o); // e.g. not_found: keep the app's reading
  }
  rpcArg = false;
  return appSla(o);
}

export function useOrderSla(order: (SlaOrder & { id: string; status: string }) | null) {
  const [sla, setSla] = useState<OrderSla | null>(null);
  const id = order?.id;
  const status = order?.status;
  const svc = order?.service_type ?? "";
  const created = order?.created_at ?? "";
  const { slot_end = null, released_at = null, delivered_at = null, collected_at = null } = order ?? {};
  useEffect(() => {
    if (!id || status === "cancelled") return;
    let live = true;
    fetchOrderSla({ id, service_type: svc, created_at: created, slot_end, released_at, delivered_at, collected_at }).then((s) => live && setSla(s));
    return () => {
      live = false;
    };
  }, [id, status, svc, created, slot_end, released_at, delivered_at, collected_at]);
  return order && order.status !== "cancelled" ? sla : null;
}

/** "On time" / "Late" / "Due by 14:00" chip for one order. */
export function SlaChip({ order, now }: { order: Order; now: number }) {
  const { t, lang } = useCx();
  const sla = useOrderSla(order);
  if (!sla) return null;
  if (sla.onTime === true) return <span className="st ok">{t("slaOn")}</span>;
  if (sla.onTime === false) return <span className="st bad">{t("slaLate")}</span>;
  const iso = new Date(sla.dueAt).toISOString();
  const late = now > sla.dueAt;
  return <span className={`st ${late ? "bad" : "act"}`}>{late ? t("slaOverdue") : t("slaDue", { d: dshort(iso, lang), t: tshort(iso, lang) })}</span>;
}

/** Account: on-time share of the last deliveries and a dot per delivery. */
export function SlaHistory({ customerId }: { customerId: string }) {
  const { t, n, lang } = useCx();
  const [rows, setRows] = useState<{ order: Order; sla: OrderSla }[] | null>(null);
  useEffect(() => {
    let live = true;
    supabase()
      .from("orders")
      .select("*")
      .eq("customer_id", customerId)
      .in("status", ["delivered", "collected"])
      .order("created_at", { ascending: false })
      .limit(20)
      .then(async ({ data }) => {
        const orders = (data ?? []) as Order[];
        const out = await Promise.all(orders.map(async (o) => ({ order: o, sla: await fetchOrderSla(o) })));
        if (live) setRows(out);
      });
    return () => {
      live = false;
    };
  }, [customerId]);
  if (!rows) return null;
  const s = slaSummary(rows.map((r) => r.sla));
  return (
    <>
      <h4 className="cx-h">{t("slaH")}</h4>
      {s.pct === null ? (
        <p className="mut small">{t("slaNone")}</p>
      ) : (
        <div className="rq-card pad sla-card">
          <div className="row">
            <b>{t("slaPct", { p: n(s.pct) })}</b>
            <small className="mut">{t("slaOf", { a: n(s.onTime), b: n(s.served) })}</small>
          </div>
          <div className="sla-dots" role="list" aria-label={t("slaH")}>
            {[...rows]
              .reverse()
              .filter((r) => r.sla.onTime !== null)
              .map((r) => (
                <span
                  key={r.order.id}
                  role="listitem"
                  className={r.sla.onTime ? "on" : "late"}
                  title={`${dshort(r.order.created_at, lang)} · ${t(r.sla.onTime ? "slaOn" : "slaLate")}`}
                  aria-label={`${dshort(r.order.created_at, lang)} · ${t(r.sla.onTime ? "slaOn" : "slaLate")}`}
                />
              ))}
          </div>
          <p className="mut small" style={{ margin: "8px 0 0" }}>
            {t("slaRule")}
          </p>
        </div>
      )}
    </>
  );
}
