"use client";

import "./ops.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { FleetMap } from "@/components/nws/FleetMap";
import type { LatLng, MapSite } from "@/components/nws/FleetMapView";
import { permitSummary, type Permit } from "@/components/nws/fleetData";
import { ago, maskPhone, one, orderSla, SEV_LABEL, SEV_TONE, useNow, useRealtime, useRpc } from "@/components/nws/ops";
import { PenaltyDialog } from "@/components/nws/PenaltyDialog";
import { fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { STATUS_TEXT } from "@/components/OrderBits";
import { agoText, STALE_AFTER_S } from "@/lib/gps";
import { orderNo } from "@/lib/format";
import { muscatDayStart } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import { inTestArea, useTestAreas } from "@/lib/testArea";
import { ON_JOB_STATUSES, type OrderStatus } from "@/lib/types";
import type { ServiceType } from "@/lib/pricing";

type LiveTanker = {
  id: string; plate: string; service_type: ServiceType; capacity_gal: number; is_online: boolean; blocked: boolean; blocked_reason: string | null;
  last_lat: number | null; last_lng: number | null; last_fix_at: string | null; last_accuracy_m: number | null; location_age_s: number | null;
  company: { name: string } | { name: string }[] | null;
  assignments: { unassigned_at: string | null; driver: { full_name: string; phone: string | null } | null }[];
  permits: Permit[];
};
type LiveOrder = {
  id: string; order_no: number; service_type: ServiceType; gallons: number; area: string; status: OrderStatus; tanker_id: string | null;
  tanker_plate: string | null; created_at: string; released_at: string | null; slot_end: string | null; collected_at: string | null; delivered_at: string | null;
  is_test: boolean;
  loc: { lat: number; lng: number } | { lat: number; lng: number }[] | null;
};
type Alert = {
  id: number; tanker_id: string | null; order_id: string | null; type: string; severity: "high" | "med" | "low"; message: string;
  lat: number | null; lng: number | null; state: "open" | "acknowledged" | "resolved"; created_at: string; action_note: string | null;
};
type Zone = { name: string; center_lat: number; center_lng: number; radius_km: number; is_test: boolean; min_lat: number | null; max_lat: number | null; min_lng: number | null; max_lng: number | null };
type Emergency = { on: boolean; zone: string | null; reason: string | null; since: string | null };
type Hit = { kind: "tanker" | "order" | "customer"; id: string; title: string; sub: string };

const ACTIVE: OrderStatus[] = ["requested", "accepted", "arriving", "arrived", "collected"];
const TYPES: (ServiceType | "all")[] = ["all", "DW", "WW", "TE"];
const TYPE_LABEL = { all: "All tankers", DW: "Drinking water", WW: "Wastewater", TE: "Treated effluent" };
const ORDER_COLS = "id, order_no, service_type, gallons, area, status, tanker_id, tanker_plate, created_at, released_at, slot_end, collected_at, delivered_at, is_test, loc:order_locations(lat, lng)";
const SCAN_EVERY = 60_000;
// Alert types staff_alert_action maps to a penalty rule; other types pick a rule in the dialog.
const ALERT_RULE = new Set(["Discharge outside approved zone", "Non-renewed tanker on active trip", "Delivery window breach", "Short volume"]);

// Haversine distance in km (mirrors public.km).
function km(a: LatLng, b: LatLng) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const startOfDay = (at: number) => muscatDayStart(at).toISOString();

export default function LiveOperations() {
  const { can, toast } = useStaff();
  const rpc = useRpc();
  const router = useRouter();
  const [tankers, setTankers] = useState<LiveTanker[]>([]);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [today, setToday] = useState<LiveOrder[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [openAll, setOpenAll] = useState<{ id: number; lat: number | null; lng: number | null; severity: Alert["severity"] }[]>([]);
  const [sites, setSites] = useState<MapSite[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [emergency, setEmergency] = useState<Emergency | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const now = useNow(5_000);
  const [filter, setFilter] = useState<ServiceType | "all">("all");
  const [loaded, setLoaded] = useState(false);
  const [selTanker, setSelTanker] = useState<string | null>(null);
  const [selAlert, setSelAlert] = useState<number | null>(null);
  const [trail, setTrail] = useState<LatLng[] | null>(null);
  const [dlg, setDlg] = useState<null | "suspend" | "penalty" | "alertPenalty" | "alertPenaltyPick" | "alertSuspend">(null);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const preselected = useRef(false); // the first open alert is selected on arrival, as in the prototype
  const testAreas = useTestAreas();

  const load = useCallback(async () => {
    const db = supabase();
    const day = startOfDay(Date.now());
    const [t, o, d, a, e, oa] = await Promise.all([
      db
        .from("tankers")
        .select(
          "id, plate, service_type, capacity_gal, is_online, blocked, blocked_reason, last_lat, last_lng, last_fix_at, last_accuracy_m, location_age_s, company:companies(name), assignments:tanker_assignments(unassigned_at, driver:profiles!tanker_assignments_driver_id_fkey(full_name, phone)), permits(id, permit_no, type, status, issued_at, expires_at)",
        )
        .order("plate"),
      db.from("orders").select(ORDER_COLS).in("status", ACTIVE).order("created_at", { ascending: false }),
      // Today's KPIs leave out test-zone orders (0020).
      db.from("orders").select(ORDER_COLS).eq("is_test", false).or(`created_at.gte.${day},delivered_at.gte.${day}`),
      db.from("alerts").select("id, tanker_id, order_id, type, severity, message, lat, lng, state, created_at, action_note").order("created_at", { ascending: false }).limit(60),
      db.from("app_settings").select("value").eq("key", "EMERGENCY").maybeSingle(),
      db.from("alerts").select("id, lat, lng, severity").eq("state", "open").limit(5000),
    ]);
    setTankers((t.data ?? []) as unknown as LiveTanker[]);
    setOrders((o.data ?? []) as unknown as LiveOrder[]);
    setToday((d.data ?? []) as unknown as LiveOrder[]);
    setAlerts((a.data ?? []) as Alert[]);
    if (!preselected.current) {
      preselected.current = true;
      const first = ((a.data ?? []) as Alert[]).find((x) => x.state === "open");
      if (first) {
        setSelAlert((prev) => prev ?? first.id);
        setSelTanker((prev) => prev ?? first.tanker_id);
      }
    }
    setOpenAll((oa.data ?? []) as { id: number; lat: number | null; lng: number | null; severity: Alert["severity"] }[]);
    try {
      setEmergency(e.data ? (JSON.parse(e.data.value) as Emergency) : null);
    } catch {
      setEmergency(null);
    }
    setFetchedAt(Date.now());
    setLoaded(true);
  }, []);

  // The control-room scan releases scheduled orders, generates contract orders and raises alerts.
  const scan = useCallback(async () => {
    const { data, error } = await supabase().rpc("staff_scan");
    if (error) return;
    setLastScan(Date.now());
    const r = data as { released: number; contract_orders: number; new_alerts: number };
    if (r.new_alerts > 0 || r.released > 0 || r.contract_orders > 0) load();
  }, [load]);

  useEffect(() => {
    const first = setTimeout(() => {
      load();
      scan();
    }, 0);
    const db = supabase();
    Promise.all([db.from("sites").select("id, code, kind, name, lat, lng, radius_m").eq("active", true).eq("is_test", false), db.from("zones").select("name, center_lat, center_lng, radius_km, is_test, min_lat, max_lat, min_lng, max_lng").eq("active", true)]).then(([s, z]) => {
      type Site = { id: string; code: string; kind: "fill" | "discharge"; name: string; lat: number; lng: number; radius_m: number };
      setSites(((s.data ?? []) as Site[]).map((x) => ({ ...x, label: `${x.code} · ${x.name} (${x.kind === "fill" ? "filling" : "discharge"} geofence ${x.radius_m} m)` })));
      setZones((z.data ?? []) as Zone[]);
    });
    const poll = setInterval(load, 30_000);
    const sc = setInterval(scan, SCAN_EVERY);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(sc);
    };
  }, [load, scan]);
  useRealtime("nws-live", ["tankers", "orders", "alerts"], load, 5000);

  // Age = server age at fetch time + time since (independent of the browser clock).
  const age = useCallback((t: LiveTanker) => (t.location_age_s == null ? null : t.location_age_s + Math.max(0, now - fetchedAt) / 1000), [now, fetchedAt]);
  const isStale = useCallback(
    (t: LiveTanker) => {
      const a = age(t);
      return a == null || a > STALE_AFTER_S;
    },
    [age],
  );
  // As zone_at(): a box zone contains its box; real zones rank before test zones, then nearest centre.
  const zoneOf = (p: LatLng | null) => {
    if (!p) return null;
    const hit = zones
      .map((z) => ({ z, d: km(p, { lat: z.center_lat, lng: z.center_lng }) }))
      .filter(({ z, d }) => (z.min_lat != null ? p.lat >= z.min_lat && p.lat <= z.max_lat! && p.lng >= z.min_lng! && p.lng <= z.max_lng! : d <= z.radius_km))
      .sort((a, b) => Number(a.z.is_test) - Number(b.z.is_test) || a.d - b.d)[0];
    return hit?.z.name ?? null;
  };

  const day = startOfDay(now);
  const openAlerts = useMemo(() => alerts.filter((a) => a.state === "open"), [alerts]);
  // KPIs leave out tankers and alerts in an active test zone (0020); the map and feed still show them.
  const inTest = (p: { lat: number | null; lng: number | null }) => p.lat != null && p.lng != null && inTestArea({ lat: p.lat, lng: p.lng }, testAreas);
  const allOnline = tankers.filter((t) => t.is_online);
  const online = allOnline.filter((t) => !inTest({ lat: t.last_lat, lng: t.last_lng }));
  const testOnline = allOnline.length - online.length;
  const kpiAlerts = openAll.filter((a) => !inTest(a));
  const openCount = openAll.length;
  const testAlerts = openCount - kpiAlerts.length;
  const inProgress = orders.filter((o) => !o.is_test && o.status !== "requested").length;
  const delivered = today.filter((o) => o.status === "delivered" && o.delivered_at && o.delivered_at >= day);
  const onTime = delivered.filter((o) => orderSla(o, now).tone === "ok").length;
  const tripsToday = today.filter((o) => o.created_at >= day && o.status !== "cancelled").length;
  const highOpen = kpiAlerts.filter((a) => a.severity === "high").length;

  // On the map: online tankers, plus any tanker with an open alert or currently selected.
  const mapTankers = useMemo(() => {
    const flagged = new Set(openAlerts.map((a) => a.tanker_id));
    return tankers
      .filter((t) => (t.is_online || flagged.has(t.id) || t.id === selTanker) && (filter === "all" || t.service_type === filter))
      .filter((t) => t.last_lat != null && t.last_lng != null)
      .map((t) => {
        const a = age(t);
        return {
          id: t.id, lat: t.last_lat as number, lng: t.last_lng as number, type: t.service_type, stale: isStale(t), blocked: t.blocked,
          label: `${t.plate} · ${a == null ? "no fix yet" : `last fix ${agoText(a)}`}`,
        };
      });
  }, [tankers, openAlerts, selTanker, filter, age, isStale]);
  const mapOrders = useMemo(
    () =>
      orders
        .filter((o) => filter === "all" || o.service_type === filter)
        .map((o) => ({ o, l: one(o.loc) }))
        .filter(({ l }) => l)
        .map(({ o, l }) => ({ id: o.id, lat: l!.lat, lng: l!.lng, type: o.service_type, label: `${orderNo(o.order_no)} · ${STATUS_TEXT[o.status][0]} · ${o.gallons.toLocaleString()} gal` })),
    [orders, filter],
  );
  const alertRings = useMemo(() => openAlerts.filter((a) => a.lat != null && a.lng != null).map((a) => ({ lat: a.lat as number, lng: a.lng as number })), [openAlerts]);

  const tanker = tankers.find((t) => t.id === selTanker) ?? null;
  const alert = alerts.find((a) => a.id === selAlert) ?? null;
  const job = tanker ? orders.find((o) => o.tanker_id === tanker.id && ON_JOB_STATUSES.includes(o.status)) : null;
  const drv = tanker ? (tanker.assignments.find((a) => !a.unassigned_at)?.driver ?? null) : null;
  const permit = tanker ? permitSummary(tanker) : null;
  const tAge = tanker ? age(tanker) : null;

  function pickAlert(a: Alert) {
    setSelAlert(a.id);
    setSelTanker(a.tanker_id);
    setTrail(null);
  }
  function pickTanker(id: string) {
    setSelTanker(id);
    setSelAlert(openAlerts.find((a) => a.tanker_id === id)?.id ?? null);
    setTrail(null);
  }

  async function alertAction(action: "acknowledge" | "resolve" | "inspector" | "suspend" | "penalty", note: string | null, ok: string) {
    if (!alert) return;
    if (await rpc("staff_alert_action", { p_alert_id: alert.id, p_action: action, p_note: note }, ok)) {
      setDlg(null);
      load();
    }
  }

  // Trip history: GPS fixes of the last 2 hours (or the latest 200) drawn on the map.
  async function tripHistory(t: LiveTanker) {
    const db = supabase();
    type Fix = LatLng & { recorded_at: string };
    let { data } = await db.from("gps_fixes").select("lat, lng, recorded_at").eq("tanker_id", t.id).gte("recorded_at", new Date(Date.now() - 2 * 3_600_000).toISOString()).order("recorded_at");
    if (!data?.length) ({ data } = await db.from("gps_fixes").select("lat, lng, recorded_at").eq("tanker_id", t.id).order("recorded_at", { ascending: false }).limit(200));
    const pts = ((data ?? []) as Fix[]).slice().sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
    if (pts.length < 2) return toast(`No GPS history for ${t.plate} yet`, true);
    setTrail(pts.map(({ lat, lng }) => ({ lat, lng })));
    toast(`${t.plate}: ${pts.length} GPS fixes since ${fmtDateTime(pts[0].recorded_at)}`);
  }

  // Header search: plates locally; TO numbers and customers from the database.
  useEffect(() => {
    const s = q.trim();
    const t = setTimeout(async () => {
      if (s.length < 2) return setHits(null);
      const out: Hit[] = tankers
        .filter((x) => x.plate.toLowerCase().includes(s.toLowerCase()))
        .slice(0, 5)
        .map((x) => ({ kind: "tanker", id: x.id, title: x.plate, sub: `${x.service_type} · ${x.blocked ? "suspended" : x.is_online ? "online" : "offline"}` }));
      const n = s.toUpperCase().replace(/^TO-?/, "");
      const like = s.replace(/[,()%]/g, "");
      const db = supabase();
      const [o, c] = await Promise.all([
        /^\d+$/.test(n) ? db.from("orders").select("id, order_no, status, area").eq("order_no", Number(n)).limit(3) : Promise.resolve({ data: [] }),
        db.from("profiles").select("id, full_name, phone").eq("role", "customer").or(`full_name.ilike.%${like}%,phone.ilike.%${like}%`).limit(5),
      ]);
      for (const x of (o.data ?? []) as { id: string; order_no: number; status: OrderStatus; area: string }[])
        out.push({ kind: "order", id: x.id, title: orderNo(x.order_no), sub: `${STATUS_TEXT[x.status][0]} · ${x.area}` });
      for (const x of (c.data ?? []) as { id: string; full_name: string; phone: string | null }[]) out.push({ kind: "customer", id: x.id, title: x.full_name || "Customer", sub: maskPhone(x.phone) });
      setHits(out);
    }, 250);
    return () => clearTimeout(t);
  }, [q, tankers]);

  const isOp = can("operator");
  const alertRole = can("operator", "admin", "inspector");
  const penaltyRole = can("operator", "inspector", "admin");
  const inspectRole = can("inspector", "permit_officer");
  const roleTip = (ok: boolean, who: string) => (ok ? undefined : `${who} only`);

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Live operations</h1>
          <p>
            {new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · Muscat Governorate
            {lastScan ? ` · control-room scan ${ago(new Date(lastScan).toISOString(), now)}` : ""}
          </p>
        </div>
        <div className="ops-tools">
          <label className="srch">
            <Icon name="search" />
            <input
              placeholder="Search tanker, order or customer"
              aria-label="Search tanker, order or customer"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
            />
          </label>
          {hits && q.trim().length >= 2 && (
            <div className="srch-res" role="listbox">
              {hits.length === 0 && <div className="empty" style={{ padding: 14 }}>No matches.</div>}
              {hits.map((h) =>
                h.kind === "tanker" ? (
                  <button
                    key={h.kind + h.id}
                    onClick={() => {
                      pickTanker(h.id);
                      setQ("");
                    }}
                  >
                    <span>
                      <b>{h.title}</b> <small>Tanker</small>
                    </span>
                    <small>{h.sub}</small>
                  </button>
                ) : (
                  <Link key={h.kind + h.id} href={h.kind === "order" ? `/nws/orders/${h.id}` : `/nws/customers?id=${h.id}`}>
                    <span>
                      <b>{h.title}</b> <small>{h.kind === "order" ? "Order" : "Customer"}</small>
                    </span>
                    <small>{h.sub}</small>
                  </Link>
                ),
              )}
            </div>
          )}
          <Link href="/nws/settings/emergency" className={`em ${emergency?.on ? "on" : ""}`}>
            <i />
            {emergency?.on ? "Emergency active" : "Emergency mode"}
          </Link>
          <button className="ib" aria-label={`${openCount} open alerts`} title={`${openCount} open alerts`} onClick={() => feedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            <Icon name="bell" />
            {openCount > 0 && <span className="dot">{openCount}</span>}
          </button>
        </div>
      </div>

      {emergency?.on && (
        <div className="banner badb">
          <b>Emergency mode active{emergency.zone ? ` in ${emergency.zone}` : ""}.</b> {emergency.reason} Priority dispatch on, driver shifts overridden
          {emergency.since ? ` · since ${fmtDateTime(emergency.since)}` : ""}.
        </div>
      )}

      <div className="okpis">
        <div className="okpi">
          <span>Tankers active</span>
          <b>{loaded ? online.length : "—"}</b>
          <small>
            {tankers.length} registered · {online.filter(isStale).length} with stale GPS
            {testOnline > 0 ? ` · ${testOnline} in test zone (not counted)` : ""}
          </small>
        </div>
        <div className="okpi">
          <span>Trips today</span>
          <b>{loaded ? tripsToday : "—"}</b>
          <small className="ok">
            {delivered.length} delivered · {inProgress} in progress
          </small>
        </div>
        <div className="okpi">
          <span>Delivered on time</span>
          <b>{loaded && delivered.length ? `${Math.round((onTime / delivered.length) * 1000) / 10}%` : "—"}</b>
          <small className={delivered.length && onTime / delivered.length < 0.92 ? "warn" : "ok"}>Target 92% · {delivered.length} deliveries today</small>
        </div>
        <div className="okpi">
          <span>Open alerts</span>
          <b>{loaded ? kpiAlerts.length : "—"}</b>
          <small className={highOpen ? "bad" : ""}>
            {highOpen} high severity{testAlerts > 0 ? ` · ${testAlerts} more in the test zone` : ""}
          </small>
        </div>
      </div>

      <div className="ops-grid">
        <div className="mapcard">
          <FleetMap
            tankers={mapTankers}
            orders={mapOrders}
            sites={sites}
            trail={trail}
            selectedId={selTanker}
            alerts={alertRings}
            onSelect={(k, id) => (k === "tanker" ? pickTanker(id) : router.push(`/nws/orders/${id}`))}
          />
          <div className="ov ov-tl chips" role="group" aria-label="Filter by service">
            {TYPES.map((k) => (
              <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {TYPE_LABEL[k]}
              </button>
            ))}
            {trail && (
              <button className="chip on" onClick={() => setTrail(null)}>
                Clear trip history ✕
              </button>
            )}
          </div>
          <div className="ov ov-tr live">
            <i />
            Live GPS · IVMS link simulated
          </div>
          <div className="ov ov-bl">
            <div className="legend2">
              <span><i style={{ background: "#3B82F6" }} />Drinking water</span>
              <span><i style={{ background: "#C08E35" }} />Wastewater</span>
              <span><i style={{ background: "#2FA36B" }} />Treated effluent</span>
              <span><i style={{ background: "#8A9A9E" }} />Stale GPS</span>
              <span><i style={{ background: "#E5484D" }} />Suspended</span>
              <span><i style={{ background: "none", boxShadow: "inset 0 0 0 2px #E5484D" }} />Open alert</span>
              <span><i className="pinsw" style={{ background: "#93aeb3" }} />Delivery point</span>
              <span><i className="sq" style={{ background: "#3B82F6" }} />Filling station</span>
              <span><i className="sq" style={{ background: "#C08E35" }} />Approved discharge</span>
            </div>
          </div>
        </div>

        <div className="ops-side">
          <div className="panel alerts" ref={feedRef}>
            <h2>
              Alerts <span className={`st ${openCount ? "bad" : "ok"}`}>{openCount} open</span>
            </h2>
            <div className="feed">
              {alerts.length === 0 && <div className="empty">No alerts. The control-room scan runs every minute.</div>}
              {alerts.slice(0, 30).map((a) => {
                const t = tankers.find((x) => x.id === a.tanker_id);
                return (
                  <button key={a.id} className={`alert ${a.state !== "open" ? "done" : ""} ${selAlert === a.id ? "sel" : ""}`} onClick={() => pickAlert(a)}>
                    <i className={`sb ${a.severity}`} />
                    <div className="ac">
                      <div className="t">
                        <span>{a.type}</span>
                        <time>{ago(a.created_at, now)}</time>
                      </div>
                      <div className="d">
                        <span className={`st ${SEV_TONE[a.severity]} ptag`}>{SEV_LABEL[a.severity]}</span> {t ? `${t.plate} · ` : ""}
                        {a.message}
                        {a.state !== "open" ? ` — ${a.state}` : ""}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="panel tkc">
            {!tanker ? (
              <div className="empty" style={{ padding: 12 }}>
                {alert ? alert.message : "Select a tanker on the map or an alert."}
                {alert && alert.state !== "resolved" && (
                  <div className="lnks" style={{ justifyContent: "center", marginTop: 10 }}>
                    {alert.state === "open" && (
                      <button disabled={!alertRole} onClick={() => alertAction("acknowledge", null, "Alert acknowledged")}>
                        Acknowledge
                      </button>
                    )}
                    <button disabled={!alertRole} onClick={() => alertAction("resolve", null, "Alert resolved")}>
                      Resolve
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="tk-h">
                  <b>{tanker.plate}</b>
                  <span className={`tag ${tanker.service_type}`}>{TYPE_LABEL[tanker.service_type]}</span>
                </div>
                {alert && (
                  <div className={`tk-al ${alert.severity}`}>
                    <b>
                      {alert.type} · {alert.state}
                    </b>
                    <span>{alert.message}</span>
                    {alert.action_note && <span>Note: {alert.action_note}</span>}
                  </div>
                )}
                {tanker.blocked && (
                  <div className="tk-al high">
                    <b>Suspended</b>
                    <span>{tanker.blocked_reason}</span>
                  </div>
                )}
                <div className="kvr">
                  <div>
                    <span>Owner</span>
                    <b>{one(tanker.company)?.name ?? "Independent"}</b>
                  </div>
                  <div>
                    <span>Driver</span>
                    <b>{drv?.full_name || "Unassigned"}</b>
                  </div>
                  <div>
                    <span>Permit</span>
                    <b style={{ color: permit?.valid ? undefined : "var(--bad)" }}>{permit?.text}</b>
                  </div>
                  <div>
                    <span>GPS</span>
                    <b>
                      {tanker.last_accuracy_m != null ? `±${tanker.last_accuracy_m.toFixed(1)} m · ` : ""}
                      {tAge == null ? "no fix yet" : `fix ${agoText(tAge)}`}
                    </b>
                  </div>
                  <div>
                    <span>Zone</span>
                    <b>
                      {zoneOf(tanker.last_lat != null && tanker.last_lng != null ? { lat: tanker.last_lat, lng: tanker.last_lng } : null) ?? "Outside service zones"} ·{" "}
                      {tanker.blocked ? "Suspended" : tanker.is_online ? "Online" : "Offline"}
                    </b>
                  </div>
                  <div>
                    <span>Current job</span>
                    <b>
                      {job ? (
                        <Link className="lk" href={`/nws/orders/${job.id}`}>
                          {orderNo(job.order_no)} · {STATUS_TEXT[job.status][0]}
                        </Link>
                      ) : (
                        "None"
                      )}
                    </b>
                  </div>
                </div>
                {alert && alert.state !== "resolved" ? (
                  <div className="tk-act">
                    <button className="btn bad" disabled={!alertRole} title={roleTip(alertRole, "Operators, inspectors and admins")} onClick={() => setDlg(ALERT_RULE.has(alert.type) ? "alertPenalty" : "alertPenaltyPick")}>
                      Issue penalty
                    </button>
                    {alert.action_note === "Inspector dispatched" ? (
                      <button className="btn" disabled title="An inspector is already on the way for this alert">
                        Inspector sent
                      </button>
                    ) : (
                      <button className="btn" disabled={!alertRole} title={roleTip(alertRole, "Operators, inspectors and admins")} onClick={() => alertAction("inspector", null, "Inspector dispatched for today")}>
                        Send inspector
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="tk-act">
                    <button className="btn bad" disabled={!penaltyRole} title={roleTip(penaltyRole, "Operators, inspectors and admins")} onClick={() => setDlg("penalty")}>
                      Issue penalty
                    </button>
                    <button
                      className="btn"
                      disabled={!inspectRole}
                      title={roleTip(inspectRole, "Inspectors and permit officers")}
                      onClick={async () => {
                        if (await rpc("staff_record_inspection", { p_tanker_id: tanker.id, p_permit_id: null, p_result: "scheduled", p_notes: "Sent from Live operations" }, "Inspection booked for tomorrow")) load();
                      }}
                    >
                      Send inspector
                    </button>
                  </div>
                )}
                <div className="lnks">
                  {alert && alert.state === "open" && (
                    <button disabled={!alertRole} title={roleTip(alertRole, "Operators, inspectors and admins")} onClick={() => alertAction("acknowledge", null, "Alert acknowledged")}>
                      Acknowledge
                    </button>
                  )}
                  {alert && alert.state !== "resolved" && (
                    <button disabled={!alertRole} title={roleTip(alertRole, "Operators, inspectors and admins")} onClick={() => alertAction("resolve", null, "Alert resolved")}>
                      Resolve
                    </button>
                  )}
                  {!tanker.blocked && (
                    <button disabled={!isOp} title={roleTip(isOp, "Control room operators")} onClick={() => setDlg(alert && alert.state !== "resolved" ? "alertSuspend" : "suspend")}>
                      Suspend tanker
                    </button>
                  )}
                  <button
                    onClick={() =>
                      drv ? toast(`Simulated: calling ${drv.full_name || "the driver"} through a masked number — the real number (${maskPhone(drv.phone)}) stays hidden`) : toast("No driver assigned to this tanker", true)
                    }
                  >
                    Call driver
                  </button>
                  <button onClick={() => tripHistory(tanker)}>Trip history</button>
                  <Link href={`/nws/fleet?tanker=${tanker.id}`}>Open in Fleet</Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {dlg === "alertPenalty" && alert && (
        <ReasonDialog
          title={`Issue penalty — ${alert.type}`}
          body="The rule is chosen from the alert type under the penalty framework; the fine is deducted from the tanker company’s earnings and the alert is resolved."
          confirm="Issue penalty"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => alertAction("penalty", r, "Penalty issued")}
        />
      )}
      {dlg === "alertSuspend" && alert && tanker && (
        <ReasonDialog
          title={`Suspend ${tanker.plate}`}
          body="The tanker goes offline immediately and can’t take jobs until it is unblocked in Fleet. The alert is resolved."
          confirm="Suspend tanker"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => alertAction("suspend", r, `${tanker.plate} suspended`)}
        />
      )}
      {dlg === "suspend" && tanker && (
        <ReasonDialog
          title={`Suspend ${tanker.plate}`}
          body="The tanker goes offline immediately and can’t take jobs until it is unblocked in Fleet."
          confirm="Suspend tanker"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (r) => {
            if (await rpc("staff_block_tanker", { p_tanker_id: tanker.id, p_reason: r }, `${tanker.plate} suspended`)) {
              setDlg(null);
              load();
            }
          }}
        />
      )}
      {dlg === "alertPenaltyPick" && alert && (
        <PenaltyDialog
          title={`Issue penalty — ${alert.type}`}
          tankerId={alert.tanker_id}
          orderId={alert.order_id}
          onClose={() => setDlg(null)}
          onDone={() => alertAction("resolve", "Penalty issued from the framework", "Penalty issued and alert resolved")}
        />
      )}
      {dlg === "penalty" && tanker && <PenaltyDialog title={`Issue penalty — ${tanker.plate}`} tankerId={tanker.id} orderId={job?.id ?? null} onClose={() => setDlg(null)} onDone={load} />}
    </>
  );
}
