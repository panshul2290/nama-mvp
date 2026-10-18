"use client";

import Link from "next/link";
import { useDriver } from "@/components/DriverContext";
import { SERVICE_SHORT } from "@/components/OrderBits";
import { orderNo } from "@/lib/format";
import { omr } from "@/lib/pricing";

export default function DriverHome() {
  const { profile, tanker, online, toggleOnline, job, today } = useDriver();

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

      <div className={`card ${online ? "" : "sunk"}`}>
        <div className="row">
          <div>
            <h4>{online ? "Online — receiving jobs" : "You are offline"}</h4>
            <p>{job ? "Finish your current trip first." : online ? "Open jobs near you are in the Jobs tab." : "Go online to see and accept jobs near you."}</p>
          </div>
          <button
            className={`switch ${online ? "on" : ""}`}
            role="switch"
            aria-checked={online}
            aria-label="Online"
            onClick={toggleOnline}
            disabled={Boolean(job)}
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
            <p>85% of delivery fees</p>
          </div>
        </div>
      </div>
    </main>
  );
}
