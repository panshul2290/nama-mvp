"use client";

import { useCallback, useState } from "react";
import { useBiz } from "@/components/business/BizContext";
import { Kpis, St, fmtDate, n3, omr, useAction, useLive } from "@/components/portal/kit";
import { supabase } from "@/lib/supabase/client";
import { ref, type Invoice } from "@/lib/types";

export default function BusinessInvoices() {
  const { org, canPay, reloadOrg } = useBiz();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [uninvoiced, setUninvoiced] = useState({ n: 0, total: 0 });
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(0);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const db = supabase();
    const [i, o] = await Promise.all([
      db.from("invoices").select("*").eq("org_id", org.id).order("issued_at", { ascending: false }),
      db.from("orders").select("total").eq("org_id", org.id).eq("status", "delivered").eq("is_test", false).is("invoice_id", null),
    ]);
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
      <Kpis
        items={[
          { label: "Outstanding invoices", value: omr(unpaid.reduce((s, i) => s + Number(i.total), 0)), sub: `${unpaid.length} unpaid`, tone: unpaid.length ? "warn" : "ok" },
          { label: "Overdue", value: overdue.length, sub: overdue.length ? "2% a month on overdue amounts" : "Nothing overdue", tone: overdue.length ? "bad" : "ok" },
          { label: "Delivered, not yet invoiced", value: omr(uninvoiced.total), sub: `${uninvoiced.n} order${uninvoiced.n === 1 ? "" : "s"}` },
          { label: "Credit used", value: omr(org.credit_used), sub: `of ${omr(org.credit_limit)}` },
        ]}
      />
      <div className="panel">
        <h2>
          <span>
            Invoices{" "}
            <small>
              {org.invoicing === "weekly" ? "Weekly" : "Monthly"} cycle · Net {org.terms_days} · credit limit {omr(org.credit_limit)}
            </small>
          </span>
          {canPay && (
            <button
              className="btn pri sm"
              disabled={busy === "gen" || uninvoiced.n === 0}
              onClick={() => run("gen", async () => supabase().rpc("org_generate_invoice"), "Invoice issued for delivered orders", after)}
            >
              {busy === "gen" ? "Generating…" : "Generate invoice"}
            </button>
          )}
        </h2>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Period</th>
                <th className="num">Orders</th>
                <th className="num">Subtotal</th>
                <th className="num">VAT</th>
                <th className="num">Total</th>
                <th>Due</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => {
                const late = i.status !== "paid" && (i.status === "overdue" || (now > 0 && Date.parse(i.due_at) < now));
                return (
                  <tr key={i.id}>
                    <td>{ref.invoice(i.invoice_no)}</td>
                    <td>
                      {fmtDate(i.period_start)} – {fmtDate(i.period_end)}
                    </td>
                    <td className="num">{i.orders}</td>
                    <td className="num">{n3(i.subtotal)}</td>
                    <td className="num">{n3(i.vat)}</td>
                    <td className="num">
                      <b>{n3(i.total)}</b>
                    </td>
                    <td>{fmtDate(i.due_at)}</td>
                    <td>
                      {i.status === "paid" ? <St tone="ok">Paid {fmtDate(i.paid_at)}</St> : late ? <St tone="bad">Overdue</St> : <St tone="act">Issued</St>}
                    </td>
                    <td>
                      <div className="btns">
                        <a className="btn sm" href={`/business/invoice/${i.id}`} target="_blank" rel="noopener">
                          Download PDF
                        </a>
                        {canPay && i.status !== "paid" && (
                          <button
                            className="btn sm pri"
                            disabled={!!busy}
                            onClick={() => run(`pay${i.id}`, async () => supabase().rpc("org_pay_invoice", { p_invoice_id: i.id }), `${ref.invoice(i.invoice_no)} paid`, after)}
                          >
                            {busy === `pay${i.id}` ? "Paying…" : "Pay now"}
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
                    No invoices yet. Delivered orders are invoiced each cycle{canPay ? " — or generate one now" : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="note">Payments are by bank transfer to Nama Water Services (simulated). Invoices show VAT at 5% and a line for every delivery.</p>
      </div>
    </>
  );
}
