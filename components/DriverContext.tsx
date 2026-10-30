"use client";

// Driver state shared by the Home, Jobs, Trip, Earnings and Profile tabs. It lives in the
// driver layout, so location reporting keeps running while the driver switches tabs.
import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { DICT, muscatDay, useErrText } from "@/components/driver/i18n";
import { legIndex, tripLegs, type Leg } from "@/components/driver/legs";
import { useProfile } from "@/components/useProfile";
import { useToast } from "@/components/useToast";
import { errorCode } from "@/lib/errors";
import { FEED_CHANNEL, GONE_EVENT } from "@/lib/feed";
import { DEFAULT_CENTER } from "@/lib/geo";
import { getCurrentPosition, keepScreenOn, wakeLockSupported, watchPosition, type GeoError } from "@/lib/geo-source";
import { useT } from "@/lib/i18n";
import { buildDemoRoute, DEMO_MODE, positionAt, travelled, type SimRoute } from "@/lib/simulator";
import { supabase } from "@/lib/supabase/client";
import { MAX_ACCURACY_M, MOVING_INTERVAL_MS, shouldSend, usable, type Fix, type Sent } from "@/lib/tracking";
import type { LngLat, Notification, OpenRequest, Order, OrderLocation, Profile, Site, Tanker } from "@/lib/types";

const PING_MS = MOVING_INTERVAL_MS; // decide every 10 s; shouldSend() applies the 15 m / 30 s rule
/** If no new fix has arrived for this long, ask for one (some phones go quiet when stationary). */
const POKE_AFTER_MS = 8_000;
/** No usable fix for this long during a job → "Tracking paused". */
const NO_FIX_MS = 30_000;
const JOBS_REFRESH_MS = 15_000;

export type TrackingIssue = "denied" | "hidden" | "nofix";

/** Orders a driver is working (wastewater stays active until it is discharged). */
const WORKING = ["accepted", "arriving", "arrived", "collected"];

export type Job = { order: Order; loc: OrderLocation | null; customer: Pick<Profile, "full_name" | "phone"> | null };
export type SimState = { status: "loading" | "running" | "done"; totalKm: number; leftKm: number; source: "osrm" | "straight-line"; leg: string };
export type JobFn = "confirm_fill" | "mark_arrived" | "submit_pod" | "confirm_discharge";
export type IssueKind = "breakdown" | "customer_unreachable" | "wrong_address" | "station_closed" | "accident";
export type Prefs = { training?: number[]; declined?: number } & Record<string, unknown>;

type DriverState = {
  profile: Profile;
  tanker: Tanker;
  refreshTanker: () => Promise<void>;
  online: boolean;
  toggleOnline: () => Promise<void>;
  /** The tanker's company is suspended by NWS (no going online, no jobs). */
  companySuspended: boolean;
  /** Today's safety pre-check (Muscat day) has been submitted. */
  shiftChecked: boolean;
  submitShiftCheck: (items: Record<string, boolean>) => Promise<boolean>;
  job: Job | null;
  /** The trip's legs and the index of the one in progress. */
  legs: Leg[];
  leg: number;
  /** The job that just finished (shown on the Trip tab until the next one starts). */
  finished: Order | null;
  /** Accepts atomically; resolves to the RPC error (if any) so the caller can react. */
  acceptJob: (orderId: string) => Promise<{ message?: string } | null>;
  /** Runs a trip-step RPC on the current job; resolves to the updated order, or null on error (already shown). */
  jobAction: (fn: JobFn, params?: Record<string, unknown>) => Promise<Order | null>;
  reportIssue: (kind: IssueKind, note: string) => Promise<boolean>;
  acting: boolean;
  /** Open requests for this tanker (live while online and free), minus declined ones. */
  openJobs: OpenRequest[];
  /** When each open job was first seen on this device (drives the 60 s offer). */
  seenAt: Record<string, number>;
  declineJob: (id: string) => void;
  me: LngLat | null;
  getPosition: () => LngLat | null;
  hasFix: boolean;
  gpsError: boolean;
  /** Screen wake lock state during a job: held, unsupported, or failed. */
  wakeLock: "held" | "unsupported" | "failed" | "off";
  /** Demo trip simulator (NEXT_PUBLIC_DEMO_MODE=true only). */
  demoMode: boolean;
  sim: SimState | null;
  startSimulation: () => void;
  stopSimulation: () => void;
  today: { earned: number; jobs: number };
  sites: Site[];
  prefs: Prefs;
  savePrefs: (patch: Prefs) => Promise<void>;
  unread: number;
  refreshUnread: () => void;
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
  const { show: showToast, node: toastNode } = useToast();
  const t = useT(DICT);
  const errText = useErrText();
  const [tanker, setTanker] = useState<Tanker | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [finished, setFinished] = useState<Order | null>(null);
  const [ready, setReady] = useState(false);
  const [acting, setActing] = useState(false);
  const [today, setToday] = useState({ earned: 0, jobs: 0 });
  const [shiftChecked, setShiftChecked] = useState(false);
  const [companySuspended, setCompanySuspended] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({});
  const [unread, setUnread] = useState(0);
  const [openJobs, setOpenJobs] = useState<OpenRequest[]>([]);
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  const [declined, setDeclined] = useState<string[]>([]);

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
  const feed = useRef<RealtimeChannel | null>(null);
  const quiet = useRef(false); // our own release is in flight: don't announce it as "withdrawn"

  const online = tanker?.is_online ?? false;
  const onJob = Boolean(job);
  const meRef = useRef<LngLat | null>(me);
  useEffect(() => {
    meRef.current = me;
  });

  const loadJob = useCallback(async (driverId: string) => {
    const db = supabase();
    const { data: order } = await db.from("orders").select("*").eq("driver_id", driverId).in("status", WORKING).maybeSingle<Order>();
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
      .select("driver_earnings, tip")
      .eq("driver_id", driverId)
      .eq("status", "delivered")
      .gte("delivered_at", midnight.toISOString())
      .then(({ data }) =>
        setToday({ earned: (data ?? []).reduce((s, r) => s + Number(r.driver_earnings) + Number(r.tip ?? 0), 0), jobs: (data ?? []).length }),
      );
  }, []);

  const refreshUnread = useCallback(() => {
    if (!profile) return;
    supabase()
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profile.id)
      .is("read_at", null)
      .then(({ count }) => setUnread(count ?? 0));
  }, [profile]);

  // Tanker, any job in progress, today's safety check, sites and preferences.
  useEffect(() => {
    if (!profile) return;
    const db = supabase();
    // RLS returns only the tanker assigned to this driver (tanker_assignments).
    Promise.all([
      db.from("tankers").select("*").maybeSingle<Tanker>(),
      loadJob(profile.id),
      db.from("shift_checks").select("id").eq("driver_id", profile.id).eq("day", muscatDay()).maybeSingle(),
    ]).then(([{ data: tk }, j, { data: check }]) => {
      if (!tk) return router.replace("/onboarding");
      setTanker(tk);
      setJob(j);
      setShiftChecked(Boolean(check));
      setReady(true);
    });
    db.from("sites")
      .select("*")
      .eq("active", true)
      .then(({ data }) => setSites((data ?? []) as Site[]));
    // prefs is a private column: read through my_private_profile(), not the table.
    db.rpc("my_private_profile").then(({ data }) => setPrefs((data as { prefs?: Prefs | null } | null)?.prefs ?? {}));
    loadToday(profile.id);
    refreshUnread();
  }, [profile, router, loadJob, loadToday, refreshUnread]);

  const refreshTanker = useCallback(async () => {
    const { data } = await supabase().from("tankers").select("*").maybeSingle<Tanker>();
    if (data) setTanker(data);
  }, []);

  // A suspended company's tankers can't work (the database refuses with company_suspended).
  // tanker_company_active() is the online guard's own check (0015); RLS may hide a suspended
  // company's row from its drivers, so the table alone can't tell.
  const tankerId = tanker?.id ?? null;
  const companyId = tanker?.company_id ?? null;
  useEffect(() => {
    if (!tankerId || !companyId) return;
    supabase()
      .rpc("tanker_company_active", { p_tanker: tankerId })
      .then(({ data, error }) => {
        if (!error) setCompanySuspended(data === false);
      });
  }, [tankerId, companyId]);

  const savePrefs = useCallback(
    async (patch: Prefs) => {
      if (!profile) return;
      const next = { ...prefs, ...patch };
      setPrefs(next);
      await supabase().from("profiles").update({ prefs: next }).eq("id", profile.id);
    },
    [profile, prefs],
  );

  // New notifications (job assigned, penalty issued…) arrive live.
  useEffect(() => {
    if (!profile) return;
    const db = supabase();
    const ch = db
      .channel(`notif-${profile.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profile.id}` }, (payload) => {
        const n = payload.new as Notification;
        setUnread((u) => u + 1);
        if (n.event !== "new_message") showToast(n.title); // chat messages get their own banner (components/chat/OrderChat.tsx)
      })
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [profile, showToast]);

  // Location reporting while online (so NWS operators see idle tankers) and during a job:
  // every 10 s while moving (>15 m), at most every 30 s otherwise, with accuracy and the fix's
  // own timestamp. shouldSend() decides; it runs on every fix as it arrives (so a native
  // background location callback uploads straight away, without waiting for a WebView timer)
  // and on a 10 s tick as a fallback.
  const reportingRef = useRef(false);
  const sendIfDue = useCallback(() => {
    if (!reportingRef.current) return;
    const now = Date.now();
    const fix = fixRef.current;
    if (!shouldSend(fix, lastSent.current, now)) return;
    const f = fix as Fix;
    lastSent.current = { lat: f.lat, lng: f.lng, at: now };
    supabase()
      .rpc("report_location", { p_lat: f.lat, p_lng: f.lng, p_accuracy_m: f.accuracy, p_recorded_at: new Date(f.at).toISOString() })
      .then(({ error }) => {
        if (error) lastSent.current = null; // retry with the next fix or tick
      });
  }, []);

  // One entry point for fixes, real or simulated. Fixes worse than 100 m are dropped (the server rejects them too).
  const acceptFix = useCallback(
    (f: Fix) => {
      if (f.accuracy > MAX_ACCURACY_M) return;
      fixRef.current = f;
      lastFixAt.current = Date.now();
      setMe({ lat: f.lat, lng: f.lng });
      sendIfDue();
    },
    [sendIfDue],
  );

  const onFix = useCallback(
    (f: Fix) => {
      deniedRef.current = false;
      setGpsError(false);
      if (simRoute.current) return; // the simulator is driving
      acceptFix(f);
    },
    [acceptFix],
  );
  const onFixError = useCallback((err: GeoError) => {
    if (err.denied) deniedRef.current = true;
    setGpsError(true);
  }, []);

  // GPS while online or on a job.
  useEffect(() => {
    if (!(online || onJob)) return;
    return watchPosition(onFix, onFixError, { highAccuracy: true, maximumAgeMs: 5_000, timeoutMs: 20_000 });
  }, [online, onJob, onFix, onFixError]);

  const toggleOnline = useCallback(async () => {
    if (!tanker || job) return;
    const next = !tanker.is_online;
    if (next && !shiftChecked) return showToast(t("needCheck"));
    setTanker({ ...tanker, is_online: next });
    // The database refuses if the tanker is blocked or has no valid permit.
    const { data, error } = await supabase().rpc("driver_set_online", { p_online: next }).single<Tanker>();
    if (error) {
      setTanker({ ...tanker, is_online: !next });
      if (errorCode(error) === "company_suspended") setCompanySuspended(true);
      showToast(errText(error));
      refreshTanker(); // picks up a block NWS set meanwhile (shown in the blockers panel)
      return;
    }
    setTanker(data);
  }, [tanker, job, shiftChecked, showToast, t, errText, refreshTanker]);

  const submitShiftCheck = useCallback(
    async (items: Record<string, boolean>) => {
      const { error } = await supabase().rpc("submit_shift_check", { p_items: items });
      if (error) {
        showToast(errText(error));
        return false;
      }
      setShiftChecked(true);
      showToast(t("checkSaved"));
      return true;
    },
    [showToast, t, errText],
  );

  // ---------------------------------------------------------------- open jobs feed
  const refreshJobs = useCallback(() => {
    const at = meRef.current ?? DEFAULT_CENTER;
    supabase()
      .rpc("open_requests_near", { p_lat: at.lat, p_lng: at.lng })
      .then(({ data, error }) => {
        if (error) return;
        const rows = (data ?? []) as OpenRequest[];
        setOpenJobs(rows);
        setSeenAt((s) => {
          const now = Date.now();
          const next: Record<string, number> = {};
          for (const r of rows) next[r.id] = s[r.id] ?? now;
          return next;
        });
      });
  }, []);

  useEffect(() => {
    if (!online || job) return;
    const first = setTimeout(refreshJobs, 0);
    const db = supabase();
    const ch = db
      .channel(FEED_CHANNEL, { config: { broadcast: { self: false } } })
      // New requests arrive via Postgres Changes; RLS lets drivers see status = 'requested'
      // (inserted, or released from 'scheduled' 90 minutes before the slot).
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, () => refreshJobs())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, () => refreshJobs())
      // Accepted/cancelled requests vanish from RLS, so peers announce them here.
      .on("broadcast", { event: GONE_EVENT }, ({ payload }) => setOpenJobs((rs) => rs.filter((r) => r.id !== payload?.id)))
      .subscribe();
    feed.current = ch;
    const timer = setInterval(refreshJobs, JOBS_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      feed.current = null;
      db.removeChannel(ch);
    };
  }, [online, job, refreshJobs]);

  // Re-sort once the first real GPS fix replaces the fallback position.
  const hasFix = Boolean(me);
  useEffect(() => {
    if (!online || job || !hasFix) return;
    const t0 = setTimeout(refreshJobs, 0);
    return () => clearTimeout(t0);
  }, [online, job, hasFix, refreshJobs]);

  const declineJob = useCallback(
    (id: string) => {
      setDeclined((d) => [...d, id]);
      savePrefs({ declined: Number(prefs.declined ?? 0) + 1 });
    },
    [savePrefs, prefs.declined],
  );

  const acceptJob = useCallback(
    async (orderId: string) => {
      if (!profile) return { message: "not_a_driver" };
      const { error } = await supabase().rpc("accept_order", { p_order_id: orderId }).single<Order>();
      if (error) {
        setOpenJobs((rs) => rs.filter((r) => r.id !== orderId || !/already_taken|not_eligible/.test(error.message)));
        if (errorCode(error) === "company_suspended") setCompanySuspended(true);
        return error;
      }
      feed.current?.send({ type: "broadcast", event: GONE_EVENT, payload: { id: orderId } });
      setFinished(null);
      setJob(await loadJob(profile.id));
      return null;
    },
    [profile, loadJob],
  );

  // ---------------------------------------------------------------- active job
  const jobId = job?.order.id;
  const testNames = useMemo(() => ({ fill: t("testStation"), discharge: t("testPlant") }), [t]);
  const legs = useMemo(() => (job ? tripLegs(job.order, job.loc, sites, me, testNames) : []), [job, sites, me, testNames]);
  const leg = job ? legIndex(job.order) : 0;
  const legKey = job ? `${job.order.id}:${leg}` : "";
  const target = legs[leg]?.target ?? null;
  const targetRef = useRef(target);
  const legKeyRef = useRef(legKey);
  useEffect(() => {
    targetRef.current = target;
    legKeyRef.current = legKey;
  });

  const finish = useCallback(
    (o: Order) => {
      setFinished(o);
      setJob(null);
      if (profile) loadToday(profile.id);
    },
    [profile, loadToday],
  );

  // Own job updates (accepted → arriving after the first location update, control-room actions).
  useEffect(() => {
    if (!jobId || !profile) return;
    const db = supabase();
    const ch = db
      .channel(`job-${jobId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${jobId}` }, (payload) => {
        const o = payload.new as Order;
        if (o.status === "delivered") return; // finished through our own RPC result
        // Reassigned or cancelled by the control room: the job is no longer ours.
        if (o.driver_id !== profile.id || o.status === "cancelled" || o.status === "requested") {
          setJob(null);
          if (!quiet.current) showToast(t("jobWithdrawn"));
          return;
        }
        setJob((j) => (j && j.order.id === jobId ? { ...j, order: { ...j.order, ...o } } : j));
      })
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [jobId, profile, showToast, t]);

  // Same path for real and simulated fixes. Restarts when a job starts, so the first fix goes
  // out straight away and flips the job to 'arriving'.
  const reporting = online || onJob;
  useEffect(() => {
    reportingRef.current = reporting;
    if (!reporting) return;
    lastSent.current = null;
    const tick = () => {
      if (!simRoute.current && Date.now() - lastFixAt.current > POKE_AFTER_MS) getCurrentPosition().then(onFix, onFixError);
      sendIfDue();
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, PING_MS);
    return () => {
      reportingRef.current = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [reporting, jobId, onFix, onFixError, sendIfDue]);

  /** Geofenced steps are judged on the server's last fix, so send the newest one first. */
  const sendFixNow = useCallback(async () => {
    const f = fixRef.current;
    const now = Date.now();
    if (!usable(f, now)) return;
    const last = lastSent.current;
    if (last && last.lat === f.lat && last.lng === f.lng) return;
    lastSent.current = { lat: f.lat, lng: f.lng, at: now };
    const { error } = await supabase().rpc("report_location", { p_lat: f.lat, p_lng: f.lng, p_accuracy_m: f.accuracy, p_recorded_at: new Date(f.at).toISOString() });
    if (error) lastSent.current = null;
  }, []);

  const jobAction = useCallback(
    async (fn: JobFn, params: Record<string, unknown> = {}) => {
      if (!job) return null;
      setActing(true);
      await sendFixNow();
      const { data, error } = await supabase()
        .rpc(fn, { p_order_id: job.order.id, ...params })
        .single<Order>();
      setActing(false);
      if (error) {
        showToast(errText(error));
        return null;
      }
      if (data.status === "delivered") finish(data);
      else setJob((j) => (j ? { ...j, order: data } : j));
      return data;
    },
    [job, sendFixNow, showToast, errText, finish],
  );

  const reportIssue = useCallback(
    async (kind: IssueKind, note: string) => {
      if (!job) return false;
      setActing(true);
      await sendFixNow();
      quiet.current = true;
      const { data, error } = await supabase().rpc("report_trip_issue", { p_order_id: job.order.id, p_kind: kind, p_note: note }).single<{ released: boolean }>();
      setActing(false);
      if (error) {
        quiet.current = false;
        showToast(errText(error));
        return false;
      }
      if (data.released) {
        setJob(null);
        showToast(t("issueReleased"));
        refreshTanker(); // breakdowns and accidents also take the tanker offline
      } else showToast(t("issueSent"));
      setTimeout(() => (quiet.current = false), 5_000);
      return true;
    },
    [job, sendFixNow, showToast, errText, t, refreshTanker],
  );

  // ---------------------------------------------------------------- demo trip simulator
  // Drives the current leg only (to the filling station, the customer or the discharge site)
  // and then parks there, so the geofence checks see the tanker inside the site.
  const startSimulation = useCallback(() => {
    const to = targetRef.current;
    const key = legKeyRef.current;
    if (!DEMO_MODE || !to) return;
    setSim({ status: "loading", totalKm: 0, leftKm: 0, source: "osrm", leg: key });
    buildDemoRoute(to, meRef.current).then((route) => {
      if (legKeyRef.current !== key) return;
      simRoute.current = { route, startedAt: Date.now() };
      setSim({ status: "running", totalKm: route.totalM / 1000, leftKm: route.totalM / 1000, source: route.source, leg: key });
    });
  }, []);
  const stopSimulation = useCallback(() => {
    simRoute.current = null;
    setSim(null);
  }, []);

  // One simulated GPS fix per second, like a phone; reporting still follows the 10 s / 30 s cadence.
  // After a leg ends the simulated tanker stays parked at the site until the next leg is simulated.
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
    const t0 = setTimeout(() => setSim(null), 0);
    return () => clearTimeout(t0);
  }, [jobId]);

  // Keep the screen on during a job; the lock is dropped whenever the page is hidden, so re-request it.
  useEffect(() => {
    if (!jobId) return;
    if (!wakeLockSupported()) {
      const t0 = setTimeout(() => setWakeLock("unsupported"), 0);
      return () => clearTimeout(t0);
    }
    let release: (() => Promise<void>) | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        const r = await keepScreenOn(() => !cancelled && setWakeLock("off"));
        if (cancelled) return void r();
        release = r;
        setWakeLock("held");
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
      release?.();
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

  const getPosition = useCallback(() => meRef.current, []);
  const shownJobs = useMemo(() => (online && !job ? openJobs.filter((r) => !declined.includes(r.id)) : []), [online, job, openJobs, declined]);

  if (!profile || !ready || !tanker) return fallback;

  return (
    <Ctx
      value={{
        profile,
        tanker,
        refreshTanker,
        online,
        toggleOnline,
        companySuspended,
        shiftChecked,
        submitShiftCheck,
        job,
        legs,
        leg,
        finished,
        acceptJob,
        jobAction,
        reportIssue,
        acting,
        openJobs: shownJobs,
        seenAt,
        declineJob,
        me,
        getPosition,
        hasFix,
        gpsError,
        wakeLock,
        demoMode: DEMO_MODE,
        sim,
        startSimulation,
        stopSimulation,
        today,
        sites,
        prefs,
        savePrefs,
        unread,
        refreshUnread,
        toast: showToast,
      }}
    >
      {job && trackingIssue && (
        <div className="track-paused" role="alert">
          <b>{t("pausedT")}</b>
          <small>{t(`paused_${trackingIssue}`)}</small>
        </div>
      )}
      {children}
      {toastNode}
    </Ctx>
  );
}
