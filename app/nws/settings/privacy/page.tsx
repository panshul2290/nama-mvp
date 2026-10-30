"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, PageHead, pct, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { fmtDate, fmtDateTime, STAFF_ROLE_LABEL, useStaff } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";
import { ref, type DataRequest, type StaffRole } from "@/lib/types";

type Privacy = {
  mask_phone: boolean; mask_id: boolean; mask_address: boolean; usage_data_default: boolean;
  retention_gps_days: number; retention_chat_days: number; retention_photo_days: number; retention_orders_years: number;
  privileged_roles: StaffRole[]; hosting?: string;
};
type Req = DataRequest & { customer: { full_name: string } | null; result_note?: string | null };
type Retention = { gps_fixes: number; chat_messages: number; delivery_media: number; complaint_photos: number; addresses: number };
type Run = { id: number; ran_at: string; dry_run: boolean; result: Retention };

// Screen text in one place (Arabic comes later).
const KIND: Record<DataRequest["kind"], string> = { access: "Export my data", delete: "Delete my account", correct: "Correct my data" };
const DUE_DAYS = 30; // statutory response window (assumption)
const ROLES: StaffRole[] = ["admin", "operator", "permit_officer", "inspector", "complaints_agent", "finance"];
const ENFORCED = "Applied by the database";
const RET_LABEL: Record<keyof Retention, string> = {
  gps_fixes: "GPS fixes", chat_messages: "Chat messages", delivery_media: "Delivery photos and signatures", complaint_photos: "Complaint photos", addresses: "Delivery addresses anonymised",
};

export default function PrivacyPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const [saved, setSaved] = useState<Privacy | null>(null);
  const [p, setP] = useState<Privacy | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [now, setNow] = useState(0); // time of the last load, for due dates
  const [consent, setConsent] = useState<{ share: number; n: number } | null>(null);
  const [preview, setPreview] = useState<Retention | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
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
    // Counted in the database (0024), so no customer's private fields come to the browser.
    db.rpc("staff_consent_stats").then(({ data }) => {
      const s = (data as { customers: number; sharing: number }[] | null)?.[0];
      setConsent(s ? { share: s.sharing, n: s.customers } : null);
    });
    db.from("retention_runs").select("id, ran_at, dry_run, result").order("id", { ascending: false }).limit(5).then(({ data }) => setRuns((data ?? []) as Run[]));
    if (admin) db.rpc("staff_run_retention", { p_dry: true }).then(({ data }) => setPreview((data as Retention | null) ?? null));
  }, [admin]);
  useEffect(load, [load]);

  function save() {
    if (!p) return;
    ask({
      title: "Save privacy controls",
      body: "The database applies these at once: masking on NWS screens, the reveal roles, the usage-data default for new accounts, and the periods the nightly retention job uses.",
      confirm: "Save controls",
      ok: "Privacy controls saved",
      run: (reason) => supabase().rpc("staff_update_setting", { p_key: "PRIVACY", p_value: p, p_reason: reason }),
      done: load,
    });
  }
  function runRetention() {
    ask({
      title: "Run retention now",
      body: preview
        ? `Removes ${Object.entries(preview).filter(([k]) => k in RET_LABEL).map(([k, v]) => `${v} ${RET_LABEL[k as keyof Retention].toLowerCase()}`).join(", ")} — closed orders only. It also runs every night at 03:00.`
        : "Removes data past its retention period (closed orders only). It also runs every night at 03:00.",
      confirm: "Run retention",
      danger: true,
      ok: "Retention run complete",
      run: () => supabase().rpc("staff_run_retention", { p_dry: false }),
      done: load,
    });
  }
  function process(r: Req) {
    ask({
      title: `${r.kind === "access" ? "Prepare export for" : "Erase personal data of"} ${r.customer?.full_name ?? "customer"} (${ref.dataRequest(r.ref_no)})`,
      body: r.kind === "access"
        ? "Builds a copy of everything held about the customer (profile with the decrypted ID number, sites, orders, payments, wallet, complaints, messages, notifications). They download it from the app for 30 days and are notified."
        : "Removes name, phone, email, ID number, sites, devices, notifications, messages and complaint texts, ends their sign-in and blocks the account. Orders and payments stay, anonymously, for the financial retention period. Refused while orders are open, the wallet isn't empty or a contract is live.",
      confirm: r.kind === "access" ? "Prepare export" : "Erase personal data",
      danger: r.kind === "delete",
      ok: r.kind === "access" ? "Export ready — the customer has been told" : "Personal data erased",
      run: (reason) => supabase().rpc("staff_process_data_request", { p_request_id: r.id, p_reason: reason }),
      done: load,
    });
  }
  function close(r: Req, state: "completed" | "rejected") {
    ask({
      title: `${state === "completed" ? "Complete" : "Reject"} ${ref.dataRequest(r.ref_no)}`,
      body: `${KIND[r.kind]} — ${r.customer?.full_name ?? "customer"}. ${state === "completed" ? "Confirm the record was corrected." : "The customer is told why in the reply."}`,
      confirm: state === "completed" ? "Mark completed" : "Reject request",
      danger: state === "rejected",
      ok: state === "completed" ? "Request completed" : "Request rejected",
      run: (reason) => supabase().rpc("staff_close_data_request", { p_request_id: r.id, p_state: state, p_reason: reason }),
      done: load,
    });
  }

  const dirty = p && saved && JSON.stringify(p) !== JSON.stringify(saved);
  type NumKey = "retention_gps_days" | "retention_chat_days" | "retention_photo_days" | "retention_orders_years";
  const sel = (k: NumKey, opts: [number, string][]) => (
    <select className="inl" aria-label={k} disabled={!admin || !p} value={p?.[k] ?? ""} onChange={(e) => p && setP({ ...p, [k]: Number(e.target.value) })}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const sw = (k: "mask_phone" | "mask_id" | "usage_data_default", label: string) => (
    <Switch on={!!p?.[k]} disabled={!admin || !p} label={label} onClick={() => p && setP({ ...p, [k]: !p[k] })} />
  );
  const days: [number, string][] = [[30, "30 days"], [90, "90 days"], [180, "180 days"], [365, "1 year"], [730, "2 years"]];
  const toggleRole = (role: StaffRole) => {
    if (!p || role === "admin") return;
    const has = p.privileged_roles.includes(role);
    setP({ ...p, privileged_roles: has ? p.privileged_roles.filter((x) => x !== role) : [...p.privileged_roles, role] });
  };

  return (
    <>
      <PageHead title="Data privacy" sub="Masking and retention of personal data, encryption, consent, and customers’ data requests — each applied by the database." />
      {!admin && <ReadOnlyNote who="a Super admin" />}
      <div className="half">
        <div className="panel">
          <h2>Controls <small>{ENFORCED.toLowerCase()}</small></h2>
          <div className="tblwrap">
            <table>
              <tbody>
                <tr><td>Mask phone numbers on NWS screens<small style={{ display: "block" }}>Roles below see the full number through an audited “Reveal”; drivers and customers talk through the masked relay</small></td><td className="num">{sw("mask_phone", "Mask phone numbers")}</td></tr>
                <tr><td>Mask ID numbers<small style={{ display: "block" }}>Encrypted at rest; everyone sees “•••• 1234”; roles below reveal one number at a time, audited</small></td><td className="num">{sw("mask_id", "Mask ID numbers")}</td></tr>
                <tr><td>Exact address hidden until a driver accepts<small style={{ display: "block" }}>Always on: the pin and address are released only to the assigned driver (row-level security)</small></td><td className="num"><span className="st ok">Always on</span></td></tr>
                <tr><td>Share usage data with NWS by default<small style={{ display: "block" }}>Set on every new account; customers change it in their app</small></td><td className="num">{sw("usage_data_default", "Usage data default")}</td></tr>
                <tr><td>Keep GPS history<small style={{ display: "block" }}>Fixes of closed orders and idle tracking</small></td><td className="num">{sel("retention_gps_days", days)}</td></tr>
                <tr><td>Keep order chats<small style={{ display: "block" }}>Closed orders only</small></td><td className="num">{sel("retention_chat_days", days.filter(([d]) => d >= 30))}</td></tr>
                <tr><td>Keep delivery and complaint photos<small style={{ display: "block" }}>Photos and signatures; meter readings and hashes stay</small></td><td className="num">{sel("retention_photo_days", [[90, "90 days"], [180, "180 days"], [365, "1 year"], [730, "2 years"], [1825, "5 years"]])}</td></tr>
                <tr><td>Keep street addresses of orders<small style={{ display: "block" }}>Then reduced to about 1 km; amounts and payments stay for audit</small></td><td className="num">{sel("retention_orders_years", [[5, "5 years"], [7, "7 years"], [10, "10 years"]])}</td></tr>
                <tr>
                  <td>Roles that may reveal phone and ID numbers<small style={{ display: "block" }}>Every reveal asks for a reason and is in the audit log; read-only users never</small></td>
                  <td className="num">
                    <div className="checks" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", fontSize: 12.5 }}>
                      {ROLES.map((role) => (
                        <label key={role}>
                          <input type="checkbox" disabled={!admin || !p || role === "admin"} checked={!!p?.privileged_roles?.includes(role)} onChange={() => toggleRole(role)} /> {STAFF_ROLE_LABEL[role]}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
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

        <div className="stack">
          <div className="panel">
            <h2>Hosting, encryption and consent</h2>
            <dl className="kv" style={{ paddingTop: 8 }}>
              <dt>Hosting</dt><dd>Pilot hosted outside Oman; to be moved to Oman at go-live</dd>
              <dt>Data owner</dt><dd>Nama Water Services (all data)</dd>
              <dt>Encryption</dt><dd>TLS in transit; provider disk encryption; ID numbers and IBANs field-encrypted (AES-256, key in the secrets vault)</dd>
              <dt>Customers sharing usage data</dt><dd>{consent ? (consent.n ? `${pct(consent.share / consent.n)} (${consent.share} of ${consent.n})` : "—") : "…"}</dd>
              <dt>Reminders and marketing</dt><dd>Sent only to users who allow them (refill reminders: reminder consent; offers: promotions consent)</dd>
              <dt>Staff access</dt><dd>Role-based; every change and reveal is in the audit log</dd>
            </dl>
            <p className="note">Oman Personal Data Protection Law (Royal Decree 6/2022): customers can request a copy, correction or deletion of their data from the app. Requests are answered within {DUE_DAYS} days (assumption).</p>
          </div>
          <div className="panel">
            <h2>Retention job <small>nightly at 03:00 · closed orders only</small></h2>
            <div className="tblwrap">
              <table>
                <thead><tr><th>Due for removal now</th><th className="num">Items</th></tr></thead>
                <tbody>
                  {!admin && <Empty cols={2}>Visible to Super admins.</Empty>}
                  {admin && !preview && <Empty cols={2}>Counting…</Empty>}
                  {preview && (Object.keys(RET_LABEL) as (keyof Retention)[]).map((k) => (
                    <tr key={k}><td>{RET_LABEL[k]}</td><td className="num">{preview[k] ?? 0}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs && runs.length > 0 && (
              <p className="note">Last run {fmtDateTime(runs[0].ran_at)}: {(Object.keys(RET_LABEL) as (keyof Retention)[]).map((k) => `${runs[0].result[k] ?? 0} ${RET_LABEL[k].toLowerCase()}`).join(", ")}.</p>
            )}
            {admin && <div className="pad"><button className="btn bad" onClick={runRetention}>Run retention now</button></div>}
          </div>
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
                      {r.result_note && <small style={{ display: "block" }}>{r.result_note}</small>}
                    </td>
                    <td className="num">
                      {admin && r.state === "open" && (
                        <div className="btns" style={{ justifyContent: "flex-end" }}>
                          {r.kind === "correct" ? (
                            <button className="btn sm pri" onClick={() => close(r, "completed")}>Complete</button>
                          ) : (
                            <button className={`btn sm ${r.kind === "delete" ? "bad" : "pri"}`} onClick={() => process(r)}>{r.kind === "access" ? "Prepare export" : "Erase data"}</button>
                          )}
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
