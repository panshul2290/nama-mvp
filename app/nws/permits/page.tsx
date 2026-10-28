"use client";

import "../ops.css";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DAY, Modal, n3, one, St, Tabs, useNow, useRpc, useSignedUrl, SERVICE_NAME } from "@/components/nws/ops";
import { fmtDate, fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { Loading } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";
import type { ServiceType } from "@/lib/pricing";

export default function PermitsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Permits />
    </Suspense>
  );
}

type Status = "pending" | "approved" | "rejected" | "expired";
type Stage = "submitted" | "documents" | "inspection" | "decision";
type Named = { name: string } | { name: string }[] | null;
type TankerRef = { id: string; plate: string; service_type: ServiceType; capacity_gal: number; company: Named };
type PermitRow = {
  id: string; permit_no: string; type: ServiceType; issued_at: string; expires_at: string; status: Status; effective_status: Status;
  stage: Stage; info_requested: string | null; reviewed_at: string | null; reason: string | null; created_at: string;
  /** Set for applications from an owner or driver; null for permits a permit officer created directly. */
  applied_by: string | null;
  tanker: TankerRef | TankerRef[] | null;
  reviewer: { full_name: string } | { full_name: string }[] | null;
};
type Doc = { id: string; tanker_id: string | null; driver_id: string | null; kind: string; ref_no: string; valid_to: string; file_path: string | null; status: "valid" | "pending_review" | "rejected"; uploaded_at: string };
type AutoCheck = { check: string; ok: boolean | null; detail: string };
type Audit = { id: number; at: string; action: string; actor_email: string | null; reason: string | null };
type Penalty = {
  id: string; penalty_no: number; rule_code: string; amount: string; reason: string; evidence: string; state: "issued" | "disputed" | "upheld" | "cancelled";
  dispute_text: string | null; created_at: string;
  tanker: { plate: string } | { plate: string }[] | null; company: Named; order: { order_no: number } | { order_no: number }[] | null;
  rule: { label: string } | { label: string }[] | null;
};
type Rule = { code: string; label: string; party: string; amount: string; amount_kind: string; active: boolean };
type Inspection = {
  id: string; tanker_id: string; permit_id: string | null; result: "scheduled" | "pass" | "fail"; notes: string; scheduled_for: string | null; created_at: string;
  tanker: { plate: string; service_type: ServiceType } | { plate: string; service_type: ServiceType }[] | null;
  permit: { permit_no: string } | { permit_no: string }[] | null;
  inspector: { full_name: string } | { full_name: string }[] | null;
};
type Company = { id: string; name: string; cr_no: string; phone: string | null; rating: number; since: string; status: "pending" | "active" | "suspended" };
type Tab = "apps" | "exp" | "viol" | "insp" | "co";
type Dlg =
  | { k: "reject" | "resubmit" | "info" | "pass" | "fail" | "issue" | "schedule" }
  | { k: "doc_reject"; id: string }
  | { k: "pen"; p: Penalty; decision: "uphold" | "cancel" }
  | { k: "insp"; row: Inspection; result: "pass" | "fail" }
  | { k: "co"; c: Company; action: "activate" | "suspend" }
  | null;

const TONE: Record<Status, string> = { pending: "warn", approved: "ok", rejected: "bad", expired: "bad" };
const LABEL: Record<Status, string> = { pending: "Pending review", approved: "Approved", rejected: "Rejected", expired: "Expired" };
const STAGES = ["Submitted", "Documents", "Inspection", "Decision", "Issued"];
const STAGE_IDX: Record<Stage, number> = { submitted: 0, documents: 1, inspection: 2, decision: 3 };
const STAGE_LABEL: Record<Stage, string> = { submitted: "New submission", documents: "Document check", inspection: "Inspection", decision: "Awaiting decision" };
const NEXT_LABEL: Record<Stage, string> = { submitted: "Accept submission", documents: "Complete document check", inspection: "Record inspection: passed", decision: "Approve and issue permit" };
const DOC_LABEL: Record<string, string> = {
  mulkiya: "Mulkiya (registration)", tank_cleanliness: "Tank cleanliness certificate", rop_inspection: "ROP vehicle inspection", insurance: "Insurance",
  ivms_certificate: "IVMS installation certificate", heavy_licence: "Driver heavy-vehicle licence", water_test: "Water quality test",
};
const PEN_TONE: Record<Penalty["state"], string> = { issued: "warn", disputed: "bad", upheld: "ok", cancelled: "" };
const PEN_LABEL: Record<Penalty["state"], string> = { issued: "Open", disputed: "Disputed", upheld: "Upheld", cancelled: "Cancelled" };
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function Permits() {
  const { can, toast } = useStaff();
  const params = useSearchParams();
  const now = useNow(60_000);
  const run = useRpc();
  const officer = can("permit_officer");
  const canInspect = can("inspector", "permit_officer");
  const canDoc = can("permit_officer", "inspector");
  const canDecide = can("operator", "admin", "finance");
  const canIssue = can("operator", "inspector", "admin");
  const canCompany = can("permit_officer", "admin");

  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get("tab");
    return t === "exp" || t === "viol" || t === "insp" || t === "co" ? t : "apps";
  });
  const [rows, setRows] = useState<PermitRow[] | null>(null);
  const [tankers, setTankers] = useState<TankerRef[]>([]);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [appFilter, setAppFilter] = useState<"pending" | "all" | Status>("pending");
  const [penFilter, setPenFilter] = useState<"open" | "all" | "upheld" | "cancelled">("open");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [checks, setChecks] = useState<AutoCheck[] | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newExpiry, setNewExpiry] = useState("");
  const [form, setForm] = useState(() => ({ tanker: "", permit_no: "", type: "DW" as ServiceType, issued: isoDay(new Date()), expires: isoDay(new Date(Date.now() + 365 * DAY)) }));
  const [pen, setPen] = useState({ rule: "", tanker: "", order: "", amount: "" });
  const [sched, setSched] = useState({ tanker: "", permit: "" });

  const load = useCallback(async () => {
    const db = supabase();
    const [p, t, pe, r, i, c] = await Promise.all([
      db
        .from("permits")
        .select(
          "id, permit_no, type, issued_at, expires_at, status, effective_status, stage, info_requested, reviewed_at, reason, created_at, applied_by, tanker:tankers(id, plate, service_type, capacity_gal, company:companies(name)), reviewer:profiles!permits_reviewed_by_fkey(full_name)",
        )
        .order("created_at", { ascending: false }),
      db.from("tankers").select("id, plate, service_type, capacity_gal, company_id, company:companies(name)").order("plate"),
      db
        .from("penalties")
        .select("id, penalty_no, rule_code, amount, reason, evidence, state, dispute_text, created_at, tanker:tankers(plate), company:companies(name), order:orders(order_no), rule:penalty_rules(label)")
        .order("created_at", { ascending: false })
        .limit(300),
      db.from("penalty_rules").select("code, label, party, amount, amount_kind, active").order("code"),
      db
        .from("inspections")
        .select("id, tanker_id, permit_id, result, notes, scheduled_for, created_at, tanker:tankers(plate, service_type), permit:permits(permit_no), inspector:profiles(full_name)")
        .order("created_at", { ascending: false })
        .limit(200),
      db.from("companies").select("id, name, cr_no, phone, rating, since, status, created_at").order("name"),
    ]);
    const list = (p.data ?? []) as unknown as PermitRow[];
    setRows(list);
    setTankers((t.data ?? []) as unknown as (TankerRef & { company_id: string | null })[]);
    setPenalties((pe.data ?? []) as unknown as Penalty[]);
    setRules((r.data ?? []) as Rule[]);
    setInspections((i.data ?? []) as unknown as Inspection[]);
    setCompanies((c.data ?? []) as Company[]);
    // Deep link from Fleet: open that tanker's latest permit.
    const tk = params.get("tanker");
    setSel((s) => s ?? (tk ? (list.find((x) => one(x.tanker)?.id === tk)?.id ?? null) : (list.find((x) => x.status === "pending")?.id ?? null)));
    if (tk) setAppFilter((f) => (list.find((x) => one(x.tanker)?.id === tk && x.status !== "pending") ? "all" : f));
  }, [params]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const selected = rows?.find((p) => p.id === sel) ?? null;
  const selTanker = one(selected?.tanker);

  // Documents (tanker and its driver), automatic checks and audit history for the selected permit.
  const loadDetail = useCallback(async () => {
    if (!sel) return;
    const db = supabase();
    const tid = rows?.find((p) => p.id === sel) ? one(rows.find((p) => p.id === sel)!.tanker)?.id : null;
    const drv = tid ? (await db.from("tanker_assignments").select("driver_id").eq("tanker_id", tid).is("unassigned_at", null).maybeSingle()).data?.driver_id : null;
    const [d, c, a] = await Promise.all([
      tid
        ? db
            .from("tanker_documents")
            .select("id, tanker_id, driver_id, kind, ref_no, valid_to, file_path, status, uploaded_at")
            .or(drv ? `tanker_id.eq.${tid},driver_id.eq.${drv}` : `tanker_id.eq.${tid}`)
            .order("kind")
        : Promise.resolve({ data: [] }),
      db.rpc("permit_auto_checks", { p_permit_id: sel }),
      db.from("audit_log").select("id, at, action, actor_email, reason").eq("target_type", "permit").eq("target_id", sel).order("at"),
    ]);
    setDocs((d.data ?? []) as Doc[]);
    setChecks(Array.isArray(c.data) ? (c.data as AutoCheck[]) : []);
    setAudit((a.data ?? []) as Audit[]);
  }, [sel, rows]);
  useEffect(() => {
    const t = setTimeout(loadDetail, 0);
    return () => clearTimeout(t);
  }, [loadDetail]);

  async function rpc(name: string, args: Record<string, unknown>, ok: string) {
    const done = await run(name, args, ok);
    if (done) {
      setDlg(null);
      await load();
    }
    return done;
  }

  const daysLeft = useCallback((iso: string) => Math.ceil((Date.parse(iso) - now) / DAY), [now]);
  const apps = useMemo(
    () => (rows ?? []).filter((p) => (appFilter === "pending" ? p.status === "pending" : appFilter === "all" ? true : p.effective_status === appFilter)),
    [rows, appFilter],
  );
  const pending = (rows ?? []).filter((p) => p.status === "pending");
  const expiring = (rows ?? [])
    .filter((p) => p.status === "approved" && daysLeft(p.expires_at) <= 60 && daysLeft(p.expires_at) > -30)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  const openPen = penalties.filter((p) => p.state === "issued" || p.state === "disputed");
  const penList = penalties.filter((p) => (penFilter === "open" ? p.state === "issued" || p.state === "disputed" : penFilter === "all" ? true : p.state === penFilter));
  const tankerCount = (companyName: string) => tankers.filter((t) => one(t.company)?.name === companyName).length;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const ok = await rpc(
      "staff_create_permit",
      { p_tanker_id: form.tanker, p_permit_no: form.permit_no, p_type: form.type, p_issued_at: new Date(`${form.issued}T00:00:00`).toISOString(), p_expires_at: new Date(`${form.expires}T23:59:59`).toISOString() },
      "Permit created (pending review)",
    );
    if (ok) {
      setCreating(false);
      setForm((f) => ({ ...f, permit_no: "" }));
    }
  }

  async function issuePenalty(reason: string) {
    let orderId: string | null = null;
    const n = pen.order.trim().toUpperCase().replace(/^TO-?/, "");
    if (n) {
      const { data } = /^\d+$/.test(n) ? await supabase().from("orders").select("id").eq("order_no", Number(n)).maybeSingle() : { data: null };
      if (!data) return toast(`Order ${pen.order} not found`, true);
      orderId = data.id;
    }
    await rpc(
      "staff_issue_penalty",
      { p_rule: pen.rule, p_tanker_id: pen.tanker || null, p_order_id: orderId, p_reason: reason, p_amount: pen.amount ? Number(pen.amount) : null },
      "Penalty issued — the company and driver are notified",
    );
  }

  // Applications move one stage at a time (submitted → documents → inspection → decision) and are
  // approved only at the decision stage after a passed inspection; the database enforces the same.
  const passedInspection = (p: PermitRow) => {
    const tankerId = one(p.tanker)?.id;
    return inspections.some((i) => i.tanker_id === tankerId && i.result === "pass" && (i.permit_id === p.id || i.created_at >= p.created_at));
  };
  const approvable = (p: PermitRow) => p.stage === "decision" && (!p.applied_by || passedInspection(p));

  async function advance(p: PermitRow) {
    const next: Record<Stage, string | null> = { submitted: "documents", documents: "inspection", inspection: null, decision: null };
    if (p.stage === "inspection") return setDlg({ k: "pass" });
    const ok =
      p.stage === "decision"
        ? await rpc("staff_review_permit", { p_permit_id: p.id, p_decision: "approve", p_reason: null }, `${p.permit_no} approved and issued — the owner is notified`)
        : await rpc("staff_permit_stage", { p_permit_id: p.id, p_stage: next[p.stage], p_note: null }, `${p.permit_no}: ${NEXT_LABEL[p.stage].toLowerCase()} — logged`);
    if (!ok) await load(); // e.g. permit_review_incomplete: show where the application really is
  }

  const permInsp = selected ? inspections.filter((i) => i.permit_id === selected.id) : [];
  const lastInsp = permInsp[0] ?? null;
  const stageIdx = selected ? (selected.status === "approved" ? 5 : STAGE_IDX[selected.stage] ?? 0) : 0;
  const offTitle = officer ? undefined : "Permit officers only";

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Permits</h1>
          <p>Digital permit applications and renewals through a staged review, automatic expiry monitoring, and enforcement: violations, fines and field inspections.</p>
        </div>
        {tab === "apps" && (
          <button className="btn pri" disabled={!officer} title={offTitle} onClick={() => setCreating((c) => !c)}>
            {creating ? "Close" : "New permit"}
          </button>
        )}
        {tab === "viol" && (
          <button className="btn pri" disabled={!canIssue} title={canIssue ? undefined : "Operators, inspectors and admins"} onClick={() => { setPen({ rule: rules.find((r) => r.active && r.party === "driver")?.code ?? "", tanker: "", order: "", amount: "" }); setDlg({ k: "issue" }); }}>
            Issue penalty
          </button>
        )}
        {tab === "insp" && (
          <button className="btn pri" disabled={!canInspect} title={canInspect ? undefined : "Inspectors and permit officers"} onClick={() => { setSched({ tanker: "", permit: "" }); setDlg({ k: "schedule" }); }}>
            Schedule inspection
          </button>
        )}
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["apps", "Applications", pending.length],
          ["exp", "Expiring", expiring.length],
          ["viol", "Violations", openPen.length],
          ["insp", "Inspections", inspections.filter((i) => i.result === "scheduled").length],
          ["co", "Companies", companies.length],
        ]}
      />

      {tab === "apps" && (
        <>
          {creating && officer && (
            <form className="panel" onSubmit={create}>
              <h2>New permit <small>starts as a submitted application; take it through the review to issue it</small></h2>
              <div className="pad" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr)) auto", gap: 12, alignItems: "end" }}>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="pt">Tanker</label>
                  <select id="pt" className="in" required value={form.tanker} onChange={(e) => setForm({ ...form, tanker: e.target.value, type: tankers.find((t) => t.id === e.target.value)?.service_type ?? form.type })}>
                    <option value="">Choose…</option>
                    {tankers.map((t) => (
                      <option key={t.id} value={t.id}>{t.plate} · {t.service_type}</option>
                    ))}
                  </select>
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="pn">Permit number</label>
                  <input id="pn" className="in" required minLength={3} maxLength={40} value={form.permit_no} onChange={(e) => setForm({ ...form, permit_no: e.target.value })} placeholder="NWS-DW-2026-0481" />
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="ty">Type</label>
                  <select id="ty" className="in" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ServiceType })}>
                    <option value="DW">DW · drinking water</option>
                    <option value="WW">WW · wastewater</option>
                    <option value="TE">TE · treated effluent</option>
                  </select>
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="is">Issued</label>
                  <input id="is" className="in" type="date" required value={form.issued} onChange={(e) => setForm({ ...form, issued: e.target.value })} />
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="ex">Expires</label>
                  <input id="ex" className="in" type="date" required value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
                </div>
                <button className="btn pri">Create</button>
              </div>
            </form>
          )}

          <div className="pv">
            <div className="plist">
              <div className="chips">
                {(
                  [
                    ["pending", "Needs action"],
                    ["approved", "Approved"],
                    ["rejected", "Rejected"],
                    ["expired", "Expired"],
                    ["all", "All permits"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} className={`chip ${appFilter === k ? "on" : ""}`} onClick={() => setAppFilter(k)}>
                    {l}
                  </button>
                ))}
              </div>
              {!rows && <div className="empty">Loading…</div>}
              {rows && apps.length === 0 && <div className="empty">{appFilter === "pending" ? "No applications waiting for review." : "No permits."}</div>}
              {apps.map((p) => {
                const t = one(p.tanker);
                return (
                  <button key={p.id} className={`pcard ${sel === p.id ? "sel" : ""}`} onClick={() => setSel(p.id)}>
                    <span className="row">
                      <b>{p.permit_no}</b>
                      <small className="mut">{fmtDate(p.created_at)}</small>
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>{one(t?.company)?.name ?? "Independent operator"}</span>
                    <span className="row">
                      <span>
                        <span className={`tag ${p.type}`}>{SERVICE_NAME[p.type]}</span> <small className="mut">{t?.plate ?? "—"}</small>
                      </span>
                      {p.status === "pending" ? (
                        <St tone={p.info_requested ? "warn" : "act"}>{p.info_requested ? "Info requested" : STAGE_LABEL[p.stage]}</St>
                      ) : (
                        <St tone={TONE[p.effective_status]}>{LABEL[p.effective_status]}</St>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="panel pv-d">
              {!selected ? (
                <div className="empty">Select an application to review it.</div>
              ) : (
                <>
                  <div className="pv-h">
                    <div>
                      <div className="ttl">
                        <h2>{selected.permit_no}</h2>
                        {selected.status === "pending" ? (
                          <St tone={selected.info_requested ? "warn" : "act"}>{selected.info_requested ? "Info requested" : STAGE_LABEL[selected.stage]}</St>
                        ) : (
                          <St tone={TONE[selected.effective_status]}>{LABEL[selected.effective_status]}</St>
                        )}
                      </div>
                      <p>
                        {selTanker?.plate ?? "—"} · {SERVICE_NAME[selected.type]} · {selTanker?.capacity_gal.toLocaleString() ?? "—"} gal
                      </p>
                      <p style={{ color: "var(--ink)", fontWeight: 600 }}>{one(selTanker?.company)?.name ?? "Independent operator"}</p>
                    </div>
                    <small>
                      Submitted {fmtDateTime(selected.created_at)}
                      <br />
                      Valid {fmtDate(selected.issued_at)} – {fmtDate(selected.expires_at)}
                    </small>
                  </div>

                  <div className="stp">
                    {STAGES.map((s, k) => (
                      <Fragment key={s}>
                        <div className={`sx ${k < stageIdx ? "done" : k === stageIdx && selected.status === "pending" ? "cur" : ""}`}>
                          <i>{k < stageIdx ? "✓" : k + 1}</i>
                          <span>{s}</span>
                        </div>
                        {k < STAGES.length - 1 && <b className={k < stageIdx ? "done" : ""} />}
                      </Fragment>
                    ))}
                  </div>

                  {selected.info_requested && selected.status === "pending" && <div className="banner">Documents requested from the owner: {selected.info_requested}</div>}
                  {selTanker && selected.type !== selTanker.service_type && <div className="banner badb">This permit is for {selected.type}, but the tanker is {selTanker.service_type}: it doesn’t count.</div>}
                  {selected.status === "approved" && daysLeft(selected.expires_at) <= 30 && (
                    <div className="banner">{daysLeft(selected.expires_at) < 0 ? `Expired ${-daysLeft(selected.expires_at)} days ago.` : `Expires in ${daysLeft(selected.expires_at)} days.`} The tanker can’t go online without a renewal.</div>
                  )}

                  <div className="pv-two">
                    <div className="pv-box">
                      <h3>Documents</h3>
                      {docs.length === 0 && <div className="pv-r"><small>No documents on file for this tanker or its driver.</small></div>}
                      {docs.map((d) => (
                        <DocRow
                          key={d.id}
                          d={d}
                          today={isoDay(new Date(now))}
                          canReview={canDoc}
                          onApprove={() => rpc("staff_review_document", { p_document_id: d.id, p_approve: true, p_reason: null }, `${DOC_LABEL[d.kind] ?? d.kind} approved`)}
                          onReject={() => setDlg({ k: "doc_reject", id: d.id })}
                        />
                      ))}
                    </div>
                    <div className="pv-box">
                      <h3>Automatic checks</h3>
                      {!checks && <div className="pv-r"><small>Running checks…</small></div>}
                      {checks?.map((c) => (
                        <div key={c.check} className="pv-r">
                          <span>
                            <b>{c.check}</b>
                            <small>{c.detail}</small>
                          </span>
                          <St tone={c.ok ? "ok" : "bad"}>{c.ok ? "Pass" : "Check"}</St>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selected.status === "approved" ? (
                    <div className="pv-ins ok"><div><b>Permit issued</b><small>Valid until {fmtDate(selected.expires_at)} · reviewed {fmtDateTime(selected.reviewed_at)} by {one(selected.reviewer)?.full_name ?? "—"}</small></div><St tone="ok">Issued</St></div>
                  ) : selected.status === "rejected" ? (
                    <div className="pv-ins bad"><div><b>Application rejected</b><small>{selected.reason ?? "No reason recorded"} · the owner can correct and resubmit</small></div><St tone="bad">Rejected</St></div>
                  ) : lastInsp && lastInsp.result !== "scheduled" ? (
                    <div className={`pv-ins ${lastInsp.result === "pass" ? "ok" : "bad"}`}>
                      <div><b>Inspection {lastInsp.result === "pass" ? "passed" : "failed"}</b><small>{fmtDateTime(lastInsp.created_at)} · {one(lastInsp.inspector)?.full_name ?? "Inspector"} · {lastInsp.notes || "no notes"}</small></div>
                      <St tone={lastInsp.result === "pass" ? "ok" : "bad"}>{lastInsp.result === "pass" ? "Passed" : "Failed"}</St>
                    </div>
                  ) : selected.stage === "inspection" ? (
                    <div className="pv-ins"><div><b>Field inspection</b><small>Al Ghubrah filling station · checklist: tank hygiene, valves, IVMS seal, PPE</small></div><St tone="act">Scheduled</St></div>
                  ) : (
                    <div className="pv-ins"><div><b>Field inspection</b><small>Scheduled automatically once the document check is complete</small></div><St>Pending</St></div>
                  )}

                  {selected.status === "pending" && (
                    <div className="pv-act">
                      <small>
                        {selected.stage === "decision" && !approvable(selected)
                          ? "No passed inspection is recorded for this application, so it can’t be approved yet. Schedule an inspection from the Inspections tab."
                          : selected.stage === "decision"
                          ? "All checks complete. Issuing notifies the owner and lets the tanker go online."
                          : selected.stage === "inspection"
                            ? "Approval unlocks after the inspection result is recorded."
                            : "Each step is logged in the audit trail with your name."}
                      </small>
                      <div className="btns">
                        <button className="btn bad" disabled={!officer} title={offTitle} onClick={() => setDlg({ k: "reject" })}>Reject</button>
                        <button className="btn" disabled={!officer} title={offTitle} onClick={() => setDlg({ k: "info" })}>Request documents</button>
                        {selected.stage === "inspection" && (
                          <button className="btn" disabled={!canInspect} onClick={() => setDlg({ k: "fail" })}>Record inspection: failed</button>
                        )}
                        <button
                          className="btn pri"
                          disabled={selected.stage === "inspection" ? !canInspect : !officer || (selected.stage === "decision" && !approvable(selected))}
                          title={
                            selected.stage === "inspection"
                              ? canInspect
                                ? undefined
                                : "Inspectors and permit officers"
                              : selected.stage === "decision" && !approvable(selected)
                                ? "Needs a passed inspection"
                                : offTitle
                          }
                          onClick={() => advance(selected)}
                        >
                          {NEXT_LABEL[selected.stage]}
                        </button>
                      </div>
                    </div>
                  )}
                  {selected.status === "rejected" && (
                    <div className="pv-act">
                      <small>Moves the permit back to review.</small>
                      <button className="btn" disabled={!officer} title={offTitle} onClick={() => { setNewExpiry(""); setDlg({ k: "resubmit" }); }}>Resubmit…</button>
                    </div>
                  )}

                  <div>
                    <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>History <small className="mut" style={{ fontWeight: 400 }}>from the audit log</small></h3>
                    <ul className="tl" style={{ padding: "4px 0 0" }}>
                      {audit.length === 0 && <li>No staff actions recorded yet.</li>}
                      {audit.map((a) => (
                        <li key={a.id} className={a.action === "permit.reject" ? "bad" : "done"}>
                          {a.action} by {a.actor_email ?? "staff"}
                          {a.reason ? ` — ${a.reason}` : ""}
                          <small>{fmtDateTime(a.at)}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "exp" && (
        <div className="panel">
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Permit</th><th>Tanker</th><th>Type</th><th>Owner</th><th>Expires</th><th>Days left</th><th></th></tr>
              </thead>
              <tbody>
                {expiring.length === 0 && <tr><td colSpan={7} className="empty">No permits expire in the next 60 days.</td></tr>}
                {expiring.map((p) => {
                  const t = one(p.tanker);
                  const dl = daysLeft(p.expires_at);
                  return (
                    <tr key={p.id}>
                      <td><b>{p.permit_no}</b></td>
                      <td>{t?.plate ?? "—"}</td>
                      <td><span className={`tag ${p.type}`}>{SERVICE_NAME[p.type]}</span></td>
                      <td>{one(t?.company)?.name ?? "Independent"}</td>
                      <td>{fmtDate(p.expires_at)}</td>
                      <td><St tone={dl < 0 ? "bad" : dl < 10 ? "warn" : "ok"}>{dl < 0 ? `Expired ${-dl} d ago` : `${dl} days`}</St></td>
                      <td>
                        {reminded.has(p.id) ? (
                          <St tone="ok">Reminder sent</St>
                        ) : (
                          <button
                            className="btn sm"
                            onClick={() => {
                              setReminded((s) => new Set(s).add(p.id));
                              toast("Reminder sent (simulated)");
                            }}
                          >
                            Send SMS and app reminder
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">Automatic reminders go to owners at 30, 14 and 3 days, and to the NWS permits team daily. Expired tankers are blocked from jobs and from filling at NWS stations.</p>
        </div>
      )}

      {tab === "viol" && (
        <div className="panel">
          <div className="toolbar">
            <div className="chips">
              {(
                [
                  ["open", "Open and disputed"],
                  ["upheld", "Upheld"],
                  ["cancelled", "Cancelled"],
                  ["all", "All"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`chip ${penFilter === k ? "on" : ""}`} onClick={() => setPenFilter(k)}>
                  {l}
                </button>
              ))}
            </div>
            <span className="mut" style={{ fontSize: 12.5 }}>Fines on tanker companies are deducted from their earnings; cancelling reverses the deduction.</span>
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Case</th><th>Violation</th><th>Tanker</th><th>Owner</th><th>Evidence</th><th className="num">Fine</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {penList.length === 0 && <tr><td colSpan={8} className="empty">No violations.</td></tr>}
                {penList.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>V-{p.penalty_no}</b>
                      <small style={{ display: "block" }}>{fmtDateTime(p.created_at)}</small>
                    </td>
                    <td>
                      {one(p.rule)?.label ?? p.rule_code}
                      <small style={{ display: "block" }}>{p.reason}</small>
                    </td>
                    <td>
                      {one(p.tanker)?.plate ?? "—"}
                      {one(p.order) && <small style={{ display: "block" }}>TO-{one(p.order)!.order_no}</small>}
                    </td>
                    <td>{one(p.company)?.name ?? "—"}</td>
                    <td>
                      <small>{p.evidence || "—"}</small>
                      {p.dispute_text && <small style={{ display: "block", color: "var(--warn)" }}>Dispute: {p.dispute_text}</small>}
                    </td>
                    <td className="num">{n3(p.amount)}</td>
                    <td><St tone={PEN_TONE[p.state]}>{PEN_LABEL[p.state]}</St></td>
                    <td>
                      {(p.state === "issued" || p.state === "disputed") && (
                        <div className="btns" style={{ flexWrap: "nowrap" }}>
                          <button className="btn sm" disabled={!canDecide} title={canDecide ? undefined : "Operators, finance and admins"} onClick={() => setDlg({ k: "pen", p, decision: "uphold" })}>Uphold</button>
                          <button className="btn sm" disabled={!canDecide} title={canDecide ? undefined : "Operators, finance and admins"} onClick={() => setDlg({ k: "pen", p, decision: "cancel" })}>Cancel</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "insp" && (
        <div className="panel">
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Tanker</th><th>Permit</th><th>Reason / notes</th><th>Inspector</th><th>Date</th><th>Result</th></tr>
              </thead>
              <tbody>
                {inspections.length === 0 && <tr><td colSpan={6} className="empty">No inspections yet.</td></tr>}
                {inspections.map((i) => {
                  const t = one(i.tanker);
                  // A pass moves its application to the decision stage, so it must already be at the inspection stage.
                  const app = i.permit_id ? rows?.find((p) => p.id === i.permit_id) : undefined;
                  const early = app?.status === "pending" && (app.stage === "submitted" || app.stage === "documents");
                  return (
                    <tr key={i.id}>
                      <td>{t?.plate ?? "—"} {t && <span className={`tag ${t.service_type}`}>{t.service_type}</span>}</td>
                      <td>{one(i.permit)?.permit_no ?? "—"}</td>
                      <td><small>{i.notes || "—"}</small></td>
                      <td>{one(i.inspector)?.full_name ?? <span className="mut">Unassigned</span>}</td>
                      <td>{fmtDate(i.scheduled_for ?? i.created_at)}</td>
                      <td>
                        {i.result === "scheduled" ? (
                          <div className="btns" style={{ flexWrap: "nowrap" }}>
                            <St tone="act">Scheduled</St>
                            <button
                              className="btn sm"
                              disabled={!canInspect || early}
                              title={early ? "Complete the application’s document check first" : canInspect ? undefined : "Inspectors and permit officers"}
                              onClick={() => setDlg({ k: "insp", row: i, result: "pass" })}
                            >
                              Pass
                            </button>
                            <button className="btn sm bad" disabled={!canInspect} title={canInspect ? undefined : "Inspectors and permit officers"} onClick={() => setDlg({ k: "insp", row: i, result: "fail" })}>Fail</button>
                          </div>
                        ) : (
                          <St tone={i.result === "pass" ? "ok" : "bad"}>{i.result === "pass" ? "Pass" : "Fail"}</St>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">Recording a result adds the inspection to the tanker’s record; a pass on a permit application moves it to the decision stage.</p>
        </div>
      )}

      {tab === "co" && (
        <div className="panel">
          <h2>Tanker companies <small>permitted owners and operators</small></h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Company</th><th>CR number</th><th>Phone</th><th className="num">Rating</th><th>Since</th><th className="num">Tankers</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {companies.length === 0 && <tr><td colSpan={8} className="empty">No companies registered.</td></tr>}
                {companies.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.name}</b></td>
                    <td>{c.cr_no}</td>
                    <td>{c.phone ?? "—"}</td>
                    <td className="num">{Number(c.rating).toFixed(1)} ★</td>
                    <td>{fmtDate(c.since)}</td>
                    <td className="num">{tankerCount(c.name)}</td>
                    <td><St tone={c.status === "active" ? "ok" : c.status === "pending" ? "warn" : "bad"}>{c.status === "active" ? "Active" : c.status === "pending" ? "Pending activation" : "Suspended"}</St></td>
                    <td>
                      {c.status === "active" ? (
                        <button className="btn sm bad" disabled={!canCompany} title={canCompany ? undefined : "Permit officers and admins"} onClick={() => setDlg({ k: "co", c, action: "suspend" })}>Suspend</button>
                      ) : (
                        <button className="btn sm" disabled={!canCompany} title={canCompany ? undefined : "Permit officers and admins"} onClick={() => setDlg({ k: "co", c, action: "activate" })}>Activate</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dialogs */}
      {dlg?.k === "reject" && selected && (
        <ReasonDialog
          title={`Reject ${selected.permit_no}`}
          body="The tanker can’t go online on this permit. The owner can correct and resubmit."
          confirm="Reject"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => void (await rpc("staff_review_permit", { p_permit_id: selected.id, p_decision: "reject", p_reason: reason }, "Application rejected"))}
        />
      )}
      {dlg?.k === "info" && selected && (
        <ReasonDialog
          title={`Request documents — ${selected.permit_no}`}
          body="The owner is asked for the missing or corrected documents. The application stays at its current stage."
          confirm="Send request"
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => void (await rpc("staff_permit_stage", { p_permit_id: selected.id, p_stage: "request_info", p_note: reason }, "Documents requested from the owner"))}
        />
      )}
      {(dlg?.k === "pass" || dlg?.k === "fail") && selected && selTanker && (
        <ReasonDialog
          title={`Record inspection: ${dlg.k === "pass" ? "passed" : "failed"}`}
          body={`${selTanker.plate} · ${selected.permit_no}. Add the inspector’s notes (tank hygiene, valves, IVMS seal, PPE).`}
          confirm={dlg.k === "pass" ? "Record pass" : "Record fail"}
          danger={dlg.k === "fail"}
          onCancel={() => setDlg(null)}
          onConfirm={async (notes) =>
            void (await rpc(
              "staff_record_inspection",
              { p_tanker_id: selTanker.id, p_permit_id: selected.id, p_result: dlg.k, p_notes: notes, p_checklist: { tank_hygiene: dlg.k === "pass", valves: true, ivms_seal: true, ppe: true } },
              dlg.k === "pass" ? "Inspection passed — ready for decision" : "Inspection failure recorded",
            ))
          }
        />
      )}
      {dlg?.k === "resubmit" && selected && (
        <ReasonDialog
          title={`Resubmit ${selected.permit_no}`}
          body="Moves the permit back to pending review."
          confirm="Resubmit"
          extra={
            <div className="fld">
              <label htmlFor="ne">New expiry (optional)</label>
              <input id="ne" className="in" type="date" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} />
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc(
              "staff_resubmit_permit",
              { p_permit_id: selected.id, p_expires_at: newExpiry ? new Date(`${newExpiry}T23:59:59`).toISOString() : null, p_reason: reason },
              "Permit resubmitted",
            ))
          }
        />
      )}
      {dlg?.k === "doc_reject" && (
        <ReasonDialog
          title="Reject document"
          body="The owner is asked to upload a corrected document."
          confirm="Reject document"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => {
            if (await rpc("staff_review_document", { p_document_id: dlg.id, p_approve: false, p_reason: reason }, "Document rejected")) loadDetail();
          }}
        />
      )}
      {dlg?.k === "pen" && (
        <ReasonDialog
          title={`${dlg.decision === "uphold" ? "Uphold" : "Cancel"} V-${dlg.p.penalty_no}`}
          body={
            dlg.decision === "uphold"
              ? `${one(dlg.p.rule)?.label ?? dlg.p.rule_code} · ${n3(dlg.p.amount)} OMR stays deducted.`
              : `${n3(dlg.p.amount)} OMR is credited back to ${one(dlg.p.company)?.name ?? "the company"}.`
          }
          confirm={dlg.decision === "uphold" ? "Uphold penalty" : "Cancel penalty"}
          danger={dlg.decision === "cancel"}
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc("staff_decide_penalty", { p_penalty_id: dlg.p.id, p_decision: dlg.decision, p_reason: reason }, `V-${dlg.p.penalty_no} ${dlg.decision === "uphold" ? "upheld" : "cancelled"}`))
          }
        />
      )}
      {dlg?.k === "insp" && (
        <ReasonDialog
          title={`Record result: ${dlg.result === "pass" ? "pass" : "fail"} — ${one(dlg.row.tanker)?.plate ?? ""}`}
          body="Adds the result to the tanker’s inspection record."
          confirm={dlg.result === "pass" ? "Record pass" : "Record fail"}
          danger={dlg.result === "fail"}
          onCancel={() => setDlg(null)}
          onConfirm={async (notes) =>
            void (await rpc(
              "staff_record_inspection",
              { p_tanker_id: dlg.row.tanker_id, p_permit_id: dlg.row.permit_id, p_result: dlg.result, p_notes: notes, p_checklist: {} },
              dlg.result === "pass" ? "Inspection passed" : "Inspection failure recorded",
            ))
          }
        />
      )}
      {dlg?.k === "co" && (
        <ReasonDialog
          title={`${dlg.action === "activate" ? "Activate" : "Suspend"} ${dlg.c.name}`}
          body={dlg.action === "activate" ? "The company can register tankers and take contracts." : "The company is hidden from customers and can’t take new contracts."}
          confirm={dlg.action === "activate" ? "Activate" : "Suspend company"}
          danger={dlg.action === "suspend"}
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc("staff_company_action", { p_company_id: dlg.c.id, p_action: dlg.action, p_reason: reason }, `${dlg.c.name} ${dlg.action === "activate" ? "activated" : "suspended"}`))
          }
        />
      )}
      {dlg?.k === "issue" && (
        <ReasonDialog
          title="Issue penalty"
          body="Penalties follow the NWS framework. Fines are deducted from the tanker company’s earnings; the owner and driver are notified and can dispute."
          confirm="Issue penalty"
          danger
          extra={
            <>
              <div className="fld">
                <label htmlFor="pr">Violation</label>
                <select id="pr" className="in" value={pen.rule} onChange={(e) => setPen({ ...pen, rule: e.target.value })}>
                  {rules
                    .filter((r) => r.active && r.party === "driver")
                    .map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label} · {r.amount_kind === "pct" ? `${Number(r.amount)}%` : `${n3(r.amount)} OMR`}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid2" style={{ gap: 12 }}>
                <div className="fld">
                  <label htmlFor="ptk">Tanker</label>
                  <select id="ptk" className="in" value={pen.tanker} onChange={(e) => setPen({ ...pen, tanker: e.target.value })}>
                    <option value="">From the order…</option>
                    {tankers.map((t) => (
                      <option key={t.id} value={t.id}>{t.plate}</option>
                    ))}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="po">Order (optional)</label>
                  <input id="po" className="in" placeholder="TO-1234" value={pen.order} onChange={(e) => setPen({ ...pen, order: e.target.value })} />
                </div>
              </div>
              <div className="fld">
                <label htmlFor="pa">Amount override in OMR (optional)</label>
                <input id="pa" className="in" type="number" min="0" step="0.001" value={pen.amount} onChange={(e) => setPen({ ...pen, amount: e.target.value })} />
              </div>
            </>
          }
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => (!pen.rule ? toast("Choose a violation", true) : !pen.tanker && !pen.order.trim() ? toast("Choose a tanker or an order", true) : issuePenalty(reason))}
        />
      )}
      {dlg?.k === "schedule" && (
        <Modal title="Schedule inspection" onClose={() => setDlg(null)}>
          <p>Books a field inspection for today. Record the result from the Inspections list.</p>
          <ScheduleForm
            tankers={tankers}
            permits={rows ?? []}
            value={sched}
            onChange={setSched}
            onCancel={() => setDlg(null)}
            onSubmit={(notes) =>
              rpc("staff_record_inspection", { p_tanker_id: sched.tanker, p_permit_id: sched.permit || null, p_result: "scheduled", p_notes: notes, p_checklist: {} }, "Inspection scheduled")
            }
          />
        </Modal>
      )}
    </>
  );
}

function DocRow({ d, today, canReview, onApprove, onReject }: { d: Doc; today: string; canReview: boolean; onApprove: () => void; onReject: () => void }) {
  const url = useSignedUrl(d.file_path);
  const expired = d.status === "valid" && d.valid_to < today;
  const [text, tone] = d.status === "pending_review" ? ["Pending review", "warn"] : d.status === "rejected" ? ["Rejected", "bad"] : expired ? ["Expired", "bad"] : ["Verified", "ok"];
  return (
    <div className="pv-r">
      <span>
        <b>{DOC_LABEL[d.kind] ?? d.kind}</b>
        <small>
          {d.ref_no || "No reference"} · valid to {fmtDate(d.valid_to)}
          {d.driver_id && !d.tanker_id ? " · driver" : ""}
          {url && (
            <>
              {" · "}
              <a className="lk" href={url} target="_blank" rel="noreferrer">View</a>
            </>
          )}
        </small>
      </span>
      <span className="btns" style={{ flexWrap: "nowrap", alignItems: "center" }}>
        <St tone={tone}>{text}</St>
        {canReview && d.status !== "valid" && <button className="btn sm" onClick={onApprove}>Approve</button>}
        {canReview && d.status !== "rejected" && <button className="btn sm" onClick={onReject}>Reject</button>}
      </span>
    </div>
  );
}

function ScheduleForm({
  tankers,
  permits,
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  tankers: TankerRef[];
  permits: PermitRow[];
  value: { tanker: string; permit: string };
  onChange: (v: { tanker: string; permit: string }) => void;
  onCancel: () => void;
  onSubmit: (notes: string) => Promise<boolean>;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const forTanker = permits.filter((p) => one(p.tanker)?.id === value.tanker);
  return (
    <>
      <div className="fld">
        <label htmlFor="st">Tanker</label>
        <select id="st" className="in" value={value.tanker} onChange={(e) => onChange({ tanker: e.target.value, permit: "" })}>
          <option value="">Choose…</option>
          {tankers.map((t) => (
            <option key={t.id} value={t.id}>{t.plate} · {t.service_type}</option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="sp">Permit (optional)</label>
        <select id="sp" className="in" value={value.permit} onChange={(e) => onChange({ ...value, permit: e.target.value })}>
          <option value="">None — routine or spot check</option>
          {forTanker.map((p) => (
            <option key={p.id} value={p.id}>{p.permit_no} · {LABEL[p.effective_status]}</option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="sn">Reason</label>
        <textarea id="sn" className="in" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Spot check after customer complaint" />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className="btn pri"
          disabled={busy || !value.tanker || notes.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            await onSubmit(notes.trim());
            setBusy(false);
          }}
        >
          {busy ? "Saving…" : "Schedule"}
        </button>
      </div>
    </>
  );
}
