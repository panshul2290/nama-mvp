"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Empty, Kpi, PageHead, ReadOnlyNote, Switch, useAudited, useRun } from "@/components/nws/admin/ui";
import { Modal } from "@/components/nws/ops";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { nearby, simRoute } from "@/lib/ivmsSim";
import { supabase } from "@/lib/supabase/client";

// G11/A6 and C1: the integration API (keys, scopes, request log), outgoing webhooks, and
// IVMS devices with the built-in simulator. Screen text in one place (Arabic comes later).
const T = {
  title: "Integrations",
  sub: "API keys for NWS and partner systems (TAS, TFS/STP, IVMS, BI), outgoing webhooks, and IVMS devices.",
  keys: "API keys",
  keysSub: "each integration has its own key · only a hash is stored",
  log: "API requests",
  logSub: "latest 100",
  hooks: "Webhooks",
  hooksSub: "order and permit events · HMAC-SHA256 signed · retried with backoff",
  deliveries: "Webhook deliveries",
  ivms: "IVMS devices",
  ivmsSub: "fixes arrive through POST /api/v1/ivms/fixes with an ivms:write key",
  sim: "IVMS simulator",
  simSub: "moves chosen tankers along a road route through the same IVMS ingestion",
  keyOnce: "Copy this key now — it is shown only once.",
  secretOnce: "Copy the signing secret now — it is shown only once. Receivers check X-Nama-Signature (docs/api/openapi.yaml).",
  spec: "Spec: docs/api/openapi.yaml · base URL /api/v1 · Authorization: Bearer <key>",
};
const SCOPES: [string, string][] = [
  ["orders:read", "Orders (read)"], ["tankers:read", "Tankers (read)"], ["permits:read", "Permits (read)"], ["permits:write", "Permit decisions (TAS)"],
  ["events:write", "Fill / discharge meter events (TFS, STP)"], ["ivms:write", "IVMS fixes"], ["reports:read", "Reporting export (BI / DWH)"], ["notify:send", "Notification gateway worker"],
];
const EVENTS = ["order.created", "order.accepted", "order.filled", "order.delivered", "order.cancelled", "permit.approved", "permit.rejected", "permit.expiring"];

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
    const t = setInterval(() => void supabase().rpc("staff_ivms_sim_tick").then(() => supabase().from("tankers").select("id, plate, is_online, last_lat, last_lng, last_fix_at, last_fix_source, last_accuracy_m").eq("on_platform", true).order("plate").then(({ data }) => setTankers((data ?? []) as Tanker[]))), 5000);
    return () => clearInterval(t);
  }, [sims.length]);

  const plate = useMemo(() => new Map(tankers.map((t) => [t.id, t.plate])), [tankers]);
  const keyName = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k.name])), [keys]);
  const hookName = useMemo(() => new Map((hooks ?? []).map((h) => [h.id, h.name])), [hooks]);
  const lastHour = (reqs ?? []).filter((r) => Date.parse(r.at) > now - 3600_000);

  async function startSim(t: Tanker) {
    const from = t.last_lat != null && t.last_lng != null ? { lat: t.last_lat, lng: t.last_lng } : { lat: 23.588, lng: 58.383 };
    const { data: job } = await supabase().from("orders").select("id, loc:order_locations(lat, lng)").eq("tanker_id", t.id).in("status", ["accepted", "arriving", "arrived", "collected"]).maybeSingle();
    const loc = (job as { loc: { lat: number; lng: number } | { lat: number; lng: number }[] | null } | null)?.loc;
    const dest = (Array.isArray(loc) ? loc[0] : loc) ?? nearby(from, 3);
    const route = await simRoute(from, dest);
    if (await run(supabase().rpc("staff_ivms_sim_start", { p_tanker_id: t.id, p_route: route, p_speed_kmh: 40 }), `${t.plate}: IVMS simulator started (${job ? "to its job" : "a 3 km loop"})`)) load();
  }

  return (
    <>
      <PageHead title={T.title} sub={T.sub} />
      {!admin && <ReadOnlyNote who="Super admins (keys and webhooks); operators run the IVMS simulator" />}
      <div className="okpis">
        <Kpi label="Live API keys" value={keys ? keys.filter((k) => !k.revoked_at).length : admin ? "…" : "—"} sub={T.spec} />
        <Kpi label="API calls, last hour" value={reqs ? lastHour.length : admin ? "…" : "—"} sub={`${lastHour.filter((r) => r.status >= 400).length} refused or failed`} tone={lastHour.some((r) => r.status >= 500) ? "bad" : undefined} />
        <Kpi label="Webhook deliveries waiting" value={dels ? dels.filter((d) => d.status === "queued" || d.status === "sending").length : admin ? "…" : "—"} sub={`${(dels ?? []).filter((d) => d.status === "failed").length} failed for good`} />
        <Kpi label="IVMS devices reporting" value={devices ? devices.filter((d) => d.last_fix_at && Date.parse(d.last_fix_at) > now - 600_000).length : "…"} sub={`of ${devices?.length ?? 0} registered · ${sims.length} simulated`} />
      </div>

      {admin && (
        <div className="panel">
          <h2>{T.keys} <small>{T.keysSub}</small></h2>
          <div className="pad"><button className="btn pri" onClick={() => setNewKey(true)}>Create API key</button></div>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Integration</th><th>Key</th><th>Scopes</th><th className="num">Limit / min</th><th>Last used</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {!keys && <Empty cols={7}>Loading…</Empty>}
                {keys?.length === 0 && <Empty cols={7}>No API keys yet.</Empty>}
                {keys?.map((k) => (
                  <tr key={k.id}>
                    <td><b>{k.name}</b><small style={{ display: "block" }}>created {fmtDateTime(k.created_at)}</small></td>
                    <td><code>{k.prefix}…</code></td>
                    <td><small>{k.scopes.join(", ")}</small></td>
                    <td className="num">{k.rate_per_min}</td>
                    <td>{k.last_used_at ? fmtDateTime(k.last_used_at) : "Never"}</td>
                    <td>{k.revoked_at ? <span className="st bad">Revoked</span> : <span className="st ok">Live</span>}</td>
                    <td className="num">
                      {!k.revoked_at && (
                        <button className="btn sm bad" onClick={() => ask({ title: `Revoke “${k.name}”`, body: "Calls with this key are refused at once. Create a new key for the integration first if it must keep working.", confirm: "Revoke key", danger: true, ok: "Key revoked", run: (reason) => supabase().rpc("staff_revoke_api_key", { p_id: k.id, p_reason: reason }), done: load })}>
                          Revoke
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
          <h2>{T.log} <small>{T.logSub}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Time</th><th>Key</th><th>Request</th><th className="num">Status</th><th className="num">Rows</th><th>Error</th></tr></thead>
              <tbody>
                {!reqs && <Empty cols={6}>Loading…</Empty>}
                {reqs?.length === 0 && <Empty cols={6}>No API calls yet.</Empty>}
                {reqs?.map((r) => (
                  <tr key={r.id}>
                    <td><small>{fmtDateTime(r.at)}</small></td>
                    <td>{r.key_id ? keyName.get(r.key_id) ?? "—" : <span className="mut">unknown key</span>}</td>
                    <td><code>{r.method} {r.path}</code></td>
                    <td className="num"><span className={`st ${tone(r.status)}`}>{r.status}</span></td>
                    <td className="num">{r.rows ?? ""}</td>
                    <td><small>{r.error ?? ""}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {admin && (
        <div className="panel">
          <h2>{T.hooks} <small>{T.hooksSub}</small></h2>
          <div className="pad btns">
            <button className="btn pri" onClick={() => setNewHook(true)}>Add webhook</button>
            <button className="btn" onClick={async () => { if (await run(supabase().rpc("staff_webhook_dispatch"), "Webhook dispatcher ran")) load(); }}>Deliver now</button>
          </div>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Endpoint</th><th>Events</th><th>Active</th><th></th></tr></thead>
              <tbody>
                {!hooks && <Empty cols={4}>Loading…</Empty>}
                {hooks?.length === 0 && <Empty cols={4}>No webhooks yet.</Empty>}
                {hooks?.map((h) => (
                  <tr key={h.id}>
                    <td><b>{h.name}</b><small style={{ display: "block" }} dir="ltr">{h.url}</small></td>
                    <td><small>{h.events.join(", ")}</small></td>
                    <td><Switch on={h.active} label={h.active ? "Active" : "Paused"} onClick={async () => { if (await run(supabase().rpc("staff_set_webhook", { p_id: h.id, p_active: !h.active }), h.active ? "Webhook paused" : "Webhook active")) load(); }} /></td>
                    <td className="num"><button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_test_webhook", { p_id: h.id }), "Test event sent")) load(); }}>Send test</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 style={{ paddingTop: 12 }}>{T.deliveries} <small>latest 50</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Queued</th><th>Endpoint</th><th>Event</th><th>Status</th><th className="num">Attempts</th><th>Response</th><th>Signature</th></tr></thead>
              <tbody>
                {dels?.length === 0 && <Empty cols={7}>No deliveries yet.</Empty>}
                {dels?.map((d) => (
                  <tr key={d.id}>
                    <td><small>{fmtDateTime(d.created_at)}</small></td>
                    <td>{hookName.get(d.endpoint_id) ?? "—"}</td>
                    <td><code>{d.event}</code></td>
                    <td>
                      <span className={`st ${d.status === "sent" ? "ok" : d.status === "failed" ? "bad" : "warn"}`}>{d.status}</span>
                      {d.status === "queued" && d.attempts > 0 && <small style={{ display: "block" }}>retry {fmtDateTime(d.next_attempt_at)}</small>}
                    </td>
                    <td className="num">{d.attempts}</td>
                    <td><small>{d.response_status ?? "—"} {d.response_body ? d.response_body.slice(0, 60) : ""}</small></td>
                    <td><small><code>{d.signature ? `${d.signature.slice(0, 24)}…` : "—"}</code></small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="half">
        <div className="panel">
          <h2>{T.ivms} <small>{T.ivmsSub}</small></h2>
          {operator && <RegisterDevice tankers={tankers} keys={(keys ?? []).filter((k) => !k.revoked_at && k.scopes.includes("ivms:write"))} onDone={load} />}
          <div className="tblwrap">
            <table>
              <thead><tr><th>Device</th><th>Tanker</th><th>Integration</th><th>Last fix</th></tr></thead>
              <tbody>
                {!devices && <Empty cols={4}>Loading…</Empty>}
                {devices?.length === 0 && <Empty cols={4}>No devices registered.</Empty>}
                {devices?.map((d) => (
                  <tr key={d.id}>
                    <td><code>{d.id}</code></td>
                    <td>{d.tanker_id ? plate.get(d.tanker_id) ?? "—" : <span className="mut">unassigned</span>}</td>
                    <td>{d.api_key_id ? keyName.get(d.api_key_id) ?? "key" : <span className="mut">any IVMS key</span>}</td>
                    <td>{d.last_fix_at ? fmtDateTime(d.last_fix_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>{T.sim} <small>{T.simSub}</small></h2>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Tanker</th><th>Last fix</th><th className="num">Accuracy</th><th></th></tr></thead>
              <tbody>
                {tankers.length === 0 && <Empty cols={4}>Loading…</Empty>}
                {tankers.map((t) => {
                  const sim = sims.find((s) => s.tanker_id === t.id);
                  return (
                    <tr key={t.id}>
                      <td><b>{t.plate}</b>{t.is_online && <span className="st ok ptag">online</span>}</td>
                      <td>{t.last_fix_source ? <span className={`st ${t.last_fix_source === "ivms" ? "ok" : "act"}`}>{t.last_fix_source === "ivms" ? "IVMS" : t.last_fix_source === "simulated" ? "Simulated" : "Phone"}</span> : "—"} <small>{t.last_fix_at ? fmtDateTime(t.last_fix_at) : ""}</small></td>
                      <td className="num">{t.last_accuracy_m != null ? `±${Math.round(t.last_accuracy_m)} m` : "—"}</td>
                      <td className="num">
                        {operator && (sim ? (
                          <button className="btn sm" onClick={async () => { if (await run(supabase().rpc("staff_ivms_sim_stop", { p_tanker_id: t.id }), `${t.plate}: simulator stopped`)) load(); }}>Stop</button>
                        ) : (
                          <button className="btn sm" onClick={() => void startSim(t)}>Simulate IVMS</button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">A simulated tanker reports an IVMS fix (±3 m) every few seconds while this page or Live operations is open, and every minute otherwise. It drives to its current job, or a 3 km loop, and back. The phone stops overriding its position while the IVMS feed is live.</p>
        </div>
      </div>

      {newKey && <NewKey onClose={() => setNewKey(false)} onDone={(v) => { setNewKey(false); setShown({ title: "New API key", value: v, note: T.keyOnce }); load(); }} />}
      {newHook && <NewHook onClose={() => setNewHook(false)} onDone={(v) => { setNewHook(false); setShown({ title: "Webhook signing secret", value: v, note: T.secretOnce }); load(); }} />}
      {shown && (
        <ConfirmDialog
          title={shown.title}
          body={<><p>{shown.note}</p><code style={{ wordBreak: "break-all", display: "block", padding: 8, background: "var(--bg2, #f3f5f6)" }}>{shown.value}</code></>}
          confirm="Copy and close"
          onCancel={() => setShown(null)}
          onConfirm={async () => {
            try {
              await navigator.clipboard.writeText(shown.value);
              toast("Copied");
            } catch {
              toast("Copy it by hand before closing", true);
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
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["orders:read"]);
  const [rate, setRate] = useState("120");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Create API key" onClose={onClose}>
      <div className="fld">
        <label htmlFor="ak-n">Integration name</label>
        <input id="ak-n" className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. NWS BI warehouse, TAS, IVMS vendor" autoFocus />
      </div>
      <div className="fld">
        <label>Scopes</label>
        <div className="checks" style={{ display: "grid", gap: 4 }}>
          {SCOPES.map(([s, l]) => (
            <label key={s}><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {l} <code>{s}</code></label>
          ))}
        </div>
      </div>
      <div className="fld">
        <label htmlFor="ak-r">Requests per minute</label>
        <input id="ak-r" className="in" type="number" min={1} max={10000} value={rate} onChange={(e) => setRate(e.target.value)} />
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn pri"
          disabled={busy || name.trim().length < 3 || scopes.length === 0}
          onClick={async () => {
            setBusy(true);
            const { data, error } = await supabase().rpc("staff_create_api_key", { p_name: name.trim(), p_scopes: scopes, p_rate_per_min: Number(rate) || 120 });
            setBusy(false);
            if (error) return toast(friendlyError(error), true);
            onDone((data as { key: string }).key);
          }}
        >
          {busy ? "Creating…" : "Create key"}
        </button>
      </div>
    </Modal>
  );
}

function NewHook({ onClose, onDone }: { onClose: () => void; onDone: (secret: string) => void }) {
  const { toast } = useStaff();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("simulate://receiver");
  const [events, setEvents] = useState<string[]>(["order.created", "order.delivered", "permit.approved"]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Add webhook" onClose={onClose}>
      <div className="fld">
        <label htmlFor="wh-n">Name</label>
        <input id="wh-n" className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. NWS ERP" autoFocus />
      </div>
      <div className="fld">
        <label htmlFor="wh-u">URL (https://…, or simulate://name for the built-in test receiver)</label>
        <input id="wh-u" className="in" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="fld">
        <label>Events</label>
        <div className="checks" style={{ display: "grid", gap: 4 }}>
          {EVENTS.map((e) => (
            <label key={e}><input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} /> <code>{e}</code></label>
          ))}
        </div>
      </div>
      <div className="btns" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn pri"
          disabled={busy || name.trim().length < 3 || events.length === 0}
          onClick={async () => {
            setBusy(true);
            const { data, error } = await supabase().rpc("staff_create_webhook", { p_name: name.trim(), p_url: url.trim(), p_events: events });
            setBusy(false);
            if (error) return toast(friendlyError(error), true);
            onDone((data as { secret: string }).secret);
          }}
        >
          {busy ? "Adding…" : "Add webhook"}
        </button>
      </div>
    </Modal>
  );
}

function RegisterDevice({ tankers, keys, onDone }: { tankers: Tanker[]; keys: Key[]; onDone: () => void }) {
  const run = useRun();
  const [id, setId] = useState("IV-");
  const [tanker, setTanker] = useState("");
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="pad" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
      <input className="in" style={{ maxWidth: 130 }} value={id} onChange={(e) => setId(e.target.value.toUpperCase())} aria-label="Device id" placeholder="IV-12345" />
      <select className="in" style={{ maxWidth: 180 }} value={tanker} onChange={(e) => setTanker(e.target.value)} aria-label="Tanker">
        <option value="">Tanker…</option>
        {tankers.map((t) => <option key={t.id} value={t.id}>{t.plate}</option>)}
      </select>
      <select className="in" style={{ maxWidth: 200 }} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Integration key">
        <option value="">Any IVMS key</option>
        {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
      </select>
      <button className="btn" disabled={!/^IV-\d{4,6}$/.test(id) || !tanker} onClick={() => setConfirm(true)}>Register device</button>
      {confirm && (
        <ConfirmDialog
          title={`Register ${id}`}
          body={<>Fixes from {id} will move {tankers.find((t) => t.id === tanker)?.plate}. A device already on that tanker is unassigned. Recorded in the audit log.</>}
          confirm="Register"
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            if (await run(supabase().rpc("staff_register_device", { p_device_id: id, p_tanker_id: tanker, p_api_key_id: key || null }), `${id} registered`)) onDone();
            setConfirm(false);
          }}
        />
      )}
    </div>
  );
}
