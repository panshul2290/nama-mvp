"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";

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

  const load = useCallback(async () => {
    let query = supabase().from("audit_log").select("*").order("id", { ascending: false }).limit(300);
    const term = q.trim().replace(/[%,()]/g, " ");
    if (term) query = query.or(`actor_email.ilike.%${term}%,target_id.ilike.%${term}%,reason.ilike.%${term}%,action.ilike.%${term}%`);
    if (action) query = query.like("action", `${action}%`);
    if (from) query = query.gte("at", new Date(`${from}T00:00:00`).toISOString());
    if (to) query = query.lte("at", new Date(`${to}T23:59:59.999`).toISOString());
    const { data } = await query;
    setRows((data ?? []) as Row[]);
  }, [q, action, from, to]);

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
            <input className="in" placeholder="Search actor, target, reason…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" style={{ width: 260 }} />
            <select className="in" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
              <option value="">All actions</option>
              <option value="tanker.">Tanker (block, assign…)</option>
              <option value="permit.">Permit</option>
              <option value="staff.">Staff roles</option>
            </select>
            <label className="mut" style={{ fontSize: 12.5 }}>
              From <input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="mut" style={{ fontSize: 12.5 }}>
              To <input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <span className="mut" style={{ fontSize: 12.5 }}>{rows ? `${rows.length} entr${rows.length === 1 ? "y" : "ies"}${rows.length === 300 ? " (latest 300)" : ""}` : "Loading…"}</span>
        </div>
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
              {rows?.length === 0 && (
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
                    <td><span className="lk">{open === r.id ? "Hide" : "Before / after"}</span></td>
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
      </div>
    </>
  );
}
