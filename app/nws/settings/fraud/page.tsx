"use client";

import { useCallback, useEffect, useState } from "react";
import { Chips, Empty, PageHead, useAudited } from "@/components/nws/admin/ui";
import { fmtDateTime, useStaff } from "@/components/nws/StaffContext";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { FraudFlag } from "@/lib/types";

// Mirrors the checks in staff_scan() (0012): rule name, threshold and the score each flag gets.
const RULES: { name: string; match: string; threshold: string; score: number }[] = [
  { name: "Delivery without filling", match: "Delivery without filling", threshold: "Drinking or treated water delivered with no station fill event (last 30 days)", score: 80 },
  { name: "Duplicate POD photo", match: "Duplicate proof-of-delivery photo", threshold: "Same proof-of-delivery photo hash on 2 or more deliveries", score: 90 },
  { name: "Rating manipulation", match: "Rating manipulation", threshold: "3 or more five-star ratings from one customer to one driver within 24 h", score: 60 },
  { name: "Wallet misuse", match: "Wallet misuse", threshold: "Wallet top-ups above 200 OMR by one customer within 24 h", score: 55 },
  { name: "Unusual ordering", match: "Unusual ordering", threshold: "More than 5 orders by one household customer within 24 h", score: 40 },
];
const level = (s: number): [string, string] => (s >= 75 ? ["High", "bad"] : s >= 50 ? ["Medium", "warn"] : ["Low", ""]);
const STATE: Record<FraudFlag["state"], [string, string]> = { open: ["Open", "act"], cleared: ["Cleared", "ok"], confirmed: ["Confirmed fraud", "bad"] };
type Filter = "open" | "cleared" | "confirmed" | "all";

export default function FraudPage() {
  const { can, toast } = useStaff();
  const { ask, dialog } = useAudited();
  const [flags, setFlags] = useState<FraudFlag[] | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [scanning, setScanning] = useState(false);
  const decider = can("admin", "operator", "finance");

  const load = useCallback(() => {
    supabase().from("fraud_flags").select("*").order("created_at", { ascending: false }).limit(500).then(({ data }) => setFlags((data ?? []) as FraudFlag[]));
  }, []);
  useEffect(load, [load]);

  async function scan() {
    setScanning(true);
    const { data, error } = await supabase().rpc("staff_scan");
    setScanning(false);
    if (error) return toast(friendlyError(error), true);
    const r = data as { new_flags: number; new_alerts: number };
    toast(`Checks complete: ${r.new_flags} new flag${r.new_flags === 1 ? "" : "s"}, ${r.new_alerts} new alert${r.new_alerts === 1 ? "" : "s"}`);
    load();
  }

  function decide(f: FraudFlag, state: "cleared" | "confirmed") {
    ask({
      title: `${state === "cleared" ? "Clear" : "Confirm"} flag: ${f.rule}`,
      body: state === "cleared" ? "Mark as a false positive. The flag is kept for the record." : "Confirm as fraud. Follow up with a penalty, account block or refund from the relevant screen.",
      confirm: state === "cleared" ? "Clear flag" : "Confirm fraud",
      danger: state === "confirmed",
      ok: state === "cleared" ? "Flag cleared" : "Flag confirmed as fraud",
      run: (reason) => supabase().rpc("staff_fraud_decide", { p_flag_id: f.id, p_state: state, p_reason: reason }),
      done: load,
    });
  }

  const n = (s: Filter) => (flags ?? []).filter((f) => s === "all" || f.state === s).length;
  const shown = (flags ?? []).filter((f) => filter === "all" || f.state === filter);

  return (
    <>
      <PageHead title="Fraud detection" sub="Automatic checks on trips, proof of delivery, ratings, wallets and ordering. Flags are reviewed here; nothing is blocked automatically.">
        <button className="btn pri" onClick={scan} disabled={scanning}>{scanning ? "Running…" : "Run checks now"}</button>
      </PageHead>
      <div className="half">
        <div className="panel">
          <h2>Detection rules <small>run every scan</small></h2>
          <div className="tblwrap">
            <table>
              <tbody>
                {RULES.map((r) => {
                  const open = (flags ?? []).filter((f) => f.rule === r.match && f.state === "open").length;
                  return (
                    <tr key={r.name}>
                      <td>{r.name}<small style={{ display: "block" }}>Threshold: {r.threshold}</small></td>
                      <td><span className={`st ${level(r.score)[1]}`}>{level(r.score)[0]}</span></td>
                      <td className="num">{open ? <b>{open} open</b> : <span className="mut">0 open</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note">Rules and thresholds are defined in the database scan (staff_scan), which also runs on a schedule. Cashback and loyalty credits pass the Wallet misuse rule.</p>
        </div>

        <div className="panel">
          <h2>Flags <small>{n("open")} need review</small></h2>
          <div className="toolbar" style={{ paddingTop: 0 }}>
            <Chips<Filter> items={[["open", "Open", n("open")], ["confirmed", "Confirmed", n("confirmed")], ["cleared", "Cleared", n("cleared")], ["all", "All", n("all")]]} value={filter} onChange={setFilter} />
          </div>
          <div className="tblwrap scroll">
            <table>
              <tbody>
                {!flags && <Empty cols={3}>Loading…</Empty>}
                {flags && shown.length === 0 && <Empty cols={3}>No {filter === "all" ? "" : filter} flags.</Empty>}
                {shown.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <b style={{ fontWeight: 600 }}>{f.rule}</b> · {f.subject_type}
                      <small style={{ display: "block" }}>{f.details}</small>
                      <small style={{ display: "block" }}>{fmtDateTime(f.created_at)}</small>
                    </td>
                    <td><span className={`st ${level(f.score)[1]}`} title={`Score ${f.score}`}>{level(f.score)[0]}</span></td>
                    <td className="num">
                      {f.state === "open" ? (
                        decider ? (
                          <div className="btns" style={{ justifyContent: "flex-end" }}>
                            <button className="btn sm" onClick={() => decide(f, "cleared")}>Clear</button>
                            <button className="btn sm bad" onClick={() => decide(f, "confirmed")}>Confirm</button>
                          </div>
                        ) : (
                          <span className="st act">Open</span>
                        )
                      ) : (
                        <span className={`st ${STATE[f.state][1]}`}>{STATE[f.state][0]}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {dialog}
    </>
  );
}
