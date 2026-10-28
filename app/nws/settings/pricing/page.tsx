"use client";

import { useEffect, useState } from "react";
import { fmtDateTime } from "@/components/nws/StaffContext";
import { supabase } from "@/lib/supabase/client";
import type { RuleStatus } from "@/lib/pricing";

type Rule = { rule_key: string; value: string; status: RuleStatus; source: string; notes: string; updated_at: string };
const BADGE: Record<RuleStatus, [string, string]> = {
  confirmed: ["Confirmed", "ok"],
  pending_clarification: ["Pending NWS clarification", "warn"],
  assumption: ["Assumption", "warn"],
};

export default function PricingRulesPage() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    const db = supabase();
    Promise.all([
      db.from("pricing_rules").select("rule_key, value, status, source, notes, updated_at").order("status").order("rule_key"),
      db.from("app_settings").select("value").eq("key", "BILLING_MODE").maybeSingle(),
    ]).then(([r, m]) => {
      setRules((r.data ?? []) as Rule[]);
      setMode((m.data?.value as string) ?? null);
    });
  }, []);

  const count = (s: RuleStatus) => rules?.filter((r) => r.status === s).length ?? 0;

  return (
    <>
      <div className="vhead">
        <div>
          <h1>Pricing rules</h1>
          <p>Read-only. Every price is computed from these rules; lines priced from a rule that isn’t confirmed are tagged on quotes and orders.</p>
        </div>
      </div>
      <div className="okpis">
        <div className="okpi">
          <span>BILLING_MODE</span>
          <b>{mode ?? "—"}</b>
          <small className={mode === "production" ? "ok" : "warn"}>
            {mode === "production" ? "orders using unconfirmed rules are refused" : "unconfirmed rules are allowed and flagged"}
          </small>
        </div>
        <div className="okpi"><span>Confirmed</span><b>{count("confirmed")}</b><small className="ok">from the tender tariff table</small></div>
        <div className="okpi"><span>Pending clarification</span><b>{count("pending_clarification")}</b><small className="warn">awaiting NWS answers</small></div>
        <div className="okpi"><span>Assumptions</span><b>{count("assumption")}</b><small className="warn">no tender basis yet</small></div>
      </div>
      <div className="panel">
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Value</th>
                <th>Status</th>
                <th>Source</th>
                <th>Notes</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {!rules && (
                <tr><td colSpan={6} className="empty">Loading…</td></tr>
              )}
              {rules?.map((r) => (
                <tr key={r.rule_key}>
                  <td><code>{r.rule_key}</code></td>
                  <td className="num"><b>{r.value}</b></td>
                  <td><span className={`st ${BADGE[r.status][1]}`}>{BADGE[r.status][0]}</span></td>
                  <td>{r.source}</td>
                  <td><small>{r.notes}</small></td>
                  <td><small>{fmtDateTime(r.updated_at)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Rules and BILLING_MODE are changed by the database owner (see README → Pricing); there is no in-portal editor in v1.</p>
      </div>
    </>
  );
}
