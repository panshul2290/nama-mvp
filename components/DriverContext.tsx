"use client";

// Driver state shared by the Home, Jobs, Trip and Profile tabs. It lives in the
// driver layout, so location reporting keeps running while the driver switches tabs.
import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import { useProfile } from "@/components/useProfile";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { omrValue } from "@/lib/pricing";
import { buildDemoRoute, DEMO_MODE, positionAt, travelled, type SimRoute } from "@/lib/simulator";
import { supabase } from "@/lib/supabase/client";
import { MAX_ACCURACY_M, MOVING_INTERVAL_MS, shouldSend, type Fix, type Sent } from "@/lib/tracking";
import type { LngLat, Order, OrderLocation, Profile, Tanker } from "@/lib/types";

const PING_MS = MOVING_INTERVAL_MS; // decide every 10 s; shouldSend() applies the 15 m / 30 s rule
/** If no new fix has arrived for this long, ask the browser for one (some phones go quiet when stationary). */
const POKE_AFTER_MS = 8_000;
/** No usable fix for this long during a job → "Tracking paused". */
const NO_FIX_MS = 30_000;

export type TrackingIssue = "denied" | "hidden" | "nofix";
const ISSUE_TEXT: Record<TrackingIssue, string> = {
  denied: "Location permission is off. Allow location for this site in your browser settings.",
  hidden: "The app is in the background, so your location isn’t being shared.",
  nofix: "No GPS fix for 30 seconds. Check that location is on and you have a clear view of the sky.",
};

export type Job = { order: Order; loc: OrderLocation | null; customer: Pick<Profile, "full_name" | "phone"> | null };
export type SimState = { status: "loading" | "running" | "done"; totalKm: number; leftKm: number; source: "osrm" | "straight-line" };

type DriverState = {
  profile: Profile;
  tanker: Tanker;
  online: boolean;
  toggleOnline: () => Promise<void>;
  job: Job | null;
  /** Accepts atomically; resolves to the RPC error (if any) so the caller can react. */
  acceptJob: (orderId: string) => Promise<{ message?: string } | null>;
  advance: (fn: "mark_arrived" | "mark_delivered") => Promise<void>;
  acting: boolean;
  me: LngLat | null;
  getPosition: () => LngLat | null;
  hasFix: boolean;
  gpsError: boolean;
  /** Screen Wake Lock state during a job: held, unsupported, or failed. */
  wakeLock: "held" | "unsupported" | "failed" | "off";
  /** Demo trip simulator (NEXT_PUBLIC_DEMO_MODE=true only). */
  demoMode: boolean;
  sim: SimState | null;
  startSimulation: () => void;
  stopSimulation: () => void;
  today: { earned: number; jobs: number };
  toast: (m: string) => void;
};

const Ctx = createContext<DriverState | null>(null);

export function useDriver(): DriverState {
  const v = use(Ctx);
  if (!v) throw new Error("useDriver must be used inside the driver layout");
  return v;
}

export function DriverProvider({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const router = useRouter();
  const profile = useProfile("driver");
  const toast = useToast();
  const [tanker, setTanker] = useState<Tanker | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [ready, setReady] = useState(false);
  const [acting, setActing] = useState(false);
  const [today, setToday] = useState({ earned: 0, jobs: 0 });

  const [me, setMe] = useState<LngLat | null>(null);
  const [gpsError, setGpsError] = useState(false);
  const [trackingIssue, setTrackingIssue] = useState<TrackingIssue | null>(null);
  const [wakeLock, setWakeLock] = useState<"held" | "unsupported" | "failed" | "off">("off");
  const [sim, setSim] = useState<SimState | null>(null);
  const deniedRef = useRef(false);
  const lastFixAt = useRef(0); // when the last *usable* fix arrived (local clock)
  const fixRef = useRef<Fix | null>(null); // latest usable fix (accuracy ≤ 100 m)
  const lastSent = useRef<Sent | null>(null);
  const simRoute = useRef<{ route: SimRoute; startedAt: number } | null>(null);

  const online = tanker?.is_online ?? false;
  const onJob = Boolean(job);
  const meRef = useRef<LngLat | null>(me);
  useEffect(() => {
    meRef.current = me;
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

  const loadToday = useCallback((driverId: string) => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    supabase()
      .from("orders")
      .select("driver_earnings")
      .eq("driver_id", driverId)
      .eq("status", "delivered")
      .gte("delivered_at", midnight.toISOString())
      .then(({ data }) =>
        setToday({ earned: (data ?? []).reduce((s, r) => s + Number(r.driver_earnings), 0), jobs: (data ?? []).length }),
      );
  }, []);

  // Tanker + any job already in progress.
  useEffect(() => {
    if (!profile) return;
    const db = supabase();
    // RLS returns only the tanker assigned to this driver (tanker_assignments).
    Promise.all([db.from("tankers").select("*").maybeSingle<Tanker>(), loadJob(profile.id)]).then(
      ([{ data: t }, j]) => {
        if (!t) return router.replace("/onboarding");
        setTanker(t);
        setJob(j);
        setReady(true);
      },
    );
    loadToday(profile.id);
  }, [profile, router, loadJob, loadToday]);

  // One entry point for fixes, real or simulated. Fixes worse than 100 m are dropped (the server rejects them too).
  const acceptFix = useCallback((f: Fix) => {
    if (f.accuracy > MAX_ACCURACY_M) return;
    fixRef.current = f;
    lastFixAt.current = Date.now();
    setMe({ lat: f.lat, lng: f.lng });
  }, []);

  const onFix = useCallback(
    (p: GeolocationPosition) => {
      deniedRef.current = false;
      setGpsError(false);
      if (simRoute.current) return; // the simulator is driving
      acceptFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp });
    },
    [acceptFix],
  );
  const onFixError = useCallback((err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) deniedRef.current = true;
    setGpsError(true);
  }, []);

  // GPS while online or on a job.
  useEffect(() => {
    if (!(online || onJob) || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 });
    return () => navigator.geolocation.clearWatch(watch);
  }, [online, onJob, onFix, onFixError]);

  const toggleOnline = useCallback(async () => {
    if (!tanker || job) return;
    const next = !tanker.is_online;
    setTanker({ ...tanker, is_online: next });
    // The database refuses if the tanker is blocked or has no valid permit.
    const { data, error } = await supabase().rpc("driver_set_online", { p_online: next }).single<Tanker>();
    if (error) {
      setTanker({ ...tanker, is_online: !next });
      toast.show(friendlyError(error));
      return;
    }
    setTanker(data);
  }, [tanker, job, toast]);

  const acceptJob = useCallback(
    async (orderId: string) => {
      if (!profile) return { message: "not_a_driver" };
      const { error } = await supabase().rpc("accept_order", { p_order_id: orderId }).single<Order>();
      if (error) return error;
      setJob(await loadJob(profile.id));
      return null;
    },
    [profile, loadJob],
  );

  // ---------------------------------------------------------------- active job
  const jobId = job?.order.id;
  const dest = job?.loc ? { lat: job.loc.lat, lng: job.loc.lng } : null;
  const destRef = useRef(dest);
  useEffect(() => {
    destRef.current = dest;
  });

  // Own job updates (e.g. accepted → arriving after the first location update).
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

  // Location reporting while online (so NWS operators see idle tankers) and during a job:
  // every 10 s while moving (>15 m), at most every 30 s otherwise, with accuracy and the fix's
  // own timestamp. Same path for real and simulated fixes. Restarts when a job starts, so the
  // first fix goes out straight away and flips the job to 'arriving'.
  const reporting = online || onJob;
  useEffect(() => {
    if (!reporting) return;
    lastSent.current = null;
    const tick = () => {
      const now = Date.now();
      if (!simRoute.current && now - lastFixAt.current > POKE_AFTER_MS && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 0, timeout: 9_000 });
      }
      const fix = fixRef.current;
      if (!shouldSend(fix, lastSent.current, now)) return;
      const f = fix as Fix;
      lastSent.current = { lat: f.lat, lng: f.lng, at: now };
      supabase()
        .rpc("report_location", { p_lat: f.lat, p_lng: f.lng, p_accuracy_m: f.accuracy, p_recorded_at: new Date(f.at).toISOString() })
        .then(({ error }) => {
          if (error) lastSent.current = null; // retry on the next tick
        });
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, PING_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [reporting, jobId, onFix, onFixError]);

  // ---------------------------------------------------------------- demo trip simulator
  const startSimulation = useCallback(() => {
    const to = destRef.current;
    if (!DEMO_MODE || !to || simRoute.current) return;
    setSim({ status: "loading", totalKm: 0, leftKm: 0, source: "osrm" });
    buildDemoRoute(to).then((route) => {
      simRoute.current = { route, startedAt: Date.now() };
      setSim({ status: "running", totalKm: route.totalM / 1000, leftKm: route.totalM / 1000, source: route.source });
    });
  }, []);
  const stopSimulation = useCallback(() => {
    simRoute.current = null;
    setSim(null);
  }, []);

  // One simulated GPS fix per second, like a phone; reporting still follows the 10 s / 30 s cadence.
  const simRunning = sim?.status === "running" || sim?.status === "done";
  useEffect(() => {
    if (!simRunning) return;
    const step = () => {
      const s = simRoute.current;
      if (!s) return;
      const m = Math.min(s.route.totalM, travelled((Date.now() - s.startedAt) / 1000));
      const pos = positionAt(s.route, m);
      acceptFix({ ...pos, accuracy: 5 + Math.random() * 7, at: Date.now() });
      const leftKm = (s.route.totalM - m) / 1000;
      setSim((x) => (x ? { ...x, leftKm, status: leftKm <= 0 ? "done" : "running" } : x));
    };
    const timer = setInterval(step, 1_000);
    return () => clearInterval(timer);
  }, [simRunning, acceptFix]);

  // The job ending stops the simulator.
  useEffect(() => {
    if (jobId) return;
    simRoute.current = null;
    const t = setTimeout(() => setSim(null), 0);
    return () => clearTimeout(t);
  }, [jobId]);

  // Keep the screen on during a job; the lock is dropped whenever the page is hidden, so re-request it.
  useEffect(() => {
    if (!jobId) return;
    if (!("wakeLock" in navigator)) {
      const t = setTimeout(() => setWakeLock("unsupported"), 0);
      return () => clearTimeout(t);
    }
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        lock = await navigator.wakeLock.request("screen");
        if (cancelled) return void lock.release();
        setWakeLock("held");
        lock.addEventListener("release", () => !cancelled && setWakeLock("off"));
      } catch {
        if (!cancelled) setWakeLock("failed");
      }
    };
    const onVisible = () => document.visibilityState === "visible" && acquire();
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => undefined);
    };
  }, [jobId]);

  // Watch for location updates stopping during a job.
  useEffect(() => {
    if (!jobId) return;
    const startedAt = Date.now();
    const check = () => {
      const hidden = document.visibilityState === "hidden";
      const sinceFix = Date.now() - Math.max(lastFixAt.current, startedAt);
      setTrackingIssue(deniedRef.current && !simRoute.current ? "denied" : hidden ? "hidden" : sinceFix > NO_FIX_MS ? "nofix" : null);
    };
    const first = setTimeout(check, 0);
    const timer = setInterval(check, 2_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [jobId]);

  const advance = useCallback(
    async (fn: "mark_arrived" | "mark_delivered") => {
      if (!job || !profile) return;
      setActing(true);
      const { data, error } = await supabase().rpc(fn, { p_order_id: job.order.id }).single<Order>();
      setActing(false);
      if (error) return toast.show(friendlyError(error));
      if (fn === "mark_delivered") {
        toast.show(`Delivered · you earned ${omrValue(data.driver_earnings)}`);
        setJob(null);
        loadToday(profile.id);
      } else {
        setJob({ ...job, order: data });
      }
    },
    [job, profile, toast, loadToday],
  );

  const getPosition = useCallback(() => meRef.current, []);

  if (!profile || !ready || !tanker) return fallback;

  return (
    <Ctx
      value={{
        profile,
        tanker,
        online,
        toggleOnline,
        job,
        acceptJob,
        advance,
        acting,
        me,
        getPosition,
        hasFix: Boolean(me),
        gpsError,
        wakeLock,
        demoMode: DEMO_MODE,
        sim,
        startSimulation,
        stopSimulation,
        today,
        toast: toast.show,
      }}
    >
      {job && trackingIssue && (
        <div className="track-paused" role="alert">
          <b>Tracking paused — keep this screen open</b>
          <small>{ISSUE_TEXT[trackingIssue]}</small>
        </div>
      )}
      {children}
      {toast.node}
    </Ctx>
  );
}
