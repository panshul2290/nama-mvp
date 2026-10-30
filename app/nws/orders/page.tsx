"use client";

import "../ops.css";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { CallerOrderModal } from "@/components/nws/CallerOrderModal";
import { DispatchSuggestions } from "@/components/nws/DispatchSuggestions";
import { CHANNEL_LABEL, downloadCsv, Kpi, n3, one, orderSla, useNow, useRealtime } from "@/components/nws/ops";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { statusText } from "@/components/OrderBits";
import { friendlyError } from "@/lib/errors";
import { orderNo } from "@/lib/format";
import { type ServiceType } from "@/lib/pricing";
import { muscatDayStart } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import { omanDayEndIso, omanDayStartIso } from "@/lib/time";
import type { OrderStatus } from "@/lib/types";

type Row = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: OrderStatus; total: string;
  tanker_plate: string | null; driver_name: string | null; created_at: string; released_at: string | null; collected_at: string | null; delivered_at: string | null;
  slot_end: string | null; slot_label: string | null;
  channel: string; is_emergency: boolean; is_test: boolean;
  customer: { full_name: string } | null;
  zone: { name: string } | { name: string }[] | null;
  contract: { contract_no: number } | { contract_no: number }[] | null;
  org: { name: string } | { name: string }[] | null;
};
type Group = "all" | "queue" | "progress" | "scheduled" | "approval" | "closed";
const GROUPS: [Group, string, OrderStatus[] | null][] = [
  ["all", "All", null],
  ["queue", "Dispatch queue", ["requested"]],
  ["progress", "In progress", ["accepted", "arriving", "arrived", "collected"]],
  ["scheduled", "Scheduled", ["scheduled"]],
  ["approval", "Awaiting approval", ["pending_approval"]],
  ["closed", "Closed", ["delivered", "cancelled"]],
];
const LIMIT = 300;
const COLS =
  "id, order_no, service_type, gallons, area, status, total, tanker_plate, driver_name, created_at, released_at, collected_at, delivered_at, slot_end, slot_label, channel, is_emergency, is_test, customer:profiles!orders_customer_id_fkey(full_name), zone:zones!orders_zone_id_fkey(name), contract:contracts!orders_contract_id_fkey(contract_no), org:organizations!orders_org_id_fkey(name)";

const plan = (o: Row) => (o.channel === "contract" && one(o.contract) ? `Contract CT-${one(o.contract)!.contract_no}` : (CHANNEL_LABEL[o.channel] ?? o.channel));

export default function OrdersPage() {
  const router = useRouter();
  const { can } = useStaff();
  const now = useNow(30_000);
  const [group, setGroup] = useState<Group>("all");
  const [type, setType] = useState<ServiceType | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [area, setArea] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Group, number>>>({});
  const [kpi, setKpi] = useState<{ median: number | null; cancelledToday: number; createdToday: number } | null>(null);
  const [calling, setCalling] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    let query = supabase().from("orders").select(COLS).order("created_at", { ascending: false }).limit(LIMIT);
    const st = GROUPS.find((g) => g[0] === group)?.[2];
    if (st) query = query.in("status", st);
    if (type) query = query.eq("service_type", type);
    if (from) query = query.gte("created_at", omanDayStartIso(from));
    if (to) query = query.lte("created_at", omanDayEndIso(to));
    if (area.trim()) query = query.ilike("area", `%${area.trim()}%`);
    const n = q.trim().toUpperCase().replace(/^TO-?/, "");
    if (n) {
      if (!/^\d+$/.test(n)) return setRows([]);
      query = query.eq("order_no", Number(n));
    }
    const { data, error } = await query;
    setError(error ? friendlyError(error) : null);
    setRows((data ?? []) as unknown as Row[]);
  }, [group, type, from, to, area, q]);

  // Status counts and dispatch KPIs (independent of the table filters). Test-zone orders don't count.
  const loadKpis = useCallback(async () => {
    const db = supabase();
    const day = muscatDayStart();
    const week = new Date(day.getTime() - 7 * 86_400_000).toISOString();
    const real = () => db.from("orders").select("id", { count: "exact", head: true }).eq("is_test", false);
    const head = (s: OrderStatus[]) => real().in("status", s);
    const [c, acc, cx, made] = await Promise.all([
      Promise.all(GROUPS.slice(1).map((g) => head(g[2]!))),
      db.from("orders").select("created_at, released_at, accepted_at").eq("is_test", false).gte("accepted_at", week).order("accepted_at", { ascending: false }).limit(1000),
      real().eq("status", "cancelled").gte("cancelled_at", day.toISOString()),
      real().gte("created_at", day.toISOString()),
    ]);
    setCounts(Object.fromEntries(GROUPS.slice(1).map((g, i) => [g[0], c[i].count ?? 0])));
    const waits = ((acc.data ?? []) as { created_at: string; released_at: string | null; accepted_at: string }[])
      .map((o) => Date.parse(o.accepted_at) - Date.parse(o.released_at ?? o.created_at))
      .filter((x) => x >= 0)
      .sort((a, b) => a - b);
    setKpi({ median: waits.length ? waits[Math.floor(waits.length / 2)] : null, cancelledToday: cx.count ?? 0, createdToday: made.count ?? 0 });
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce typing
    return () => clearTimeout(t);
  }, [load, tick]);
  useEffect(() => {
    const t = setTimeout(loadKpis, 0);
    return () => clearTimeout(t);
  }, [loadKpis, tick]);
  useRealtime("nws-orders", ["orders"], () => setTick((x) => x + 1), 1200);

  const median = kpi?.median;
  const canCall = can("operator", "complaints_agent");

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Orders</h1>
          <p>
            All requests from the mobile app, B2B accounts, contracts and the Genesys call centre. Dispatch offers each request to the nearest online, permitted
            tanker; operators can assign, reschedule, cancel or refund.
          </p>
        </div>
        <button
          className="btn pri"
          disabled={!canCall}
          title={canCall ? undefined : "Operators and complaints agents only"}
          onClick={() => setCalling(`GX-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`)}
        >
          New order for a caller
        </button>
      </div>

      <div className="okpis">
        <Kpi label="In dispatch queue" value={counts.queue ?? "—"} sub="waiting for a tanker" tone={counts.queue ? "warn" : ""} />
        <Kpi label="In progress" value={counts.progress ?? "—"} sub={`${counts.scheduled ?? 0} scheduled · ${counts.approval ?? 0} awaiting approval`} />
        <Kpi label="Median time to assign" value={median == null ? "—" : `${Math.floor(median / 60_000)} m ${Math.round((median % 60_000) / 1000)} s`} sub="last 7 days · from release · target 10 min" tone={median == null ? undefined : median <= 10 * 60_000 ? "ok" : "warn"} />
        <Kpi
          label="Cancelled today"
          value={kpi ? kpi.cancelledToday : "—"}
          sub={kpi?.createdToday ? `${Math.round((kpi.cancelledToday / kpi.createdToday) * 1000) / 10}% of ${kpi.createdToday} orders today` : "no orders today yet"}
          tone={kpi && kpi.createdToday && kpi.cancelledToday / kpi.createdToday > 0.05 ? "bad" : ""}
        />
      </div>

      <div className="panel">
        <div className="toolbar">
          <div className="chips" role="group" aria-label="Status">
            {GROUPS.map(([k, l]) => (
              <button key={k} className={`chip ${group === k ? "on" : ""}`} onClick={() => setGroup(k)}>
                {l}
                {k !== "all" && k !== "closed" && counts[k] != null && <span className="tc">{counts[k]}</span>}
              </button>
            ))}
          </div>
          <button
            className="btn sm"
            disabled={!rows?.length}
            onClick={() =>
              downloadCsv("orders", [
                ["Order", "Customer", "Service", "Gallons", "Plan", "Zone", "Area", "Status", "Tanker", "Driver", "Total OMR", "SLA", "Created", "Test"],
                ...(rows ?? []).map((o) => [
                  orderNo(o.order_no), o.customer?.full_name ?? one(o.org)?.name ?? "", o.service_type, o.gallons, plan(o), one(o.zone)?.name ?? "", o.area,
                  statusText(o.status, o.service_type)[0], o.tanker_plate ?? "", o.driver_name ?? "", n3(o.total), orderSla(o, now).text, o.created_at, o.is_test ? "TEST" : "",
                ]),
              ])
            }
          >
            Export CSV
          </button>
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
            {rows ? `${rows.length} order${rows.length === 1 ? "" : "s"}${rows.length === LIMIT ? ` (first ${LIMIT})` : ""}` : "Loading…"}
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
                <th>Channel</th>
                <th>Zone</th>
                <th>Status</th>
                <th>Tanker</th>
                <th className="num">Total</th>
                <th>SLA</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={12} className="empty">
                    No orders match these filters.
                  </td>
                </tr>
              )}
              {rows?.map((o) => {
                const sla = orderSla(o, now);
                return (
                  <Fragment key={o.id}>
                  <tr className="click" onClick={() => router.push(`/nws/orders/${o.id}`)}>
                    <td className={`stripe ${o.service_type}`}>
                      <b>{orderNo(o.order_no)}</b>
                      {o.is_emergency && <span className="st bad ptag">priority</span>}
                      {o.is_test && <span className="st warn ptag" title="Test zone order: not counted in KPIs, reports or invoices">TEST</span>}
                    </td>
                    <td>
                      {o.customer?.full_name || "—"}
                      {one(o.org) && <small style={{ display: "block" }}>{one(o.org)!.name}</small>}
                    </td>
                    <td>
                      <span className={`tag ${o.service_type}`}>{o.service_type}</span>
                    </td>
                    <td className="num">{o.gallons.toLocaleString()}</td>
                    <td>{plan(o)}</td>
                    <td>
                      {one(o.zone)?.name ?? "—"}
                      <small style={{ display: "block" }}>{o.area}</small>
                    </td>
                    <td>
                      <span className={`st ${statusText(o.status, o.service_type)[1]}`}>{statusText(o.status, o.service_type)[0]}</span>
                      {o.slot_label && ["scheduled", "requested"].includes(o.status) && <small style={{ display: "block" }}>{o.slot_label}</small>}
                    </td>
                    <td>{o.tanker_plate || "—"}</td>
                    <td className="num">{n3(o.total)}</td>
                    <td>{sla.tone ? <span className={`st ${sla.tone}`}>{sla.text}</span> : <span className="mut">—</span>}</td>
                    <td>
                      <small>{fmtDateTime(o.created_at)}</small>
                    </td>
                    <td className="num">
                      {o.status === "requested" && (
                        <button className="btn sm" aria-expanded={suggest === o.id} onClick={(e) => { e.stopPropagation(); setSuggest(suggest === o.id ? null : o.id); }}>
                          {suggest === o.id ? "Hide" : "Suggest"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {suggest === o.id && (
                    <tr>
                      <td colSpan={12} style={{ background: "var(--bg2, #f6f8f9)" }}>
                        <DispatchSuggestions compact orderId={o.id} orderLabel={orderNo(o.order_no)} canAssign={can("operator")} onAssigned={() => { setSuggest(null); load(); }} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {calling && (
        <CallerOrderModal
          genesysId={calling}
          onClose={() => setCalling(null)}
          onPlaced={(o) => {
            setCalling(null);
            router.push(`/nws/orders/${o.id}`);
          }}
        />
      )}
    </>
  );
}
