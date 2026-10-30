"use client";

import { FixQuality } from "@/components/nws/FixQuality";
import "../ops.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { FleetMap } from "@/components/nws/FleetMap";
import type { LatLng, MapSite, MapTanker } from "@/components/nws/FleetMapView";
import { permitSummary, type FleetTanker } from "@/components/nws/fleetData";
import { ago, downloadTable, ExportButtons, Kpi, one, pct, St, Tabs, useNow, useRealtime, useRpc, SERVICE_NAME, HOUR } from "@/components/nws/ops";
import type { TableFormat } from "@/lib/csv";
import { fmtDate, fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { GeoFilter, useGeo } from "@/components/nws/register/geo";
import { STATUS_TEXT } from "@/components/OrderBits";
import { Loading } from "@/components/Shell";
import { orderNo } from "@/lib/format";
import { STALE_AFTER_S } from "@/lib/gps";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { OrderStatus } from "@/lib/types";

export default function FleetPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Fleet />
    </Suspense>
  );
}

type WaterTest = { cert_no: string; tested_at: string; passed: boolean };
type Device = { id: string; firmware: string; sensors: Record<string, boolean>; installed_at: string };
type Row = FleetTanker & {
  company_id: string | null;
  governorate_code: string | null; in_register: boolean; capacity_known: boolean;
  last_lat: number | null; last_lng: number | null; last_fix_at: string | null; last_accuracy_m: number | null; last_fix_source: string | null;
  company: { name: string } | { name: string }[] | null;
  water_tests: WaterTest[];
  device: Device | Device[] | null;
};
type Site = { id: string; code: string; kind: "fill" | "discharge"; name: string; lat: number; lng: number; radius_m: number };
type SourceEvent = { kind: string; verified: boolean; note: string; source: string; site_id: string | null; created_at: string };
type Trip = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: OrderStatus; tanker_plate: string | null; driver_name: string | null;
  created_at: string; filled_at: string | null; delivered_at: string | null; cancelled_at: string | null; fill_verified: boolean | null; discharge_verified: boolean | null;
  is_test: boolean;
  fill_site: { name: string } | { name: string }[] | null; discharge_site: { name: string } | { name: string }[] | null; source_events: SourceEvent[];
};
type Dialog = { kind: "block" | "unblock" | "unassign" | "assign"; tanker: FleetTanker } | null;
type Tab = "tankers" | "trips" | "ivms";
type Filter = "all" | ServiceType | "expired";

const TRIP_SELECT =
  "id, order_no, service_type, gallons, area, status, tanker_plate, driver_name, created_at, filled_at, delivered_at, cancelled_at, fill_verified, discharge_verified, is_test, fill_site:sites!orders_fill_site_id_fkey(name), discharge_site:sites!orders_discharge_site_id_fkey(name), source_events(kind, verified, note, source, site_id, created_at)";

const latestTest = (t: Row) => [...(t.water_tests ?? [])].sort((a, b) => b.tested_at.localeCompare(a.tested_at))[0] ?? null;

/** Fill or discharge verification for a trip: station/IVMS events first, then the order's own flag. */
function verification(t: Trip, kind: "fill" | "discharge"): { text: string; tone: string; note: string } | null {
  const ev = (t.source_events ?? []).filter((e) => e.kind === kind).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (ev) return { text: ev.verified ? "Verified" : "Mismatch", tone: ev.verified ? "ok" : "bad", note: ev.note || ev.source.toUpperCase() };
  const flag = kind === "fill" ? t.fill_verified : t.discharge_verified;
  if (flag == null) return null;
  return { text: flag ? "Verified" : "Mismatch", tone: flag ? "ok" : "bad", note: "" };
}

function Fleet() {
  const { can, toast } = useStaff();
  const params = useSearchParams();
  const now = useNow(5_000);
  const [tab, setTab] = useState<Tab>("tankers");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [registerCount, setRegisterCount] = useState<number | null>(null);
  const [geoF, setGeoF] = useState({ cluster: "", governorate: "" });
  const geo = useGeo();
  const [freeDrivers, setFreeDrivers] = useState<{ id: string; full_name: string; company_id: string | null }[]>([]);
  const [dlg, setDlg] = useState<Dialog>(null);
  const [driverPick, setDriverPick] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(params.get("tanker"));
  const [trail, setTrail] = useState<LatLng[] | null>(null);
  const [trailNote, setTrailNote] = useState("");
  const [tankerTrips, setTankerTrips] = useState<Trip[]>([]);
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [fixAcc, setFixAcc] = useState<number[]>([]);
  const isOperator = can("operator");
  const run = useRpc();

  const load = useCallback(async () => {
    const db = supabase();
    // Tankers registered on the platform only: the NWS register (~11,000 offline tankers with
    // no driver) is listed, paged, under Permits → Register.
    const [t, d, a, s, rc] = await Promise.all([
      db
        .from("tankers")
        .select(
          "id, plate, service_type, capacity_gal, capacity_known, governorate_code, in_register, company_id, is_online, blocked, blocked_reason, blocked_at, location_age_s, last_lat, last_lng, last_fix_at, last_accuracy_m, last_fix_source, company:companies(name), water_tests(cert_no, tested_at, passed), device:devices(id, firmware, sensors, installed_at), assignments:tanker_assignments(id, driver_id, assigned_at, unassigned_at, driver:profiles!tanker_assignments_driver_id_fkey(full_name, phone)), permits(id, permit_no, type, status, issued_at, expires_at)",
        )
        .eq("on_platform", true)
        .order("plate"),
      db.from("profiles").select("id, full_name, company_id").eq("role", "driver").order("full_name"),
      db.from("tanker_assignments").select("driver_id").is("unassigned_at", null),
      db.from("sites").select("id, code, kind, name, lat, lng, radius_m").eq("active", true).eq("is_test", false),
      db.from("tankers").select("id", { count: "exact", head: true }).eq("in_register", true),
    ]);
    setRegisterCount(rc.count ?? null);
    setRows((t.data ?? []) as unknown as Row[]);
    setSites((s.data ?? []) as Site[]);
    const busy = new Set((a.data ?? []).map((x) => x.driver_id));
    setFreeDrivers(((d.data ?? []) as { id: string; full_name: string; company_id: string | null }[]).filter((x) => !busy.has(x.id)));
  }, []);

  const loadTrips = useCallback(async () => {
    const db = supabase();
    const [o, g] = await Promise.all([
      db.from("orders").select(TRIP_SELECT).not("tanker_id", "is", null).order("created_at", { ascending: false }).limit(100),
      db.from("gps_fixes").select("accuracy_m").order("recorded_at", { ascending: false }).limit(1000),
    ]);
    setTrips((o.data ?? []) as unknown as Trip[]);
    setFixAcc(((g.data ?? []) as { accuracy_m: number | null }[]).map((x) => x.accuracy_m).filter((x): x is number => x != null));
  }, []);

  useEffect(() => {
    const first = setTimeout(() => {
      load();
      loadTrips();
    }, 0);
    return () => clearTimeout(first);
  }, [load, loadTrips]);
  useRealtime("nws-fleet", ["tankers"], load, 5000);

  // Route history and trip log of the selected tanker: last 2 h of fixes, else the latest 200.
  useEffect(() => {
    let live = true;
    const go = async () => {
      if (!sel) {
        setTrail(null);
        setTankerTrips([]);
        return;
      }
      const db = supabase();
      const since = new Date(Date.now() - 2 * HOUR).toISOString();
      const [recent, tr] = await Promise.all([
        db.from("gps_fixes").select("lat, lng, recorded_at").eq("tanker_id", sel).gte("recorded_at", since).order("recorded_at").limit(2000),
        db.from("orders").select(TRIP_SELECT).eq("tanker_id", sel).order("created_at", { ascending: false }).limit(8),
      ]);
      let fixes = (recent.data ?? []) as LatLng[];
      let note = "last 2 hours";
      if (fixes.length < 2) {
        const older = await db.from("gps_fixes").select("lat, lng, recorded_at").eq("tanker_id", sel).order("recorded_at", { ascending: false }).limit(200);
        fixes = ((older.data ?? []) as LatLng[]).reverse();
        note = "latest fixes (none in the last 2 hours)";
      }
      if (!live) return;
      setTrail(fixes.length ? fixes : null);
      setTrailNote(`${fixes.length} GPS fixes · ${note}`);
      setTankerTrips((tr.data ?? []) as unknown as Trip[]);
    };
    const t = setTimeout(go, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sel]);

  async function act(rpc: string, args: Record<string, unknown>, ok: string) {
    if (await run(rpc, args, ok)) {
      setDlg(null);
      load();
    }
  }

  const active = (t: FleetTanker) => t.assignments.find((a) => !a.unassigned_at) ?? null;
  const all = useMemo(() => rows ?? [], [rows]);
  const inGeo = (t: Row) =>
    (!geoF.governorate || t.governorate_code === geoF.governorate) &&
    (!geoF.cluster || (geoF.cluster === "none" ? !geo.clusterOf(t.governorate_code) : geo.clusterOf(t.governorate_code) === geoF.cluster));
  const list = all.filter((t) => {
    if (!inGeo(t)) return false;
    if (filter === "expired" ? permitSummary(t).valid : filter !== "all" && t.service_type !== filter) return false;
    const s = q.trim().toLowerCase();
    return !s || t.plate.toLowerCase().includes(s) || (one(t.company)?.name ?? "").toLowerCase().includes(s) || (active(t)?.driver?.full_name ?? "").toLowerCase().includes(s);
  });
  const selected = all.find((t) => t.id === sel) ?? null;
  const opTitle = isOperator ? undefined : "Control room operators only";
  const fixAge = (t: Row) => (t.last_fix_at ? (now - Date.parse(t.last_fix_at)) / 1000 : null);

  const mapTankers: MapTanker[] = useMemo(
    () =>
      selected && selected.last_lat != null && selected.last_lng != null
        ? [{ id: selected.id, lat: selected.last_lat, lng: selected.last_lng, type: selected.service_type, stale: false, blocked: selected.blocked, label: selected.plate }]
        : [],
    [selected],
  );
  const mapSites: MapSite[] = useMemo(() => sites.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, kind: s.kind, radius_m: s.radius_m, label: `${s.name} (${s.code})` })), [sites]);

  function exportTankers(fmt: TableFormat) {
    downloadTable("fleet-register", [
      ["Plate", "Service", "Capacity (gal)", "Governorate", "Cluster", "In NWS register", "Owner", "Driver", "Permit", "Water test", "IVMS device", "Accuracy (m)", "Last fix", "Status"],
      ...list.map((t) => {
        const w = latestTest(t);
        return [
          t.plate, SERVICE_NAME[t.service_type], t.capacity_known ? t.capacity_gal : "unknown", t.governorate_code ? geo.govName(t.governorate_code) : "",
          t.governorate_code ? geo.clusterName(geo.clusterOf(t.governorate_code)) : "", t.in_register ? "yes" : "no", one(t.company)?.name ?? "", active(t)?.driver?.full_name ?? "", permitSummary(t).text,
          w ? `${w.cert_no} ${w.tested_at} ${w.passed ? "passed" : "failed"}` : "", one(t.device)?.id ?? "", t.last_accuracy_m?.toFixed(1) ?? "", t.last_fix_at ?? "",
          t.blocked ? "Suspended" : "Active",
        ];
      }),
    ], fmt);
  }
  function exportTrips(rs: Trip[], name: string, fmt: TableFormat = "csv") {
    downloadTable(name, [
      ["Order", "Created", "Tanker", "Driver", "Service", "Gallons", "Area", "Status", "Fill site", "Fill check", "Discharge site", "Discharge check", "Completed"],
      ...rs.map((t) => [
        orderNo(t.order_no), t.created_at, t.tanker_plate ?? "", t.driver_name ?? "", t.service_type, t.gallons, t.area, STATUS_TEXT[t.status][0],
        one(t.fill_site)?.name ?? "", verification(t, "fill")?.text ?? "", one(t.discharge_site)?.name ?? "", verification(t, "discharge")?.text ?? "", t.delivered_at ?? t.cancelled_at ?? "",
      ]),
    ], fmt);
  }

  // Chip counts follow the cluster / governorate filter.
  const here = all.filter(inGeo);
  const counts = {
    all: here.length,
    DW: here.filter((t) => t.service_type === "DW").length,
    WW: here.filter((t) => t.service_type === "WW").length,
    TE: here.filter((t) => t.service_type === "TE").length,
    expired: here.filter((t) => !permitSummary(t).valid).length,
  };
  const devices = all.filter((t) => one(t.device));
  const reporting = devices.filter((t) => {
    const a = fixAge(t);
    return a != null && a < 300;
  });
  const accs = all.map((t) => t.last_accuracy_m).filter((x): x is number => x != null);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Fleet</h1>
          <p>Every tanker registered on the platform with its permit, water-quality and IVMS status, plus trip logs and route history. Operators can suspend a tanker and override driver assignment. Tankers in the NWS register that aren’t on the platform yet are under Permits → Register.</p>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["tankers", "Tankers", all.length],
          ["trips", "Trip logs"],
          ["ivms", "IVMS devices", devices.length],
        ]}
      />

      {tab === "tankers" && (
        <>
          <div className="okpis">
            <Kpi label="Registered on platform" value={all.length} sub={`${all.filter((t) => t.is_online).length} online now`} tone="ok" />
            <Kpi label="In NWS register" value={registerCount == null ? "…" : registerCount.toLocaleString()} sub={<Link className="lk" href="/nws/permits?tab=reg">{all.filter((t) => t.in_register).length} of them on the platform · open the register</Link>} />
            <Kpi label="Suspended" value={all.filter((t) => t.blocked).length} sub="blocked by an operator" tone={all.some((t) => t.blocked) ? "bad" : ""} />
            <Kpi label="No valid permit" value={counts.expired} sub="can’t go online or take jobs" tone={counts.expired ? "warn" : ""} />
            <Kpi label="Unassigned" value={all.filter((t) => !active(t)).length} sub="no driver on the tanker" />
          </div>
          <div className="panel">
            <div className="toolbar">
              <div className="chips">
                {(
                  [
                    ["all", "All"],
                    ["DW", "Drinking water"],
                    ["WW", "Wastewater"],
                    ["TE", "Treated effluent"],
                    ["expired", "No valid permit"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                    {l}
                    <span className="tc">{counts[k]}</span>
                  </button>
                ))}
              </div>
              <div className="filters">
                <GeoFilter geo={geo} cluster={geoF.cluster} governorate={geoF.governorate} onChange={setGeoF} />
                <input className="in" placeholder="Plate, owner or driver" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tankers" style={{ width: 200 }} />
                <ExportButtons onExport={exportTankers} disabled={!list.length} />
              </div>
            </div>
            {!isOperator && <p className="note" style={{ paddingTop: 0 }}>Read-only: suspend and assignment actions are for control room operators.</p>}
            <div className="tblwrap" style={{ maxHeight: 460, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Plate</th>
                    <th>Owner</th>
                    <th>Governorate</th>
                    <th>Driver</th>
                    <th>Service</th>
                    <th>Permit</th>
                    <th>Water test</th>
                    <th className="num">Last fix (source, accuracy)</th>
                    <th>Last fix</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!rows && (
                    <tr><td colSpan={11} className="empty">Loading…</td></tr>
                  )}
                  {rows && list.length === 0 && (
                    <tr><td colSpan={11} className="empty">No tankers match.</td></tr>
                  )}
                  {list.map((t) => {
                    const a = active(t);
                    const p = permitSummary(t);
                    const w = latestTest(t);
                    const age = fixAge(t);
                    const stale = t.is_online && (age == null || age > STALE_AFTER_S);
                    return (
                      <tr key={t.id} className={`click ${sel === t.id ? "sel" : ""}`} onClick={() => setSel(sel === t.id ? null : t.id)}>
                        <td className={`stripe ${t.service_type}`}>
                          <b>{t.plate}</b>
                          <small style={{ display: "block" }}>{t.capacity_known ? `${t.capacity_gal.toLocaleString()} gal` : "capacity unknown"}</small>
                        </td>
                        <td>{one(t.company)?.name ?? <span className="mut">Independent</span>}</td>
                        <td>
                          {t.governorate_code ? geo.govName(t.governorate_code) : <span className="mut">Not set</span>}
                          {t.governorate_code && <small style={{ display: "block" }}>{geo.clusterName(geo.clusterOf(t.governorate_code))}</small>}
                        </td>
                        <td>{a?.driver?.full_name ?? <span className="mut">Unassigned</span>}</td>
                        <td><span className={`tag ${t.service_type}`}>{SERVICE_NAME[t.service_type]}</span></td>
                        <td><St tone={p.tone}>{p.text}</St></td>
                        <td>
                          {t.service_type !== "DW" ? (
                            <span className="mut">—</span>
                          ) : w ? (
                            <>
                              <St tone={w.passed ? "ok" : "bad"}>{w.passed ? "Passed" : "Failed"}</St>
                              <small style={{ display: "block" }}>{w.cert_no} · {fmtDate(w.tested_at)}</small>
                            </>
                          ) : (
                            <St tone="warn">No test</St>
                          )}
                        </td>
                        <td className="num"><FixQuality source={t.last_fix_source} accuracy={t.last_accuracy_m} /></td>
                        <td>
                          {t.last_fix_at ? ago(t.last_fix_at, now) : <span className="mut">No fix</span>}
                          {stale ? <small style={{ display: "block", color: "var(--bad)" }}>stale while online</small> : <small style={{ display: "block" }}>{t.is_online ? "online" : "offline"}</small>}
                        </td>
                        <td>
                          {t.blocked ? (
                            <>
                              <St tone="bad">Suspended</St>
                              <small style={{ display: "block" }} title={t.blocked_reason ?? ""}>{t.blocked_reason}</small>
                            </>
                          ) : (
                            <St tone="ok">Active</St>
                          )}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="btns" style={{ flexWrap: "nowrap" }}>
                            {t.blocked ? (
                              <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unblock", tanker: t })}>Reinstate</button>
                            ) : (
                              <button className="btn sm bad" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "block", tanker: t })}>Suspend</button>
                            )}
                            {a ? (
                              <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unassign", tanker: t })}>Unassign</button>
                            ) : (
                              <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => { setDriverPick(""); setDlg({ kind: "assign", tanker: t }); }}>Assign</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows && !selected && <p className="note">Select a tanker to see its route history and trip log.</p>}
          </div>

          {selected && (
            <div className="grid2">
              <div className="panel">
                <h2>
                  Route history — {selected.plate} <small>{trailNote}</small>
                </h2>
                <div className="pad">
                  <div className="minimap" style={{ height: 340 }}>
                    <FleetMap tankers={mapTankers} orders={[]} sites={mapSites} trail={trail} selectedId={selected.id} />
                  </div>
                  {!trail && <p className="mut" style={{ margin: "0 0 8px", fontSize: 13 }}>No GPS history recorded for this tanker yet.</p>}
                  <div className="legend2">
                    <span><i style={{ background: "#17b3c6" }} />Route</span>
                    <span><i style={{ background: "#3B82F6" }} />Filling station geofence</span>
                    <span><i style={{ background: "#C08E35" }} />Approved discharge geofence</span>
                  </div>
                </div>
              </div>
              <div className="panel">
                <h2>
                  Trip log <small>{selected.plate} · latest {tankerTrips.length}</small>
                </h2>
                <div className="tblwrap">
                  <table>
                    <thead>
                      <tr><th>Order</th><th>Fill</th><th>Discharge / delivery</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {tankerTrips.length === 0 && <tr><td colSpan={4} className="empty">No trips yet.</td></tr>}
                      {tankerTrips.map((t) => (
                        <TripCells key={t.id} t={t} compact />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pad btns" style={{ paddingTop: 12 }}>
                  {selected.blocked ? (
                    <button className="btn" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unblock", tanker: selected })}>Reinstate tanker</button>
                  ) : (
                    <button className="btn bad" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "block", tanker: selected })}>Suspend tanker</button>
                  )}
                  <button className="btn" disabled={!tankerTrips.length} onClick={() => exportTrips(tankerTrips, `trips-${selected.plate}`)}>Export trips</button>
                  <Link className="btn" href={`/nws/permits?tab=apps&tanker=${selected.id}`}>Permits</Link>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "trips" && (
        <div className="panel">
          <div className="toolbar">
            <span className="mut" style={{ fontSize: 13 }}>Latest {trips?.length ?? 0} trips across the fleet, with station (TFS) and IVMS fill / discharge verification</span>
            <ExportButtons disabled={!trips?.length} onExport={(f) => trips && exportTrips(trips, "trip-logs", f)} />
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Order</th><th>Tanker</th><th>Service</th><th className="num">Gallons</th><th>Fill</th><th>Discharge / delivery</th><th>Status</th></tr>
              </thead>
              <tbody>
                {!trips && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
                {trips?.length === 0 && <tr><td colSpan={7} className="empty">No trips yet.</td></tr>}
                {trips?.map((t) => (
                  <TripCells key={t.id} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "ivms" && (
        <>
          <div className="okpis">
            <Kpi label="IVMS devices" value={devices.length} sub={`${all.length - devices.length} tankers without a device`} tone={all.length - devices.length ? "warn" : ""} />
            <Kpi label="Reporting now" value={reporting.length} sub="fix in the last 5 minutes" tone="ok" />
            <Kpi label="Average accuracy" value={accs.length ? `±${(accs.reduce((a, b) => a + b, 0) / accs.length).toFixed(1)} m` : "—"} sub="last fix of each tanker" />
            <Kpi label="Fixes within ±10 m" value={pct(fixAcc.filter((x) => x <= 10).length, fixAcc.length)} sub={`of the latest ${fixAcc.length.toLocaleString()} fixes`} />
          </div>
          <div className="panel">
            <h2>IVMS devices</h2>
            <div className="tblwrap">
              <table>
                <thead>
                  <tr><th>Device</th><th>Tanker</th><th>Firmware</th><th>Installed</th><th>Last fix</th><th className="num">Accuracy</th><th>Signal</th><th>Sensors</th></tr>
                </thead>
                <tbody>
                  {devices.length === 0 && <tr><td colSpan={8} className="empty">No devices registered.</td></tr>}
                  {devices.map((t) => {
                    const d = one(t.device)!;
                    const a = fixAge(t);
                    const sig = a == null ? ["No fix", "bad"] : a < 60 ? ["Good", "ok"] : a < 300 ? ["Weak", "warn"] : ["Lost", "bad"];
                    const sensors = Object.entries(d.sensors ?? {}).filter(([, v]) => v).map(([k]) => k.replace("_", " "));
                    return (
                      <tr key={d.id}>
                        <td><b>{d.id}</b></td>
                        <td>{t.plate} <span className={`tag ${t.service_type}`}>{t.service_type}</span></td>
                        <td>{d.firmware}</td>
                        <td>{fmtDate(d.installed_at)}</td>
                        <td>{t.last_fix_at ? ago(t.last_fix_at, now) : "—"}</td>
                        <td className="num"><FixQuality source={t.last_fix_source} accuracy={t.last_accuracy_m} /></td>
                        <td><St tone={sig[1]}>{sig[0]}</St></td>
                        <td><small>{sensors.join(", ") || "—"}</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note">Devices buffer fixes during network dropouts and upload on reconnect. Signal is derived from the age of the last fix (Good under 60 s, Weak under 5 min). IVMS integration is simulated until the interface spec is confirmed.</p>
          </div>
        </>
      )}

      {dlg?.kind === "block" && (
        <ReasonDialog
          title={`Suspend ${dlg.tanker.plate}`}
          body="The tanker goes offline immediately and can’t go online or accept jobs until it is reinstated."
          confirm="Suspend tanker"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_block_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, `${dlg.tanker.plate} suspended`)}
        />
      )}
      {dlg?.kind === "unblock" && (
        <ReasonDialog
          title={`Reinstate ${dlg.tanker.plate}`}
          body="The driver can go online again (if the tanker has a valid permit)."
          confirm="Reinstate"
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_unblock_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, `${dlg.tanker.plate} reinstated`)}
        />
      )}
      {dlg?.kind === "unassign" && (
        <ReasonDialog
          title={`Unassign ${dlg.tanker.plate}`}
          body={`Removes ${active(dlg.tanker)?.driver?.full_name ?? "the driver"} from this tanker and takes it offline. Refused while the tanker is on a job.`}
          confirm="Unassign"
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_unassign_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, `${dlg.tanker.plate} unassigned`)}
        />
      )}
      {dlg?.kind === "assign" && (
        <ReasonDialog
          title={`Assign a driver to ${dlg.tanker.plate}`}
          body="NWS override. Only drivers of this tanker's company without a tanker are listed."
          confirm="Assign"
          extra={
            <div className="fld">
              <label htmlFor="drv">Driver</label>
              <select id="drv" className="in" value={driverPick} onChange={(e) => setDriverPick(e.target.value)}>
                <option value="">Choose a driver…</option>
                {freeDrivers.filter((d) => d.company_id === dlg.tanker.company_id).map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name || d.id}</option>
                ))}
              </select>
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={(reason) =>
            driverPick
              ? act("staff_assign_tanker", { p_driver_id: driverPick, p_tanker_id: dlg.tanker.id, p_reason: reason }, `Driver assigned to ${dlg.tanker.plate}`)
              : toast("Choose a driver first", true)
          }
        />
      )}
    </>
  );
}

function Check({ v, site }: { v: ReturnType<typeof verification>; site: string | null }) {
  if (!v) return <span className="mut">{site ?? "—"}</span>;
  return (
    <>
      <St tone={v.tone}>{v.text}</St>
      <small style={{ display: "block" }}>{[site, v.note].filter(Boolean).join(" · ")}</small>
    </>
  );
}

function TripCells({ t, compact }: { t: Trip; compact?: boolean }) {
  const end = t.delivered_at ?? t.cancelled_at;
  return (
    <tr>
      <td className={`stripe ${t.service_type}`}>
        <Link className="lk" href={`/nws/orders/${t.id}`}>{orderNo(t.order_no)}</Link>
        {t.is_test && <span className="st warn ptag" title="Test zone trip">TEST</span>}
        <small style={{ display: "block" }}>{fmtDateTime(t.created_at)}</small>
      </td>
      {!compact && (
        <>
          <td>
            {t.tanker_plate ?? "—"}
            <small style={{ display: "block" }}>{t.driver_name ?? ""}</small>
          </td>
          <td><span className={`tag ${t.service_type}`}>{t.service_type}</span></td>
          <td className="num">{t.gallons.toLocaleString()}</td>
        </>
      )}
      <td>{t.service_type === "WW" ? <span className="mut">n/a</span> : <Check v={verification(t, "fill")} site={one(t.fill_site)?.name ?? null} />}</td>
      <td>
        {t.service_type === "WW" ? (
          <Check v={verification(t, "discharge")} site={one(t.discharge_site)?.name ?? null} />
        ) : (
          <span>
            {t.area}
            <small style={{ display: "block" }}>{t.gallons.toLocaleString()} gal</small>
          </span>
        )}
      </td>
      <td>
        <St tone={STATUS_TEXT[t.status][1]}>{STATUS_TEXT[t.status][0]}</St>
        {end && <small style={{ display: "block" }}>{fmtDateTime(end)}</small>}
      </td>
    </tr>
  );
}
