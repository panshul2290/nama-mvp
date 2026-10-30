"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useBiz } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { useFmt } from "@/components/portal/i18n";
import { Dialog, St, useAction, useLive } from "@/components/portal/kit";
import { canEscalate, casePromise, caseSteps, NAMA_1442 } from "@/lib/complaints";
import { useT } from "@/lib/i18n";
import { REFUND_POLICY } from "@/lib/refundPolicy";
import { supabase } from "@/lib/supabase/client";
import { ref, type Complaint, type ComplaintNote } from "@/lib/types";

// Business complaints (#33/#34): every case the team reported on the organisation's orders
// (admins see all of them, others their own), with the status timeline (received → in review →
// resolved), NWS's promised answer time (complaint_sla), the conversation, a reply box for the
// person who reported it, and "Escalate to Nama 1442".
type Case = Complaint & { order: { id: string; order_no: number; org_id: string } | null };

const STEP = { received: "tlReceived", review: "tlReview", escalated: "tlEscalated", resolved: "tlResolved" } as const;
const tone = (c: Complaint) => (c.state === "resolved" ? "ok" : c.state === "escalated" ? "bad" : c.state === "new" ? "warn" : "act");

export default function BusinessComplaints() {
  const { org } = useBiz();
  const t = useT(BIZ);
  const f = useFmt();
  const [cases, setCases] = useState<Case[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const { data } = await supabase()
      .from("complaints")
      .select("*, order:orders!inner(id, order_no, org_id)")
      .eq("order.org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(200);
    setCases((data ?? []) as unknown as Case[]);
    setNow(Date.now());
  }, [org.id]);
  useLive("biz-complaints", ["complaints"], load);

  const cat = (c: Complaint) => (BIZ[`cat_${c.category}`] ? t(`cat_${c.category}`) : c.category.replace(/_/g, " "));
  const state = (c: Complaint) => t(STEP[c.state === "new" ? "received" : c.state === "resolved" ? "resolved" : c.state === "escalated" ? "escalated" : "review"]);
  const selected = cases?.find((c) => c.id === sel) ?? null;
  // Escalated and high-priority cases first, then the newest.
  const list = [...(cases ?? [])].sort((a, b) => Number(b.state === "escalated") - Number(a.state === "escalated") || Number(b.priority === "high") - Number(a.priority === "high") || b.created_at.localeCompare(a.created_at));

  return (
    <>
      <div className="vhead">
        <div>
          <h1>{t("cxTitle")}</h1>
          <p>{t("cxLead")}</p>
        </div>
      </div>
      <div className="half">
        <div className="panel">
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("cxCase")}</th>
                  <th>{t("cxCategory")}</th>
                  <th>{t("status")}</th>
                  <th>{t("cxPromise")}</th>
                </tr>
              </thead>
              <tbody>
                {!cases && (
                  <tr>
                    <td colSpan={4} className="empty">
                      {t("loading")}
                    </td>
                  </tr>
                )}
                {cases?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      {t("cxNone")}
                    </td>
                  </tr>
                )}
                {list.map((c) => {
                  const p = casePromise(c, now);
                  return (
                    <tr key={c.id} className={`click ${sel === c.id ? "sel" : ""}`} onClick={() => setSel(c.id)}>
                      <td>
                        <b dir="ltr">{ref.complaint(c.case_no)}</b>
                        {c.order && (
                          <small className="stack" dir="ltr">
                            {ref.order(c.order.order_no)}
                          </small>
                        )}
                      </td>
                      <td>{cat(c)}</td>
                      <td>
                        <St tone={tone(c)}>{state(c)}</St>
                        {c.priority === "high" && c.state !== "resolved" && <small className="stack">{t("cxHigh")}</small>}
                      </td>
                      <td>{c.state === "resolved" ? <St tone={p.kind === "met" ? "ok" : "bad"}>{f.dateTime(c.resolved_at)}</St> : <span className={p.kind === "late" ? "bad" : ""}>{f.dateTime(c.due_at)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">{selected ? <CaseDetail key={selected.id} c={selected} label={cat(selected)} onChanged={load} /> : <div className="empty">{t("cxSelect")}</div>}</div>
      </div>
    </>
  );
}

function CaseDetail({ c, label, onChanged }: { c: Case; label: string; onChanged: () => Promise<void> }) {
  const { profile, isAdmin } = useBiz();
  const t = useT(BIZ);
  const tr = useT(REFUND_POLICY);
  const f = useFmt();
  const { busy, run } = useAction();
  const [notes, setNotes] = useState<ComplaintNote[]>([]);
  const [reply, setReply] = useState("");
  const [esc, setEsc] = useState(false);
  const [why, setWhy] = useState("");
  const [now] = useState(() => Date.now());
  const mine = c.customer_id === profile.id;

  const loadNotes = useCallback(async () => {
    const { data } = await supabase().from("complaint_notes").select("*").eq("complaint_id", c.id).order("created_at");
    setNotes((data ?? []) as ComplaintNote[]);
  }, [c.id]);
  useEffect(() => {
    const t0 = setTimeout(loadNotes, 0);
    return () => clearTimeout(t0);
  }, [loadNotes, c.state]);

  const steps = caseSteps(c);
  const p = casePromise(c, now);
  return (
    <>
      <h2>
        <span dir="ltr">{ref.complaint(c.case_no)}</span> · {label}
      </h2>
      <div className="pad">
        <ol className="plain" aria-label={t("status")}>
          {steps.map((s) => (
            <li key={s.key} aria-current={s.current ? "step" : undefined}>
              <St tone={s.done ? (s.key === "escalated" ? "bad" : s.key === "resolved" ? "ok" : "act") : ""}>{t(STEP[s.key])}</St> {s.at && <small>{f.dateTime(s.at)}</small>}
            </li>
          ))}
        </ol>
        <p className={p.kind === "late" || p.kind === "missed" ? "bad" : ""}>
          {p.kind === "open" ? t("tlPromise", { h: f.n(p.hours), at: f.dateTime(p.due) }) : p.kind === "late" ? t("tlLate") : t(p.kind === "met" ? "tlMet" : "tlMissed", { h: f.n(p.hours) })}
        </p>
        {c.order && (
          <p>
            <Link className="lk" href={`/business/orders/${c.order.id}`} dir="ltr">
              {ref.order(c.order.order_no)}
            </Link>
          </p>
        )}
        {c.resolution && <div className="banner">{c.resolution}</div>}
        {Number(c.refund_amount) > 0 && (
          <div className="banner info">
            {t("cxRefunded", { amount: f.omr(c.refund_amount) })} {tr("rpBusiness")}
          </div>
        )}

        <h3>{t("cxThread")}</h3>
        <ul className="plain">
          {notes.map((n) => (
            <li key={n.id}>
              <b>{n.author_role === "customer" || n.author_role === "business" ? t("cxYou") : t("cxNws")}</b> <small>{f.dateTime(n.created_at)}</small>
              <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
            </li>
          ))}
        </ul>
        {c.state !== "resolved" &&
          (mine ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run("reply", () => supabase().rpc("complaint_reply", { p_complaint_id: c.id, p_body: reply.trim() }), t("cxSent"), () => {
                  setReply("");
                  loadNotes();
                });
              }}
            >
              <div className="fld">
                <label htmlFor="cxr">{t("cxReplyL")}</label>
                <textarea id="cxr" className="in" rows={3} maxLength={2000} required value={reply} onChange={(e) => setReply(e.target.value)} />
              </div>
              <button className="btn pri" disabled={busy === "reply" || !reply.trim()}>
                {t("cxSend")}
              </button>
            </form>
          ) : (
            <p className="mut">{t("cxReplyOwn")}</p>
          ))}

        <div style={{ marginTop: 16 }}>
          {!canEscalate(c) ? (
            <div className="banner badb">{t("escAlready", { at: f.dateTime(c.escalated_at ?? c.created_at) })}</div>
          ) : (
            (mine || isAdmin) && (
              <button className="btn" onClick={() => setEsc(true)}>
                {t("escT")}
              </button>
            )
          )}
          <p>
            <a className="lk" href={`tel:${NAMA_1442}`}>
              {t("call1442")}
            </a>{" "}
            · {t("callNum")}{" "}
            <bdi dir="ltr" style={{ userSelect: "all", fontWeight: 700 }}>
              {NAMA_1442}
            </bdi>
          </p>
        </div>
      </div>
      {esc && (
        <Dialog title={t("escT")} body={t("escS")} onClose={() => setEsc(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run("esc", () => supabase().rpc("escalate_complaint", { p_complaint_id: c.id, p_reason: why.trim() || null }), t("escDone"), () => {
                setEsc(false);
                onChanged();
                loadNotes();
              });
            }}
          >
            <div className="fld">
              <label htmlFor="escw">{t("escWhy")}</label>
              <textarea id="escw" className="in" rows={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
            </div>
            <div className="btns" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setEsc(false)}>
                {t("cancel")}
              </button>
              <button className="btn pri" disabled={busy === "esc"}>
                {t("escBtn")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
