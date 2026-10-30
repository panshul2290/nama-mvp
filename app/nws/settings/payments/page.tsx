"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Chips, ConfirmDialog, downloadCsv, Empty, fetchPaged, Kpi, PageHead, ReadOnlyNote, useRun } from "@/components/nws/admin/ui";
import { FillCreditPanel } from "@/components/nws/admin/FillCreditPanel";
import { SETTINGS_OPS } from "@/components/nws/i18n/settingsOps";
import { useStaff } from "@/components/nws/StaffContext";
import { useFmt } from "@/components/portal/i18n";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref } from "@/lib/types";

type Kind = "All" | "Payment" | "Top-up" | "Tip" | "Refund" | "Fine" | "Payout";
// `reference`, `party` and `status` are the English export text; the screen shows `ord`, `method` and `memo` in the viewer's language.
type Line = { id: string; at: string; kind: Exclude<Kind, "All">; party: string; reference: string; amount: number; status: string; tone: string; ord?: string; method?: string; memo?: string };
type Batch = { id: string; batch_no: number; total: string; companies: number; created_at: string; run_by: string | null };

type OrdRef = { order_no: number; is_test: boolean } | null;
type Pay = { id: string; created_at: string; method: string; amount: string; wallet_amount: string; status: string; gateway_ref: string | null; refunded_amount: string; order: OrdRef; customer: { full_name: string } | null };
type WTx = { id: number; created_at: string; kind: string; amount: string; memo: string; order: OrdRef; customer: { full_name: string } | null };
type CTx = { id: number; created_at: string; kind: string; amount: string; memo: string; company_id: string; order: OrdRef; company: { name: string } | null };
// Test-zone orders (0020) stay out of the ledger and the KPIs; rows without an order (top-ups, payouts) stay in.
const real = (r: { order: OrdRef }) => !r.order?.is_test;

const PAY_STATUS: Record<string, [string, string]> = {
  captured: ["Settled", "ok"], authorized: ["Authorised", "act"], failed: ["Failed", "bad"], refunded: ["Refunded", "warn"],
  partially_refunded: ["Part refunded", "warn"], on_account: ["On account", "act"],
};
const METHOD: Record<string, string> = { wallet: "Wallet", card: "Card", omannet: "OmanNet", wallet_card: "Wallet + card", account: "Account", cash: "Cash" };
// English export wording → dictionary key, for the screen.
const SHOWN: Record<string, string> = {
  All: "all", Payment: "payKPayment", "Top-up": "payKTopup", Tip: "payKTip", Refund: "payKRefund", Fine: "payKFine", Payout: "payKPayout",
  Settled: "paySettled", Authorised: "payAuthorised", Failed: "payFailed", Refunded: "payRefunded", "Part refunded": "payPartRefunded", "On account": "payOnAccount",
  "Paid (simulated bank transfer)": "payPaidSim", Reversed: "payReversed", Customer: "customer", "Tanker company": "payTankerCo",
  Wallet: "payMWallet", Card: "payMCard", OmanNet: "payMOmanNet", "Wallet + card": "payMWalletCard", Account: "payMAccount", Cash: "payMCash",
};
const KINDS: Exclude<Kind, "All">[] = ["Payment", "Top-up", "Tip", "Refund", "Fine", "Payout"];
const DAYS = 30;

/** Start of the current month in Muscat (UTC+4, no daylight saving), whatever the browser's time zone. */
function monthStart() {
  const m = new Date(Date.now() + 4 * 3600_000);
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) - 4 * 3600_000).toISOString();
}

export default function PaymentsPage() {
  const { can } = useStaff();
  const run = useRun();
  const t = useT(SETTINGS_OPS);
  const f = useFmt();
  const shownText = (s: string) => (SHOWN[s] ? t(SHOWN[s]) : s);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [kpi, setKpi] = useState<{ collected: number; paidMonth: number; paidAll: number; pending: number; pendingCos: number; failed: number; payments: number } | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [kind, setKind] = useState<Kind>("All");
  const [confirm, setConfirm] = useState(false);
  const finance = can("finance", "admin");

  const load = useCallback(() => {
    const db = supabase();
    const from = new Date(Date.now() - DAYS * 86400_000).toISOString();
    const month = monthStart();
    Promise.all([
      db.from("payments").select("id, created_at, method, amount, wallet_amount, status, gateway_ref, refunded_amount, order:orders(order_no, is_test), customer:profiles(full_name)").gte("created_at", from).order("created_at", { ascending: false }).limit(1000),
      db.from("wallet_tx").select("id, created_at, kind, amount, memo, order:orders(order_no, is_test), customer:profiles(full_name)").in("kind", ["topup", "refund", "goodwill", "cancel_fee"]).gte("created_at", from).order("created_at", { ascending: false }).limit(1000),
      db.from("company_tx").select("id, created_at, kind, amount, memo, company_id, order:orders(order_no, is_test), company:companies(name)").in("kind", ["tip", "penalty", "penalty_reversal", "payout"]).gte("created_at", from).order("created_at", { ascending: false }).limit(1000),
      // KPI sources: this month's money in, and every earnings row for balances.
      fetchPaged<{ amount: string; wallet_amount: string; status: string; order: OrdRef }>((a, b) => db.from("payments").select("amount, wallet_amount, status, order:orders(order_no, is_test)").gte("created_at", month).order("id").range(a, b), 50000),
      fetchPaged<{ amount: string }>((a, b) => db.from("wallet_tx").select("amount").eq("kind", "topup").gte("created_at", month).order("id").range(a, b), 50000),
      fetchPaged<{ company_id: string; kind: string; amount: string; created_at: string }>((a, b) => db.from("company_tx").select("company_id, kind, amount, created_at").eq("bucket", "earnings").order("id").range(a, b), 100000),
    ]).then(([p, w, c, pm, tm, all]) => {
      const out: Line[] = [];
      for (const r of ((p.data ?? []) as unknown as Pay[]).filter(real)) {
        const [st, tone] = PAY_STATUS[r.status] ?? [r.status, ""];
        out.push({ id: `P-${r.id.slice(0, 8)}`, at: r.created_at, kind: "Payment", party: r.customer?.full_name || "Customer", reference: `${r.order ? ref.order(r.order.order_no) : "—"} · ${METHOD[r.method] ?? r.method}`, amount: Number(r.amount), status: st, tone, ord: r.order ? ref.order(r.order.order_no) : "—", method: METHOD[r.method] ?? r.method });
      }
      for (const r of ((w.data ?? []) as unknown as WTx[]).filter(real)) {
        const k: Line["kind"] = r.kind === "topup" ? "Top-up" : r.kind === "cancel_fee" ? "Fine" : "Refund";
        out.push({ id: `W-${r.id}`, at: r.created_at, kind: k, party: r.customer?.full_name || "Customer", reference: r.order ? `${ref.order(r.order.order_no)} · ${r.memo}` : r.memo, amount: Number(r.amount), status: "Settled", tone: "ok", ord: r.order ? ref.order(r.order.order_no) : undefined, memo: r.memo });
      }
      for (const r of ((c.data ?? []) as unknown as CTx[]).filter(real)) {
        const k: Line["kind"] = r.kind === "tip" ? "Tip" : r.kind === "payout" ? "Payout" : "Fine";
        out.push({ id: `C-${r.id}`, at: r.created_at, kind: k, party: r.company?.name || "Tanker company", reference: r.order ? `${ref.order(r.order.order_no)} · ${r.memo}` : r.memo, amount: Number(r.amount), status: r.kind === "payout" ? "Paid (simulated bank transfer)" : r.kind === "penalty_reversal" ? "Reversed" : "Settled", tone: r.kind === "penalty_reversal" ? "warn" : "ok", ord: r.order ? ref.order(r.order.order_no) : undefined, memo: r.memo });
      }
      setLines(out.sort((a, b) => b.at.localeCompare(a.at)));

      const pays = pm.rows.filter(real);
      // Money actually collected from customers: the non-wallet part of captured payments plus wallet top-ups (wallet spend isn't counted twice).
      const collected = pays.filter((x) => ["captured", "partially_refunded", "refunded"].includes(x.status)).reduce((a, x) => a + Number(x.amount) - Number(x.wallet_amount), 0)
        + tm.rows.reduce((a, x) => a + Number(x.amount), 0);
      const rows = all.rows;
      const bal = new Map<string, number>();
      for (const r of rows) bal.set(r.company_id, (bal.get(r.company_id) ?? 0) + Number(r.amount));
      const payouts = rows.filter((r) => r.kind === "payout");
      setKpi({
        collected,
        paidMonth: -payouts.filter((r) => r.created_at >= month).reduce((a, r) => a + Number(r.amount), 0),
        paidAll: -payouts.reduce((a, r) => a + Number(r.amount), 0),
        pending: [...bal.values()].filter((v) => v > 0).reduce((a, v) => a + v, 0),
        pendingCos: [...bal.values()].filter((v) => v > 0).length,
        failed: pays.filter((x) => x.status === "failed").length,
        payments: pays.length,
      });
    });
    db.from("payout_batches").select("*").order("created_at", { ascending: false }).limit(20).then(({ data }) => {
      const b = (data ?? []) as Batch[];
      setBatches(b);
      const ids = [...new Set(b.map((x) => x.run_by).filter((x): x is string => !!x))];
      if (ids.length) db.from("profiles").select("id, full_name").in("id", ids).then(({ data: ps }) => setNames(new Map(((ps ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name]))));
    });
  }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => (lines ?? []).filter((l) => kind === "All" || l.kind === kind), [lines, kind]);
  const counts = (k: Kind) => (lines ?? []).filter((l) => k === "All" || l.kind === k).length;

  return (
    <>
      <PageHead title={t("payTitle")} sub={t("paySub")} />
      {!finance && <ReadOnlyNote who={t("whoAdminFinance")} />}
      <div className="okpis">
        <Kpi label={t("payCollected")} value={kpi ? f.n3(kpi.collected) : "…"} sub={t("payCollectedSub")} />
        <Kpi label={t("payPaidOut")} value={kpi ? f.n3(kpi.paidMonth) : "…"} sub={kpi ? t("payPaidOutSub", { all: f.n3(kpi.paidAll) }) : undefined} />
        <Kpi label={t("payPendingK")} value={kpi ? f.n3(kpi.pending) : "…"} sub={kpi ? t(kpi.pendingCos === 1 ? "payCosOne" : "payCosN", { n: f.n(kpi.pendingCos) }) : undefined} tone={kpi?.pending ? "warn" : undefined} />
        <Kpi label={t("payFailedK")} value={kpi ? f.n(kpi.failed) : "…"} sub={kpi?.payments ? t("payFailedSub", { pct: f.pct(kpi.failed / kpi.payments), n: f.n(kpi.payments) }) : t("thisMonthLc")} tone={kpi && kpi.payments && kpi.failed / kpi.payments > 0.02 ? "bad" : undefined} />
      </div>

      <div className="panel">
        <div className="toolbar">
          <Chips items={(["All", ...KINDS] as Kind[]).map((k) => [k, shownText(k), lines ? counts(k) : undefined] as [Kind, string, number?])} value={kind} onChange={setKind} />
          <div className="btns">
            {finance && <button className="btn pri" onClick={() => setConfirm(true)}>{t("payRun")}</button>}
            <button
              className="btn"
              disabled={!shown.length}
              onClick={() => {
                downloadCsv(`ledger_${kind}`, [["Ref", "Time", "Type", "Party", "For", "OMR", "Status"], ...shown.map((l) => [l.id, l.at, l.kind, l.party, l.reference, l.amount.toFixed(3), l.status])]);
                void supabase().rpc("staff_log_export", { p_what: `payments ledger (${kind})`, p_rows: shown.length });
              }}
            >
              {t("exportCsv")}
            </button>
          </div>
        </div>
        <div className="tblwrap scroll">
          <table>
            <thead><tr><th>{t("payRef")}</th><th>{t("time")}</th><th>{t("type")}</th><th>{t("payParty")}</th><th>{t("payFor")}</th><th className="num">{t("payOmr")}</th><th>{t("status")}</th></tr></thead>
            <tbody>
              {!lines && <Empty cols={7}>{t("loading")}</Empty>}
              {lines && shown.length === 0 && <Empty cols={7}>{kind === "All" ? t("payNoneAll", { n: f.n(DAYS) }) : t("payNoneKind", { kind: shownText(kind), n: f.n(DAYS) })}</Empty>}
              {shown.slice(0, 300).map((l) => (
                <tr key={l.id}>
                  <td><small dir="ltr">{l.id}</small></td>
                  <td><small>{f.dateTime(l.at)}</small></td>
                  <td>{shownText(l.kind)}</td>
                  <td>{shownText(l.party)}</td>
                  <td>
                    <small>
                      {l.ord && <bdi dir="ltr">{l.ord}</bdi>}
                      {l.ord && (l.method || l.memo) ? " · " : ""}
                      {l.method ? shownText(l.method) : l.memo}
                    </small>
                  </td>
                  <td className="num" style={{ color: l.amount < 0 ? "var(--bad)" : undefined }}>{f.n3(l.amount)}</td>
                  <td><span className={`st ${l.tone}`}>{shownText(l.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{t(shown.length > 300 ? "payNoteCapped" : "payNote", { n: f.n(DAYS), max: f.n(300) })}</p>
      </div>

      <FillCreditPanel />

      <div className="panel">
        <h2>{t("payBatches")} <small>{finance ? t("payBatchesCan") : t("payBatchesBy")}</small></h2>
        <div className="tblwrap">
          <table>
            <thead><tr><th>{t("payBatch")}</th><th>{t("payRunH")}</th><th>{t("payBy")}</th><th className="num">{t("payCompanies")}</th><th className="num">{t("pcTotal")}</th></tr></thead>
            <tbody>
              {batches?.length === 0 && <Empty cols={5}>{t("payNoBatches")}</Empty>}
              {batches?.map((b) => (
                <tr key={b.id}>
                  <td><b dir="ltr">{ref.payout(b.batch_no)}</b></td>
                  <td>{f.dateTime(b.created_at)}</td>
                  <td>{(b.run_by && names.get(b.run_by)) || "—"}</td>
                  <td className="num">{f.n(b.companies)}</td>
                  <td className="num">{f.n3(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={t("payRun")}
          body={
            <>
              {t("payRunB1")}
              {kpi ? <> — <b>{f.omr3(kpi.pending)}</b> {t(kpi.pendingCos === 1 ? "payToOne" : "payToN", { n: f.n(kpi.pendingCos) })}</> : null}
              {t("payRunB2")}
            </>
          }
          confirm={t("payRun")}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            if (await run(supabase().rpc("staff_run_payout_batch"), t("payRunOk"))) load();
            setConfirm(false);
          }}
        />
      )}
    </>
  );
}
