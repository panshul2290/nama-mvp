"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, fetchPaged, PageHead, pct, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { fmtDate, fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";
import { ref, type DataRequest } from "@/lib/types";

type Privacy = { mask_phone: boolean; mask_address: boolean; retention_gps_days: number; retention_orders_years: number; residency: string; usage_data_default: boolean };
type Req = DataRequest & { customer: { full_name: string } | null };
const KIND: Record<DataRequest["kind"], string> = { access: "Export my data", delete: "Delete my account", correct: "Correct my data" };
const DUE_DAYS = 30; // statutory response window (assumption)

export default function PrivacyPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const [saved, setSaved] = useState<Privacy | null>(null);
  const [p, setP] = useState<Privacy | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [now, setNow] = useState(0); // time of the last load, for due dates
  const [consent, setConsent] = useState<{ share: number; n: number } | null>(null);
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("app_settings").select("value").eq("key", "PRIVACY").maybeSingle().then(({ data }) => {
      const v = data?.value ? (JSON.parse(data.value as string) as Privacy) : null;
      setSaved(v);
      setP(v);
    });
    db.from("data_requests").select("*, customer:profiles!data_requests_customer_id_fkey(full_name)").order("created_at", { ascending: false }).limit(100)
      .then(({ data }) => {
        setNow(Date.now());
        setReqs((data ?? []) as Req[]);
      });
    fetchPaged<{ prefs: Record<string, unknown> | null }>((a, b) => db.from("profiles").select("prefs").eq("role", "customer").order("id").range(a, b), 50000).then(({ rows }) => {
      setConsent({ share: rows.filter((r) => r.prefs?.share_usage === true).length, n: rows.length });
    });
  }, []);
  useEffect(load, [load]);

  function save() {
    if (!p) return;
    ask({
      title: "Save privacy controls",
      body: "Masking applies immediately in every app. Retention changes apply to the next nightly clean-up.",
      confirm: "Save controls",
      ok: "Privacy controls saved",
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "PRIVACY", p_value: p, p_reason: reason }),
      done: load,
    });
  }
  function close(r: Req, state: "completed" | "rejected") {
    ask({
      title: `${state === "completed" ? "Complete" : "Reject"} ${ref.dataRequest(r.ref_no)}`,
      body: `${KIND[r.kind]} — ${r.customer?.full_name ?? "customer"}. ${state === "completed" ? "Confirm the request was fulfilled (export sent, account deleted or data corrected)." : "The customer is told why in the reply."}`,
      confirm: state === "completed" ? "Mark completed" : "Reject request",
      danger: state === "rejected",
      ok: state === "completed" ? "Request completed" : "Request rejected",
      run: (reason) => supabase().rpc("staff_close_data_request", { p_request_id: r.id, p_state: state, p_reason: reason }),
      done: load,
    });
  }

  const dirty = p && saved && JSON.stringify(p) !== JSON.stringify(saved);
  const sel = (k: "retention_gps_days" | "retention_orders_years", opts: [number, string][]) => (
    <select className="inl" aria-label={k} disabled={!admin || !p} value={p?.[k] ?? ""} onChange={(e) => p && setP({ ...p, [k]: Number(e.target.value) })}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const sw = (k: "mask_phone" | "mask_address" | "usage_data_default", label: string) => (
    <Switch on={!!p?.[k]} disabled={!admin || !p} label={label} onClick={() => p && setP({ ...p, [k]: !p[k] })} />
  );

  return (
    <>
      <PageHead title="Data privacy" sub="Masking and retention of personal data, residency and consent, and customers’ data requests." />
      {!admin && <ReadOnlyNote who="a Super admin" />}
      <div className="half">
        <div className="panel">
          <h2>Controls</h2>
          <div className="tblwrap">
            <table>
              <tbody>
                <tr><td>Mask customer phone numbers to drivers<small style={{ display: "block" }}>Calls and chats go through the masked relay</small></td><td className="num">{sw("mask_phone", "Mask phone numbers")}</td></tr>
                <tr><td>Mask exact addresses until a tanker is assigned</td><td className="num">{sw("mask_address", "Mask addresses")}</td></tr>
                <tr><td>Share usage data with NWS by default<small style={{ display: "block" }}>Default for new customers; they can change it in their app</small></td><td className="num">{sw("usage_data_default", "Usage data default")}</td></tr>
                <tr><td>Keep orders and payments</td><td className="num">{sel("retention_orders_years", [[5, "5 years"], [7, "7 years"], [10, "10 years"]])}</td></tr>
                <tr><td>Keep GPS history</td><td className="num">{sel("retention_gps_days", [[30, "30 days"], [90, "90 days"], [180, "180 days"], [365, "1 year"], [730, "2 years"]])}</td></tr>
              </tbody>
            </table>
          </div>
          {admin && (
            <div className="pad" style={{ paddingTop: 12 }}>
              <div className="btns">
                <button className="btn pri" disabled={!dirty} onClick={save}>Save changes</button>
                {dirty && <button className="btn" onClick={() => setP(saved)}>Discard</button>}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Residency and consent</h2>
          <dl className="kv" style={{ paddingTop: 8 }}>
            <dt>Hosting</dt><dd>{saved?.residency ?? "—"}</dd>
            <dt>Data owner</dt><dd>Nama Water Services (all data)</dd>
            <dt>Encryption</dt><dd>TLS 1.3 in transit, AES-256 at rest</dd>
            <dt>Customers sharing usage data</dt><dd>{consent ? (consent.n ? `${pct(consent.share / consent.n)} (${consent.share} of ${consent.n})` : "—") : "…"}</dd>
            <dt>Staff access</dt><dd>Role-based; every change is in the audit log</dd>
          </dl>
          <p className="note">Oman Personal Data Protection Law (Royal Decree 6/2022): customers can request a copy, correction or deletion of their data from the app. Requests are answered within {DUE_DAYS} days (assumption).</p>
        </div>
      </div>

      <div className="panel">
        <h2>Data requests <small>{reqs?.filter((r) => r.state === "open").length ?? 0} open</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>Request</th><th>Customer</th><th>Type</th><th>Received</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {!reqs && <Empty cols={6}>Loading…</Empty>}
              {reqs?.length === 0 && <Empty cols={6}>No data requests.</Empty>}
              {reqs?.map((r) => {
                const due = Math.ceil((new Date(r.created_at).getTime() + DUE_DAYS * 86400_000 - now) / 86400_000);
                return (
                  <tr key={r.id}>
                    <td><b>{ref.dataRequest(r.ref_no)}</b>{r.details && <small style={{ display: "block" }}>{r.details}</small>}</td>
                    <td>{r.customer?.full_name || "Customer"}</td>
                    <td>{KIND[r.kind]}</td>
                    <td><small>{fmtDateTime(r.created_at)}</small></td>
                    <td>
                      {r.state === "open" ? (
                        <span className={`st ${due < 0 ? "bad" : due <= 7 ? "warn" : "act"}`}>{due < 0 ? `Overdue ${-due} d` : `Due in ${due} days`}</span>
                      ) : (
                        <span className={`st ${r.state === "completed" ? "ok" : ""}`}>{r.state === "completed" ? "Completed" : "Rejected"} {fmtDate(r.closed_at)}</span>
                      )}
                    </td>
                    <td className="num">
                      {admin && r.state === "open" && (
                        <div className="btns" style={{ justifyContent: "flex-end" }}>
                          <button className="btn sm pri" onClick={() => close(r, "completed")}>Complete</button>
                          <button className="btn sm" onClick={() => close(r, "rejected")}>Reject</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {dialog}
    </>
  );
}
