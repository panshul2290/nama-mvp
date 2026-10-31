"use client";

// Control-room wall screen: the live GPS map for a monitor or video wall, opened in its own window
// from Live operations. Full-window dark map, big markers coloured by trip state, a strip of live
// counts with the Oman clock, a visual (silent) SOS banner and a rolling ticker of high alerts.
// Built to run unattended: realtime reconnects, a periodic refetch backs it up, and an ended
// session shows a sign-in panel instead of a blank map.
// URL: /nws/wall[?zone=<zone id or name>][&rotate=<seconds>][&test=1][&theme=dark]
import "./wall.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, NamaLogo } from "@/components/icons";
import { alertMessage } from "@/components/nws/alertText";
import { FleetMap } from "@/components/nws/FleetMap";
import type { MapFrame, MapOrder, MapSite, MapTanker, MapZone } from "@/components/nws/FleetMapView";
import { permitSummary, type Permit } from "@/components/nws/fleetData";
import { OPS } from "@/components/nws/i18n/ops";
import { WALL } from "@/components/nws/i18n/wall";
import { one, SOS_BANNER_MS, useNow } from "@/components/nws/ops";
import { useFmt } from "@/components/portal/i18n";
import { STALE_AFTER_S } from "@/lib/gps";
import { orderNo } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { circlePolygon } from "@/lib/mapStyle";
import { supabase } from "@/lib/supabase/client";
import { inTestArea, useTestAreas } from "@/lib/testArea";
import { ON_JOB_STATUSES, type OrderStatus } from "@/lib/types";
import type { ServiceType } from "@/lib/pricing";

type Tk = {
  id: string; plate: string; service_type: ServiceType; is_online: boolean; blocked: boolean;
  last_lat: number | null; last_lng: number | null; location_age_s: number | null;
  company: { name: string } | { name: string }[] | null; permits: Permit[];
};
type Ord = { id: string; order_no: number; service_type: ServiceType; gallons: number; status: OrderStatus; tanker_id: string | null; is_test: boolean; loc: { lat: number; lng: number } | { lat: number; lng: number }[] | null };
type Al = { id: number; tanker_id: string | null; type: string; severity: "high" | "med" | "low"; message: string; lat: number | null; lng: number | null; state: string; created_at: string };
type Zone = { id: string; name: string; governorate_code: string | null; center_lat: number; center_lng: number; radius_km: number; is_test: boolean; min_lat: number | null; max_lat: number | null; min_lng: number | null; max_lng: number | null };
type Gov = { code: string; name: string; name_ar: string; sort: number };
type Site = { id: string; code: string; kind: "fill" | "discharge"; name: string; lat: number; lng: number; radius_m: number };
type Box = [number, number, number, number]; // west, south, east, north

const ACTIVE: OrderStatus[] = ["requested", "accepted", "arriving", "arrived", "collected"];
const OMAN: Box = [51.9, 16.6, 59.9, 26.4];
const REFETCH_MS = 20_000;
const IDLE_MS = 4_000;
const KEEPALIVE_MS = 4 * 60_000;

function zoneBox(z: Zone): Box {
  if (z.min_lat != null && z.max_lat != null && z.min_lng != null && z.max_lng != null) return [z.min_lng, z.min_lat, z.max_lng, z.max_lat];
  const dLat = z.radius_km / 110.574;
  const dLng = z.radius_km / (111.32 * Math.cos((z.center_lat * Math.PI) / 180));
  return [z.center_lng - dLng, z.center_lat - dLat, z.center_lng + dLng, z.center_lat + dLat];
}
function zoneShape(z: Zone): GeoJSON.Polygon {
  if (z.min_lat != null && z.max_lat != null && z.min_lng != null && z.max_lng != null)
    return { type: "Polygon", coordinates: [[[z.min_lng, z.min_lat], [z.max_lng, z.min_lat], [z.max_lng, z.max_lat], [z.min_lng, z.max_lat], [z.min_lng, z.min_lat]]] };
  return circlePolygon(z.center_lat, z.center_lng, z.radius_km * 1000);
}
const union = (boxes: Box[]): Box | null =>
  boxes.length ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))] : null;
// A box around points, padded so a single tanker isn't framed at street level.
function pointsBox(pts: { lat: number; lng: number }[]): Box | null {
  if (!pts.length) return null;
  const w = Math.min(...pts.map((p) => p.lng)), e = Math.max(...pts.map((p) => p.lng));
  const s = Math.min(...pts.map((p) => p.lat)), n = Math.max(...pts.map((p) => p.lat));
  const pad = 0.02;
  return [w - pad, s - pad, e + pad, n + pad];
}

export default function WallPage() {
  return (
    <Suspense fallback={null}>
      <Wall />
    </Suspense>
  );
}

function Wall() {
  const t = useT(WALL);
  const to = useT(OPS);
  const f = useFmt();
  const { lang } = useLang();
  const params = useSearchParams();
  const zoneParam = params.get("zone");
  const withTest = params.get("test") === "1";
  // Street map like the customer and driver apps; ?theme=dark for a darkened room.
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const rotateS = Number(params.get("rotate")) > 0 ? Math.max(15, Number(params.get("rotate"))) : 0;
  const testAreas = useTestAreas();

  const [tankers, setTankers] = useState<Tk[]>([]);
  const [orders, setOrders] = useState<Ord[]>([]);
  const [alerts, setAlerts] = useState<Al[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [govs, setGovs] = useState<Gov[]>([]);
  const [siteRows, setSiteRows] = useState<Site[]>([]);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(true); // realtime channel joined
  const [netOk, setNetOk] = useState(true); // last refetch reached the server
  const [signedOut, setSignedOut] = useState(false);
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  const [rot, setRot] = useState(0);
  const [recentre, setRecentre] = useState(0);
  const now = useNow(1000);

  const load = useCallback(async () => {
    const db = supabase();
    const [tk, o, a] = await Promise.all([
      db
        .from("tankers")
        .select("id, plate, service_type, is_online, blocked, last_lat, last_lng, location_age_s, company:companies(name), permits(id, permit_no, type, status, issued_at, expires_at)")
        .eq("on_platform", true),
      db.from("orders").select("id, order_no, service_type, gallons, status, tanker_id, is_test, loc:order_locations(lat, lng)").in("status", ACTIVE),
      db.from("alerts").select("id, tanker_id, type, severity, message, lat, lng, state, created_at").neq("state", "resolved").order("created_at", { ascending: false }).limit(500),
    ]);
    const err = tk.error ?? o.error ?? a.error;
    if (err) {
      // A missing session reads as "permission denied" or a JWT error: say so instead of a blank map.
      const { data } = await db.auth.getSession();
      if (!data.session) setSignedOut(true);
      setNetOk(false);
      return;
    }
    setTankers((tk.data ?? []) as unknown as Tk[]);
    setOrders((o.data ?? []) as unknown as Ord[]);
    setAlerts((a.data ?? []) as Al[]);
    setFetchedAt(Date.now());
    setNetOk(true);
    setLoaded(true);
  }, []);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Reference data, then the first load and the periodic refetch (a backstop for realtime).
  useEffect(() => {
    const db = supabase();
    Promise.all([
      db.from("zones").select("id, name, governorate_code, center_lat, center_lng, radius_km, is_test, min_lat, max_lat, min_lng, max_lng").eq("active", true),
      db.from("governorates").select("code, name, name_ar, sort").order("sort"),
      db.from("sites").select("id, code, kind, name, lat, lng, radius_m").eq("active", true).eq("is_test", false),
    ]).then(([z, g, s]) => {
      setZones((z.data ?? []) as Zone[]);
      setGovs((g.data ?? []) as Gov[]);
      setSiteRows((s.data ?? []) as Site[]);
    });
    const first = setTimeout(() => loadRef.current(), 0);
    const poll = setInterval(() => loadRef.current(), REFETCH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, []);

  // Realtime with reconnect: a dropped channel is rebuilt after a pause and the board reloads on rejoin.
  useEffect(() => {
    const db = supabase();
    let ch: ReturnType<typeof db.channel> | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let deb: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const soon = () => {
      if (deb) return;
      deb = setTimeout(() => {
        deb = undefined;
        loadRef.current();
      }, 3000);
    };
    const connect = () => {
      let mine = db.channel(`nws-wall-${Date.now()}`);
      for (const table of ["tankers", "orders", "alerts"]) mine = mine.on("postgres_changes", { event: "*", schema: "public", table }, soon);
      ch = mine;
      mine.subscribe((status) => {
        if (stopped || ch !== mine) return;
        if (status === "SUBSCRIBED") {
          setLive(true);
          loadRef.current();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setLive(false);
          clearTimeout(retry);
          retry = setTimeout(() => {
            ch = null;
            db.removeChannel(mine);
            if (!stopped) connect();
          }, 5000);
        }
      });
    };
    connect();
    const back = () => {
      setNetOk(true);
      loadRef.current();
    };
    const gone = () => setNetOk(false);
    window.addEventListener("online", back);
    window.addEventListener("offline", gone);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(deb);
      if (ch) db.removeChannel(ch);
      window.removeEventListener("online", back);
      window.removeEventListener("offline", gone);
    };
  }, []);

  // Session: keep it fresh for a 24/7 screen, and show a sign-in panel when it ends.
  useEffect(() => {
    const db = supabase();
    const { data } = db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (!session && event !== "INITIAL_SESSION")) setSignedOut(true);
      else if (session) setSignedOut(false);
    });
    const keep = setInterval(() => {
      db.auth.getSession().then(({ data: s }) => !s.session && setSignedOut(true));
    }, KEEPALIVE_MS);
    return () => {
      data.subscription.unsubscribe();
      clearInterval(keep);
    };
  }, []);

  // Full screen (needs a click or key press), F / R shortcuts, and hiding the cursor and controls when idle.
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    let tm: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setIdle(false);
      clearTimeout(tm);
      tm = setTimeout(() => setIdle(true), IDLE_MS);
    };
    const key = (e: KeyboardEvent) => {
      wake();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") toggleFull();
      if (e.key === "r" || e.key === "R") setRecentre(Date.now());
    };
    const fs = () => setFull(Boolean(document.fullscreenElement));
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", key);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      clearTimeout(tm);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", key);
      document.removeEventListener("fullscreenchange", fs);
    };
  }, [toggleFull]);

  // Governorates to cycle through (?rotate=N): the boxes of their active zones, then all of Oman.
  const stops = useMemo(() => {
    const out: { key: string; name: string; box: Box }[] = [];
    for (const g of govs) {
      const box = union(zones.filter((z) => !z.is_test && z.governorate_code === g.code).map(zoneBox));
      if (box) out.push({ key: g.code, name: lang === "ar" ? g.name_ar : g.name, box });
    }
    if (withTest) for (const z of zones.filter((z) => z.is_test)) out.push({ key: z.id, name: z.name, box: zoneBox(z) });
    return [{ key: "all", name: t("allOman"), box: OMAN }, ...out];
  }, [govs, zones, lang, withTest, t]);
  useEffect(() => {
    if (!rotateS || stops.length < 2) return;
    const tm = setInterval(() => setRot((i) => (i + 1) % stops.length), rotateS * 1000);
    return () => clearInterval(tm);
  }, [rotateS, stops.length]);
  const focusZone = zoneParam ? zones.find((z) => z.id === zoneParam || z.name.toLowerCase() === zoneParam.toLowerCase()) : undefined;

  // What's on the board: test-zone tankers, orders and alerts only with ?test=1 (0020).
  const isTest = useCallback((p: { lat: number | null; lng: number | null }) => p.lat != null && p.lng != null && inTestArea({ lat: p.lat, lng: p.lng }, testAreas), [testAreas]);
  const board = useMemo(() => {
    const tk = tankers.filter((x) => withTest || !isTest({ lat: x.last_lat, lng: x.last_lng }));
    const ord = orders.filter((o) => withTest || !o.is_test);
    const al = alerts.filter((a) => withTest || !isTest(a));
    const onJob = new Set(ord.filter((o) => o.tanker_id && ON_JOB_STATUSES.includes(o.status)).map((o) => o.tanker_id as string));
    const openAl = al.filter((a) => a.state === "open" || a.type === "SOS");
    return { tk, ord, al: openAl, onJob };
  }, [tankers, orders, alerts, withTest, isTest]);

  const age = useCallback((x: Tk) => (x.location_age_s == null ? null : x.location_age_s + Math.max(0, now - fetchedAt) / 1000), [now, fetchedAt]);
  const online = board.tk.filter((x) => x.is_online);
  const trip = online.filter((x) => board.onJob.has(x.id));
  const stale = online.filter((x) => {
    const a = age(x);
    return a == null || a > STALE_AFTER_S;
  });
  const noPermit = board.tk.filter((x) => !permitSummary(x, now, lang).valid);
  const openOrders = board.ord.length;
  // Open SOS on the map all along; the flashing band only for SOS_BANNER_MS, until acknowledged.
  const sos = board.al.filter((a) => a.type === "SOS");
  const sosBand = sos.filter((a) => a.state === "open" && now - Date.parse(a.created_at) < SOS_BANNER_MS);
  const high = board.al.filter((a) => a.severity === "high" && a.type !== "SOS").slice(0, 12);

  const sosTankers = useMemo(() => new Set(board.al.filter((a) => a.type === "SOS").map((a) => a.tanker_id)), [board.al]);
  // GPS age only moves the "stale" flag, so it's worked out per fetch (not per clock tick) to keep the map still.
  const mapTankers = useMemo<MapTanker[]>(() => {
    const flagged = new Set(board.al.map((a) => a.tanker_id));
    const at = fetchedAt;
    return board.tk
      .filter((x) => (x.is_online || flagged.has(x.id)) && x.last_lat != null && x.last_lng != null)
      .map((x) => {
        const a = x.location_age_s == null ? null : x.location_age_s + Math.max(0, at - fetchedAt) / 1000;
        const company = one(x.company)?.name;
        return {
          id: x.id, lat: x.last_lat as number, lng: x.last_lng as number, type: x.service_type,
          stale: a == null || a > STALE_AFTER_S, blocked: x.blocked || !permitSummary(x, at, "en").valid || sosTankers.has(x.id),
          status: board.onJob.has(x.id) ? "trip" : "idle",
          label: [x.plate, company].filter(Boolean).join(" · "),
        };
      });
  }, [board, fetchedAt, sosTankers]);
  const mapOrders = useMemo<MapOrder[]>(
    () =>
      board.ord
        .map((o) => ({ o, l: one(o.loc) }))
        .filter(({ l }) => l)
        .map(({ o, l }) => ({ id: o.id, lat: l!.lat, lng: l!.lng, type: o.service_type, label: `${orderNo(o.order_no)} · ${o.gallons} gal` })),
    [board.ord],
  );
  const rings = useMemo(() => board.al.filter((a) => a.lat != null && a.lng != null && (a.severity === "high" || a.type === "SOS")).map((a) => ({ lat: a.lat as number, lng: a.lng as number })), [board.al]);
  const mapZones = useMemo<MapZone[]>(() => zones.filter((z) => withTest || !z.is_test).map((z) => ({ id: z.id, test: z.is_test, geometry: zoneShape(z) })), [zones, withTest]);
  const sites = useMemo<MapSite[]>(() => siteRows.map((x) => ({ ...x, label: `${x.code} · ${x.name}` })), [siteRows]);

  // Framing: a chosen zone, the rotation, or every tanker on the board (refitted each minute unless the operator panned).
  const minute = Math.floor(now / 60_000);
  const fitBox = useMemo(() => pointsBox([...mapTankers, ...mapOrders]), [mapTankers, mapOrders]);
  const frame = useMemo<MapFrame>(() => {
    if (focusZone) return { key: `zone-${focusZone.id}-${recentre}`, bounds: zoneBox(focusZone), force: recentre > 0 };
    if (rotateS && stops.length > 1) {
      const s = stops[rot % stops.length];
      return { key: `rot-${s.key}-${rot}-${recentre}`, bounds: s.box, force: true };
    }
    return { key: `fit-${minute}-${recentre}-${loaded}`, bounds: fitBox ?? OMAN, force: recentre > 0 && minute === Math.floor(recentre / 60_000) };
  }, [focusZone, rotateS, stops, rot, minute, recentre, fitBox, loaded]);
  const where = focusZone ? focusZone.name : rotateS && stops.length > 1 ? stops[rot % stops.length].name : null;

  const ok = live && netOk;
  const tkOf = (id: string | null) => tankers.find((x) => x.id === id);
  const signIn = `/login?app=nws&next=${encodeURIComponent(`/nws/wall${params.toString() ? `?${params.toString()}` : ""}`)}`;
  const alertType = (ty: string) => (OPS[`at_${ty}`] ? to(`at_${ty}`) : ty);

  return (
    <div className={`wall ${theme} ${idle ? "idle" : ""} ${sosBand.length ? "has-sos" : ""}`}>
      <div className="wall-map">
        <FleetMap tankers={mapTankers} orders={mapOrders} sites={sites} alerts={rings} zones={mapZones} frame={frame} big theme={theme} key={theme} />
      </div>

      <header className="wall-top">
        <div className="wall-brand">
          <NamaLogo />
          <span>
            <b>{t("title")}</b>
            <small>
              {where ?? t("allOman")}
              {withTest ? ` · ${t("testOn")}` : ""}
            </small>
          </span>
        </div>
        <div className="wall-kpis" role="status" aria-live="polite">
          <Kpi label={t("kOnline")} value={loaded ? f.n(online.length) : "—"} />
          <Kpi label={t("kTrip")} value={loaded ? f.n(trip.length) : "—"} tone="trip" />
          <Kpi label={t("kIdle")} value={loaded ? f.n(online.length - trip.length) : "—"} tone="idle" />
          <Kpi label={t("kOffline")} value={loaded ? f.n(board.tk.length - online.length) : "—"} tone="off" />
          <Kpi label={t("kNoPermit")} value={loaded ? f.n(noPermit.length) : "—"} tone={noPermit.length ? "bad" : ""} />
          <Kpi label={t("kStale")} value={loaded ? f.n(stale.length) : "—"} tone={stale.length ? "warn" : ""} />
          <Kpi label={t("kOrders")} value={loaded ? f.n(openOrders) : "—"} />
          <Kpi label={t("kAlerts")} value={loaded ? f.n(board.al.length) : "—"} tone={board.al.some((a) => a.severity === "high") ? "bad" : ""} />
        </div>
        <div className="wall-clock">
          <b dir="ltr">{f.d(f.fmt(now, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }))}</b>
          <small>
            {f.fmt(now, { weekday: "short", day: "numeric", month: "short" })} · {t("omanTime")}
          </small>
        </div>
      </header>

      {sosBand.length > 0 && (
        <div className="wall-sos" role="alert">
          <b>
            <Icon name="alert" /> {t("sos")} · {t("sosN", { n: f.n(sosBand.length) })}
          </b>
          {sosBand.slice(0, 3).map((a) => (
            <span key={a.id}>
              {tkOf(a.tanker_id) && <bdi dir="ltr">{tkOf(a.tanker_id)!.plate}</bdi>} {alertMessage(a.message, lang)} · {f.ago(a.created_at, now)}
            </span>
          ))}
        </div>
      )}

      <div className={`wall-conn ${ok ? "ok" : "bad"}`} role="status">
        <i />
        {ok ? `${t("live")} · ${fetchedAt ? t("updated", { ago: f.ago(new Date(fetchedAt).toISOString(), now) }) : "—"}` : t("lost")}
      </div>

      <div className="wall-ctl">
        <button type="button" onClick={toggleFull}>
          <Icon name={full ? "x" : "map"} />
          {full ? t("exitFull") : t("full")}
        </button>
        <button type="button" onClick={() => setRecentre(Date.now())}>
          {t("recentre")} (R)
        </button>
        <small>{t("tip")}</small>
      </div>

      <footer className="wall-bottom">
        <div className="wall-legend" aria-hidden="true">
          <span><i className="trip" />{t("lTrip")}</span>
          <span><i className="idle" />{t("lIdle")}</span>
          <span><i className="stale" />{t("lStale")}</span>
          <span><i className="blocked" />{t("lBlocked")}</span>
          <span><i className="order" />{t("lOrder")}</span>
        </div>
        <div className="wall-ticker" aria-label={t("kAlerts")}>
          {high.length === 0 ? (
            <span className="calm">{t("noAlerts")}</span>
          ) : (
            <div className="run" style={{ animationDuration: `${Math.max(30, high.length * 9)}s` }}>
              {[0, 1].map((copy) => (
                <span key={copy} aria-hidden={copy === 1 ? true : undefined}>
                  {high.map((a) => (
                    <em key={a.id}>
                      <b>{alertType(a.type)}</b> {alertMessage(a.message, lang)} · {f.ago(a.created_at, now)}
                    </em>
                  ))}
                </span>
              ))}
            </div>
          )}
        </div>
      </footer>

      {signedOut && (
        <div className="wall-out" role="alertdialog" aria-labelledby="wall-out-t">
          <div>
            <NamaLogo />
            <h2 id="wall-out-t">{t("signedOut")}</h2>
            <p>{t("signedOutB")}</p>
            <Link className="btn pri" href={signIn}>
              {t("signIn")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`wk ${tone}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
