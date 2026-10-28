"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, fetchPaged, int, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { NotificationTemplate } from "@/lib/types";

const AUDIENCE: Record<string, string> = { customer: "Customer", driver: "Driver", owner: "Tanker owner", business: "Business" };
type Channel = "sms" | "push" | "whatsapp";
const CHANNELS: [Channel, string][] = [["sms", "SMS"], ["push", "Push"], ["whatsapp", "WhatsApp"]];

const save = (t: NotificationTemplate, reason: string) =>
  supabase().rpc("staff_update_template", {
    p_event: t.event, p_push: t.push, p_sms: t.sms, p_whatsapp: t.whatsapp,
    p_title_en: t.title_en, p_body_en: t.body_en, p_title_ar: t.title_ar, p_body_ar: t.body_ar, p_reason: reason,
  });

export default function NotificationsPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const [tpl, setTpl] = useState<NotificationTemplate[] | null>(null);
  const [sent, setSent] = useState<Map<string, number> | null>(null);
  const [edit, setEdit] = useState<NotificationTemplate | null>(null);
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("notification_templates").select("*").order("audience").order("event").then(({ data }) => setTpl((data ?? []) as NotificationTemplate[]));
    const from = new Date(Date.now() - 30 * 86400_000).toISOString();
    fetchPaged<{ event: string }>((a, b) => db.from("notifications").select("event").gte("created_at", from).order("id").range(a, b), 50000).then(({ rows }) => {
      const m = new Map<string, number>();
      for (const n of rows) m.set(n.event, (m.get(n.event) ?? 0) + 1);
      setSent(m);
    });
  }, []);
  useEffect(load, [load]);

  function toggle(t: NotificationTemplate, c: Channel) {
    const label = CHANNELS.find((x) => x[0] === c)![1];
    ask({
      title: `${t[c] ? "Turn off" : "Turn on"} ${label} for “${t.label}”`,
      confirm: t[c] ? `Turn off ${label}` : `Turn on ${label}`,
      ok: "Template updated",
      run: (reason) => save({ ...t, [c]: !t[c] }, reason),
      done: load,
    });
  }

  const total = sent ? [...sent.values()].reduce((a, n) => a + n, 0) : null;
  return (
    <>
      <PageHead title="Notifications" sub="What customers, drivers, owners and business users are told at each step, in English and Arabic, and on which channels." />
      {!admin && <ReadOnlyNote who="a Super admin" />}
      <div className="panel">
        <h2>Notification templates <small>English and Arabic · {"{placeholders}"} are filled in automatically</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Event</th><th>Audience</th><th>SMS</th><th>Push</th><th>WhatsApp</th><th>English</th><th>Arabic</th><th className="num">Sent, 30 days</th><th></th></tr>
            </thead>
            <tbody>
              {!tpl && <Empty cols={9}>Loading…</Empty>}
              {tpl?.map((t) => (
                <tr key={t.event}>
                  <td>{t.label}<small style={{ display: "block" }}><code>{t.event}</code></small></td>
                  <td>{AUDIENCE[t.audience] ?? t.audience}</td>
                  {CHANNELS.map(([c, l]) => (
                    <td key={c}><Switch on={t[c]} disabled={!admin} label={l} onClick={() => toggle(t, c)} /></td>
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
        <p className="note">
          {total != null && <>{int(total)} notifications sent in the last 30 days. </>}
          Customers can turn individual channels off in their app, except order-critical SMS. SMS and WhatsApp delivery is simulated (messages are logged, not sent).
        </p>
      </div>
      {edit && <EditTemplate tpl={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      {dialog}
    </>
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
                <label key={c}><input type="checkbox" checked={t[c]} onChange={(e) => setT({ ...t, [c]: e.target.checked })} /> {l}</label>
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
