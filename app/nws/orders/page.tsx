"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { STATUS_TEXT } from "@/components/OrderBits";
import { orderNo } from "@/lib/format";
import { omrValue, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { OrderStatus } from "@/lib/types";

type Row = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: OrderStatus; total: string;
  tanker_plate: string | null; driver_name: string | null; created_at: string; customer: { full_name: string } | null;
};
const STATUSES: (OrderStatus | "all" | "active")[] = ["all", "active", "requested", "accepted", "arriving", "arrived", "delivered", "cancelled"];
const ACTIVE: OrderStatus[] = ["requested", "accepted", "arriving", "arrived"];
const label = (s: (typeof STATUSES)[number]) => (s === "all" ? "All" : s === "active" ? "Active" : STATUS_TEXT[s][0]);

export default function OrdersPage() {
  const router = useRouter();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [type, setType] = useState<ServiceType | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [area, setArea] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let query = supabase()
      .from("orders")
      .select("id, order_no, service_type, gallons, area, status, total, tanker_plate, driver_name, created_at, customer:profiles!orders_customer_id_fkey(full_name)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (status === "active") query = query.in("status", ACTIVE);
    else if (status !== "all") query = query.eq("status", status);
    if (type) query = query.eq("service_type", type);
    if (from) query = query.gte("created_at", new Date(`${from}T00:00:00`).toISOString());
    if (to) query = query.lte("created_at", new Date(`${to}T23:59:59.999`).toISOString());
    if (area.trim()) query = query.ilike("area", `%${area.trim()}%`);
    const n = q.trim().toUpperCase().replace(/^TO-?/, "");
    if (n) {
      if (!/^\d+$/.test(n)) return setRows([]);
      query = query.eq("order_no", Number(n));
    }
    const { data, error } = await query;
    setError(error?.message ?? null);
    setRows((data ?? []) as unknown as Row[]);
  }, [status, type, from, to, area, q]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Orders</h1>
          <p>Every order across all customers. Click a row for the timeline, driver, tanker and price lines.</p>
        </div>
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="chips" role="group" aria-label="Status">
            {STATUSES.map((s) => (
              <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setStatus(s)}>
                {label(s)}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar" style={{ paddingTop: 0 }}>
          <div className="filters">
            <input className="in" placeholder="Search TO-number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by TO number" style={{ width: 170 }} />
            <select className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType | "")} aria-label="Service type">
              <option value="">All services</option>
              <option value="DW">Drinking water</option>
              <option value="WW">Wastewater</option>
              <option value="TE">Treated effluent</option>
            </select>
            <input className="in" placeholder="Area" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area" style={{ width: 150 }} />
            <label className="mut" style={{ fontSize: 12.5 }}>
              From <input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="mut" style={{ fontSize: 12.5 }}>
              To <input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <span className="mut" style={{ fontSize: 12.5 }}>
            {rows ? `${rows.length} order${rows.length === 1 ? "" : "s"}${rows.length === 300 ? " (first 300)" : ""}` : "Loading…"}
          </span>
        </div>
        {error && <div className="banner badb" style={{ margin: "0 16px 12px" }}>{error}</div>}
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Type</th>
                <th className="num">Gallons</th>
                <th>Area</th>
                <th>Status</th>
                <th>Driver</th>
                <th>Tanker</th>
                <th className="num">Total</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty">
                    No orders match these filters.
                  </td>
                </tr>
              )}
              {rows?.map((o) => (
                <tr key={o.id} className="click" onClick={() => router.push(`/nws/orders/${o.id}`)}>
                  <td className={`stripe ${o.service_type}`}>
                    <b>{orderNo(o.order_no)}</b>
                  </td>
                  <td>{o.customer?.full_name || "—"}</td>
                  <td>
                    <span className={`tag ${o.service_type}`}>{o.service_type}</span>
                  </td>
                  <td className="num">{o.gallons.toLocaleString()}</td>
                  <td>{o.area}</td>
                  <td>
                    <span className={`st ${STATUS_TEXT[o.status][1]}`}>{STATUS_TEXT[o.status][0]}</span>
                  </td>
                  <td>{o.driver_name || "—"}</td>
                  <td>{o.tanker_plate || "—"}</td>
                  <td className="num">{omrValue(o.total)}</td>
                  <td>
                    <small>{fmtDateTime(o.created_at)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
