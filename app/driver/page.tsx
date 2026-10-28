"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { DICT, useFmt } from "@/components/driver/i18n";
import { pickOffer } from "@/components/driver/offer";
import { permitState, usePermits } from "@/components/driver/permit";
import { useNow } from "@/components/driver/useNow";
import { Icon } from "@/components/icons";
import { LangToggle, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

/** Safety pre-check items, keyed as submit_shift_check() expects. */
const PRE_CHECK = ["tyres_brakes_lights", "valves_sealed", "hatch_locked", "ppe", "hose_sanitised"] as const;

type Emergency = { on: boolean; zone: string | null; reason: string | null };

export default function DriverHome() {
  const { profile, tanker, online, toggleOnline, shiftChecked, submitShiftCheck, job, legs, leg, today, openJobs, seenAt, unread } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const now = useNow(1_000);
  const { rows: permits } = usePermits(tanker.id);
  const permit = permits && now ? permitState(permits, tanker.service_type, now) : null;
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

  const noPermit = permit != null && (permit.key === "expired" || permit.key === "rejected" || permit.key === "wrong" || permit.key === "none");
  const cantGoOnline = !online && (Boolean(tanker.blocked) || noPermit || !shiftChecked);
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
            {tanker.plate} · {t(`svc_${tanker.service_type}`)} · {f.n(tanker.capacity_gal)} {t("gal")}
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
      {tanker.blocked && (
        <div className="banner badb" role="alert">
          <b>{t("blockedT")}</b> {tanker.blocked_reason ? t("reasonX", { reason: tanker.blocked_reason }) : ""} {t("blockedS")}
        </div>
      )}
      {!tanker.blocked && noPermit && permit && (
        <div className="banner badb" role="alert">
          <b>{t(`permit_${permit.key}`)}.</b> {permit.pending ? t("renewalReview") : t("noPermitS", { svc: t(`svc_${tanker.service_type}`) })}{" "}
          {!permit.pending && (
            <Link className="lk" href="/driver/profile#permit">
              {t("renewNow")}
            </Link>
          )}
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

      <div className={`card ${online ? "" : "sunk"}`}>
        <div className="row">
          <div>
            <h4>{online ? t("onlineT") : t("offlineT")}</h4>
            <p>
              {job
                ? t("finishTrip")
                : online
                  ? t("onlineS")
                  : !shiftChecked
                    ? t("finishCheck")
                    : cantGoOnline
                      ? t("cantOnline")
                      : t("readyS")}
            </p>
          </div>
          <button
            className={`switch ${online ? "on" : ""}`}
            role="switch"
            aria-checked={online}
            aria-label={t("online")}
            onClick={toggleOnline}
            disabled={Boolean(job) || cantGoOnline}
          />
        </div>
      </div>

      {offer && (
        <Link href="/driver/jobs" className="card hl">
          <div className="row">
            <h4>
              {t("newJob")} · {f.order(offer.job.order_no)}
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
          <h4 className="d-h4">{t("preCheck")}</h4>
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
