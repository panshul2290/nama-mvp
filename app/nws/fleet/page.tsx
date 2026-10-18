"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { permitSummary, type FleetTanker } from "@/components/nws/fleetData";
import { fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { agoText, STALE_AFTER_S } from "@/lib/gps";
import { supabase } from "@/lib/supabase/client";

export default function FleetPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Fleet />
    </Suspense>
  );
}

type Dialog = { kind: "block" | "unblock" | "unassign" | "assign"; tanker: FleetTanker } | null;

function Fleet() {
  const { can, toast } = useStaff();
  const highlight = useSearchParams().get("tanker");
  const [rows, setRows] = useState<FleetTanker[] | null>(null);
  const [freeDrivers, setFreeDrivers] = useState<{ id: string; full_name: string }[]>([]);
  const [dlg, setDlg] = useState<Dialog>(null);
  const [driverPick, setDriverPick] = useState("");
  const [filter, setFilter] = useState<"all" | "online" | "blocked" | "nopermit">("all");
  const isOperator = can("operator");

  const load = useCallback(async () => {
    const db = supabase();
    const [t, d, a] = await Promise.all([
      db
        .from("tankers")
        .select(
          "id, plate, service_type, capacity_gal, is_online, blocked, blocked_reason, blocked_at, location_age_s, assignments:tanker_assignments(id, driver_id, assigned_at, unassigned_at, driver:profiles!tanker_assignments_driver_id_fkey(full_name, phone)), permits(id, permit_no, type, status, issued_at, expires_at)",
        )
        .order("plate"),
      db.from("profiles").select("id, full_name").eq("role", "driver").order("full_name"),
      db.from("tanker_assignments").select("driver_id").is("unassigned_at", null),
    ]);
    setRows((t.data ?? []) as unknown as FleetTanker[]);
    const busy = new Set((a.data ?? []).map((x) => x.driver_id));
    setFreeDrivers(((d.data ?? []) as { id: string; full_name: string }[]).filter((x) => !busy.has(x.id)));
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const db = supabase();
    const ch = db.channel("nws-fleet").on("postgres_changes", { event: "*", schema: "public", table: "tankers" }, () => load()).subscribe();
    return () => {
      clearTimeout(first);
      db.removeChannel(ch);
    };
  }, [load]);

  async function act(rpc: string, args: Record<string, unknown>, ok: string) {
    const { error } = await supabase().rpc(rpc, args);
    if (error) return toast(friendlyError(error), true);
    toast(ok);
    setDlg(null);
    load();
  }

  const active = (t: FleetTanker) => t.assignments.find((a) => !a.unassigned_at) ?? null;
  const list = (rows ?? []).filter((t) =>
    filter === "online" ? t.is_online : filter === "blocked" ? t.blocked : filter === "nopermit" ? !permitSummary(t).valid : true,
  );
  const counts = {
    total: rows?.length ?? 0,
    online: rows?.filter((t) => t.is_online).length ?? 0,
    blocked: rows?.filter((t) => t.blocked).length ?? 0,
    nopermit: rows?.filter((t) => !permitSummary(t).valid).length ?? 0,
  };
  const opTitle = isOperator ? undefined : "Operators only";

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Fleet</h1>
          <p>
            Tankers, their current driver, GPS and permit status. Operators can block a tanker (it goes offline and can’t take jobs) and override driver
            assignment. Driver assignment will move to the tanker company portal; this stays as the NWS override.
          </p>
        </div>
      </div>
      <div className="okpis">
        <div className="okpi"><span>Tankers</span><b>{counts.total}</b><small>registered</small></div>
        <div className="okpi"><span>Online</span><b>{counts.online}</b><small className="ok">receiving jobs</small></div>
        <div className="okpi"><span>Blocked</span><b>{counts.blocked}</b><small className={counts.blocked ? "bad" : ""}>by an operator</small></div>
        <div className="okpi"><span>No valid permit</span><b>{counts.nopermit}</b><small className={counts.nopermit ? "warn" : ""}>can’t go online</small></div>
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="chips">
            {(
              [
                ["all", "All"],
                ["online", "Online"],
                ["blocked", "Blocked"],
                ["nopermit", "No valid permit"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {l}
              </button>
            ))}
          </div>
          {!isOperator && <span className="mut" style={{ fontSize: 12.5 }}>Read-only: block and assignment actions are for operators.</span>}
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Tanker</th>
                <th>Type</th>
                <th className="num">Capacity</th>
                <th>Driver</th>
                <th>Online</th>
                <th>Last fix</th>
                <th>Permit</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows && list.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">No tankers.</td>
                </tr>
              )}
              {!rows && (
                <tr>
                  <td colSpan={9} className="empty">Loading…</td>
                </tr>
              )}
              {list.map((t) => {
                const a = active(t);
                const p = permitSummary(t);
                const stale = t.is_online && (t.location_age_s == null || t.location_age_s > STALE_AFTER_S);
                return (
                  <tr key={t.id} className={highlight === t.id ? "sel" : ""}>
                    <td className={`stripe ${t.service_type}`}><b>{t.plate}</b></td>
                    <td><span className={`tag ${t.service_type}`}>{t.service_type}</span></td>
                    <td className="num">{t.capacity_gal.toLocaleString()}</td>
                    <td>
                      {a?.driver?.full_name ?? <span className="mut">Unassigned</span>}
                      {a?.driver?.phone ? <small style={{ display: "block" }}>{a.driver.phone}</small> : null}
                    </td>
                    <td><span className={`st ${t.is_online ? "ok" : ""}`}>{t.is_online ? "Online" : "Offline"}</span></td>
                    <td>
                      {t.location_age_s == null ? <span className="mut">No fix</span> : <span className={stale ? "mut" : ""}>{agoText(t.location_age_s)}</span>}
                      {stale ? <small style={{ display: "block", color: "var(--bad)" }}>stale</small> : null}
                    </td>
                    <td><span className={`st ${p.tone}`}>{p.text}</span></td>
                    <td>
                      {t.blocked ? (
                        <>
                          <span className="st bad">Blocked</span>
                          <small style={{ display: "block" }} title={t.blocked_reason ?? ""}>
                            {t.blocked_reason} · {fmtDateTime(t.blocked_at)}
                          </small>
                        </>
                      ) : (
                        <span className="st ok">Active</span>
                      )}
                    </td>
                    <td>
                      <div className="btns" style={{ flexWrap: "nowrap" }}>
                        {t.blocked ? (
                          <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unblock", tanker: t })}>Unblock</button>
                        ) : (
                          <button className="btn sm bad" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "block", tanker: t })}>Block</button>
                        )}
                        {a ? (
                          <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => setDlg({ kind: "unassign", tanker: t })}>Unassign</button>
                        ) : (
                          <button className="btn sm" disabled={!isOperator} title={opTitle} onClick={() => { setDriverPick(""); setDlg({ kind: "assign", tanker: t }); }}>Assign</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {dlg?.kind === "block" && (
        <ReasonDialog
          title={`Block ${dlg.tanker.plate}`}
          body="The tanker goes offline immediately and can’t go online or accept jobs until it is unblocked."
          confirm="Block tanker"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_block_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, `${dlg.tanker.plate} blocked`)}
        />
      )}
      {dlg?.kind === "unblock" && (
        <ReasonDialog
          title={`Unblock ${dlg.tanker.plate}`}
          body="The driver can go online again (if the tanker has a valid permit)."
          confirm="Unblock"
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_unblock_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, `${dlg.tanker.plate} unblocked`)}
        />
      )}
      {dlg?.kind === "unassign" && (
        <ReasonDialog
          title={`Unassign ${dlg.tanker.plate}`}
          body={`Removes ${active(dlg.tanker)?.driver?.full_name ?? "the driver"} from this tanker and takes it offline. Refused while the tanker is on a job.`}
          confirm="Unassign"
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => act("staff_unassign_tanker", { p_tanker_id: dlg.tanker.id, p_reason: reason }, `${dlg.tanker.plate} unassigned`)}
        />
      )}
      {dlg?.kind === "assign" && (
        <ReasonDialog
          title={`Assign a driver to ${dlg.tanker.plate}`}
          body="NWS override. Only drivers without a tanker are listed."
          confirm="Assign"
          extra={
            <div className="fld">
              <label htmlFor="drv">Driver</label>
              <select id="drv" className="in" value={driverPick} onChange={(e) => setDriverPick(e.target.value)}>
                <option value="">Choose a driver…</option>
                {freeDrivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name || d.id}</option>
                ))}
              </select>
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={(reason) =>
            driverPick
              ? act("staff_assign_tanker", { p_driver_id: driverPick, p_tanker_id: dlg.tanker.id, p_reason: reason }, `Driver assigned to ${dlg.tanker.plate}`)
              : toast("Choose a driver first", true)
          }
        />
      )}
    </>
  );
}
