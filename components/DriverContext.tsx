"use client";

// Driver state shared by the Home, Jobs, Trip and Profile tabs. It lives in the
// driver layout, so GPS pings keep running while the driver switches tabs.
import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import { useProfile } from "@/components/useProfile";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { distanceKm } from "@/lib/geo";
import { omrValue } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { LngLat, Order, OrderLocation, Profile, Tanker } from "@/lib/types";

const PING_MS = 10_000;
/** No usable fix for this long during a job → "Tracking paused". */
const NO_FIX_MS = 30_000;

export type TrackingIssue = "denied" | "hidden" | "nofix";
const ISSUE_TEXT: Record<TrackingIssue, string> = {
  denied: "Location permission is off. Allow location for this site in your browser settings.",
  hidden: "The app is in the background, so your location isn’t being shared.",
  nofix: "No GPS fix for 30 seconds. Check that location is on and you have a clear view of the sky.",
};
export const SIMULATION = process.env.NEXT_PUBLIC_ENABLE_SIMULATION === "true";

export type Job = { order: Order; loc: OrderLocation | null; customer: Pick<Profile, "full_name" | "phone"> | null };

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
  simulate: boolean;
  setSimulate: (v: boolean) => void;
  /** Screen Wake Lock state during a job: held, unsupported, or failed. */
  wakeLock: "held" | "unsupported" | "failed" | "off";
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

  const [gps, setGps] = useState<LngLat | null>(null);
  const [gpsError, setGpsError] = useState(false);
  const [simulate, setSimulate] = useState(SIMULATION);
  const [simPos, setSimPos] = useState<LngLat | null>(null);
  const [trackingIssue, setTrackingIssue] = useState<TrackingIssue | null>(null);
  const [wakeLock, setWakeLock] = useState<"held" | "unsupported" | "failed" | "off">("off");
  const deniedRef = useRef(false);
  const lastFixAt = useRef(0);

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
    Promise.all([db.from("tankers").select("*").eq("driver_id", profile.id).maybeSingle<Tanker>(), loadJob(profile.id)]).then(
      ([{ data: t }, j]) => {
        if (!t) return router.replace("/onboarding");
        setTanker(t);
        setJob(j);
        setReady(true);
      },
    );
    loadToday(profile.id);
  }, [profile, router, loadJob, loadToday]);

  // GPS while online or on a job.
  useEffect(() => {
    if (!(online || onJob) || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        deniedRef.current = false;
        lastFixAt.current = Date.now();
        setGpsError(false);
        setGps({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) deniedRef.current = true;
        setGpsError(true);
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [online, onJob]);

  const toggleOnline = useCallback(async () => {
    if (!tanker || job) return;
    const next = !tanker.is_online;
    setTanker({ ...tanker, is_online: next });
    const { error } = await supabase().from("tankers").update({ is_online: next }).eq("driver_id", tanker.driver_id);
    if (error) {
      setTanker({ ...tanker, is_online: !next });
      toast.show(friendlyError(error));
    }
  }, [tanker, job, toast]);

  const acceptJob = useCallback(
    async (orderId: string) => {
      if (!profile) return { message: "not_a_driver" };
      const { error } = await supabase().rpc("accept_order", { p_order_id: orderId }).single<Order>();
      if (error) return error;
      const j = await loadJob(profile.id);
      setSimPos(null);
      setJob(j);
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
        lastFixAt.current = Date.now();
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
      setTrackingIssue(deniedRef.current ? "denied" : hidden ? "hidden" : sinceFix > NO_FIX_MS ? "nofix" : null);
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
        setSimPos(null);
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
        hasFix: Boolean(gps),
        gpsError,
        simulate,
        setSimulate,
        wakeLock,
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
