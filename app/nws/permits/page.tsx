"use client";

import { VehiclePanel } from "@/components/nws/VehiclePanel";
import "../ops.css";
import "../admin.css";
import "../register.css";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { fetchPaged } from "@/components/nws/admin/ui";
import { DAY, Modal, one, St, Tabs, useNow, useRealtime, useRpc, useSignedUrl } from "@/components/nws/ops";
import { PERMITS } from "@/components/nws/i18n/permits";
import { Campaign } from "@/components/nws/register/Campaign";
import { useGeo } from "@/components/nws/register/geo";
import { RegisterPanel } from "@/components/nws/register/RegisterPanel";
import { AdoptionClaims } from "@/components/nws/register/AdoptionClaims";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { useLang, useT, type Lang } from "@/lib/i18n";
import { label, penaltyState, permitStage } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { omanDateKey, omanDayEndIso, omanDayStartIso } from "@/lib/time";
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
  info_response: string | null; info_responded_at: string | null; reminded_at: string | null;
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
  rule: { label: string; party: string } | { label: string; party: string }[] | null;
};
type Rule = { code: string; label: string; party: string; amount: string; amount_kind: string; active: boolean };
type Inspection = {
  id: string; tanker_id: string; permit_id: string | null; inspector_id: string | null; result: "scheduled" | "pass" | "fail"; notes: string; scheduled_for: string | null; created_at: string;
  tanker: { plate: string; service_type: ServiceType } | { plate: string; service_type: ServiceType }[] | null;
  permit: { permit_no: string } | { permit_no: string }[] | null;
  inspector: { full_name: string } | { full_name: string }[] | null;
};
type Company = { id: string; name: string; cr_no: string; phone: string | null; rating: number; since: string; status: "pending" | "active" | "suspended" };
type Tab = "reg" | "camp" | "apps" | "exp" | "viol" | "insp" | "co";
type Dlg =
  | { k: "reject" | "resubmit" | "info" | "pass" | "fail" | "issue" | "schedule" }
  | { k: "doc_reject"; id: string }
  | { k: "pen"; p: Penalty; decision: "uphold" | "cancel" }
  | { k: "insp"; row: Inspection; result: "pass" | "fail" }
  | { k: "co"; c: Company; action: "activate" | "suspend" }
  | null;

const TONE: Record<Status, string> = { pending: "warn", approved: "ok", rejected: "bad", expired: "bad" };
// Labels are keys of components/nws/i18n/permits.ts.
const LABEL: Record<Status, string> = { pending: "stPending", approved: "stApproved", rejected: "stRejected", expired: "stExpired" };
const STAGES = ["stepSubmitted", "stepDocuments", "stepInspection", "stepDecision", "stepIssued"];
const STAGE_IDX: Record<Stage, number> = { submitted: 0, documents: 1, inspection: 2, decision: 3 };
const NEXT_LABEL: Record<Stage, string> = { submitted: "nextSubmitted", documents: "nextDocuments", inspection: "nextInspection", decision: "nextDecision" };
const DOC_LABEL: Record<string, string> = {
  mulkiya: "docMulkiya", tank_cleanliness: "docTank", rop_inspection: "docRop", insurance: "docInsurance",
  ivms_certificate: "docIvms", heavy_licence: "docHeavy", water_test: "docWater",
};
/** A document kind in the viewer's language (unknown kinds as stored). */
const docLabel = (t: (k: string) => string, kind: string) => (DOC_LABEL[kind] ? t(DOC_LABEL[kind]) : kind);
const isoDay = (d: Date) => omanDateKey(d); // Muscat calendar date
const CHECKLIST: [keyof Checklist, string][] = [["tank_hygiene", "ckHygiene"], ["valves", "ckValves"], ["ivms_seal", "ckIvms"], ["ppe", "ckPpe"]];
type Checklist = { tank_hygiene: boolean; valves: boolean; ivms_seal: boolean; ppe: boolean };
const ALL_OK: Checklist = { tank_hygiene: true, valves: true, ivms_seal: true, ppe: true };
// Labels match permit_missing_documents (0023), so the missing ones come pre-ticked. The English
// names are what the database returns and what the request note carries; ASK_LABEL shows them translated.
const ASK_KINDS = ["Mulkiya", "Insurance", "Water test", "Tank cleanliness certificate", "ROP vehicle inspection", "IVMS installation certificate", "Driver heavy-vehicle licence"];
const ASK_LABEL: Record<string, string> = {
  Mulkiya: "askMulkiya", Insurance: "docInsurance", "Water test": "askWater", "Tank cleanliness certificate": "docTank",
  "ROP vehicle inspection": "docRop", "IVMS installation certificate": "docIvms", "Driver heavy-vehicle licence": "docHeavy",
};
const askLabel = (t: (k: string) => string, k: string) => (ASK_LABEL[k] ? t(ASK_LABEL[k]) : k);
const svc = (s: string, lang: Lang) => label("svc", s, lang);

/** The inspector ticks each item; a pass needs every item ticked. */
function ChecklistFields({ value, onChange }: { value: Checklist; onChange: (v: Checklist) => void }) {
  const t = useT(PERMITS);
  return (
    <fieldset className="fld" style={{ border: 0, padding: 0, margin: "0 0 10px" }}>
      <legend style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>{t("checklist")}</legend>
      {CHECKLIST.map(([k, l]) => (
        <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, padding: "2px 0" }}>
          <input type="checkbox" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} /> {t(l)}
        </label>
      ))}
    </fieldset>
  );
}


function Permits() {
  const { can, toast, staff } = useStaff();
  const t = useT(PERMITS);
  const f = useFmt();
  const { lang } = useLang();
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
    return t === "reg" || t === "camp" || t === "exp" || t === "viol" || t === "insp" || t === "co" ? t : "apps";
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
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [askKinds, setAskKinds] = useState<string[]>([]);
  const [missingDocs, setMissingDocs] = useState<string[] | null>(null);
  const [checklist, setChecklist] = useState<Checklist>(ALL_OK);
  const [kind, setKind] = useState<"all" | "renewal" | "new">("all");
  const [appQ, setAppQ] = useState("");
  const [regTotal, setRegTotal] = useState<number | null>(null);
  const geo = useGeo();
  const [creating, setCreating] = useState(false);
  const [newExpiry, setNewExpiry] = useState("");
  const [form, setForm] = useState(() => ({ tanker: "", permit_no: "", type: "DW" as ServiceType, issued: isoDay(new Date()), expires: isoDay(new Date(Date.now() + 365 * DAY)) }));
  const [pen, setPen] = useState({ rule: "", tanker: "", order: "", amount: "" });
  const [sched, setSched] = useState({ tanker: "", permit: "" });

  const load = useCallback(async () => {
    const db = supabase();
    // Permits page through PostgREST's 1,000-row limit (register imports add ~900 applications).
    // Only tankers on the platform are listed for the forms; the register (~11,000) is paged
    // in the database (Register tab).
    const [p, t, pe, r, i, c, rc] = await Promise.all([
      fetchPaged<PermitRow>((a, b) =>
        db
          .from("permits")
          .select(
            "id, permit_no, type, issued_at, expires_at, status, effective_status, stage, info_requested, info_response, info_responded_at, reminded_at, reviewed_at, reason, created_at, applied_by, tanker:tankers(id, plate, service_type, capacity_gal, company:companies(name)), reviewer:profiles!permits_reviewed_by_fkey(full_name)",
          )
          .order("created_at", { ascending: false })
          .order("id")
          .range(a, b), 20000),
      db.from("tankers").select("id, plate, service_type, capacity_gal, company_id, company:companies(name)").eq("on_platform", true).order("plate"),
      db
        .from("penalties")
        .select("id, penalty_no, rule_code, amount, reason, evidence, state, dispute_text, created_at, tanker:tankers(plate), company:companies(name), order:orders(order_no), rule:penalty_rules(label, party)")
        .order("created_at", { ascending: false })
        .limit(300),
      db.from("penalty_rules").select("code, label, party, amount, amount_kind, active").order("code"),
      db
        .from("inspections")
        .select("id, tanker_id, permit_id, inspector_id, result, notes, scheduled_for, created_at, tanker:tankers(plate, service_type), permit:permits(permit_no), inspector:profiles(full_name)")
        .order("created_at", { ascending: false })
        .limit(200),
      db.from("companies").select("id, name, cr_no, phone, rating, since, status, created_at").order("name"),
      db.from("tankers").select("id", { count: "exact", head: true }).or("on_platform.eq.true,in_register.eq.true"),
    ]);
    const list = p.rows;
    setRegTotal(rc.count ?? null);
    setRows(list);
    setTankers((t.data ?? []) as unknown as (TankerRef & { company_id: string | null })[]);
    // Tanker enforcement only: customer and business penalties (late cancel, overdue) live elsewhere.
    setPenalties(((pe.data ?? []) as unknown as Penalty[]).filter((x) => (one(x.rule)?.party ?? "driver") === "driver"));
    setLoadErr(p.error ? friendlyError(p.error, lang) : null);
    setRules((r.data ?? []) as Rule[]);
    setInspections((i.data ?? []) as unknown as Inspection[]);
    setCompanies((c.data ?? []) as Company[]);
    // Deep link from Fleet: open that tanker's latest permit.
    const tk = params.get("tanker");
    setSel((s) => s ?? (tk ? (list.find((x) => one(x.tanker)?.id === tk)?.id ?? null) : (list.find((x) => x.status === "pending")?.id ?? null)));
    if (tk) setAppFilter((f) => (list.find((x) => one(x.tanker)?.id === tk && x.status !== "pending") ? "all" : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the error text follows the language on the next load
  }, [params]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  useRealtime("nws-permits", ["permits", "inspections", "tanker_documents"], load, 1500);

  const selected = rows?.find((p) => p.id === sel) ?? null;
  const selTanker = one(selected?.tanker);

  // Documents (tanker and its driver), automatic checks and audit history for the selected permit.
  const loadDetail = useCallback(async () => {
    if (!sel) return;
    const db = supabase();
    const tid = rows?.find((p) => p.id === sel) ? one(rows.find((p) => p.id === sel)!.tanker)?.id : null;
    const drv = tid ? (await db.from("tanker_assignments").select("driver_id").eq("tanker_id", tid).is("unassigned_at", null).maybeSingle()).data?.driver_id : null;
    const [d, c, a, m] = await Promise.all([
      tid
        ? db
            .from("tanker_documents")
            .select("id, tanker_id, driver_id, kind, ref_no, valid_to, file_path, status, uploaded_at")
            .or(drv ? `tanker_id.eq.${tid},driver_id.eq.${drv}` : `tanker_id.eq.${tid}`)
            .order("kind")
        : Promise.resolve({ data: [] }),
      db.rpc("permit_auto_checks", { p_permit_id: sel }),
      db.from("audit_log").select("id, at, action, actor_email, reason").eq("target_type", "permit").eq("target_id", sel).order("at"),
      db.rpc("permit_missing_documents", { p_permit_id: sel }),
    ]);
    setMissingDocs(Array.isArray(m.data) ? (m.data as string[]) : null);
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
  // A renewal is an application for a tanker that already had an approved permit.
  // Earliest approved permit per tanker, so each check is O(1) (the list can hold thousands of permits).
  const firstApproved = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of rows ?? []) {
      const tid = one(x.tanker)?.id;
      if (tid && x.status === "approved" && (!m.has(tid) || x.created_at < m.get(tid)!)) m.set(tid, x.created_at);
    }
    return m;
  }, [rows]);
  const isRenewal = useCallback(
    (p: PermitRow) => {
      const first = firstApproved.get(one(p.tanker)?.id ?? "");
      return !!first && first < p.created_at;
    },
    [firstApproved],
  );
  const apps = useMemo(
    () =>
      (rows ?? [])
        .filter((p) => (appFilter === "pending" ? p.status === "pending" : appFilter === "all" ? true : p.effective_status === appFilter))
        .filter((p) => kind === "all" || (kind === "renewal") === isRenewal(p))
        .filter((p) => !appQ.trim() || p.permit_no.toLowerCase().includes(appQ.trim().toLowerCase()) || (one(p.tanker)?.plate ?? "").toLowerCase().includes(appQ.trim().toLowerCase())),
    [rows, appFilter, kind, isRenewal, appQ],
  );
  const pending = (rows ?? []).filter((p) => p.status === "pending");
  // Latest approved permit per tanker only (a renewed tanker drops off), with any renewal in review.
  const latestApproved = new Map<string, PermitRow>();
  for (const p of rows ?? []) {
    const tid = one(p.tanker)?.id;
    if (tid && p.status === "approved" && (!latestApproved.has(tid) || latestApproved.get(tid)!.expires_at < p.expires_at)) latestApproved.set(tid, p);
  }
  const renewalPending = (p: PermitRow) => pending.some((x) => one(x.tanker)?.id === one(p.tanker)?.id);
  const expiring = [...latestApproved.values()]
    .filter((p) => daysLeft(p.expires_at) <= 60 && daysLeft(p.expires_at) > -30)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  const openPen = penalties.filter((p) => p.state === "issued" || p.state === "disputed");
  const penList = penalties.filter((p) => (penFilter === "open" ? p.state === "issued" || p.state === "disputed" : penFilter === "all" ? true : p.state === penFilter));
  const tankerCount = (companyName: string) => tankers.filter((t) => one(t.company)?.name === companyName).length;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const ok = await rpc(
      "staff_create_permit",
      { p_tanker_id: form.tanker, p_permit_no: form.permit_no, p_type: form.type, p_issued_at: omanDayStartIso(form.issued), p_expires_at: omanDayEndIso(form.expires) },
      t("permitCreated"),
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
      if (!data) return toast(t("orderNotFound", { no: pen.order }), true);
      orderId = data.id;
    }
    await rpc(
      "staff_issue_penalty",
      { p_rule: pen.rule, p_tanker_id: pen.tanker || null, p_order_id: orderId, p_reason: reason, p_amount: pen.amount ? Number(pen.amount) : null },
      t("penIssuedNotified"),
    );
  }

  // Applications move one stage at a time (submitted → documents → inspection → decision) and are
  // approved only at the decision stage after a passed inspection; the database enforces the same.
  const passedInspection = (p: PermitRow) => {
    const tankerId = one(p.tanker)?.id;
    return inspections.some((i) => i.tanker_id === tankerId && i.result === "pass" && (i.permit_id === p.id || i.created_at >= p.created_at));
  };
  const approvable = (p: PermitRow) => p.stage === "decision" && (!p.applied_by || passedInspection(p));
  // Separation of duties (0023): whoever recorded the passed inspection can't also approve.
  const ownPass = (p: PermitRow) =>
    !!p.applied_by && inspections.some((i) => i.tanker_id === one(p.tanker)?.id && i.result === "pass" && (i.permit_id === p.id || i.created_at >= p.created_at) && i.inspector_id === staff.id);

  async function advance(p: PermitRow) {
    const next: Record<Stage, string | null> = { submitted: "documents", documents: "inspection", inspection: "decision", decision: null };
    if (p.stage === "inspection" && !passedInspection(p)) {
      setChecklist(ALL_OK);
      return setDlg({ k: "pass" });
    }
    if (p.stage === "inspection") {
      if (!(await rpc("staff_permit_stage", { p_permit_id: p.id, p_stage: "decision", p_note: null }, t("readyDecision", { no: p.permit_no })))) await load();
      return;
    }
    const ok =
      p.stage === "decision"
        ? await rpc("staff_review_permit", { p_permit_id: p.id, p_decision: "approve", p_reason: null }, t("approvedIssued", { no: p.permit_no }))
        : await rpc("staff_permit_stage", { p_permit_id: p.id, p_stage: next[p.stage], p_note: null }, t("loggedStep", { no: p.permit_no, step: lang === "ar" ? t(NEXT_LABEL[p.stage]) : t(NEXT_LABEL[p.stage]).toLowerCase() }));
    if (!ok) await load(); // e.g. permit_review_incomplete: show where the application really is
  }

  const permInsp = selected ? inspections.filter((i) => i.permit_id === selected.id) : [];
  const lastInsp = permInsp[0] ?? null;
  const booked = selected ? (inspections.find((i) => i.result === "scheduled" && i.tanker_id === one(selected.tanker)?.id) ?? null) : null;
  const docsBlocked = selected?.stage === "documents" && (missingDocs?.length ?? 0) > 0;
  const stageIdx = selected ? (selected.status === "approved" ? 5 : STAGE_IDX[selected.stage] ?? 0) : 0;
  const offTitle = officer ? undefined : t("officersOnly");

  return (
    <>
      <div className="vhead">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("lead")}</p>
        </div>
        {tab === "apps" && (
          <button className="btn pri" disabled={!officer} title={offTitle} onClick={() => setCreating((c) => !c)}>
            {creating ? t("close") : t("newPermit")}
          </button>
        )}
        {tab === "viol" && (
          <button className="btn pri" disabled={!canIssue} title={canIssue ? undefined : t("issueRoles")} onClick={() => { setPen({ rule: rules.find((r) => r.active && r.party === "driver")?.code ?? "", tanker: "", order: "", amount: "" }); setDlg({ k: "issue" }); }}>
            {t("issuePenalty")}
          </button>
        )}
        {tab === "insp" && (
          <button className="btn pri" disabled={!canInspect} title={canInspect ? undefined : t("inspectRoles")} onClick={() => { setSched({ tanker: "", permit: "" }); setDlg({ k: "schedule" }); }}>
            {t("scheduleInspection")}
          </button>
        )}
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ["reg", t("tabReg"), regTotal ?? undefined],
          ["camp", t("tabCamp")],
          ["apps", t("tabApps"), pending.length],
          ["exp", t("tabExp"), expiring.length],
          ["viol", t("tabViol"), openPen.length],
          ["insp", t("tabInsp"), inspections.filter((i) => i.result === "scheduled").length],
          ["co", t("tabCo"), companies.length],
        ]}
      />

      {tab === "apps" && (
        <>
          {creating && officer && (
            <form className="panel" onSubmit={create}>
              <h2>{t("newPermit")} <small>{t("newPermitSub")}</small></h2>
              <div className="pad" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, alignItems: "end" }}>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="pt">{t("tanker")}</label>
                  <select id="pt" className="in" required value={form.tanker} onChange={(e) => setForm({ ...form, tanker: e.target.value, type: tankers.find((x) => x.id === e.target.value)?.service_type ?? form.type })}>
                    <option value="">{t("choose")}</option>
                    {tankers.map((x) => (
                      <option key={x.id} value={x.id}>{x.plate} · {x.service_type}</option>
                    ))}
                  </select>
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="pn">{t("permitNo")}</label>
                  <input id="pn" className="in" dir="ltr" required minLength={3} maxLength={40} value={form.permit_no} onChange={(e) => setForm({ ...form, permit_no: e.target.value })} placeholder="NWS-DW-2026-0481" />
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="ty">{t("type")}</label>
                  <select id="ty" className="in" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ServiceType })}>
                    <option value="DW">{t("typeDW")}</option>
                    <option value="WW">{t("typeWW")}</option>
                    <option value="TE">{t("typeTE")}</option>
                  </select>
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="is">{t("issued")}</label>
                  <input id="is" className="in" type="date" required value={form.issued} onChange={(e) => setForm({ ...form, issued: e.target.value })} />
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor="ex">{t("expires")}</label>
                  <input id="ex" className="in" type="date" required value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
                </div>
                <button className="btn pri">{t("create")}</button>
              </div>
            </form>
          )}

          <div className="pv">
            <div className="plist">
              <div className="chips">
                {(
                  [
                    ["pending", "fNeeds"],
                    ["approved", "stApproved"],
                    ["rejected", "stRejected"],
                    ["expired", "stExpired"],
                    ["all", "fAllPermits"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} className={`chip ${appFilter === k ? "on" : ""}`} onClick={() => setAppFilter(k)}>
                    {t(l)}
                  </button>
                ))}
              </div>
              <div className="chips">
                {(
                  [
                    ["all", "fAllKinds"],
                    ["renewal", "fRenewals"],
                    ["new", "fNew"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                    {t(l)}
                  </button>
                ))}
              </div>
              <input className="in" placeholder={t("searchPh")} aria-label={t("searchAria")} value={appQ} onChange={(e) => setAppQ(e.target.value)} style={{ margin: "0 0 8px" }} />
              {!rows && <div className="empty">{t("loading")}</div>}
              {loadErr && <div className="banner badb">{t("loadErr", { e: loadErr })}</div>}
              {rows && !loadErr && params.get("tanker") && !rows.some((x) => one(x.tanker)?.id === params.get("tanker")) && (
                <div className="banner">{t("noPermitTanker")}</div>
              )}
              {rows && !loadErr && apps.length === 0 && <div className="empty">{appFilter === "pending" ? t("noApps") : t("noPermits")}</div>}
              {apps.map((p) => {
                const tk = one(p.tanker);
                return (
                  <button key={p.id} className={`pcard ${sel === p.id ? "sel" : ""}`} onClick={() => setSel(p.id)}>
                    <span className="row">
                      <b dir="ltr">{p.permit_no}</b>
                      <small className="mut">{f.date(p.created_at)}</small>
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>{one(tk?.company)?.name ?? t("independent")}</span>
                    <span className="row">
                      <span>
                        <span className={`tag ${p.type}`}>{svc(p.type, lang)}</span> <small className="mut">{isRenewal(p) ? t("renewal") : t("newPermit")} · <bdi dir="ltr">{tk?.plate ?? "—"}</bdi></small>
                      </span>
                      {p.status === "pending" ? (
                        <St tone={p.info_requested ? "warn" : "act"}>{p.info_requested ? t("infoRequested") : p.info_response ? t("ownerReplied") : permitStage(p.stage, lang)}</St>
                      ) : (
                        <St tone={TONE[p.effective_status]}>{t(LABEL[p.effective_status])}</St>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="panel pv-d">
              {!selected ? (
                <div className="empty">{t("selectApp")}</div>
              ) : (
                <>
                  <div className="pv-h">
                    <div>
                      <div className="ttl">
                        <h2 dir="ltr">{selected.permit_no}</h2>
                        {selected.status === "pending" ? (
                          <St tone={selected.info_requested ? "warn" : "act"}>{selected.info_requested ? t("infoRequested") : selected.info_response ? t("ownerReplied") : permitStage(selected.stage, lang)}</St>
                        ) : (
                          <St tone={TONE[selected.effective_status]}>{t(LABEL[selected.effective_status])}</St>
                        )}
                      </div>
                      <p>
                        {isRenewal(selected) ? t("renewal") : t("newPermit")} · <bdi dir="ltr">{selTanker?.plate ?? "—"}</bdi> · {svc(selected.type, lang)} · {selTanker ? f.gal(selTanker.capacity_gal) : "—"}
                      </p>
                      <p style={{ color: "var(--ink)", fontWeight: 600 }}>{one(selTanker?.company)?.name ?? t("independent")}</p>
                    </div>
                    <small>
                      {t("submittedAt", { d: f.dateTime(selected.created_at) })}
                      <br />
                      {selected.applied_by ? t("online") : t("byNws")}
                      <br />
                      {selected.status === "approved" || !selected.applied_by ? t("validRange", { from: f.date(selected.issued_at), to: f.date(selected.expires_at) }) : t("valid12")}
                    </small>
                  </div>

                  <div className="stp">
                    {STAGES.map((s, k) => (
                      <Fragment key={s}>
                        <div className={`sx ${k < stageIdx ? "done" : k === stageIdx && selected.status === "pending" ? "cur" : ""}`}>
                          <i>{k < stageIdx ? "✓" : f.n(k + 1)}</i>
                          <span>{t(s)}</span>
                        </div>
                        {k < STAGES.length - 1 && <b className={k < stageIdx ? "done" : ""} />}
                      </Fragment>
                    ))}
                  </div>

                  {selected.info_requested && selected.status === "pending" && <div className="banner">{t("waitingOwner", { what: selected.info_requested })}</div>}
                  {!selected.info_requested && selected.info_response && selected.status === "pending" && (
                    <div className="banner info">
                      <b>{t("ownerRepliedAt", { d: f.dateTime(selected.info_responded_at) })}</b> {selected.info_response}
                    </div>
                  )}
                  {selTanker && selected.type !== selTanker.service_type && <div className="banner badb">{t("typeMismatch", { p: svc(selected.type, lang), t: svc(selTanker.service_type, lang) })}</div>}
                  {selected.status === "approved" && daysLeft(selected.expires_at) <= 30 && (
                    <div className="banner">{daysLeft(selected.expires_at) < 0 ? t("expiredAgo", { n: f.n(-daysLeft(selected.expires_at)) }) : t("expiresIn", { n: f.n(daysLeft(selected.expires_at)) })} {t("noOnline")}</div>
                  )}

                  <div className="pv-two">
                    <div className="pv-box">
                      <h3>{t("documents")}</h3>
                      {docs.length === 0 && <div className="pv-r"><small>{t("noDocs")}</small></div>}
                      {missingDocs?.map((m) => (
                        <div key={m} className="pv-r">
                          <span>
                            <b>{askLabel(t, m)}</b>
                            <small>{t("requiredMissing")}</small>
                          </span>
                          <St tone="warn">{t("missing")}</St>
                        </div>
                      ))}
                      {docs.map((d) => (
                        <DocRow
                          key={d.id}
                          d={d}
                          today={isoDay(new Date(now))}
                          canReview={canDoc}
                          onApprove={() => rpc("staff_review_document", { p_document_id: d.id, p_approve: true, p_reason: null }, t("docApproved", { doc: docLabel(t, d.kind) }))}
                          onReject={() => setDlg({ k: "doc_reject", id: d.id })}
                        />
                      ))}
                    </div>
                    <div className="pv-box">
                      <h3>{t("autoChecks")}</h3>
                      {!checks && <div className="pv-r"><small>{t("runningChecks")}</small></div>}
                      {checks?.map((c) => (
                        <div key={c.check} className="pv-r">
                          <span>
                            <b>{PERMITS[`ac:${c.check}`] ? t(`ac:${c.check}`) : c.check}</b>
                            <small>{PERMITS[`ac:${c.detail}`] ? t(`ac:${c.detail}`) : /^\d+ upheld or open$/.test(c.detail) ? t("ac:upheld", { n: parseInt(c.detail, 10) }) : c.detail}</small>
                          </span>
                          <St tone={c.ok ? "ok" : "bad"}>{c.ok ? t("pass") : t("check")}</St>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selected.status === "approved" ? (
                    <div className="pv-ins ok"><div><b>{t("permitIssued")}</b><small>{t("issuedInfo", { d: f.date(selected.expires_at), at: f.dateTime(selected.reviewed_at), who: one(selected.reviewer)?.full_name ?? "—" })}</small></div><St tone="ok">{t("stepIssued")}</St></div>
                  ) : selected.status === "rejected" ? (
                    <div className="pv-ins bad"><div><b>{t("appRejected")}</b><small>{selected.reason ?? t("noReason")} · {t("canResubmit")}</small></div><St tone="bad">{t("stRejected")}</St></div>
                  ) : lastInsp && lastInsp.result !== "scheduled" ? (
                    <div className={`pv-ins ${lastInsp.result === "pass" ? "ok" : "bad"}`}>
                      <div><b>{lastInsp.result === "pass" ? t("inspPassed") : t("inspFailed")}</b><small>{f.dateTime(lastInsp.created_at)} · {one(lastInsp.inspector)?.full_name ?? t("inspector")} · {lastInsp.notes || t("noNotes")}</small></div>
                      <St tone={lastInsp.result === "pass" ? "ok" : "bad"}>{lastInsp.result === "pass" ? t("passed") : t("failed")}</St>
                    </div>
                  ) : selected.stage === "inspection" && booked ? (
                    <div className="pv-ins">
                      <div>
                        <b>{booked.scheduled_for ? t("fieldInspOn", { d: f.date(booked.scheduled_for) }) : t("fieldInspBooked")}</b>
                        <small>{one(booked.inspector)?.full_name ?? t("inspToAssign")} · {t("checklistItems")}</small>
                      </div>
                      <St tone="act">{t("scheduled")}</St>
                    </div>
                  ) : selected.stage === "inspection" ? (
                    <div className="pv-ins"><div><b>{t("fieldInsp")}</b><small>{t("noBooked")}</small></div><St tone="warn">{t("notBooked")}</St></div>
                  ) : (
                    <div className="pv-ins"><div><b>{t("fieldInsp")}</b><small>{t("autoBooked")}</small></div><St>{t("pending")}</St></div>
                  )}

                  {selected.status === "pending" && (
                    <div className="pv-act">
                      <small>
                        {docsBlocked
                          ? t("hintMissing", { docs: missingDocs!.map((m) => askLabel(t, m)).join(lang === "ar" ? "، " : ", ") })
                          : selected.stage === "decision" && !approvable(selected)
                          ? t("hintNoPass")
                          : selected.stage === "decision"
                          ? t("hintDecision")
                          : selected.stage === "inspection"
                            ? t("hintInspection")
                            : t("hintLogged")}
                      </small>
                      <div className="btns">
                        <button className="btn bad" disabled={!officer} title={offTitle} onClick={() => setDlg({ k: "reject" })}>{t("reject")}</button>
                        <button className="btn" disabled={!officer} title={offTitle} onClick={() => { setAskKinds(missingDocs ?? []); setDlg({ k: "info" }); }}>{t("requestDocs")}</button>
                        {selected.stage === "inspection" && (
                          <button className="btn" disabled={!canInspect} onClick={() => { setChecklist(ALL_OK); setDlg({ k: "fail" }); }}>{t("recordFailed")}</button>
                        )}
                        <button
                          className="btn pri"
                          disabled={selected.stage === "inspection" ? !canInspect : !officer || docsBlocked || (selected.stage === "decision" && (!approvable(selected) || ownPass(selected)))}
                          title={
                            selected.stage === "inspection"
                              ? canInspect
                                ? undefined
                                : t("inspectRoles")
                              : selected.stage === "decision" && !approvable(selected)
                                ? t("needsPass")
                                : selected.stage === "decision" && ownPass(selected)
                                  ? t("ownPass")
                                : docsBlocked
                                  ? t("docsMissingT")
                                  : offTitle
                          }
                          onClick={() => advance(selected)}
                        >
                          {selected.stage === "inspection" && passedInspection(selected) ? t("moveDecision") : t(NEXT_LABEL[selected.stage])}
                        </button>
                      </div>
                    </div>
                  )}
                  {selected.status === "rejected" && (
                    <div className="pv-act">
                      <small>{t("backToReview")}</small>
                      <button className="btn" disabled={!officer} title={offTitle} onClick={() => { setNewExpiry(""); setDlg({ k: "resubmit" }); }}>{t("resubmitDots")}</button>
                    </div>
                  )}

                  <div>
                    <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>{t("history")} <small className="mut" style={{ fontWeight: 400 }}>{t("fromAudit")}</small></h3>
                    <ul className="tl" style={{ padding: "4px 0 0" }}>
                      {audit.length === 0 && <li>{t("noActions")}</li>}
                      {audit.map((a) => (
                        <li key={a.id} className={a.action === "permit.reject" ? "bad" : "done"}>
                          {t("actionBy", { action: a.action, who: a.actor_email ?? t("staff") })}
                          {a.reason ? ` — ${a.reason}` : ""}
                          <small>{f.dateTime(a.at)}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {selTanker?.id && <VehiclePanel tankerId={selTanker.id} />}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "reg" && <AdoptionClaims />}
      {tab === "reg" && (
        <RegisterPanel
          geo={geo}
          canImport={officer}
          onTotal={setRegTotal}
          onOpen={(id) => {
            setSel(id);
            setAppFilter("all");
            setAppQ("");
            setTab("apps");
          }}
        />
      )}

      {tab === "camp" && <Campaign geo={geo} />}

      {tab === "exp" && (
        <div className="panel">
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>{t("thPermit")}</th><th>{t("tanker")}</th><th>{t("type")}</th><th>{t("thOwner")}</th><th>{t("expires")}</th><th>{t("thDaysLeft")}</th><th></th></tr>
              </thead>
              <tbody>
                {expiring.length === 0 && <tr><td colSpan={7} className="empty">{t("noExpiring")}</td></tr>}
                {expiring.map((p) => {
                  const tk = one(p.tanker);
                  const dl = daysLeft(p.expires_at);
                  return (
                    <tr key={p.id}>
                      <td><b dir="ltr">{p.permit_no}</b></td>
                      <td dir="ltr">{tk?.plate ?? "—"}</td>
                      <td><span className={`tag ${p.type}`}>{svc(p.type, lang)}</span></td>
                      <td>{one(tk?.company)?.name ?? t("independentShort")}</td>
                      <td>{f.date(p.expires_at)}</td>
                      <td><St tone={dl < 0 ? "bad" : dl < 10 ? "warn" : "ok"}>{dl < 0 ? t("expiredDAgo", { n: f.n(-dl) }) : t("nDays", { n: f.n(dl) })}</St></td>
                      <td>
                        {renewalPending(p) && <St tone="act">{t("renewalReview")}</St>}{" "}
                        {p.reminded_at && now - Date.parse(p.reminded_at) < 3 * DAY ? (
                          <St tone="ok">{t("reminderSentAt", { d: f.date(p.reminded_at) })}</St>
                        ) : (
                          <button className="btn sm" disabled={!officer} title={offTitle} onClick={() => rpc("staff_permit_remind", { p_permit_id: p.id }, t("reminderSent", { plate: tk?.plate ?? t("theTanker") }))}>
                            {t("sendReminder")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">{t("expNote")}</p>
        </div>
      )}

      {tab === "viol" && (
        <div className="panel">
          <div className="toolbar">
            <div className="chips">
              {(
                [
                  ["open", "fOpen"],
                  ["upheld", "fUpheld"],
                  ["cancelled", "fCancelled"],
                  ["all", "all"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`chip ${penFilter === k ? "on" : ""}`} onClick={() => setPenFilter(k)}>
                  {t(l)}
                </button>
              ))}
            </div>
            <span className="mut" style={{ fontSize: 12.5 }}>{t("violNote")}</span>
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>{t("thCase")}</th><th>{t("thViolation")}</th><th>{t("tanker")}</th><th>{t("thOwner")}</th><th>{t("thEvidence")}</th><th className="num">{t("thFine")}</th><th>{t("status")}</th><th></th></tr>
              </thead>
              <tbody>
                {penList.length === 0 && <tr><td colSpan={8} className="empty">{t("noViolations")}</td></tr>}
                {penList.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b dir="ltr">V-{p.penalty_no}</b>
                      <small style={{ display: "block" }}>{f.dateTime(p.created_at)}</small>
                    </td>
                    <td>
                      {one(p.rule)?.label ?? p.rule_code}
                      <small style={{ display: "block" }}>{p.reason}</small>
                    </td>
                    <td>
                      <bdi dir="ltr">{one(p.tanker)?.plate ?? "—"}</bdi>
                      {one(p.order) && <small style={{ display: "block" }} dir="ltr">TO-{one(p.order)!.order_no}</small>}
                    </td>
                    <td>{one(p.company)?.name ?? "—"}</td>
                    <td>
                      <small>{p.evidence || "—"}</small>
                      {p.dispute_text && <small style={{ display: "block", color: "var(--warn)" }}>{t("dispute", { text: p.dispute_text })}</small>}
                    </td>
                    <td className="num">{f.n3(p.amount)}</td>
                    <td><St tone={penaltyState(p.state, lang)[1]}>{penaltyState(p.state, lang)[0]}</St></td>
                    <td>
                      {(p.state === "issued" || p.state === "disputed") && (
                        <div className="btns" style={{ flexWrap: "nowrap" }}>
                          <button className="btn sm" disabled={!canDecide} title={canDecide ? undefined : t("decideRoles")} onClick={() => setDlg({ k: "pen", p, decision: "uphold" })}>{t("uphold")}</button>
                          <button className="btn sm" disabled={!canDecide} title={canDecide ? undefined : t("decideRoles")} onClick={() => setDlg({ k: "pen", p, decision: "cancel" })}>{t("cancel")}</button>
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
                <tr><th>{t("tanker")}</th><th>{t("thPermit")}</th><th>{t("thReasonNotes")}</th><th>{t("thInspector")}</th><th>{t("date")}</th><th>{t("thResult")}</th></tr>
              </thead>
              <tbody>
                {inspections.length === 0 && <tr><td colSpan={6} className="empty">{t("noInspections")}</td></tr>}
                {inspections.map((i) => {
                  const tk = one(i.tanker);
                  // A pass moves its application to the decision stage, so it must already be at the inspection stage.
                  const app = i.permit_id ? rows?.find((p) => p.id === i.permit_id) : undefined;
                  const early = app?.status === "pending" && (app.stage === "submitted" || app.stage === "documents");
                  return (
                    <tr key={i.id}>
                      <td><bdi dir="ltr">{tk?.plate ?? "—"}</bdi> {tk && <span className={`tag ${tk.service_type}`}>{tk.service_type}</span>}</td>
                      <td dir="ltr">{one(i.permit)?.permit_no ?? "—"}</td>
                      <td><small>{i.notes || "—"}</small></td>
                      <td>{one(i.inspector)?.full_name ?? <span className="mut">{t("unassigned")}</span>}</td>
                      <td>{f.date(i.scheduled_for ?? i.created_at)}</td>
                      <td>
                        {i.result === "scheduled" ? (
                          <div className="btns" style={{ flexWrap: "nowrap" }}>
                            <St tone="act">{t("scheduled")}</St>
                            <button
                              className="btn sm"
                              disabled={!canInspect || early}
                              title={early ? t("docCheckFirst") : canInspect ? undefined : t("inspectRoles")}
                              onClick={() => { setChecklist(ALL_OK); setDlg({ k: "insp", row: i, result: "pass" }); }}
                            >
                              {t("pass")}
                            </button>
                            <button className="btn sm bad" disabled={!canInspect} title={canInspect ? undefined : t("inspectRoles")} onClick={() => { setChecklist(ALL_OK); setDlg({ k: "insp", row: i, result: "fail" }); }}>{t("fail")}</button>
                          </div>
                        ) : (
                          <St tone={i.result === "pass" ? "ok" : "bad"}>{i.result === "pass" ? t("pass") : t("fail")}</St>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">{t("inspNote")}</p>
        </div>
      )}

      {tab === "co" && (
        <div className="panel">
          <h2>{t("companiesT")} <small>{t("companiesSub")}</small></h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>{t("company")}</th><th>{t("thCr")}</th><th>{t("phone")}</th><th className="num">{t("thRating")}</th><th>{t("thSince")}</th><th className="num">{t("tankers")}</th><th>{t("status")}</th><th></th></tr>
              </thead>
              <tbody>
                {companies.length === 0 && <tr><td colSpan={8} className="empty">{t("noCompanies")}</td></tr>}
                {companies.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.name}</b></td>
                    <td dir="ltr">{c.cr_no}</td>
                    <td dir="ltr">{c.phone ?? "—"}</td>
                    <td className="num">{f.n(Number(c.rating), 1)} ★</td>
                    <td>{f.date(c.since)}</td>
                    <td className="num">{f.n(tankerCount(c.name))}</td>
                    <td><St tone={c.status === "active" ? "ok" : c.status === "pending" ? "warn" : "bad"}>{c.status === "active" ? t("coActive") : c.status === "pending" ? t("coPending") : t("coSuspended")}</St></td>
                    <td>
                      {c.status === "active" ? (
                        <button className="btn sm bad" disabled={!canCompany} title={canCompany ? undefined : t("companyRoles")} onClick={() => setDlg({ k: "co", c, action: "suspend" })}>{t("suspend")}</button>
                      ) : (
                        <button className="btn sm" disabled={!canCompany} title={canCompany ? undefined : t("companyRoles")} onClick={() => setDlg({ k: "co", c, action: "activate" })}>{t("activate")}</button>
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
          title={t("rejectT", { no: selected.permit_no })}
          body={t("rejectBody")}
          confirm={t("reject")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => void (await rpc("staff_review_permit", { p_permit_id: selected.id, p_decision: "reject", p_reason: reason }, t("appRejectedToast")))}
        />
      )}
      {dlg?.k === "info" && selected && (
        <ReasonDialog
          title={t("requestT", { no: selected.permit_no })}
          body={t("requestBody")}
          confirm={t("sendRequest")}
          extra={
            <fieldset className="fld" style={{ border: 0, padding: 0, margin: "0 0 10px" }}>
              <legend style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>{t("docsNeeded")}</legend>
              {ASK_KINDS.map((k) => (
                <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, padding: "2px 0" }}>
                  <input type="checkbox" checked={askKinds.includes(k)} onChange={(e) => setAskKinds((a) => (e.target.checked ? [...a, k] : a.filter((x) => x !== k)))} /> {askLabel(t, k)}
                </label>
              ))}
            </fieldset>
          }
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc(
              "staff_permit_stage",
              { p_permit_id: selected.id, p_stage: "request_info", p_note: askKinds.length ? `${askKinds.join(", ")} — ${reason}` : reason },
              t("requestSent"),
            ))
          }
        />
      )}
      {(dlg?.k === "pass" || dlg?.k === "fail") && selected && selTanker && (
        <ReasonDialog
          title={t("recordInspT", { r: dlg.k === "pass" ? t("passedL") : t("failedL") })}
          body={t("recordInspBody", { plate: selTanker.plate, no: selected.permit_no })}
          extra={<ChecklistFields value={checklist} onChange={setChecklist} />}
          confirm={dlg.k === "pass" ? t("recordPass") : t("recordFail")}
          danger={dlg.k === "fail"}
          onCancel={() => setDlg(null)}
          onConfirm={async (notes) => {
            if (dlg.k === "pass" && !Object.values(checklist).every(Boolean)) return toast(t("needAllTicked"), true);
            void (await rpc(
              "staff_record_inspection",
              { p_tanker_id: selTanker.id, p_permit_id: selected.id, p_result: dlg.k, p_notes: notes, p_checklist: checklist, p_inspection_id: booked?.id ?? null },
              dlg.k === "pass" ? t("inspPassedToast") : t("inspFailedToast"),
            ));
          }}
        />
      )}
      {dlg?.k === "resubmit" && selected && (
        <ReasonDialog
          title={t("resubmitT", { no: selected.permit_no })}
          body={t("resubmitBody")}
          confirm={t("resubmit")}
          extra={
            <div className="fld">
              <label htmlFor="ne">{t("newExpiry")}</label>
              <input id="ne" className="in" type="date" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} />
            </div>
          }
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc(
              "staff_resubmit_permit",
              { p_permit_id: selected.id, p_expires_at: newExpiry ? omanDayEndIso(newExpiry) : null, p_reason: reason },
              t("resubmitted"),
            ))
          }
        />
      )}
      {dlg?.k === "doc_reject" && (
        <ReasonDialog
          title={t("rejectDocT")}
          body={t("rejectDocBody")}
          confirm={t("rejectDocT")}
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => {
            if (await rpc("staff_review_document", { p_document_id: dlg.id, p_approve: false, p_reason: reason }, t("docRejected"))) loadDetail();
          }}
        />
      )}
      {dlg?.k === "pen" && (
        <ReasonDialog
          title={t(dlg.decision === "uphold" ? "upholdT" : "cancelT", { n: dlg.p.penalty_no })}
          body={
            dlg.decision === "uphold"
              ? t("upholdBody", { rule: one(dlg.p.rule)?.label ?? dlg.p.rule_code, amt: f.omr3(dlg.p.amount) })
              : t("cancelBody", { amt: f.omr3(dlg.p.amount), co: one(dlg.p.company)?.name ?? t("theCompany") })
          }
          confirm={dlg.decision === "uphold" ? t("upholdPen") : t("cancelPen")}
          danger={dlg.decision === "cancel"}
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc("staff_decide_penalty", { p_penalty_id: dlg.p.id, p_decision: dlg.decision, p_reason: reason }, t(dlg.decision === "uphold" ? "penUpheld" : "penCancelled", { n: dlg.p.penalty_no })))
          }
        />
      )}
      {dlg?.k === "insp" && (
        <ReasonDialog
          title={t("recordResultT", { r: dlg.result === "pass" ? t("passL") : t("failL"), plate: one(dlg.row.tanker)?.plate ?? "" })}
          body={t("recordResultBody")}
          extra={<ChecklistFields value={checklist} onChange={setChecklist} />}
          confirm={dlg.result === "pass" ? t("recordPass") : t("recordFail")}
          danger={dlg.result === "fail"}
          onCancel={() => setDlg(null)}
          onConfirm={async (notes) => {
            if (dlg.result === "pass" && !Object.values(checklist).every(Boolean)) return toast(t("needAllTicked"), true);
            void (await rpc(
              "staff_record_inspection",
              { p_tanker_id: dlg.row.tanker_id, p_permit_id: dlg.row.permit_id, p_result: dlg.result, p_notes: notes, p_checklist: checklist, p_inspection_id: dlg.row.id },
              dlg.result === "pass" ? t("inspPassedShort") : t("inspFailedShort"),
            ));
          }}
        />
      )}
      {dlg?.k === "co" && (
        <ReasonDialog
          title={t(dlg.action === "activate" ? "activateT" : "suspendT", { name: dlg.c.name })}
          body={dlg.action === "activate" ? t("activateBody") : t("suspendBody")}
          confirm={dlg.action === "activate" ? t("activate") : t("suspendCo")}
          danger={dlg.action === "suspend"}
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) =>
            void (await rpc("staff_company_action", { p_company_id: dlg.c.id, p_action: dlg.action, p_reason: reason }, t(dlg.action === "activate" ? "coActivated" : "coSuspendedToast", { name: dlg.c.name })))
          }
        />
      )}
      {dlg?.k === "issue" && (
        <ReasonDialog
          title={t("issuePenalty")}
          body={t("issueBody")}
          confirm={t("issuePenalty")}
          danger
          extra={
            <>
              <div className="fld">
                <label htmlFor="pr">{t("violation")}</label>
                <select id="pr" className="in" value={pen.rule} onChange={(e) => setPen({ ...pen, rule: e.target.value })}>
                  {rules
                    .filter((r) => r.active && r.party === "driver")
                    .map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label} · {r.amount_kind === "pct" ? f.pct(Number(r.amount) / 100, 0) : f.omr3(r.amount)}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid2" style={{ gap: 12 }}>
                <div className="fld">
                  <label htmlFor="ptk">{t("tanker")}</label>
                  <select id="ptk" className="in" value={pen.tanker} onChange={(e) => setPen({ ...pen, tanker: e.target.value })}>
                    <option value="">{t("fromOrder")}</option>
                    {tankers.map((x) => (
                      <option key={x.id} value={x.id}>{x.plate}</option>
                    ))}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="po">{t("orderOpt")}</label>
                  <input id="po" className="in" dir="ltr" placeholder="TO-1234" value={pen.order} onChange={(e) => setPen({ ...pen, order: e.target.value })} />
                </div>
              </div>
              <div className="fld">
                <label htmlFor="pa">{t("amountOverride")}</label>
                <input id="pa" className="in" dir="ltr" type="number" min="0" step="0.001" value={pen.amount} onChange={(e) => setPen({ ...pen, amount: e.target.value })} />
              </div>
            </>
          }
          onCancel={() => setDlg(null)}
          onConfirm={(reason) => (!pen.rule ? toast(t("chooseViolation"), true) : !pen.tanker && !pen.order.trim() ? toast(t("chooseTankerOrder"), true) : issuePenalty(reason))}
        />
      )}
      {dlg?.k === "schedule" && (
        <Modal title={t("scheduleInspection")} onClose={() => setDlg(null)}>
          <p>{t("scheduleBody")}</p>
          <ScheduleForm
            tankers={tankers}
            permits={rows ?? []}
            value={sched}
            onChange={setSched}
            onCancel={() => setDlg(null)}
            onSubmit={(notes) =>
              rpc("staff_record_inspection", { p_tanker_id: sched.tanker, p_permit_id: sched.permit || null, p_result: "scheduled", p_notes: notes, p_checklist: {} }, t("inspScheduled"))
            }
          />
        </Modal>
      )}
    </>
  );
}

function DocRow({ d, today, canReview, onApprove, onReject }: { d: Doc; today: string; canReview: boolean; onApprove: () => void; onReject: () => void }) {
  const url = useSignedUrl(d.file_path);
  const t = useT(PERMITS);
  const f = useFmt();
  const expired = d.status === "valid" && d.valid_to < today;
  const [text, tone] = d.status === "pending_review" ? [t("dPending"), "warn"] : d.status === "rejected" ? [t("dRejected"), "bad"] : expired ? [t("dExpired"), "bad"] : [t("dVerified"), "ok"];
  return (
    <div className="pv-r">
      <span>
        <b>{docLabel(t, d.kind)}</b>
        <small>
          {d.ref_no ? <bdi dir="ltr">{d.ref_no}</bdi> : t("noRef")} · {t("validTo", { d: f.date(d.valid_to) })}
          {d.driver_id && !d.tanker_id ? t("driverDoc") : ""}
          {url && (
            <>
              {" · "}
              <a className="lk" href={url} target="_blank" rel="noreferrer">{t("view")}</a>
            </>
          )}
        </small>
      </span>
      <span className="btns" style={{ flexWrap: "nowrap", alignItems: "center" }}>
        <St tone={tone}>{text}</St>
        {canReview && d.status !== "valid" && <button className="btn sm" onClick={onApprove}>{t("approve")}</button>}
        {canReview && d.status !== "rejected" && <button className="btn sm" onClick={onReject}>{t("reject")}</button>}
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
  const t = useT(PERMITS);
  const forTanker = permits.filter((p) => one(p.tanker)?.id === value.tanker);
  return (
    <>
      <div className="fld">
        <label htmlFor="st">{t("tanker")}</label>
        <select id="st" className="in" value={value.tanker} onChange={(e) => onChange({ tanker: e.target.value, permit: "" })}>
          <option value="">{t("choose")}</option>
          {tankers.map((x) => (
            <option key={x.id} value={x.id}>{x.plate} · {x.service_type}</option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="sp">{t("permitOpt")}</label>
        <select id="sp" className="in" value={value.permit} onChange={(e) => onChange({ ...value, permit: e.target.value })}>
          <option value="">{t("routine")}</option>
          {forTanker.map((p) => (
            <option key={p.id} value={p.id}>{p.permit_no} · {t(LABEL[p.effective_status])}</option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="sn">{t("reason")}</label>
        <textarea id="sn" className="in" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("schedPh")} />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onCancel} disabled={busy}>{t("cancel")}</button>
        <button
          className="btn pri"
          disabled={busy || !value.tanker || notes.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            await onSubmit(notes.trim());
            setBusy(false);
          }}
        >
          {busy ? t("saving") : t("schedule")}
        </button>
      </div>
    </>
  );
}
