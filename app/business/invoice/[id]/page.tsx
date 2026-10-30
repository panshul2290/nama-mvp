"use client";

import { useParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { ORDER_COLS, SEGMENT_LABEL, useBiz, type BizOrder } from "@/components/business/BizContext";
import { NamaLogo } from "@/components/icons";
import { fmtDate, gal, n3 } from "@/components/portal/kit";
import { SERVICE_LABEL } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";
import { ref, type Invoice } from "@/lib/types";

// Print-friendly invoice: opened in a new tab from Invoices → "Download PDF",
// saved as PDF with the browser's print dialog.
export default function InvoicePrint() {
  const { id } = useParams<{ id: string }>();
  const { org } = useBiz();
  const [inv, setInv] = useState<Invoice | null | undefined>(undefined);
  const [lines, setLines] = useState<BizOrder[]>([]);
  const [sites, setSites] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const db = supabase();
      const [i, o, p] = await Promise.all([
        db.from("invoices").select("*").eq("id", id).maybeSingle(),
        db.from("orders").select(ORDER_COLS).eq("invoice_id", id).order("delivered_at", { ascending: true }),
        db.from("properties").select("id, label").eq("org_id", org.id),
      ]);
      setInv((i.data ?? null) as Invoice | null);
      setLines((o.data ?? []) as BizOrder[]);
      setSites(Object.fromEntries(((p.data ?? []) as { id: string; label: string }[]).map((x) => [x.id, x.label])));
    })();
  }, [id, org.id]);

  useEffect(() => {
    if (inv) document.title = `${ref.invoice(inv.invoice_no)} — ${org.name}`;
  }, [inv, org.name]);

  if (inv === undefined) return <div className="inv-print-loading">Loading invoice…</div>;
  if (!inv) return <div className="inv-print-loading">Invoice not found.</div>;

  const paid = inv.status === "paid";
  return (
    <div className="inv-page">
      <div className="inv-tools">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <button onClick={() => window.close()} className="sec">
          Close
        </button>
      </div>
      <article className="inv-doc">
        <header className="inv-head">
          <div>
            <NamaLogo className="inv-logo" />
            <p>
              <b>Nama Water Services SAOC</b>
              <br />
              Tanker Operations · Muscat, Sultanate of Oman
              <br />
              VATIN OM1100XXXXXX (simulated) · Call centre 1442
            </p>
          </div>
          <div className="inv-title">
            <h1>Tax invoice</h1>
            <dl>
              <dt>Invoice</dt>
              <dd>{ref.invoice(inv.invoice_no)}</dd>
              <dt>Issued</dt>
              <dd>{fmtDate(inv.issued_at)}</dd>
              <dt>Due</dt>
              <dd>{fmtDate(inv.due_at)}</dd>
              <dt>Status</dt>
              <dd>{paid ? `Paid ${fmtDate(inv.paid_at)}` : "Unpaid"}</dd>
            </dl>
          </div>
        </header>

        <section className="inv-parties">
          <div>
            <small>Bill to</small>
            <b>{org.name}</b>
            <span>CR {org.cr_no}</span>
            <span>{SEGMENT_LABEL[org.segment]} account · Net {org.terms_days}</span>
          </div>
          <div>
            <small>Period</small>
            <b>
              {fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}
            </b>
            <span>
              {inv.orders} deliver{inv.orders === 1 ? "y" : "ies"} on account
            </span>
          </div>
        </section>

        <table className="inv-lines">
          <thead>
            <tr>
              <th>Order</th>
              <th>Delivered</th>
              <th>Site</th>
              <th>Service</th>
              <th className="r">Gallons</th>
              <th>PO</th>
              <th className="r">Amount ex VAT</th>
              <th className="r">VAT 5%</th>
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((o) => {
              const credit = Number(o.short_credit ?? 0);
              return (
                <Fragment key={o.id}>
                  <tr>
                    <td>{ref.order(o.order_no)}</td>
                    <td>{fmtDate(o.delivered_at)}</td>
                    <td>{(o.property_id && sites[o.property_id]) || o.area}</td>
                    <td>{SERVICE_LABEL[o.service_type]}</td>
                    <td className="r">{gal(o.gallons)}</td>
                    <td>{o.po_number ?? "—"}</td>
                    <td className="r">{n3(Number(o.total) - Number(o.vat))}</td>
                    <td className="r">{n3(o.vat)}</td>
                    <td className="r">{n3(o.total)}</td>
                  </tr>
                  {/* invoice_org bills total − short_credit, taking the credit off the amount before VAT. */}
                  {credit > 0 && (
                    <tr className="credit">
                      <td colSpan={6}>Short-delivery credit on {ref.order(o.order_no)} (less than ordered was delivered)</td>
                      <td className="r">−{n3(credit)}</td>
                      <td className="r">—</td>
                      <td className="r">−{n3(credit)}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        <div className="inv-totals">
          <div>
            <span>Subtotal (ex VAT)</span>
            <b>OMR {n3(inv.subtotal)}</b>
          </div>
          <div>
            <span>VAT 5%</span>
            <b>OMR {n3(inv.vat)}</b>
          </div>
          <div className="grand">
            <span>Total due</span>
            <b>OMR {n3(inv.total)}</b>
          </div>
        </div>

        <footer className="inv-foot">
          <p>
            Pay by bank transfer to Nama Water Services, quoting {ref.invoice(inv.invoice_no)}. Overdue amounts attract 2% a month. Every delivery on this invoice has a
            proof of delivery (photo, flow-meter reading, signature and where it was recorded) on the order’s page in the Business portal (Orders → the order).
          </p>
          <p className="mut">Generated by the NWS Tanker Operations platform. All data shown is simulated for demonstration.</p>
        </footer>
      </article>
    </div>
  );
}
