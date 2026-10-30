"use client";

import "../ops.css";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { CallerOrderModal } from "@/components/nws/CallerOrderModal";
import { DispatchSuggestions } from "@/components/nws/DispatchSuggestions";
import { ORD } from "@/components/nws/i18n/orders";
import { CHANNEL_LABEL, downloadCsv, Kpi, n3, one, orderSla, useNow, useRealtime } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { statusText } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { orderNo } from "@/lib/format";
import { useLang, useT, type Lang } from "@/lib/i18n";
import { label, serviceLabel } from "@/lib/labels";
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
// Group labels are keys of ORD (components/nws/i18n/orders).
const GROUPS: [Group, string, OrderStatus[] | null][] = [
  ["all", "gAll", null],
  ["queue", "gQueue", ["requested"]],
  ["progress", "gProgress", ["accepted", "arriving", "arrived", "collected"]],
  ["scheduled", "gScheduled", ["scheduled"]],
  ["approval", "gApproval", ["pending_approval"]],
  ["closed", "gClosed", ["delivered", "cancelled"]],
];
const LIMIT = 300;
const COLS =
  "id, order_no, service_type, gallons, area, status, total, tanker_plate, driver_name, created_at, released_at, collected_at, delivered_at, slot_end, slot_label, channel, is_emergency, is_test, customer:profiles!orders_customer_id_fkey(full_name), zone:zones!orders_zone_id_fkey(name), contract:contracts!orders_contract_id_fkey(contract_no), org:organizations!orders_org_id_fkey(name)";

// English for the CSV export; planText words it on screen.
const plan = (o: Row) => (o.channel === "contract" && one(o.contract) ? `Contract CT-${one(o.contract)!.contract_no}` : (CHANNEL_LABEL[o.channel] ?? o.channel));
const planText = (o: Row, lang: Lang) =>
  o.channel === "contract" && one(o.contract) ? ORD.contractX[lang].replace("{n}", String(one(o.contract)!.contract_no)) : label("channel", o.channel, lang, CHANNEL_LABEL[o.channel] ?? o.channel);

export default function OrdersPage() {
  const router = useRouter();
  const { can } = useStaff();
  const t = useT(ORD);
  const f = useFmt();
  const { lang } = useLang();
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
    setError(error ? friendlyError(error, lang) : null);
    setRows((data ?? []) as unknown as Row[]);
  }, [group, type, from, to, area, q, lang]);

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
          <h1>{t("title")}</h1>
          <p>{t("intro")}</p>
        </div>
        <button
          className="btn pri"
          disabled={!canCall}
          title={canCall ? undefined : t("opsAgentsOnly")}
          onClick={() => setCalling(`GX-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`)}
        >
          {t("newCaller")}
        </button>
      </div>

      <div className="okpis">
        <Kpi label={t("kQueue")} value={counts.queue != null ? f.n(counts.queue) : "—"} sub={t("kQueueSub")} tone={counts.queue ? "warn" : ""} />
        <Kpi label={t("kProgress")} value={counts.progress != null ? f.n(counts.progress) : "—"} sub={t("kProgressSub", { s: f.n(counts.scheduled ?? 0), a: f.n(counts.approval ?? 0) })} />
        <Kpi
          label={t("kMedian")}
          value={median == null ? "—" : t("kMedianVal", { m: f.n(Math.floor(median / 60_000)), s: f.n(Math.round((median % 60_000) / 1000)) })}
          sub={t("kMedianSub")}
          tone={median == null ? undefined : median <= 10 * 60_000 ? "ok" : "warn"}
        />
        <Kpi
          label={t("kCancelled")}
          value={kpi ? f.n(kpi.cancelledToday) : "—"}
          sub={kpi?.createdToday ? t("kCancelledSub", { pct: f.ratio(kpi.cancelledToday, kpi.createdToday), n: f.n(kpi.createdToday) }) : t("kNoOrders")}
          tone={kpi && kpi.createdToday && kpi.cancelledToday / kpi.createdToday > 0.05 ? "bad" : ""}
        />
      </div>

      <div className="panel">
        <div className="toolbar">
          <div className="chips" role="group" aria-label={t("statusGroup")}>
            {GROUPS.map(([k, l]) => (
              <button key={k} className={`chip ${group === k ? "on" : ""}`} onClick={() => setGroup(k)}>
                {t(l)}
                {k !== "all" && k !== "closed" && counts[k] != null && <span className="tc">{f.n(counts[k])}</span>}
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
            {t("exportCsv")}
          </button>
        </div>
        <div className="toolbar" style={{ paddingTop: 0 }}>
          <div className="filters">
            <input className="in" placeholder={t("searchTo")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchToAria")} style={{ width: 170 }} />
            <select className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType | "")} aria-label={t("serviceType")}>
              <option value="">{t("allServices")}</option>
              <option value="DW">{serviceLabel("DW", lang)}</option>
              <option value="WW">{serviceLabel("WW", lang)}</option>
              <option value="TE">{serviceLabel("TE", lang)}</option>
            </select>
            <input className="in" placeholder={t("area")} value={area} onChange={(e) => setArea(e.target.value)} aria-label={t("area")} style={{ width: 150 }} />
            <label className="mut" style={{ fontSize: 12.5 }}>
              {t("from")} <input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="mut" style={{ fontSize: 12.5 }}>
              {t("to")} <input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <span className="mut" style={{ fontSize: 12.5 }}>
            {rows ? `${rows.length === 1 ? t("nOrder1") : t("nOrders", { n: f.n(rows.length) })}${rows.length === LIMIT ? t("firstN", { n: f.n(LIMIT) }) : ""}` : t("loading")}
          </span>
        </div>
        {error && <div className="banner badb" style={{ margin: "0 16px 12px" }}>{error}</div>}
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("order")}</th>
                <th>{t("customer")}</th>
                <th>{t("type")}</th>
                <th className="num">{t("gallons")}</th>
                <th>{t("thChannel")}</th>
                <th>{t("zone")}</th>
                <th>{t("status")}</th>
                <th>{t("tanker")}</th>
                <th className="num">{t("total")}</th>
                <th>{t("thSla")}</th>
                <th>{t("thCreated")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={12} className="empty">
                    {t("noMatch")}
                  </td>
                </tr>
              )}
              {rows?.map((o) => {
                const sla = orderSla(o, now, lang);
                const [stText, stTone] = statusText(o.status, o.service_type, lang);
                return (
                  <Fragment key={o.id}>
                  <tr className="click" onClick={() => router.push(`/nws/orders/${o.id}`)}>
                    <td className={`stripe ${o.service_type}`}>
                      <b dir="ltr">{orderNo(o.order_no)}</b>
                      {o.is_emergency && <span className="st bad ptag">{t("priority")}</span>}
                      {o.is_test && <span className="st warn ptag" title={t("testTip")}>{t("test")}</span>}
                    </td>
                    <td>
                      {o.customer?.full_name || "—"}
                      {one(o.org) && <small style={{ display: "block" }}>{one(o.org)!.name}</small>}
                    </td>
                    <td>
                      <span className={`tag ${o.service_type}`}>{o.service_type}</span>
                    </td>
                    <td className="num">{f.n(o.gallons)}</td>
                    <td>{planText(o, lang)}</td>
                    <td>
                      {one(o.zone)?.name ?? "—"}
                      <small style={{ display: "block" }}>{o.area}</small>
                    </td>
                    <td>
                      <span className={`st ${stTone}`}>{stText}</span>
                      {o.slot_label && ["scheduled", "requested"].includes(o.status) && <small style={{ display: "block" }}>{o.slot_label}</small>}
                    </td>
                    <td>{o.tanker_plate ? <bdi dir="ltr">{o.tanker_plate}</bdi> : "—"}</td>
                    <td className="num">{f.n3(o.total)}</td>
                    <td>{sla.tone ? <span className={`st ${sla.tone}`}>{sla.text}</span> : <span className="mut">—</span>}</td>
                    <td>
                      <small>{f.dateTime(o.created_at)}</small>
                    </td>
                    <td className="num">
                      {o.status === "requested" && (
                        <button className="btn sm" aria-expanded={suggest === o.id} onClick={(e) => { e.stopPropagation(); setSuggest(suggest === o.id ? null : o.id); }}>
                          {suggest === o.id ? t("hide") : t("suggest")}
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
