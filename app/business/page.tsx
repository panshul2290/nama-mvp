"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder, type BizProperty } from "@/components/business/BizContext";
import { OPEN } from "@/components/business/data";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { Bars, Kpis, fmtDateTime, gal, monthStart, omr, useLive } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import { ref } from "@/lib/types";

export default function BusinessDashboard() {
  const { org } = useBiz();
  const [sites, setSites] = useState<BizProperty[]>([]);
  const [orders, setOrders] = useState<BizOrder[]>([]);
  const [activeContracts, setActiveContracts] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const db = supabase();
    const since = new Date(Math.min(monthStart().getTime(), Date.now() - 2 * 86_400_000)).toISOString();
    const [p, o, c, up] = await Promise.all([
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
      db.from("orders").select(ORDER_COLS).eq("org_id", org.id).gte("created_at", since).order("created_at", { ascending: false }).limit(1000),
      db.from("contracts").select("id", { count: "exact", head: true }).eq("org_id", org.id).eq("status", "active"),
      db.from("orders").select(ORDER_COLS).eq("org_id", org.id).in("status", OPEN).order("slot_start", { ascending: true, nullsFirst: true }).limit(50),
    ]);
    setSites((p.data ?? []) as BizProperty[]);
    const map = new Map<string, BizOrder>();
    for (const r of [...((o.data ?? []) as BizOrder[]), ...((up.data ?? []) as BizOrder[])]) map.set(r.id, r);
    setOrders([...map.values()]);
    setActiveContracts(c.count ?? 0);
    setLoaded(true);
  }, [org.id]);

  useLive("biz-dash", ["orders", "contracts", "properties"], load);

  const ms = monthStart().getTime();
  const month = orders.filter((o) => Date.parse(o.created_at) >= ms && o.status !== "cancelled");
  const delivered = month.filter((o) => o.status === "delivered");
  const spend = month.reduce((s, o) => s + Number(o.total), 0);
  const used = Number(org.credit_used);
  const limit = Number(org.credit_limit);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const siteName = (id: string | null) => sites.find((s) => s.id === id)?.label ?? "—";

  const bySite = sites
    .map((s) => ({ label: s.label, value: delivered.filter((o) => o.property_id === s.id).reduce((t, o) => t + o.gallons, 0) }))
    .sort((a, b) => b.value - a.value);
  const upcoming = orders
    .filter((o) => OPEN.includes(o.status))
    .sort((a, b) => (a.slot_start ?? a.created_at).localeCompare(b.slot_start ?? b.created_at))
    .slice(0, 8);

  return (
    <>
      <Kpis
        items={[
          { label: "Sites", value: loaded ? sites.length : "…" },
          { label: "Active contracts", value: loaded ? activeContracts : "…" },
          { label: "Deliveries this month", value: loaded ? delivered.length : "…", sub: `${month.length - delivered.length} more booked or on the way` },
          { label: "Spend this month", value: omr(spend), sub: "Incl. VAT, on account" },
          {
            label: `Credit used of ${omr(limit)}`,
            value: limit > 0 ? `${pct}%` : "—",
            sub: limit > 0 ? `${omr(used)} outstanding` : "Credit limit set by NWS on activation",
            tone: pct >= 90 ? "bad" : pct >= 70 ? "warn" : undefined,
          },
        ]}
      />
      <div className="half">
        <div className="panel">
          <h2>
            Water use by site <small>gallons delivered, this month</small>
          </h2>
          <Bars rows={bySite} unit=" gal" empty={sites.length ? "No deliveries this month yet." : "Add your first site in Sites."} />
        </div>
        <div className="panel">
          <h2>
            Upcoming deliveries
            <Link className="lk" href="/business/orders" style={{ fontSize: 13 }}>
              All orders
            </Link>
          </h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {upcoming.map((o) => (
                  <tr key={o.id}>
                    <td>{o.slot_label ?? (o.slot_start ? fmtDateTime(o.slot_start) : "As soon as possible")}</td>
                    <td>{siteName(o.property_id)}</td>
                    <td>
                      {gal(o.gallons)} gal <TypeTag type={o.service_type} />
                    </td>
                    <td className="mut">{o.contract_id ? "Contract" : ref.order(o.order_no)}</td>
                    <td>
                      <StatusPill status={o.status} />
                    </td>
                  </tr>
                ))}
                {loaded && !upcoming.length && (
                  <tr>
                    <td className="empty" colSpan={5}>
                      Nothing booked. Place a bulk order or set up a contract.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
