"use client";

import "../ops.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Bars, CHANNEL_LABEL, HOUR, Kpi, Modal, n3, one, pct, St, Tabs, useNow, useRealtime, useRpc, useSignedUrl } from "@/components/nws/ops";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { orderNo } from "@/lib/format";
import { supabase } from "@/lib/supabase/client";

type State = "new" | "assigned" | "escalated" | "resolved";
type Case = {
  id: string; case_no: number; order_id: string | null; customer_id: string | null; category: string; description: string; photo_path: string | null;
  channel: "app" | "call_centre" | "business"; genesys_id: string | null; state: State; owner_team: string | null; sla_hours: number; due_at: string;
  refund_amount: string; resolution: string | null; created_at: string; resolved_at: string | null;
  customer: { full_name: string; phone: string | null } | { full_name: string; phone: string | null }[] | null;
  order: { id: string; order_no: number; tanker_plate: string | null; driver_name: string | null } | { id: string; order_no: number; tanker_plate: string | null; driver_name: string | null }[] | null;
};
type Sla = { category: string; label: string; hours: number; team: string };
type Note = { id: number; body: string; internal: boolean; author_role: string; created_at: string; author: { full_name: string } | { full_name: string }[] | null };

const STATE_TONE: Record<State, string> = { new: "warn", assigned: "act", escalated: "bad", resolved: "ok" };
const STATE_LABEL: Record<State, string> = { new: "New", assigned: "Assigned", escalated: "Escalated", resolved: "Resolved" };
type Tab = "cases" | "quality" | "sla";

/** "5 h left" / "3 h over" against the case's due time. */
function slaText(c: Pick<Case, "state" | "due_at" | "resolved_at">, now: number): { text: string; tone: string } {
  if (c.state === "resolved") {
    const ok = c.resolved_at && c.resolved_at <= c.due_at;
    return { text: ok ? "Met" : "Missed", tone: ok ? "ok" : "bad" };
  }
  const left = (Date.parse(c.due_at) - now) / HOUR;
  if (left < 0) return { text: `${Math.ceil(-left)} h over`, tone: "bad" };
  return { text: `${Math.floor(left)} h left`, tone: left < 4 ? "warn" : "" };
}

export default function ComplaintsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Complaints />
    </Suspense>
  );
}

function Complaints() {
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
          "id, case_no, order_id, customer_id, category, description, photo_path, channel, genesys_id, state, owner_team, sla_hours, due_at, refund_amount, resolution, created_at, resolved_at, customer:profiles(full_name, phone), order:orders(id, order_no, tanker_plate, driver_name)",
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
          <h1>Complaints</h1>
          <p>Case management from submission to resolution, with escalation, refunds and SLA tracking. Synced with the Genesys call centre so agents and the tanker team work the same case.</p>
        </div>
      </div>
      <Tabs<Tab>
        tabs={[
          ["cases", "Cases", open.length],
          ["quality", "Service quality"],
          ["sla", "SLA and call centre"],
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
  const now = useNow(30_000);
  const [f, setF] = useState<"open" | State | "all" | "overdue">("open");
  const [logging, setLogging] = useState(false);
  const all = useMemo(() => cases ?? [], [cases]);
  const overdue = (c: Case) => c.state !== "resolved" && Date.parse(c.due_at) < now;
  const match = (c: Case, k: typeof f) => (k === "all" ? true : k === "open" ? c.state !== "resolved" : k === "overdue" ? overdue(c) : c.state === k);
  const list = all.filter((c) => match(c, f));
  const label = (cat: string) => slas.find((s) => s.category === cat)?.label ?? cat.replace(/_/g, " ");
  const selected = all.find((c) => c.id === sel) ?? null;
  const canLog = can("complaints_agent", "operator");
  const today = all.filter((c) => now - Date.parse(c.created_at) < 86_400_000).length;

  return (
    <>
      <div className="okpis">
        <Kpi label="Open cases" value={cases ? all.filter((c) => c.state !== "resolved").length : "—"} sub={`${all.filter((c) => c.state === "new").length} new, not yet assigned`} tone="warn" />
        <Kpi label="Past SLA" value={cases ? all.filter(overdue).length : "—"} sub="open cases over their resolution time" tone={all.some(overdue) ? "bad" : "ok"} />
        <Kpi label="Escalated" value={cases ? all.filter((c) => c.state === "escalated").length : "—"} sub="with a supervisor" />
        <Kpi label="Opened today" value={cases ? today : "—"} sub={`${all.filter((c) => c.channel === "call_centre" && now - Date.parse(c.created_at) < 86_400_000).length} from the call centre`} />
      </div>
      <div className="two">
        <div className="panel">
          <div className="toolbar">
            <div className="chips">
              {(
                [
                  ["open", "Open"],
                  ["new", "New"],
                  ["escalated", "Escalated"],
                  ["overdue", "Past SLA"],
                  ["resolved", "Resolved"],
                  ["all", "All"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`chip ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
                  {l}
                  <span className="tc">{all.filter((c) => match(c, k)).length}</span>
                </button>
              ))}
            </div>
            <button className="btn pri" disabled={!canLog} title={canLog ? undefined : "Complaints agents and operators only"} onClick={() => setLogging(true)}>
              Log case from Genesys call
            </button>
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Category</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>SLA</th>
                  <th>Order</th>
                </tr>
              </thead>
              <tbody>
                {!cases && <tr><td colSpan={6} className="empty">Loading…</td></tr>}
                {cases && list.length === 0 && <tr><td colSpan={6} className="empty">No cases.</td></tr>}
                {list.map((c) => {
                  const s = slaText(c, now);
                  const o = one(c.order);
                  return (
                    <tr key={c.id} className={`click ${sel === c.id ? "sel" : ""}`} onClick={() => setSel(c.id)}>
                      <td>
                        <b>C-{c.case_no}</b>
                        <small style={{ display: "block" }}>{one(c.customer)?.full_name || "—"}</small>
                      </td>
                      <td>{label(c.category)}</td>
                      <td>{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                      <td><St tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</St></td>
                      <td>{c.state === "resolved" ? <St tone={s.tone}>{s.text}</St> : s.tone === "bad" ? <St tone="bad">{s.text}</St> : <span className={s.tone === "warn" ? "" : "mut"} style={s.tone === "warn" ? { color: "var(--warn)", fontWeight: 700 } : undefined}>{s.text}</span>}</td>
                      <td>{o ? orderNo(o.order_no) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          {selected ? (
            <CaseDetail key={selected.id} c={selected} label={label(selected.category)} now={now} reload={reload} />
          ) : (
            <>
              <h2>Case detail</h2>
              <div className="empty">Select a case to assign, escalate, refund or resolve it.</div>
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

function CaseDetail({ c, label, now, reload }: { c: Case; label: string; now: number; reload: () => Promise<void> }) {
  const { can } = useStaff();
  const run = useRpc();
  const photo = useSignedUrl(c.photo_path);
  const [notes, setNotes] = useState<Note[]>([]);
  const [mode, setMode] = useState<"resolve" | "note" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = can("complaints_agent", "operator", "admin");
  const title = agent ? undefined : "Complaints agents, operators and admins only";

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
  const s = slaText(c, now);
  return (
    <>
      <h2>
        <span>
          C-{c.case_no} <St tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</St>
        </span>
        <small>{CHANNEL_LABEL[c.channel]}</small>
      </h2>
      <dl className="kv">
        <dt>Customer</dt>
        <dd>
          {c.customer_id ? (
            <Link className="lk" href={`/nws/customers?id=${c.customer_id}`}>
              {cu?.full_name || "Customer"}
            </Link>
          ) : (
            "—"
          )}
          {cu?.phone ? <small className="mut"> · {cu.phone}</small> : null}
        </dd>
        <dt>Category</dt>
        <dd>{label}</dd>
        <dt>Order</dt>
        <dd>
          {o ? (
            <Link className="lk" href={`/nws/orders/${o.id}`}>
              {orderNo(o.order_no)}
            </Link>
          ) : (
            "—"
          )}
          {o?.tanker_plate ? <small className="mut"> · {o.tanker_plate}{o.driver_name ? ` · ${o.driver_name}` : ""}</small> : null}
        </dd>
        <dt>Owner team</dt>
        <dd>{c.owner_team || "Unassigned"}</dd>
        <dt>Opened</dt>
        <dd>{fmtDateTime(c.created_at)}</dd>
        <dt>SLA</dt>
        <dd>
          {c.sla_hours} h · due {fmtDateTime(c.due_at)} <St tone={s.tone}>{s.text}</St>
        </dd>
        {c.genesys_id && (
          <>
            <dt>Genesys</dt>
            <dd>Interaction {c.genesys_id}</dd>
          </>
        )}
        {Number(c.refund_amount) > 0 && (
          <>
            <dt>Refunded</dt>
            <dd>{n3(c.refund_amount)} OMR to wallet</dd>
          </>
        )}
        <dt>Description</dt>
        <dd style={{ fontWeight: 400 }}>{c.description}</dd>
      </dl>
      {c.photo_path && (
        <div className="pad">
          {photo ? (
            <a href={photo} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
              <img className="pod-img" src={photo} alt={`Photo attached to C-${c.case_no}`} />
            </a>
          ) : (
            <small className="mut">Loading photo…</small>
          )}
        </div>
      )}
      {c.state === "resolved" && c.resolution && <div className="banner info" style={{ margin: "0 16px 12px" }}>Resolution: {c.resolution}</div>}

      <h2 style={{ paddingTop: 4 }}>
        Timeline <small>internal notes are not shown to the customer</small>
      </h2>
      <ul className="tl">
        <li className="done">
          Case opened via {CHANNEL_LABEL[c.channel]}
          <small>{fmtDateTime(c.created_at)}</small>
        </li>
        {notes.map((n) => (
          <li key={n.id} className={n.internal ? "int" : "done"}>
            {n.internal && <b>Internal · </b>}
            {n.body}
            <small>
              {n.author_role === "staff" ? one(n.author)?.full_name || "NWS staff" : one(n.author)?.full_name || n.author_role} · {fmtDateTime(n.created_at)}
            </small>
          </li>
        ))}
        {c.resolved_at && (
          <li className="done">
            Resolved — customer notified by SMS and push
            <small>{fmtDateTime(c.resolved_at)}</small>
          </li>
        )}
      </ul>

      <div className="pad">
        {mode && (
          <div className="fld">
            <label htmlFor="cbody">{mode === "resolve" ? "Resolution (sent to the customer)" : "Internal note"}</label>
            <textarea id="cbody" className="in" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <div className="btns" style={{ marginTop: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setMode(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn pri"
                disabled={busy || text.trim().length < 3}
                onClick={() =>
                  mode === "resolve"
                    ? act("resolve", { p_body: text.trim() }, `C-${c.case_no} resolved — customer notified`)
                    : act("note", { p_body: text.trim() }, "Internal note added")
                }
              >
                {mode === "resolve" ? "Resolve and notify" : "Add note"}
              </button>
            </div>
          </div>
        )}
        {!mode &&
          (c.state !== "resolved" ? (
            <div className="btns">
              <button className="btn" disabled={!agent || busy} title={title} onClick={() => act("assign", { p_team: "Tanker operations" }, "Assigned to tanker operations")}>
                Assign to tanker ops
              </button>
              <button className="btn bad" disabled={!agent || busy || c.state === "escalated"} title={title} onClick={() => act("escalate", {}, "Escalated to the supervisor")}>
                Escalate
              </button>
              <button className="btn" disabled={!agent || busy} title={title} onClick={() => act("refund", { p_amount: 1 }, "1.000 OMR refunded to the customer's wallet")}>
                Refund 1.000 OMR
              </button>
              <button className="btn pri" disabled={!agent || busy} title={title} onClick={() => { setText(""); setMode("resolve"); }}>
                Resolve and notify
              </button>
              <button className="btn" disabled={!agent || busy} title={title} onClick={() => { setText(""); setMode("note"); }}>
                Add internal note
              </button>
            </div>
          ) : (
            <div className="btns">
              <St tone="ok">Resolved — customer notified by SMS and push</St>
              <button className="btn sm" disabled={!agent || busy} title={title} onClick={() => act("reopen", {}, `C-${c.case_no} reopened`)}>
                Reopen
              </button>
              <button className="btn sm" disabled={!agent || busy} title={title} onClick={() => { setText(""); setMode("note"); }}>
                Add internal note
              </button>
            </div>
          ))}
      </div>
    </>
  );
}

type Caller = { id: string; full_name: string; phone: string | null };
function LogCallModal({ slas, onClose, onDone }: { slas: Sla[]; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const { toast } = useStaff();
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
      const { data } = await supabase().from("profiles").select("id, full_name, phone").eq("role", "customer").or(`full_name.ilike.%${s}%,phone.ilike.%${s}%`).order("full_name").limit(8);
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
    if (!cust || !cat || desc.trim().length < 3) return toast("Choose the caller, a category and describe the problem", true);
    setBusy(true);
    const { data, error } = await supabase().rpc("staff_log_call_complaint", {
      p_customer_id: cust.id,
      p_order_id: order || null,
      p_category: cat,
      p_description: desc.trim(),
      p_genesys_id: gx.trim() || null,
    });
    setBusy(false);
    if (error) return toast(friendlyError(error), true);
    toast(`Case C-${(data as { case_no: number }).case_no} logged`);
    await onDone((data as { id: string }).id);
  }

  return (
    <Modal title="Log case from Genesys call" wide onClose={onClose}>
      <p>Screen pop from the NWS_Tanker queue. Find the caller, link the order they are calling about, and the case starts its SLA clock now.</p>
      <div className="grid2">
        <div>
          <div className="fld">
            <label htmlFor="gq">Caller (name or mobile)</label>
            <input id="gq" className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Fatma or 9123" autoFocus />
          </div>
          <div className="picklist">
            {cust && !found.some((f) => f.id === cust.id) && (
              <button className="pickrow on" type="button">
                <span>{cust.full_name}</span>
                <small className="mut">{cust.phone}</small>
              </button>
            )}
            {found.map((p) => (
              <button key={p.id} type="button" className={`pickrow ${cust?.id === p.id ? "on" : ""}`} onClick={() => choose(p)}>
                <span>{p.full_name || "Unnamed"}</span>
                <small className="mut">{p.phone || "—"}</small>
              </button>
            ))}
            {q.trim().length >= 2 && found.length === 0 && <small className="mut">No customer matches.</small>}
          </div>
          <div className="fld">
            <label htmlFor="go">Order (optional)</label>
            <select id="go" className="in" value={order} onChange={(e) => setOrder(e.target.value)} disabled={!cust}>
              <option value="">{cust ? "Not about a specific order" : "Choose the caller first"}</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {orderNo(o.order_no)} · {o.service_type} · {fmtDateTime(o.created_at)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <div className="fld">
            <label htmlFor="gc">Category</label>
            <select id="gc" className="in" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Choose…</option>
              {slas.map((s) => (
                <option key={s.category} value={s.category}>
                  {s.label} · {s.hours} h SLA · {s.team}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="gd">What the caller reported</label>
            <textarea id="gd" className="in" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="gx">Genesys interaction ID</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="gx" className="in" value={gx} onChange={(e) => setGx(e.target.value)} placeholder="GX-…" />
              <button type="button" className="btn sm" onClick={() => setGx(`GX-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`)}>
                From call
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn pri" onClick={submit} disabled={busy || !cust || !cat || desc.trim().length < 3}>
          {busy ? "Saving…" : "Log case"}
        </button>
      </div>
    </Modal>
  );
}

type Rated = { driver_id: string; rating: number };
function QualityTab({ cases, slas }: { cases: Case[]; slas: Sla[] }) {
  const [rated, setRated] = useState<Rated[] | null>(null);
  const [drivers, setDrivers] = useState<Map<string, { name: string; company: string }>>(new Map());
  const [driverCats, setDriverCats] = useState<Map<string, string[]>>(new Map());

  const load = useCallback(async () => {
    const db = supabase();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [r, cx] = await Promise.all([
      db.from("orders").select("driver_id, rating").not("rating", "is", null).not("driver_id", "is", null).gte("rated_at", since).limit(5000),
      db.from("complaints").select("category, order:orders(driver_id)").not("order_id", "is", null).limit(2000),
    ]);
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
    setDrivers(new Map((ps ?? []).map((p) => [p.id as string, { name: (p.full_name as string) || "Driver", company: cn.get(p.company_id as string) ?? "—" }])));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const avg = rated?.length ? rated.reduce((a, b) => a + b.rating, 0) / rated.length : null;
  const resolved = cases.filter((c) => c.resolved_at);
  const avgRes = resolved.length ? resolved.reduce((a, c) => a + (Date.parse(c.resolved_at!) - Date.parse(c.created_at)), 0) / resolved.length / HOUR : null;
  const inSla = resolved.filter((c) => c.resolved_at! <= c.due_at).length;
  const byCat = slas.map((s): [string, number] => [s.label, cases.filter((c) => c.category === s.category).length]).sort((a, b) => b[1] - a[1]);
  const catLabel = (k: string) => slas.find((s) => s.category === k)?.label ?? k;

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
        <Kpi label="Average driver rating, 30 days" value={avg == null ? "—" : `${avg.toFixed(1)} ★`} sub={`${rated?.length ?? 0} rated deliveries`} tone={avg != null && avg >= 4.5 ? "ok" : ""} />
        <Kpi label="Average resolution time" value={avgRes == null ? "—" : `${avgRes.toFixed(1)} h`} sub={`${resolved.length} resolved cases`} />
        <Kpi label="Resolved within SLA" value={pct(inSla, resolved.length)} sub="target 92%" tone={resolved.length && inSla / resolved.length >= 0.92 ? "ok" : "warn"} />
        <Kpi label="Refunded on cases" value={`${n3(cases.reduce((a, c) => a + Number(c.refund_amount), 0))}`} sub="OMR to customer wallets" />
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>
            Complaints by category <small>all cases</small>
          </h2>
          {byCat.length ? <Bars rows={byCat} /> : <p className="note">No categories configured.</p>}
        </div>
        <div className="panel">
          <h2>
            Lowest-rated drivers <small>needs coaching · 30 days</small>
          </h2>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Tanker company</th>
                  <th className="num">Rating</th>
                  <th className="num">Ratings</th>
                  <th>Top issue</th>
                </tr>
              </thead>
              <tbody>
                {!rated && <tr><td colSpan={5} className="empty">Loading…</td></tr>}
                {rated && worst.length === 0 && <tr><td colSpan={5} className="empty">No rated deliveries in the last 30 days.</td></tr>}
                {worst.map((w) => (
                  <tr key={w.id}>
                    <td>{drivers.get(w.id)?.name ?? "Driver"}</td>
                    <td>{drivers.get(w.id)?.company ?? "—"}</td>
                    <td className="num" style={w.avg < 4 ? { color: "var(--bad)", fontWeight: 700 } : undefined}>{w.avg.toFixed(1)}</td>
                    <td className="num">{w.n}</td>
                    <td>{topIssue(w.id)}</td>
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
  return (
    <div className="grid2">
      <div className="panel">
        <h2>
          Resolution SLA by category <small>changed in Settings</small>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Hours</th>
                <th>Owner team</th>
                <th>First escalation</th>
              </tr>
            </thead>
            <tbody>
              {slas.length === 0 && <tr><td colSpan={4} className="empty">Loading…</td></tr>}
              {slas.map((s) => (
                <tr key={s.category}>
                  <td>{s.label}</td>
                  <td className="num">{s.hours}</td>
                  <td>{s.team}</td>
                  <td>Supervisor after {Math.max(1, Math.round(s.hours / 2))} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h2>
          Call centre alignment <St tone="act">Simulated</St>
        </h2>
        <dl className="kv">
          <dt>Genesys queues</dt>
          <dd>NWS_Tanker_EN, NWS_Tanker_AR</dd>
          <dt>Screen pop</dt>
          <dd>Customer, last order and live ETA</dd>
          <dt>Call-centre orders</dt>
          <dd>Placed from Orders → New order for a caller</dd>
          <dt>Case sync</dt>
          <dd>Two-way, real time</dd>
          <dt>Calls to drivers</dt>
          <dd>Masked numbers — real numbers stay hidden on both sides</dd>
          <dt>Hours</dt>
          <dd>07:00–23:00, Arabic and English</dd>
        </dl>
        <p className="note">The Genesys integration is simulated in the pilot: interaction IDs are entered by the agent, and calls are not recorded here.</p>
      </div>
    </div>
  );
}
