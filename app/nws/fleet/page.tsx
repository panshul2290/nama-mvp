"use client";

import { FixQuality } from "@/components/nws/FixQuality";
import "../ops.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { FleetMap } from "@/components/nws/FleetMap";
import type { LatLng, MapSite, MapTanker } from "@/components/nws/FleetMapView";
import { permitSummary, type FleetTanker } from "@/components/nws/fleetData";
import { downloadTable, ExportButtons, Kpi, one, St, Tabs, useNow, useRealtime, useRpc, SERVICE_NAME, HOUR } from "@/components/nws/ops";
import type { TableFormat } from "@/lib/csv";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { FLEET } from "@/components/nws/i18n/fleet";
import { TierPill, useDriverTiers, VehiclePanel } from "@/components/nws/VehiclePanel";
import { useFmt, type Fmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { GeoFilter, useGeo } from "@/components/nws/register/geo";
import { STATUS_TEXT, statusText } from "@/components/OrderBits";
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

type Tr = (key: string, vars?: Record<string, string | number>) => string;
const PERMIT_KEY: Record<string, string> = { "Pending review": "pPending", Expired: "pExpired", Rejected: "pRejected", "Wrong service type": "pWrongType", "No permit": "pNone" };

/** permitSummary() text (English, also used by exports) in the portal language. */
function permitText(t: FleetTanker, p: ReturnType<typeof permitSummary>, tr: Tr, f: Fmt) {
  const m = /^Expires in (\d+) day/.exec(p.text);
  if (m) return Number(m[1]) === 1 ? tr("pExpiresIn1") : tr("pExpiresIn", { n: f.n(Number(m[1])) });
  if (p.text.startsWith("Valid to ")) {
    const v = [...t.permits].filter((x) => x.status === "approved" && x.type === t.service_type && Date.parse(x.expires_at) > Date.now()).sort((a, b) => b.expires_at.localeCompare(a.expires_at))[0];
    return tr("pValidTo", { date: f.date(v?.expires_at) });
  }
  return PERMIT_KEY[p.text] ? tr(PERMIT_KEY[p.text]) : p.text;
}

function Fleet() {
  const { can, toast } = useStaff();
  const t = useT(FLEET);
  const f = useFmt();
  const { lang } = useLang();
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
  const tiers = useDriverTiers();
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
          "id, plate, service_type, capacity_gal, capacity_known, governorate_code, in_register, company_id, is_online, blocked, blocked_reason, blocked_at, location_age_s, last_lat, last_lng, last_fix_at, last_accuracy_m, last_fix_source, company:companies(name), water_tests(cert_no, tested_at, passed), device:devices(id, firmware, sensors, installed_at), assignments:tanker_assignments(id, driver_id, assigned_at, unassigned_at, driver:profiles!tanker_assignments_driver_id_fkey(full_name, phone:phone_masked)), permits(id, permit_no, type, status, issued_at, expires_at)",
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
      let note = "trail2h";
      if (fixes.length < 2) {
        const older = await db.from("gps_fixes").select("lat, lng, recorded_at").eq("tanker_id", sel).order("recorded_at", { ascending: false }).limit(200);
        fixes = ((older.data ?? []) as LatLng[]).reverse();
        note = "trailOlder";
      }
      if (!live) return;
      setTrail(fixes.length ? fixes : null);
      setTrailNote(JSON.stringify([fixes.length, note]));
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
  const opTitle = isOperator ? undefined : t("opOnly");
  const trailText = (() => {
    if (!trailNote) return "";
    const [n, note] = JSON.parse(trailNote) as [number, string];
    return t("trailN", { n: f.n(n), note: t(note) });
  })();
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
          <h1>{t("title")}</h1>
          <p>{t("intro")}</p>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["tankers", t("tabTankers"), all.length],
          ["trips", t("tabTrips")],
          ["ivms", t("tabIvms"), devices.length],
        ]}
      />

      {tab === "tankers" && (
        <>
          <div className="okpis">
            <Kpi label={t("kRegistered")} value={f.n(all.length)} sub={t("kOnlineNow", { n: f.n(all.filter((x) => x.is_online).length) })} tone="ok" />
            <Kpi label={t("kInRegister")} value={registerCount == null ? "…" : f.n(registerCount)} sub={<Link className="lk" href="/nws/permits?tab=reg">{t("kInRegisterSub", { n: f.n(all.filter((x) => x.in_register).length) })}</Link>} />
            <Kpi label={t("kSuspended")} value={f.n(all.filter((x) => x.blocked).length)} sub={t("kSuspendedSub")} tone={all.some((x) => x.blocked) ? "bad" : ""} />
            <Kpi label={t("kNoPermit")} value={f.n(counts.expired)} sub={t("kNoPermitSub")} tone={counts.expired ? "warn" : ""} />
            <Kpi label={t("kUnassigned")} value={f.n(all.filter((x) => !active(x)).length)} sub={t("kUnassignedSub")} />
          </div>
          <div className="panel">
            <div className="toolbar">
              <div className="chips">
                {(
                  [
                    ["all", t("fAll")],
                    ["DW", label("svc", "DW", lang)],
                    ["WW", label("svc", "WW", lang)],
                    ["TE", label("svc", "TE", lang)],
                    ["expired", t("fNoPermit")],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                    {l}
                    <span className="tc">{f.n(counts[k])}</span>
                  </button>
                ))}
              </div>
              <div className="filters">
                <GeoFilter geo={geo} cluster={geoF.cluster} governorate={geoF.governorate} onChange={setGeoF} />
                <input className="in" placeholder={t("searchPh")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchAria")} style={{ width: 200 }} />
                <ExportButtons onExport={exportTankers} disabled={!list.length} />
              </div>
            </div>
            {!isOperator && <p className="note" style={{ paddingTop: 0 }}>{t("readOnly")}</p>}
            <div className="tblwrap" style={{ maxHeight: 460, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>{t("cPlate")}</th>
                    <th>{t("cOwner")}</th>
                    <th>{t("cGov")}</th>
                    <th>{t("cDriver")}</th>
                    <th>{t("cService")}</th>
                    <th>{t("cPermit")}</th>
                    <th>{t("cWater")}</th>
                    <th className="num">{t("cFixQ")}</th>
                    <th>{t("cFix")}</th>
                    <th>{t("cStatus")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!rows && (
                    <tr><td colSpan={11} className="empty">{t("loading")}</td></tr>
                  )}
                  {rows && list.length === 0 && (
                    <tr><td colSpan={11} className="empty">{t("noMatch")}</td></tr>
                  )}
                  {list.map((tk) => {
                    const a = active(tk);
                    const p = permitSummary(tk);
                    const w = latestTest(tk);
                    const age = fixAge(tk);
                    const stale = tk.is_online && (age == null || age > STALE_AFTER_S);
                    return (
                      <tr key={tk.id} className={`click ${sel === tk.id ? "sel" : ""}`} onClick={() => setSel(sel === tk.id ? null : tk.id)}>
                        <td className={`stripe ${tk.service_type}`}>
                          <b dir="ltr">{tk.plate}</b>
                          <small style={{ display: "block" }}>{tk.capacity_known ? f.gal(tk.capacity_gal) : t("capUnknown")}</small>
                        </td>
                        <td>{one(tk.company)?.name ?? <span className="mut">{t("independent")}</span>}</td>
                        <td>
                          {tk.governorate_code ? geo.govName(tk.governorate_code) : <span className="mut">{t("notSet")}</span>}
                          {tk.governorate_code && <small style={{ display: "block" }}>{geo.clusterName(geo.clusterOf(tk.governorate_code))}</small>}
                        </td>
                        <td>
                          {a?.driver?.full_name ?? <span className="mut">{t("unassigned")}</span>} {a && <TierPill tier={tiers[a.driver_id]} />}
                        </td>
                        <td><span className={`tag ${tk.service_type}`}>{label("svc", tk.service_type, lang, SERVICE_NAME[tk.service_type])}</span></td>
                        <td><St tone={p.tone}>{permitText(tk, p, t, f)}</St></td>
                        <td>
                          {tk.service_type !== "DW" ? (
                            <span className="mut">—</span>
                          ) : w ? (
                            <>
                              <St tone={w.passed ? "ok" : "bad"}>{w.passed ? t("passed") : t("failed")}</St>
                              <small style={{ display: "block" }}><bdi dir="ltr">{w.cert_no}</bdi> · {f.date(w.tested_at)}</small>
                            </>
                          ) : (
                            <St tone="warn">{t("noTest")}</St>
                          )}
                        </td>
                        <td className="num"><FixQuality source={tk.last_fix_source} accuracy={tk.last_accuracy_m} /></td>
                        <td>
                          {tk.last_fix_at ? f.ago(tk.last_fix_at, now) : <span className="mut">{t("noFix")}</span>}
                          {stale ? <small style={{ display: "block", color: "var(--bad)" }}>{t("staleOnline")}</small> : <small style={{ display: "block" }}>{tk.is_online ? t("onlineL") : t("offlineL")}</small>}
                        </td>
                        <td>
                          {tk.blocked ? (
                            <>
                              <St tone="bad">{t("suspended")}</St>
                              <small style={{ display: "block" }} title={tk.blocked_reason ?? ""}>{tk.blocked_reason}</small>
                            </>
                          ) : (
                            <St tone="ok">{t("activeL")}</St>
                          )}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="btns" style={{ flexWrap: "nowrap" }}>
                            {tk.blocked ? (
                              <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unblock", tanker: tk })}>{t("reinstate")}</button>
                            ) : (
                              <button className="btn sm bad" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "block", tanker: tk })}>{t("suspend")}</button>
                            )}
                            {a ? (
                              <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unassign", tanker: tk })}>{t("unassign")}</button>
                            ) : (
                              <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => { setDriverPick(""); setDlg({ kind: "assign", tanker: tk }); }}>{t("assign")}</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows && !selected && <p className="note">{t("selectHint")}</p>}
          </div>

          {selected && <VehiclePanel tankerId={selected.id} />}
          {selected && (
            <div className="grid2">
              <div className="panel">
                <h2>
                  {t("routeHistory", { plate: selected.plate })} <small>{trailText}</small>
                </h2>
                <div className="pad">
                  <div className="minimap" style={{ height: 340 }}>
                    <FleetMap tankers={mapTankers} orders={[]} sites={mapSites} trail={trail} selectedId={selected.id} />
                  </div>
                  {!trail && <p className="mut" style={{ margin: "0 0 8px", fontSize: 13 }}>{t("noGps")}</p>}
                  <div className="legend2">
                    <span><i style={{ background: "#17b3c6" }} />{t("lgRoute")}</span>
                    <span><i style={{ background: "#3B82F6" }} />{t("lgFill")}</span>
                    <span><i style={{ background: "#C08E35" }} />{t("lgDischarge")}</span>
                  </div>
                </div>
              </div>
              <div className="panel">
                <h2>
                  {t("tripLog")} <small>{t("tripLogSub", { plate: selected.plate, n: f.n(tankerTrips.length) })}</small>
                </h2>
                <div className="tblwrap">
                  <table>
                    <thead>
                      <tr><th>{t("cOrder")}</th><th>{t("cFill")}</th><th>{t("cDischarge")}</th><th>{t("cStatus")}</th></tr>
                    </thead>
                    <tbody>
                      {tankerTrips.length === 0 && <tr><td colSpan={4} className="empty">{t("noTrips")}</td></tr>}
                      {tankerTrips.map((tr) => (
                        <TripCells key={tr.id} t={tr} compact />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pad btns" style={{ paddingTop: 12 }}>
                  {selected.blocked ? (
                    <button className="btn" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unblock", tanker: selected })}>{t("reinstateTanker")}</button>
                  ) : (
                    <button className="btn bad" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "block", tanker: selected })}>{t("suspendTanker")}</button>
                  )}
                  <button className="btn" disabled={!tankerTrips.length} onClick={() => exportTrips(tankerTrips, `trips-${selected.plate}`)}>{t("exportTrips")}</button>
                  <Link className="btn" href={`/nws/permits?tab=apps&tanker=${selected.id}`}>{t("permits")}</Link>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "trips" && (
        <div className="panel">
          <div className="toolbar">
            <span className="mut" style={{ fontSize: 13 }}>{t("tripsIntro", { n: f.n(trips?.length ?? 0) })}</span>
            <ExportButtons disabled={!trips?.length} onExport={(fmt) => trips && exportTrips(trips, "trip-logs", fmt)} />
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>{t("cOrder")}</th><th>{t("cTanker")}</th><th>{t("cService")}</th><th className="num">{t("cGallons")}</th><th>{t("cFill")}</th><th>{t("cDischarge")}</th><th>{t("cStatus")}</th></tr>
              </thead>
              <tbody>
                {!trips && <tr><td colSpan={7} className="empty">{t("loading")}</td></tr>}
                {trips?.length === 0 && <tr><td colSpan={7} className="empty">{t("noTrips")}</td></tr>}
                {trips?.map((tr) => (
                  <TripCells key={tr.id} t={tr} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "ivms" && (
        <>
          <div className="okpis">
            <Kpi label={t("kDevices")} value={f.n(devices.length)} sub={t("kDevicesSub", { n: f.n(all.length - devices.length) })} tone={all.length - devices.length ? "warn" : ""} />
            <Kpi label={t("kReporting")} value={f.n(reporting.length)} sub={t("kReportingSub")} tone="ok" />
            <Kpi label={t("kAccuracy")} value={accs.length ? t("accM", { n: f.n(accs.reduce((a, b) => a + b, 0) / accs.length, 1) }) : "—"} sub={t("kAccuracySub")} />
            <Kpi label={t("kWithin10")} value={f.ratio(fixAcc.filter((x) => x <= 10).length, fixAcc.length)} sub={t("kWithin10Sub", { n: f.n(fixAcc.length) })} />
          </div>
          <div className="panel">
            <h2>{t("kDevices")}</h2>
            <div className="tblwrap">
              <table>
                <thead>
                  <tr><th>{t("cDevice")}</th><th>{t("cTanker")}</th><th>{t("cFirmware")}</th><th>{t("cInstalled")}</th><th>{t("cFix")}</th><th className="num">{t("cAccuracy")}</th><th>{t("cSignal")}</th><th>{t("cSensors")}</th></tr>
                </thead>
                <tbody>
                  {devices.length === 0 && <tr><td colSpan={8} className="empty">{t("noDevices")}</td></tr>}
                  {devices.map((tk) => {
                    const d = one(tk.device)!;
                    const a = fixAge(tk);
                    const sig = a == null ? [t("sigNoFix"), "bad"] : a < 60 ? [t("sigGood"), "ok"] : a < 300 ? [t("sigWeak"), "warn"] : [t("sigLost"), "bad"];
                    const sensors = Object.entries(d.sensors ?? {}).filter(([, v]) => v).map(([k]) => k.replace("_", " "));
                    return (
                      <tr key={d.id}>
                        <td><b dir="ltr">{d.id}</b></td>
                        <td><bdi dir="ltr">{tk.plate}</bdi> <span className={`tag ${tk.service_type}`}>{tk.service_type}</span></td>
                        <td dir="ltr">{d.firmware}</td>
                        <td>{f.date(d.installed_at)}</td>
                        <td>{tk.last_fix_at ? f.ago(tk.last_fix_at, now) : "—"}</td>
                        <td className="num"><FixQuality source={tk.last_fix_source} accuracy={tk.last_accuracy_m} /></td>
                        <td><St tone={sig[1]}>{sig[0]}</St></td>
                        <td><small>{sensors.join(", ") || "—"}</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note">{t("ivmsNote")}</p>
          </div>
        </>
      )}

      {dlg?.kind === "block" && (
        <ReasonDialog
          title={t("dlgSuspend", { plate: dlg.tanker.plate })}
          body={t("dlgSuspendBody")}
          confirm={t("suspendTanker")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_block_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, t("okSuspended", { plate: dlg.tanker.plate }))}
        />
      )}
      {dlg?.kind === "unblock" && (
        <ReasonDialog
          title={t("dlgReinstate", { plate: dlg.tanker.plate })}
          body={t("dlgReinstateBody")}
          confirm={t("reinstate")}
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_unblock_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, t("okReinstated", { plate: dlg.tanker.plate }))}
        />
      )}
      {dlg?.kind === "unassign" && (
        <ReasonDialog
          title={t("dlgUnassign", { plate: dlg.tanker.plate })}
          body={t("dlgUnassignBody", { driver: active(dlg.tanker)?.driver?.full_name ?? t("theDriver") })}
          confirm={t("unassign")}
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_unassign_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, t("okUnassigned", { plate: dlg.tanker.plate }))}
        />
      )}
      {dlg?.kind === "assign" && (
        <ReasonDialog
          title={t("dlgAssign", { plate: dlg.tanker.plate })}
          body={t("dlgAssignBody")}
          confirm={t("assign")}
          extra={
            <div className="fld">
              <label htmlFor="drv">{t("cDriver")}</label>
              <select id="drv" className="in" value={driverPick} onChange={(e) => setDriverPick(e.target.value)}>
                <option value="">{t("chooseDriver")}</option>
                {freeDrivers.filter((d) => d.company_id === dlg.tanker.company_id).map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name || d.id}</option>
                ))}
              </select>
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={(reason) =>
            driverPick
              ? act("staff_assign_tanker", { p_driver_id: driverPick, p_tanker_id: dlg.tanker.id, p_reason: reason }, t("okAssigned", { plate: dlg.tanker.plate }))
              : toast(t("chooseDriverFirst"), true)
          }
        />
      )}
    </>
  );
}

function Check({ v, site }: { v: ReturnType<typeof verification>; site: string | null }) {
  const t = useT(FLEET);
  if (!v) return <span className="mut">{site ?? "—"}</span>;
  return (
    <>
      <St tone={v.tone}>{v.text === "Verified" ? t("verified") : t("mismatch")}</St>
      <small style={{ display: "block" }}>{[site, v.note].filter(Boolean).join(" · ")}</small>
    </>
  );
}

function TripCells({ t, compact }: { t: Trip; compact?: boolean }) {
  const tr = useT(FLEET);
  const f = useFmt();
  const { lang } = useLang();
  const [stText, stTone] = statusText(t.status, undefined, lang);
  const end = t.delivered_at ?? t.cancelled_at;
  return (
    <tr>
      <td className={`stripe ${t.service_type}`}>
        <Link className="lk" href={`/nws/orders/${t.id}`} dir="ltr">{orderNo(t.order_no)}</Link>
        {t.is_test && <span className="st warn ptag" title={tr("testTrip")}>{tr("testTag")}</span>}
        <small style={{ display: "block" }}>{f.dateTime(t.created_at)}</small>
      </td>
      {!compact && (
        <>
          <td>
            <bdi dir="ltr">{t.tanker_plate ?? "—"}</bdi>
            <small style={{ display: "block" }}>{t.driver_name ?? ""}</small>
          </td>
          <td><span className={`tag ${t.service_type}`}>{t.service_type}</span></td>
          <td className="num">{f.n(t.gallons)}</td>
        </>
      )}
      <td>{t.service_type === "WW" ? <span className="mut">{tr("na")}</span> : <Check v={verification(t, "fill")} site={one(t.fill_site)?.name ?? null} />}</td>
      <td>
        {t.service_type === "WW" ? (
          <Check v={verification(t, "discharge")} site={one(t.discharge_site)?.name ?? null} />
        ) : (
          <span>
            {t.area}
            <small style={{ display: "block" }}>{f.gal(t.gallons)}</small>
          </span>
        )}
      </td>
      <td>
        <St tone={stTone}>{stText}</St>
        {end && <small style={{ display: "block" }}>{f.dateTime(end)}</small>}
      </td>
    </tr>
  );
}
