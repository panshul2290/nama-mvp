"use client";

import { useState } from "react";
import { driverOf, tankerPermit, tankerStatus, useCompany, useFleet } from "@/components/company/CompanyContext";
import { TypeTag } from "@/components/OrderBits";
import { Dialog, St, fmtDate, useAction } from "@/components/portal/kit";
import { agoText } from "@/lib/gps";
import { SERVICE_LABEL, type ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

export default function CompanyTankers() {
  const fleet = useFleet("tankers");
  const { company } = useCompany();
  const [adding, setAdding] = useState(false);

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="mut" style={{ fontSize: 13 }}>
          Every tanker must have a valid NWS permit and a working IVMS device
        </span>
        <button className="btn pri" onClick={() => setAdding(true)}>
          Register tanker
        </button>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Tanker</th>
              <th>Service</th>
              <th className="num">Capacity (gal)</th>
              <th>Driver</th>
              <th>Permit</th>
              <th>IVMS</th>
              <th>Last position</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {fleet.tankers.map((t) => {
              const p = tankerPermit(t, fleet.permits);
              const dev = fleet.devices.find((d) => d.tanker_id === t.id);
              const [s, tone] = tankerStatus(t, fleet.permits, company.status === "suspended");
              const open = fleet.alerts.filter((a) => a.tanker_id === t.id && a.state === "open");
              return (
                <tr key={t.id}>
                  <td>
                    <span className="tk-plate">{t.plate}</span>
                    <small className="docmeta">Registered {fmtDate(t.created_at)}</small>
                  </td>
                  <td>
                    <TypeTag type={t.service_type} />
                  </td>
                  <td className="num">{t.capacity_gal.toLocaleString()}</td>
                  <td>{driverOf(fleet, t.id)?.full_name ?? <span className="mut">—</span>}</td>
                  <td>
                    <St tone={p.tone}>{p.text}</St>
                  </td>
                  <td>
                    {dev ? (
                      <>
                        {dev.id}
                        <small className="docmeta">Firmware {dev.firmware}</small>
                      </>
                    ) : (
                      <St tone="warn">Not installed</St>
                    )}
                  </td>
                  <td>{t.location_age_s == null ? <span className="mut">—</span> : agoText(t.location_age_s)}</td>
                  <td>
                    <St tone={tone}>{s}</St>
                    {t.blocked && t.blocked_reason && <small className="docmeta">{t.blocked_reason}</small>}
                    {open.length > 0 && <small className="docmeta">{open.length} open alert{open.length > 1 ? "s" : ""}: {open[0].message}</small>}
                  </td>
                </tr>
              );
            })}
            {fleet.loaded && !fleet.tankers.length && (
              <tr>
                <td colSpan={8} className="empty">
                  No tankers yet. Register your first tanker to get an IVMS device and apply for a permit.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">Tankers registered here belong to your company. NWS blocks a tanker from jobs when its permit lapses or after a serious violation; you’ll see the reason here.</p>
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

  return (
    <Dialog title="Register tanker" body="An IVMS device is provisioned automatically. NWS checks the documents you upload in Compliance before it inspects the tanker." onClose={onClose}>
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
            `${plate.trim().toUpperCase()} registered${apply ? " — permit application sent to NWS" : ""}`,
            () => {
              onDone();
              onClose();
            },
          );
        }}
      >
        <div className="fld">
          <label htmlFor="tkP">Plate number</label>
          <input id="tkP" className="in" required minLength={2} maxLength={20} value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="OM 4821 AR" autoFocus />
        </div>
        <div className="fld">
          <label htmlFor="tkS">Service</label>
          <select id="tkS" className="in" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
            {(Object.keys(SERVICE_LABEL) as ServiceType[]).map((s) => (
              <option key={s} value={s}>
                {SERVICE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="tkC">Tank capacity (gallons)</label>
          <input id="tkC" className="in" type="number" min={100} max={20000} step={100} required value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, margin: "0 0 12px" }}>
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> Apply for the NWS permit now
        </label>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "add"}>
            {busy === "add" ? "Registering…" : apply ? "Register and apply" : "Register tanker"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
