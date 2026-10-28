"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, Kpi, PageHead, useAudited, useRun } from "@/components/nws/admin/ui";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";
import { ref, type Incident, type Integration } from "@/lib/types";
import { useFocusTrap } from "@/lib/useFocusTrap";

type Target = { priority: Incident["priority"]; label: string; response_min: number; resolve_min: number };
const STATUS: Record<Integration["status"], [string, string]> = { ok: ["Operational", "ok"], warn: ["Degraded", "warn"], down: ["Down", "bad"], simulated: ["Simulated", "act"] };
const dur = (min: number) => (min < 60 ? `${Math.max(0, Math.round(min))} min` : min < 1440 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${(min / 1440).toFixed(1)} days`);

export default function HealthPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const [ints, setInts] = useState<Integration[] | null>(null);
  const [incs, setIncs] = useState<Incident[] | null>(null);
  const [targets, setTargets] = useState<Map<string, Target>>(new Map());
  const [testing, setTesting] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [now, setNow] = useState(0); // time of the last load, for "waiting" response clocks
  const responder = can("admin", "operator");

  const load = useCallback(() => {
    const db = supabase();
    db.from("integrations").select("*").order("name").then(({ data }) => setInts((data ?? []) as Integration[]));
    db.from("incidents").select("*").order("opened_at", { ascending: false }).limit(50).then(({ data }) => {
      setNow(Date.now());
      setIncs((data ?? []) as Incident[]);
    });
    db.from("incident_targets").select("*").then(({ data }) => setTargets(new Map(((data ?? []) as Target[]).map((t) => [t.priority, t]))));
  }, []);
  useEffect(load, [load]);

  async function test(i: Integration) {
    setTesting(i.key);
    await run(supabase().rpc("staff_test_integration", { p_key: i.key }), `${i.name}: test sent`);
    setTesting(null);
    load();
  }
  function act(i: Incident, action: "acknowledge" | "resolve") {
    ask({
      title: `${action === "acknowledge" ? "Acknowledge" : "Resolve"} ${ref.incident(i.inc_no)}`,
      body: i.title,
      confirm: action === "acknowledge" ? "Acknowledge" : "Resolve incident",
      ok: action === "acknowledge" ? "Incident acknowledged" : "Incident resolved",
      run: (note) => supabase().rpc("staff_incident_action", { p_incident_id: i.id, p_action: action, p_note: note }),
      done: load,
    });
  }

  const lat = (ints ?? []).map((i) => i.latency_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : null;
  const open = (incs ?? []).filter((i) => i.state !== "resolved");
  const okCount = (ints ?? []).filter((i) => i.status === "ok" || i.status === "simulated").length;

  return (
    <>
      <PageHead title="System health" sub="Platform availability, the interfaces to NWS and partner systems, and incidents against the tender's priority matrix.">
        {responder && <button className="btn pri" onClick={() => setOpening(true)}>Open incident</button>}
      </PageHead>
      <div className="okpis">
        <Kpi label="Uptime, 30 days" value="99.9%" sub="simulated · uptime = (720 h − lost) / 720 h; contract target TBC" />
        <Kpi label="Interface latency p95" value={p95 == null ? "—" : `${p95} ms`} sub={`last test of ${lat.length} interface${lat.length === 1 ? "" : "s"}`} tone={p95 != null && p95 > 500 ? "warn" : undefined} />
        <Kpi label="Open incidents" value={incs ? open.length : "…"} sub={open.some((i) => i.priority === "P1") ? "including a P1" : "no P1 open"} tone={open.some((i) => i.priority === "P1") ? "bad" : open.length ? "warn" : "ok"} />
        <Kpi label="Interfaces OK" value={ints ? `${okCount} / ${ints.length}` : "…"} sub={ints?.some((i) => i.status === "warn" || i.status === "down") ? "some degraded" : "all responding"} tone={ints?.some((i) => i.status === "down") ? "bad" : ints?.some((i) => i.status === "warn") ? "warn" : "ok"} />
      </div>

      <div className="panel">
        <h2>Interfaces <small>IT administrators only</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>System</th><th>Purpose</th><th>Status</th><th>Last test</th><th className="num">Latency</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {!ints && <Empty cols={7}>Loading…</Empty>}
              {ints?.map((i) => (
                <tr key={i.key}>
                  <td><b style={{ fontWeight: 600 }}>{i.name}</b></td>
                  <td><small>{i.purpose}</small></td>
                  <td><span className={`st ${STATUS[i.status][1]}`}>{STATUS[i.status][0]}</span></td>
                  <td><small>{i.last_test_at ? fmtDateTime(i.last_test_at) : "Never"}</small></td>
                  <td className="num">{i.latency_ms != null ? `${i.latency_ms} ms` : "—"}</td>
                  <td><small>{i.note}</small></td>
                  <td className="num"><button className="btn sm" disabled={testing === i.key} onClick={() => test(i)}>{testing === i.key ? "Testing…" : "Test"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Incidents</h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>Incident</th><th>Priority</th><th>Opened</th><th>Response</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {incs?.length === 0 && <Empty cols={6}>No incidents recorded.</Empty>}
              {incs?.map((i) => {
                const t = targets.get(i.priority);
                const resp = ((i.acknowledged_at ? new Date(i.acknowledged_at).getTime() : now) - new Date(i.opened_at).getTime()) / 60000;
                const late = t ? resp > t.response_min : false;
                return (
                  <tr key={i.id}>
                    <td>{ref.incident(i.inc_no)} · {i.title}<small style={{ display: "block" }}>{i.system} · {i.owner}</small></td>
                    <td>{i.priority}{t && <small style={{ display: "block" }}>{t.label}</small>}</td>
                    <td><small>{fmtDateTime(i.opened_at)}</small></td>
                    <td>
                      <span className={`st ${late ? "bad" : i.acknowledged_at ? "ok" : "warn"}`}>
                        {i.acknowledged_at ? dur(resp) : `Waiting ${dur(resp)}`}{t ? ` (target ${dur(t.response_min)})` : ""}
                      </span>
                    </td>
                    <td>
                      {i.state === "resolved" ? (
                        <span className="st ok">Resolved in {dur((new Date(i.resolved_at!).getTime() - new Date(i.opened_at).getTime()) / 60000)}</span>
                      ) : (
                        <span className={`st ${i.state === "open" ? "bad" : "act"}`}>{i.state === "open" ? "Open" : "In progress"}</span>
                      )}
                    </td>
                    <td className="num">
                      {responder && i.state !== "resolved" && (
                        <div className="btns" style={{ justifyContent: "flex-end" }}>
                          {i.state === "open" && <button className="btn sm" onClick={() => act(i, "acknowledge")}>Acknowledge</button>}
                          <button className="btn sm pri" onClick={() => act(i, "resolve")}>Resolve</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          Response and resolution targets follow the tender&apos;s incident priority matrix:{" "}
          {[...targets.values()].sort((a, b) => a.priority.localeCompare(b.priority)).map((t) => `${t.priority} respond ${dur(t.response_min)} / resolve ${dur(t.resolve_min)}`).join(" · ")}.
        </p>
      </div>
      {opening && <OpenIncident targets={[...targets.values()].sort((a, b) => a.priority.localeCompare(b.priority))} onClose={() => setOpening(false)} onDone={() => { setOpening(false); load(); }} />}
      {dialog}
    </>
  );
}

function OpenIncident({ targets, onClose, onDone }: { targets: Target[]; onClose: () => void; onDone: () => void }) {
  const run = useRun();
  const [priority, setPriority] = useState("P3");
  const [title, setTitle] = useState("");
  const [system, setSystem] = useState("");
  const [busy, setBusy] = useState(false);
  const trap = useFocusTrap(busy ? undefined : onClose);
  return (
    <div ref={trap} className="dlg" role="dialog" aria-modal="true" aria-label="Open incident" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <h3>Open incident</h3>
        <p>The on-call team is paged and the response clock starts now.</p>
        <div className="fld">
          <label htmlFor="inc-p">Priority</label>
          <select id="inc-p" className="in" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {targets.map((t) => <option key={t.priority} value={t.priority}>{t.priority} — {t.label}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="inc-t">What is happening</label>
          <input id="inc-t" className="in" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Push notifications delayed" />
        </div>
        <div className="fld">
          <label htmlFor="inc-s">Affected system</label>
          <input id="inc-s" className="in" value={system} maxLength={80} onChange={(e) => setSystem(e.target.value)} placeholder="e.g. SMS gateway" />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn pri"
            disabled={busy || title.trim().length < 3 || system.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              const ok = await run(supabase().rpc("staff_open_incident", { p_priority: priority, p_title: title.trim(), p_system: system.trim() }), "Incident opened");
              setBusy(false);
              if (ok) onDone();
            }}
          >
            {busy ? "Opening…" : "Open incident"}
          </button>
        </div>
      </div>
    </div>
  );
}
