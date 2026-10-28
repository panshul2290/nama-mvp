"use client";

import { useState } from "react";
import { currentDoc, onTime, tankerOf, useCompanyOrders, useFleet } from "@/components/company/CompanyContext";
import { Dialog, St, daysUntil, fmtDate, useAction } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";

export default function CompanyDrivers() {
  const fleet = useFleet("drivers");
  const { orders } = useCompanyOrders("drivers", 90);
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);

  async function assign(driverId: string, tankerId: string) {
    const current = tankerOf(fleet, driverId);
    if (tankerId === "") {
      if (!current) return;
      await run(driverId, () => supabase().rpc("owner_unassign", { p_tanker_id: current.id }), `Driver unassigned from ${current.plate}`, fleet.reload);
      return;
    }
    const t = fleet.tankers.find((x) => x.id === tankerId);
    await run(driverId, () => supabase().rpc("owner_assign_driver", { p_driver_id: driverId, p_tanker_id: tankerId }), `Assigned to ${t?.plate ?? "tanker"}`, fleet.reload);
  }

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="mut" style={{ fontSize: 13 }}>
          Drivers sign up in the Driver app, then you add them here by email and assign a tanker
        </span>
        <button className="btn pri" onClick={() => setAdding(true)}>
          Add driver
        </button>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Tanker</th>
              <th>Heavy licence</th>
              <th className="num">Jobs (90 d)</th>
              <th className="num">Rating</th>
              <th className="num">On time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {fleet.drivers.map((d) => {
              const tk = tankerOf(fleet, d.id);
              const mine = orders.filter((o) => o.driver_id === d.id && o.status === "delivered");
              const rated = mine.filter((o) => o.rating);
              const timed = mine.map(onTime).filter((x) => x !== null);
              const lic = currentDoc(fleet.docs, "heavy_licence", { driver: d.id });
              const licDays = lic ? daysUntil(lic.valid_to) : null;
              return (
                <tr key={d.id}>
                  <td>
                    <b>{d.full_name || "Unnamed driver"}</b>
                    <small className="docmeta">{d.phone ?? "No phone"}</small>
                  </td>
                  <td>
                    <select className="inl" aria-label={`Tanker for ${d.full_name}`} value={tk?.id ?? ""} disabled={busy === d.id} onChange={(e) => assign(d.id, e.target.value)}>
                      <option value="">— Not assigned</option>
                      {fleet.tankers.map((t) => {
                        const other = fleet.assignments.find((a) => a.tanker_id === t.id && a.driver_id !== d.id);
                        return (
                          <option key={t.id} value={t.id}>
                            {t.plate} · {t.service_type}
                            {other ? ` (replaces ${fleet.drivers.find((x) => x.id === other.driver_id)?.full_name ?? "driver"})` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td>
                    {!lic ? (
                      <St tone="bad">Missing</St>
                    ) : lic.status === "pending_review" ? (
                      <St tone="act">In review · {fmtDate(lic.valid_to)}</St>
                    ) : (
                      <St tone={licDays! < 0 ? "bad" : licDays! <= 30 ? "warn" : "ok"}>{licDays! < 0 ? "Expired" : fmtDate(lic.valid_to)}</St>
                    )}
                  </td>
                  <td className="num">{mine.length}</td>
                  <td className="num">{rated.length ? `${(rated.reduce((s, o) => s + (o.rating ?? 0), 0) / rated.length).toFixed(1)} ★` : "—"}</td>
                  <td className="num">{timed.length ? `${Math.round((timed.filter(Boolean).length / timed.length) * 100)}%` : "—"}</td>
                  <td>{!tk ? <St tone="warn">No tanker</St> : tk.blocked ? <St tone="bad">Tanker blocked</St> : tk.is_online ? <St tone="ok">Online</St> : <St>Offline</St>}</td>
                </tr>
              );
            })}
            {fleet.loaded && !fleet.drivers.length && (
              <tr>
                <td colSpan={7} className="empty">
                  No drivers yet. Ask each driver to create an account in the Driver app, then add them here with the email they used.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">A driver can drive one tanker at a time. Changing a tanker takes it offline until the driver goes online again; it isn’t possible while either is on a job.</p>
      {adding && <AddDriver onClose={() => setAdding(false)} onDone={fleet.reload} />}
    </div>
  );
}

function AddDriver({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [email, setEmail] = useState("");
  return (
    <Dialog title="Add driver" body="Enter the email the driver used to sign up in the Driver app. A tanker they registered themselves joins your company too." onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("add", () => supabase().rpc("owner_add_driver", { p_email: email.trim() }), "Driver added to your company", () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="drE">Driver’s email</label>
          <input id="drE" className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="driver@example.com" autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "add"}>
            {busy === "add" ? "Adding…" : "Add driver"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
