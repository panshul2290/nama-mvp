"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useDriver } from "@/components/DriverContext";
import { Icon } from "@/components/icons";
import { SERVICE_SHORT } from "@/components/OrderBits";
import { errorCode, friendlyError } from "@/lib/errors";
import { FEED_CHANNEL, GONE_EVENT } from "@/lib/feed";
import { orderCode } from "@/lib/format";
import { DEFAULT_CENTER } from "@/lib/geo";
import { omrValue } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import type { OpenRequest } from "@/lib/types";

const REFRESH_MS = 15_000;

export default function JobsPage() {
  const router = useRouter();
  const { tanker, online, toggleOnline, job, acceptJob, getPosition, hasFix, gpsError, toast } = useDriver();
  const [requests, setRequests] = useState<OpenRequest[]>([]);
  const [accepting, setAccepting] = useState<string | null>(null);
  const feed = useRef<RealtimeChannel | null>(null);

  const refresh = useCallback(() => {
    const at = getPosition() ?? DEFAULT_CENTER;
    supabase()
      .rpc("open_requests_near", { p_lat: at.lat, p_lng: at.lng })
      .then(({ data, error }) => {
        if (!error) setRequests((data ?? []) as OpenRequest[]);
      });
  }, [getPosition]);

  // Live feed while online and free.
  useEffect(() => {
    if (!online || job) return;
    refresh();
    const db = supabase();
    const ch = db
      .channel(FEED_CHANNEL, { config: { broadcast: { self: false } } })
      // New requests arrive via Postgres Changes; RLS lets drivers see status = 'requested'.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, () => refresh())
      // Accepted/cancelled requests vanish from RLS, so peers announce them here.
      .on("broadcast", { event: GONE_EVENT }, ({ payload }) => setRequests((rs) => rs.filter((r) => r.id !== payload?.id)))
      .subscribe();
    feed.current = ch;
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(timer);
      feed.current = null;
      db.removeChannel(ch);
    };
  }, [online, job, refresh]);

  // Re-sort once the first real GPS fix replaces the fallback position.
  useEffect(() => {
    if (online && !job && hasFix) refresh();
  }, [online, job, hasFix, refresh]);

  async function accept(id: string) {
    setAccepting(id);
    const error = await acceptJob(id);
    setAccepting(null);
    if (error) {
      toast(friendlyError(error));
      if (["already_taken", "not_eligible"].includes(errorCode(error) ?? "")) setRequests((rs) => rs.filter((r) => r.id !== id));
      return;
    }
    feed.current?.send({ type: "broadcast", event: GONE_EVENT, payload: { id } });
    router.push("/driver/trip");
  }

  const shown = online && !job ? requests : [];

  return (
    <main className="screen">
      <div className="dj-h">
        <div>
          <h3>Jobs</h3>
          <small>
            {tanker.plate} · {SERVICE_SHORT[tanker.service_type]} · {tanker.capacity_gal.toLocaleString()} gal
          </small>
        </div>
        <button className={`st ${online ? "ok" : ""}`} onClick={toggleOnline} disabled={Boolean(job)} aria-pressed={online}>
          {online ? "Online" : "Offline"}
        </button>
      </div>

      {!online && (
        <div className="dj-ban">
          <Icon name="alert" />
          <span>You are offline. Go online to see and accept jobs.</span>
        </div>
      )}
      {job && <div className="banner info">Finish your current trip before accepting another job.</div>}
      {online && !job && !hasFix && (
        <div className="dj-ban">
          <Icon name="pin" />
          <span>{gpsError ? "Location unavailable — distances are from central Muscat." : "Getting your location…"}</span>
        </div>
      )}

      <h4 className="ch-sec">Open jobs near you</h4>
      {shown.length === 0 ? (
        <div className="empty">{online && !job ? "No open jobs right now. New requests appear here instantly." : "Jobs appear here when you’re online."}</div>
      ) : (
        shown.map((r) => (
          <div key={r.id} className="dj-job">
            <div className="row">
              <span>
                <b>{orderCode(r.id)}</b>
              </span>
              <b className="e num">{omrValue(r.driver_earnings)}</b>
            </div>
            <small>
              {r.gallons.toLocaleString()} gal · {r.area} · {Number(r.distance_km).toFixed(1)} km · As soon as possible
            </small>
            <button className="btn sm pri" disabled={accepting !== null} onClick={() => accept(r.id)}>
              {accepting === r.id ? "Accepting…" : "Accept"}
            </button>
          </div>
        ))
      )}
    </main>
  );
}
