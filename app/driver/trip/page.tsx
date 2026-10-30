"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChatButton, ChatSheet, useChatHub, type ChatLabels } from "@/components/chat/OrderChat";
import { useDriver } from "@/components/DriverContext";
import { useJobChat } from "@/components/driver/DriverChat";
import { DICT, useFmt } from "@/components/driver/i18n";
import { insideGeofence, metresTo } from "@/components/driver/legs";
import { IssueSheet, PodSheet } from "@/components/driver/TripSheets";
import { Icon } from "@/components/icons";
import { Map } from "@/components/Map";
import { RuleTag } from "@/components/OrderBits";
import { useRoadEta } from "@/components/useRoadEta";
import { initials } from "@/lib/format";
import { distanceKm, DEFAULT_CENTER } from "@/lib/geo";
import { useLang, useT } from "@/lib/i18n";
import type { Order } from "@/lib/types";

const QUICK = ["msgLate", "msg5", "msgGate", "msgCover"];

export default function TripPage() {
  const { job, leg, finished } = useDriver();
  if (!job) return <NoTrip finished={finished} />;
  // Remount per leg so the ETA and simulator state start fresh for the new target.
  return <Trip key={`${job.order.id}:${leg}`} />;
}

function NoTrip({ finished }: { finished: Order | null }) {
  const t = useT(DICT);
  const f = useFmt();
  const ww = finished?.service_type === "WW";
  return (
    <main className="screen">
      <div className="dj-h">
        <div>
          <h3>{t("tTrip")}</h3>
          <small>{t("noTrip")}</small>
        </div>
      </div>
      {finished && (
        <>
          <div className="done-hero">
            <Icon name="check" />
            <div>
              <b>{t(ww ? "dischargedX" : "deliveredX", { order: f.order(finished.order_no) })}</b>
              <small>{t("youEarned", { amt: f.omr(finished.driver_earnings) })}</small>
            </div>
          </div>
          {ww && finished.discharge_verified != null && (
            <div className={`banner ${finished.discharge_verified ? "okb" : ""}`}>{finished.discharge_verified ? t("valveOk") : t("valveFlagged")}</div>
          )}
          {!ww && finished.fill_verified != null && (
            <div className={`banner ${finished.fill_verified ? "okb" : ""}`}>{finished.fill_verified ? t("fillOk") : t("fillFlagged")}</div>
          )}
        </>
      )}
      <div className="empty">
        {t("acceptToStart")}
        <br />
        <br />
        <Link href="/driver/jobs" className="btn pri">
          {t("openJobs")}
        </Link>
      </div>
    </main>
  );
}

function Trip() {
  const { job, legs, leg, me, jobAction, acting, wakeLock, demoMode, sim, startSimulation, stopSimulation, toast, fillShort } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const [pod, setPod] = useState(false);
  const [issue, setIssue] = useState(false);
  const [chatTapped, setChatTapped] = useState(false);
  const chat = useJobChat();
  const hub = useChatHub();
  const { lang, dir } = useLang();
  const o = job!.order;
  const loc = job!.loc;
  const cur = legs[leg];
  const next = legs[leg + 1];
  const site = cur?.site ?? null;
  const ww = o.service_type === "WW";
  const arrived = cur?.kind === "cust" && o.status === "arrived";
  const inside = cur?.kind !== "cust" && insideGeofence(site, me);
  const atTarget = arrived || inside;
  const eta = useRoadEta(!atTarget ? me : null, cur?.target ?? null, { withPath: true });
  const legKey = `${o.id}:${leg}`;

  // The chat sheet opens from the button here, or from a message banner elsewhere in the app.
  const chatOpen = chatTapped || hub.pending === o.id;
  const { setActive } = hub;
  useEffect(() => {
    if (!chatOpen) return;
    setActive(o.id);
    return () => setActive(null);
  }, [chatOpen, o.id, setActive]);

  async function confirmFill() {
    const r = await jobAction("confirm_fill");
    if (r) toast(r.fill_verified ? t("fillOk") : t("fillFlagged"));
  }

  async function confirmDischarge() {
    const r = await jobAction("confirm_discharge");
    if (r) toast(r.discharge_verified ? t("valveOk") : t("valveFlagged"));
  }

  if (!cur) return null;
  const last = chat?.msgs.at(-1) ?? null;
  const fillBanner = fillShort && !o.filled_at && (
    <div className="banner badb" role="alert">
      <b>{t("fcShortT")}</b> {t("fcShortS")}{" "}
      <Link className="lk" href="/driver/earnings#fill">
        {t("fcTopupLink")}
      </Link>
    </div>
  );
  const chatLabels: ChatLabels = {
    title: job!.customer?.full_name || t("customer"),
    subtitle: t("chatCustSub", { order: f.order(o.order_no) }),
    initials: job!.customer?.full_name ? initials(job!.customer.full_name) : undefined,
    placeholder: t("typeMsg"),
    send: t("send"),
    close: t("close"),
    call: t("callCustomer"),
    masked: t("chatMasked"),
    empty: t("chatEmpty"),
    closedNote: t("chatClosed"),
    sent: t("chatSent"),
    read: t("chatRead"),
    nws: t("chatNws"),
    quickTitle: t("chatQuick"),
  };
  const titles = { fill: site?.name ?? t("noSite"), cust: loc?.address || o.area, discharge: site?.name ?? t("noSite") };
  const away = metresTo(site, me);
  const etaText = eta
    ? t(eta.source === "osrm" ? "etaRoad" : "etaLine", { km: f.km(eta.km), min: f.d(eta.minutes) })
    : cur.target
      ? t("waitingGps")
      : t("noTarget");
  const pill: [string, string] =
    cur.kind === "fill"
      ? inside
        ? [t("insideFill"), "ok"]
        : [t("drivingFill"), "act"]
      : cur.kind === "discharge"
        ? inside
          ? [t("insideDischarge"), "ok"]
          : [t("drivingDischarge"), "act"]
        : arrived
          ? [t("arrivedCust"), "ok"]
          : [t("drivingCust"), "act"];
  const geofence = site && (
    <div>
      <Icon name="shield" />
      <span>
        <small>{cur.kind === "fill" ? t("stationGeofence") : t("approvedSite")}</small>
        <b>{inside ? t("insideR", { r: f.d(site.radius_m) }) : away != null ? t("awayUnlocks", { d: f.km(away / 1000) }) : t("unlocks")}</b>
      </span>
      {inside && <span className="st ok">{t("geofenceOk")}</span>}
    </div>
  );

  return (
    <main className="screen flush">
      <div className="tr-map short">
        <Map
          center={cur.target ?? me ?? DEFAULT_CENTER}
          destination={cur.target}
          destKind={cur.kind === "cust" ? "home" : cur.kind}
          geofenceM={site?.radius_m ?? null}
          me={me}
          route={atTarget ? null : (eta?.path ?? null)}
          follow
          padBottom={30}
        />
        <div className="tr-chip">
          <b>{f.order(o.order_no)}</b>
          <span className="mut">· {t("stepOf", { n: f.d(leg + 1), m: f.d(legs.length) })}</span>
          {o.is_test && <span className="st warn">{t("testTag")}</span>}
        </div>
      </div>

      <div className="sheet2">
        <i className="grab" aria-hidden="true" />
        <span className={`st ${pill[1]}`}>{pill[0]}</span>
        <h3 className="tj-t">{titles[cur.kind]}</h3>
        <small className="mut">{arrived ? t("atDeliveryPoint") : inside ? t("insideNote") : etaText}</small>

        {cur.kind === "fill" && fillBanner}
        {o.is_test && cur.kind !== "cust" && (
          <div className="banner okb" style={{ marginTop: 12 }}>
            {t("testNote")}
          </div>
        )}

        {cur.kind === "cust" && o.fill_verified === false && (
          <div className="banner" style={{ marginTop: 12 }}>
            {t("fillFlagged")}
          </div>
        )}

        <div className="tj-box">
          {cur.kind === "fill" && (
            <>
              <div>
                <Icon name="drop" />
                <span>
                  <small>{t("fill")}</small>
                  <b>
                    {f.n(o.gallons)} {t("gal")} · {t(`svc_${o.service_type}`)}
                  </b>
                </span>
              </div>
              <div>
                <Icon name="chart" />
                <span>
                  <small>{t("stationMeter")}</small>
                  <b>
                    {f.n(o.gallons)} {t("gal")}
                  </b>
                </span>
                <span className="st">{t("waiting")}</span>
              </div>
              <div>
                <Icon name="coins" />
                <span>
                  <small>{t("fillCredit")}</small>
                  <b>{t("deductedAtStation", { amt: f.omr(o.water_charge) })}</b>
                </span>
              </div>
              {geofence}
            </>
          )}
          {cur.kind === "cust" && (
            <>
              <div>
                <Icon name="drop" />
                <span>
                  <small>{ww ? t("collect") : t("deliver")}</small>
                  <b>
                    {f.n(o.gallons)} {t("gal")} · {t(`svc_${o.service_type}`)}
                  </b>
                </span>
              </div>
              {o.filled_at && (
                <>
                  <div>
                    <Icon name="chart" />
                    <span>
                      <small>{t("stationMeter")}</small>
                      <b>
                        {f.n(o.fill_meter_gal ?? o.gallons)} {t("gal")}
                      </b>
                    </span>
                    {o.fill_verified ? <span className="st ok">{t("match")}</span> : <span className="st warn">{t("flagged")}</span>}
                  </div>
                  <div>
                    <Icon name="coins" />
                    <span>
                      <small>{t("fillCreditDeducted")}</small>
                      <b>−{f.omr(o.water_charge)}</b>
                    </span>
                  </div>
                </>
              )}
              <div>
                <Icon name="pin" />
                <span>
                  <small>{t("custNote")}</small>
                  <b>{o.driver_note || t("noNote")}</b>
                </span>
              </div>
              <div>
                <Icon name="user" />
                <span>
                  <small>{t("customer")}</small>
                  <b>
                    {job!.customer?.full_name || t("customer")} · {t("maskedNo")}
                  </b>
                </span>
              </div>
              <div>
                <Icon name="coins" />
                <span>
                  <small>{t("yourEarnings")}</small>
                  <b>
                    {f.omr(o.driver_earnings)} <RuleTag status={o.price_basis?.earnings} />
                  </b>
                </span>
              </div>
            </>
          )}
          {cur.kind === "discharge" && (
            <>
              <div>
                <Icon name="drop" />
                <span>
                  <small>{t("discharge")}</small>
                  <b>{t("galWastewater", { n: f.n(o.gallons) })}</b>
                </span>
              </div>
              {geofence}
              <div>
                <Icon name="zap" />
                <span>
                  <small>{t("valveSensor")}</small>
                  <b>{t("valveOpens")}</b>
                </span>
              </div>
              <div>
                <Icon name="check" />
                <span>
                  <small>{t("collectedAt")}</small>
                  <b>{loc?.address || o.area}</b>
                </span>
              </div>
            </>
          )}
        </div>

        {cur.kind === "fill" &&
          (inside ? (
            <button className="cta" disabled={acting} onClick={confirmFill}>
              {acting ? t("saving") : t("confirmFill", { n: f.n(o.gallons) })}
            </button>
          ) : (
            <>
              <button className="cta" disabled>
                {t("unlocks")}
              </button>
              <button type="button" className="lk small d-override" disabled={acting} onClick={confirmFill}>
                {t("fillAnyway")}
              </button>
            </>
          ))}
        {cur.kind === "cust" &&
          (arrived ? (
            <button className="cta" onClick={() => setPod(true)}>
              {ww ? t("capturePodC") : t("capturePodD")}
            </button>
          ) : (
            <button className="cta" disabled={acting} onClick={() => jobAction("mark_arrived")}>
              {acting ? t("saving") : t("markArrived")}
            </button>
          ))}
        {cur.kind === "discharge" &&
          (inside ? (
            <button className="cta" disabled={acting} onClick={confirmDischarge}>
              {acting ? t("saving") : t("confirmDischarge", { name: site?.name ?? "" })}
            </button>
          ) : (
            <>
              <button className="cta" disabled>
                {t("unlocks")}
              </button>
              <button type="button" className="lk small d-override" disabled={acting} onClick={confirmDischarge}>
                {t("dischargeAnyway")}
              </button>
            </>
          ))}

        {next && (
          <div className="d-next">
            <Icon name="pin" />
            <span>
              <b>{t("nextX", { name: next.kind === "cust" ? loc?.address || o.area : (next.site?.name ?? t("noSite")) })}</b>
              <small>
                {cur.target && next.target ? `${f.km(distanceKm(cur.target, next.target))} · ` : ""}
                {t("custNotified")}
              </small>
            </span>
          </div>
        )}

        {demoMode && !arrived && (
          <div className="reco sim">
            {!sim || sim.leg !== legKey ? (
              <>
                <button type="button" className="btn sm" onClick={startSimulation} disabled={!cur.target}>
                  {t("simulate")}
                </button>
                <span>{t(`simNote_${cur.kind}`)}</span>
              </>
            ) : (
              <>
                <button type="button" className="btn sm" onClick={stopSimulation}>
                  {t("stop")}
                </button>
                <span>
                  {sim.status === "loading"
                    ? t("simPlanning")
                    : sim.status === "done"
                      ? t(`simDone_${cur.kind}`)
                      : t(sim.source === "osrm" ? "simRunning" : "simRunningLine", { left: f.km(sim.leftKm), total: f.km(sim.totalKm) })}
                </span>
              </>
            )}
          </div>
        )}

        <div className="oc-actions">
          <ChatButton label={t("msgCustomer")} unread={chat?.unread ?? 0} lang={lang} onClick={() => setChatTapped(true)} />
          <button type="button" className="oc-btn sec" onClick={() => toast(t("callMasked"))}>
            <Icon name="phone" />
            {t("call")}
          </button>
        </div>
        {last && (
          <button type="button" className={`d-last ${last.sender_role !== "driver" && !last.read_at ? "new" : ""}`} onClick={() => setChatTapped(true)}>
            <small>{last.sender_role === "driver" ? t("you") : last.sender_role === "staff" ? t("nwsControl") : t("customer")}</small>
            <span>{last.body}</span>
          </button>
        )}

        <div className="tj-links">
          <span />
          {o.status !== "collected" && (
            <button type="button" className="lk bad" onClick={() => setIssue(true)}>
              {t("reportProblem")}
            </button>
          )}
        </div>
        <p className="tr-note">
          {t("sharingLoc")} {wakeLock === "held" ? t("screenOn") : wakeLock === "off" ? "" : t("screenOff")}
        </p>
      </div>

      {chatOpen && chat && (
        <ChatSheet
          chat={chat}
          me="driver"
          lang={lang}
          dir={dir}
          labels={chatLabels}
          quick={QUICK.map((k) => ({ text: t(k) }))}
          canSend
          onClose={() => {
            setChatTapped(false);
            hub.clearPending();
          }}
          onCall={() => toast(t("callMasked"))}
          onError={(m) => toast(m)}
        />
      )}
      {pod && <PodSheet onClose={() => setPod(false)} />}
      {issue && <IssueSheet onClose={() => setIssue(false)} />}
    </main>
  );
}
