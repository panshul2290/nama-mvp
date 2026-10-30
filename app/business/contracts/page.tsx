"use client";

import { useCallback, useEffect, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { FREQ_LABEL, muscatToday } from "@/components/business/data";
import { contractStatus } from "@/lib/labels";
import { TypeTag } from "@/components/OrderBits";
import { Dialog, St, fmtShort, gal, n3, useAction, useLive } from "@/components/portal/kit";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ref, type Contract } from "@/lib/types";

type Co = { id: string; name: string; rating: string | number };

export default function BusinessContracts() {
  const { org, canOrder } = useBiz();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sites, setSites] = useState<BizProperty[]>([]);
  const [companies, setCompanies] = useState<Co[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [ending, setEnding] = useState<Contract | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const db = supabase();
    const [c, p] = await Promise.all([
      db.from("contracts").select("*").eq("org_id", org.id).order("created_at", { ascending: false }),
      db.from("properties").select("id, label, address, area, lat, lng, tank_gal, created_at").eq("org_id", org.id).order("label"),
    ]);
    setLoadError(c.error?.message ?? p.error?.message ?? null);
    if (c.error) return setLoaded(true); // keep what is on screen
    const list = (c.data ?? []) as Contract[];
    setContracts(list);
    setSites((p.data ?? []) as BizProperty[]);
    // Companies: active ones (directory) plus any we already contract with that RLS lets us see.
    const { data: cos } = await db.from("companies").select("id, name, rating").order("name");
    setCompanies((cos ?? []) as Co[]);
    setLoaded(true);
  }, [org.id]);

  useLive("biz-contracts", ["contracts"], load);

  const site = (id: string) => sites.find((s) => s.id === id)?.label ?? "—";
  const company = (id: string) => companies.find((c) => c.id === id)?.name ?? "Tanker company";
  const act = (c: Contract, action: "pause" | "resume" | "end") =>
    run(`${action}${c.id}`, async () => supabase().rpc("contract_set_status", { p_contract_id: c.id, p_action: action }), `${ref.contract(c.contract_no)} ${action === "end" ? "ended" : action === "pause" ? "paused" : "resumed"}`, load);

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          Couldn’t load this page: {loadError}. It retries automatically.
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            Recurring deliveries with an NWS-permitted tanker company, billed on your account.
          </span>
          {canOrder && (
            <button className="btn pri" onClick={() => setOpen(true)} disabled={!sites.length} title={sites.length ? undefined : "Add a site first"}>
              New contract
            </button>
          )}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Site</th>
                <th>Company</th>
                <th>Service</th>
                <th>Frequency</th>
                <th>Term</th>
                <th className="num">Monthly (est.)</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const [label, tone] = contractStatus(c.status);
                return (
                  <tr key={c.id}>
                    <td>
                      {ref.contract(c.contract_no)}
                      <small className="stack">{c.plan === "yearly" ? "Yearly plan" : "Monthly plan"}</small>
                    </td>
                    <td>{site(c.property_id)}</td>
                    <td>{company(c.company_id)}</td>
                    <td>
                      <TypeTag type={c.service_type} /> {gal(c.gallons)}
                    </td>
                    <td>
                      {FREQ_LABEL[c.frequency]}
                      <small className="stack">{c.slot === "evening" ? "6–8 pm" : "8–10 am"}</small>
                    </td>
                    <td>
                      {fmtShort(c.start_date)} – {fmtShort(c.end_date)}
                    </td>
                    <td className="num">{n3(c.monthly_est)}</td>
                    <td>
                      <St tone={tone}>{label}</St>
                    </td>
                    <td>
                      {canOrder && (
                        <div className="btns">
                          {c.status === "active" && (
                            <button className="btn sm" disabled={!!busy} onClick={() => act(c, "pause")}>
                              Pause
                            </button>
                          )}
                          {c.status === "paused" && (
                            <button className="btn sm pri" disabled={!!busy} onClick={() => act(c, "resume")}>
                              Resume
                            </button>
                          )}
                          {["pending_owner", "active", "paused"].includes(c.status) && (
                            <button className="btn sm" disabled={!!busy} onClick={() => setEnding(c)}>
                              End
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {loaded && !contracts.length && (
                <tr>
                  <td className="empty" colSpan={9}>
                    No contracts yet. A contract books deliveries automatically every week, two weeks or month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">
          Contracts are with NWS-permitted companies. The company accepts the offer in its portal; deliveries are then scheduled a week ahead. If a company&apos;s permit lapses,
          deliveries move to another permitted company at the same price.
        </p>
      </div>
      {open && <NewContract sites={sites} companies={companies} onClose={() => setOpen(false)} onSaved={load} />}
      {ending && (
        <Dialog title={`End ${ref.contract(ending.contract_no)}?`} body="Scheduled deliveries that haven't started are cancelled. This can't be undone." onClose={() => setEnding(null)}>
          <div className="btns" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEnding(null)}>
              Keep contract
            </button>
            <button className="btn bad" disabled={!!busy} onClick={() => act(ending, "end").then(() => setEnding(null))}>
              End contract
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function NewContract({ sites, companies, onClose, onSaved }: { sites: BizProperty[]; companies: Co[]; onClose: () => void; onSaved: () => void }) {
  const [site, setSite] = useState(sites[0]?.id ?? "");
  const [company, setCompany] = useState(companies[0]?.id ?? "");
  const [type, setType] = useState<ServiceType>("DW");
  const [gallons, setGallons] = useState(5000);
  const [freq, setFreq] = useState<Contract["frequency"]>("weekly");
  const [plan, setPlan] = useState<Contract["plan"]>("yearly");
  const [slot, setSlot] = useState<Contract["slot"]>("morning");
  const [start, setStart] = useState(muscatToday());
  const [months, setMonths] = useState(12);
  const [perLoad, setPerLoad] = useState<number | null>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    let cancelled = false;
    supabase()
      .rpc("quote_order", { p_service_type: type, p_gallons: gallons, p_slot_start: slot === "evening" ? `${start}T18:00:00+04:00` : `${start}T08:00:00+04:00` })
      .then(({ data }) => {
        if (!cancelled) setPerLoad(data ? Number((data as { total: number }).total) : null);
      });
    return () => {
      cancelled = true;
    };
  }, [type, gallons, slot, start]);
  const perMonth = perLoad == null ? null : perLoad * (freq === "weekly" ? 4.33 : freq === "biweekly" ? 2.17 : 1);

  return (
    <Dialog title="New contract" body="Recurring deliveries to one site. The tanker company accepts or declines the offer." onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(
            "ct",
            async () =>
              supabase().rpc("create_contract", {
                p_property_id: site,
                p_company_id: company,
                p_service_type: type,
                p_gallons: gallons,
                p_frequency: freq,
                p_plan: plan,
                p_slot: slot,
                p_start_date: start,
                p_months: months,
              }),
            "Contract offer sent to the tanker company",
            () => {
              onSaved();
              onClose();
            },
          );
        }}
      >
        <div className="form">
          <div className="fld">
            <label htmlFor="cSite">Site</label>
            <select id="cSite" className="in" value={site} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cCo">Tanker company</label>
            <select id="cCo" className="in" value={company} onChange={(e) => setCompany(e.target.value)} required>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {Number(c.rating).toFixed(1)} ★
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cType">Service</label>
            <select id="cType" className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
              {(["DW", "WW", "TE"] as ServiceType[]).map((t) => (
                <option key={t} value={t}>
                  {SERVICE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cGal">Gallons per delivery</label>
            <input id="cGal" className="in" type="number" min={100} max={20000} step={100} required value={gallons} onChange={(e) => setGallons(Number(e.target.value))} />
          </div>
          <div className="fld">
            <label htmlFor="cFreq">Frequency</label>
            <select id="cFreq" className="in" value={freq} onChange={(e) => setFreq(e.target.value as Contract["frequency"])}>
              {(Object.keys(FREQ_LABEL) as Contract["frequency"][]).map((f) => (
                <option key={f} value={f}>
                  {FREQ_LABEL[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cSlot">Delivery time</label>
            <select id="cSlot" className="in" value={slot} onChange={(e) => setSlot(e.target.value as Contract["slot"])}>
              <option value="morning">Morning · 8–10 am</option>
              <option value="evening">Evening · 6–8 pm (peak)</option>
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cPlan">Plan</label>
            <select id="cPlan" className="in" value={plan} onChange={(e) => setPlan(e.target.value as Contract["plan"])}>
              <option value="monthly">Monthly plan</option>
              <option value="yearly">Yearly plan (bigger discount)</option>
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cStart">Start date</label>
            <input id="cStart" className="in" type="date" min={muscatToday()} required value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="cMonths">Term (months)</label>
            <input id="cMonths" className="in" type="number" min={1} max={24} required value={months} onChange={(e) => setMonths(Number(e.target.value))} />
          </div>
        </div>
        <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
          {perMonth != null ? `About OMR ${n3(perMonth)} a month at the standard tariff. The plan discount on the delivery fee is applied when the offer is created, so the contract shows a lower monthly figure.` : "Priced from the NWS tariff when the offer is created."}
        </p>
        {!companies.length && <div className="banner">No tanker company is taking contracts right now.</div>}
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "ct" || !site || !company}>
            {busy === "ct" ? "Sending…" : "Send contract offer"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
