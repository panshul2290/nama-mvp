"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, ReadOnlyNote, useAudited, useRun } from "@/components/nws/admin/ui";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";

type Emergency = { on: boolean; zone: string | null; reason: string | null; since: string | null };
type Hist = { id: number; at: string; actor_email: string | null; action: string; reason: string | null; after: Emergency | null };

export default function EmergencyPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const [em, setEm] = useState<Emergency | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [zone, setZone] = useState("");
  const [reason, setReason] = useState("");
  const [hist, setHist] = useState<Hist[] | null>(null);
  const editor = can("admin", "operator");

  const load = useCallback(() => {
    const db = supabase();
    db.from("app_settings").select("value").eq("key", "EMERGENCY").maybeSingle().then(({ data }) => {
      const v = data?.value ? (JSON.parse(data.value as string) as Emergency) : { on: false, zone: null, reason: null, since: null };
      setEm(v);
      if (v.zone) setZone(v.zone);
    });
    db.from("zones").select("name").eq("active", true).order("name").then(({ data }) => {
      const names = ((data ?? []) as { name: string }[]).map((z) => z.name);
      setZones(names);
      setZone((z) => z || names[0] || "");
    });
    db.from("audit_log").select("id, at, actor_email, action, reason, after").like("action", "emergency.%").order("id", { ascending: false }).limit(10)
      .then(({ data }) => setHist((data ?? []) as Hist[]));
  }, []);
  useEffect(load, [load]);

  async function activate() {
    if (await run(supabase().rpc("staff_set_emergency", { p_on: true, p_zone: zone, p_reason: reason.trim() }), `Emergency mode active in ${zone}`)) {
      setReason("");
      load();
    }
  }
  function deactivate() {
    ask({
      title: "End emergency mode",
      body: `Dispatch returns to normal in ${em?.zone ?? "the zone"} and the banners are removed from every app.`,
      confirm: "End emergency mode",
      ok: "Emergency mode ended",
      run: (r) => supabase().rpc("staff_set_emergency", { p_on: false, p_zone: null, p_reason: r }),
      done: load,
    });
  }

  return (
    <>
      <PageHead title="Emergency mode" sub="For supply outages, health or weather events: priority dispatch for one zone, with banners in every app." />
      {!editor && <ReadOnlyNote who="Super admins and control room operators" />}
      {em?.on && (
        <div className="banner badb">
          <b>Emergency mode is active in {em.zone}</b> since {fmtDateTime(em.since)} — “{em.reason}”
        </div>
      )}
      <div className="half">
        <div className="panel">
          <h2>
            <span>Emergency mode {em == null ? null : em.on ? <span className="st bad">Active</span> : <span className="st">Off</span>}</span>
          </h2>
          <div className="pad">
            {em?.on ? (
              <>
                <dl className="kv" style={{ padding: "4px 0 14px" }}>
                  <dt>Affected zone</dt><dd>{em.zone}</dd>
                  <dt>Since</dt><dd>{fmtDateTime(em.since)}</dd>
                  <dt>Reason</dt><dd>{em.reason}</dd>
                </dl>
                <button className="btn" disabled={!editor} onClick={deactivate}>End emergency mode</button>
              </>
            ) : (
              <>
                <div className="fld">
                  <label htmlFor="em-zone">Affected zone</label>
                  <select id="em-zone" className="in" value={zone} disabled={!editor} onChange={(e) => setZone(e.target.value)}>
                    {zones.map((z) => <option key={z}>{z}</option>)}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="em-reason">Reason shown to drivers and customers (kept in the audit log)</label>
                  <input id="em-reason" className="in" value={reason} disabled={!editor} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Water supply interruption after main burst" />
                </div>
                <button className="btn pri" disabled={!editor || !zone || reason.trim().length < 3} onClick={activate}>Activate emergency mode</button>
              </>
            )}
          </div>
        </div>
        <div className="panel">
          <h2>What changes when active</h2>
          <ul className="plain">
            <li>Emergency requests from the zone jump the dispatch queue (priority dispatch).</li>
            <li>Driver shift settings are overridden; tanker companies are asked to put drivers in and near the zone on duty.</li>
            <li>Customers and drivers in the zone see a banner with the reason in the customer and driver apps.</li>
            <li>The control room’s Live operations view shows the emergency banner and highlights the zone.</li>
            <li>Every activation and deactivation is recorded in the audit log.</li>
          </ul>
        </div>
      </div>
      <div className="panel">
        <h2>History</h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Zone</th><th>By</th><th>Reason</th></tr></thead>
            <tbody>
              {hist?.length === 0 && <Empty cols={5}>Emergency mode has not been used yet.</Empty>}
              {hist?.map((h) => (
                <tr key={h.id}>
                  <td><small>{fmtDateTime(h.at)}</small></td>
                  <td>{h.action === "emergency.activate" ? <span className="st bad">Activated</span> : <span className="st">Ended</span>}</td>
                  <td>{h.after?.zone ?? "—"}</td>
                  <td>{h.actor_email ?? "—"}</td>
                  <td>{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {dialog}
    </>
  );
}
