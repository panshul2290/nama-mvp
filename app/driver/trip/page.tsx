"use client";

import Link from "next/link";
import { SIMULATION, useDriver } from "@/components/DriverContext";
import { Icon } from "@/components/icons";
import { Map } from "@/components/Map";
import { SERVICE_SHORT } from "@/components/OrderBits";
import { etaMinutes, kmText, orderCode } from "@/lib/format";
import { DEFAULT_CENTER, distanceKm } from "@/lib/geo";
import { omrValue } from "@/lib/pricing";

const STEP_LABEL: Record<string, [string, "act" | "ok"]> = {
  accepted: ["Driving to customer", "act"],
  arriving: ["Driving to customer", "act"],
  arrived: ["Arrived at the customer", "ok"],
};

export default function TripPage() {
  const { job, me, advance, acting, gpsError, simulate, setSimulate } = useDriver();

  if (!job) {
    return (
      <main className="screen">
        <div className="dj-h">
          <div>
            <h3>Trip</h3>
            <small>No trip in progress</small>
          </div>
        </div>
        <div className="empty">
          Accept a job to start a trip.
          <br />
          <br />
          <Link href="/driver/jobs" className="btn pri">
            Open jobs
          </Link>
        </div>
      </main>
    );
  }

  const o = job.order;
  const dest = job.loc ? { lat: job.loc.lat, lng: job.loc.lng } : null;
  const away = me && dest ? distanceKm(me, dest) : null;
  const [label, tone] = STEP_LABEL[o.status] ?? ["On the job", "act"];
  const arrived = o.status === "arrived";

  return (
    <main className="screen flush">
      <div className="tr-map short">
        <Map center={dest ?? me ?? DEFAULT_CENTER} destination={dest} me={me} follow padBottom={30} />
        <div className="tr-chip">
          <b>{orderCode(o.id)}</b>
          <span className="mut">· {arrived ? "Step 2 of 2" : "Step 1 of 2"}</span>
        </div>
      </div>

      <div className="sheet2">
        <i className="grab" aria-hidden="true" />
        <span className={`st ${tone}`}>{label}</span>
        <h3 className="tj-t">{job.loc?.address || o.area}</h3>
        <small className="mut">
          {arrived ? "You’re at the delivery point" : away != null ? `${kmText(away)} to go · about ${etaMinutes(away)} min` : "Waiting for GPS…"}
        </small>

        <div className="tj-box">
          <div>
            <Icon name="drop" />
            <span>
              <small>Deliver</small>
              <b>
                {o.gallons.toLocaleString()} gal · {SERVICE_SHORT[o.service_type]}
              </b>
            </span>
          </div>
          <div>
            <Icon name="pin" />
            <span>
              <small>Area</small>
              <b>{o.area}</b>
            </span>
          </div>
          <div>
            <Icon name="user" />
            <span>
              <small>Customer</small>
              <b>{job.customer?.full_name || "Customer"}</b>
            </span>
          </div>
          <div>
            <Icon name="coins" />
            <span>
              <small>Your earnings</small>
              <b>{omrValue(o.driver_earnings)}</b>
            </span>
          </div>
        </div>

        {gpsError && !simulate && <div className="banner badb">Location is off — the customer can’t see you moving. Allow location access.</div>}

        {arrived ? (
          <button className="cta" disabled={acting} onClick={() => advance("mark_delivered")}>
            {acting ? "Saving…" : "Mark delivered"}
          </button>
        ) : (
          <button className="cta" disabled={acting} onClick={() => advance("mark_arrived")}>
            {acting ? "Saving…" : "Mark arrived"}
          </button>
        )}

        {SIMULATION && (
          <label className="reco sim">
            <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
            Simulate drive (dev) — move toward the customer on each 10 s ping
          </label>
        )}

        <div className="tj-links">
          {job.customer?.phone ? (
            <a className="lk" href={`tel:${job.customer.phone}`}>
              Call customer
            </a>
          ) : (
            <span className="mut small">No phone on file</span>
          )}
          {dest && (
            <a className="lk" href={`https://www.openstreetmap.org/directions?route=%3B${dest.lat}%2C${dest.lng}`} target="_blank" rel="noreferrer">
              Open directions
            </a>
          )}
        </div>
        <p className="tr-note">Sharing your location every 10 seconds while on this job.</p>
      </div>
    </main>
  );
}
