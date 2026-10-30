"use client";

import { useCallback, useEffect, useState } from "react";
import { Empty, int, Kpi, omr, PageHead, ReadOnlyNote, Switch, useAudited } from "@/components/nws/admin/ui";
import { fmtDateTime, ReasonDialog, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { PENALTY_STATE } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { ref, type Penalty, type PenaltyRule } from "@/lib/types";

const PARTY: Record<string, string> = { driver: "Driver / tanker company", customer: "Customer", business: "Business account" };
const STATE: Record<Penalty["state"], [string, string]> = PENALTY_STATE;
const amountText = (r: PenaltyRule) => (r.amount_kind === "pct" ? `${Number(r.amount)}% per month` : omr(r.amount));

export default function PenaltiesPage() {
  const { can } = useStaff();
  const { ask, dialog } = useAudited();
  const [rules, setRules] = useState<PenaltyRule[] | null>(null);
  const [recent, setRecent] = useState<Penalty[] | null>(null);
  const [edit, setEdit] = useState<PenaltyRule | null>(null);
  const admin = can("admin");

  const load = useCallback(() => {
    const db = supabase();
    db.from("penalty_rules").select("*").order("party").order("code").then(({ data }) => setRules((data ?? []) as PenaltyRule[]));
    db.from("penalties").select("*").gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(500)
      .then(({ data }) => setRecent((data ?? []) as Penalty[]));
  }, []);
  useEffect(load, [load]);

  function toggle(r: PenaltyRule) {
    ask({
      title: `${r.active ? "Switch off" : "Switch on"}: ${r.label}`,
      body: r.active ? "No new penalties will be issued for this trigger. Existing ones are unaffected." : "Penalties will be issued automatically again for this trigger.",
      confirm: r.active ? "Switch off" : "Switch on",
      danger: r.active,
      ok: r.active ? "Penalty rule switched off" : "Penalty rule switched on",
      run: (reason) => supabase().rpc("staff_update_penalty_rule", { p_code: r.code, p_amount: Number(r.amount), p_active: !r.active, p_reason: reason }),
      done: load,
    });
  }

  const label = new Map(rules?.map((r) => [r.code, r.label]));
  const byRule = new Map<string, { n: number; amt: number }>();
  for (const p of recent ?? []) {
    const a = byRule.get(p.rule_code) ?? { n: 0, amt: 0 };
    a.n++; if (p.state !== "cancelled") a.amt += Number(p.amount);
    byRule.set(p.rule_code, a);
  }
  const live = recent?.filter((p) => p.state !== "cancelled") ?? [];

  return (
    <>
      <PageHead title="Penalties" sub="The penalty framework applied automatically from IVMS, proof-of-delivery and payment events, and what it issued recently." />
      {!admin && <ReadOnlyNote who="a Super admin" />}
      <div className="panel">
        <h2>Penalty framework <small>applied automatically from IVMS, POD and payment events</small></h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Trigger</th><th>Applies to</th><th className="num">Amount (OMR)</th><th>Customer compensation</th><th className="num">Last 30 days</th><th>Active</th><th></th></tr>
            </thead>
            <tbody>
              {!rules && <Empty cols={7}>Loading…</Empty>}
              {rules?.map((r) => (
                <tr key={r.code}>
                  <td>{r.label}<small style={{ display: "block" }}><code>{r.code}</code></small></td>
                  <td>{PARTY[r.party]}</td>
                  <td className="num"><b>{amountText(r)}</b></td>
                  <td>{r.compensation || <span className="mut">—</span>}</td>
                  <td className="num">{byRule.get(r.code)?.n ?? 0}</td>
                  <td><Switch on={r.active} disabled={!admin} label={r.active ? "Active" : "Off"} onClick={() => toggle(r)} /></td>
                  <td className="num">{admin && <button className="btn sm" onClick={() => setEdit(r)}>Edit amount</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Drivers and owners see each fine with its evidence in their app and can dispute within 7 days. Amounts are placeholders for NWS to set (assumption).</p>
      </div>

      <div className="okpis">
        <Kpi label="Issued, last 30 days" value={recent ? int(recent.length) : "…"} />
        <Kpi label="Amount (OMR)" value={omr(live.reduce((a, p) => a + Number(p.amount), 0))} sub="excluding cancelled" />
        <Kpi label="Disputed, awaiting decision" value={int(recent?.filter((p) => p.state === "disputed").length ?? 0)} tone={recent?.some((p) => p.state === "disputed") ? "warn" : undefined} />
        <Kpi label="Upheld" value={int(recent?.filter((p) => p.state === "upheld").length ?? 0)} />
      </div>

      <div className="panel">
        <h2>Recent penalties <small>last 30 days · decisions are made in Fleet</small></h2>
        <div className="tblwrap scroll">
          <table>
            <thead><tr><th>Ref</th><th>Trigger</th><th>Reason</th><th className="num">OMR</th><th>Status</th><th>Issued</th></tr></thead>
            <tbody>
              {recent?.length === 0 && <Empty cols={6}>No penalties in the last 30 days.</Empty>}
              {recent?.slice(0, 50).map((p) => (
                <tr key={p.id}>
                  <td>{ref.penalty(p.penalty_no)}</td>
                  <td>{label.get(p.rule_code) ?? p.rule_code}</td>
                  <td><small>{p.reason}</small></td>
                  <td className="num">{omr(p.amount)}</td>
                  <td><span className={`st ${STATE[p.state][1]}`}>{STATE[p.state][0]}</span></td>
                  <td><small>{fmtDateTime(p.created_at)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <EditAmount rule={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      {dialog}
    </>
  );
}

function EditAmount({ rule, onClose, onDone }: { rule: PenaltyRule; onClose: () => void; onDone: () => void }) {
  const { toast } = useStaff();
  const [amount, setAmount] = useState(String(Number(rule.amount)));
  return (
    <ReasonDialog
      title={`Edit amount: ${rule.label}`}
      body="Applies to penalties issued from now on."
      confirm="Save amount"
      extra={
        <div className="fld">
          <label htmlFor="pen-amt">{rule.amount_kind === "pct" ? "Late fee (% per month)" : "Amount (OMR)"}</label>
          <input id="pen-amt" className="in" type="number" min={0} step={rule.amount_kind === "pct" ? 0.5 : 0.1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      }
      onCancel={onClose}
      onConfirm={async (reason) => {
        const { error } = await supabase().rpc("staff_update_penalty_rule", { p_code: rule.code, p_amount: Number(amount), p_active: rule.active, p_reason: reason });
        if (error) return toast(friendlyError(error), true);
        toast("Penalty amount updated");
        onDone();
      }}
    />
  );
}
