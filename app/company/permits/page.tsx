"use client";

import { useEffect, useState } from "react";
import { STAGE_LABEL, tankerPermit, useFleet } from "@/components/company/CompanyContext";
import { TypeTag } from "@/components/OrderBits";
import { St, daysUntil, fmtDate, useAction } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import type { Inspection } from "@/lib/types";

const STAGES = ["submitted", "documents", "inspection", "decision"] as const;

export default function CompanyPermits() {
  const fleet = useFleet("permits", ["inspections"]);
  const { busy, run } = useAction();
  const [inspections, setInspections] = useState<Inspection[]>([]);

  useEffect(() => {
    let cancelled = false;
    supabase()
      .from("inspections")
      .select("id, tanker_id, permit_id, inspector_id, result, notes, checklist, scheduled_for, created_at")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => !cancelled && setInspections((data ?? []) as Inspection[]));
    return () => {
      cancelled = true;
    };
  }, [fleet.permits.length]);

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
                          <St tone="act">{STAGE_LABEL[pending.stage] ?? pending.stage}</St>
                          {pending.info_requested && <small className="docmeta">NWS asks: {pending.info_requested}</small>}
                        </>
                      ) : (
                        <span className="mut">—</span>
                      )}
                    </td>
                    <td className="num">
                      <button
                        className={`btn sm ${p.tone === "bad" || p.tone === "warn" ? "pri" : ""}`}
                        disabled={!!pending || busy === t.id}
                        title={pending ? "An application is already with NWS" : undefined}
                        onClick={() => run(t.id, () => supabase().rpc("apply_permit", { p_tanker_id: t.id }), `Application for ${t.plate} sent to NWS`, fleet.reload)}
                      >
                        {busy === t.id ? "Sending…" : p.valid && p.tone === "ok" ? "Apply for renewal" : p.text === "No permit" ? "Apply for permit" : "Apply for renewal"}
                      </button>
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
                        <St tone="act">In review</St>
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
                      {p.reason && <small className="docmeta">{p.reason}</small>}
                      {!p.info_requested && !p.reason && <span className="mut">—</span>}
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
          Stages: submitted → document check → inspection → decision. When NWS requests information, upload the missing document in Compliance; the permits team is notified automatically.
        </p>
      </div>

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
