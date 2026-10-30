"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { STAGE_LABEL, tankerPermit, useFleet, type FPermit } from "@/components/company/CompanyContext";
import { TypeTag } from "@/components/OrderBits";
import { Dialog, St, daysUntil, fmtDate, fmtDateTime, useAction, useLive } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import type { Inspection } from "@/lib/types";

const STAGES = ["submitted", "documents", "inspection", "decision"] as const;

export default function CompanyPermits() {
  const fleet = useFleet("permits");
  const { busy, run } = useAction();
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [answering, setAnswering] = useState<FPermit | null>(null);

  const loadInspections = useCallback(async () => {
    const { data } = await supabase()
      .from("inspections")
      .select("id, tanker_id, permit_id, inspector_id, result, notes, checklist, scheduled_for, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    setInspections((data ?? []) as Inspection[]);
  }, []);
  useLive("company-inspections", ["inspections"], loadInspections, 60_000);

  const plate = (id: string) => fleet.tankers.find((t) => t.id === id)?.plate ?? "—";

  return (
    <>
      <div className="panel">
        <div className="toolbar">
          <span className="mut" style={{ fontSize: 13 }}>
            Applications go straight to the NWS permits team. A tanker needs an approved, valid permit for its service to go online.
          </span>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Tanker</th>
                <th>Service</th>
                <th>Current permit</th>
                <th>Application</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fleet.tankers.map((t) => {
                const p = tankerPermit(t, fleet.permits);
                const pending = fleet.permits.find((x) => x.tanker_id === t.id && x.status === "pending");
                return (
                  <tr key={t.id}>
                    <td className="tk-plate">{t.plate}</td>
                    <td>
                      <TypeTag type={t.service_type} />
                    </td>
                    <td>
                      <St tone={p.tone}>{p.text}</St>
                    </td>
                    <td>
                      {pending ? (
                        <>
                          {pending.info_requested ? <St tone="warn">Info requested</St> : <St tone="act">{STAGE_LABEL[pending.stage] ?? pending.stage}</St>}
                          {pending.info_requested && <small className="docmeta">NWS asks: {pending.info_requested}</small>}
                          {!pending.info_requested && pending.info_response && <small className="docmeta">You replied {fmtDate(pending.info_responded_at)}</small>}
                        </>
                      ) : (
                        <span className="mut">—</span>
                      )}
                    </td>
                    <td className="num">
                      {pending?.info_requested ? (
                        <button className="btn sm pri" onClick={() => setAnswering(pending)}>
                          Reply to NWS
                        </button>
                      ) : (
                      <button
                        className={`btn sm ${p.tone === "bad" || p.tone === "warn" ? "pri" : ""}`}
                        disabled={!!pending || busy === t.id}
                        title={pending ? "An application is already with NWS" : undefined}
                        onClick={() => run(t.id, () => supabase().rpc("apply_permit", { p_tanker_id: t.id }), `Application for ${t.plate} sent to NWS`, fleet.reload)}
                      >
                        {busy === t.id ? "Sending…" : p.valid && p.tone === "ok" ? "Apply for renewal" : p.text === "No permit" ? "Apply for permit" : "Apply for renewal"}
                      </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {fleet.loaded && !fleet.tankers.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    Register a tanker first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Applications and permits</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Application / permit</th>
                <th>Tanker</th>
                <th>Service</th>
                <th>Submitted</th>
                <th>Stage</th>
                <th>Status</th>
                <th>Valid to</th>
                <th>Notes from NWS</th>
              </tr>
            </thead>
            <tbody>
              {fleet.permits.map((p) => {
                const expired = p.status === "approved" && daysUntil(p.expires_at) <= 0;
                const stageIdx = STAGES.indexOf(p.stage);
                return (
                  <tr key={p.id}>
                    <td>{p.permit_no}</td>
                    <td className="tk-plate">{plate(p.tanker_id)}</td>
                    <td>
                      <TypeTag type={p.type} />
                    </td>
                    <td>{fmtDate(p.created_at)}</td>
                    <td>
                      {p.status === "pending" ? (
                        <span title={STAGES.map((s) => STAGE_LABEL[s]).join(" → ")}>
                          {STAGE_LABEL[p.stage]} <small className="mut">({stageIdx + 1} of 4)</small>
                        </span>
                      ) : (
                        <span className="mut">Done</span>
                      )}
                    </td>
                    <td>
                      {p.status === "pending" ? (
                        <St tone={p.info_requested ? "warn" : "act"}>{p.info_requested ? "Info requested" : "In review"}</St>
                      ) : p.status === "approved" ? (
                        <St tone={expired ? "bad" : "ok"}>{expired ? "Expired" : "Issued"}</St>
                      ) : p.status === "rejected" ? (
                        <St tone="bad">Rejected</St>
                      ) : (
                        <St tone="bad">Expired</St>
                      )}
                    </td>
                    <td>{p.status === "approved" || p.status === "expired" ? fmtDate(p.expires_at) : "—"}</td>
                    <td style={{ maxWidth: 320 }}>
                      {p.info_requested && <b style={{ color: "var(--warn)" }}>Information requested: {p.info_requested}</b>}
                      {!p.info_requested && p.info_response && <small className="docmeta">Your reply ({fmtDateTime(p.info_responded_at)}): {p.info_response}</small>}
                      {p.reason && <small className="docmeta">{p.reason}</small>}
                      {!p.info_requested && !p.reason && !p.info_response && <span className="mut">—</span>}
                    </td>
                  </tr>
                );
              })}
              {fleet.loaded && !fleet.permits.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    No applications yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">
          Stages: submitted → document check → inspection → decision. When NWS asks for information, upload any document it needs in <Link className="lk" href="/company/compliance">Compliance</Link>, then use “Reply to NWS” so the permits team sees your answer. You get a notification at each decision.
        </p>
      </div>

      {answering && (
        <ReplyDialog
          permit={answering}
          plate={plate(answering.tanker_id)}
          onClose={() => setAnswering(null)}
          onDone={() => {
            setAnswering(null);
            fleet.reload();
          }}
        />
      )}

      {inspections.length > 0 && (
        <div className="panel">
          <h2>Inspections</h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Tanker</th>
                  <th>Date</th>
                  <th>Result</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((i) => (
                  <tr key={i.id}>
                    <td className="tk-plate">{plate(i.tanker_id)}</td>
                    <td>{fmtDate(i.scheduled_for ?? i.created_at)}</td>
                    <td>
                      <St tone={i.result === "pass" ? "ok" : i.result === "fail" ? "bad" : "act"}>{i.result === "scheduled" ? "Scheduled" : i.result === "pass" ? "Passed" : "Failed"}</St>
                    </td>
                    <td>{i.notes || <span className="mut">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/** Answer NWS's information request (permit_respond, 0023): clears the request and shows the answer to the permits team. */
function ReplyDialog({ permit, plate, onClose, onDone }: { permit: FPermit; plate: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  return (
    <Dialog title={`Reply to NWS — ${permit.permit_no}`} body={`NWS asks about ${plate}: “${permit.info_requested}”`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("reply", () => supabase().rpc("permit_respond", { p_permit_id: permit.id, p_note: text.trim() }), "Reply sent to the NWS permits team", onDone);
        }}
      >
        <div className="fld">
          <label htmlFor="pr-reply">Your answer</label>
          <textarea id="pr-reply" className="in" rows={4} maxLength={1000} required minLength={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. The new insurance policy is uploaded in Compliance." autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "reply" || text.trim().length < 3}>
            {busy === "reply" ? "Sending…" : "Send reply"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
