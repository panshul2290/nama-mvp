"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { permitSummary, type Permit } from "@/components/nws/fleetData";
import { useDriver } from "@/components/DriverContext";
import { RuleTag, SERVICE_SHORT } from "@/components/OrderBits";
import { usePricingRules } from "@/components/usePricingRules";
import { orderNo } from "@/lib/format";
import { omr } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

export default function DriverHome() {
  const { profile, tanker, online, toggleOnline, job, today } = useDriver();
  const { rules } = usePricingRules();
  const share = rules?.driver_share;
  // The tanker's permits (RLS: only the tanker assigned to this driver).
  const [permits, setPermits] = useState<Permit[] | null>(null);
  useEffect(() => {
    supabase()
      .from("permits")
      .select("id, permit_no, type, status, issued_at, expires_at")
      .eq("tanker_id", tanker.id)
      .then(({ data }) => setPermits((data ?? []) as Permit[]));
  }, [tanker.id, tanker.blocked]);
  const permit = permits ? permitSummary({ service_type: tanker.service_type, permits }) : null;
  const cantGoOnline = !online && (tanker.blocked || (permit != null && !permit.valid));

  return (
    <main className="screen">
      <div className="ptop">
        <div>
          <h3>{profile.full_name || "Driver"}</h3>
          <div className="sub">
            {tanker.plate} · {SERVICE_SHORT[tanker.service_type]} · {tanker.capacity_gal.toLocaleString()} gal
          </div>
        </div>
      </div>

      {tanker.blocked && (
        <div className="banner badb" role="alert">
          <b>Your tanker is blocked by NWS.</b> {tanker.blocked_reason ? `Reason: ${tanker.blocked_reason}. ` : ""}It can’t go online or take jobs until NWS
          unblocks it.
        </div>
      )}
      {!tanker.blocked && permit && !permit.valid && (
        <div className="banner badb" role="alert">
          <b>No valid permit ({permit.text.toLowerCase()}).</b> Your tanker needs an approved, unexpired {tanker.service_type} permit before it can go online.
        </div>
      )}
      {!tanker.blocked && permit?.valid && permit.tone === "warn" && <div className="banner">Permit {permit.text.toLowerCase()} — renew it in time to keep working.</div>}

      <div className={`card ${online ? "" : "sunk"}`}>
        <div className="row">
          <div>
            <h4>{online ? "Online — receiving jobs" : "You are offline"}</h4>
            <p>
              {job
                ? "Finish your current trip first."
                : online
                  ? "Open jobs near you are in the Jobs tab."
                  : cantGoOnline
                    ? "Going online is disabled — see above."
                    : "Go online to see and accept jobs near you."}
            </p>
          </div>
          <button
            className={`switch ${online ? "on" : ""}`}
            role="switch"
            aria-checked={online}
            aria-label="Online"
            onClick={toggleOnline}
            disabled={Boolean(job) || cantGoOnline}
          />
        </div>
      </div>

      {job ? (
        <Link href="/driver/trip" className="card hl">
          <h4>Job in progress · {orderNo(job.order.order_no)}</h4>
          <p>
            {job.order.gallons.toLocaleString()} gal · {job.order.area} — open Trip
          </p>
        </Link>
      ) : (
        !online && (
          <div className="card">
            <h4>Start your shift</h4>
            <ul className="tl">
              <li className="cur">Go online</li>
              <li>Accept a job from Jobs</li>
              <li>Drive, then mark arrived and delivered</li>
            </ul>
          </div>
        )
      )}

      <div className="card">
        <div className="row">
          <div>
            <p>Today</p>
            <div className="money" style={{ fontSize: 22, whiteSpace: "nowrap" }}>
              {omr(Math.round(today.earned * 1000))}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <p>Deliveries {today.jobs}</p>
            {share && (
              <p>
                {Math.round(Number(share.value) * 100)}% of delivery fees <RuleTag status={share.status} />
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
