"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Empty, Kpi, PageHead, ReadOnlyNote, Switch, useAudited, useRun } from "@/components/nws/admin/ui";
import { SET_ADMIN } from "@/components/nws/i18n/settingsAdmin";
import { Modal } from "@/components/nws/ops";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { nearby, simRoute } from "@/lib/ivmsSim";
import { supabase } from "@/lib/supabase/client";

// G11/A6 and C1: the integration API (keys, scopes, request log), outgoing webhooks, and
// IVMS devices with the built-in simulator. Screen text: keys of SET_ADMIN
// (components/nws/i18n/settingsAdmin.ts); scope and event identifiers stay as they are.
const SCOPES: [string, string][] = [
  ["orders:read", "scOrdersR"], ["tankers:read", "scTankersR"], ["permits:read", "scPermitsR"], ["permits:write", "scPermitsW"],
  ["events:write", "scEventsW"], ["ivms:write", "scIvmsW"], ["reports:read", "scReportsR"], ["notify:send", "scNotify"],
];
const EVENTS = ["order.created", "order.accepted", "order.filled", "order.delivered", "order.cancelled", "permit.approved", "permit.rejected", "permit.expiring"];
const DELIVERY_STATUS: Record<string, string> = { queued: "dlQueued", sending: "dlSending", sent: "dlSent", failed: "dlFailed" };

type Key = { id: string; name: string; prefix: string; scopes: string[]; rate_per_min: number; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Req = { id: number; key_id: string | null; method: string; path: string; status: number; rows: number | null; error: string | null; at: string };
type Hook = { id: string; name: string; url: string; events: string[]; active: boolean; created_at: string };
type Delivery = { id: number; endpoint_id: string; event: string; status: string; attempts: number; response_status: number | null; response_body: string | null; signature: string | null; created_at: string; sent_at: string | null; next_attempt_at: string };
type Device = { id: string; tanker_id: string | null; api_key_id: string | null; last_fix_at: string | null; active: boolean };
type Tanker = { id: string; plate: string; is_online: boolean; last_lat: number | null; last_lng: number | null; last_fix_at: string | null; last_fix_source: string | null; last_accuracy_m: number | null };
type Sim = { tanker_id: string; device_id: string; speed_kmh: number; started_at: string; last_tick: string };

const tone = (s: number) => (s < 300 ? "ok" : s === 429 ? "warn" : "bad");

export default function IntegrationsPage() {
  const { can, toast } = useStaff();
  const { ask, dialog } = useAudited();
  const run = useRun();
  const t = useT(SET_ADMIN);
  const f = useFmt();
  const admin = can("admin");
  const operator = can("operator");
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [dels, setDels] = useState<Delivery[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [tankers, setTankers] = useState<Tanker[]>([]);
  const [sims, setSims] = useState<Sim[]>([]);
  const [newKey, setNewKey] = useState(false);
  const [newHook, setNewHook] = useState(false);
  const [shown, setShown] = useState<{ title: string; value: string; note: string } | null>(null);
  const [now, setNow] = useState(0); // time of the last load, for "last hour" counts

  const load = useCallback(() => {
    const db = supabase();
    if (admin) {
      db.from("api_keys").select("id, name, prefix, scopes, rate_per_min, created_at, last_used_at, revoked_at").order("created_at", { ascending: false }).then(({ data }) => setKeys((data ?? []) as Key[]));
      db.from("api_requests").select("id, key_id, method, path, status, rows, error, at").order("id", { ascending: false }).limit(100).then(({ data }) => setReqs((data ?? []) as Req[]));
      db.from("webhook_endpoints").select("id, name, url, events, active, created_at").order("created_at", { ascending: false }).then(({ data }) => setHooks((data ?? []) as Hook[]));
      db.from("webhook_deliveries").select("id, endpoint_id, event, status, attempts, response_status, response_body, signature, created_at, sent_at, next_attempt_at").order("id", { ascending: false }).limit(50).then(({ data }) => setDels((data ?? []) as Delivery[]));
    }
    db.from("devices").select("id, tanker_id, api_key_id, last_fix_at, active").order("id").then(({ data }) => setDevices((data ?? []) as Device[]));
    db.from("tankers").select("id, plate, is_online, last_lat, last_lng, last_fix_at, last_fix_source, last_accuracy_m").eq("on_platform", true).order("plate").then(({ data }) => {
      setNow(Date.now());
      setTankers((data ?? []) as Tanker[]);
    });
    db.from("ivms_sim").select("tanker_id, device_id, speed_kmh, started_at, last_tick").then(({ data }) => setSims((data ?? []) as Sim[]));
  }, [admin]);
  useEffect(load, [load]);

  // While simulations run and this page is open, tick them every 5 s (pg_cron also ticks each minute).
  useEffect(() => {
    if (!sims.length) return;
    const timer = setInterval(() => void supabase().rpc("staff_ivms_sim_tick").then(() => supabase().from("tankers").select("id, plate, is_online, last_lat, last_lng, last_fix_at, last_fix_source, last_accuracy_m").eq("on_platform", true).order("plate").then(({ data }) => setTankers((data ?? []) as Tanker[]))), 5000);
    return () => clearInterval(timer);
  }, [sims.length]);

  const plate = useMemo(() => new Map(tankers.map((x) => [x.id, x.plate])), [tankers]);
  const keyName = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k.name])), [keys]);
  const hookName = useMemo(() => new Map((hooks ?? []).map((h) => [h.id, h.name])), [hooks]);
  const lastHour = (reqs ?? []).filter((r) => Date.parse(r.at) > now - 3600_000);

  async function startSim(tk: Tanker) {
    const from = tk.last_lat != null && tk.last_lng != null ? { lat: tk.last_lat, lng: tk.last_lng } : { lat: 23.588, lng: 58.383 };
    const { data: job } = await supabase().from("orders").select("id, loc:order_locations(lat, lng)").eq("tanker_id", tk.id).in("status", ["accepted", "arriving", "arrived", "collected"]).maybeSingle();
    const loc = (job as { loc: { lat: number; lng: number } | { lat: number; lng: number }[] | null } | null)?.loc;
    const dest = (Array.isArray(loc) ? loc[0] : loc) ?? nearby(from, 3);
    const route = await simRoute(from, dest);
    if (await run(supabase().rpc("staff_ivms_sim_start", { p_tanker_id: tk.id, p_route: route, p_speed_kmh: 40 }), t(job ? "simStartedJob" : "simStartedLoop", { plate: tk.plate }))) load();
  }

  return (
    <>
      <PageHead title={t("navIntegrations")} sub={t("intSub")} />
      {!admin && <ReadOnlyNote who={t("intAdmins")} />}
      <div className="okpis">
        <Kpi label={t("kLiveKeys")} value={keys ? f.n(keys.filter((k) => !k.revoked_at).length) : admin ? "…" : "—"} sub={<bdi dir="ltr">{t("spec")}</bdi>} />
        <Kpi label={t("kCalls")} value={reqs ? f.n(lastHour.length) : admin ? "…" : "—"} sub={t("kCallsS", { n: f.n(lastHour.filter((r) => r.status >= 400).length) })} tone={lastHour.some((r) => r.status >= 500) ? "bad" : undefined} />
        <Kpi label={t("kHooksWait")} value={dels ? f.n(dels.filter((d) => d.status === "queued" || d.status === "sending").length) : admin ? "…" : "—"} sub={t("kHooksWaitS", { n: f.n((dels ?? []).filter((d) => d.status === "failed").length) })} />
        <Kpi label={t("kDevices")} value={devices ? f.n(devices.filter((d) => d.last_fix_at && Date.parse(d.last_fix_at) > now - 600_000).length) : "…"} sub={t("kDevicesS", { n: f.n(devices?.length ?? 0), s: f.n(sims.length) })} />
      </div>

      {admin && (
        <div className="panel">
          <h2>{t("keys")} <small>{t("keysSub")}</small></h2>
          <div className="pad"><button className="btn pri" onClick={() => setNewKey(true)}>{t("createKey")}</button></div>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("integration")}</th><th>{t("key")}</th><th>{t("scopes")}</th><th className="num">{t("limitMin")}</th><th>{t("lastUsed")}</th><th>{t("status")}</th><th></th></tr></thead>
              <tbody>
                {!keys && <Empty cols={7}>{t("loading")}</Empty>}
                {keys?.length === 0 && <Empty cols={7}>{t("noKeys")}</Empty>}
                {keys?.map((k) => (
                  <tr key={k.id}>
                    <td><b>{k.name}</b><small style={{ display: "block" }}>{t("createdAt", { at: f.dateTime(k.created_at) })}</small></td>
                    <td><code dir="ltr">{k.prefix}…</code></td>
                    <td><small dir="ltr">{k.scopes.join(", ")}</small></td>
                    <td className="num">{f.n(k.rate_per_min)}</td>
                    <td>{k.last_used_at ? f.dateTime(k.last_used_at) : t("never")}</td>
                    <td>{k.revoked_at ? <span className="st bad">{t("revoked")}</span> : <span className="st ok">{t("live")}</span>}</td>
                    <td className="num">
                      {!k.revoked_at && (
                        <button className="btn sm bad" onClick={() => ask({ title: t("revokeT", { name: k.name }), body: t("revokeB"), confirm: t("revokeKey"), danger: true, ok: t("keyRevoked"), run: (reason) => supabase().rpc("staff_revoke_api_key", { p_id: k.id, p_reason: reason }), done: load })}>
                          {t("revoke")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {admin && (
        <div className="panel">
          <h2>{t("apiLog")} <small>{t("latest100")}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("time")}</th><th>{t("key")}</th><th>{t("request")}</th><th className="num">{t("status")}</th><th className="num">{t("rowsCol")}</th><th>{t("errorCol")}</th></tr></thead>
              <tbody>
                {!reqs && <Empty cols={6}>{t("loading")}</Empty>}
                {reqs?.length === 0 && <Empty cols={6}>{t("noCalls")}</Empty>}
                {reqs?.map((r) => (
                  <tr key={r.id}>
                    <td><small>{f.dateTime(r.at)}</small></td>
                    <td>{r.key_id ? keyName.get(r.key_id) ?? "—" : <span className="mut">{t("unknownKey")}</span>}</td>
                    <td><code dir="ltr">{r.method} {r.path}</code></td>
                    <td className="num"><span className={`st ${tone(r.status)}`} dir="ltr">{r.status}</span></td>
                    <td className="num">{r.rows != null ? f.n(r.rows) : ""}</td>
                    <td><small dir="ltr">{r.error ?? ""}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {admin && (
        <div className="panel">
          <h2>{t("hooks")} <small>{t("hooksSub")}</small></h2>
          <div className="pad btns">
            <button className="btn pri" onClick={() => setNewHook(true)}>{t("addHook")}</button>
            <button className="btn" onClick={async () => { if (await run(supabase().rpc("staff_webhook_dispatch"), t("hookDispatched"))) load(); }}>{t("deliverNow")}</button>
          </div>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("endpoint")}</th><th>{t("events")}</th><th>{t("active")}</th><th></th></tr></thead>
              <tbody>
                {!hooks && <Empty cols={4}>{t("loading")}</Empty>}
                {hooks?.length === 0 && <Empty cols={4}>{t("noHooks")}</Empty>}
                {hooks?.map((h) => (
                  <tr key={h.id}>
                    <td><b>{h.name}</b><small style={{ display: "block" }} dir="ltr">{h.url}</small></td>
                    <td><small dir="ltr">{h.events.join(", ")}</small></td>
                    <td><Switch on={h.active} label={h.active ? t("active") : t("paused")} onClick={async () => { if (await run(supabase().rpc("staff_set_webhook", { p_id: h.id, p_active: !h.active }), h.active ? t("hookPaused") : t("hookActive"))) load(); }} /></td>
                    <td className="num"><button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_test_webhook", { p_id: h.id }), t("testEventSent"))) load(); }}>{t("sendTestShort")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 style={{ paddingTop: 12 }}>{t("deliveries")} <small>{t("latest50")}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("queuedCol")}</th><th>{t("endpoint")}</th><th>{t("event")}</th><th>{t("status")}</th><th className="num">{t("attempts")}</th><th>{t("responseBtn")}</th><th>{t("signature")}</th></tr></thead>
              <tbody>
                {dels?.length === 0 && <Empty cols={7}>{t("noDeliveries")}</Empty>}
                {dels?.map((d) => (
                  <tr key={d.id}>
                    <td><small>{f.dateTime(d.created_at)}</small></td>
                    <td>{hookName.get(d.endpoint_id) ?? "—"}</td>
                    <td><code dir="ltr">{d.event}</code></td>
                    <td>
                      <span className={`st ${d.status === "sent" ? "ok" : d.status === "failed" ? "bad" : "warn"}`}>{DELIVERY_STATUS[d.status] ? t(DELIVERY_STATUS[d.status]) : d.status}</span>
                      {d.status === "queued" && d.attempts > 0 && <small style={{ display: "block" }}>{t("retryAt", { at: f.dateTime(d.next_attempt_at) })}</small>}
                    </td>
                    <td className="num">{f.n(d.attempts)}</td>
                    <td><small dir="ltr">{d.response_status ?? "—"} {d.response_body ? d.response_body.slice(0, 60) : ""}</small></td>
                    <td><small><code dir="ltr">{d.signature ? `${d.signature.slice(0, 24)}…` : "—"}</code></small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="half">
        <div className="panel">
          <h2>{t("ivms")} <small>{t("ivmsSub")}</small></h2>
          {operator && <RegisterDevice tankers={tankers} keys={(keys ?? []).filter((k) => !k.revoked_at && k.scopes.includes("ivms:write"))} onDone={load} />}
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("device")}</th><th>{t("tanker")}</th><th>{t("integration")}</th><th>{t("lastFix")}</th></tr></thead>
              <tbody>
                {!devices && <Empty cols={4}>{t("loading")}</Empty>}
                {devices?.length === 0 && <Empty cols={4}>{t("noDevices")}</Empty>}
                {devices?.map((d) => (
                  <tr key={d.id}>
                    <td><code dir="ltr">{d.id}</code></td>
                    <td>{d.tanker_id ? <bdi dir="ltr">{plate.get(d.tanker_id) ?? "—"}</bdi> : <span className="mut">{t("unassigned")}</span>}</td>
                    <td>{d.api_key_id ? keyName.get(d.api_key_id) ?? t("keyWord") : <span className="mut">{t("anyIvmsKey")}</span>}</td>
                    <td>{d.last_fix_at ? f.dateTime(d.last_fix_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>{t("sim")} <small>{t("simSub")}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>{t("tanker")}</th><th>{t("lastFix")}</th><th className="num">{t("accuracy")}</th><th></th></tr></thead>
              <tbody>
                {tankers.length === 0 && <Empty cols={4}>{t("loading")}</Empty>}
                {tankers.map((tk) => {
                  const sim = sims.find((s) => s.tanker_id === tk.id);
                  return (
                    <tr key={tk.id}>
                      <td><b dir="ltr">{tk.plate}</b>{tk.is_online && <span className="st ok ptag">{t("onlineTag")}</span>}</td>
                      <td>{tk.last_fix_source ? <span className={`st ${tk.last_fix_source === "ivms" ? "ok" : "act"}`}>{tk.last_fix_source === "ivms" ? t("srcIvms") : tk.last_fix_source === "simulated" ? t("srcSim") : t("srcPhone")}</span> : "—"} <small>{tk.last_fix_at ? f.dateTime(tk.last_fix_at) : ""}</small></td>
                      <td className="num">{tk.last_accuracy_m != null ? t("accM", { n: f.n(tk.last_accuracy_m) }) : "—"}</td>
                      <td className="num">
                        {operator && (sim ? (
                          <button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_ivms_sim_stop", { p_tanker_id: tk.id }), t("simStopped", { plate: tk.plate }))) load(); }}>{t("stop")}</button>
                        ) : (
                          <button className="btn sm" onClick={() => void startSim(tk)}>{t("simIvms")}</button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">{t("simNote")}</p>
        </div>
      </div>

      {newKey && <NewKey onClose={() => setNewKey(false)} onDone={(v) => { setNewKey(false); setShown({ title: t("newKeyT"), value: v, note: t("keyOnce") }); load(); }} />}
      {newHook && <NewHook onClose={() => setNewHook(false)} onDone={(v) => { setNewHook(false); setShown({ title: t("secretT"), value: v, note: t("secretOnce") }); load(); }} />}
      {shown && (
        <ConfirmDialog
          title={shown.title}
          body={<><p>{shown.note}</p><code dir="ltr" style={{ wordBreak: "break-all", display: "block", padding: 8, background: "var(--bg2, #f3f5f6)" }}>{shown.value}</code></>}
          confirm={t("copyClose")}
          onCancel={() => setShown(null)}
          onConfirm={async () => {
            try {
              await navigator.clipboard.writeText(shown.value);
              toast(t("copied"));
            } catch {
              toast(t("copyByHand"), true);
              return;
            }
            setShown(null);
          }}
        />
      )}
      {dialog}
    </>
  );
}

function NewKey({ onClose, onDone }: { onClose: () => void; onDone: (key: string) => void }) {
  const { toast } = useStaff();
  const t = useT(SET_ADMIN);
  const { lang } = useLang();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["orders:read"]);
  const [rate, setRate] = useState("120");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t("createKey")} onClose={onClose}>
      <div className="fld">
        <label htmlFor="ak-n">{t("intName")}</label>
        <input id="ak-n" className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("intNamePh")} autoFocus />
      </div>
      <div className="fld">
        <label>{t("scopes")}</label>
        <div className="checks" style={{ display: "grid", gap: 4 }}>
          {SCOPES.map(([s, l]) => (
            <label key={s}><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {t(l)} <code dir="ltr">{s}</code></label>
          ))}
        </div>
      </div>
      <div className="fld">
        <label htmlFor="ak-r">{t("perMin")}</label>
        <input id="ak-r" className="in" type="number" dir="ltr" min={1} max={10000} value={rate} onChange={(e) => setRate(e.target.value)} />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>{t("cancel")}</button>
        <button
          className="btn pri"
          disabled={busy || name.trim().length < 3 || scopes.length === 0}
          onClick={async () => {
            setBusy(true);
            const { data, error } = await supabase().rpc("staff_create_api_key", { p_name: name.trim(), p_scopes: scopes, p_rate_per_min: Number(rate) || 120 });
            setBusy(false);
            if (error) return toast(friendlyError(error, lang), true);
            onDone((data as { key: string }).key);
          }}
        >
          {busy ? t("creating") : t("createKeyBtn")}
        </button>
      </div>
    </Modal>
  );
}

function NewHook({ onClose, onDone }: { onClose: () => void; onDone: (secret: string) => void }) {
  const { toast } = useStaff();
  const t = useT(SET_ADMIN);
  const { lang } = useLang();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("simulate://receiver");
  const [events, setEvents] = useState<string[]>(["order.created", "order.delivered", "permit.approved"]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t("addHook")} onClose={onClose}>
      <div className="fld">
        <label htmlFor="wh-n">{t("name")}</label>
        <input id="wh-n" className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("hookNamePh")} autoFocus />
      </div>
      <div className="fld">
        <label htmlFor="wh-u">{t("hookUrl")}</label>
        <input id="wh-u" className="in" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="fld">
        <label>{t("events")}</label>
        <div className="checks" style={{ display: "grid", gap: 4 }}>
          {EVENTS.map((e) => (
            <label key={e}><input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} /> <code dir="ltr">{e}</code></label>
          ))}
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>{t("cancel")}</button>
        <button
          className="btn pri"
          disabled={busy || name.trim().length < 3 || events.length === 0}
          onClick={async () => {
            setBusy(true);
            const { data, error } = await supabase().rpc("staff_create_webhook", { p_name: name.trim(), p_url: url.trim(), p_events: events });
            setBusy(false);
            if (error) return toast(friendlyError(error, lang), true);
            onDone((data as { secret: string }).secret);
          }}
        >
          {busy ? t("adding") : t("addHook")}
        </button>
      </div>
    </Modal>
  );
}

function RegisterDevice({ tankers, keys, onDone }: { tankers: Tanker[]; keys: Key[]; onDone: () => void }) {
  const run = useRun();
  const t = useT(SET_ADMIN);
  const [id, setId] = useState("IV-");
  const [tanker, setTanker] = useState("");
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="pad" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
      <input className="in" dir="ltr" style={{ maxWidth: 130 }} value={id} onChange={(e) => setId(e.target.value.toUpperCase())} aria-label={t("deviceId")} placeholder="IV-12345" />
      <select className="in" style={{ maxWidth: 180 }} value={tanker} onChange={(e) => setTanker(e.target.value)} aria-label={t("tanker")}>
        <option value="">{t("tankerPick")}</option>
        {tankers.map((x) => <option key={x.id} value={x.id}>{x.plate}</option>)}
      </select>
      <select className="in" style={{ maxWidth: 200 }} value={key} onChange={(e) => setKey(e.target.value)} aria-label={t("intKey")}>
        <option value="">{t("anyIvmsKeyOpt")}</option>
        {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
      </select>
      <button className="btn" disabled={!/^IV-\d{4,6}$/.test(id) || !tanker} onClick={() => setConfirm(true)}>{t("registerDevice")}</button>
      {confirm && (
        <ConfirmDialog
          title={t("registerT", { id })}
          body={t("registerB", { id, plate: tankers.find((x) => x.id === tanker)?.plate ?? "" })}
          confirm={t("register")}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            if (await run(supabase().rpc("staff_register_device", { p_device_id: id, p_tanker_id: tanker, p_api_key_id: key || null }), t("registered", { id }))) onDone();
            setConfirm(false);
          }}
        />
      )}
    </div>
  );
}
