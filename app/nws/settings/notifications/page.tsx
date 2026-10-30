"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Chips, Empty, int, Kpi, PageHead, ReadOnlyNote, Switch, useAudited, useRun } from "@/components/nws/admin/ui";
import { fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { NotificationTemplate, OutboxRow } from "@/lib/types";

// Screen text in one place (Arabic comes later).
const T = {
  title: "Notifications",
  sub: "What customers, drivers, owners, business users and staff are told at each step, in English and Arabic, on which channels — and every message the delivery pipeline sent.",
  delivery: "Delivery",
  deliverySub: "provider per channel · the dispatcher runs every minute",
  outbox: "Outbox",
  outboxSub: "every message, per channel, newest first",
  templates: "Notification templates",
  templatesSub: "English and Arabic · {placeholders} are filled in automatically",
  runNow: "Run dispatcher now",
  sendTest: "Send me a test",
  simulatedNote:
    "No SMS, WhatsApp, push (FCM) or email gateway is connected yet: channels set to “Simulated” are sent by the built-in simulator, which records a provider response (numbers ending 0000 are unreachable, push tokens starting “invalid” are unregistered, @bounce.test addresses bounce). “External gateway” leaves messages queued for a gateway worker through the integration API (POST /api/v1/notifications/claim). Users choose their channels in the apps; order-critical SMS goes out even when SMS is off; reminders need the user's reminder consent and marketing their promotions consent.",
  loadMore: "Load more",
};
const AUDIENCE: Record<string, string> = { customer: "Customer", driver: "Driver", owner: "Tanker owner", business: "Business", staff: "NWS staff" };
const CATEGORY: Record<string, string> = { service: "Service", reminder: "Reminder (needs consent)", marketing: "Marketing (needs consent)" };
type Channel = "sms" | "push" | "whatsapp" | "email";
const CHANNELS: [Channel, string][] = [["sms", "SMS"], ["push", "Push"], ["whatsapp", "WhatsApp"], ["email", "Email"]];
const PROVIDER: Record<string, string> = { simulated: "Simulated", external: "External gateway", off: "Off" };
const STATUS_TONE: Record<OutboxRow["status"], string> = { queued: "warn", sent: "ok", failed: "bad" };
const STATUS_LABEL: Record<OutboxRow["status"], string> = { queued: "Queued", sent: "Sent", failed: "Failed" };
const PAGE = 100;

type NotifySetting = { providers: Record<Channel, string>; max_attempts: number; sender_id?: string };
type Stat = { channel: Channel; status: OutboxRow["status"]; is_test: boolean; n: number };
type Row = OutboxRow & { user: { full_name: string } | null };

const save = (t: NotificationTemplate, reason: string) =>
  supabase().rpc("staff_update_template", {
    p_event: t.event, p_push: t.push, p_sms: t.sms, p_whatsapp: t.whatsapp, p_email: t.email ?? false,
    p_title_en: t.title_en, p_body_en: t.body_en, p_title_ar: t.title_ar, p_body_ar: t.body_ar, p_reason: reason,
  });

export default function NotificationsPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const [tpl, setTpl] = useState<NotificationTemplate[] | null>(null);
  const [sent, setSent] = useState<Map<string, number> | null>(null);
  const [edit, setEdit] = useState<NotificationTemplate | null>(null);
  const [cfg, setCfg] = useState<NotifySetting | null>(null);
  const [stats, setStats] = useState<Stat[] | null>(null);
  const [tick, setTick] = useState(0);
  const admin = can("admin");
  const operator = can("operator");

  const load = useCallback(() => {
    const db = supabase();
    db.from("notification_templates").select("*").order("audience").order("event").then(({ data }) => setTpl((data ?? []) as NotificationTemplate[]));
    db.rpc("staff_notification_counts", { p_days: 30 }).then(({ data }) => setSent(new Map(((data ?? []) as { event: string; n: number }[]).map((x) => [x.event, x.n]))));
    db.rpc("staff_outbox_stats", { p_days: 7 }).then(({ data }) => setStats((data ?? []) as Stat[]));
    db.from("app_settings").select("value").eq("key", "NOTIFY").maybeSingle<{ value: string }>().then(({ data }) => {
      try {
        setCfg(data ? (JSON.parse(data.value) as NotifySetting) : null);
      } catch {
        setCfg(null);
      }
    });
  }, []);
  useEffect(load, [load]);
  // After an action: counts and settings, and the outbox list remounts.
  const reload = useCallback(() => {
    load();
    setTick((n) => n + 1);
  }, [load]);

  function toggle(t: NotificationTemplate, c: Channel) {
    const label = CHANNELS.find((x) => x[0] === c)![1];
    const on = Boolean(t[c]);
    ask({
      title: `${on ? "Turn off" : "Turn on"} ${label} for “${t.label}”`,
      confirm: on ? `Turn off ${label}` : `Turn on ${label}`,
      ok: "Template updated",
      run: (reason) => save({ ...t, [c]: !on }, reason),
      done: reload,
    });
  }

  function setProvider(c: Channel, p: string) {
    if (!cfg) return;
    ask({
      title: `${CHANNELS.find((x) => x[0] === c)![1]}: ${PROVIDER[p]}`,
      body: p === "external" ? "Messages on this channel stay queued until a gateway worker claims them through the integration API." : p === "off" ? "Messages on this channel will be marked failed (switched off)." : "The built-in simulator sends and records a provider response.",
      confirm: "Change provider",
      ok: "Delivery settings saved",
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "NOTIFY", p_value: { ...cfg, providers: { ...cfg.providers, [c]: p } }, p_reason: reason }),
      done: reload,
    });
  }

  const live = (stats ?? []).filter((s) => !s.is_test);
  const sum = (f: (s: Stat) => boolean) => live.filter(f).reduce((a, s) => a + s.n, 0);
  const testN = (stats ?? []).filter((s) => s.is_test).reduce((a, s) => a + s.n, 0);
  const total30 = sent ? [...sent.values()].reduce((a, n) => a + n, 0) : null;

  return (
    <>
      <PageHead title={T.title} sub={T.sub}>
        {operator && <button className="btn" onClick={async () => { if (await run(supabase().rpc("dispatch_notifications"), "Dispatcher ran")) reload(); }}>{T.runNow}</button>}
      </PageHead>
      {!admin && <ReadOnlyNote who="a Super admin" />}
      <div className="okpis">
        <Kpi label="Sent, 7 days" value={stats ? int(sum((s) => s.status === "sent")) : "…"} sub={CHANNELS.map(([c, l]) => `${l} ${int(sum((s) => s.channel === c && s.status === "sent"))}`).join(" · ")} tone="ok" />
        <Kpi label="Queued now" value={stats ? int(sum((s) => s.status === "queued")) : "…"} sub="waiting for the dispatcher or a gateway" tone={sum((s) => s.status === "queued") ? "warn" : undefined} />
        <Kpi label="Failed, 7 days" value={stats ? int(sum((s) => s.status === "failed")) : "…"} sub="no device / number / email, or provider error" tone={sum((s) => s.status === "failed") ? "bad" : undefined} />
        <Kpi label="Test-zone messages" value={stats ? int(testN) : "…"} sub="left out of the figures above" />
      </div>

      <div className="panel">
        <h2>{T.delivery} <small>{T.deliverySub}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>Channel</th><th>Provider</th><th className="num">Attempts before failing</th><th></th></tr></thead>
            <tbody>
              {!cfg && <Empty cols={4}>Loading…</Empty>}
              {cfg && CHANNELS.map(([c, l]) => (
                <tr key={c}>
                  <td>{l}{c === "sms" && cfg.sender_id ? <small style={{ display: "block" }}>Sender id {cfg.sender_id}</small> : null}</td>
                  <td>
                    <select className="in" style={{ maxWidth: 220 }} value={cfg.providers[c] ?? "simulated"} disabled={!admin} onChange={(e) => setProvider(c, e.target.value)} aria-label={`${l} provider`}>
                      {Object.entries(PROVIDER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td className="num">{cfg.max_attempts}</td>
                  <td className="num">
                    {admin && (
                      <button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_notify_test", { p_channel: c }), `Test ${l} queued — the dispatcher sends it within a minute`)) reload(); }}>{T.sendTest}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{T.simulatedNote}</p>
      </div>

      <Outbox key={tick} canRetry={operator} onChanged={reload} />

      <div className="panel">
        <h2>{T.templates} <small>{T.templatesSub}</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Event</th><th>Audience</th>{CHANNELS.map(([, l]) => <th key={l}>{l}</th>)}<th>English</th><th>Arabic</th><th className="num">In-app, 30 days</th><th></th></tr>
            </thead>
            <tbody>
              {!tpl && <Empty cols={11}>Loading…</Empty>}
              {tpl?.map((t) => (
                <tr key={t.event}>
                  <td>
                    {t.label}
                    <small style={{ display: "block" }}><code>{t.event}</code> · {CATEGORY[t.category ?? "service"]}{t.critical ? " · order-critical SMS" : ""}</small>
                  </td>
                  <td>{AUDIENCE[t.audience] ?? t.audience}</td>
                  {CHANNELS.map(([c, l]) => (
                    <td key={c}><Switch on={Boolean(t[c])} disabled={!admin} label={l} onClick={() => toggle(t, c)} /></td>
                  ))}
                  <td className="tpl"><b>{t.title_en}</b><small>{t.body_en}</small></td>
                  <td className="tpl" dir="rtl" lang="ar"><b>{t.title_ar}</b><small>{t.body_ar}</small></td>
                  <td className="num">{sent ? int(sent.get(t.event) ?? 0) : "…"}</td>
                  <td className="num">{admin && <button className="btn sm" onClick={() => setEdit(t)}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total30 != null && <p className="note">{int(total30)} in-app notifications in the last 30 days; each also goes out on the template&apos;s channels that the user hasn&apos;t switched off.</p>}
      </div>
      {edit && <EditTemplate tpl={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {dialog}
    </>
  );
}

function Outbox({ canRetry, onChanged }: { canRetry: boolean; onChanged: () => void }) {
  const run = useRun();
  const [channel, setChannel] = useState<"all" | Channel>("all");
  const [status, setStatus] = useState<"all" | OutboxRow["status"]>("all");
  const [event, setEvent] = useState("");
  const [search, setSearch] = useState("");
  const [showTest, setShowTest] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const query = useCallback(
    (from: number) => {
      const text = search.trim().replace(/[,()%]/g, " ");
      let q = supabase()
        .from("notification_outbox")
        .select("id, notification_id, user_id, event, channel, lang, destination_masked, title, body, status, attempts, next_attempt_at, provider, provider_ref, provider_response, error, order_id, is_test, created_at, sent_at, user:profiles!notification_outbox_user_id_fkey(full_name)")
        .order("id", { ascending: false })
        .range(from, from + PAGE - 1);
      if (channel !== "all") q = q.eq("channel", channel);
      if (status !== "all") q = q.eq("status", status);
      if (event.trim()) q = q.ilike("event", `%${event.trim().replace(/[%_]/g, "")}%`);
      if (text) q = q.or(`title.ilike.%${text}%,body.ilike.%${text}%`);
      if (!showTest) q = q.eq("is_test", false);
      return q;
    },
    [channel, status, event, search, showTest],
  );

  useEffect(() => {
    let live = true;
    query(0).then(({ data, error }) => {
      if (!live) return;
      setErr(error ? friendlyError(error) : null);
      const got = (data ?? []) as unknown as Row[];
      setRows(got);
      setMore(got.length === PAGE);
    });
    return () => {
      live = false;
    };
  }, [query]);

  async function loadMore() {
    const { data, error } = await query(rows?.length ?? 0);
    if (error) return setErr(friendlyError(error));
    const got = (data ?? []) as unknown as Row[];
    setRows((r) => [...(r ?? []), ...got]);
    setMore(got.length === PAGE);
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return m;
  }, [rows]);

  return (
    <div className="panel">
      <h2>{T.outbox} <small>{T.outboxSub}</small></h2>
      <div className="pad" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <Chips items={[["all", "All channels"], ...CHANNELS]} value={channel} onChange={setChannel} />
        <Chips items={[["all", "Any status"], ["queued", "Queued", counts.get("queued")], ["sent", "Sent", counts.get("sent")], ["failed", "Failed", counts.get("failed")]]} value={status} onChange={setStatus} />
        <input className="in" style={{ maxWidth: 180 }} placeholder="Event, e.g. refill" value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Filter by event" />
        <input className="in" style={{ maxWidth: 220 }} placeholder="Search message text" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search message text" />
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> Include test zone</label>
      </div>
      {err && <div className="banner badb">{err}</div>}
      <div className="tblwrap">
        <table>
          <thead><tr><th>Queued</th><th>To</th><th>Event</th><th>Channel</th><th>Message</th><th>Status</th><th className="num">Attempts</th><th>Provider</th><th></th></tr></thead>
          <tbody>
            {!rows && <Empty cols={9}>Loading…</Empty>}
            {rows?.length === 0 && <Empty cols={9}>No messages match these filters.</Empty>}
            {rows?.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.created_at)}{r.sent_at && <small style={{ display: "block" }}>sent {fmtDateTime(r.sent_at)}</small>}</td>
                <td>{r.user?.full_name || "—"}<small style={{ display: "block" }} dir="ltr">{r.destination_masked ?? "—"}</small></td>
                <td><code>{r.event}</code>{r.is_test && <span className="st warn ptag">TEST</span>}</td>
                <td>{CHANNELS.find(([c]) => c === r.channel)?.[1]}<small style={{ display: "block" }}>{r.lang === "ar" ? "Arabic" : "English"}</small></td>
                <td className="tpl" dir={r.lang === "ar" ? "rtl" : undefined}><b>{r.title}</b><small>{r.body}</small></td>
                <td>
                  <span className={`st ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  {r.error && <small style={{ display: "block" }} className="bad">{r.error}</small>}
                  {r.status === "queued" && r.attempts > 0 && <small style={{ display: "block" }}>next try {fmtDateTime(r.next_attempt_at)}</small>}
                </td>
                <td className="num">{r.attempts}</td>
                <td>
                  {r.provider ?? "—"}
                  {r.provider_ref && <small style={{ display: "block" }}><code>{r.provider_ref}</code></small>}
                  {r.provider_response && (
                    <button className="btn sm ghost" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>Response</button>
                  )}
                  {open === r.id && <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", maxWidth: 260 }}>{JSON.stringify(r.provider_response, null, 1)}</pre>}
                </td>
                <td className="num">
                  {canRetry && r.status === "failed" && r.destination_masked && (
                    <button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_notify_retry", { p_id: r.id }), "Queued again")) onChanged(); }}>Retry</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && <div className="pad"><button className="btn" onClick={loadMore}>{T.loadMore}</button></div>}
    </div>
  );
}

function EditTemplate({ tpl, onClose, onDone }: { tpl: NotificationTemplate; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const [t, setT] = useState(tpl);
  const field = (k: "title_en" | "body_en" | "title_ar" | "body_ar", label: string, rtl = false, rows = 0) => (
    <div className="fld">
      <label htmlFor={`tp-${k}`}>{label}</label>
      {rows ? (
        <textarea id={`tp-${k}`} className="in" rows={rows} dir={rtl ? "rtl" : undefined} value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
      ) : (
        <input id={`tp-${k}`} className="in" dir={rtl ? "rtl" : undefined} value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
      )}
    </div>
  );
  return (
    <div className="dlg-wide">
      <ReasonDialog
        title={`Edit “${tpl.label}”`}
        body="Keep the {placeholders} — they are replaced with order numbers, names and amounts when the message is sent."
        confirm="Save template"
        extra={
          <>
            <div className="row2">
              {field("title_en", "Title (English)")}
              {field("title_ar", "Title (Arabic)", true)}
            </div>
            <div className="row2">
              {field("body_en", "Message (English)", false, 3)}
              {field("body_ar", "Message (Arabic)", true, 3)}
            </div>
            <div className="checks" style={{ marginBottom: 12 }}>
              {CHANNELS.map(([c, l]) => (
                <label key={c}><input type="checkbox" checked={Boolean(t[c])} onChange={(e) => setT({ ...t, [c]: e.target.checked })} /> {l}</label>
              ))}
            </div>
          </>
        }
        onCancel={onClose}
        onConfirm={async (reason) => {
          const { error } = await save(t, reason);
          if (error) return toast(friendlyError(error), true);
          toast("Template saved");
          onDone();
        }}
      />
    </div>
  );
}
