"use client";

import { useCallback, useState } from "react";
import { useCompany, useCompanyTx, useFleet } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { PlatformFeesOwed } from "@/components/company/PlatformFees";
import { useFmt } from "@/components/portal/i18n";
import { Bars, Columns, Dialog, Kpis, St, dayStart, downloadCsv, useAction, useLive, weekStart } from "@/components/portal/kit";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { omanToday } from "@/lib/time";
import { penaltyState } from "@/lib/labels";
import { ref, type Penalty } from "@/lib/types";

// English ledger kinds for the CSV statement; the screen shows CO "kind_*" in the viewer's language.
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
  const t = useT(CO);
  const f = useFmt();
  const { lang } = useLang();
  const kindText = (k: string) => (CO[`kind_${k}`] ? t(`kind_${k}`) : k);
  const pref = (no: number | string) => <bdi dir="ltr">{ref.penalty(no)}</bdi>;

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
    const from = dayStart().getTime() - (6 - i) * 86_400_000; // Muscat days (no DST)
    const to = from + 86_400_000;
    return {
      label: f.fmt(from, { weekday: "short" }),
      value: sum(tx.filter((x) => x.bucket === "earnings" && Date.parse(x.created_at) >= from && Date.parse(x.created_at) < to), ["earning", "tip", "cancel_fee"]),
    };
  });
  const payouts = tx.filter((x) => x.kind === "payout");
  const since30 = dayStart().getTime() - 29 * 86_400_000;
  const statement = tx.filter((x) => Date.parse(x.created_at) >= since30);
  const plate = (id: string | null) => fleet.tankers.find((t) => t.id === id)?.plate ?? "";
  const iban = company.iban ? `•••• ${company.iban.slice(-4)}` : "";
  const bank = company.bank_name ? `${company.bank_name}${iban ? ` ${iban}` : ""}` : t("bankMissing");

  function exportCsv() {
    downloadCsv(`statement-${company.cr_no}-${omanToday()}.csv`, [
      ["Date", "Type", "Account", "Tanker", "Reference", "Amount (OMR)"],
      ...statement.map((x) => [new Date(x.created_at).toISOString(), KIND_LABEL[x.kind] ?? x.kind, x.bucket === "fill_credit" ? "Filling credit" : "Earnings", plate(x.tanker_id), x.memo, Number(x.amount).toFixed(3)]),
    ]);
  }

  return (
    <>
      <Kpis
        items={[
          { label: t("kEarnedWeek"), value: f.omr(earned), sub: t("balanceDue", { v: f.omr(company.earnings_balance) }) },
          { label: t("tips"), value: f.omr(tips), sub: t("tipsSub") },
          {
            label: t("penalties"),
            value: f.omr(fines),
            sub: penalties.filter((p) => p.state === "issued").length ? t("canDisputeN", { n: f.n(penalties.filter((p) => p.state === "issued").length) }) : t("noneOpen"),
            tone: fines < 0 ? "bad" : "ok",
          },
          { label: t("acctFill"), value: f.omr(company.fill_credit), sub: Number(company.fill_credit) < 20 ? t("fillLow") : t("fillUsed"), tone: Number(company.fill_credit) < 20 ? "warn" : undefined },
        ]}
      />
      <div className="half">
        <div className="panel">
          <h2>
            {t("byTanker")} <small>{t("byTankerSub")}</small>
          </h2>
          <Bars rows={byTanker} empty={t("noTankersYet")} />
          <h2 style={{ paddingTop: 4 }}>
            {t("last7")} <small>{t("perDay")}</small>
          </h2>
          <Columns rows={days} format={(v) => f.n3(v)} />
        </div>
        <div className="panel">
          <h2>{t("payoutsTitle")}</h2>
          <dl className="kv wide">
            <dt>{t("bankAcct")}</dt>
            <dd>{bank}</dd>
            <dt>{t("schedule")}</dt>
            <dd>{t("weeklyTo", { bank: company.bank_name ?? t("yourBank") })}</dd>
            <dt>{t("nextPayout")}</dt>
            <dd>{t("payoutOn", { amt: f.omr(Math.max(0, Number(company.earnings_balance))), date: f.date(nextSunday().toISOString()) })}</dd>
            <dt>{t("acctFill")}</dt>
            <dd>{f.omr(company.fill_credit)}</dd>
          </dl>
          <div className="pad btns">
            <button className="btn pri" onClick={() => setTopup(true)}>
              {t("topupBtn")}
            </button>
            <button className="btn" onClick={exportCsv} disabled={!statement.length}>
              {t("dlStatement")}
            </button>
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("paidCol")}</th>
                  <th>{t("reference")}</th>
                  <th className="num">{t("amountOmr")}</th>
                </tr>
              </thead>
              <tbody>
                {payouts.slice(0, 8).map((x) => (
                  <tr key={x.id}>
                    <td>{f.date(x.created_at)}</td>
                    <td>{x.memo || t("weeklyPayout")}</td>
                    <td className="num">{f.n3(Math.abs(Number(x.amount)))}</td>
                  </tr>
                ))}
                {!payouts.length && (
                  <tr>
                    <td colSpan={3} className="empty">
                      {t("noPayouts")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <PlatformFeesOwed />

      <div className="panel">
        <h2>{t("penalties")}</h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("penaltyCol")}</th>
                <th>{t("ruleCol")}</th>
                <th>{t("tanker")}</th>
                <th>{t("reason")}</th>
                <th>{t("issuedCol")}</th>
                <th className="num">{t("amountOmr")}</th>
                <th>{t("status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {penalties.map((p) => {
                const [s, tone] = penaltyState(p.state, lang);
                return (
                  <tr key={p.id}>
                    <td>{pref(p.penalty_no)}</td>
                    <td>{p.label}</td>
                    <td className="tk-plate">{plate(p.tanker_id) || "—"}</td>
                    <td style={{ maxWidth: 300 }}>
                      {p.reason}
                      {p.order && <small className="docmeta">{t("orderX", { no: `\u2066${ref.order(p.order.order_no)}\u2069` })}</small>}
                      {p.dispute_text && <small className="docmeta">{t("yourDispute", { text: p.dispute_text })}</small>}
                    </td>
                    <td>{f.date(p.created_at)}</td>
                    <td className="num">{f.n3(p.amount)}</td>
                    <td>
                      <St tone={tone}>{s}</St>
                    </td>
                    <td className="num">
                      {p.state === "issued" && (
                        <button className="btn sm" onClick={() => setDispute(p)}>
                          {t("disputeBtn")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!penalties.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    {t("noPenalties")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          {t("statement")} <small>{t("last30")}</small>
          <button className="btn sm" onClick={exportCsv} disabled={!statement.length}>
            {t("exportCsv")}
          </button>
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("date")}</th>
                <th>{t("type")}</th>
                <th>{t("account")}</th>
                <th>{t("tanker")}</th>
                <th>{t("reference")}</th>
                <th className="num">{t("amountOmr")}</th>
              </tr>
            </thead>
            <tbody>
              {statement.slice(0, 200).map((x) => (
                <tr key={x.id}>
                  <td>{f.dateTime(x.created_at)}</td>
                  <td>{kindText(x.kind)}</td>
                  <td className="mut">{x.bucket === "fill_credit" ? t("acctFill") : t("acctEarn")}</td>
                  <td className="tk-plate">{plate(x.tanker_id) || "—"}</td>
                  <td>{x.memo}</td>
                  <td className="num" style={{ color: Number(x.amount) < 0 ? "var(--bad)" : undefined }}>
                    <bdi dir="ltr">
                      {Number(x.amount) > 0 ? "+" : ""}
                      {f.n3(x.amount)}
                    </bdi>
                  </td>
                </tr>
              ))}
              {!statement.length && (
                <tr>
                  <td colSpan={6} className="empty">
                    {t("noTx")}
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
  const t = useT(CO);
  const f = useFmt();
  return (
    <Dialog title={t("topTitle")} body={t("topBody")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("top", () => supabase().rpc("owner_topup_fill_credit", { p_amount: amount }), t("toppedUp", { amt: f.omr(amount) }), () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="chips" style={{ marginBottom: 12 }}>
          {[10, 50, 100, 250].map((v) => (
            <button type="button" key={v} className={`chip ${amount === v ? "on" : ""}`} onClick={() => setAmount(v)}>
              {f.ar ? `${f.n(v)} ر.ع.` : `${v} OMR`}
            </button>
          ))}
        </div>
        <div className="fld">
          <label htmlFor="tuA">{t("amountRange")}</label>
          <input id="tuA" className="in" dir="ltr" type="number" min={10} max={10000} step={1} required value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "top"}>
            {busy === "top" ? t("toppingUp") : t("topUpX", { amt: f.omr(amount) })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Dispute({ penalty, onClose, onDone }: { penalty: Penalty & { label: string }; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const t = useT(CO);
  const f = useFmt();
  return (
    <Dialog
      title={t("dispTitle", { no: `\u2066${ref.penalty(penalty.penalty_no)}\u2069` })}
      body={t("dispBody", { label: penalty.label, amt: f.omr(penalty.amount) })}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run("disp", () => supabase().rpc("dispute_penalty", { p_penalty_id: penalty.id, p_text: text.trim() }), t("dispSent"), () => {
            onDone();
            onClose();
          });
        }}
      >
        <div className="fld">
          <label htmlFor="dpT">{t("dispWhy")}</label>
          <textarea id="dpT" className="in" rows={4} required minLength={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
        <div className="btns" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn pri" disabled={busy === "disp" || text.trim().length < 3}>
            {busy === "disp" ? t("sending") : t("sendDispute")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
