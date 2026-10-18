"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDate, fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import type { ServiceType } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

type Status = "pending" | "approved" | "rejected" | "expired";
type PermitRow = {
  id: string; permit_no: string; type: ServiceType; issued_at: string; expires_at: string; status: Status; effective_status: Status;
  reviewed_at: string | null; reason: string | null; created_at: string;
  tanker: { id: string; plate: string; service_type: ServiceType } | null;
  reviewer: { full_name: string } | null;
};
type Audit = { id: number; at: string; action: string; actor_email: string | null; reason: string | null };
const DAY = 86_400_000;
const TONE: Record<Status, string> = { pending: "warn", approved: "ok", rejected: "bad", expired: "bad" };
const LABEL: Record<Status, string> = { pending: "Pending review", approved: "Approved", rejected: "Rejected", expired: "Expired" };
const daysLeft = (p: PermitRow) => Math.ceil((Date.parse(p.expires_at) - Date.now()) / DAY);
const expiringSoon = (p: PermitRow) => p.effective_status === "approved" && daysLeft(p) <= 30;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function PermitsPage() {
  const { can, toast } = useStaff();
  const officer = can("permit_officer");
  const [rows, setRows] = useState<PermitRow[] | null>(null);
  const [tankers, setTankers] = useState<{ id: string; plate: string; service_type: ServiceType }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [filter, setFilter] = useState<"all" | Status | "expiring">("all");
  const [dlg, setDlg] = useState<"reject" | "resubmit" | null>(null);
  const [newExpiry, setNewExpiry] = useState("");
  const [creating, setCreating] = useState(false);
  const today = new Date();
  const [form, setForm] = useState({ tanker: "", permit_no: "", type: "DW" as ServiceType, issued: isoDay(today), expires: isoDay(new Date(today.getTime() + 365 * DAY)) });

  const load = useCallback(async () => {
    const db = supabase();
    const [p, t] = await Promise.all([
      db
        .from("permits")
        .select("id, permit_no, type, issued_at, expires_at, status, effective_status, reviewed_at, reason, created_at, tanker:tankers(id, plate, service_type), reviewer:profiles!permits_reviewed_by_fkey(full_name)")
        .order("created_at", { ascending: false }),
      db.from("tankers").select("id, plate, service_type").order("plate"),
    ]);
    setRows((p.data ?? []) as unknown as PermitRow[]);
    setTankers((t.data ?? []) as { id: string; plate: string; service_type: ServiceType }[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const selected = rows?.find((p) => p.id === sel) ?? null;
  useEffect(() => {
    if (!sel) return;
    supabase()
      .from("audit_log")
      .select("id, at, action, actor_email, reason")
      .eq("target_type", "permit")
      .eq("target_id", sel)
      .order("at")
      .then(({ data }) => setAudit((data ?? []) as Audit[]));
  }, [sel, rows]);

  const list = useMemo(
    () => (rows ?? []).filter((p) => (filter === "all" ? true : filter === "expiring" ? expiringSoon(p) : p.effective_status === filter)),
    [rows, filter],
  );
  const count = (f: typeof filter) => (rows ?? []).filter((p) => (f === "all" ? true : f === "expiring" ? expiringSoon(p) : p.effective_status === f)).length;

  async function rpc(name: string, args: Record<string, unknown>, ok: string) {
    const { error } = await supabase().rpc(name, args);
    if (error) {
      toast(friendlyError(error), true);
      return false;
    }
    toast(ok);
    setDlg(null);
    await load();
    return true;
  }

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

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Permits</h1>
          <p>
            A tanker can go online only with an approved, unexpired permit for its own service type. For now staff create permit records; the tanker
            company portal will submit them later.
          </p>
        </div>
        <button className="btn pri" disabled={!officer} title={officer ? undefined : "Permit officers only"} onClick={() => setCreating((c) => !c)}>
          {creating ? "Close" : "New permit"}
        </button>
      </div>

      {creating && officer && (
        <form className="panel" onSubmit={create}>
          <h2>New permit <small>starts as pending; approve it to let the tanker go online</small></h2>
          <div className="pad" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr)) auto", gap: 12, alignItems: "end" }}>
            <div className="fld" style={{ margin: 0 }}>
              <label htmlFor="pt">Tanker</label>
              <select
                id="pt"
                className="in"
                required
                value={form.tanker}
                onChange={(e) => setForm({ ...form, tanker: e.target.value, type: tankers.find((t) => t.id === e.target.value)?.service_type ?? form.type })}
              >
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

      <div className="chips" style={{ marginBottom: 14 }}>
        {(
          [
            ["all", "All"],
            ["pending", "Pending"],
            ["approved", "Approved"],
            ["rejected", "Rejected"],
            ["expired", "Expired"],
            ["expiring", "Expiring ≤ 30 days"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
            {l}
            <span className="tc">{count(k)}</span>
          </button>
        ))}
      </div>

      <div className="two">
        <div className="plist">
          {!rows && <div className="empty">Loading…</div>}
          {rows && list.length === 0 && <div className="empty">No permits.</div>}
          {list.map((p) => (
            <button key={p.id} className={`pcard ${sel === p.id ? "sel" : ""}`} onClick={() => setSel(p.id)}>
              <span className="row">
                <b>{p.permit_no}</b>
                <small className="mut">{fmtDate(p.created_at)}</small>
              </span>
              <span>
                {p.tanker?.plate ?? "—"} <span className={`tag ${p.type}`}>{p.type}</span>
              </span>
              <span className="row">
                <span className={`st ${TONE[p.effective_status]}`}>{LABEL[p.effective_status]}</span>
                {expiringSoon(p) ? <span className="st warn">Expires in {daysLeft(p)} d</span> : <small className="mut">to {fmtDate(p.expires_at)}</small>}
              </span>
            </button>
          ))}
        </div>

        <div>
          {!selected ? (
            <div className="panel"><p className="note">Select a permit to see its details and history.</p></div>
          ) : (
            <div className="panel">
              <h2>
                <span>
                  {selected.permit_no} <span className={`st ${TONE[selected.effective_status]}`}>{LABEL[selected.effective_status]}</span>
                </span>
                <small>created {fmtDateTime(selected.created_at)}</small>
              </h2>
              <div className="pad">
                {expiringSoon(selected) && <div className="banner">Expires in {daysLeft(selected)} days ({fmtDate(selected.expires_at)}). Renew before then or the tanker can’t go online.</div>}
                {selected.tanker && selected.type !== selected.tanker.service_type && (
                  <div className="banner badb">This permit is for {selected.type}, but the tanker is {selected.tanker.service_type}: it doesn’t count.</div>
                )}
                {selected.effective_status === "rejected" && selected.reason && <div className="banner badb">Rejected: {selected.reason}</div>}
              </div>
              <dl className="kv">
                <dt>Tanker</dt>
                <dd>{selected.tanker ? `${selected.tanker.plate} · ${selected.tanker.service_type}` : "—"}</dd>
                <dt>Permit type</dt>
                <dd><span className={`tag ${selected.type}`}>{selected.type}</span></dd>
                <dt>Issued</dt>
                <dd>{fmtDate(selected.issued_at)}</dd>
                <dt>Expires</dt>
                <dd>{fmtDate(selected.expires_at)}</dd>
                <dt>Reviewed</dt>
                <dd>{selected.reviewed_at ? `${fmtDateTime(selected.reviewed_at)} · ${selected.reviewer?.full_name ?? "—"}` : "—"}</dd>
              </dl>
              <div className="pad">
                {!officer ? (
                  <p className="mut" style={{ margin: 0, fontSize: 13 }}>Only permit officers can review permits.</p>
                ) : selected.status === "pending" ? (
                  <div className="btns">
                    <button className="btn pri" onClick={() => rpc("staff_review_permit", { p_permit_id: selected.id, p_decision: "approve", p_reason: null }, "Permit approved")}>Approve</button>
                    <button className="btn bad" onClick={() => setDlg("reject")}>Reject…</button>
                  </div>
                ) : selected.status === "rejected" ? (
                  <button className="btn" onClick={() => { setNewExpiry(""); setDlg("resubmit"); }}>Resubmit…</button>
                ) : null}
              </div>
              <h2 style={{ paddingTop: 4 }}>History <small>from the audit log</small></h2>
              <ul className="tl">
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
          )}
        </div>
      </div>

      {dlg === "reject" && selected && (
        <ReasonDialog
          title={`Reject ${selected.permit_no}`}
          body="The tanker can’t go online on this permit. It can be resubmitted after the issue is fixed."
          confirm="Reject"
          danger
          onCancel={() => setDlg(null)}
          onConfirm={async (reason) => void (await rpc("staff_review_permit", { p_permit_id: selected.id, p_decision: "reject", p_reason: reason }, "Permit rejected"))}
        />
      )}
      {dlg === "resubmit" && selected && (
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
    </>
  );
}
