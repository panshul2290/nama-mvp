"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { CollectBox } from "@/components/driver/Collect";
import { DICT, useErrText, useFmt } from "@/components/driver/i18n";
import { nearestSite } from "@/components/driver/legs";
import { feeFactorList, pickOffer } from "@/components/driver/offer";
import { BLOCKERS_ID, OnlineBlockers, useBlockerTitle, useOnlineBlockers } from "@/components/driver/OnlineBlockers";
import { useNow } from "@/components/driver/useNow";
import { Icon } from "@/components/icons";
import { RuleTag } from "@/components/OrderBits";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type OpenRequest } from "@/lib/types";

type Tab = "open" | "contracts" | "scheduled";
type Scheduled = { id: string; order_no: number; service_type: OpenRequest["service_type"]; gallons: number; area: string; slot_label: string | null; slot_start: string | null; driver_earnings: string; contract_no: number | null };

export default function JobsPage() {
  const router = useRouter();
  const { tanker, online, toggleOnline, job, openJobs, seenAt, acceptJob, declineJob, passOffer, hasFix, gpsError, sites, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const errText = useErrText();
  const now = useNow(1_000);
  const [tab, setTab] = useState<Tab>("open");
  const [accepting, setAccepting] = useState<string | null>(null);
  const [passing, setPassing] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<Scheduled[] | null>(null);
  const { permit, blockers, reloadPermits } = useOnlineBlockers();
  const blockerTitle = useBlockerTitle();
  // Offline with something missing: the toggle is disabled and the panel says what to do.
  const cantGoOnline = !online && !job && blockers.length > 0;

  useEffect(() => {
    if (tab !== "scheduled") return;
    supabase()
      .rpc("driver_scheduled_jobs")
      .then(({ data }) => setScheduled((data ?? []) as Scheduled[]));
  }, [tab]);

  async function accept(id: string) {
    setAccepting(id);
    const error = await acceptJob(id);
    setAccepting(null);
    if (error) return toast(errText(error));
    router.push("/driver/trip");
  }

  const contracts = openJobs.filter((r) => r.contract_no != null);
  const offer = pickOffer(openJobs, seenAt, now);
  const list = (tab === "contracts" ? contracts : openJobs).filter((r) => r.id !== offer?.job.id || tab === "contracts");
  const busy = accepting !== null || !online || Boolean(job);

  const tags = (r: OpenRequest) => (
    <>
      {r.is_test && <span className="st warn">{t("testTag")}</span>}
      {r.is_emergency && <span className="st bad">{t("emergency")}</span>}
      {r.contract_no != null && <span className="st act">{t("contractN", { n: f.d(ref.contract(r.contract_no)) })}</span>}
    </>
  );
  const when = (r: { slot_label?: string | null }) => r.slot_label || t("asap");
  // DW/TE trips start at the nearest filling station; WW ends at a discharge site.
  // Test-zone jobs (0020) use the test station / plant wherever the tanker is.
  const via = (r: OpenRequest) => {
    const ww = r.service_type === "WW";
    if (r.is_test) return t(ww ? "dischargeAt" : "fillAt", { name: t(ww ? "testPlant" : "testStation") });
    const s = nearestSite(sites, ww ? "discharge" : "fill", r.service_type, null);
    return s ? t(ww ? "dischargeAt" : "fillAt", { name: s.name }) : null;
  };

  return (
    <main className="screen">
      <div className="dj-h">
        <div>
          <h3>{t("tJobs")}</h3>
          <small>
            <bdi>{tanker.plate}</bdi> · {t(`svc_${tanker.service_type}`)} · {f.n(tanker.capacity_gal)} {t("gal")}
          </small>
        </div>
        <button
          className={`d-onl ${online ? "on" : ""}`}
          onClick={toggleOnline}
          disabled={Boolean(job) || cantGoOnline}
          aria-pressed={online}
          aria-describedby={cantGoOnline ? BLOCKERS_ID : undefined}
          title={cantGoOnline ? t("blkToggle", { reason: blockerTitle(blockers[0]) }) : undefined}
        >
          <i />
          {online ? t("online") : t("offline")}
        </button>
      </div>

      {cantGoOnline && <OnlineBlockers blockers={blockers} onApplied={reloadPermits} checkHref="/driver#precheck" />}
      {!online && !cantGoOnline && (
        <div className="dj-ban">
          <Icon name="alert" />
          <span>{t("offlineBan")}</span>
        </div>
      )}
      {permit?.key === "expiring" && (
        <div className="dj-ban">
          <Icon name="alert" />
          <span>{t("permitExpiresShort", { n: f.d(permit.daysLeft ?? 0) })}</span>
        </div>
      )}
      {job && <div className="banner info">{t("finishFirst")}</div>}
      {online && !job && !hasFix && (
        <div className="dj-ban">
          <Icon name="pin" />
          <span>{gpsError ? t("noGpsJobs") : t("gettingGps")}</span>
        </div>
      )}

      <div className="seg" role="tablist">
        {(
          [
            ["open", t("segOpen", { n: f.d(openJobs.length) })],
            ["contracts", t("segContracts", { n: f.d(contracts.length) })],
            ["scheduled", t("segScheduled")],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab === "open" && offer && (
        <div className="d-offer">
          <div className="row">
            <b className="nj">{offer.server ? t("offeredT") : t("newJob")}</b>
            <span className="d-cdn" role="timer" aria-live="off">
              <Icon name="clock" />
              {offer.server ? t("secs", { n: f.d(offer.left) }) : t("toAccept", { n: f.d(offer.left) })}
            </span>
          </div>
          <div className="money">{f.omr(offer.job.driver_earnings)}</div>
          <small>
            {t("expectedTrip")} <RuleTag status={offer.job.earnings_status} />
          </small>
          <CollectBox amount={offer.job.collect_omr} />
          {feeFactorList(offer.job.fee_factors).length > 0 && (
            <small className="d-block">
              {feeFactorList(offer.job.fee_factors)
                .map(([k, v]) => t(`ff_${k}`, { x: f.d(String(Math.round(v * 100) / 100)) }))
                .join(" · ")}
            </small>
          )}
          <div className="d-rows">
            <div>
              <Icon name="pin" />
              <span>
                <b>{offer.job.area}</b>
                <small>
                  {t("kmAway", { km: f.km(Number(offer.job.distance_km)) })} · {when(offer.job)}
                </small>
              </span>
            </div>
            {via(offer.job) && (
              <div>
                <Icon name="route" />
                <span>
                  <b>{via(offer.job)}</b>
                  <small>{offer.job.service_type === "WW" ? t("afterCollection") : t("onTheWay")}</small>
                </span>
              </div>
            )}
          </div>
          <div className="d-tag">
            <span className={`tag ${offer.job.service_type}`}>{t(`svc_${offer.job.service_type}`)}</span>
            <small>
              {f.n(offer.job.gallons)} {t("gal")} · {f.order(offer.job.order_no)}
            </small>
            {tags(offer.job)}
          </div>
          <div className="d-btns">
            {offer.server ? (
              <button
                className="cta sec"
                disabled={accepting !== null || passing !== null}
                onClick={async () => {
                  setPassing(offer.job.id);
                  await passOffer(offer.job.id);
                  setPassing(null);
                }}
              >
                {passing === offer.job.id ? t("sending") : t("passOffer")}
              </button>
            ) : (
              <button className="cta sec" onClick={() => declineJob(offer.job.id)} disabled={accepting !== null}>
                {t("decline")}
              </button>
            )}
            <button className="cta" onClick={() => accept(offer.job.id)} disabled={busy}>
              {accepting === offer.job.id ? t("accepting") : t("acceptJob")}
            </button>
          </div>
        </div>
      )}

      {tab !== "scheduled" && (
        <>
          {tab === "open" && <h4 className="ch-sec">{offer ? t("otherJobs") : t("openJobs")}</h4>}
          {list.length === 0 ? (
            <div className="empty">{!online || job ? t("jobsWhenOnline") : tab === "contracts" ? t("noContracts") : offer ? t("noOther") : tab === "open" && !hasFix ? t("gpsWaitT") : t("noJobs")}</div>
          ) : (
            list.map((r) => (
              <div key={r.id} className="dj-job">
                <div className="row">
                  <span>
                    <b>{f.order(r.order_no)}</b>
                    {tags(r)}
                  </span>
                  <b className="e num">
                    {f.omr(r.driver_earnings)} <RuleTag status={r.earnings_status} />
                  </b>
                </div>
                <small>
                  {f.n(r.gallons)} {t("gal")} · {r.area} · {f.km(Number(r.distance_km))} · {when(r)}
                </small>
                <small>{t("youEarn", { amt: f.omr(r.driver_earnings) })}</small>
                <CollectBox amount={r.collect_omr} compact />
                <button className="btn sm pri" disabled={busy} onClick={() => accept(r.id)}>
                  {accepting === r.id ? t("accepting") : t("accept")}
                </button>
              </div>
            ))
          )}
        </>
      )}

      {tab === "scheduled" && (
        <>
          <p className="mut small" style={{ margin: "0 0 10px" }}>
            {t("releasedNote")}
          </p>
          {scheduled == null ? (
            <div className="empty">{t("loading")}</div>
          ) : scheduled.length === 0 ? (
            <div className="empty">{t("noScheduled")}</div>
          ) : (
            scheduled.map((s) => (
              <div key={s.id} className="dj-job">
                <div className="row">
                  <span>
                    <b>{f.order(s.order_no)}</b>
                    {s.contract_no != null && <span className="st act">{t("contractN", { n: f.d(ref.contract(s.contract_no)) })}</span>}
                  </span>
                  <b className="e num">{f.omr(s.driver_earnings)}</b>
                </div>
                <small>
                  {f.n(s.gallons)} {t("gal")} · {s.area} · {s.slot_start ? `${f.date(s.slot_start)} ` : ""}
                  {s.slot_label ?? ""}
                </small>
              </div>
            ))
          )}
        </>
      )}
    </main>
  );
}
