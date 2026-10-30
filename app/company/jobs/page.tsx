"use client";

import { CONTRACT_STATUS, contractCustomer, contractSite, FREQ_LABEL, useCompany, useCompanyOrders, useContractDeliveries, useFleet, type FContract } from "@/components/company/CompanyContext";
import { StatusPill, TypeTag } from "@/components/OrderBits";
import { St, dayStart, fmtDate, fmtDateTime, fmtTime, gal, n3, useAction } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import { ref, type OrderStatus } from "@/lib/types";

export default function CompanyJobs() {
  const { reloadCompany } = useCompany();
  const fleet = useFleet("jobs");
  const { orders, loaded } = useCompanyOrders("jobs", 2);
  const upcoming = useContractDeliveries("jobs");
  const { busy, run } = useAction();

  const today = dayStart().getTime();
  const jobs = orders.filter((o) => Date.parse(o.created_at) >= today || (o.slot_start && Date.parse(o.slot_start) >= today && Date.parse(o.slot_start) < today + 86_400_000));
  const offers = fleet.contracts.filter((c) => c.status === "pending_owner");
  const others = fleet.contracts.filter((c) => c.status !== "pending_owner");

  const decide = (c: FContract, accept: boolean) =>
    run(c.id, () => supabase().rpc("owner_decide_contract", { p_contract_id: c.id, p_accept: accept }), accept ? `${ref.contract(c.contract_no)} accepted — deliveries are scheduled` : `${ref.contract(c.contract_no)} declined`, () => {
      fleet.reload();
      reloadCompany();
    });

  const contractRow = (c: FContract) => {
    const [s, tone] = CONTRACT_STATUS[c.status] ?? [c.status, ""];
    return (
      <tr key={c.id}>
        <td>
          <b>{ref.contract(c.contract_no)}</b>
          <small className="docmeta">Received {fmtDate(c.created_at)}</small>
        </td>
        <td>
          {contractCustomer(c)}
          <small className="docmeta">{[c.org_id ? "Business" : "Household", contractSite(c)].filter(Boolean).join(" · ")}</small>
        </td>
        <td>
          <TypeTag type={c.service_type} /> {gal(c.gallons)} gal
        </td>
        <td>
          {FREQ_LABEL[c.frequency]}
          <small className="docmeta">{c.slot === "evening" ? "6–8 pm" : "8–10 am"}</small>
        </td>
        <td>
          {fmtDate(c.start_date)} – {fmtDate(c.end_date)}
          <small className="docmeta">{c.plan === "yearly" ? "Yearly plan" : "Monthly plan"}</small>
        </td>
        <td className="num">{n3(c.monthly_est)}</td>
        <td>
          <St tone={tone}>{s}</St>
        </td>
        <td className="num">
          {c.status === "pending_owner" && (
            <div className="btns" style={{ justifyContent: "flex-end" }}>
              <button className="btn sm pri" disabled={busy === c.id} onClick={() => decide(c, true)}>
                Accept
              </button>
              <button className="btn sm" disabled={busy === c.id} onClick={() => decide(c, false)}>
                Decline
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
        <th>Contract</th>
        <th>Customer</th>
        <th>Service</th>
        <th>Frequency</th>
        <th>Term</th>
        <th className="num">Monthly (OMR)</th>
        <th>Status</th>
        <th />
      </tr>
    </thead>
  );

  return (
    <>
      <div className="panel">
        <h2>
          Contract offers <small>{offers.length ? `${offers.length} waiting for your decision` : "No offers waiting"}</small>
        </h2>
        <div className="tblwrap">
          <table>
            {head}
            <tbody>
              {offers.map(contractRow)}
              {fleet.loaded && !offers.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    New offers from households and businesses appear here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">Accepting a contract books its deliveries for the next 7 days; they are offered first to your tankers. Monthly amounts include VAT and the plan discount.</p>
      </div>

      <div className="panel">
        <h2>Contracts</h2>
        <div className="tblwrap">
          <table>
            {head}
            <tbody>
              {others.map(contractRow)}
              {fleet.loaded && !others.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    No active contracts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          Upcoming contract deliveries <small>{upcoming.orders.length ? `${upcoming.orders.length} booked, not yet taken by a driver` : "None booked"}</small>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Order</th>
                <th>Contract</th>
                <th>Area</th>
                <th>Service</th>
                <th className="num">Gallons</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.orders.map((o) => {
                const k = fleet.contracts.find((c) => c.id === o.contract_id);
                return (
                  <tr key={o.id}>
                    <td>{o.slot_start ? fmtDateTime(o.slot_start) : "—"}{o.slot_label && <small className="docmeta">{o.slot_label}</small>}</td>
                    <td>{ref.order(o.order_no)}</td>
                    <td>
                      {k ? ref.contract(k.contract_no) : "—"}
                      {k && <small className="docmeta">{contractCustomer(k)}</small>}
                    </td>
                    <td>{o.area}</td>
                    <td>
                      <TypeTag type={o.service_type} />
                    </td>
                    <td className="num">{gal(o.gallons)}</td>
                    <td>
                      <StatusPill status={o.status as OrderStatus} />
                    </td>
                  </tr>
                );
              })}
              {upcoming.loaded && !upcoming.orders.length && (
                <tr>
                  <td colSpan={7} className="empty">
                    Deliveries from accepted contracts appear here as soon as they are booked; your drivers see them first, 90 minutes before the window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          Jobs today <small>{jobs.length} job{jobs.length === 1 ? "" : "s"}</small>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Order</th>
                <th>Tanker</th>
                <th>Driver</th>
                <th>Area</th>
                <th>Service</th>
                <th className="num">Gallons</th>
                <th>Status</th>
                <th className="num">Earned (OMR)</th>
                <th className="num">Rating</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((o) => (
                <tr key={o.id}>
                  <td>{o.slot_label ?? fmtTime(o.created_at)}</td>
                  <td>
                    {ref.order(o.order_no)}
                    {o.contract_id && <small className="docmeta">Contract</small>}
                  </td>
                  <td className="tk-plate">{o.tanker_plate ?? fleet.tankers.find((t) => t.id === o.tanker_id)?.plate ?? "—"}</td>
                  <td>{o.driver_name ?? "—"}</td>
                  <td>{o.area}</td>
                  <td>
                    <TypeTag type={o.service_type} />
                  </td>
                  <td className="num">{gal(o.gallons)}</td>
                  <td>
                    <StatusPill status={o.status as OrderStatus} />
                  </td>
                  <td className="num">{o.status === "delivered" ? n3(Number(o.driver_earnings) + Number(o.tip)) : o.status === "cancelled" ? <span className="mut">—</span> : <span className="mut">{n3(o.driver_earnings)}</span>}</td>
                  <td className="num">{o.rating ? `${o.rating} ★` : "—"}</td>
                </tr>
              ))}
              {loaded && !jobs.length && (
                <tr>
                  <td colSpan={10} className="empty">
                    No jobs yet today. Jobs appear here as soon as one of your drivers accepts one.
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
