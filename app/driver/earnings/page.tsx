"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { DICT, useErrText, useFmt } from "@/components/driver/i18n";
import { useNow } from "@/components/driver/useNow";
import { useT } from "@/lib/i18n";
import { PENALTY_STATE } from "@/lib/labels";
import { isOnTime, muscatDayStart, muscatWeekStart } from "@/lib/sla";
import { supabase } from "@/lib/supabase/client";
import { ref, type CompanyTx, type Order, type Penalty } from "@/lib/types";

type Row = Pick<CompanyTx, "id" | "bucket" | "kind" | "amount" | "order_id" | "memo" | "created_at">;
type MyOrder = Pick<
  Order,
  "id" | "order_no" | "area" | "status" | "service_type" | "rating" | "tip" | "driver_earnings" | "created_at" | "released_at" | "accepted_at" | "slot_end" | "collected_at" | "delivered_at"
>;
const EARNING_KINDS = ["earning", "tip", "cancel_fee", "penalty", "penalty_reversal"];

export default function EarningsPage() {
  const { profile, tanker, prefs, toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const errText = useErrText();
  const now = useNow(60_000);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [released, setReleased] = useState(0);
  const [penalties, setPenalties] = useState<Penalty[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [disputing, setDisputing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const db = supabase();
    // The working week starts on Sunday in Oman (Muscat time).
    const week = muscatWeekStart().toISOString();
    db.from("orders")
      .select("id, order_no, area, status, service_type, rating, tip, driver_earnings, created_at, released_at, accepted_at, slot_end, collected_at, delivered_at")
      .eq("driver_id", profile.id)
      .order("accepted_at", { ascending: false })
      .limit(300)
      .then(({ data }) => {
        const os = (data ?? []) as MyOrder[];
        setOrders(os);
        // Self-registered tankers have no company ledger: derive the week from delivered orders.
        if (!tanker.company_id)
          setRows(
            os
              .filter((o) => o.status === "delivered" && o.delivered_at && o.delivered_at >= week)
              .flatMap((o, i): Row[] => [
                { id: -2 * i - 1, bucket: "earnings", kind: "earning", amount: o.driver_earnings, order_id: o.id, memo: ref.order(o.order_no), created_at: o.delivered_at! },
                ...(Number(o.tip ?? 0) > 0
                  ? [{ id: -2 * i - 2, bucket: "earnings" as const, kind: "tip", amount: String(o.tip), order_id: o.id, memo: ref.order(o.order_no), created_at: o.delivered_at! }]
                  : []),
              ]),
          );
      });
    if (tanker.company_id)
      db.from("company_tx")
        .select("id, bucket, kind, amount, order_id, memo, created_at")
        .eq("driver_id", profile.id)
        .gte("created_at", week)
        .order("created_at", { ascending: false })
        .then(({ data }) => setRows((data ?? []) as Row[]));
    db.from("trip_issues")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", profile.id)
      .eq("released", true)
      .then(({ count }) => setReleased(count ?? 0));
    db.from("penalties")
      .select("*")
      .eq("driver_id", profile.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setPenalties((data ?? []) as Penalty[]));
    db.from("penalty_rules")
      .select("code, label")
      .then(({ data }) => setLabels(Object.fromEntries((data ?? []).map((r) => [r.code as string, r.label as string]))));
  }, [profile.id, tanker.company_id]);

  useEffect(() => {
    const t0 = setTimeout(load, 0);
    return () => clearTimeout(t0);
  }, [load]);

  const sums = useMemo(() => {
    const day = now ? muscatDayStart(now).toISOString() : "";
    const s = { today: 0, week: 0, tipsToday: 0, tipsWeek: 0, fillToday: 0, fillWeek: 0 };
    for (const r of rows ?? []) {
      const a = Number(r.amount);
      const isToday = day !== "" && r.created_at >= day;
      if (r.bucket === "fill_credit" && r.kind === "fill_charge") {
        s.fillWeek -= a;
        if (isToday) s.fillToday -= a;
      } else if (r.bucket === "earnings" && EARNING_KINDS.includes(r.kind)) {
        s.week += a;
        if (isToday) s.today += a;
        if (r.kind === "tip") {
          s.tipsWeek += a;
          if (isToday) s.tipsToday += a;
        }
      }
    }
    return s;
  }, [rows, now]);

  const perf = useMemo(() => {
    const delivered = orders.filter((o) => o.status === "delivered");
    const rated = delivered.filter((o) => o.rating != null);
    const timed = orders.map(isOnTime).filter((v): v is boolean => v != null);
    const onTime = timed.filter(Boolean);
    const accepted = orders.length + released;
    const declined = Number(prefs.declined ?? 0);
    return {
      rating: rated.length ? rated.reduce((s, o) => s + Number(o.rating), 0) / rated.length : null,
      ratings: rated.length,
      onTime: timed.length ? Math.round((onTime.length / timed.length) * 100) : null,
      acceptance: accepted + declined ? Math.round((accepted / (accepted + declined)) * 100) : null,
      jobs: delivered.length,
      recent: delivered.slice(0, 10),
    };
  }, [orders, released, prefs.declined]);

  async function dispute(id: string) {
    setBusy(true);
    const { error } = await supabase().rpc("dispute_penalty", { p_penalty_id: id, p_text: text.trim() });
    setBusy(false);
    if (error) return toast(errText(error));
    toast(t("disputeSent"));
    setDisputing(null);
    setText("");
    load();
  }

  const pct = (v: number | null) => (v == null ? "—" : `${f.d(v)}%`);
  const signed = (a: number) => `${a >= 0 ? "+" : "−"}${f.money(Math.abs(a))}`;
  // Same tones as the web portals (lib/labels); the words come from the driver's own EN/AR strings.
  const STATE_TONE: Record<Penalty["state"], string> = { issued: PENALTY_STATE.issued[1], disputed: PENALTY_STATE.disputed[1], upheld: PENALTY_STATE.upheld[1], cancelled: PENALTY_STATE.cancelled[1] };

  return (
    <main className="screen">
      <div className="ptop">
        <h3>{t("tEarnings")}</h3>
      </div>

      <div className="card">
        <p>{t("today")}</p>
        <div className="money">{rows ? f.omr(sums.today) : "…"}</div>
        <p>{t("includesTips", { tips: f.omr(sums.tipsToday), week: f.omr(sums.week) })}</p>
        <p style={{ marginTop: 6 }}>{t("weekTips", { tips: f.omr(sums.tipsWeek) })}</p>
        <div className="d-note">
          <span className="st act">{t("payoutSunday")}</span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <h4>{t("fillCreditUsed")}</h4>
            <p>{t("fillCreditS")}</p>
          </div>
          <div style={{ textAlign: "end" }}>
            <div className="money" style={{ fontSize: 20 }}>
              {f.money(sums.fillToday)}
            </div>
            <p>{t("thisWeekX", { amt: f.money(sums.fillWeek) })}</p>
          </div>
        </div>
      </div>

      <div className="card">
        <h4>{t("performance")}</h4>
        <div className="d-kpis">
          <div>
            <b>{perf.rating == null ? "—" : `★ ${f.d(perf.rating.toFixed(1))}`}</b>
            <small>{t("ratingN", { n: f.d(perf.ratings) })}</small>
          </div>
          <div>
            <b>{pct(perf.onTime)}</b>
            <small>{t("onTime")}</small>
          </div>
          <div>
            <b>{pct(perf.acceptance)}</b>
            <small>{t("acceptance")}</small>
          </div>
          <div>
            <b>{f.d(perf.jobs)}</b>
            <small>{t("jobsDone")}</small>
          </div>
        </div>
      </div>

      <h4 className="d-h4">{t("thisWeek")}</h4>
      {!rows ? (
        <p className="mut small">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="mut small">{t("noLedger")}</p>
      ) : (
        rows.slice(0, 30).map((r) => (
          <div key={r.id} className="lrow">
            <span>
              {t(`tx_${r.kind}`)}
              <small>
                {f.date(r.created_at)} · {r.memo}
              </small>
            </span>
            <span className={`num ${Number(r.amount) < 0 ? "d-neg" : ""}`}>{signed(Number(r.amount))}</span>
          </div>
        ))
      )}

      <h4 className="d-h4">{t("recentJobs")}</h4>
      {perf.recent.length === 0 ? (
        <p className="mut small">{t("noRecent")}</p>
      ) : (
        perf.recent.map((o) => (
          <div key={o.id} className="lrow">
            <span>
              {f.order(o.order_no)}
              <small>
                {o.area}
                {o.rating ? ` · ${f.d(o.rating)}★` : ""}
                {Number(o.tip ?? 0) > 0 ? ` · ${t("tipX", { amt: f.money(Number(o.tip)) })}` : ""}
              </small>
            </span>
            <span className="num">+{f.money(Number(o.driver_earnings))}</span>
          </div>
        ))
      )}

      <h4 className="d-h4">{t("penalties")}</h4>
      {penalties.length === 0 ? (
        <p className="mut small">{t("noPenalties")}</p>
      ) : (
        penalties.map((p) => (
          <div key={p.id} className="d-pen">
            <div className="lrow">
              <span>
                {f.date(p.created_at)} · {labels[p.rule_code] ?? p.reason}
                <small>
                  {ref.penalty(p.penalty_no)} · {p.reason}
                </small>
              </span>
              <span className="num d-neg">−{f.money(Number(p.amount))}</span>
            </div>
            <div className="row" style={{ padding: "6px 0 10px" }}>
              <span className={`st ${STATE_TONE[p.state]}`}>{t(`pen_${p.state}`)}</span>
              {p.state === "issued" && disputing !== p.id && (
                <button className="btn sm" onClick={() => setDisputing(p.id)}>
                  {t("dispute")}
                </button>
              )}
            </div>
            {p.dispute_text && <p className="mut small">{t("yourDispute", { text: p.dispute_text })}</p>}
            {disputing === p.id && (
              <div className="fld">
                <label htmlFor={`dsp-${p.id}`}>{t("disputeWhy")}</label>
                <input id={`dsp-${p.id}`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
                <div className="d-btns2">
                  <button className="btn sm" onClick={() => setDisputing(null)}>
                    {t("cancel")}
                  </button>
                  <button className="btn sm pri" disabled={busy || text.trim().length < 3} onClick={() => dispute(p.id)}>
                    {busy ? t("sending") : t("sendDispute")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </main>
  );
}
