"use client";

// Money on the customer's order screen: the payment confirmation (live: payments are in the
// realtime publication, 0036) and the "driver asked for more money" report (0035).
import { useEffect, useRef, useState } from "react";
import { useCx } from "@/components/customer/i18n";
import { amt3, dtshort, omr3, tshort } from "@/components/customer/fmt";
import { Sheet } from "@/components/customer/ui";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { Order, Payment } from "@/lib/types";

/** The order's payment, kept live. undefined while loading, null when there is none. */
export function useOrderPayment(orderId: string): Payment | null | undefined {
  const [pay, setPay] = useState<Payment | null | undefined>(undefined);
  useEffect(() => {
    if (!orderId) return;
    const db = supabase();
    let live = true;
    const load = () =>
      db
        .from("payments")
        .select("*")
        .eq("order_id", orderId)
        .eq("kind", "order")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<Payment>()
        .then(({ data }) => live && setPay(data ?? null));
    load();
    const ch = db
      .channel(`payment-${orderId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "payments", filter: `order_id=eq.${orderId}` }, (p) => {
        if (p.new && (p.new as Payment).id && (p.new as Payment).kind !== "tip") setPay(p.new as Payment);
      })
      .subscribe((s) => {
        if (s === "SUBSCRIBED") load();
      });
    return () => {
      live = false;
      db.removeChannel(ch);
    };
  }, [orderId]);
  return pay;
}

/** "Payment received — X OMR" with the reference, or "We're confirming your payment". */
export function PaymentCard({ order }: { order: Order }) {
  const { t, lang } = useCx();
  const pay = useOrderPayment(order.id);
  if (!pay || order.billing === "account" || pay.status === "on_account") return null;
  const at = pay.confirmed_at ?? pay.captured_at ?? pay.created_at;
  const how =
    pay.method === "wallet" || (pay.method === "wallet_card" && !(Number(pay.card_amount) > 0))
      ? t("payByWallet")
      : pay.method === "omannet"
        ? t("payByOmannet")
        : pay.method === "wallet_card" && Number(pay.wallet_amount) > 0
          ? t("payBySplit", { w: amt3(pay.wallet_amount, lang), l: pay.card_last4 ?? "", c: amt3(pay.card_amount, lang) })
          : t("payByCard", { l: pay.card_last4 ?? "" });
  const refLine = pay.gateway_ref ? <small dir="auto">{t("payRefAt", { r: pay.gateway_ref, t: dtshort(at, lang) })}</small> : null;

  if (pay.status === "pending")
    return (
      <div className="banner info pay-card" role="status" aria-live="polite">
        <b>{t("payPendT")}</b>
        <small>{t("payPendS", { t: tshort(pay.created_at, lang) })}</small>
        {refLine}
      </div>
    );
  if (pay.status === "failed")
    return (
      <div className="banner badb pay-card" role="status">
        <b>{t("payFailedT")}</b>
        {pay.failure_reason && <small>{pay.failure_reason}</small>}
      </div>
    );
  if (pay.method === "cash")
    return pay.status === "authorized" ? (
      <div className="banner pay-card" role="status">
        <b>{t("payCod", { a: omr3(pay.amount, lang) })}</b>
      </div>
    ) : null;
  return (
    <div className="banner okb pay-card" role="status" aria-live="polite">
      <b>{t("payRecvdT", { a: omr3(pay.amount, lang) })}</b>
      <small>{how}</small>
      {refLine}
      {Number(pay.refunded_amount) > 0 && <small>{t("payRefundedS", { a: omr3(pay.refunded_amount, lang) })}</small>}
      {Number(pay.refunded_to_card ?? 0) > 0 && <small>{t("payRefundedCard", { a: omr3(pay.refunded_to_card ?? 0, lang), l: pay.card_last4 ?? "" })}</small>}
    </div>
  );
}

const ACTIVE = ["accepted", "arriving", "arrived", "collected"];
const REPORT_WINDOW_MS = 72 * 3600_000;

/** The overcharge report is open on an order in progress, and for 72 hours after delivery. */
export function canReportOvercharge(order: Order, now: number): boolean {
  if (!order.tanker_id || order.org_id) return false;
  if (ACTIVE.includes(order.status)) return true;
  return order.status === "delivered" && !!order.delivered_at && now - Date.parse(order.delivered_at) < REPORT_WINDOW_MS;
}

/** The case number of this order's overcharge report, if the customer already filed one. */
export function useOverchargeCase(orderId: string): [number | null, (n: number) => void] {
  const [caseNo, setCaseNo] = useState<number | null>(null);
  useEffect(() => {
    if (!orderId) return;
    supabase()
      .from("complaints")
      .select("case_no")
      .eq("order_id", orderId)
      .eq("category", "overcharge")
      .limit(1)
      .maybeSingle<{ case_no: number }>()
      .then(({ data }) => setCaseNo(data?.case_no ?? null));
  }, [orderId]);
  return [caseNo, setCaseNo];
}

export function OverchargeSheet({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (caseNo: number) => void }) {
  const { t, lang } = useCx();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    const a = amount.trim().replace(",", ".");
    if (a && !/^\d{1,4}(\.\d{1,3})?$/.test(a)) return setError(t("ocBadAmt"));
    setBusy(true);
    setError(null);
    const { data, error } = await supabase()
      .rpc("report_overcharge", { p_order_id: order.id, p_amount: a ? Number(a) : null, p_note: note.trim() || null })
      .single<{ case_no: number }>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error, lang));
    onDone(data.case_no);
  }
  return (
    <Sheet title={t("ocT")} onClose={onClose}>
      <p>{t("ocS", { a: omr3(order.total, lang) })}</p>
      <p>
        <b>{t("ocDont")}</b>
      </p>
      <div className="fld">
        <label htmlFor="oc-a">{t("ocAmt")}</label>
        <input id="oc-a" inputMode="decimal" dir="ltr" maxLength={8} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2.000" />
      </div>
      <div className="fld">
        <label htmlFor="oc-n">{t("ocNote")}</label>
        <textarea id="oc-n" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta danger" disabled={busy} onClick={send}>
        {busy ? t("sending") : t("ocSend")}
      </button>
      <button className="cta sec" onClick={onClose}>
        {t("close")}
      </button>
    </Sheet>
  );
}


/** A wallet top-up (0036): TU-<topup_no>, confirmed at once by the simulated gateway. */
export type Topup = {
  id: string;
  topup_no: number;
  customer_id: string;
  amount: string;
  method: "card" | "omannet";
  card_last4: string | null;
  status: "pending" | "confirmed" | "failed";
  gateway_ref: string;
  created_at: string;
  confirmed_at: string | null;
};
export const topupRef = (t: Pick<Topup, "topup_no">) => `TU-${t.topup_no}`;

/**
 * The customer's pending top-ups, kept live (topups and wallet_tx are in the realtime
 * publication). onConfirmed fires when one of them is confirmed, and onWallet on any new
 * wallet line, so the screen can refresh the balance.
 */
export function useLiveTopups(userId: string, onConfirmed: (t: Topup) => void, onWallet: () => void) {
  const [pending, setPending] = useState<Topup[]>([]);
  const cb = useRef({ onConfirmed, onWallet });
  const waiting = useRef<Set<string>>(new Set());
  useEffect(() => {
    cb.current = { onConfirmed, onWallet };
  });
  useEffect(() => {
    if (!userId) return;
    const db = supabase();
    let live = true;
    const load = () =>
      db
        .from("topups")
        .select("*")
        .eq("customer_id", userId)
        .in("status", ["pending", "confirmed"])
        .order("created_at", { ascending: false })
        .limit(20)
        .then(({ data }) => {
          if (!live) return;
          const rows = (data ?? []) as Topup[];
          for (const r of rows) if (r.status === "confirmed" && waiting.current.has(r.id)) cb.current.onConfirmed(r);
          const open = rows.filter((r) => r.status === "pending");
          waiting.current = new Set(open.map((r) => r.id));
          setPending(open);
        });
    load();
    const ch = db
      .channel(`topups-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "topups", filter: `customer_id=eq.${userId}` }, () => load())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "wallet_tx", filter: `customer_id=eq.${userId}` }, () => cb.current.onWallet())
      .subscribe((st) => {
        if (st === "SUBSCRIBED") load();
      });
    // Without realtime (or after a missed event) a pending top-up still resolves: check every 15 s.
    const poll = setInterval(() => {
      if (waiting.current.size) load();
    }, 15_000);
    return () => {
      live = false;
      clearInterval(poll);
      db.removeChannel(ch);
    };
  }, [userId]);
  /** A top-up just started on this screen: watch it until it's confirmed. */
  const track = (t: Topup) => {
    if (t.status !== "pending") return;
    waiting.current.add(t.id);
    setPending((cur) => (cur.some((x) => x.id === t.id) ? cur : [t, ...cur]));
  };
  return { pending, track };
}
