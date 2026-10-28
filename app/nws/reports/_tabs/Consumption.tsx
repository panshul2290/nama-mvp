"use client";

import { useEffect, useMemo, useState } from "react";
import { BarList, Donut, PALETTE, SERVICE_COLOR, Sparkline } from "@/components/nws/admin/charts";
import { Empty, fetchPaged, groupBy, int, Kpi, omr } from "@/components/nws/admin/ui";
import { fmtDate } from "@/components/nws/StaffContext";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ROW_CAP, type ORow } from "./data";

type Hist = { customer_id: string; property_id: string | null; area: string; gallons: number; delivered_at: string };
type Who = { id: string; full_name: string; segment: string | null };
type Prop = { id: string; label: string; area: string; tank_gal: number };

const DAY = 86400_000;
const SEGMENT_LABEL: Record<string, string> = { household: "Residential", commercial: "Commercial", farm: "Farms", government: "Government" };

/** Refill prediction per property (or customer + area when no property): average gap between DW deliveries. */
function predict(hist: Hist[]) {
  const by = groupBy(hist, (h) => h.property_id ?? `${h.customer_id}|${h.area}`, () => [] as Hist[], (a, h) => a.push(h));
  const now = Date.now();
  return [...by.values()]
    .map((hs) => {
      const t = hs.map((h) => new Date(h.delivered_at).getTime()).sort((a, b) => a - b);
      const gaps = t.slice(1).map((x, i) => x - t[i]).filter((g) => g > DAY / 4);
      const weeks = Array.from({ length: 8 }, (_, w) =>
        hs.filter((h) => { const age = now - new Date(h.delivered_at).getTime(); return age >= (7 - w) * 7 * DAY && age < (8 - w) * 7 * DAY; }).reduce((a, h) => a + h.gallons, 0),
      );
      const avg = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : null;
      const last = t[t.length - 1];
      const next = avg ? last + avg : null;
      return {
        key: hs[0].property_id ?? `${hs[0].customer_id}|${hs[0].area}`,
        customer_id: hs[0].customer_id, property_id: hs[0].property_id, area: hs[0].area,
        deliveries: hs.length, avgDays: avg ? avg / DAY : null, last, next,
        dueIn: next ? (next - now) / DAY : null,
        perWeek: weeks.reduce((a, g) => a + g, 0) / 8, weeks,
      };
    })
    .filter((p) => p.avgDays != null);
}

export default function Consumption({ rows }: { rows: ORow[] }) {
  const [hist, setHist] = useState<Hist[] | null>(null);
  const [who, setWho] = useState<Map<string, Who>>(new Map());
  const [props, setProps] = useState<Map<string, Prop>>(new Map());
  const [segments, setSegments] = useState<Record<string, number> | null>(null);

  const delivered = useMemo(() => rows.filter((o) => o.status === "delivered"), [rows]);

  // 180 days of drinking-water deliveries drive the refill predictions (independent of the range).
  useEffect(() => {
    const db = supabase();
    const from = new Date(Date.now() - 180 * DAY).toISOString();
    fetchPaged<Hist>((a, b) => db.from("orders").select("customer_id, property_id, area, gallons, delivered_at").eq("service_type", "DW").eq("status", "delivered").gte("delivered_at", from).order("delivered_at").order("id").range(a, b), ROW_CAP)
      .then(({ rows: r }) => setHist(r));
    fetchPaged<{ segment: string | null }>((a, b) => db.from("profiles").select("segment").eq("role", "customer").order("id").range(a, b), 20000).then(({ rows: r }) => {
      const m: Record<string, number> = {};
      for (const x of r) m[x.segment ?? "household"] = (m[x.segment ?? "household"] ?? 0) + 1;
      setSegments(m);
    });
  }, []);

  const preds = useMemo(() => (hist ? predict(hist) : []), [hist]);
  const consumers = useMemo(
    () => [...groupBy(delivered, (o) => o.customer_id, () => ({ n: 0, gal: 0, omr: 0 }), (a, o) => { a.n++; a.gal += o.gallons; a.omr += Number(o.total); })]
      .sort((a, b) => b[1].gal - a[1].gal).slice(0, 10),
    [delivered],
  );
  const alerts = useMemo(() => preds.filter((p) => p.dueIn != null && p.dueIn <= 3).sort((a, b) => a.dueIn! - b.dueIn!), [preds]);
  const topProps = useMemo(() => [...preds].sort((a, b) => b.perWeek - a.perWeek).slice(0, 25), [preds]);

  // Names for the people and properties on screen.
  useEffect(() => {
    const ids = [...new Set([...consumers.map(([id]) => id), ...alerts.slice(0, 50).map((p) => p.customer_id), ...topProps.map((p) => p.customer_id)])];
    const pids = [...new Set([...alerts.slice(0, 50), ...topProps].map((p) => p.property_id).filter((x): x is string => !!x))];
    const db = supabase();
    if (ids.length) db.from("profiles").select("id, full_name, segment").in("id", ids).then(({ data }) => setWho(new Map(((data ?? []) as Who[]).map((p) => [p.id, p]))));
    if (pids.length) db.from("properties").select("id, label, area, tank_gal").in("id", pids).then(({ data }) => setProps(new Map(((data ?? []) as Prop[]).map((p) => [p.id, p]))));
  }, [consumers, alerts, topProps]);

  const byArea = [...groupBy(delivered, (o) => o.area || "—", () => ({ gal: 0 }), (a, o) => (a.gal += o.gallons))].sort((a, b) => b[1].gal - a[1].gal).slice(0, 10);
  const totalGal = delivered.reduce((a, o) => a + o.gallons, 0);
  const name = (id: string) => who.get(id)?.full_name || "Customer";
  const place = (p: { property_id: string | null; area: string }) => (p.property_id ? (props.get(p.property_id)?.label ?? "Property") : "No saved property");
  const due = (d: number | null) =>
    d == null ? <span className="mut">—</span> : d < 0 ? <span className="st bad">Overdue {Math.ceil(-d)} d</span> : d <= 3 ? <span className="st warn">Due in {Math.max(0, Math.round(d))} d</span> : <span className="st ok">In {Math.round(d)} d</span>;

  return (
    <>
      <div className="okpis">
        <Kpi label="Water delivered" value={`${int(totalGal)} gal`} sub={`${int(delivered.length)} trips in range`} />
        <Kpi label="Average per trip" value={delivered.length ? `${int(totalGal / delivered.length)} gal` : "—"} />
        <Kpi label="Refill alerts due" value={hist ? int(alerts.length) : "…"} sub="refill expected within 3 days" tone={alerts.length ? "warn" : undefined} />
        <Kpi label="Properties tracked" value={hist ? int(preds.length) : "…"} sub="2 or more drinking-water deliveries in 180 days" />
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>Water delivered by area <small>gallons</small></h2>
          <BarList rows={byArea.map(([a, v]) => ({ label: a, value: v.gal }))} />
        </div>
        <div className="panel">
          <h2>By service <small>gallons</small></h2>
          <Donut
            slices={(["DW", "WW", "TE"] as ServiceType[]).map((s) => ({ label: SERVICE_LABEL[s], value: delivered.filter((o) => o.service_type === s).reduce((a, o) => a + o.gallons, 0), color: SERVICE_COLOR[s] }))}
            center={totalGal >= 1e6 ? `${(totalGal / 1e6).toFixed(1)} M` : `${Math.round(totalGal / 1e3)} k`}
            sub="gallons"
          />
        </div>
        <div className="panel">
          <h2>Customer segments <small>accounts</small></h2>
          {segments ? (
            <Donut slices={Object.entries(segments).map(([k, v], i) => ({ label: SEGMENT_LABEL[k] ?? k, value: v, color: PALETTE[i % PALETTE.length] }))} sub="customers" />
          ) : (
            <div className="empty">Loading…</div>
          )}
        </div>
      </div>

      <div className="half">
        <div className="panel">
          <h2>Top consumers <small>delivered in range</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Customer</th><th className="num">Trips</th><th className="num">Gallons</th><th className="num">OMR</th></tr></thead>
              <tbody>
                {consumers.length === 0 && <Empty cols={4}>No deliveries in this range.</Empty>}
                {consumers.map(([id, v]) => (
                  <tr key={id}>
                    <td>{name(id)}<small style={{ display: "block" }}>{SEGMENT_LABEL[who.get(id)?.segment ?? ""] ?? ""}</small></td>
                    <td className="num">{v.n}</td>
                    <td className="num">{int(v.gal)}</td>
                    <td className="num">{omr(v.omr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>Predictive refill alerts <small>refill expected within 3 days</small></h2>
          <div className="tblwrap scroll">
            <table>
              <thead><tr><th>Customer · property</th><th className="num">Every</th><th>Last delivery</th><th>Expected</th><th>Alert</th></tr></thead>
              <tbody>
                {!hist && <Empty cols={5}>Loading…</Empty>}
                {hist && alerts.length === 0 && <Empty cols={5}>No refills due in the next 3 days.</Empty>}
                {alerts.slice(0, 50).map((p) => (
                  <tr key={p.key}>
                    <td>{name(p.customer_id)}<small style={{ display: "block" }}>{place(p)} · {p.area}</small></td>
                    <td className="num">{p.avgDays!.toFixed(1)} d</td>
                    <td>{fmtDate(new Date(p.last).toISOString())}</td>
                    <td>{p.next ? fmtDate(new Date(p.next).toISOString()) : "—"}</td>
                    <td>{due(p.dueIn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">Average interval between a property&apos;s drinking-water deliveries over the last 180 days. Customers get the “Refill reminder” notification template when a refill is due.</p>
        </div>
      </div>

      <div className="panel">
        <h2>Consumption by property <small>usage trends, drinking water</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Property</th><th>Customer</th><th className="num">Gallons / week</th><th>Trend (8 weeks)</th><th className="num">Deliveries</th><th>Next predicted refill</th><th>Alert</th></tr>
            </thead>
            <tbody>
              {!hist && <Empty cols={7}>Loading…</Empty>}
              {hist && topProps.length === 0 && <Empty cols={7}>Not enough delivery history yet.</Empty>}
              {topProps.map((p) => (
                <tr key={p.key}>
                  <td>{place(p)}<small style={{ display: "block" }}>{p.area}{p.property_id && props.get(p.property_id) ? ` · tank ${int(props.get(p.property_id)!.tank_gal)} gal` : ""}</small></td>
                  <td>{name(p.customer_id)}</td>
                  <td className="num">{int(p.perWeek)}</td>
                  <td><Sparkline values={p.weeks} /></td>
                  <td className="num">{p.deliveries}</td>
                  <td>{p.next ? fmtDate(new Date(p.next).toISOString()) : "—"}</td>
                  <td>{due(p.dueIn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
