"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { dayKey, downloadCsv, Empty, fetchPaged, groupBy, omr, sinceIso, useRun } from "@/components/nws/admin/ui";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { CHANNEL_LABEL, companyName, ORDER_COLS, RANGES, ROW_CAP, zoneName, type ORow, type Ref } from "./data";

type Dataset = "Orders" | "Revenue" | "Complaints" | "Ratings" | "Fleet" | "Payments";
type Group = "day" | "service" | "zone" | "company" | "category" | "channel";
type Fmt = "csv" | "xlsx" | "pdf";
type Scheduled = { id: string; name: string; dataset: string; group_by: string; cadence: string; format: string; recipients: string; created_at: string };

const DATASETS: Dataset[] = ["Orders", "Revenue", "Complaints", "Ratings", "Fleet", "Payments"];
const GROUPS: Record<Dataset, Group[]> = {
  Orders: ["day", "service", "zone", "company", "channel"],
  Revenue: ["day", "service", "zone", "company", "channel"],
  Complaints: ["day", "category", "channel"],
  Ratings: ["day", "service", "zone", "company", "channel"],
  Fleet: ["service", "company"],
  Payments: ["day", "channel", "category"],
};
const groupLabel = (ds: Dataset, g: Group) =>
  ds === "Payments" && g === "channel" ? "Method" : ds === "Payments" && g === "category" ? "Status" : { day: "Day", service: "Service", zone: "Zone", company: "Company", category: "Category", channel: "Channel" }[g];
const COLUMNS: Record<Dataset, string[]> = {
  Orders: ["Orders", "Delivered", "Cancelled", "Gallons"],
  Revenue: ["Delivered orders", "Water (OMR)", "Delivery fees (OMR)", "VAT (OMR)", "Total (OMR)"],
  Complaints: ["Cases", "Open", "Resolved", "Refunds (OMR)"],
  Ratings: ["Ratings", "Average", "1–2 stars"],
  Fleet: ["Tankers", "Online", "Blocked", "Trips in range"],
  Payments: ["Payments", "Amount (OMR)", "Failed", "Refunded (OMR)"],
};
// Columns shown with 3 decimals (OMR) or 2 (averages).
const decimals = (ds: Dataset, i: number) => (COLUMNS[ds][i].includes("OMR") ? 3 : ds === "Ratings" && i === 1 ? 2 : 0);
const METHOD: Record<string, string> = { wallet: "Wallet", card: "Card", omannet: "OmanNet", wallet_card: "Wallet + card", account: "On account", cash: "Cash" };

type Raw =
  | { ds: "Orders" | "Revenue" | "Ratings"; rows: (ORow & { water_charge: string; delivery_fee: string; vat: string })[] }
  | { ds: "Complaints"; rows: { created_at: string; category: string; channel: string; state: string; refund_amount: string }[]; labels: Map<string, string> }
  | { ds: "Fleet"; rows: { id: string; service_type: ServiceType; company_id: string | null; is_online: boolean; blocked: boolean }[]; trips: Map<string, number> }
  | { ds: "Payments"; rows: { created_at: string; method: string; status: string; amount: string; refunded_amount: string }[] };

async function load(ds: Dataset, days: number): Promise<{ raw: Raw | null; error: { message?: string } | null }> {
  const db = supabase();
  const from = sinceIso(days);
  if (ds === "Orders" || ds === "Revenue" || ds === "Ratings") {
    const { rows, error } = await fetchPaged<ORow & { water_charge: string; delivery_fee: string; vat: string }>((a, b) => {
      const q = db.from("orders").select(`${ORDER_COLS}, water_charge, delivery_fee, vat`);
      const f = ds === "Revenue" ? q.eq("status", "delivered").gte("delivered_at", from) : ds === "Ratings" ? q.not("rating", "is", null).gte("rated_at", from) : q.gte("created_at", from);
      return f.order("id").range(a, b);
    }, ROW_CAP);
    return { raw: { ds, rows }, error };
  }
  if (ds === "Complaints") {
    const [c, sla] = await Promise.all([
      fetchPaged<{ created_at: string; category: string; channel: string; state: string; refund_amount: string }>((a, b) => db.from("complaints").select("created_at, category, channel, state, refund_amount").gte("created_at", from).order("id").range(a, b), ROW_CAP),
      db.from("complaint_sla").select("category, label"),
    ]);
    return { raw: { ds, rows: c.rows, labels: new Map((sla.data ?? []).map((r: { category: string; label: string }) => [r.category, r.label])) }, error: c.error };
  }
  if (ds === "Fleet") {
    const [t, o] = await Promise.all([
      fetchPaged<{ id: string; service_type: ServiceType; company_id: string | null; is_online: boolean; blocked: boolean }>((a, b) => db.from("tankers").select("id, service_type, company_id, is_online, blocked").order("id").range(a, b), ROW_CAP),
      fetchPaged<{ tanker_id: string | null }>((a, b) => db.from("orders").select("tanker_id").eq("status", "delivered").gte("delivered_at", from).order("id").range(a, b), ROW_CAP),
    ]);
    const trips = new Map<string, number>();
    for (const r of o.rows) if (r.tanker_id) trips.set(r.tanker_id, (trips.get(r.tanker_id) ?? 0) + 1);
    return { raw: { ds, rows: t.rows, trips }, error: t.error };
  }
  const { rows, error } = await fetchPaged<{ created_at: string; method: string; status: string; amount: string; refunded_amount: string }>((a, b) => db.from("payments").select("created_at, method, status, amount, refunded_amount").gte("created_at", from).order("id").range(a, b), ROW_CAP);
  return { raw: { ds, rows }, error };
}

/** Group the raw rows into [label, ...metrics] lines. */
function aggregate(raw: Raw, g: Group, ref: Ref | null): [string, number[]][] {
  const out = (m: Map<string, number[]>, fin?: (v: number[]) => number[]) => [...m].map(([k, v]) => [k, fin ? fin(v) : v] as [string, number[]]);
  const key = (o: { created_at?: string; service_type?: ServiceType; zone_id?: string | null; tanker_id?: string | null; channel?: string }) =>
    g === "day" ? dayKey(o.created_at!) : g === "service" ? SERVICE_LABEL[o.service_type!] : g === "zone" ? zoneName(ref, o.zone_id ?? null)
      : g === "company" ? companyName(ref, o.tanker_id ?? null) : CHANNEL_LABEL[o.channel ?? ""] ?? o.channel ?? "—";
  switch (raw.ds) {
    case "Orders":
      return out(groupBy(raw.rows, key, () => [0, 0, 0, 0], (a, o) => { a[0]++; if (o.status === "delivered") a[1]++; if (o.status === "cancelled") a[2]++; a[3] += o.gallons; }));
    case "Revenue":
      return out(groupBy(raw.rows, (o) => key({ ...o, created_at: o.delivered_at ?? o.created_at }), () => [0, 0, 0, 0, 0], (a, o) => {
        a[0]++; a[1] += Number(o.water_charge); a[2] += Number(o.delivery_fee); a[3] += Number(o.vat); a[4] += Number(o.total);
      }));
    case "Ratings":
      return out(groupBy(raw.rows, (o) => key({ ...o, created_at: o.rated_at ?? o.created_at }), () => [0, 0, 0], (a, o) => { a[0]++; a[1] += o.rating!; if (o.rating! <= 2) a[2]++; }), (v) => [v[0], v[0] ? v[1] / v[0] : 0, v[2]]);
    case "Complaints":
      return out(groupBy(raw.rows, (c) => (g === "category" ? (raw.labels.get(c.category) ?? c.category) : g === "day" ? dayKey(c.created_at) : CHANNEL_LABEL[c.channel] ?? c.channel), () => [0, 0, 0, 0], (a, c) => {
        a[0]++; if (c.state === "resolved") a[2]++; else a[1]++; a[3] += Number(c.refund_amount);
      }));
    case "Fleet":
      return out(groupBy(raw.rows, (t) => (g === "service" ? SERVICE_LABEL[t.service_type] : t.company_id ? (ref?.companies.get(t.company_id) ?? "Unknown company") : "Independent"), () => [0, 0, 0, 0], (a, t) => {
        a[0]++; if (t.is_online) a[1]++; if (t.blocked) a[2]++; a[3] += raw.trips.get(t.id) ?? 0;
      }));
    case "Payments":
      return out(groupBy(raw.rows, (p) => (g === "day" ? dayKey(p.created_at) : g === "channel" ? (METHOD[p.method] ?? p.method) : p.status.replace("_", " ")), () => [0, 0, 0, 0], (a, p) => {
        a[0]++; if (p.status !== "failed") a[1] += Number(p.amount); if (p.status === "failed") a[2]++; a[3] += Number(p.refunded_amount);
      }));
  }
}

export default function Builder({ refData }: { refData: Ref | null }) {
  const { toast } = useStaff();
  const run = useRun();
  const [ds, setDs] = useState<Dataset>("Orders");
  const [group, setGroup] = useState<Group>("zone");
  const [range, setRange] = useState("30");
  const [fmt, setFmt] = useState<Fmt>("csv");
  const [raw, setRaw] = useState<Raw | null>(null);
  const [cadence, setCadence] = useState("weekly");
  const [recipients, setRecipients] = useState("");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<Scheduled[] | null>(null);

  useEffect(() => {
    let live = true;
    load(ds, Number(range)).then(({ raw: r, error }) => {
      if (!live) return;
      if (error) toast(friendlyError(error), true);
      setRaw(r);
    });
    return () => { live = false; };
  }, [ds, range, toast]);

  const loadSaved = useCallback(() => {
    supabase().from("scheduled_reports").select("*").order("created_at", { ascending: false }).then(({ data }) => setSaved((data ?? []) as Scheduled[]));
  }, []);
  useEffect(loadSaved, [loadSaved]);

  const g = GROUPS[ds].includes(group) ? group : GROUPS[ds][0];
  const lines = useMemo(() => {
    if (!raw || raw.ds !== ds) return null;
    const l = aggregate(raw, g, refData);
    return g === "day" ? l.sort((a, b) => a[0].localeCompare(b[0])) : l.sort((a, b) => b[1][0] - a[1][0]);
  }, [raw, ds, g, refData]);
  const totals = lines ? COLUMNS[ds].map((_, i) => (ds === "Ratings" && i === 1 ? (() => { const n = lines.reduce((a, l) => a + l[1][0], 0); return n ? lines.reduce((a, l) => a + l[1][1] * l[1][0], 0) / n : 0; })() : lines.reduce((a, l) => a + l[1][i], 0))) : [];
  const cell = (v: number, i: number) => (decimals(ds, i) === 3 ? omr(v) : decimals(ds, i) === 2 ? v.toFixed(2) : v.toLocaleString());
  const title = `${ds} by ${groupLabel(ds, g).toLowerCase()}`;
  const rangeLabel = RANGES.find((r) => r[0] === range)?.[1] ?? "";

  function exportNow() {
    if (!lines) return;
    if (fmt !== "csv") return toast("Scheduled exports only (simulated) — XLSX and PDF are produced by scheduled reports.");
    downloadCsv(`${title} ${rangeLabel}`, [[groupLabel(ds, g), ...COLUMNS[ds]], ...lines.map(([k, v]) => [k, ...v.map((x, i) => (decimals(ds, i) ? x.toFixed(decimals(ds, i)) : x))]), ["Total", ...totals.map((x, i) => (decimals(ds, i) ? x.toFixed(decimals(ds, i)) : x))]]);
    toast("CSV downloaded");
  }

  async function schedule() {
    const ok = await run(supabase().rpc("staff_save_scheduled_report", { p_name: name.trim() || title, p_dataset: ds, p_group_by: g, p_cadence: cadence, p_format: fmt, p_recipients: recipients.trim() }), "Report scheduled");
    if (ok) { setName(""); loadSaved(); }
  }

  return (
    <div className="wide">
      <div className="panel">
        <h2>Report builder</h2>
        <div className="pad">
          <div className="form">
            <div className="fld">
              <label htmlFor="rb-ds">Dataset</label>
              <select id="rb-ds" className="in" value={ds} onChange={(e) => { setRaw(null); setDs(e.target.value as Dataset); }}>
                {DATASETS.map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="rb-range">Date range</label>
              <select id="rb-range" className="in" value={range} onChange={(e) => setRange(e.target.value)}>
                {[["1", "Today"], ...RANGES].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="rb-grp">Group by</label>
              <select id="rb-grp" className="in" value={g} onChange={(e) => setGroup(e.target.value as Group)}>
                {GROUPS[ds].map((x) => <option key={x} value={x}>{groupLabel(ds, x)}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="rb-fmt">Format</label>
              <select id="rb-fmt" className="in" value={fmt} onChange={(e) => setFmt(e.target.value as Fmt)}>
                <option value="csv">CSV</option>
                <option value="xlsx">XLSX</option>
                <option value="pdf">PDF</option>
              </select>
            </div>
          </div>
          <h3 className="preview-h">Preview — {title}, {rangeLabel.toLowerCase()}{ds === "Fleet" ? " (fleet as of now; trips in range)" : ""}</h3>
          <div className="tblwrap scroll">
            <table>
              <thead>
                <tr><th>{groupLabel(ds, g)}</th>{COLUMNS[ds].map((c) => <th key={c} className="num">{c}</th>)}</tr>
              </thead>
              <tbody>
                {!lines && <Empty cols={COLUMNS[ds].length + 1}>Loading…</Empty>}
                {lines?.length === 0 && <Empty cols={COLUMNS[ds].length + 1}>No rows in this range.</Empty>}
                {lines?.map(([k, v]) => (
                  <tr key={k}>
                    <td>{g === "day" ? new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : k}</td>
                    {v.map((x, i) => <td key={i} className="num">{cell(x, i)}</td>)}
                  </tr>
                ))}
                {lines && lines.length > 1 && (
                  <tr>
                    <td><b>Total</b></td>
                    {totals.map((x, i) => <td key={i} className="num"><b>{cell(x, i)}</b></td>)}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="btns" style={{ marginTop: 12 }}>
            <button className="btn pri" onClick={exportNow} disabled={!lines?.length}>Export {fmt.toUpperCase()}</button>
            {fmt !== "csv" && <span className="mut" style={{ fontSize: 12.5, alignSelf: "center" }}>Scheduled exports only (simulated)</span>}
          </div>

          <h3 className="preview-h">Schedule</h3>
          <div className="form">
            <div className="fld">
              <label htmlFor="rb-name">Report name</label>
              <input id="rb-name" className="in" placeholder={title} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <div className="fld">
              <label htmlFor="rb-cad">Cadence</label>
              <select id="rb-cad" className="in" value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value="daily">Daily 06:00</option>
                <option value="weekly">Weekly, Sunday</option>
                <option value="monthly">Monthly, 1st</option>
              </select>
            </div>
            <div className="fld" style={{ gridColumn: "span 2" }}>
              <label htmlFor="rb-to">Recipients</label>
              <input id="rb-to" className="in" placeholder="ops@nws.com.om, bi@nws.com.om" value={recipients} onChange={(e) => setRecipients(e.target.value)} />
            </div>
          </div>
          <div className="btns" style={{ marginTop: 12 }}>
            <button className="btn" onClick={schedule}>Save and schedule</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Scheduled reports</h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>Report</th><th>Format</th><th>Schedule</th></tr></thead>
            <tbody>
              {!saved && <Empty cols={3}>Loading…</Empty>}
              {saved?.length === 0 && <Empty cols={3}>No scheduled reports yet.</Empty>}
              {saved?.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}<small style={{ display: "block" }}>{r.recipients || "No recipients"} · {fmtDateTime(r.created_at)}</small></td>
                  <td>{r.format.toUpperCase()}</td>
                  <td style={{ textTransform: "capitalize" }}>{r.cadence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">NWS staff with report rights can build and schedule reports in the web interface. Delivery of scheduled files is simulated; the BI warehouse also receives nightly extracts.</p>
      </div>
    </div>
  );
}
