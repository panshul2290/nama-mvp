"use client";

import { useState } from "react";
import { useDriverTiers } from "@/components/nws/VehiclePanel";
import { currentDoc, tankerOf, useCompany, useCompanyOrders, useFleet } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { isOnTime } from "@/lib/sla";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, daysUntil, useAction } from "@/components/portal/kit";
import { SERVICE_SHORT } from "@/components/OrderBits";
import { useLang, useT } from "@/lib/i18n";
import { label } from "@/lib/labels";
import { useSentInvitations } from "@/components/useInvitations";
import { formatPhone } from "@/lib/phone";
import { supabase } from "@/lib/supabase/client";

export default function CompanyDrivers() {
  const fleet = useFleet("drivers");
  const { orders } = useCompanyOrders("drivers", 90);
  const { company } = useCompany();
  const sent = useSentInvitations("driver", company.id);
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const t = useT(CO);
  const tiers = useDriverTiers();
  const f = useFmt();
  const { lang } = useLang();

  async function assign(driverId: string, tankerId: string) {
    const current = tankerOf(fleet, driverId);
    if (tankerId === "") {
      if (!current) return;
      await run(driverId, () => supabase().rpc("owner_unassign", { p_tanker_id: current.id }), t("unassignedFrom", { plate: current.plate }), fleet.reload);
      return;
    }
    const tk = fleet.tankers.find((x) => x.id === tankerId);
    await run(driverId, () => supabase().rpc("owner_assign_driver", { p_driver_id: driverId, p_tanker_id: tankerId }), t("assignedTo", { plate: tk?.plate ?? t("tanker") }), fleet.reload);
  }

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="mut" style={{ fontSize: 13 }}>
          {t("drIntro")}
        </span>
        <button className="btn pri" onClick={() => setAdding(true)}>
          {t("inviteDriver")}
        </button>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("driver")}</th>
              <th>{t("tanker")}</th>
              <th>{t("heavyLicence")}</th>
              <th className="num">{t("jobs90")}</th>
              <th className="num">{t("rating")}</th>
              <th className="num">{t("onTime")}</th>
              <th>{t("status")}</th>
              <th>{t("tierCol")}</th>
            </tr>
          </thead>
          <tbody>
            {fleet.drivers.map((d) => {
              const tk = tankerOf(fleet, d.id);
              const mine = orders.filter((o) => o.driver_id === d.id && o.status === "delivered");
              const rated = mine.filter((o) => o.rating);
              const timed = mine.map(isOnTime).filter((x) => x !== null);
              const lic = currentDoc(fleet.docs, "heavy_licence", { driver: d.id });
              const licDays = lic ? daysUntil(lic.valid_to) : null;
              return (
                <tr key={d.id}>
                  <td>
                    <b>{d.full_name || t("unnamedDriver")}</b>
                    <small className="docmeta">{d.phone ? <bdi dir="ltr">{d.phone}</bdi> : t("noPhone")}</small>
                  </td>
                  <td>
                    <select className="inl" aria-label={t("tankerFor", { name: d.full_name })} value={tk?.id ?? ""} disabled={busy === d.id} onChange={(e) => assign(d.id, e.target.value)}>
                      <option value="">{t("notAssigned")}</option>
                      {fleet.tankers.map((tn) => {
                        const other = fleet.assignments.find((a) => a.tanker_id === tn.id && a.driver_id !== d.id);
                        return (
                          <option key={tn.id} value={tn.id}>
                            {tn.plate} · {label("svcShort", tn.service_type, lang, SERVICE_SHORT[tn.service_type])}
                            {other ? t("replaces", { name: fleet.drivers.find((x) => x.id === other.driver_id)?.full_name ?? t("driver") }) : ""}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td>
                    {!lic ? (
                      <St tone="bad">{t("missing")}</St>
                    ) : lic.status === "pending_review" ? (
                      <St tone="act">{t("inReviewD", { date: f.date(lic.valid_to) })}</St>
                    ) : (
                      <St tone={licDays! < 0 ? "bad" : licDays! <= 30 ? "warn" : "ok"}>{licDays! < 0 ? t("expired") : f.date(lic.valid_to)}</St>
                    )}
                  </td>
                  <td className="num">{f.n(mine.length)}</td>
                  <td className="num">{rated.length ? `${f.n(rated.reduce((s, o) => s + (o.rating ?? 0), 0) / rated.length, 1)} ★` : "—"}</td>
                  <td className="num">{timed.length ? f.pct(Math.round((timed.filter(Boolean).length / timed.length) * 100) / 100, 0) : "—"}</td>
                  <td>{!tk ? <St tone="warn">{t("noTanker")}</St> : tk.blocked ? <St tone="bad">{t("tankerBlocked")}</St> : tk.is_online ? <St tone="ok">{t("online")}</St> : <St>{t("offline")}</St>}</td>
                  <td>
                    <span className={`tier ${tiers[d.id] ?? "bronze"}`}>{t(`tier_${tiers[d.id] ?? "bronze"}`)}</span>
                  </td>
                </tr>
              );
            })}
            {fleet.loaded && !fleet.drivers.length && (
              <tr>
                <td colSpan={8} className="empty">
                  {t("drEmpty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sent.invitations.length > 0 && (
        <>
          <h2 style={{ paddingTop: 12 }}>
            {t("pendingInv")} <small>{t("pendingInvSub")}</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("mobileEmail")}</th>
                  <th>{t("sentCol")}</th>
                  <th>{t("expiresCol")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sent.invitations.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <bdi dir="ltr">{i.phone ? formatPhone(i.phone) : i.email}</bdi>
                    </td>
                    <td>{f.date(i.created_at)}</td>
                    <td>{i.expired ? <St tone="bad">{t("expired")}</St> : f.date(i.expires_at)}</td>
                    <td className="num">
                      <button className="btn sm" disabled={busy === i.id} onClick={() => run(i.id, () => supabase().rpc("revoke_invitation", { p_id: i.id }), t("invRevoked"), sent.reload)}>
                        {t("revoke")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {sent.recent.length > 0 && (
        <>
          <h2 style={{ paddingTop: 12 }}>
            {t("recentAnswers")} <small>{t("last14")}</small>
          </h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {sent.recent.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <bdi dir="ltr">{i.phone ? formatPhone(i.phone) : i.email}</bdi>
                    </td>
                    <td>
                      <St tone={i.status === "accepted" ? "ok" : "bad"}>{i.status === "accepted" ? t("joined") : t("declinedSt")}</St>
                    </td>
                    <td>{f.date(i.decided_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="note">
        {t("drNote")} {t("tierNote")}
      </p>
      {adding && <InviteDriver onClose={() => setAdding(false)} onDone={sent.reload} />}
    </div>
  );
}

function InviteDriver({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [contact, setContact] = useState("");
  const t = useT(CO);
  return (
    <Dialog title={t("inviteDriver")} body={t("inviteBody")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("add", () => supabase().rpc("owner_add_driver", { p_contact: contact.trim() }), t("invSent", { c: `\u2066${contact.trim()}\u2069` }), () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="drE">{t("drContact")}</label>
          <input id="drE" className="in" type="text" inputMode="tel" dir="ltr" required value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+968 9123 4567" autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "add"}>
            {busy === "add" ? t("sending") : t("sendInvitation")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
