"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Map } from "@/components/Map";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { Loading, TopBar } from "@/components/Shell";
import { useProfile } from "@/components/useProfile";
import { useToast } from "@/components/useToast";
import { errorCode, friendlyError } from "@/lib/errors";
import { FEED_CHANNEL, GONE_EVENT } from "@/lib/feed";
import { DEFAULT_CENTER, distanceKm } from "@/lib/geo";
import { omrValue, SERVICE_LABEL } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { LngLat, OpenRequest, Order, OrderLocation, Profile, Tanker } from "@/lib/types";

const PING_MS = 10_000;
const REFRESH_MS = 15_000;
const SIMULATION = process.env.NEXT_PUBLIC_ENABLE_SIMULATION === "true";

type Job = { order: Order; loc: OrderLocation | null; customer: Pick<Profile, "full_name" | "phone"> | null };

export default function DriverHome() {
  const router = useRouter();
  const profile = useProfile("driver");
  const toast = useToast();
  const [tanker, setTanker] = useState<Tanker | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [ready, setReady] = useState(false);
  const [requests, setRequests] = useState<OpenRequest[]>([]);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [earnedToday, setEarnedToday] = useState(0);

  const [gps, setGps] = useState<LngLat | null>(null);
  const [gpsError, setGpsError] = useState(false);
  const [simulate, setSimulate] = useState(SIMULATION);
  const [simPos, setSimPos] = useState<LngLat | null>(null);
  const feed = useRef<RealtimeChannel | null>(null);

  const online = tanker?.is_online ?? false;
  const onJob = Boolean(job);
  const me = onJob && simulate ? simPos : gps;
  const meRef = useRef<LngLat | null>(me);
  const gpsRef = useRef<LngLat | null>(gps);
  useEffect(() => {
    meRef.current = me;
    gpsRef.current = gps;
  });

  const loadJob = useCallback(async (driverId: string) => {
    const db = supabase();
    const { data: order } = await db
      .from("orders")
      .select("*")
      .eq("driver_id", driverId)
      .in("status", ["accepted", "arriving", "arrived"])
      .maybeSingle<Order>();
    if (!order) return null;
    const [{ data: loc }, { data: customer }] = await Promise.all([
      db.from("order_locations").select("*").eq("order_id", order.id).maybeSingle<OrderLocation>(),
      db.from("profiles").select("full_name, phone").eq("id", order.customer_id).maybeSingle(),
    ]);
    return { order, loc, customer } as Job;
  }, []);

  const loadEarnings = useCallback((driverId: string) => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    supabase()
      .from("orders")
      .select("driver_earnings")
      .eq("driver_id", driverId)
      .eq("status", "delivered")
      .gte("delivered_at", midnight.toISOString())
      .then(({ data }) => setEarnedToday((data ?? []).reduce((s, r) => s + Number(r.driver_earnings), 0)));
  }, []);

  // Tanker + any job already in progress.
  useEffect(() => {
    if (!profile) return;
    const db = supabase();
    Promise.all([db.from("tankers").select("*").eq("driver_id", profile.id).maybeSingle<Tanker>(), loadJob(profile.id)]).then(
      ([{ data: t }, j]) => {
        if (!t) return router.replace("/onboarding");
        setTanker(t);
        setJob(j);
        setReady(true);
      },
    );
    loadEarnings(profile.id);
  }, [profile, router, loadJob, loadEarnings]);

  // GPS while online or on a job.
  useEffect(() => {
    if (!(online || onJob) || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        setGpsError(false);
        setGps({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => setGpsError(true),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [online, onJob]);

  // ---------------------------------------------------------------- requests
  const refreshRequests = useCallback(() => {
    const at = meRef.current ?? DEFAULT_CENTER;
    supabase()
      .rpc("open_requests_near", { p_lat: at.lat, p_lng: at.lng })
      .then(({ data, error }) => {
        if (!error) setRequests((data ?? []) as OpenRequest[]);
      });
  }, []);

  useEffect(() => {
    if (!online || onJob) return;
    refreshRequests();
    const db = supabase();
    const ch = db
      .channel(FEED_CHANNEL, { config: { broadcast: { self: false } } })
      // New requests arrive via Postgres Changes; RLS lets drivers see status = 'requested'.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, () => refreshRequests())
      // Accepted/cancelled requests vanish from RLS, so peers announce them here.
      .on("broadcast", { event: GONE_EVENT }, ({ payload }) => setRequests((rs) => rs.filter((r) => r.id !== payload?.id)))
      .subscribe();
    feed.current = ch;
    const timer = setInterval(refreshRequests, REFRESH_MS);
    return () => {
      clearInterval(timer);
      feed.current = null;
      db.removeChannel(ch);
    };
  }, [online, onJob, refreshRequests]);

  // Re-sort once the first real GPS fix replaces the fallback position.
  const haveFix = Boolean(gps);
  useEffect(() => {
    if (online && !onJob && haveFix) refreshRequests();
  }, [online, onJob, haveFix, refreshRequests]);

  async function toggleOnline() {
    if (!tanker || onJob) return;
    const next = !online;
    setTanker({ ...tanker, is_online: next });
    const { error } = await supabase().from("tankers").update({ is_online: next }).eq("driver_id", tanker.driver_id);
    if (error) {
      setTanker({ ...tanker, is_online: !next });
      toast.show(friendlyError(error));
    }
    if (!next) setRequests([]);
  }

  async function accept(id: string) {
    if (!profile) return;
    setAccepting(id);
    const { error } = await supabase().rpc("accept_order", { p_order_id: id }).single<Order>();
    if (error) {
      setAccepting(null);
      toast.show(friendlyError(error));
      if (["already_taken", "not_eligible"].includes(errorCode(error) ?? "")) setRequests((rs) => rs.filter((r) => r.id !== id));
      return;
    }
    feed.current?.send({ type: "broadcast", event: GONE_EVENT, payload: { id } });
    const j = await loadJob(profile.id);
    setAccepting(null);
    setSimPos(null);
    setJob(j);
  }

  // ---------------------------------------------------------------- active job
  const jobId = job?.order.id;
  const dest = job?.loc ? { lat: job.loc.lat, lng: job.loc.lng } : null;
  const destRef = useRef(dest);
  useEffect(() => {
    destRef.current = dest;
  });

  // Own job updates (e.g. accepted → arriving after the first GPS ping).
  useEffect(() => {
    if (!jobId) return;
    const db = supabase();
    const ch = db
      .channel(`job-${jobId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${jobId}` }, (payload) =>
        setJob((j) => (j && j.order.id === jobId ? { ...j, order: { ...j.order, ...(payload.new as Order) } } : j)),
      )
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [jobId]);

  // Send GPS every 10 s while on the job (simulated drive in dev, if enabled).
  useEffect(() => {
    if (!jobId) return;
    const tick = () => {
      let pos = meRef.current;
      if (simulate && destRef.current) {
        pos = simulateStep(pos ?? gpsStart(destRef.current, gpsRef.current), destRef.current);
        meRef.current = pos;
        setSimPos(pos);
      }
      if (pos) supabase().rpc("report_location", { p_lat: pos.lat, p_lng: pos.lng }).then();
    };
    const first = setTimeout(tick, 0); // ping straight away so the job flips to 'arriving'
    const timer = setInterval(tick, PING_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [jobId, simulate]);

  async function advance(fn: "mark_arrived" | "mark_delivered") {
    if (!job || !profile) return;
    setActing(true);
    const { data, error } = await supabase().rpc(fn, { p_order_id: job.order.id }).single<Order>();
    setActing(false);
    if (error) return toast.show(friendlyError(error));
    if (fn === "mark_delivered") {
      toast.show(`Delivered · you earned ${omrValue(data.driver_earnings)}`);
      setJob(null);
      setSimPos(null);
      loadEarnings(profile.id);
    } else {
      setJob({ ...job, order: data });
    }
  }

  if (!profile || !ready || !tanker) return <Loading />;

  const toggle = (
    <button className="switch" role="switch" aria-checked={online} onClick={toggleOnline} disabled={onJob} title={onJob ? "Finish the job first" : undefined}>
      <span className="track" aria-hidden="true" />
      {online ? "Online" : "Offline"}
    </button>
  );

  if (job) {
    const o = job.order;
    const away = me && dest ? distanceKm(me, dest) : null;
    return (
      <>
        <TopBar subtitle={tanker.plate} />
        <main className="screen flush">
          <Map center={dest ?? me ?? DEFAULT_CENTER} destination={dest} me={me} follow className="tall" />
          <section className="sheet">
            <div className="ptop">
              <div>
                <h3>
                  <TypeTag type={o.service_type} /> {o.gallons.toLocaleString()} gal
                </h3>
                <span className="sub">
                  {o.area}
                  {away != null ? ` · ${away < 1 ? `${Math.round(away * 1000)} m` : `${away.toFixed(1)} km`} away` : ""}
                </span>
              </div>
              <StatusPill status={o.status} />
            </div>

            <div className="card">
              <dl className="kv">
                <dt>Customer</dt>
                <dd>{job.customer?.full_name || "—"}</dd>
                {job.customer?.phone && (
                  <>
                    <dt>Phone</dt>
                    <dd>
                      <a href={`tel:${job.customer.phone}`}>{job.customer.phone}</a>
                    </dd>
                  </>
                )}
                <dt>Address</dt>
                <dd>{job.loc?.address || "Pin on map"}</dd>
                <dt>Earnings</dt>
                <dd>{omrValue(o.driver_earnings)}</dd>
              </dl>
            </div>

            {dest && (
              <a className="cta sec" href={`https://www.openstreetmap.org/directions?route=%3B${dest.lat}%2C${dest.lng}`} target="_blank" rel="noreferrer">
                Open directions
              </a>
            )}

            {gpsError && !simulate && <div className="note bad">Location is off — the customer can’t see you moving. Allow location access.</div>}
            {SIMULATION && (
              <label className="note small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
                Simulate drive (dev): move toward the customer on each 10 s ping
              </label>
            )}

            {o.status !== "arrived" ? (
              <button className="cta" disabled={acting} onClick={() => advance("mark_arrived")}>
                {acting ? "Saving…" : "Mark arrived"}
              </button>
            ) : (
              <button className="cta" disabled={acting} onClick={() => advance("mark_delivered")}>
                {acting ? "Saving…" : "Mark delivered"}
              </button>
            )}
            <p className="mut small" style={{ textAlign: "center" }}>
              Sharing your location every 10 seconds while on this job.
            </p>
          </section>
          {toast.node}
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar subtitle={tanker.plate} />
      <main className="screen">
        <div className="card">
          <div className="row">
            <div>
              <h4>
                <TypeTag type={tanker.service_type} /> {tanker.capacity_gal.toLocaleString()} gal
              </h4>
              <p>
                {SERVICE_LABEL[tanker.service_type]} · today {omrValue(earnedToday)}
              </p>
            </div>
            {toggle}
          </div>
        </div>

        {!online ? (
          <div className="empty">You’re offline. Go online to see nearby requests.</div>
        ) : (
          <>
            <div className="ptop" style={{ marginTop: 6 }}>
              <h3>Open requests</h3>
              <span className="sub">Nearest first</span>
            </div>
            {!gps && <div className="note">{gpsError ? "Location unavailable — distances are from central Muscat." : "Getting your location…"}</div>}
            {requests.length === 0 ? (
              <div className="empty">No matching requests right now. New ones appear here instantly.</div>
            ) : (
              requests.map((r) => (
                <div key={r.id} className="card">
                  <div className="row" style={{ alignItems: "flex-start" }}>
                    <div>
                      <h4>
                        <TypeTag type={r.service_type} /> {r.gallons.toLocaleString()} gal
                      </h4>
                      <p>
                        {r.area} · {Number(r.distance_km).toFixed(1)} km
                      </p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <b className="num" style={{ fontSize: 17 }}>
                        {omrValue(r.driver_earnings)}
                      </b>
                      <p className="mut small">you earn</p>
                    </div>
                  </div>
                  <button className="btn pri" style={{ width: "100%", marginTop: 10 }} disabled={accepting !== null} onClick={() => accept(r.id)}>
                    {accepting === r.id ? "Accepting…" : "Accept job"}
                  </button>
                </div>
              ))
            )}
          </>
        )}
        {toast.node}
      </main>
    </>
  );
}

// Start a simulated drive from the real fix if it's plausible, else ~2.5 km out.
function gpsStart(dest: LngLat, fix: LngLat | null): LngLat {
  if (fix && distanceKm(fix, dest) < 30) return fix;
  return { lat: dest.lat + 0.018, lng: dest.lng - 0.014 };
}

// Cover a quarter of the remaining distance per ping (at least ~120 m).
function simulateStep(from: LngLat, to: LngLat): LngLat {
  const left = distanceKm(from, to);
  if (left < 0.03) return to;
  const f = Math.min(1, Math.max(0.25, 0.12 / left));
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}
