"use client";

import { contractCustomer, contractSite, useCompany, useCompanyOrders, useContractDeliveries, useFleet, type FContract } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { St, dayStart, useAction } from "@/components/portal/kit";
import { useLang, useT } from "@/lib/i18n";
import { contractStatus, freqLabel } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { ref, type OrderStatus } from "@/lib/types";

export default function CompanyJobs() {
  const { reloadCompany } = useCompany();
  const fleet = useFleet("jobs");
  const { orders, loaded } = useCompanyOrders("jobs", 2);
  const upcoming = useContractDeliveries("jobs");
  const { busy, run } = useAction();
  const t = useT(CO);
  const f = useFmt();
  const { lang } = useLang();
  const cref = (no: number | string) => <bdi dir="ltr">{ref.contract(no)}</bdi>;
  const oref = (no: number | string) => <bdi dir="ltr">{ref.order(no)}</bdi>;

  const today = dayStart().getTime();
  const jobs = orders.filter((o) => Date.parse(o.created_at) >= today || (o.slot_start && Date.parse(o.slot_start) >= today && Date.parse(o.slot_start) < today + 86_400_000));
  const offers = fleet.contracts.filter((c) => c.status === "pending_owner");
  const others = fleet.contracts.filter((c) => c.status !== "pending_owner");

  const decide = (c: FContract, accept: boolean) =>
    run(c.id, () => supabase().rpc("owner_decide_contract", { p_contract_id: c.id, p_accept: accept }), t(accept ? "ctAccepted" : "ctDeclined", { ref: `\u2066${ref.contract(c.contract_no)}\u2069` }), () => {
      fleet.reload();
      reloadCompany();
    });

  const contractRow = (c: FContract) => {
    const [s, tone] = contractStatus(c.status, "company", lang);
    return (
      <tr key={c.id}>
        <td>
          <b>{cref(c.contract_no)}</b>
          <small className="docmeta">{t("received", { date: f.date(c.created_at) })}</small>
        </td>
        <td>
          {contractCustomer(c, lang)}
          <small className="docmeta">{[c.org_id ? t("business") : t("household"), contractSite(c)].filter(Boolean).join(" · ")}</small>
        </td>
        <td>
          <TypeTag type={c.service_type} /> {f.gal(c.gallons)}
        </td>
        <td>
          {freqLabel(c.frequency, lang)}
          <small className="docmeta">{c.slot === "evening" ? t("slotEvening") : t("slotMorning")}</small>
        </td>
        <td>
          {f.date(c.start_date)} – {f.date(c.end_date)}
          <small className="docmeta">{c.plan === "yearly" ? t("yearlyPlan") : t("monthlyPlan")}</small>
        </td>
        <td className="num">{f.n3(c.monthly_est)}</td>
        <td>
          <St tone={tone}>{s}</St>
        </td>
        <td className="num">
          {c.status === "pending_owner" && (
            <div className="btns" style={{ justifyContent: "flex-end" }}>
              <button className="btn sm pri" disabled={busy === c.id} onClick={() => decide(c, true)}>
                {t("accept")}
              </button>
              <button className="btn sm" disabled={busy === c.id} onClick={() => decide(c, false)}>
                {t("decline")}
              </button>
            </div>
          )}
        </td>
      </tr>
    );
  };

  const head = (
    <thead>
      <tr>
        <th>{t("contract")}</th>
        <th>{t("customer")}</th>
        <th>{t("service")}</th>
        <th>{t("frequency")}</th>
        <th>{t("term")}</th>
        <th className="num">{t("monthlyOmr")}</th>
        <th>{t("status")}</th>
        <th />
      </tr>
    </thead>
  );

  return (
    <>
      <div className="panel">
        <h2>
          {t("offersTitle")} <small>{offers.length ? t("waitingN", { n: f.n(offers.length) }) : t("noOffers")}</small>
        </h2>
        <div className="tblwrap">
          <table>
            {head}
            <tbody>
              {offers.map(contractRow)}
              {fleet.loaded && !offers.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    {t("offersEmpty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">{t("offersNote")}</p>
      </div>

      <div className="panel">
        <h2>{t("contractsTitle")}</h2>
        <div className="tblwrap">
          <table>
            {head}
            <tbody>
              {others.map(contractRow)}
              {fleet.loaded && !others.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    {t("noContracts")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          {t("upcomingTitle")} <small>{upcoming.orders.length ? t("bookedN", { n: f.n(upcoming.orders.length) }) : t("noneBooked")}</small>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("when")}</th>
                <th>{t("order")}</th>
                <th>{t("contract")}</th>
                <th>{t("area")}</th>
                <th>{t("service")}</th>
                <th className="num">{t("gallons")}</th>
                <th>{t("status")}</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.orders.map((o) => {
                const k = fleet.contracts.find((c) => c.id === o.contract_id);
                return (
                  <tr key={o.id}>
                    <td>
                      {o.slot_start ? f.dateTime(o.slot_start) : "—"}
                      {o.slot_label && <small className="docmeta">{o.slot_label}</small>}
                    </td>
                    <td>{oref(o.order_no)}</td>
                    <td>
                      {k ? cref(k.contract_no) : "—"}
                      {k && <small className="docmeta">{contractCustomer(k, lang)}</small>}
                    </td>
                    <td>{o.area}</td>
                    <td>
                      <TypeTag type={o.service_type} />
                    </td>
                    <td className="num">{f.n(o.gallons)}</td>
                    <td>
                      <StatusPill status={o.status as OrderStatus} type={o.service_type} />
                    </td>
                  </tr>
                );
              })}
              {upcoming.loaded && !upcoming.orders.length && (
                <tr>
                  <td colSpan={7} className="empty">
                    {t("upcomingEmpty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          {t("jobsToday")} <small>{jobs.length === 1 ? t("jobs1") : t("jobsN", { n: f.n(jobs.length) })}</small>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("time")}</th>
                <th>{t("order")}</th>
                <th>{t("tanker")}</th>
                <th>{t("driver")}</th>
                <th>{t("area")}</th>
                <th>{t("service")}</th>
                <th className="num">{t("gallons")}</th>
                <th>{t("status")}</th>
                <th className="num">{t("earnedOmr")}</th>
                <th className="num">{t("rating")}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((o) => (
                <tr key={o.id}>
                  <td>{o.slot_label ?? f.time(o.created_at)}</td>
                  <td>
                    {oref(o.order_no)}
                    {o.contract_id && <small className="docmeta">{t("contract")}</small>}
                  </td>
                  <td className="tk-plate">{o.tanker_plate ?? fleet.tankers.find((t) => t.id === o.tanker_id)?.plate ?? "—"}</td>
                  <td>{o.driver_name ?? "—"}</td>
                  <td>{o.area}</td>
                  <td>
                    <TypeTag type={o.service_type} />
                  </td>
                  <td className="num">{f.n(o.gallons)}</td>
                  <td>
                    <StatusPill status={o.status as OrderStatus} type={o.service_type} />
                  </td>
                  <td className="num">{o.status === "delivered" ? f.n3(Number(o.driver_earnings) + Number(o.tip)) : o.status === "cancelled" ? <span className="mut">—</span> : <span className="mut">{f.n3(o.driver_earnings)}</span>}</td>
                  <td className="num">{o.rating ? `${f.n(o.rating)} ★` : "—"}</td>
                </tr>
              ))}
              {loaded && !jobs.length && (
                <tr>
                  <td colSpan={10} className="empty">
                    {t("jobsEmpty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
