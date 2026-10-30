"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, Kpi, PageHead, ReadOnlyNote, useAudited, useRun } from "@/components/nws/admin/ui";
import { SETTINGS } from "@/components/nws/i18n/settings";
import { useStaff } from "@/components/nws/StaffContext";
import { fmtNumber, useFmt, type Fmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type Incident, type Integration } from "@/lib/types";
import { useFocusTrap } from "@/lib/useFocusTrap";

type T = (key: string, vars?: Record<string, string | number>) => string;
type Target = { priority: Incident["priority"]; label: string; response_min: number; resolve_min: number; response_wd: number | null; resolve_wd: number | null; penalty_pct: number | string };
// incident_status() (0028): deadlines in working days where the matrix says so, breach flags, escalation level.
type IncStatus = Incident & { response_due: string; resolve_due: string; response_breached: boolean; resolve_breached: boolean; penalty_pct: number | string; escalation_level: number };
const LEVEL = ["", "lvl1", "lvl2"];
// Integration status → SETTINGS key and tone.
const STATUS: Record<Integration["status"], [string, string]> = { ok: ["intOk", "ok"], warn: ["intWarn", "warn"], down: ["intDown", "bad"], simulated: ["intSim", "act"] };
const dur = (min: number, t: T, f: Fmt) =>
  min < 60
    ? t("durMin", { n: f.n(Math.max(0, Math.round(min))) })
    : min < 1440
      ? t("durHM", { h: f.n(Math.floor(min / 60)), m: f.n(Math.round(min % 60)) })
      : t("durDays", { n: f.n(min / 1440, 1) });
const target = (min: number, wd: number | null, t: T, f: Fmt) => (wd != null ? t(wd === 1 ? "wd1" : "wdN", { n: f.n(wd) }) : dur(min, t, f));
const pctOf = (v: number | string, f: Fmt) => `${fmtNumber(Number(v), f.lang, { maximumFractionDigits: 2 })}${f.ar ? "٪" : "%"}`;

export default function HealthPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const t = useT(SETTINGS);
  const f = useFmt();
  const [ints, setInts] = useState<Integration[] | null>(null);
  const [incs, setIncs] = useState<IncStatus[] | null>(null);
  const [targets, setTargets] = useState<Map<string, Target>>(new Map());
  const [testing, setTesting] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [now, setNow] = useState(0); // time of the last load, for "waiting" response clocks
  const responder = can("admin", "operator");

  const load = useCallback(() => {
    const db = supabase();
    db.from("integrations").select("*").order("name").then(({ data }) => setInts((data ?? []) as Integration[]));
    db.rpc("incident_status").then(({ data }) => {
      setNow(Date.now());
      setIncs(((data ?? []) as IncStatus[]).slice(0, 50));
    });
    db.from("incident_targets").select("*").then(({ data }) => setTargets(new Map(((data ?? []) as Target[]).map((x) => [x.priority, x]))));
  }, []);
  useEffect(load, [load]);

  async function test(i: Integration) {
    setTesting(i.key);
    await run(supabase().rpc("staff_test_integration", { p_key: i.key }), t("testSent", { name: i.name }));
    setTesting(null);
    load();
  }
  function act(i: IncStatus, action: "acknowledge" | "resolve") {
    const r = ref.incident(i.inc_no);
    ask({
      title: action === "acknowledge" ? t("ackT", { ref: r }) : t("resolveT", { ref: r }),
      body: i.title,
      confirm: action === "acknowledge" ? t("acknowledge") : t("resolveIncident"),
      ok: action === "acknowledge" ? t("incAcked") : t("incResolved"),
      run: (note) => supabase().rpc("staff_incident_action", { p_incident_id: i.id, p_action: action, p_note: note }),
      done: load,
    });
  }

  const lat = (ints ?? []).map((i) => i.latency_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : null;
  const open = (incs ?? []).filter((i) => i.state !== "resolved");
  const monthStart = new Date(new Date(now + 4 * 3600_000).toISOString().slice(0, 8) + "01T00:00:00+04:00").getTime();
  const monthBreaches = (incs ?? []).filter((i) => Date.parse(i.opened_at) >= monthStart && (i.response_breached || i.resolve_breached));
  // Simulated interfaces aren't "OK": they are counted separately.
  const okCount = (ints ?? []).filter((i) => i.status === "ok").length;
  const simCount = (ints ?? []).filter((i) => i.status === "simulated").length;

  return (
    <>
      <PageHead title={t("navHealth")} sub={t("healthSub")}>
        {responder && <button className="btn pri" onClick={() => setOpening(true)}>{t("openIncident")}</button>}
      </PageHead>
      {!responder && <ReadOnlyNote who={t("responders")} />}
      <div className="okpis">
        <Kpi label={t("kUptime")} value={t("tbc")} sub={t("kUptimeSub")} />
        <Kpi label={t("kLatency")} value={p95 == null ? "—" : t("ms", { n: f.n(p95) })} sub={t(lat.length === 1 ? "lastTest1" : "lastTestN", { n: f.n(lat.length) })} tone={p95 != null && p95 > 500 ? "warn" : undefined} />
        <Kpi
          label={t("kBreaches")}
          value={incs ? f.n(monthBreaches.length) : "…"}
          sub={incs ? t("kBreachesSub", { pct: pctOf(monthBreaches.reduce((a, i) => a + Number(i.penalty_pct), 0), f) }) : ""}
          tone={monthBreaches.length ? "bad" : "ok"}
        />
        <Kpi label={t("kOpenInc")} value={incs ? f.n(open.length) : "…"} sub={open.some((i) => i.priority === "P1") ? t("withP1") : t("noP1")} tone={open.some((i) => i.priority === "P1") ? "bad" : open.length ? "warn" : "ok"} />
        <Kpi
          label={t("kIntOk")}
          value={ints ? `${f.n(okCount)} / ${f.n(ints.length)}` : "…"}
          sub={ints?.some((i) => i.status === "warn" || i.status === "down") ? t("someDegraded") : simCount ? t("nSimulated", { n: f.n(simCount) }) : t("allResponding")}
          tone={ints?.some((i) => i.status === "down") ? "bad" : ints?.some((i) => i.status === "warn") ? "warn" : simCount ? undefined : "ok"}
        />
      </div>

      <div className="panel">
        <h2>{t("interfaces")} <small>{t("itOnly")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("system")}</th><th>{t("purpose")}</th><th>{t("status")}</th><th>{t("lastTest")}</th><th className="num">{t("latency")}</th><th>{t("note")}</th><th></th></tr></thead>
            <tbody>
              {!ints && <Empty cols={7}>{t("loading")}</Empty>}
              {ints?.map((i) => (
                <tr key={i.key}>
                  <td><b style={{ fontWeight: 600 }}>{i.name}</b></td>
                  <td><small>{i.purpose}</small></td>
                  <td><span className={`st ${STATUS[i.status][1]}`}>{t(STATUS[i.status][0])}</span></td>
                  <td><small>{i.last_test_at ? f.dateTime(i.last_test_at) : t("never")}</small></td>
                  <td className="num">{i.latency_ms != null ? t("ms", { n: f.n(i.latency_ms) }) : "—"}</td>
                  <td><small>{i.note}</small></td>
                  <td className="num"><button className="btn sm" disabled={!responder || testing === i.key} title={responder ? undefined : t("respondersShort")} onClick={() => test(i)}>{testing === i.key ? t("testing") : t("test")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>{t("incidents")} <small>{t("incidentsSub")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("incident")}</th><th>{t("priority")}</th><th>{t("opened")}</th><th>{t("response")}</th><th>{t("resolution")}</th><th>{t("escalation")}</th><th></th></tr></thead>
            <tbody>
              {incs?.length === 0 && <Empty cols={7}>{t("noIncidents")}</Empty>}
              {incs?.map((i) => {
                const tg = targets.get(i.priority);
                const resp = ((i.acknowledged_at ? Date.parse(i.acknowledged_at) : now) - Date.parse(i.opened_at)) / 60000;
                return (
                  <tr key={i.id}>
                    <td><bdi dir="ltr">{ref.incident(i.inc_no)}</bdi> · {i.title}<small style={{ display: "block" }}>{i.system}</small></td>
                    <td>{i.priority}{tg && <small style={{ display: "block" }}>{t("perBreach", { label: tg.label, pct: pctOf(tg.penalty_pct, f) })}</small>}</td>
                    <td><small>{f.dateTime(i.opened_at)}</small></td>
                    <td>
                      <span className={`st ${i.response_breached ? "bad" : i.acknowledged_at ? "ok" : "warn"}`}>
                        {i.response_breached ? t("breachedDot") : ""}{i.acknowledged_at ? dur(resp, t, f) : t("waiting", { d: dur(resp, t, f) })}
                      </span>
                      <small style={{ display: "block" }}>{t("dueAt", { at: f.dateTime(i.response_due) })}</small>
                    </td>
                    <td>
                      {i.state === "resolved" ? (
                        <span className={`st ${i.resolve_breached ? "bad" : "ok"}`}>{i.resolve_breached ? t("breachedDot") : ""}{t("resolvedIn", { d: dur((Date.parse(i.resolved_at!) - Date.parse(i.opened_at)) / 60000, t, f) })}</span>
                      ) : (
                        <span className={`st ${i.resolve_breached ? "bad" : i.state === "open" ? "warn" : "act"}`}>{i.resolve_breached ? t("breached") : i.state === "open" ? t("stOpen") : t("inProgress")}</span>
                      )}
                      <small style={{ display: "block" }}>{t("dueAt", { at: f.dateTime(i.resolve_due) })}</small>
                    </td>
                    <td>{i.escalation_level ? <span className="st warn">{LEVEL[i.escalation_level] ? t(LEVEL[i.escalation_level]) : t("lvlN", { n: f.n(i.escalation_level) })}</span> : <span className="mut">—</span>}</td>
                    <td className="num">
                      {responder && i.state !== "resolved" && (
                        <div className="btns" style={{ justifyContent: "flex-end" }}>
                          {i.state === "open" && <button className="btn sm" onClick={() => act(i, "acknowledge")}>{t("acknowledge")}</button>}
                          <button className="btn sm pri" onClick={() => act(i, "resolve")}>{t("resolve")}</button>
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
          {t("targetsLead")}{" "}
          {[...targets.values()]
            .sort((a, b) => a.priority.localeCompare(b.priority))
            .map((x) => t("tgtLine", { p: x.priority, r: target(x.response_min, x.response_wd, t, f), s: target(x.resolve_min, x.resolve_wd, t, f), pct: pctOf(x.penalty_pct, f) }))
            .join(" · ")}
          .{" "}{t("escalNote")}
        </p>
      </div>
      {opening && <OpenIncident targets={[...targets.values()].sort((a, b) => a.priority.localeCompare(b.priority))} onClose={() => setOpening(false)} onDone={() => { setOpening(false); load(); }} />}
      {dialog}
    </>
  );
}

function OpenIncident({ targets, onClose, onDone }: { targets: Target[]; onClose: () => void; onDone: () => void }) {
  const run = useRun();
  const t = useT(SETTINGS);
  const [priority, setPriority] = useState("P3");
  const [title, setTitle] = useState("");
  const [system, setSystem] = useState("");
  const [busy, setBusy] = useState(false);
  const trap = useFocusTrap(busy ? undefined : onClose);
  return (
    <div ref={trap} className="dlg" role="dialog" aria-modal="true" aria-label={t("openIncident")} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <h3>{t("openIncident")}</h3>
        <p>{t("incPaged")}</p>
        <div className="fld">
          <label htmlFor="inc-p">{t("priority")}</label>
          <select id="inc-p" className="in" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {targets.map((x) => <option key={x.priority} value={x.priority}>{x.priority} — {x.label}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="inc-t">{t("whatHappening")}</label>
          <input id="inc-t" className="in" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t("whatPh")} />
        </div>
        <div className="fld">
          <label htmlFor="inc-s">{t("affected")}</label>
          <input id="inc-s" className="in" value={system} maxLength={80} onChange={(e) => setSystem(e.target.value)} placeholder={t("affectedPh")} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>{t("cancel")}</button>
          <button
            className="btn pri"
            disabled={busy || title.trim().length < 3 || system.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              const ok = await run(supabase().rpc("staff_open_incident", { p_priority: priority, p_title: title.trim(), p_system: system.trim() }), t("incOpened"));
              setBusy(false);
              if (ok) onDone();
            }}
          >
            {busy ? t("opening") : t("openIncident")}
          </button>
        </div>
      </div>
    </div>
  );
}
