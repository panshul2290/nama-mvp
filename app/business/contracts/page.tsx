"use client";

import { useCallback, useEffect, useState } from "react";
import { useBiz, type BizProperty } from "@/components/business/BizContext";
import { FREQ_LABEL, muscatToday } from "@/components/business/data";
import { BIZ } from "@/components/business/i18n";
import { contractStatus, freqLabel, serviceLabel } from "@/lib/labels";
import { TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, useAction, useLive } from "@/components/portal/kit";
import { useT } from "@/lib/i18n";
import { type ServiceType } from "@/lib/pricing";
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
  const t = useT(BIZ);
  const f = useFmt();

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
  const company = (id: string) => companies.find((c) => c.id === id)?.name ?? t("tankerCompany");
  const act = (c: Contract, action: "pause" | "resume" | "end") =>
    run(`${action}${c.id}`, async () => supabase().rpc("contract_set_status", { p_contract_id: c.id, p_action: action }), t(action === "end" ? "ctEnded" : action === "pause" ? "ctPaused" : "ctResumed", { c: ref.contract(c.contract_no) }), load);

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          {t("errPage", { error: loadError })}
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            {t("contractsIntro")}
          </span>
          {canOrder && (
            <button className="btn pri" onClick={() => setOpen(true)} disabled={!sites.length} title={sites.length ? undefined : t("addSiteFirstT")}>
              {t("newContract")}
            </button>
          )}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("hContract")}</th>
                <th>{t("hSite")}</th>
                <th>{t("hCompany")}</th>
                <th>{t("hService")}</th>
                <th>{t("hFreq")}</th>
                <th>{t("hTerm")}</th>
                <th className="num">{t("hMonthly")}</th>
                <th>{t("hStatus")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const [label, tone] = contractStatus(c.status, "other", f.lang);
                return (
                  <tr key={c.id}>
                    <td>
                      <bdi dir="ltr">{ref.contract(c.contract_no)}</bdi>
                      <small className="stack">{c.plan === "yearly" ? t("yearlyPlan") : t("monthlyPlan")}</small>
                    </td>
                    <td>{site(c.property_id)}</td>
                    <td>{company(c.company_id)}</td>
                    <td>
                      <TypeTag type={c.service_type} /> {f.n(c.gallons)}
                    </td>
                    <td>
                      {freqLabel(c.frequency, f.lang)}
                      <small className="stack">{c.slot === "evening" ? t("slotEvening") : t("slotMorning")}</small>
                    </td>
                    <td>
                      {f.day(c.start_date)} – {f.day(c.end_date)}
                    </td>
                    <td className="num">{f.n3(c.monthly_est)}</td>
                    <td>
                      <St tone={tone}>{label}</St>
                    </td>
                    <td>
                      {canOrder && (
                        <div className="btns">
                          {c.status === "active" && (
                            <button className="btn sm" disabled={!!busy} onClick={() => act(c, "pause")}>
                              {t("pause")}
                            </button>
                          )}
                          {c.status === "paused" && (
                            <button className="btn sm pri" disabled={!!busy} onClick={() => act(c, "resume")}>
                              {t("resume")}
                            </button>
                          )}
                          {["pending_owner", "active", "paused"].includes(c.status) && (
                            <button className="btn sm" disabled={!!busy} onClick={() => setEnding(c)}>
                              {t("end")}
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
                    {t("noContracts")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">{t("contractsNote")}</p>
      </div>
      {open && <NewContract sites={sites} companies={companies} onClose={() => setOpen(false)} onSaved={load} />}
      {ending && (
        <Dialog title={t("endQ", { c: ref.contract(ending.contract_no) })} body={t("endBody")} onClose={() => setEnding(null)}>
          <div className="btns" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEnding(null)}>
              {t("keepContract")}
            </button>
            <button className="btn bad" disabled={!!busy} onClick={() => act(ending, "end").then(() => setEnding(null))}>
              {t("endContract")}
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
  const t = useT(BIZ);
  const f = useFmt();

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
    <Dialog title={t("newContract")} body={t("newContractBody")} onClose={onClose} wide>
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
            t("offerSent"),
            () => {
              onSaved();
              onClose();
            },
          );
        }}
      >
        <div className="form">
          <div className="fld">
            <label htmlFor="cSite">{t("hSite")}</label>
            <select id="cSite" className="in" value={site} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cCo">{t("tankerCompany")}</label>
            <select id="cCo" className="in" value={company} onChange={(e) => setCompany(e.target.value)} required>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {f.n(Number(c.rating), 1)} ★
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cType">{t("hService")}</label>
            <select id="cType" className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
              {(["DW", "WW", "TE"] as ServiceType[]).map((s) => (
                <option key={s} value={s}>
                  {serviceLabel(s, f.lang)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cGal">{t("lGalDel")}</label>
            <input id="cGal" className="in" type="number" min={100} max={20000} step={100} required value={gallons} onChange={(e) => setGallons(Number(e.target.value))} />
          </div>
          <div className="fld">
            <label htmlFor="cFreq">{t("hFreq")}</label>
            <select id="cFreq" className="in" value={freq} onChange={(e) => setFreq(e.target.value as Contract["frequency"])}>
              {(Object.keys(FREQ_LABEL) as Contract["frequency"][]).map((q) => (
                <option key={q} value={q}>
                  {freqLabel(q, f.lang)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cSlot">{t("lTime")}</label>
            <select id="cSlot" className="in" value={slot} onChange={(e) => setSlot(e.target.value as Contract["slot"])}>
              <option value="morning">{t("optMorning")}</option>
              <option value="evening">{t("optEvening")}</option>
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cPlan">{t("lPlan")}</label>
            <select id="cPlan" className="in" value={plan} onChange={(e) => setPlan(e.target.value as Contract["plan"])}>
              <option value="monthly">{t("optMonthly")}</option>
              <option value="yearly">{t("optYearly")}</option>
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cStart">{t("lStart")}</label>
            <input id="cStart" className="in" type="date" min={muscatToday()} required value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="cMonths">{t("lTermMonths")}</label>
            <input id="cMonths" className="in" type="number" min={1} max={24} required value={months} onChange={(e) => setMonths(Number(e.target.value))} />
          </div>
        </div>
        <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
          {perMonth != null ? t("aboutMonth", { amt: f.omr(perMonth) }) : t("pricedTariff")}
        </p>
        {!companies.length && <div className="banner">{t("noCompanies")}</div>}
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "ct" || !site || !company}>
            {busy === "ct" ? t("sending") : t("sendOffer")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
