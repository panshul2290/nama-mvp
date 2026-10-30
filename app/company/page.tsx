"use client";

import Link from "next/link";
import { useMemo } from "react";
import { DOC_KINDS, DOC_LABEL, FREQ_LABEL, contractCustomer, currentDoc, driverOf, rejectedDoc, tankerPermit, tankerStatus, useCompany, useCompanyOrders, useCompanyTx, useFleet } from "@/components/company/CompanyContext";
import { FleetMap } from "@/components/nws/FleetMap";
import { SERVICE_SHORT, TypeTag } from "@/components/OrderBits";
import { Kpis, St, daysUntil, dayStart, fmtShort, omr, weekStart } from "@/components/portal/kit";
import { STALE_AFTER_S } from "@/lib/gps";

import { ref } from "@/lib/types";

type Attn = { key: string; tone: "bad" | "warn" | "act"; text: string; href: string; action: string };

export default function CompanyOverview() {
  const { company } = useCompany();
  const fleet = useFleet("overview");
  const { orders } = useCompanyOrders("overview", 14);
  const { tx } = useCompanyTx("overview", 14);

  const today = dayStart().getTime();
  const week = weekStart().getTime();
  const online = fleet.tankers.filter((t) => t.is_online && !t.blocked);
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
    for (const t of fleet.tankers) {
      const p = tankerPermit(t, fleet.permits);
      if (t.blocked) out.push({ key: `b${t.id}`, tone: "bad", text: `${t.plate} is blocked by NWS${t.blocked_reason ? ` — ${t.blocked_reason}` : ""}`, href: "/company/tankers", action: "View" });
      const renewing = fleet.permits.some((x) => x.tanker_id === t.id && x.status === "pending");
      if (!p.valid && p.text !== "Pending review")
        out.push({ key: `p${t.id}`, tone: "bad", text: `${t.plate} ${p.text === "Expired" ? "permit expired" : p.text.toLowerCase()} — tanker can’t take jobs`, href: "/company/permits", action: "Renew" });
      else if (!p.valid && renewing)
        // A pending renewal doesn't let the tanker work: say so rather than dropping it from the list.
        out.push({ key: `p${t.id}`, tone: "bad", text: `${t.plate} has no valid permit — the application is with NWS; the tanker can’t take jobs until it is issued`, href: "/company/permits", action: "View" });
      else if (p.tone === "warn" && p.valid) out.push({ key: `p${t.id}`, tone: "warn", text: `${t.plate} permit ${p.text.toLowerCase()}`, href: "/company/permits", action: "Renew" });
      const info = fleet.permits.find((x) => x.tanker_id === t.id && x.status === "pending" && x.info_requested);
      if (info) out.push({ key: `i${info.id}`, tone: "warn", text: `NWS asked for more information on ${t.plate}: “${info.info_requested}”`, href: "/company/permits", action: "Open" });
      for (const d of DOC_KINDS) {
        if (d.kind === "water_test" && t.service_type !== "DW") continue;
        const rej = rejectedDoc(fleet.docs, d.kind, { tanker: t.id });
        if (rej) out.push({ key: `r${rej.id}`, tone: "bad", text: `NWS rejected the ${d.label.toLowerCase()} for ${t.plate}${rej.review_note ? ` — ${rej.review_note}` : ""}`, href: "/company/compliance", action: "Re-upload" });
        const doc = currentDoc(fleet.docs, d.kind, { tanker: t.id });
        if (!doc) continue;
        const n = daysUntil(doc.valid_to);
        if (n < 0) out.push({ key: `d${doc.id}`, tone: "bad", text: `${d.label} for ${t.plate} expired on ${fmtShort(doc.valid_to)}`, href: "/company/compliance", action: "Upload" });
        else if (n <= 30) out.push({ key: `d${doc.id}`, tone: "warn", text: `${d.label} for ${t.plate} expires ${fmtShort(doc.valid_to)}`, href: "/company/compliance", action: "Upload" });
      }
    }
    for (const dr of fleet.drivers) {
      const lic = currentDoc(fleet.docs, "heavy_licence", { driver: dr.id });
      if (lic && daysUntil(lic.valid_to) <= 30)
        out.push({ key: `l${lic.id}`, tone: daysUntil(lic.valid_to) < 0 ? "bad" : "warn", text: `${dr.full_name}’s ${DOC_LABEL.heavy_licence.toLowerCase()} ${daysUntil(lic.valid_to) < 0 ? "expired" : `expires in ${daysUntil(lic.valid_to)} days`}`, href: "/company/compliance", action: "Upload" });
    }
    for (const c of fleet.contracts.filter((k) => k.status === "pending_owner"))
      out.push({ key: `c${c.id}`, tone: "act", text: `Contract offer ${ref.contract(c.contract_no)} from ${contractCustomer(c)} — ${c.gallons.toLocaleString()} gal ${SERVICE_SHORT[c.service_type].toLowerCase()}, ${(FREQ_LABEL[c.frequency] ?? c.frequency).toLowerCase()}`, href: "/company/jobs", action: "Review" });
    for (const a of fleet.alerts.filter((x) => x.state === "open").slice(0, 8)) {
      const t = fleet.tankers.find((x) => x.id === a.tanker_id);
      out.push({ key: `a${a.id}`, tone: a.severity === "high" ? "bad" : "warn", text: `${t ? `${t.plate}: ` : ""}${a.message}`, href: "/company/tankers", action: "View" });
    }
    const rank = { bad: 0, warn: 1, act: 2 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [fleet]);

  const mapTankers = fleet.tankers
    .filter((t) => t.last_lat != null && t.last_lng != null && (t.is_online || t.blocked))
    .map((t) => ({
      id: t.id,
      lat: t.last_lat!,
      lng: t.last_lng!,
      type: t.service_type,
      stale: t.location_age_s == null || t.location_age_s > STALE_AFTER_S,
      blocked: t.blocked,
      label: `${t.plate} · ${driverOf(fleet, t.id)?.full_name ?? "no driver"}`,
    }));

  return (
    <>
      <Kpis
        items={[
          { label: "Tankers online", value: `${online.length} of ${fleet.tankers.length}`, sub: fleet.tankers.some((t) => t.blocked) ? `${fleet.tankers.filter((t) => t.blocked).length} blocked` : "None blocked", tone: fleet.tankers.some((t) => t.blocked) ? "bad" : "ok" },
          { label: "Jobs today", value: jobsToday.length, sub: `${doneToday} delivered · ${jobsToday.length - doneToday} in progress` },
          { label: "Drivers", value: fleet.drivers.length, sub: `${fleet.drivers.filter((d) => assigned.has(d.id)).length} on a tanker` },
          { label: "Earned this week", value: omr(earnedWeek), sub: `+ ${omr(tipsWeek)} tips · balance ${omr(company.earnings_balance)}` },
          { label: "Company rating", value: `${Number(avgRating ?? company.rating).toFixed(1)} ★`, sub: rated.length ? `${rated.length} rated jobs, last 14 days` : "NWS rating" },
        ]}
      />
      <div className="half">
        <div className="panel">
          <h2>
            Needs your attention <small>{attention.length ? `${attention.length} item${attention.length > 1 ? "s" : ""}` : ""}</small>
          </h2>
          {!fleet.loaded ? (
            <div className="empty">Loading…</div>
          ) : attention.length === 0 ? (
            <div className="empty">All permits, documents and contracts are in order.</div>
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
            Live fleet <small>{mapTankers.length ? `${mapTankers.length} on the map` : "No tanker online"}</small>
          </h2>
          <div className="pad">
            <div className="mapcard short">
              <FleetMap tankers={mapTankers} orders={[]} />
              {!mapTankers.length && <div className="ov-empty">Tankers appear here when a driver goes online.</div>}
            </div>
          </div>
          <div className="tblwrap">
            <table>
              <tbody>
                {fleet.tankers.map((t) => {
                  const [s, tone] = tankerStatus(t, fleet.permits, company.status === "suspended");
                  return (
                    <tr key={t.id}>
                      <td className="tk-plate">{t.plate}</td>
                      <td>
                        <TypeTag type={t.service_type} />
                      </td>
                      <td>{driverOf(fleet, t.id)?.full_name ?? <span className="mut">No driver</span>}</td>
                      <td>
                        <St tone={tone}>{s}</St>
                      </td>
                    </tr>
                  );
                })}
                {fleet.loaded && !fleet.tankers.length && (
                  <tr>
                    <td className="mut">
                      No tankers yet. <Link className="lk" href="/company/tankers">Register your first tanker</Link>
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
