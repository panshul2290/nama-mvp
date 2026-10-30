"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { InvitationCards } from "@/components/driver/Invitations";
import { pickOffer } from "@/components/driver/offer";
import { BLOCKERS_ID, OnlineBlockers, useBlockerTitle, useOnlineBlockers } from "@/components/driver/OnlineBlockers";
import { useNow } from "@/components/driver/useNow";
import { LESSONS } from "@/components/driver/training";
import { Icon } from "@/components/icons";
import { LangToggle, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

/** Safety pre-check items, keyed as submit_shift_check() expects. */
const PRE_CHECK = ["tyres_brakes_lights", "valves_sealed", "hatch_locked", "ppe", "hose_sanitised"] as const;

type Emergency = { on: boolean; zone: string | null; reason: string | null };

export default function DriverHome() {
  const { profile, tanker, refreshTanker, online, toggleOnline, shiftChecked, submitShiftCheck, job, legs, leg, today, openJobs, seenAt, unread, toast, training, hasFix, gpsError } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const now = useNow(1_000);
  const { permit, blockers, reloadPermits } = useOnlineBlockers();
  const blockerTitle = useBlockerTitle();
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [emergency, setEmergency] = useState<Emergency | null>(null);

  // Emergency mode is an NWS-wide setting (staff switch it on from the control room).
  useEffect(() => {
    supabase()
      .from("app_settings")
      .select("value")
      .eq("key", "EMERGENCY")
      .maybeSingle()
      .then(({ data }) => {
        try {
          setEmergency(data?.value ? (JSON.parse(data.value) as Emergency) : null);
        } catch {
          setEmergency(null);
        }
      });
  }, []);

  // Offline with something missing: the toggle is disabled and the panel under it says what to do.
  const cantGoOnline = !online && blockers.length > 0;
  const done = PRE_CHECK.filter((k) => checks[k]).length;
  const offer = online && !job ? pickOffer(openJobs, seenAt, now) : null;

  async function submit() {
    setSaving(true);
    await submitShiftCheck(Object.fromEntries(PRE_CHECK.map((k) => [k, true])));
    setSaving(false);
  }

  return (
    <main className="screen">
      <div className="ptop">
        <div>
          <h3>{profile.full_name || t("driver")}</h3>
          <div className="sub">
            <bdi>{tanker.plate}</bdi> · {t(`svc_${tanker.service_type}`)} · {f.n(tanker.capacity_gal)} {t("gal")}
          </div>
        </div>
        <div className="d-tools">
          <Link href="/driver/notifications" className="d-bell" aria-label={t("notifications")}>
            <Icon name="bell" />
            {unread > 0 && <span className="badge">{f.d(unread)}</span>}
          </Link>
          <LangToggle />
        </div>
      </div>

      {emergency?.on && (
        <div className="banner badb" role="alert">
          <b>{t("emergencyT", { zone: emergency.zone || t("yourArea") })}</b> {emergency.reason ? `${emergency.reason}. ` : ""}
          {t("emergencyS")}
        </div>
      )}
      {permit?.key === "expiring" && permit.current && (
        <div className="banner">
          <b>{t("permitExpires", { n: f.d(permit.daysLeft ?? 0), date: f.date(permit.current.expires_at) })}</b>{" "}
          {permit.pending ? (
            t("renewalReview")
          ) : (
            <Link className="lk" href="/driver/profile#permit">
              {t("renewInProfile")}
            </Link>
          )}
        </div>
      )}

      <InvitationCards toast={toast} onJoined={refreshTanker} />

      <div className={`card ${online ? "" : "sunk"}`}>
        <div className="row">
          <div>
            <h4>{online ? t("onlineT") : t("offlineT")}</h4>
            <p>
              {job
                ? t("finishTrip")
                : online
                  ? t("onlineS")
                  : cantGoOnline
                    ? blockers.length === 1 && blockers[0].kind === "check"
                      ? t("finishCheck")
                      : t("cantOnline")
                    : t("readyS")}
            </p>
          </div>
          <button
            className={`switch ${online ? "on" : ""}`}
            role="switch"
            aria-checked={online}
            aria-label={cantGoOnline ? t("blkToggle", { reason: blockerTitle(blockers[0]) }) : t("online")}
            aria-describedby={cantGoOnline ? BLOCKERS_ID : undefined}
            title={cantGoOnline ? blockerTitle(blockers[0]) : undefined}
            onClick={toggleOnline}
            disabled={Boolean(job) || cantGoOnline}
          />
        </div>
      </div>
      {!online && !job && <OnlineBlockers blockers={blockers} onApplied={reloadPermits} checkHref="#precheck" />}
      {/* A gentle reminder before going online (required only when NWS switches the rule on: then it's a blocker above). */}
      {!online && !job && training.loaded && !training.complete && !training.required && (
        <Link href="/driver/training" className="card">
          <div className="row">
            <div>
              <h4>{t("trainRemindT", { n: f.d(LESSONS.filter((l) => training.done.includes(l.key)).length), m: f.d(LESSONS.length) })}</h4>
              <p>{t("trainRemindS", { min: f.d(LESSONS.filter((l) => !training.done.includes(l.key)).reduce((s, l) => s + l.minutes, 0)) })}</p>
            </div>
            <span className="lk">{t("startTraining")}</span>
          </div>
        </Link>
      )}

      {online && !job && !hasFix && (
        <div className="card" role="status">
          <h4>
            <Icon name="pin" size={16} /> {t("gpsWaitT")}
          </h4>
          <p>{gpsError ? t("noGpsJobs") : t("gettingGps")}</p>
        </div>
      )}

      {offer && (
        <Link href="/driver/jobs" className="card hl">
          <div className="row">
            <h4>
              {offer.server ? t("offeredT") : t("newJob")} · {f.order(offer.job.order_no)}
            </h4>
            <span className="st warn">{t("secs", { n: f.d(offer.left) })}</span>
          </div>
          <div className="money">{f.omr(offer.job.driver_earnings)}</div>
          <p>
            {f.n(offer.job.gallons)} {t("gal")} · {offer.job.area} · {f.km(Number(offer.job.distance_km))}
            {offer.job.is_emergency ? ` · ${t("emergency")}` : ""}
          </p>
        </Link>
      )}

      {job ? (
        <Link href="/driver/trip" className="card hl">
          <h4>
            {t("jobInProgress")} · {f.order(job.order.order_no)}
          </h4>
          <p>{legs[leg] ? t(`legLabel_${legs[leg].kind}`, { name: legs[leg].site?.name ?? job.loc?.address ?? job.order.area }) : job.order.area}</p>
        </Link>
      ) : (
        !online && (
          <div className="card">
            <h4>{t("startShift")}</h4>
            <ul className="tl">
              <li className={shiftChecked ? "done" : "cur"}>
                {t("preCheck")} <small>{shiftChecked ? t("checkDone") : t("nOfM", { n: f.d(done), m: f.d(PRE_CHECK.length) })}</small>
              </li>
              <li className={shiftChecked ? "cur" : ""}>{t("goOnline")}</li>
              <li>{t("acceptFromJobs")}</li>
            </ul>
          </div>
        )
      )}

      <div className="card">
        <div className="row">
          <div>
            <p>{t("today")}</p>
            <div className="money" style={{ fontSize: 22, whiteSpace: "nowrap" }}>
              {f.omr(today.earned)}
            </div>
          </div>
          <div style={{ textAlign: "end" }}>
            <p>{t("deliveriesN", { n: f.d(today.jobs) })}</p>
            <Link className="lk small" href="/driver/earnings">
              {t("seeEarnings")}
            </Link>
          </div>
        </div>
      </div>

      {!shiftChecked && (
        <>
          <h4 className="d-h4" id="precheck">
            {t("preCheck")}
          </h4>
          <p className="mut small" style={{ margin: "0 0 4px" }}>
            {t("preCheckS")}
          </p>
          {PRE_CHECK.map((k) => (
            <button key={k} type="button" className="d-check" role="checkbox" aria-checked={Boolean(checks[k])} onClick={() => setChecks((c) => ({ ...c, [k]: !c[k] }))}>
              <span className={`d-box ${checks[k] ? "on" : ""}`}>{checks[k] && <Icon name="check" size={14} />}</span>
              {t(`pre_${k}`)}
            </button>
          ))}
          <button className="cta" style={{ marginTop: 14 }} disabled={done < PRE_CHECK.length || saving} onClick={submit}>
            {saving ? t("saving") : t("submitCheck")}
          </button>
        </>
      )}
    </main>
  );
}
