"use client";

import { useState } from "react";
import { driverOf, permitText, tankerPermit, tankerStatus, useCompany, useFleet } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, useAction } from "@/components/portal/kit";
import { useLang, useT } from "@/lib/i18n";
import { serviceLabel } from "@/lib/labels";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

export default function CompanyTankers() {
  const fleet = useFleet("tankers");
  const { company } = useCompany();
  const [adding, setAdding] = useState(false);
  const t = useT(CO);
  const f = useFmt();
  const { lang } = useLang();
  // Same wording as lib/gps agoText, in the portal language.
  const ago = (s: number) =>
    s < 5 ? t("justNow") : s < 60 ? t("agoS", { n: f.n(Math.floor(s)) }) : s < 3600 ? t("agoM", { n: f.n(Math.floor(s / 60)) }) : t("agoH", { n: f.n(Math.floor(s / 3600)) });

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="mut" style={{ fontSize: 13 }}>
          {t("tkIntro")}
        </span>
        <button className="btn pri" onClick={() => setAdding(true)}>
          {t("registerTanker")}
        </button>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>{t("tanker")}</th>
              <th>{t("service")}</th>
              <th className="num">{t("capGal")}</th>
              <th>{t("driver")}</th>
              <th>{t("permit")}</th>
              <th>{t("ivms")}</th>
              <th>{t("lastPos")}</th>
              <th>{t("status")}</th>
            </tr>
          </thead>
          <tbody>
            {fleet.tankers.map((tk) => {
              const p = tankerPermit(tk, fleet.permits);
              const dev = fleet.devices.find((d) => d.tanker_id === tk.id);
              const [s, tone] = tankerStatus(tk, fleet.permits, company.status === "suspended", lang);
              const open = fleet.alerts.filter((a) => a.tanker_id === tk.id && a.state === "open");
              return (
                <tr key={tk.id}>
                  <td>
                    <span className="tk-plate">{tk.plate}</span>
                    <small className="docmeta">{t("registeredOn", { date: f.date(tk.created_at) })}</small>
                  </td>
                  <td>
                    <TypeTag type={tk.service_type} />
                  </td>
                  <td className="num">{f.n(tk.capacity_gal)}</td>
                  <td>{driverOf(fleet, tk.id)?.full_name ?? <span className="mut">—</span>}</td>
                  <td>
                    <St tone={p.tone}>{permitText(tk, fleet.permits, lang)}</St>
                  </td>
                  <td>
                    {dev ? (
                      <>
                        <bdi dir="ltr">{dev.id}</bdi>
                        <small className="docmeta">{t("firmware", { v: dev.firmware })}</small>
                      </>
                    ) : (
                      <St tone="warn">{t("notInstalled")}</St>
                    )}
                  </td>
                  <td>{tk.location_age_s == null ? <span className="mut">—</span> : ago(tk.location_age_s)}</td>
                  <td>
                    <St tone={tone}>{s}</St>
                    {tk.blocked && tk.blocked_reason && <small className="docmeta">{tk.blocked_reason}</small>}
                    {open.length > 0 && (
                      <small className="docmeta">{open.length > 1 ? t("openAlertsN", { n: f.n(open.length), msg: open[0].message }) : t("openAlerts1", { msg: open[0].message })}</small>
                    )}
                  </td>
                </tr>
              );
            })}
            {fleet.loaded && !fleet.tankers.length && (
              <tr>
                <td colSpan={8} className="empty">
                  {t("tkEmpty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">{t("tkNote")}</p>
      {adding && <RegisterTanker onClose={() => setAdding(false)} onDone={fleet.reload} />}
    </div>
  );
}

function RegisterTanker({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [plate, setPlate] = useState("");
  const [type, setType] = useState<ServiceType>("DW");
  const [cap, setCap] = useState(5000);
  const [apply, setApply] = useState(true);
  const t = useT(CO);
  const { lang } = useLang();

  return (
    <Dialog title={t("registerTanker")} body={t("regTankerBody")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run(
            "add",
            // Register, then (prototype: "Register and apply for permit") send the permit application.
            async () => {
              const reg = await supabase().rpc("owner_register_tanker", { p_plate: plate.trim(), p_service_type: type, p_capacity_gal: cap });
              if (reg.error || !apply) return reg;
              return supabase().rpc("apply_permit", { p_tanker_id: (reg.data as { id: string }).id });
            },
            t(apply ? "tkRegisteredApplied" : "tkRegistered", { plate: plate.trim().toUpperCase() }),
            () => {
              onDone();
              onClose();
            },
          );
        }}
      >
        <div className="fld">
          <label htmlFor="tkP">{t("plateNo")}</label>
          <input id="tkP" className="in" dir="ltr" required minLength={2} maxLength={20} value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="OM 4821 AR" autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="tkS">{t("service")}</label>
          <select id="tkS" className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
            {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((s) => (
              <option key={s} value={s}>
                {serviceLabel(s, lang)}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="tkC">{t("tankCap")}</label>
          <input id="tkC" className="in" dir="ltr" type="number" min={100} max={20000} step={100} required value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, margin: "0 0 12px" }}>
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> {t("applyNow")}
        </label>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "add"}>
            {busy === "add" ? t("registering") : apply ? t("registerApply") : t("registerTanker")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
