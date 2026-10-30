"use client";

import Link from "next/link";
import { useMemo } from "react";
import { DOC_KINDS, contractCustomer, currentDoc, docLabel, driverOf, permitText, rejectedDoc, tankerPermit, tankerStatus, useCompany, useCompanyOrders, useCompanyTx, useFleet } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { FleetMap } from "@/components/nws/FleetMap";
import { SERVICE_SHORT, TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Kpis, St, daysUntil, dayStart, weekStart } from "@/components/portal/kit";
import { STALE_AFTER_S } from "@/lib/gps";
import { useLang, useT } from "@/lib/i18n";
import { freqLabel, label } from "@/lib/labels";

import { ref } from "@/lib/types";

type Attn = { key: string; tone: "bad" | "warn" | "act"; text: string; href: string; action: string };

export default function CompanyOverview() {
  const { company } = useCompany();
  const fleet = useFleet("overview");
  const { orders } = useCompanyOrders("overview", 14);
  const { tx } = useCompanyTx("overview", 14);
  const t = useT(CO);
  const f = useFmt();
  const { lang } = useLang();

  const today = dayStart().getTime();
  const week = weekStart().getTime();
  const online = fleet.tankers.filter((tk) => tk.is_online && !tk.blocked);
  // Same rule as Jobs: created today, or booked for a window today.
  const jobsToday = orders.filter((o) => (Date.parse(o.created_at) >= today || (o.slot_start && Date.parse(o.slot_start) >= today && Date.parse(o.slot_start) < today + 86_400_000)) && o.status !== "cancelled");
  const doneToday = jobsToday.filter((o) => o.status === "delivered").length;
  // Same figure as Finance → "Earned this week" (tips are shown separately).
  const weekRows = tx.filter((x) => x.bucket === "earnings" && Date.parse(x.created_at) >= week);
  const earnedWeek = weekRows.filter((x) => ["earning", "cancel_fee"].includes(x.kind)).reduce((s, x) => s + Number(x.amount), 0);
  const tipsWeek = weekRows.filter((x) => x.kind === "tip").reduce((s, x) => s + Number(x.amount), 0);
  const assigned = new Set(fleet.assignments.map((a) => a.driver_id));
  const rated = orders.filter((o) => o.rating);
  const avgRating = rated.length ? rated.reduce((s, o) => s + (o.rating ?? 0), 0) / rated.length : null;

  const attention = useMemo(() => {
    const out: Attn[] = [];
    const en = lang === "en";
    // A document's name inside a sentence (lower case in English).
    const docIn = (kind: string) => (en ? docLabel(kind).toLowerCase() : docLabel(kind, lang));
    for (const tk of fleet.tankers) {
      const p = tankerPermit(tk, fleet.permits);
      const plate = tk.plate;
      if (tk.blocked) out.push({ key: `b${tk.id}`, tone: "bad", text: tk.blocked_reason ? t("attBlockedR", { plate, reason: tk.blocked_reason }) : t("attBlocked", { plate }), href: "/company/tankers", action: t("actView") });
      const renewing = fleet.permits.some((x) => x.tanker_id === tk.id && x.status === "pending");
      if (!p.valid && p.text !== "Pending review") {
        const state = p.text === "Expired" ? t("attPermitExpired") : en ? p.text.toLowerCase() : permitText(tk, fleet.permits, lang);
        out.push({ key: `p${tk.id}`, tone: "bad", text: t("attNoPermit", { plate, state }), href: "/company/permits", action: t("actRenew") });
      } else if (!p.valid && renewing)
        // A pending renewal doesn't let the tanker work: say so rather than dropping it from the list.
        out.push({ key: `p${tk.id}`, tone: "bad", text: t("attRenewing", { plate }), href: "/company/permits", action: t("actView") });
      else if (p.tone === "warn" && p.valid)
        out.push({ key: `p${tk.id}`, tone: "warn", text: t("attPermitState", { plate, state: en ? p.text.toLowerCase() : permitText(tk, fleet.permits, lang) }), href: "/company/permits", action: t("actRenew") });
      const info = fleet.permits.find((x) => x.tanker_id === tk.id && x.status === "pending" && x.info_requested);
      if (info) out.push({ key: `i${info.id}`, tone: "warn", text: t("attInfo", { plate, q: info.info_requested ?? "" }), href: "/company/permits", action: t("actOpen") });
      for (const d of DOC_KINDS) {
        if (d.kind === "water_test" && tk.service_type !== "DW") continue;
        const rej = rejectedDoc(fleet.docs, d.kind, { tanker: tk.id });
        if (rej)
          out.push({
            key: `r${rej.id}`,
            tone: "bad",
            text: rej.review_note ? t("attDocRejectedR", { doc: docIn(d.kind), plate, note: rej.review_note }) : t("attDocRejected", { doc: docIn(d.kind), plate }),
            href: "/company/compliance",
            action: t("actReupload"),
          });
        const doc = currentDoc(fleet.docs, d.kind, { tanker: tk.id });
        if (!doc) continue;
        const n = daysUntil(doc.valid_to);
        if (n < 0) out.push({ key: `d${doc.id}`, tone: "bad", text: t("attDocExpired", { doc: docLabel(d.kind, lang), plate, date: f.day(doc.valid_to) }), href: "/company/compliance", action: t("actUpload") });
        else if (n <= 30) out.push({ key: `d${doc.id}`, tone: "warn", text: t("attDocExpires", { doc: docLabel(d.kind, lang), plate, date: f.day(doc.valid_to) }), href: "/company/compliance", action: t("actUpload") });
      }
    }
    for (const dr of fleet.drivers) {
      const lic = currentDoc(fleet.docs, "heavy_licence", { driver: dr.id });
      if (lic && daysUntil(lic.valid_to) <= 30)
        out.push({
          key: `l${lic.id}`,
          tone: daysUntil(lic.valid_to) < 0 ? "bad" : "warn",
          text: daysUntil(lic.valid_to) < 0 ? t("attLicExpired", { name: dr.full_name }) : t("attLicExpires", { name: dr.full_name, n: f.n(daysUntil(lic.valid_to)) }),
          href: "/company/compliance",
          action: t("actUpload"),
        });
    }
    for (const c of fleet.contracts.filter((k) => k.status === "pending_owner"))
      out.push({
        key: `c${c.id}`,
        tone: "act",
        text: t("attOffer", {
          ref: `⁦${ref.contract(c.contract_no)}⁩`,
          who: contractCustomer(c, lang),
          gal: f.n(c.gallons),
          svc: en ? SERVICE_SHORT[c.service_type].toLowerCase() : label("svcShort", c.service_type, lang),
          freq: en ? freqLabel(c.frequency).toLowerCase() : freqLabel(c.frequency, lang),
        }),
        href: "/company/jobs",
        action: t("actReview"),
      });
    for (const a of fleet.alerts.filter((x) => x.state === "open").slice(0, 8)) {
      const tk = fleet.tankers.find((x) => x.id === a.tanker_id);
      out.push({ key: `a${a.id}`, tone: a.severity === "high" ? "bad" : "warn", text: `${tk ? `${tk.plate}: ` : ""}${a.message}`, href: "/company/tankers", action: t("actView") });
    }
    const rank = { bad: 0, warn: 1, act: 2 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [fleet, t, f, lang]);

  const mapTankers = fleet.tankers
    .filter((tk) => tk.last_lat != null && tk.last_lng != null && (tk.is_online || tk.blocked))
    .map((tk) => ({
      id: tk.id,
      lat: tk.last_lat!,
      lng: tk.last_lng!,
      type: tk.service_type,
      stale: tk.location_age_s == null || tk.location_age_s > STALE_AFTER_S,
      blocked: tk.blocked,
      label: `${tk.plate} · ${driverOf(fleet, tk.id)?.full_name ?? t("noDriverL")}`,
    }));

  const blockedN = fleet.tankers.filter((tk) => tk.blocked).length;
  return (
    <>
      <Kpis
        items={[
          { label: t("kOnline"), value: t("kOnlineV", { n: f.n(online.length), total: f.n(fleet.tankers.length) }), sub: blockedN ? t("kBlockedN", { n: f.n(blockedN) }) : t("kNoneBlocked"), tone: blockedN ? "bad" : "ok" },
          { label: t("kJobsToday"), value: f.n(jobsToday.length), sub: t("kJobsSub", { done: f.n(doneToday), prog: f.n(jobsToday.length - doneToday) }) },
          { label: t("drivers"), value: f.n(fleet.drivers.length), sub: t("kOnTanker", { n: f.n(fleet.drivers.filter((d) => assigned.has(d.id)).length) }) },
          { label: t("kEarnedWeek"), value: f.omr(earnedWeek), sub: t("kEarnedSub", { tips: f.omr(tipsWeek), bal: f.omr(company.earnings_balance) }) },
          { label: t("kRating"), value: `${f.n(Number(avgRating ?? company.rating), 1)} ★`, sub: rated.length ? t("kRatedSub", { n: f.n(rated.length) }) : t("kNwsRating") },
        ]}
      />
      <div className="half">
        <div className="panel">
          <h2>
            {t("needAttention")} <small>{attention.length ? (attention.length > 1 ? t("itemsN", { n: f.n(attention.length) }) : t("items1")) : ""}</small>
          </h2>
          {!fleet.loaded ? (
            <div className="empty">{t("loading")}</div>
          ) : attention.length === 0 ? (
            <div className="empty">{t("allInOrder")}</div>
          ) : (
            <div className="attn">
              {attention.map((a) => (
                <div key={a.key}>
                  <span>
                    <St tone={a.tone} />
                    {a.text}
                  </span>
                  <Link className="btn sm" href={a.href}>
                    {a.action}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <h2>
            {t("liveFleet")} <small>{mapTankers.length ? t("onMapN", { n: f.n(mapTankers.length) }) : t("noTankerOnline")}</small>
          </h2>
          <div className="pad">
            <div className="mapcard short">
              <FleetMap tankers={mapTankers} orders={[]} />
              {!mapTankers.length && <div className="ov-empty">{t("mapEmpty")}</div>}
            </div>
          </div>
          <div className="tblwrap">
            <table>
              <tbody>
                {fleet.tankers.map((tk) => {
                  const [s, tone] = tankerStatus(tk, fleet.permits, company.status === "suspended", lang);
                  return (
                    <tr key={tk.id}>
                      <td className="tk-plate">{tk.plate}</td>
                      <td>
                        <TypeTag type={tk.service_type} />
                      </td>
                      <td>{driverOf(fleet, tk.id)?.full_name ?? <span className="mut">{t("noDriver")}</span>}</td>
                      <td>
                        <St tone={tone}>{s}</St>
                      </td>
                    </tr>
                  );
                })}
                {fleet.loaded && !fleet.tankers.length && (
                  <tr>
                    <td className="mut">
                      {t("noTankersYet")}{" "}
                      <Link className="lk" href="/company/tankers">
                        {t("registerFirst")}
                      </Link>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
