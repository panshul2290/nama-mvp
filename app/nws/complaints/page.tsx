"use client";

import { Phone, RevealButton, usePrivacy } from "@/components/nws/Privacy";
import "../ops.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { COMPLAINTS } from "@/components/nws/i18n/complaints";
import { SUPPORT } from "@/components/nws/i18n/support";
import { Bars, CHANNEL_LABEL, HOUR, Kpi, Modal, one, St, Tabs, useNow, useRealtime, useRpc, useSignedUrl } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt, type Fmt } from "@/components/portal/i18n";
import { Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { orderNo } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { label as vocab } from "@/lib/labels";
import { muscatDayStart } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";

type State = "new" | "assigned" | "escalated" | "resolved";
type Case = {
  id: string; case_no: number; order_id: string | null; customer_id: string | null; category: string; description: string; photo_path: string | null;
  channel: "app" | "call_centre" | "business"; genesys_id: string | null; state: State; owner_team: string | null; sla_hours: number; due_at: string;
  refund_amount: string; resolution: string | null; created_at: string; resolved_at: string | null;
  /** 0035/0039: high for overcharge reports and customer escalations to 1442. */
  priority?: "normal" | "high"; escalated_at?: string | null; escalated_by?: "customer" | "staff" | null;
  customer: { full_name: string; phone: string | null } | { full_name: string; phone: string | null }[] | null;
  order: { id: string; order_no: number; tanker_plate: string | null; driver_name: string | null } | { id: string; order_no: number; tanker_plate: string | null; driver_name: string | null }[] | null;
};
type Sla = { category: string; label: string; hours: number; team: string };
type Note = { id: number; body: string; internal: boolean; author_role: string; created_at: string; author: { full_name: string } | { full_name: string }[] | null };
type T = (key: string, vars?: Record<string, string | number>) => string;

const STATE_TONE: Record<State, string> = { new: "warn", assigned: "act", escalated: "bad", resolved: "ok" };
type Tab = "cases" | "quality" | "sla";

/** Words for a case: its state, channel, category (complaint_sla label in English) and owner team. */
function useWords() {
  const t = useT(COMPLAINTS);
  const f = useFmt();
  return useMemo(
    () => ({
      t,
      f,
      state: (s: State) => t(`st_${s}`),
      channel: (c: string) => vocab("channel", c, f.lang, CHANNEL_LABEL[c] ?? c),
      cat: (code: string, fallback?: string) => (COMPLAINTS[`cat_${code}`] ? t(`cat_${code}`) : (fallback ?? code.replace(/_/g, " "))),
      team: (name: string) => (COMPLAINTS[`team_${name}`] ? t(`team_${name}`) : name),
    }),
    [t, f],
  );
}

/** "5 h left" / "3 h over" against the case's due time. */
function slaText(c: Pick<Case, "state" | "due_at" | "resolved_at">, now: number, t: T, f: Fmt): { text: string; tone: string } {
  if (c.state === "resolved") {
    const ok = c.resolved_at && c.resolved_at <= c.due_at;
    return { text: ok ? t("slaMet") : t("slaMissed"), tone: ok ? "ok" : "bad" };
  }
  const left = (Date.parse(c.due_at) - now) / HOUR;
  if (left < 0) return { text: t("hOver", { n: f.n(Math.ceil(-left)) }), tone: "bad" };
  return { text: t("hLeft", { n: f.n(Math.floor(left)) }), tone: left < 4 ? "warn" : "" };
}

export default function ComplaintsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Complaints />
    </Suspense>
  );
}

function Complaints() {
  const t = useT(COMPLAINTS);
  const linked = useSearchParams().get("id");
  const [tab, setTab] = useState<Tab>("cases");
  const [cases, setCases] = useState<Case[] | null>(null);
  const [slas, setSlas] = useState<Sla[]>([]);
  const [sel, setSel] = useState<string | null>(linked);
  const [seen, setSeen] = useState(linked);
  if (linked !== seen) {
    setSeen(linked);
    setSel(linked);
    setTab("cases");
  }

  const load = useCallback(async () => {
    const db = supabase();
    const [c, s] = await Promise.all([
      db
        .from("complaints")
        .select(
          "*, customer:profiles(full_name, phone), order:orders(id, order_no, tanker_plate, driver_name)",
        )
        .order("created_at", { ascending: false })
        .limit(500),
      db.from("complaint_sla").select("*").order("hours"),
    ]);
    setCases((c.data ?? []) as unknown as Case[]);
    setSlas((s.data ?? []) as Sla[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  useRealtime("nws-complaints", ["complaints"], load);

  const open = (cases ?? []).filter((c) => c.state !== "resolved");
  return (
    <>
      <div className="vhead">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("lead")}</p>
        </div>
      </div>
      <Tabs<Tab>
        tabs={[
          ["cases", t("tabCases"), open.length],
          ["quality", t("tabQuality")],
          ["sla", t("tabSla")],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "cases" && <CasesTab cases={cases} slas={slas} sel={sel} setSel={setSel} reload={load} />}
      {tab === "quality" && <QualityTab cases={cases ?? []} slas={slas} />}
      {tab === "sla" && <SlaTab slas={slas} />}
    </>
  );
}

function CasesTab({ cases, slas, sel, setSel, reload }: { cases: Case[] | null; slas: Sla[]; sel: string | null; setSel: (id: string) => void; reload: () => Promise<void> }) {
  const { can } = useStaff();
  const w = useWords();
  const { t, f: fm } = w;
  const now = useNow(30_000);
  const [f, setF] = useState<"open" | State | "all" | "overdue">("open");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [logging, setLogging] = useState(false);
  const all = useMemo(() => cases ?? [], [cases]);
  const overdue = (c: Case) => c.state !== "resolved" && Date.parse(c.due_at) < now;
  const match = (c: Case, k: typeof f) => (k === "all" ? true : k === "open" ? c.state !== "resolved" : k === "overdue" ? overdue(c) : c.state === k);
  // Search by case number, customer name or mobile, or order number.
  const hit = (c: Case) => {
    const s = q.trim().toLowerCase().replace(/^c-|^to-/, "");
    if (!s) return true;
    const cu = one(c.customer);
    const o = one(c.order);
    return String(c.case_no).includes(s) || (cu?.full_name ?? "").toLowerCase().includes(s) || (cu?.phone ?? "").replace(/\s/g, "").includes(s.replace(/\s/g, "")) || (o ? String(o.order_no).includes(s) : false);
  };
  // Escalated by the customer (1442) first, then other high-priority open cases, then the newest.
  const rank = (c: Case) => (c.state === "escalated" && c.escalated_by === "customer" ? 0 : c.state !== "resolved" && c.priority === "high" ? 1 : 2);
  const list = all.filter((c) => match(c, f) && (!cat || c.category === cat) && hit(c)).sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
  const label = (cat: string) => w.cat(cat, slas.find((s) => s.category === cat)?.label);
  const selected = all.find((c) => c.id === sel) ?? null;
  const canLog = can("complaints_agent", "operator");
  const midnight = muscatDayStart(now).getTime(); // "today" is the Muscat day
  const today = all.filter((c) => Date.parse(c.created_at) >= midnight).length;

  return (
    <>
      <div className="okpis">
        <Kpi label={t("kOpen")} value={cases ? fm.n(all.filter((c) => c.state !== "resolved").length) : "—"} sub={t("kOpenSub", { n: fm.n(all.filter((c) => c.state === "new").length) })} tone="warn" />
        <Kpi label={t("kPast")} value={cases ? fm.n(all.filter(overdue).length) : "—"} sub={t("kPastSub")} tone={all.some(overdue) ? "bad" : "ok"} />
        <Kpi label={t("kEscalated")} value={cases ? fm.n(all.filter((c) => c.state === "escalated").length) : "—"} sub={t("kEscalatedSub")} />
        <Kpi label={t("kToday")} value={cases ? fm.n(today) : "—"} sub={t("kTodaySub", { n: fm.n(all.filter((c) => c.channel === "call_centre" && Date.parse(c.created_at) >= midnight).length) })} />
      </div>
      <div className="two">
        <div className="panel">
          <div className="toolbar">
            <div className="chips">
              {(
                [
                  ["open", "fOpen"],
                  ["new", "fNew"],
                  ["escalated", "fEscalated"],
                  ["overdue", "fOverdue"],
                  ["resolved", "fResolved"],
                  ["all", "all"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`chip ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
                  {t(l)}
                  <span className="tc">{fm.n(all.filter((c) => match(c, k)).length)}</span>
                </button>
              ))}
            </div>
            <button className="btn pri" disabled={!canLog} title={canLog ? undefined : t("onlyLog")} onClick={() => setLogging(true)}>
              {t("logCase")}
            </button>
          </div>
          <div className="toolbar">
            <div className="filters">
              <input className="in" placeholder={t("searchPh")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchAria")} style={{ width: 230 }} />
              <select className="in" value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("category")}>
                <option value="">{t("allCats")}</option>
                {slas.map((s) => (
                  <option key={s.category} value={s.category}>{w.cat(s.category, s.label)}</option>
                ))}
              </select>
            </div>
            {all.length >= 500 && <small className="mut">{t("latest500")}</small>}
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("colCase")}</th>
                  <th>{t("category")}</th>
                  <th>{t("colChannel")}</th>
                  <th>{t("status")}</th>
                  <th>{t("colSla")}</th>
                  <th>{t("order")}</th>
                </tr>
              </thead>
              <tbody>
                {!cases && <tr><td colSpan={6} className="empty">{t("loading")}</td></tr>}
                {cases && list.length === 0 && <tr><td colSpan={6} className="empty">{t("noCases")}</td></tr>}
                {list.map((c) => {
                  const s = slaText(c, now, t, fm);
                  const o = one(c.order);
                  return (
                    <tr key={c.id} className={`click ${sel === c.id ? "sel" : ""}`} onClick={() => setSel(c.id)}>
                      <td>
                        <b dir="ltr">C-{c.case_no}</b>
                        <small style={{ display: "block" }}>{one(c.customer)?.full_name || "—"}</small>
                      </td>
                      <td>{label(c.category)}</td>
                      <td>{w.channel(c.channel)}</td>
                      <td>
                        <St tone={STATE_TONE[c.state]}>{w.state(c.state)}</St>
                        <Flag c={c} />
                      </td>
                      <td>{c.state === "resolved" ? <St tone={s.tone}>{s.text}</St> : s.tone === "bad" ? <St tone="bad">{s.text}</St> : <span className={s.tone === "warn" ? "" : "mut"} style={s.tone === "warn" ? { color: "var(--warn)", fontWeight: 700 } : undefined}>{s.text}</span>}</td>
                      <td>{o ? <bdi dir="ltr">{orderNo(o.order_no)}</bdi> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          {selected ? (
            <CaseDetail key={selected.id} c={selected} label={label(selected.category)} teams={[...new Set(slas.map((s) => s.team))]} now={now} reload={reload} />
          ) : (
            <>
              <h2>{t("detail")}</h2>
              <div className="empty">{t("selectCase")}</div>
            </>
          )}
        </div>
      </div>
      {logging && (
        <LogCallModal
          slas={slas}
          onClose={() => setLogging(false)}
          onDone={async (id) => {
            setLogging(false);
            await reload();
            setSel(id);
          }}
        />
      )}
    </>
  );
}

/** "Escalated by the customer to 1442" / "High priority" under the state. */
function Flag({ c }: { c: Case }) {
  const t = useT(SUPPORT);
  if (c.state === "escalated" && c.escalated_by === "customer") return <small className="bad" style={{ display: "block", fontWeight: 700 }}>{t("escByCustomer")}</small>;
  if (c.state !== "resolved" && c.priority === "high") return <small style={{ display: "block", color: "var(--warn)", fontWeight: 700 }}>{t("prioHigh")}</small>;
  return null;
}

type Mode = "resolve" | "note" | "reply" | "assign" | "escalate" | "refund";
/** Minimum text length for each mode; the field label and button are m_<mode>_l / m_<mode>_b. */
const MODE_MIN: Record<Mode, number> = { resolve: 3, reply: 1, note: 3, assign: 0, escalate: 0, refund: 0 };

function CaseDetail({ c, label, teams, now, reload }: { c: Case; label: string; teams: string[]; now: number; reload: () => Promise<void> }) {
  const privacy = usePrivacy();
  const { can } = useStaff();
  const w = useWords();
  const { t, f } = w;
  const run = useRpc();
  const photo = useSignedUrl(c.photo_path);
  const [notes, setNotes] = useState<Note[]>([]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [team, setTeam] = useState(c.owner_team ?? teams[0] ?? "");
  const [amount, setAmount] = useState("1");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = can("complaints_agent", "operator", "admin");
  const title = agent ? undefined : t("onlyAgent");

  const loadNotes = useCallback(async () => {
    const { data } = await supabase()
      .from("complaint_notes")
      .select("id, body, internal, author_role, created_at, author:profiles(full_name)")
      .eq("complaint_id", c.id)
      .order("created_at");
    setNotes((data ?? []) as unknown as Note[]);
  }, [c.id]);
  useEffect(() => {
    const t = setTimeout(loadNotes, 0);
    return () => clearTimeout(t);
  }, [loadNotes, c.state, c.refund_amount]);
  // Customer replies and other agents' notes arrive live.
  useRealtime(`case-${c.id}`, ["complaint_notes"], loadNotes, 400, { complaint_notes: `complaint_id=eq.${c.id}` });

  function start(m: Mode) {
    setText("");
    setTeam(c.owner_team ?? teams[0] ?? "");
    setAmount("1");
    setMode(m);
  }
  function submitMode() {
    const body = text.trim() || null;
    if (mode === "resolve") return act("resolve", { p_body: body }, t("okResolved", { n: c.case_no }));
    if (mode === "reply") return act("reply", { p_body: body }, t("okReply"));
    if (mode === "note") return act("note", { p_body: body }, t("okNote"));
    if (mode === "assign") return act("assign", { p_team: team, p_body: body }, t("okAssigned", { team: w.team(team) }));
    if (mode === "escalate") return act("escalate", { p_team: team || null, p_body: body }, t("okEscalated"));
    if (mode === "refund") return act("refund", { p_amount: Number(amount) }, t("okRefund", { amt: f.omr3(amount) }));
  }

  async function act(action: string, extra: Record<string, unknown>, ok: string) {
    setBusy(true);
    const done = await run("staff_case_action", { p_complaint_id: c.id, p_action: action, p_body: null, p_team: null, p_amount: null, ...extra }, ok);
    setBusy(false);
    if (done) {
      setMode(null);
      setText("");
      await Promise.all([reload(), loadNotes()]);
    }
  }

  const o = one(c.order);
  const cu = one(c.customer);
  const s = slaText(c, now, t, f);
  return (
    <>
      <h2>
        <span>
          <bdi dir="ltr">C-{c.case_no}</bdi> <St tone={STATE_TONE[c.state]}>{w.state(c.state)}</St>
        </span>
        <small>{w.channel(c.channel)}</small>
      </h2>
      <dl className="kv">
        <dt>{t("customer")}</dt>
        <dd>
          {c.customer_id ? (
            <Link className="lk" href={`/nws/customers?id=${c.customer_id}`}>
              {cu?.full_name || t("customer")}
            </Link>
          ) : (
            "—"
          )}
          {cu?.phone ? <small className="mut"> · <Phone value={cu.phone} maskPhones={privacy.maskPhones} /> {c.customer_id && <RevealButton profileId={c.customer_id} kind="contact" privileged={privacy.privileged} />}</small> : null}
        </dd>
        <dt>{t("category")}</dt>
        <dd>{label}</dd>
        <dt>{t("order")}</dt>
        <dd>
          {o ? (
            <Link className="lk" href={`/nws/orders/${o.id}`}>
              <bdi dir="ltr">{orderNo(o.order_no)}</bdi>
            </Link>
          ) : (
            "—"
          )}
          {o?.tanker_plate ? <small className="mut"> · <bdi dir="ltr">{o.tanker_plate}</bdi>{o.driver_name ? ` · ${o.driver_name}` : ""}</small> : null}
        </dd>
        <dt>{t("ownerTeam")}</dt>
        <dd>{c.owner_team ? w.team(c.owner_team) : t("unassigned")}</dd>
        <dt>{t("opened")}</dt>
        <dd>{f.dateTime(c.created_at)}</dd>
        <dt>{t("colSla")}</dt>
        <dd>
          {t("slaLine", { h: f.n(c.sla_hours), date: f.dateTime(c.due_at) })} <St tone={s.tone}>{s.text}</St>
        </dd>
        {c.genesys_id && (
          <>
            <dt>{t("genesys")}</dt>
            <dd>{t("interaction", { id: "" })}<bdi dir="ltr">{c.genesys_id}</bdi></dd>
          </>
        )}
        {Number(c.refund_amount) > 0 && (
          <>
            <dt>{t("refunded")}</dt>
            <dd>{t("refundedToWallet", { amt: f.omr3(c.refund_amount) })}</dd>
          </>
        )}
        <dt>{t("description")}</dt>
        <dd style={{ fontWeight: 400 }}>{c.description}</dd>
      </dl>
      {c.photo_path && (
        <div className="pad">
          {photo ? (
            <a href={photo} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
              <img className="pod-img" src={photo} alt={t("photoAlt", { n: c.case_no })} />
            </a>
          ) : (
            <small className="mut">{t("loadingPhoto")}</small>
          )}
        </div>
      )}
      {/* The resolution is also a timeline entry; show the banner only when it isn't (older cases). */}
      {c.state === "resolved" && c.resolution && !notes.some((n) => n.body === c.resolution) && <div className="banner info" style={{ margin: "0 16px 12px" }}>{t("resolutionX", { text: c.resolution })}</div>}

      <h2 style={{ paddingTop: 4 }}>
        {t("timeline")} <small>{t("timelineSub")}</small>
      </h2>
      <ul className="tl">
        <li className="done">
          {t("openedVia", { channel: w.channel(c.channel) })}
          <small>{f.dateTime(c.created_at)}</small>
        </li>
        {notes.map((n) => (
          <li key={n.id} className={n.internal ? "int" : "done"}>
            {n.internal && <b>{t("internalDot")}</b>}
            {n.body}
            <small>
              {n.author_role === "staff" ? one(n.author)?.full_name || t("nwsStaff") : one(n.author)?.full_name || n.author_role} · {f.dateTime(n.created_at)}
            </small>
          </li>
        ))}
        {c.resolved_at && (
          <li className="done">
            {t("resolvedNotified")}
            <small>{f.dateTime(c.resolved_at)}</small>
          </li>
        )}
      </ul>

      <div className="pad">
        {mode && (
          <div className="fld">
            {(mode === "assign" || mode === "escalate") && (
              <>
                <label htmlFor="cteam">{mode === "assign" ? t("ownerTeam") : t("escalateTo")}</label>
                <select id="cteam" className="in" value={team} onChange={(e) => setTeam(e.target.value)} style={{ marginBottom: 8 }}>
                  {mode === "escalate" && <option value="">{t("supervisor")}</option>}
                  {teams.map((x) => (
                    <option key={x} value={x}>{w.team(x)}</option>
                  ))}
                </select>
              </>
            )}
            {mode === "refund" && (
              <>
                <label htmlFor="camt">{t("refundAmt")}</label>
                <input id="camt" className="in" type="number" dir="ltr" min="0.1" max="50" step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ marginBottom: 6 }} />
                <small className="mut" style={{ display: "block", marginBottom: 8 }}>
                  {t("alreadyRefunded", { amt: f.omr3(c.refund_amount) })}
                </small>
              </>
            )}
            {mode !== "refund" && (
              <>
                <label htmlFor="cbody">{t(`m_${mode}_l`)}</label>
                <textarea id="cbody" className="in" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
              </>
            )}
            <div className="btns" style={{ marginTop: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setMode(null)} disabled={busy}>
                {t("cancel")}
              </button>
              <button
                className={`btn ${mode === "escalate" ? "bad" : "pri"}`}
                disabled={
                  busy ||
                  text.trim().length < MODE_MIN[mode] ||
                  (mode === "assign" && !team) ||
                  (mode === "refund" && !(Number(amount) > 0 && Number(amount) <= 50))
                }
                onClick={submitMode}
              >
                {t(`m_${mode}_b`)}
              </button>
            </div>
          </div>
        )}
        {!mode &&
          (c.state !== "resolved" ? (
            <div className="btns">
              <button className="btn" disabled={!agent || busy} title={title} onClick={() => start("assign")}>
                {t("assignDots")}
              </button>
              <button className="btn bad" disabled={!agent || busy || c.state === "escalated"} title={title} onClick={() => start("escalate")}>
                {t("escalateDots")}
              </button>
              <button className="btn" disabled={!agent || busy || !c.customer_id} title={!c.customer_id ? t("noCustomer") : title} onClick={() => start("refund")}>
                {t("refundDots")}
              </button>
              <button className="btn" disabled={!agent || busy || !c.customer_id} title={!c.customer_id ? t("noCustomer") : title} onClick={() => start("reply")}>
                {t("replyCust")}
              </button>
              <button className="btn pri" disabled={!agent || busy} title={title} onClick={() => start("resolve")}>
                {t("m_resolve_b")}
              </button>
              <button className="btn" disabled={!agent || busy} title={title} onClick={() => start("note")}>
                {t("addNote")}
              </button>
            </div>
          ) : (
            <div className="btns">
              <St tone="ok">{t("resolvedNotified")}</St>
              <button className="btn sm" disabled={!agent || busy} title={title} onClick={() => act("reopen", {}, t("okReopened", { n: c.case_no }))}>
                {t("reopen")}
              </button>
              <button className="btn sm" disabled={!agent || busy} title={title} onClick={() => start("note")}>
                {t("addNote")}
              </button>
            </div>
          ))}
      </div>
    </>
  );
}

type Caller = { id: string; full_name: string; phone: string | null };
function LogCallModal({ slas, onClose, onDone }: { slas: Sla[]; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const privacy = usePrivacy();
  const { toast } = useStaff();
  const w = useWords();
  const { t, f } = w;
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Caller[]>([]);
  const [cust, setCust] = useState<Caller | null>(null);
  const [orders, setOrders] = useState<{ id: string; order_no: number; service_type: string; created_at: string }[]>([]);
  const [order, setOrder] = useState("");
  const [cat, setCat] = useState("");
  const [desc, setDesc] = useState("");
  const [gx, setGx] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = q.trim().replace(/[%,()]/g, "");
    const t = setTimeout(async () => {
      if (s.length < 2) return setFound([]);
      const { data } = await supabase().from("profiles").select("id, full_name, phone").in("role", ["customer", "business"]).or(`full_name.ilike.%${s}%,phone.ilike.%${s}%`).order("full_name").limit(8);
      setFound((data ?? []) as Caller[]);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function choose(p: Caller) {
    setCust(p);
    setOrder("");
    const { data } = await supabase().from("orders").select("id, order_no, service_type, created_at").eq("customer_id", p.id).order("created_at", { ascending: false }).limit(10);
    setOrders((data ?? []) as typeof orders);
  }

  async function submit() {
    if (!cust || !cat || desc.trim().length < 3) return toast(t("needFields"), true);
    setBusy(true);
    const { data, error } = await supabase().rpc("staff_log_call_complaint", {
      p_customer_id: cust.id,
      p_order_id: order || null,
      p_category: cat,
      p_description: desc.trim(),
      p_genesys_id: gx.trim() || null,
    });
    setBusy(false);
    if (error) return toast(friendlyError(error, f.lang), true);
    toast(t("logged", { n: (data as { case_no: number }).case_no }));
    await onDone((data as { id: string }).id);
  }

  return (
    <Modal title={t("logCase")} wide onClose={onClose}>
      <p>{t("screenPop")}</p>
      <div className="grid2">
        <div>
          <div className="fld">
            <label htmlFor="gq">{t("caller")}</label>
            <input id="gq" className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("callerPh")} autoFocus />
          </div>
          <div className="picklist">
            {cust && !found.some((x) => x.id === cust.id) && (
              <button className="pickrow on" type="button">
                <span>{cust.full_name}</span>
                <small className="mut"><Phone value={cust.phone} maskPhones={privacy.maskPhones} /></small>
              </button>
            )}
            {found.map((p) => (
              <button key={p.id} type="button" className={`pickrow ${cust?.id === p.id ? "on" : ""}`} onClick={() => choose(p)}>
                <span>{p.full_name || t("unnamed")}</span>
                <small className="mut"><Phone value={p.phone} maskPhones={privacy.maskPhones} /></small>
              </button>
            ))}
            {q.trim().length >= 2 && found.length === 0 && <small className="mut">{t("noCustMatch")}</small>}
          </div>
          <div className="fld">
            <label htmlFor="go">{t("orderOpt")}</label>
            <select id="go" className="in" value={order} onChange={(e) => setOrder(e.target.value)} disabled={!cust}>
              <option value="">{cust ? t("notSpecific") : t("callerFirst")}</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {orderNo(o.order_no)} · {o.service_type} · {f.dateTime(o.created_at)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <div className="fld">
            <label htmlFor="gc">{t("category")}</label>
            <select id="gc" className="in" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">{t("choose")}</option>
              {slas.map((s) => (
                <option key={s.category} value={s.category}>
                  {t("catOption", { label: w.cat(s.category, s.label), h: f.n(s.hours), team: w.team(s.team) })}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="gd">{t("reported")}</label>
            <textarea id="gd" className="in" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="gx">{t("gxId")}</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="gx" className="in" dir="ltr" value={gx} onChange={(e) => setGx(e.target.value)} placeholder="GX-…" />
              <button type="button" className="btn sm" onClick={() => setGx(`GX-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`)}>
                {t("fromCall")}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          {t("cancel")}
        </button>
        <button className="btn pri" onClick={submit} disabled={busy || !cust || !cat || desc.trim().length < 3}>
          {busy ? t("saving") : t("logBtn")}
        </button>
      </div>
    </Modal>
  );
}

type Rated = { driver_id: string; rating: number };
function QualityTab({ cases, slas }: { cases: Case[]; slas: Sla[] }) {
  const w = useWords();
  const { t, f } = w;
  const [rated, setRated] = useState<Rated[] | null>(null);
  const [drivers, setDrivers] = useState<Map<string, { name: string; company: string }>>(new Map());
  const [driverCats, setDriverCats] = useState<Map<string, string[]>>(new Map());
  const [reopened, setReopened] = useState<number | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [r, cx, ro] = await Promise.all([
      db.from("orders").select("driver_id, rating").eq("is_test", false).not("rating", "is", null).not("driver_id", "is", null).gte("rated_at", since).limit(5000),
      db.from("complaints").select("category, order:orders(driver_id)").not("order_id", "is", null).limit(2000),
      db.from("audit_log").select("target_id").eq("action", "complaint.reopen").limit(5000),
    ]);
    setReopened(new Set(((ro.data ?? []) as { target_id: string }[]).map((x) => x.target_id)).size);
    const rows = (r.data ?? []) as Rated[];
    setRated(rows);
    const cm = new Map<string, string[]>();
    for (const x of (cx.data ?? []) as unknown as { category: string; order: { driver_id: string | null } | { driver_id: string | null }[] | null }[]) {
      const d = one(x.order)?.driver_id;
      if (d) cm.set(d, [...(cm.get(d) ?? []), x.category]);
    }
    setDriverCats(cm);
    const ids = [...new Set(rows.map((x) => x.driver_id))];
    if (!ids.length) return;
    const { data: ps } = await db.from("profiles").select("id, full_name, company_id").in("id", ids);
    const cids = [...new Set((ps ?? []).map((p) => p.company_id).filter(Boolean))] as string[];
    const { data: cs } = cids.length ? await db.from("companies").select("id, name").in("id", cids) : { data: [] };
    const cn = new Map((cs ?? []).map((c) => [c.id as string, c.name as string]));
    // An empty name shows as "Driver" in the viewer's language at render.
    setDrivers(new Map((ps ?? []).map((p) => [p.id as string, { name: (p.full_name as string) || "", company: cn.get(p.company_id as string) ?? "—" }])));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const avg = rated?.length ? rated.reduce((a, b) => a + b.rating, 0) / rated.length : null;
  const resolved = cases.filter((c) => c.resolved_at);
  const avgRes = resolved.length ? resolved.reduce((a, c) => a + (Date.parse(c.resolved_at!) - Date.parse(c.created_at)), 0) / resolved.length / HOUR : null;
  const inSla = resolved.filter((c) => c.resolved_at! <= c.due_at).length;
  const byCat = slas.map((s): [string, number] => [w.cat(s.category, s.label), cases.filter((c) => c.category === s.category).length]).sort((a, b) => b[1] - a[1]);
  const catLabel = (k: string) => w.cat(k, slas.find((s) => s.category === k)?.label ?? k);

  const worst = useMemo(() => {
    const m = new Map<string, { sum: number; n: number }>();
    for (const r of rated ?? []) {
      const v = m.get(r.driver_id) ?? { sum: 0, n: 0 };
      v.sum += r.rating;
      v.n += 1;
      m.set(r.driver_id, v);
    }
    return [...m.entries()].map(([id, v]) => ({ id, avg: v.sum / v.n, n: v.n })).sort((a, b) => a.avg - b.avg || b.n - a.n).slice(0, 8);
  }, [rated]);

  const topIssue = (id: string) => {
    const cats = driverCats.get(id);
    if (!cats?.length) return "—";
    const counts = new Map<string, number>();
    for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
    return catLabel([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  };

  return (
    <>
      <div className="okpis">
        <Kpi label={t("qRating")} value={avg == null ? "—" : `${f.n(avg, 1)} ★`} sub={t("qRatedN", { n: f.n(rated?.length ?? 0) })} tone={avg != null && avg >= 4.5 ? "ok" : ""} />
        <Kpi label={t("qRes")} value={avgRes == null ? "—" : t("hours1", { n: f.n(avgRes, 1) })} sub={t("qResolvedN", { n: f.n(resolved.length) })} />
        <Kpi label={t("qInSla")} value={f.ratio(inSla, resolved.length)} sub={t("qTarget")} tone={resolved.length && inSla / resolved.length >= 0.92 ? "ok" : "warn"} />
        <Kpi
          label={t("qReopened")}
          value={reopened == null ? "—" : f.ratio(reopened, Math.max(resolved.length, reopened))}
          sub={t("qReopenedSub", { n: f.n(reopened ?? 0), amt: f.omr3(cases.reduce((a, c) => a + Number(c.refund_amount), 0)) })}
          tone={reopened != null && resolved.length && reopened / resolved.length > 0.1 ? "warn" : ""}
        />
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>
            {t("byCat")} <small>{t("allCases")}</small>
          </h2>
          {byCat.length ? <Bars rows={byCat} /> : <p className="note">{t("noCatsCfg")}</p>}
        </div>
        <div className="panel">
          <h2>
            {t("lowest")} <small>{t("lowestSub")}</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("colDriver")}</th>
                  <th>{t("colCompany")}</th>
                  <th className="num">{t("colRating")}</th>
                  <th className="num">{t("colRatings")}</th>
                  <th>{t("colTopIssue")}</th>
                </tr>
              </thead>
              <tbody>
                {!rated && <tr><td colSpan={5} className="empty">{t("loading")}</td></tr>}
                {rated && worst.length === 0 && <tr><td colSpan={5} className="empty">{t("noRated")}</td></tr>}
                {worst.map((x) => (
                  <tr key={x.id}>
                    <td>{drivers.get(x.id)?.name || t("colDriver")}</td>
                    <td>{drivers.get(x.id)?.company ?? "—"}</td>
                    <td className="num" style={x.avg < 4 ? { color: "var(--bad)", fontWeight: 700 } : undefined}>{f.n(x.avg, 1)}</td>
                    <td className="num">{f.n(x.n)}</td>
                    <td>{topIssue(x.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function SlaTab({ slas }: { slas: Sla[] }) {
  const w = useWords();
  const { t, f } = w;
  return (
    <div className="grid2">
      <div className="panel">
        <h2>
          {t("slaTitle")} <small>{t("slaSub")}</small>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("category")}</th>
                <th className="num">{t("colHours")}</th>
                <th>{t("ownerTeam")}</th>
                <th>{t("colFirstEsc")}</th>
              </tr>
            </thead>
            <tbody>
              {slas.length === 0 && <tr><td colSpan={4} className="empty">{t("loading")}</td></tr>}
              {slas.map((s) => (
                <tr key={s.category}>
                  <td>{w.cat(s.category, s.label)}</td>
                  <td className="num">{f.n(s.hours)}</td>
                  <td>{w.team(s.team)}</td>
                  <td>{t("supAfter", { n: f.n(Math.max(1, Math.round(s.hours / 2))) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h2>
          {t("ccTitle")} <St tone="act">{t("simulated")}</St>
        </h2>
        <dl className="kv">
          <dt>{t("ccQueues")}</dt>
          {/* i18n-ignore: Genesys queue names */}
          <dd dir="ltr">NWS_Tanker_EN, NWS_Tanker_AR</dd>
          <dt>{t("ccPop")}</dt>
          <dd>{t("ccPopV")}</dd>
          <dt>{t("ccOrders")}</dt>
          <dd>{t("ccOrdersV")}</dd>
          <dt>{t("ccSync")}</dt>
          <dd>{t("ccSyncV")}</dd>
          <dt>{t("ccDrivers")}</dt>
          <dd>{t("ccDriversV")}</dd>
          <dt>{t("ccHours")}</dt>
          <dd>{t("ccHoursV")}</dd>
        </dl>
        <p className="note">{t("ccNote")}</p>
      </div>
    </div>
  );
}
