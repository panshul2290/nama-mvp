"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { permitText, tankerPermit, useFleet, type FPermit } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { TypeTag } from "@/components/OrderBits";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, daysUntil, useAction, useLive } from "@/components/portal/kit";
import { useLang, useT } from "@/lib/i18n";
import { permitStage } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import type { Inspection } from "@/lib/types";

const STAGES = ["submitted", "documents", "inspection", "decision"] as const;

export default function CompanyPermits() {
  const fleet = useFleet("permits");
  const { busy, run } = useAction();
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [answering, setAnswering] = useState<FPermit | null>(null);
  const t = useT(CO);
  const f = useFmt();
  const { lang } = useLang();

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
            {t("pmIntro")}
          </span>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("tanker")}</th>
                <th>{t("service")}</th>
                <th>{t("curPermit")}</th>
                <th>{t("application")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fleet.tankers.map((tk) => {
                const p = tankerPermit(tk, fleet.permits);
                const pending = fleet.permits.find((x) => x.tanker_id === tk.id && x.status === "pending");
                return (
                  <tr key={tk.id}>
                    <td className="tk-plate">{tk.plate}</td>
                    <td>
                      <TypeTag type={tk.service_type} />
                    </td>
                    <td>
                      <St tone={p.tone}>{permitText(tk, fleet.permits, lang)}</St>
                    </td>
                    <td>
                      {pending ? (
                        <>
                          {pending.info_requested ? <St tone="warn">{t("infoRequested")}</St> : <St tone="act">{permitStage(pending.stage, lang)}</St>}
                          {pending.info_requested && <small className="docmeta">{t("nwsAsks", { q: pending.info_requested })}</small>}
                          {!pending.info_requested && pending.info_response && <small className="docmeta">{t("youReplied", { date: f.date(pending.info_responded_at) })}</small>}
                        </>
                      ) : (
                        <span className="mut">—</span>
                      )}
                    </td>
                    <td className="num">
                      {pending?.info_requested ? (
                        <button className="btn sm pri" onClick={() => setAnswering(pending)}>
                          {t("replyNws")}
                        </button>
                      ) : (
                      <button
                        className={`btn sm ${p.tone === "bad" || p.tone === "warn" ? "pri" : ""}`}
                        disabled={!!pending || busy === tk.id}
                        title={pending ? t("alreadyWithNws") : undefined}
                        onClick={() => run(tk.id, () => supabase().rpc("apply_permit", { p_tanker_id: tk.id }), t("applySent", { plate: tk.plate }), fleet.reload)}
                      >
                        {busy === tk.id ? t("sending") : p.valid && p.tone === "ok" ? t("applyRenewal") : p.text === "No permit" ? t("applyPermit") : t("applyRenewal")}
                      </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {fleet.loaded && !fleet.tankers.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    {t("registerTankerFirst")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>{t("appsTitle")}</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("appPermit")}</th>
                <th>{t("tanker")}</th>
                <th>{t("service")}</th>
                <th>{t("submittedCol")}</th>
                <th>{t("stageCol")}</th>
                <th>{t("status")}</th>
                <th>{t("validTo")}</th>
                <th>{t("notesNws")}</th>
              </tr>
            </thead>
            <tbody>
              {fleet.permits.map((p) => {
                const expired = p.status === "approved" && daysUntil(p.expires_at) <= 0;
                const stageIdx = STAGES.indexOf(p.stage);
                return (
                  <tr key={p.id}>
                    <td>
                      <bdi dir="ltr">{p.permit_no}</bdi>
                    </td>
                    <td className="tk-plate">{plate(p.tanker_id)}</td>
                    <td>
                      <TypeTag type={p.type} />
                    </td>
                    <td>{f.date(p.created_at)}</td>
                    <td>
                      {p.status === "pending" ? (
                        <span title={STAGES.map((s) => permitStage(s, lang)).join(lang === "ar" ? " ← " : " → ")}>
                          {permitStage(p.stage, lang)} <small className="mut">{t("stepOf", { n: f.n(stageIdx + 1) })}</small>
                        </span>
                      ) : (
                        <span className="mut">{t("done")}</span>
                      )}
                    </td>
                    <td>
                      {p.status === "pending" ? (
                        <St tone={p.info_requested ? "warn" : "act"}>{p.info_requested ? t("infoRequested") : t("inReview")}</St>
                      ) : p.status === "approved" ? (
                        <St tone={expired ? "bad" : "ok"}>{expired ? t("expired") : t("issued")}</St>
                      ) : p.status === "rejected" ? (
                        <St tone="bad">{t("rejected")}</St>
                      ) : (
                        <St tone="bad">{t("expired")}</St>
                      )}
                    </td>
                    <td>{p.status === "approved" || p.status === "expired" ? f.date(p.expires_at) : "—"}</td>
                    <td style={{ maxWidth: 320 }}>
                      {p.info_requested && <b style={{ color: "var(--warn)" }}>{t("infoReqX", { q: p.info_requested })}</b>}
                      {!p.info_requested && p.info_response && <small className="docmeta">{t("yourReply", { date: f.dateTime(p.info_responded_at), text: p.info_response })}</small>}
                      {p.reason && <small className="docmeta">{p.reason}</small>}
                      {!p.info_requested && !p.reason && !p.info_response && <span className="mut">—</span>}
                    </td>
                  </tr>
                );
              })}
              {fleet.loaded && !fleet.permits.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    {t("noApps")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">
          {t("permNote1")}{" "}
          <Link className="lk" href="/company/compliance">
            {t("tabCompliance")}
          </Link>
          {t("permNote2")}
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
          <h2>{t("inspTitle")}</h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("tanker")}</th>
                  <th>{t("date")}</th>
                  <th>{t("result")}</th>
                  <th>{t("notes")}</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((i) => (
                  <tr key={i.id}>
                    <td className="tk-plate">{plate(i.tanker_id)}</td>
                    <td>{f.date(i.scheduled_for ?? i.created_at)}</td>
                    <td>
                      <St tone={i.result === "pass" ? "ok" : i.result === "fail" ? "bad" : "act"}>{i.result === "scheduled" ? t("inspScheduled") : i.result === "pass" ? t("passed") : t("failed")}</St>
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
  const t = useT(CO);
  return (
    <Dialog title={t("replyTitle", { no: `\u2066${permit.permit_no}\u2069` })} body={t("replyBody", { plate, q: permit.info_requested ?? "" })} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("reply", () => supabase().rpc("permit_respond", { p_permit_id: permit.id, p_note: text.trim() }), t("replySent"), onDone);
        }}
      >
        <div className="fld">
          <label htmlFor="pr-reply">{t("yourAnswer")}</label>
          <textarea id="pr-reply" className="in" rows={4} maxLength={1000} required minLength={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("answerPh")} autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "reply" || text.trim().length < 3}>
            {busy === "reply" ? t("sending") : t("sendReply")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
