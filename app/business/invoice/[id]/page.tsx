"use client";

import { useParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { ORDER_COLS, useBiz, type BizOrder } from "@/components/business/BizContext";
import { BIZ } from "@/components/business/i18n";
import { NamaLogo } from "@/components/icons";
import { useFmt } from "@/components/portal/i18n";
import { useLang, useT } from "@/lib/i18n";
import { segmentLabel, serviceLabel } from "@/lib/labels";
import { supabase } from "@/lib/supabase/client";
import { ref, type Invoice } from "@/lib/types";

// Print-friendly invoice: opened in a new tab from Invoices → "Download PDF",
// saved as PDF with the browser's print dialog. It renders without PortalShell, so it sets
// dir/lang itself; the invoice prints in the viewer's language.
export default function InvoicePrint() {
  const { id } = useParams<{ id: string }>();
  const { org } = useBiz();
  const [inv, setInv] = useState<Invoice | null | undefined>(undefined);
  const [lines, setLines] = useState<BizOrder[]>([]);
  const [sites, setSites] = useState<Record<string, string>>({});
  const { lang, dir } = useLang();
  const t = useT(BIZ);
  const f = useFmt();

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

  if (inv === undefined)
    return (
      <div className="inv-print-loading" dir={dir} lang={lang}>
        {t("loadingInvoice")}
      </div>
    );
  if (!inv)
    return (
      <div className="inv-print-loading" dir={dir} lang={lang}>
        {t("invoiceNotFound")}
      </div>
    );

  const paid = inv.status === "paid";
  const amt = (v: number | string) => f.omr(v);
  return (
    <div className="inv-page" dir={dir} lang={lang}>
      <div className="inv-tools">
        <button onClick={() => window.print()}>{t("printSave")}</button>
        <button onClick={() => window.close()} className="sec">
          {t("close")}
        </button>
      </div>
      <article className="inv-doc">
        <header className="inv-head">
          <div>
            <NamaLogo className="inv-logo" />
            <p>
              <b>{t("nwsName")}</b>
              <br />
              {t("nwsLine")}
              <br />
              {t("vatin")}
            </p>
          </div>
          <div className="inv-title">
            <h1>{t("taxInvoice")}</h1>
            <dl>
              <dt>{t("hInvoice")}</dt>
              <dd dir="ltr">{ref.invoice(inv.invoice_no)}</dd>
              <dt>{t("invIssued")}</dt>
              <dd>{f.date(inv.issued_at)}</dd>
              <dt>{t("hDue")}</dt>
              <dd>{f.date(inv.due_at)}</dd>
              <dt>{t("status")}</dt>
              <dd>{paid ? t("paidOn", { date: f.date(inv.paid_at) }) : t("unpaid")}</dd>
            </dl>
          </div>
        </header>

        <section className="inv-parties">
          <div>
            <small>{t("billTo")}</small>
            <b>{org.name}</b>
            <span>{t("crN", { cr: org.cr_no })}</span>
            <span>{t("segAccount", { seg: segmentLabel(org.segment, lang), n: f.n(org.terms_days) })}</span>
          </div>
          <div>
            <small>{t("hPeriod")}</small>
            <b>
              {f.date(inv.period_start)} – {f.date(inv.period_end)}
            </b>
            <span>{inv.orders === 1 ? t("delOnAccount1") : t("delOnAccountN", { n: f.n(inv.orders) })}</span>
          </div>
        </section>

        <table className="inv-lines">
          <thead>
            <tr>
              <th>{t("hOrder")}</th>
              <th>{t("hDelivered")}</th>
              <th>{t("hSite")}</th>
              <th>{t("hService")}</th>
              <th className="r">{t("hGallons")}</th>
              <th>{t("hPo")}</th>
              <th className="r">{t("hExVat")}</th>
              <th className="r">{t("hVat5")}</th>
              <th className="r">{t("total")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((o) => {
              const credit = Number(o.short_credit ?? 0);
              return (
                <Fragment key={o.id}>
                  <tr>
                    <td dir="ltr">{ref.order(o.order_no)}</td>
                    <td>{f.date(o.delivered_at)}</td>
                    <td>{(o.property_id && sites[o.property_id]) || o.area}</td>
                    <td>{serviceLabel(o.service_type, lang)}</td>
                    <td className="r">{f.n(o.gallons)}</td>
                    <td dir="ltr">{o.po_number ?? "—"}</td>
                    <td className="r">{f.n3(Number(o.total) - Number(o.vat))}</td>
                    <td className="r">{f.n3(o.vat)}</td>
                    <td className="r">{f.n3(o.total)}</td>
                  </tr>
                  {/* invoice_org bills total − short_credit, taking the credit off the amount before VAT. */}
                  {credit > 0 && (
                    <tr className="credit">
                      <td colSpan={6}>{t("creditLine", { order: ref.order(o.order_no) })}</td>
                      <td className="r">−{f.n3(credit)}</td>
                      <td className="r">—</td>
                      <td className="r">−{f.n3(credit)}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        <div className="inv-totals">
          <div>
            <span>{t("subtotalEx")}</span>
            <b>{amt(inv.subtotal)}</b>
          </div>
          <div>
            <span>{t("hVat5")}</span>
            <b>{amt(inv.vat)}</b>
          </div>
          <div className="grand">
            <span>{t("totalDue")}</span>
            <b>{amt(inv.total)}</b>
          </div>
        </div>

        <footer className="inv-foot">
          <p>{t("payNote", { inv: ref.invoice(inv.invoice_no) })}</p>
          <p className="mut">{t("generatedBy")}</p>
        </footer>
      </article>
    </div>
  );
}
