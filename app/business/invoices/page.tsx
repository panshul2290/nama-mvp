"use client";

import { useCallback, useState } from "react";
import { useBiz } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { useFmt } from "@/components/portal/i18n";
import { Kpis, St, useAction, useLive } from "@/components/portal/kit";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type Invoice } from "@/lib/types";

export default function BusinessInvoices() {
  const { org, canPay, reloadOrg } = useBiz();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [uninvoiced, setUninvoiced] = useState({ n: 0, total: 0 });
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const t = useT(BIZ);
  const f = useFmt();

  const load = useCallback(async () => {
    const db = supabase();
    const [i, o] = await Promise.all([
      db.from("invoices").select("*").eq("org_id", org.id).order("issued_at", { ascending: false }),
      db.from("orders").select("total").eq("org_id", org.id).eq("status", "delivered").eq("is_test", false).is("invoice_id", null),
    ]);
    setLoadError(i.error?.message ?? o.error?.message ?? null);
    if (i.error) return setLoaded(true); // keep what is on screen
    setInvoices((i.data ?? []) as Invoice[]);
    const rows = (o.data ?? []) as { total: string }[];
    setUninvoiced({ n: rows.length, total: rows.reduce((s, r) => s + Number(r.total), 0) });
    setNow(Date.now());
    setLoaded(true);
  }, [org.id]);

  useLive("biz-inv", ["invoices", "orders"], load);

  const unpaid = invoices.filter((i) => i.status !== "paid");
  const overdue = unpaid.filter((i) => i.status === "overdue" || (now > 0 && Date.parse(i.due_at) < now));
  const after = () => {
    load();
    reloadOrg();
  };

  return (
    <>
      {loadError && (
        <div className="banner badb" role="alert">
          {t("errPage", { error: loadError })}
        </div>
      )}
      <Kpis
        items={[
          { label: t("kOutstandingInv"), value: f.omr(unpaid.reduce((s, i) => s + Number(i.total), 0)), sub: t("nUnpaid", { n: f.n(unpaid.length) }), tone: unpaid.length ? "warn" : "ok" },
          { label: t("kOverdue"), value: f.n(overdue.length), sub: overdue.length ? t("overdueSub") : t("nothingOverdue"), tone: overdue.length ? "bad" : "ok" },
          { label: t("kUninvoiced"), value: f.omr(uninvoiced.total), sub: uninvoiced.n === 1 ? t("nOrders1") : t("nOrdersN", { n: f.n(uninvoiced.n) }) },
          { label: t("kCreditUsed"), value: f.omr(org.credit_used), sub: t("ofAmt", { amt: f.omr(org.credit_limit) }) },
        ]}
      />
      <div className="panel">
        <h2>
          <span>
            {t("invoicesH")}{" "}
            <small>{t("cycleSub", { cycle: org.invoicing === "weekly" ? t("cycleWeekly") : t("cycleMonthly"), n: f.n(org.terms_days), amt: f.omr(org.credit_limit) })}</small>
          </span>
          {canPay && (
            <button
              className="btn pri sm"
              disabled={busy === "gen" || uninvoiced.n === 0}
              onClick={() => run("gen", async () => supabase().rpc("org_generate_invoice"), t("invIssuedT"), after)}
            >
              {busy === "gen" ? t("generating") : t("generate")}
            </button>
          )}
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>{t("hInvoice")}</th>
                <th>{t("hPeriod")}</th>
                <th className="num">{t("hOrders")}</th>
                <th className="num">{t("hSubtotal")}</th>
                <th className="num">{t("hVat")}</th>
                <th className="num">{t("total")}</th>
                <th>{t("hDue")}</th>
                <th>{t("hStatus")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => {
                const late = i.status !== "paid" && (i.status === "overdue" || (now > 0 && Date.parse(i.due_at) < now));
                return (
                  <tr key={i.id}>
                    <td dir="ltr">{ref.invoice(i.invoice_no)}</td>
                    <td>
                      {f.date(i.period_start)} – {f.date(i.period_end)}
                    </td>
                    <td className="num">{f.n(i.orders)}</td>
                    <td className="num">{f.n3(i.subtotal)}</td>
                    <td className="num">{f.n3(i.vat)}</td>
                    <td className="num">
                      <b>{f.n3(i.total)}</b>
                    </td>
                    <td>{f.date(i.due_at)}</td>
                    <td>
                      {i.status === "paid" ? <St tone="ok">{t("paidOn", { date: f.date(i.paid_at) })}</St> : late ? <St tone="bad">{t("stOverdue")}</St> : <St tone="act">{t("stIssued")}</St>}
                    </td>
                    <td>
                      <div className="btns">
                        <a className="btn sm" href={`/business/invoice/${i.id}`} target="_blank" rel="noopener">
                          {t("downloadPdf")}
                        </a>
                        {canPay && i.status !== "paid" && (
                          <button
                            className="btn sm pri"
                            disabled={!!busy}
                            onClick={() => run(`pay${i.id}`, async () => supabase().rpc("org_pay_invoice", { p_invoice_id: i.id }), t("paidT", { inv: ref.invoice(i.invoice_no) }), after)}
                          >
                            {busy === `pay${i.id}` ? t("paying") : t("payNow")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {loaded && !invoices.length && (
                <tr>
                  <td className="empty" colSpan={9}>
                    {canPay ? t("noInvoicesGen") : t("noInvoices")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">{t("invNote")}</p>
      </div>
    </>
  );
}
