"use client";

import { useCallback, useState } from "react";
import { useCompany, useCompanyTx, useFleet } from "@/components/company/CompanyContext";
import { Bars, Columns, Dialog, Kpis, St, dayStart, downloadCsv, fmtDate, fmtDateTime, n3, omr, useAction, useLive, weekStart } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import { PENALTY_STATE } from "@/lib/labels";
import { ref, type Penalty } from "@/lib/types";

const KIND_LABEL: Record<string, string> = {
  earning: "Job earnings",
  tip: "Tip",
  cancel_fee: "Cancellation fee",
  penalty: "Penalty",
  penalty_reversal: "Penalty reversed",
  payout: "Payout to bank",
  fill_topup: "Filling credit top-up",
  fill_charge: "Filling station charge",
};

function nextSunday(now = new Date()) {
  return new Date(weekStart(now).getTime() + 7 * 86_400_000);
}

export default function CompanyFinance() {
  const { company, reloadCompany } = useCompany();
  const fleet = useFleet("finance");
  const { tx } = useCompanyTx("finance", 90);
  const [penalties, setPenalties] = useState<(Penalty & { label: string; order?: { order_no: number } | null })[]>([]);
  const [topup, setTopup] = useState(false);
  const [dispute, setDispute] = useState<(Penalty & { label: string }) | null>(null);

  const loadPenalties = useCallback(async () => {
    const db = supabase();
    const [p, r] = await Promise.all([
      db.from("penalties").select("*, order:orders(order_no)").eq("company_id", company.id).order("created_at", { ascending: false }).limit(100),
      db.from("penalty_rules").select("code, label"),
    ]);
    const labels = Object.fromEntries((r.data ?? []).map((x: { code: string; label: string }) => [x.code, x.label]));
    setPenalties(((p.data ?? []) as Penalty[]).map((x) => ({ ...x, label: labels[x.rule_code] ?? x.rule_code })));
  }, [company.id]);
  useLive("penalties", ["penalties"], loadPenalties);

  const week = weekStart().getTime();
  const thisWeek = tx.filter((x) => Date.parse(x.created_at) >= week && x.bucket === "earnings");
  const sum = (rows: typeof tx, kinds: string[]) => rows.filter((x) => kinds.includes(x.kind)).reduce((s, x) => s + Number(x.amount), 0);
  const earned = sum(thisWeek, ["earning", "cancel_fee"]);
  const tips = sum(thisWeek, ["tip"]);
  const fines = sum(thisWeek, ["penalty", "penalty_reversal"]);

  const byTanker = fleet.tankers
    .map((t) => ({ label: t.plate, value: Math.round(sum(thisWeek.filter((x) => x.tanker_id === t.id), ["earning", "tip", "cancel_fee"]) * 1000) / 1000 }))
    .sort((a, b) => b.value - a.value);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = dayStart();
    d.setDate(d.getDate() - (6 - i));
    const from = d.getTime();
    const to = from + 86_400_000;
    return {
      label: d.toLocaleDateString("en-GB", { weekday: "short" }),
      value: sum(tx.filter((x) => x.bucket === "earnings" && Date.parse(x.created_at) >= from && Date.parse(x.created_at) < to), ["earning", "tip", "cancel_fee"]),
    };
  });
  const payouts = tx.filter((x) => x.kind === "payout");
  const since30 = dayStart().getTime() - 29 * 86_400_000;
  const statement = tx.filter((x) => Date.parse(x.created_at) >= since30);
  const plate = (id: string | null) => fleet.tankers.find((t) => t.id === id)?.plate ?? "";
  const iban = company.iban ? `•••• ${company.iban.slice(-4)}` : "";
  const bank = company.bank_name ? `${company.bank_name}${iban ? ` ${iban}` : ""}` : "your bank (add details with NWS finance)";

  function exportCsv() {
    downloadCsv(`statement-${company.cr_no}-${new Date().toISOString().slice(0, 10)}.csv`, [
      ["Date", "Type", "Account", "Tanker", "Reference", "Amount (OMR)"],
      ...statement.map((x) => [new Date(x.created_at).toISOString(), KIND_LABEL[x.kind] ?? x.kind, x.bucket === "fill_credit" ? "Filling credit" : "Earnings", plate(x.tanker_id), x.memo, Number(x.amount).toFixed(3)]),
    ]);
  }

  return (
    <>
      <Kpis
        items={[
          { label: "Earned this week", value: omr(earned), sub: `Balance due ${omr(company.earnings_balance)}` },
          { label: "Tips", value: omr(tips), sub: "Paid in full to your company" },
          { label: "Penalties", value: omr(fines), sub: penalties.filter((p) => p.state === "issued").length ? `${penalties.filter((p) => p.state === "issued").length} can be disputed` : "None open", tone: fines < 0 ? "bad" : "ok" },
          { label: "Filling credit", value: omr(company.fill_credit), sub: Number(company.fill_credit) < 20 ? "Low — top up to keep filling" : "Used at NWS filling stations", tone: Number(company.fill_credit) < 20 ? "warn" : undefined },
        ]}
      />
      <div className="half">
        <div className="panel">
          <h2>
            Earnings by tanker <small>this week, incl. tips</small>
          </h2>
          <Bars rows={byTanker} empty="No tankers yet." />
          <h2 style={{ paddingTop: 4 }}>
            Last 7 days <small>OMR per day</small>
          </h2>
          <Columns rows={days} format={(v) => n3(v)} />
        </div>
        <div className="panel">
          <h2>Payouts</h2>
          <dl className="kv wide">
            <dt>Bank account</dt>
            <dd>{bank}</dd>
            <dt>Schedule</dt>
            <dd>Weekly on Sunday to {company.bank_name ?? "your bank"}</dd>
            <dt>Next payout</dt>
            <dd>
              {omr(Math.max(0, Number(company.earnings_balance)))} on {fmtDate(nextSunday().toISOString())}
            </dd>
            <dt>Filling credit</dt>
            <dd>{omr(company.fill_credit)}</dd>
          </dl>
          <div className="pad btns">
            <button className="btn pri" onClick={() => setTopup(true)}>
              Top up filling credit
            </button>
            <button className="btn" onClick={exportCsv} disabled={!statement.length}>
              Download statement (CSV)
            </button>
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Paid</th>
                  <th>Reference</th>
                  <th className="num">Amount (OMR)</th>
                </tr>
              </thead>
              <tbody>
                {payouts.slice(0, 8).map((x) => (
                  <tr key={x.id}>
                    <td>{fmtDate(x.created_at)}</td>
                    <td>{x.memo || "Weekly payout"}</td>
                    <td className="num">{n3(Math.abs(Number(x.amount)))}</td>
                  </tr>
                ))}
                {!payouts.length && (
                  <tr>
                    <td colSpan={3} className="empty">
                      No payouts in the last 90 days.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Penalties</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Penalty</th>
                <th>Rule</th>
                <th>Tanker</th>
                <th>Reason</th>
                <th>Issued</th>
                <th className="num">Amount (OMR)</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {penalties.map((p) => {
                const [s, tone] = PENALTY_STATE[p.state];
                return (
                  <tr key={p.id}>
                    <td>{ref.penalty(p.penalty_no)}</td>
                    <td>{p.label}</td>
                    <td className="tk-plate">{plate(p.tanker_id) || "—"}</td>
                    <td style={{ maxWidth: 300 }}>
                      {p.reason}
                      {p.order && <small className="docmeta">Order {ref.order(p.order.order_no)}</small>}
                      {p.dispute_text && <small className="docmeta">Your dispute: {p.dispute_text}</small>}
                    </td>
                    <td>{fmtDate(p.created_at)}</td>
                    <td className="num">{n3(p.amount)}</td>
                    <td>
                      <St tone={tone}>{s}</St>
                    </td>
                    <td className="num">
                      {p.state === "issued" && (
                        <button className="btn sm" onClick={() => setDispute(p)}>
                          Dispute
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!penalties.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    No penalties. Keep it up.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          Statement <small>last 30 days</small>
          <button className="btn sm" onClick={exportCsv} disabled={!statement.length}>
            Export CSV
          </button>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Account</th>
                <th>Tanker</th>
                <th>Reference</th>
                <th className="num">Amount (OMR)</th>
              </tr>
            </thead>
            <tbody>
              {statement.slice(0, 200).map((x) => (
                <tr key={x.id}>
                  <td>{fmtDateTime(x.created_at)}</td>
                  <td>{KIND_LABEL[x.kind] ?? x.kind}</td>
                  <td className="mut">{x.bucket === "fill_credit" ? "Filling credit" : "Earnings"}</td>
                  <td className="tk-plate">{plate(x.tanker_id) || "—"}</td>
                  <td>{x.memo}</td>
                  <td className="num" style={{ color: Number(x.amount) < 0 ? "var(--bad)" : undefined }}>
                    {Number(x.amount) > 0 ? "+" : ""}
                    {n3(x.amount)}
                  </td>
                </tr>
              ))}
              {!statement.length && (
                <tr>
                  <td colSpan={6} className="empty">
                    No transactions in the last 30 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {topup && <TopUp onClose={() => setTopup(false)} onDone={reloadCompany} />}
      {dispute && <Dispute penalty={dispute} onClose={() => setDispute(null)} onDone={loadPenalties} />}
    </>
  );
}

function TopUp({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [amount, setAmount] = useState(50);
  return (
    <Dialog title="Top up filling credit" body="Filling credit pays for water at NWS filling stations. Top-ups are by bank transfer (simulated) and show immediately." onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("top", () => supabase().rpc("owner_topup_fill_credit", { p_amount: amount }), `Filling credit topped up by ${omr(amount)}`, () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="chips" style={{ marginBottom: 12 }}>
          {[10, 50, 100, 250].map((v) => (
            <button type="button" key={v} className={`chip ${amount === v ? "on" : ""}`} onClick={() => setAmount(v)}>
              {v} OMR
            </button>
          ))}
        </div>
        <div className="fld">
          <label htmlFor="tuA">Amount (OMR, 10 to 10,000)</label>
          <input id="tuA" className="in" type="number" min={10} max={10000} step={1} required value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "top"}>
            {busy === "top" ? "Topping up…" : `Top up ${omr(amount)}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Dispute({ penalty, onClose, onDone }: { penalty: Penalty & { label: string }; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  return (
    <Dialog title={`Dispute ${ref.penalty(penalty.penalty_no)}`} body={`${penalty.label} — ${omr(penalty.amount)}. NWS reviews your explanation (describe any evidence, such as IVMS logs or photos, and how to get it); the amount is refunded if the penalty is cancelled.`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("disp", () => supabase().rpc("dispute_penalty", { p_penalty_id: penalty.id, p_text: text.trim() }), "Dispute sent to NWS", () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="dpT">Why should this penalty be cancelled?</label>
          <textarea id="dpT" className="in" rows={4} required minLength={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy === "disp" || text.trim().length < 3}>
            {busy === "disp" ? "Sending…" : "Send dispute"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
