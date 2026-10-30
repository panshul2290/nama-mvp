"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Chips, Empty, Kpi, PageHead, ReadOnlyNote, Switch, useAudited, useRun } from "@/components/nws/admin/ui";
import { SET_ADMIN } from "@/components/nws/i18n/settingsAdmin";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { NotificationTemplate, OutboxRow } from "@/lib/types";

// Screen text: keys of SET_ADMIN (components/nws/i18n/settingsAdmin.ts).
const AUDIENCE: Record<string, string> = { customer: "audCustomer", driver: "audDriver", owner: "audOwner", business: "audBusiness", staff: "audStaff" };
const CATEGORY: Record<string, string> = { service: "catService", reminder: "catReminder", marketing: "catMarketing" };
type Channel = "sms" | "push" | "whatsapp" | "email";
const CHANNELS: [Channel, string][] = [["sms", "chSms"], ["push", "chPush"], ["whatsapp", "chWhatsapp"], ["email", "chEmail"]];
const PROVIDER: Record<string, string> = { simulated: "provSimulated", external: "provExternal", off: "provOff" };
const STATUS_TONE: Record<OutboxRow["status"], string> = { queued: "warn", sent: "ok", failed: "bad" };
const STATUS_LABEL: Record<OutboxRow["status"], string> = { queued: "stQueued", sent: "stSent", failed: "stFailed" };
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
  const t = useT(SET_ADMIN);
  const f = useFmt();
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

  function toggle(tp: NotificationTemplate, c: Channel) {
    const ch = t(CHANNELS.find((x) => x[0] === c)![1]);
    const on = Boolean(tp[c]);
    ask({
      title: t(on ? "toggleOffT" : "toggleOnT", { ch, name: tp.label }),
      confirm: t(on ? "turnOff" : "turnOn", { ch }),
      ok: t("tplUpdated"),
      run: (reason) => save({ ...tp, [c]: !on }, reason),
      done: reload,
    });
  }

  function setProvider(c: Channel, p: string) {
    if (!cfg) return;
    ask({
      title: `${t(CHANNELS.find((x) => x[0] === c)![1])}: ${t(PROVIDER[p])}`,
      body: p === "external" ? t("provB_external") : p === "off" ? t("provB_off") : t("provB_sim"),
      confirm: t("changeProvider"),
      ok: t("deliverySaved"),
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "NOTIFY", p_value: { ...cfg, providers: { ...cfg.providers, [c]: p } }, p_reason: reason }),
      done: reload,
    });
  }

  const live = (stats ?? []).filter((s) => !s.is_test);
  const sum = (fn: (s: Stat) => boolean) => live.filter(fn).reduce((a, s) => a + s.n, 0);
  const testN = (stats ?? []).filter((s) => s.is_test).reduce((a, s) => a + s.n, 0);
  const total30 = sent ? [...sent.values()].reduce((a, n) => a + n, 0) : null;

  return (
    <>
      <PageHead title={t("navNotifications")} sub={t("notifSub")}>
        {operator && <button className="btn" onClick={async () => { if (await run(supabase().rpc("dispatch_notifications"), t("dispatcherRan"))) reload(); }}>{t("runNow")}</button>}
      </PageHead>
      {!admin && <ReadOnlyNote who={t("superAdmin")} />}
      <div className="okpis">
        <Kpi label={t("kSent7")} value={stats ? f.n(sum((s) => s.status === "sent")) : "…"} sub={CHANNELS.map(([c, l]) => `${t(l)} ${f.n(sum((s) => s.channel === c && s.status === "sent"))}`).join(" · ")} tone="ok" />
        <Kpi label={t("kQueued")} value={stats ? f.n(sum((s) => s.status === "queued")) : "…"} sub={t("kQueuedS")} tone={sum((s) => s.status === "queued") ? "warn" : undefined} />
        <Kpi label={t("kFailed7")} value={stats ? f.n(sum((s) => s.status === "failed")) : "…"} sub={t("kFailedS")} tone={sum((s) => s.status === "failed") ? "bad" : undefined} />
        <Kpi label={t("kTest")} value={stats ? f.n(testN) : "…"} sub={t("kTestS")} />
      </div>

      <div className="panel">
        <h2>{t("delivery")} <small>{t("deliverySub")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("channel")}</th><th>{t("provider")}</th><th className="num">{t("attemptsBefore")}</th><th></th></tr></thead>
            <tbody>
              {!cfg && <Empty cols={4}>{t("loading")}</Empty>}
              {cfg && CHANNELS.map(([c, l]) => (
                <tr key={c}>
                  <td>{t(l)}{c === "sms" && cfg.sender_id ? <small style={{ display: "block" }}>{t("senderId", { id: cfg.sender_id })}</small> : null}</td>
                  <td>
                    <select className="in" style={{ maxWidth: 220 }} value={cfg.providers[c] ?? "simulated"} disabled={!admin} onChange={(e) => setProvider(c, e.target.value)} aria-label={t("providerOf", { ch: t(l) })}>
                      {Object.entries(PROVIDER).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
                    </select>
                  </td>
                  <td className="num">{f.n(cfg.max_attempts)}</td>
                  <td className="num">
                    {admin && (
                      <button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_notify_test", { p_channel: c }), t("testQueued", { ch: t(l) }))) reload(); }}>{t("sendTest")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{t("simulatedNote")}</p>
      </div>

      <Outbox key={tick} canRetry={operator} onChanged={reload} />

      <div className="panel">
        <h2>{t("templates")} <small>{t("templatesSub")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>{t("event")}</th><th>{t("audience")}</th>{CHANNELS.map(([, l]) => <th key={l}>{t(l)}</th>)}<th>{t("english")}</th><th>{t("arabic")}</th><th className="num">{t("inApp30")}</th><th></th></tr>
            </thead>
            <tbody>
              {!tpl && <Empty cols={11}>{t("loading")}</Empty>}
              {tpl?.map((tp) => (
                <tr key={tp.event}>
                  <td>
                    {tp.label}
                    <small style={{ display: "block" }}><code dir="ltr">{tp.event}</code> · {t(CATEGORY[tp.category ?? "service"] ?? "catService")}{tp.critical ? t("orderCritical") : ""}</small>
                  </td>
                  <td>{AUDIENCE[tp.audience] ? t(AUDIENCE[tp.audience]) : tp.audience}</td>
                  {CHANNELS.map(([c, l]) => (
                    <td key={c}><Switch on={Boolean(tp[c])} disabled={!admin} label={t(l)} onClick={() => toggle(tp, c)} /></td>
                  ))}
                  <td className="tpl" dir="ltr" lang="en"><b>{tp.title_en}</b><small>{tp.body_en}</small></td>
                  <td className="tpl" dir="rtl" lang="ar"><b>{tp.title_ar}</b><small>{tp.body_ar}</small></td>
                  <td className="num">{sent ? f.n(sent.get(tp.event) ?? 0) : "…"}</td>
                  <td className="num">{admin && <button className="btn sm" onClick={() => setEdit(tp)}>{t("edit")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total30 != null && <p className="note">{t("total30", { n: f.n(total30) })}</p>}
      </div>
      {edit && <EditTemplate tpl={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {dialog}
    </>
  );
}

function Outbox({ canRetry, onChanged }: { canRetry: boolean; onChanged: () => void }) {
  const run = useRun();
  const t = useT(SET_ADMIN);
  const f = useFmt();
  const { lang } = useLang();
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
      setErr(error ? friendlyError(error, lang) : null);
      const got = (data ?? []) as unknown as Row[];
      setRows(got);
      setMore(got.length === PAGE);
    });
    return () => {
      live = false;
    };
  }, [query, lang]);

  async function loadMore() {
    const { data, error } = await query(rows?.length ?? 0);
    if (error) return setErr(friendlyError(error, lang));
    const got = (data ?? []) as unknown as Row[];
    setRows((r) => [...(r ?? []), ...got]);
    setMore(got.length === PAGE);
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return m;
  }, [rows]);

  const channelChips: ["all" | Channel, string][] = [["all", t("allChannels")], ...CHANNELS.map(([c, l]): [Channel, string] => [c, t(l)])];

  return (
    <div className="panel">
      <h2>{t("outbox")} <small>{t("outboxSub")}</small></h2>
      <div className="pad" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <Chips items={channelChips} value={channel} onChange={setChannel} />
        <Chips items={[["all", t("anyStatus")], ["queued", t("stQueued"), counts.get("queued")], ["sent", t("stSent"), counts.get("sent")], ["failed", t("stFailed"), counts.get("failed")]]} value={status} onChange={setStatus} />
        <input className="in" style={{ maxWidth: 180 }} placeholder={t("eventPh")} value={event} onChange={(e) => setEvent(e.target.value)} aria-label={t("filterEvent")} />
        <input className="in" style={{ maxWidth: 220 }} placeholder={t("searchMsg")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("searchMsg")} />
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> {t("inclTest")}</label>
      </div>
      {err && <div className="banner badb">{err}</div>}
      <div className="tblwrap">
        <table>
          <thead><tr><th>{t("queuedCol")}</th><th>{t("toCol")}</th><th>{t("event")}</th><th>{t("channel")}</th><th>{t("message")}</th><th>{t("status")}</th><th className="num">{t("attempts")}</th><th>{t("provider")}</th><th></th></tr></thead>
          <tbody>
            {!rows && <Empty cols={9}>{t("loading")}</Empty>}
            {rows?.length === 0 && <Empty cols={9}>{t("noMsgs")}</Empty>}
            {rows?.map((r) => {
              const ch = CHANNELS.find(([c]) => c === r.channel)?.[1];
              return (
                <tr key={r.id}>
                  <td>{f.dateTime(r.created_at)}{r.sent_at && <small style={{ display: "block" }}>{t("sentAt", { at: f.dateTime(r.sent_at) })}</small>}</td>
                  <td>{r.user?.full_name || "—"}<small style={{ display: "block" }} dir="ltr">{r.destination_masked ?? "—"}</small></td>
                  <td><code dir="ltr">{r.event}</code>{r.is_test && <span className="st warn ptag">{t("testTag")}</span>}</td>
                  <td>{ch ? t(ch) : r.channel}<small style={{ display: "block" }}>{r.lang === "ar" ? t("arabic") : t("english")}</small></td>
                  <td className="tpl" dir={r.lang === "ar" ? "rtl" : "ltr"}><b>{r.title}</b><small>{r.body}</small></td>
                  <td>
                    <span className={`st ${STATUS_TONE[r.status]}`}>{t(STATUS_LABEL[r.status])}</span>
                    {r.error && <small style={{ display: "block" }} className="bad">{r.error}</small>}
                    {r.status === "queued" && r.attempts > 0 && <small style={{ display: "block" }}>{t("nextTry", { at: f.dateTime(r.next_attempt_at) })}</small>}
                  </td>
                  <td className="num">{f.n(r.attempts)}</td>
                  <td>
                    {r.provider ?? "—"}
                    {r.provider_ref && <small style={{ display: "block" }}><code dir="ltr">{r.provider_ref}</code></small>}
                    {r.provider_response && (
                      <button className="btn sm ghost" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{t("responseBtn")}</button>
                    )}
                    {open === r.id && <pre dir="ltr" style={{ fontSize: 11, whiteSpace: "pre-wrap", maxWidth: 260 }}>{JSON.stringify(r.provider_response, null, 1)}</pre>}
                  </td>
                  <td className="num">
                    {canRetry && r.status === "failed" && r.destination_masked && (
                      <button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_notify_retry", { p_id: r.id }), t("queuedAgain"))) onChanged(); }}>{t("retry")}</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {more && <div className="pad"><button className="btn" onClick={loadMore}>{t("loadMore")}</button></div>}
    </div>
  );
}

function EditTemplate({ tpl, onClose, onDone }: { tpl: NotificationTemplate; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const tr = useT(SET_ADMIN);
  const { lang } = useLang();
  const [t, setT] = useState(tpl);
  const field = (k: "title_en" | "body_en" | "title_ar" | "body_ar", label: string, rtl = false, rows = 0) => (
    <div className="fld">
      <label htmlFor={`tp-${k}`}>{label}</label>
      {rows ? (
        <textarea id={`tp-${k}`} className="in" rows={rows} dir={rtl ? "rtl" : "ltr"} value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
      ) : (
        <input id={`tp-${k}`} className="in" dir={rtl ? "rtl" : "ltr"} value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
      )}
    </div>
  );
  return (
    <div className="dlg-wide">
      <ReasonDialog
        title={tr("editTpl", { name: tpl.label })}
        body={tr("editTplB")}
        confirm={tr("saveTpl")}
        extra={
          <>
            <div className="row2">
              {field("title_en", tr("titleEn"))}
              {field("title_ar", tr("titleAr"), true)}
            </div>
            <div className="row2">
              {field("body_en", tr("bodyEn"), false, 3)}
              {field("body_ar", tr("bodyAr"), true, 3)}
            </div>
            <div className="checks" style={{ marginBottom: 12 }}>
              {CHANNELS.map(([c, l]) => (
                <label key={c}><input type="checkbox" checked={Boolean(t[c])} onChange={(e) => setT({ ...t, [c]: e.target.checked })} /> {tr(l)}</label>
              ))}
            </div>
          </>
        }
        onCancel={onClose}
        onConfirm={async (reason) => {
          const { error } = await save(t, reason);
          if (error) return toast(friendlyError(error, lang), true);
          toast(tr("tplSaved"));
          onDone();
        }}
      />
    </div>
  );
}
