"use client";

import { FixQuality } from "@/components/nws/FixQuality";
import { alertMessage } from "@/components/nws/alertText";
import "./ops.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { FleetMap } from "@/components/nws/FleetMap";
import type { LatLng, MapSite } from "@/components/nws/FleetMapView";
import { permitSummary, type Permit } from "@/components/nws/fleetData";
import { OPS } from "@/components/nws/i18n/ops";
import { WALL } from "@/components/nws/i18n/wall";
import { maskPhone, one, orderSla, SEV_LABEL, SEV_TONE, SOS_BANNER_MS, useNow, useRealtime, useRpc } from "@/components/nws/ops";
import { PenaltyDialog } from "@/components/nws/PenaltyDialog";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { statusText } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { agoText, STALE_AFTER_S } from "@/lib/gps";
import { orderNo } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { label, serviceLabel } from "@/lib/labels";
import { muscatDayStart } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import { inTestArea, useTestAreas } from "@/lib/testArea";
import { ON_JOB_STATUSES, type OrderStatus } from "@/lib/types";
import type { ServiceType } from "@/lib/pricing";

type LiveTanker = {
  id: string; plate: string; service_type: ServiceType; capacity_gal: number; is_online: boolean; blocked: boolean; blocked_reason: string | null;
  last_lat: number | null; last_lng: number | null; last_fix_at: string | null; last_accuracy_m: number | null; last_fix_source: string | null; location_age_s: number | null;
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
type Site = { id: string; code: string; kind: "fill" | "discharge"; name: string; lat: number; lng: number; radius_m: number };

const ACTIVE: OrderStatus[] = ["requested", "accepted", "arriving", "arrived", "collected"];
const TYPES: (ServiceType | "all")[] = ["all", "DW", "WW", "TE"];
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
  const t = useT(OPS);
  const tr = t; // where `t` is a tanker or a timer below
  const tw = useT(WALL);
  // The control-room wall screen in its own window. Opened with an opener so the browser copies
  // this tab's session flags (a "don't keep me signed in" session would otherwise end there), then cut loose.
  const openWall = () => {
    const w = window.open("/nws/wall", "nama-wall");
    if (w) w.opener = null;
  };
  const f = useFmt();
  const { lang } = useLang();
  const rpc = useRpc();
  const router = useRouter();
  const [tankers, setTankers] = useState<LiveTanker[]>([]);
  const [registerCount, setRegisterCount] = useState<number | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [today, setToday] = useState<LiveOrder[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [openAll, setOpenAll] = useState<{ id: number; lat: number | null; lng: number | null; severity: Alert["severity"] }[]>([]);
  const [siteRows, setSiteRows] = useState<Site[]>([]);
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
    // Tankers on the platform only: the NWS register adds ~11,000 offline tankers with no
    // driver, counted separately below (Permits → Register lists them).
    const [t, o, d, a, e, oa, rc] = await Promise.all([
      db
        .from("tankers")
        .select(
          "id, plate, service_type, capacity_gal, is_online, blocked, blocked_reason, last_lat, last_lng, last_fix_at, last_accuracy_m, last_fix_source, location_age_s, company:companies(name), assignments:tanker_assignments(unassigned_at, driver:profiles!tanker_assignments_driver_id_fkey(full_name, phone:phone_masked)), permits(id, permit_no, type, status, issued_at, expires_at)",
        )
        .eq("on_platform", true)
        .order("plate"),
      db.from("orders").select(ORDER_COLS).in("status", ACTIVE).order("created_at", { ascending: false }),
      // Today's KPIs leave out test-zone orders (0020).
      db.from("orders").select(ORDER_COLS).eq("is_test", false).or(`created_at.gte.${day},delivered_at.gte.${day}`),
      db.from("alerts").select("id, tanker_id, order_id, type, severity, message, lat, lng, state, created_at, action_note").order("created_at", { ascending: false }).limit(60),
      db.from("app_settings").select("value").eq("key", "EMERGENCY").maybeSingle(),
      db.from("alerts").select("id, lat, lng, severity").eq("state", "open").limit(5000),
      db.from("tankers").select("id", { count: "exact", head: true }).eq("in_register", true),
    ]);
    setRegisterCount(rc.count ?? null);
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
      setSiteRows((s.data ?? []) as Site[]);
      setZones((z.data ?? []) as Zone[]);
    });
    const poll = setInterval(load, 30_000);
    const sc = setInterval(scan, SCAN_EVERY);
    // The built-in IVMS simulator (Settings → Integrations) moves its tankers while this board is open.
    const ivms = setInterval(() => void db.rpc("staff_ivms_sim_tick"), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(sc);
      clearInterval(ivms);
    };
  }, [load, scan]);
  useRealtime("nws-live", ["tankers", "orders", "alerts"], load, 5000);
  const sites = useMemo<MapSite[]>(
    () => siteRows.map((x) => ({ ...x, label: t("siteLabel", { site: `${x.code} · ${x.name}`, kind: t(x.kind === "fill" ? "siteFill" : "siteDischarge"), r: f.n(x.radius_m) }) })),
    [siteRows, t, f],
  );
  // "12 s ago" for a fix age in seconds, in the portal language.
  const since = useCallback((s: number) => (lang === "en" ? agoText(s) : s < 5 ? t("justNow") : f.ago(new Date(now - s * 1000).toISOString(), now)), [lang, t, f, now]);
  const alertType = (ty: string) => (OPS[`at_${ty}`] ? t(`at_${ty}`) : ty);
  const alertState = (s: string) => (OPS[`st_${s}`] ? t(`st_${s}`) : s);
  const typeLabel = (k: ServiceType | "all") => (k === "all" ? t("allTankers") : serviceLabel(k, lang));
  const statusWord = (o: { status: OrderStatus; service_type: ServiceType }) => statusText(o.status, o.service_type, lang)[0];

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
  // Driver SOS (0042): unresolved ones on top of the feed and in a banner; highlighted, no sound.
  const sosOpen = useMemo(() => alerts.filter((a) => a.type === "SOS" && a.state !== "resolved"), [alerts]);
  const sosFirst = useMemo(() => [...sosOpen, ...alerts.filter((a) => !(a.type === "SOS" && a.state !== "resolved"))], [alerts, sosOpen]);
  // The banner shows an SOS for SOS_BANNER_MS after it is raised, until someone acknowledges it;
  // after that it stays at the top of the alerts feed until resolved.
  const sosBanner = sosOpen.filter((a) => a.state === "open" && now - Date.parse(a.created_at) < SOS_BANNER_MS);
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
  const onTime = delivered.filter((o) => orderSla(o, now, lang).tone === "ok").length;
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
          label: `${t.plate} · ${a == null ? tr("noFixYet") : tr("lastFix", { ago: since(a) })}`,
        };
      });
  }, [tankers, openAlerts, selTanker, filter, age, isStale, tr, since]);
  const mapOrders = useMemo(
    () =>
      orders
        .filter((o) => filter === "all" || o.service_type === filter)
        .map((o) => ({ o, l: one(o.loc) }))
        .filter(({ l }) => l)
        .map(({ o, l }) => ({ id: o.id, lat: l!.lat, lng: l!.lng, type: o.service_type, label: `${orderNo(o.order_no)} · ${statusText(o.status, o.service_type, lang)[0]} · ${f.gal(o.gallons)}` })),
    [orders, filter, lang, f],
  );
  const alertRings = useMemo(() => openAlerts.filter((a) => a.lat != null && a.lng != null).map((a) => ({ lat: a.lat as number, lng: a.lng as number })), [openAlerts]);

  const tanker = tankers.find((t) => t.id === selTanker) ?? null;
  const alert = alerts.find((a) => a.id === selAlert) ?? null;
  const job = tanker ? orders.find((o) => o.tanker_id === tanker.id && ON_JOB_STATUSES.includes(o.status)) : null;
  const drv = tanker ? (tanker.assignments.find((a) => !a.unassigned_at)?.driver ?? null) : null;
  const permit = tanker ? permitSummary(tanker, now, lang) : null;
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
    if (pts.length < 2) return toast(tr("noGps", { plate: t.plate }), true);
    setTrail(pts.map(({ lat, lng }) => ({ lat, lng })));
    toast(tr("gpsFixes", { plate: t.plate, n: f.n(pts.length), at: f.dateTime(pts[0].recorded_at) }));
  }

  // Header search: plates locally; TO numbers and customers from the database.
  useEffect(() => {
    const s = q.trim();
    const t = setTimeout(async () => {
      if (s.length < 2) return setHits(null);
      const out: Hit[] = tankers
        .filter((x) => x.plate.toLowerCase().includes(s.toLowerCase()))
        .slice(0, 5)
        .map((x) => ({ kind: "tanker", id: x.id, title: x.plate, sub: `${x.service_type} · ${tr(x.blocked ? "hitSuspended" : x.is_online ? "hitOnline" : "hitOffline")}` }));
      const n = s.toUpperCase().replace(/^TO-?/, "");
      const like = s.replace(/[,()%]/g, "");
      const db = supabase();
      const [o, c] = await Promise.all([
        /^\d+$/.test(n) ? db.from("orders").select("id, order_no, status, area").eq("order_no", Number(n)).limit(3) : Promise.resolve({ data: [] }),
        // Matched on the full number in the database, returned masked (0049).
        db.rpc("staff_find_people", { p_q: like, p_roles: ["customer"], p_limit: 5 }),
      ]);
      for (const x of (o.data ?? []) as { id: string; order_no: number; status: OrderStatus; area: string }[])
        out.push({ kind: "order", id: x.id, title: orderNo(x.order_no), sub: `${statusText(x.status, undefined, lang)[0]} · ${x.area}` });
      for (const x of (c.data ?? []) as { id: string; full_name: string; phone_masked: string | null }[]) out.push({ kind: "customer", id: x.id, title: x.full_name || tr("customer"), sub: maskPhone(x.phone_masked) });
      setHits(out);
    }, 250);
    return () => clearTimeout(t);
  }, [q, tankers, tr, lang]);

  const isOp = can("operator");
  const alertRole = can("operator", "admin", "inspector");
  const penaltyRole = can("operator", "inspector", "admin");
  const inspectRole = can("inspector", "permit_officer");
  const roleTip = (ok: boolean, who: string) => (ok ? undefined : t("onlyRoles", { who: t(who) }));

  return (
    <>
      {sosBanner.length > 0 && (
        <div className="banner badb sos-row" role="alert">
          <b>{t("sosBanner", { n: f.n(sosBanner.length) })}</b>
          {sosBanner.map((a) => {
            const tk = tankers.find((x) => x.id === a.tanker_id);
            return (
              <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                {tk && <bdi dir="ltr">{tk.plate}</bdi>}
                <span>{alertMessage(a.message, lang)}</span>
                <time className="mut">{f.ago(a.created_at, now)}</time>
                {a.lat != null && a.lng != null && (
                  <bdi dir="ltr" className="mut">
                    {a.lat.toFixed(5)}, {a.lng.toFixed(5)}
                  </bdi>
                )}
                <button className="btn sm" onClick={() => pickAlert(a)}>
                  {t("sosShow")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="ops-head">
        <div>
          <h1>{t("title")}</h1>
          <p>
            {f.fmt(now, { weekday: "long", day: "numeric", month: "long" })} · {t("muscatGov")}
            {lastScan ? ` · ${t("lastScan", { ago: f.ago(new Date(lastScan).toISOString(), now) })}` : ""}
          </p>
        </div>
        <div className="ops-tools">
          <label className="srch">
            <Icon name="search" />
            <input
              placeholder={t("searchPh")}
              aria-label={t("searchPh")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
            />
          </label>
          {hits && q.trim().length >= 2 && (
            <div className="srch-res" role="listbox">
              {hits.length === 0 && <div className="empty" style={{ padding: 14 }}>{t("noMatches")}</div>}
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
                      <b dir="ltr">{h.title}</b> <small>{t("tanker")}</small>
                    </span>
                    <small>{h.sub}</small>
                  </button>
                ) : (
                  <Link key={h.kind + h.id} href={h.kind === "order" ? `/nws/orders/${h.id}` : `/nws/customers?id=${h.id}`}>
                    <span>
                      <b dir={h.kind === "order" ? "ltr" : undefined}>{h.title}</b> <small>{t(h.kind === "order" ? "order" : "customer")}</small>
                    </span>
                    <small dir={h.kind === "customer" ? "ltr" : undefined}>{h.sub}</small>
                  </Link>
                ),
              )}
            </div>
          )}
          <button type="button" className="btn sm wall-open" title={tw("openTip")} onClick={openWall}>
            <Icon name="map" />
            {tw("open")}
          </button>
          <Link href="/nws/settings/emergency" className={`em ${emergency?.on ? "on" : ""}`}>
            <i />
            {emergency?.on ? t("emActive") : t("emMode")}
          </Link>
          <button className="ib" aria-label={t("openAlertsN", { n: f.n(openCount) })} title={t("openAlertsN", { n: f.n(openCount) })} onClick={() => feedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            <Icon name="bell" />
            {openCount > 0 && <span className="dot">{f.n(openCount)}</span>}
          </button>
        </div>
      </div>

      {emergency?.on && (
        <div className="banner badb">
          <b>
            {t("emBanner")}
            {emergency.zone ? t("emIn", { zone: emergency.zone }) : ""}.
          </b>{" "}
          {emergency.reason} {t("emBody")}
          {emergency.since ? t("emSince", { at: f.dateTime(emergency.since) }) : ""}.
        </div>
      )}

      <div className="okpis">
        <div className="okpi">
          <span>{t("kTankers")}</span>
          <b>{loaded ? f.n(online.length) : "—"}</b>
          <small>
            {t("kTankersSub", { n: f.n(tankers.length) })}
            {registerCount ? t("kRegister", { n: f.n(registerCount) }) : ""}
            {t("kStale", { n: f.n(online.filter(isStale).length) })}
            {testOnline > 0 ? t("kTestTankers", { n: f.n(testOnline) }) : ""}
          </small>
        </div>
        <div className="okpi">
          <span>{t("kTrips")}</span>
          <b>{loaded ? f.n(tripsToday) : "—"}</b>
          <small className="ok">{t("kTripsSub", { d: f.n(delivered.length), p: f.n(inProgress) })}</small>
        </div>
        <div className="okpi">
          <span>{t("kOnTime")}</span>
          <b>{loaded && delivered.length ? f.ratio(onTime, delivered.length) : "—"}</b>
          <small className={delivered.length && onTime / delivered.length < 0.92 ? "warn" : "ok"}>{t("kOnTimeSub", { n: f.n(delivered.length) })}</small>
        </div>
        <div className="okpi">
          <span>{t("kAlerts")}</span>
          <b>{loaded ? f.n(kpiAlerts.length) : "—"}</b>
          <small className={highOpen ? "bad" : ""}>
            {t("kAlertsSub", { n: f.n(highOpen) })}
            {testAlerts > 0 ? t("kTestAlerts", { n: f.n(testAlerts) }) : ""}
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
          <div className="ov ov-tl chips" role="group" aria-label={t("filterService")}>
            {TYPES.map((k) => (
              <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {typeLabel(k)}
              </button>
            ))}
            {trail && (
              <button className="chip on" onClick={() => setTrail(null)}>
                {t("clearTrail")}
              </button>
            )}
          </div>
          <div className="ov ov-tr live">
            <i />
            {t("liveGps")}
          </div>
          <div className="ov ov-bl">
            <div className="legend2">
              <span><i style={{ background: "#3B82F6" }} />{t("lgDW")}</span>
              <span><i style={{ background: "#C08E35" }} />{t("lgWW")}</span>
              <span><i style={{ background: "#2FA36B" }} />{t("lgTE")}</span>
              <span><i style={{ background: "#8A9A9E" }} />{t("lgStale")}</span>
              <span><i style={{ background: "#E5484D" }} />{t("lgSuspended")}</span>
              <span><i style={{ background: "none", boxShadow: "inset 0 0 0 2px #E5484D" }} />{t("lgAlert")}</span>
              <span><i className="pinsw" style={{ background: "#93aeb3" }} />{t("lgDelivery")}</span>
              <span><i className="sq" style={{ background: "#3B82F6" }} />{t("lgFill")}</span>
              <span><i className="sq" style={{ background: "#C08E35" }} />{t("lgDischarge")}</span>
            </div>
          </div>
        </div>

        <div className="ops-side">
          <div className="panel alerts" ref={feedRef}>
            <h2>
              {t("alerts")} <span className={`st ${openCount ? "bad" : "ok"}`}>{t("nOpen", { n: f.n(openCount) })}</span>
            </h2>
            <div className="feed">
              {alerts.length === 0 && <div className="empty">{t("noAlerts")}</div>}
              {sosFirst.slice(0, 30).map((a) => {
                const tk = tankers.find((x) => x.id === a.tanker_id);
                const sos = a.type === "SOS" && a.state !== "resolved";
                return (
                  <button key={a.id} className={`alert ${a.state !== "open" ? "done" : ""} ${selAlert === a.id ? "sel" : ""} ${sos ? "sos-row" : ""}`} onClick={() => pickAlert(a)}>
                    <i className={`sb ${a.severity}`} />
                    <div className="ac">
                      <div className="t">
                        <span>{alertType(a.type)}</span>
                        <time>{f.ago(a.created_at, now)}</time>
                      </div>
                      <div className="d">
                        <span className={`st ${SEV_TONE[a.severity]} ptag`}>{label("sev", a.severity, lang, SEV_LABEL[a.severity])}</span> {tk ? <bdi dir="ltr">{tk.plate}</bdi> : null}
                        {tk ? " · " : ""}
                        {alertMessage(a.message, lang)}
                        {a.state !== "open" ? ` — ${alertState(a.state)}` : ""}
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
                {alert ? alert.message : t("selectHint")}
                {alert && alert.state !== "resolved" && (
                  <div className="lnks" style={{ justifyContent: "center", marginTop: 10 }}>
                    {alert.state === "open" && (
                      <button disabled={!alertRole} onClick={() => alertAction("acknowledge", null, t("alertAcked"))}>
                        {t("acknowledge")}
                      </button>
                    )}
                    <button disabled={!alertRole} onClick={() => alertAction("resolve", null, t("alertResolved"))}>
                      {t("resolve")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="tk-h">
                  <b dir="ltr">{tanker.plate}</b>
                  <span className={`tag ${tanker.service_type}`}>{typeLabel(tanker.service_type)}</span>
                </div>
                {alert && (
                  <div className={`tk-al ${alert.severity}`}>
                    <b>
                      {alertType(alert.type)} · {alertState(alert.state)}
                    </b>
                    <span>{alertMessage(alert.message, lang)}</span>
                    {alert.action_note && <span>{t("noteX", { note: alert.action_note })}</span>}
                  </div>
                )}
                {tanker.blocked && (
                  <div className="tk-al high">
                    <b>{t("suspended")}</b>
                    <span>{tanker.blocked_reason}</span>
                  </div>
                )}
                <div className="kvr">
                  <div>
                    <span>{t("owner")}</span>
                    <b>{one(tanker.company)?.name ?? t("independent")}</b>
                  </div>
                  <div>
                    <span>{t("driver")}</span>
                    <b>{drv?.full_name || t("unassigned")}</b>
                  </div>
                  <div>
                    <span>{t("permit")}</span>
                    <b style={{ color: permit?.valid ? undefined : "var(--bad)" }}>{permit?.text}</b>
                  </div>
                  <div>
                    <span>{t("gps")}</span>
                    <b>
                      {tanker.last_fix_at ? <FixQuality source={tanker.last_fix_source} accuracy={tanker.last_accuracy_m} /> : null}{" "}
                      {tAge == null ? t("noFixYet") : t("fixAgo", { ago: since(tAge) })}
                    </b>
                  </div>
                  <div>
                    <span>{t("zone")}</span>
                    <b>
                      {zoneOf(tanker.last_lat != null && tanker.last_lng != null ? { lat: tanker.last_lat, lng: tanker.last_lng } : null) ?? t("outsideZones")} ·{" "}
                      {tanker.blocked ? t("suspended") : tanker.is_online ? t("online") : t("offline")}
                    </b>
                  </div>
                  <div>
                    <span>{t("currentJob")}</span>
                    <b>
                      {job ? (
                        <Link className="lk" href={`/nws/orders/${job.id}`}>
                          <bdi dir="ltr">{orderNo(job.order_no)}</bdi> · {statusWord(job)}
                        </Link>
                      ) : (
                        t("none")
                      )}
                    </b>
                  </div>
                </div>
                {alert && alert.state !== "resolved" ? (
                  <div className="tk-act">
                    <button className="btn bad" disabled={!alertRole} title={roleTip(alertRole, "rolesAlert")} onClick={() => setDlg(ALERT_RULE.has(alert.type) ? "alertPenalty" : "alertPenaltyPick")}>
                      {t("issuePenalty")}
                    </button>
                    {alert.action_note === "Inspector dispatched" ? (
                      <button className="btn" disabled title={t("inspectorOnWay")}>
                        {t("inspectorSent")}
                      </button>
                    ) : (
                      <button className="btn" disabled={!alertRole} title={roleTip(alertRole, "rolesAlert")} onClick={() => alertAction("inspector", null, t("inspectorToday"))}>
                        {t("sendInspector")}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="tk-act">
                    <button className="btn bad" disabled={!penaltyRole} title={roleTip(penaltyRole, "rolesAlert")} onClick={() => setDlg("penalty")}>
                      {t("issuePenalty")}
                    </button>
                    <button
                      className="btn"
                      disabled={!inspectRole}
                      title={roleTip(inspectRole, "rolesInspect")}
                      onClick={async () => {
                        if (await rpc("staff_record_inspection", { p_tanker_id: tanker.id, p_permit_id: null, p_result: "scheduled", p_notes: "Sent from Live operations" }, t("inspectionBooked"))) load();
                      }}
                    >
                      {t("sendInspector")}
                    </button>
                  </div>
                )}
                <div className="lnks">
                  {alert && alert.state === "open" && (
                    <button disabled={!alertRole} title={roleTip(alertRole, "rolesAlert")} onClick={() => alertAction("acknowledge", null, t("alertAcked"))}>
                      {t("acknowledge")}
                    </button>
                  )}
                  {alert && alert.state !== "resolved" && (
                    <button disabled={!alertRole} title={roleTip(alertRole, "rolesAlert")} onClick={() => alertAction("resolve", null, t("alertResolved"))}>
                      {t("resolve")}
                    </button>
                  )}
                  {!tanker.blocked && (
                    <button disabled={!isOp} title={roleTip(isOp, "rolesOp")} onClick={() => setDlg(alert && alert.state !== "resolved" ? "alertSuspend" : "suspend")}>
                      {t("suspendTanker")}
                    </button>
                  )}
                  <button
                    onClick={() =>
                      drv ? toast(t("calling", { name: drv.full_name || t("theDriver"), phone: maskPhone(drv.phone) })) : toast(t("noDriver"), true)
                    }
                  >
                    {t("callDriver")}
                  </button>
                  <button onClick={() => tripHistory(tanker)}>{t("tripHistory")}</button>
                  <Link href={`/nws/fleet?tanker=${tanker.id}`}>{t("openInFleet")}</Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {dlg === "alertPenalty" && alert && (
        <ReasonDialog
          title={t("penaltyTitle", { x: alertType(alert.type) })}
          body={t("penaltyBody")}
          confirm={t("issuePenalty")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => alertAction("penalty", r, t("penaltyIssued"))}
        />
      )}
      {dlg === "alertSuspend" && alert && tanker && (
        <ReasonDialog
          title={t("suspendTitle", { plate: tanker.plate })}
          body={t("suspendBodyAlert")}
          confirm={t("suspendTanker")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(r) => alertAction("suspend", r, t("suspendedX", { plate: tanker.plate }))}
        />
      )}
      {dlg === "suspend" && tanker && (
        <ReasonDialog
          title={t("suspendTitle", { plate: tanker.plate })}
          body={t("suspendBody")}
          confirm={t("suspendTanker")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (r) => {
            if (await rpc("staff_block_tanker", { p_tanker_id: tanker.id, p_reason: r }, t("suspendedX", { plate: tanker.plate }))) {
              setDlg(null);
              load();
            }
          }}
        />
      )}
      {dlg === "alertPenaltyPick" && alert && (
        <PenaltyDialog
          title={t("penaltyTitle", { x: alertType(alert.type) })}
          tankerId={alert.tanker_id}
          orderId={alert.order_id}
          onClose={() => setDlg(null)}
          onDone={() => alertAction("resolve", "Penalty issued from the framework", t("penaltyIssuedResolved"))}
        />
      )}
      {dlg === "penalty" && tanker && <PenaltyDialog title={t("penaltyTitle", { x: tanker.plate })} tankerId={tanker.id} orderId={job?.id ?? null} onClose={() => setDlg(null)} onDone={load} />}
    </>
  );
}
