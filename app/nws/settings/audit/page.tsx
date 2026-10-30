"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { downloadCsv } from "@/components/nws/admin/ui";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { omanDayEndIso, omanDayStartIso } from "@/lib/time";

const PAGE = 300;

type Row = {
  id: number; at: string; actor_email: string | null; actor_role: string | null; action: string;
  target_type: string; target_id: string; before: unknown; after: unknown; reason: string | null;
};

export default function AuditLogPage() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    let query = supabase().from("audit_log").select("*").order("id", { ascending: false }).limit(limit);
    const term = q.trim().replace(/[%,()]/g, " ");
    if (term) query = query.or(`actor_email.ilike.%${term}%,target_id.ilike.%${term}%,reason.ilike.%${term}%,action.ilike.%${term}%`);
    if (action) query = query.like("action", `${action}%`);
    if (from) query = query.gte("at", omanDayStartIso(from));
    if (to) query = query.lte("at", omanDayEndIso(to));
    const { data, error } = await query;
    setErr(error ? friendlyError(error) : null);
    setRows((data ?? []) as Row[]);
  }, [q, action, from, to, limit]);

  function exportCsv() {
    if (!rows?.length) return;
    downloadCsv("audit_log", [
      ["When", "Actor", "Role", "Action", "Target type", "Target", "Reason", "Before", "After"],
      ...rows.map((r) => [r.at, r.actor_email, r.actor_role, r.action, r.target_type, r.target_id, r.reason, JSON.stringify(r.before), JSON.stringify(r.after)]),
    ]);
    void supabase().rpc("staff_log_export", { p_what: "audit log", p_rows: rows.length });
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Audit log</h1>
          <p>Every staff action, with who did it, the target, the reason and the values before and after. Append-only: rows can’t be edited or deleted by anyone.</p>
        </div>
      </div>
      <div className="panel">
        <div className="toolbar">
          <div className="filters">
            <input className="in" placeholder="Search actor, target, reason…" value={q} onChange={(e) => { setLimit(PAGE); setQ(e.target.value); }} aria-label="Search" style={{ width: 260 }} />
            <select className="in" value={action} onChange={(e) => { setLimit(PAGE); setAction(e.target.value); }} aria-label="Action">
              <option value="">All actions</option>
              <option value="tanker.">Tanker (block, assign…)</option>
              <option value="alert.">Alerts</option>
              <option value="company.">Companies</option>
              <option value="document.">Documents</option>
              <option value="inspection.">Inspections</option>
              <option value="org.">Business accounts</option>
              <option value="report.">Reports and exports</option>
              <option value="permit.">Permit</option>
              <option value="staff.">Staff roles</option>
              <option value="order.">Orders</option>
              <option value="customer.">Customers</option>
              <option value="complaint">Complaints</option>
              <option value="penalty">Penalties</option>
              <option value="pricing.">Pricing</option>
              <option value="promotion.">Promotions</option>
              <option value="setting.">Settings (privacy, loyalty)</option>
              <option value="emergency.">Emergency mode</option>
              <option value="zone.">Zones</option>
              <option value="site.">Geofences</option>
              <option value="template.">Notification templates</option>
              <option value="payout.">Payouts</option>
              <option value="fraud.">Fraud</option>
              <option value="data_request.">Data requests</option>
              <option value="incident.">Incidents</option>
            </select>
            <label className="mut" style={{ fontSize: 12.5 }}>
              From <input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="mut" style={{ fontSize: 12.5 }}>
              To <input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <span className="btns" style={{ alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 12.5 }}>{rows ? `${rows.length} entr${rows.length === 1 ? "y" : "ies"}${rows.length === limit ? ` (latest ${limit})` : ""}` : "Loading…"}</span>
            <button className="btn sm" disabled={!rows?.length} onClick={exportCsv}>Export CSV</button>
          </span>
        </div>
        {err && <div className="banner badb" role="alert">Couldn’t load the audit log: {err}</div>}
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && !err && (
                <tr><td colSpan={6} className="empty">No audit entries match.</td></tr>
              )}
              {rows?.map((r) => (
                <Fragment key={r.id}>
                  <tr className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td><small>{fmtDateTime(r.at)}</small></td>
                    <td>
                      {r.actor_email ?? "—"}
                      {r.actor_role ? <small style={{ display: "block" }}>{r.actor_role}</small> : null}
                    </td>
                    <td><code>{r.action}</code></td>
                    <td>
                      {r.target_type}
                      <small style={{ display: "block" }}>{r.target_id}</small>
                    </td>
                    <td>{r.reason ?? <span className="mut">—</span>}</td>
                    <td>
                      <button type="button" className="lk" aria-expanded={open === r.id} onClick={(e) => { e.stopPropagation(); setOpen(open === r.id ? null : r.id); }}>
                        {open === r.id ? "Hide" : "Before / after"}
                      </button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={6}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <div>
                            <small>Before</small>
                            <pre className="json">{JSON.stringify(r.before, null, 2) ?? "null"}</pre>
                          </div>
                          <div>
                            <small>After</small>
                            <pre className="json">{JSON.stringify(r.after, null, 2) ?? "null"}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {rows && rows.length === limit && (
          <div className="pad" style={{ textAlign: "center" }}>
            <button className="btn sm" onClick={() => setLimit((l) => l + PAGE)}>Load {PAGE} more</button>
          </div>
        )}
      </div>
    </>
  );
}
