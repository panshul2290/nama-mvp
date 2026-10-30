"use client";

// Bilingual e-receipt for a delivered household order (0036): English and Arabic side by side on
// every line, amounts in OMR with 3 decimals, date and time in Oman. Printable in a browser
// (Print / save PDF); the phone apps' WebView has no print dialog, so there it offers Share
// (the system share sheet, or the details copied).
import { Capacitor } from "@capacitor/core";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CX, useCx } from "@/components/customer/i18n";
import { BackButton, Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { TZ } from "@/lib/time";
import { ref } from "@/lib/types";

type Seller = { name_en?: string; name_ar?: string; operator_en?: string; operator_ar?: string; address_en?: string; address_ar?: string; cr_no?: string; vat_number?: string };
type ReceiptDoc = {
  receipt: {
    receipt_no: string;
    issued_at: string;
    seller: Seller;
    total: string;
    vat: string;
    lines: { water_charge: string; delivery_fee: string; discount: string; vat: string; total: string; short_credit: string; vat_rate: number; gallons_ordered: number; service_type: "DW" | "WW" | "TE" };
  };
  order: { id: string; order_no: number; service_type: "DW" | "WW" | "TE"; gallons: number; area: string; delivered_at: string | null; driver_name: string | null; tanker_plate: string | null; is_test: boolean; promo_code: string | null; pay_method: string | null };
  customer: { name: string | null; phone: string | null };
  payment: { method: string; amount: string; card_last4: string | null; status: string; gateway_ref: string | null; refunded_amount: string } | null;
  pod: { kind: string; meter_gal: number; at: string; photo: boolean; signed: boolean; no_signature: boolean; left_at_tank: boolean } | null;
  vat_pending: boolean;
};

const en = (k: string) => CX[k]?.en ?? k;
const ar = (k: string) => CX[k]?.ar ?? k;
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
const n3 = (v: string | number | null | undefined) => Number(v ?? 0).toFixed(3);
const when = (iso: string | null | undefined, l: "en" | "ar") =>
  iso
    ? new Intl.DateTimeFormat(l === "ar" ? "ar-OM-u-nu-latn" : "en-GB", { timeZone: TZ, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "—";

export default function ReceiptPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ReceiptView />
    </Suspense>
  );
}

function ReceiptView() {
  const id = useSearchParams().get("order") ?? "";
  const router = useRouter();
  const { t, lang } = useCx();
  const toast = useToast();
  const [doc, setDoc] = useState<ReceiptDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The apps' WebView ignores window.print(): offer Share only there.
  const [canPrint] = useState(() => typeof window !== "undefined" && !Capacitor.isNativePlatform() && typeof window.print === "function");

  useEffect(() => {
    if (!id) return;
    let live = true;
    supabase()
      .rpc("order_receipt", { p_order_id: id })
      .then(({ data, error }) => {
        if (!live) return;
        if (error) setError(friendlyError(error, lang));
        else setDoc(data as ReceiptDoc);
      });
    return () => {
      live = false;
    };
  }, [id, lang]);

  useEffect(() => {
    if (doc) document.title = `${doc.receipt.receipt_no} — ${ref.order(doc.order.order_no)}`;
  }, [doc]);

  const back = () => (id ? router.push(`/customer/order?id=${id}`) : router.push("/customer/orders"));

  async function share() {
    if (!doc) return;
    const vals = { r: doc.receipt.receipt_no, o: ref.order(doc.order.order_no), d: when(doc.order.delivered_at, lang), a: `${n3(doc.receipt.total)} OMR` };
    const text = `${fill(en("rcShareText"), vals)}\n${fill(ar("rcShareText"), { ...vals, a: `${n3(doc.receipt.total)} ر.ع.` })}`;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: `${t("rcPage")} ${doc.receipt.receipt_no}`, text });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast.show(t("rcCopied"));
    } catch {
      /* the person closed the share sheet */
    }
  }

  const top = (
    <div className="rq-h">
      <BackButton onClick={back} label={t("rcBack")} />
      <div>
        <h3>{t("rcPage")}</h3>
        {doc && <small dir="ltr">{doc.receipt.receipt_no}</small>}
      </div>
    </div>
  );
  if (!id) return <main className="screen">{top}</main>;
  if (error)
    return (
      <main className="screen">
        {top}
        <div className="banner badb">{error}</div>
      </main>
    );
  if (!doc) return <Loading />;

  const r = doc.receipt;
  const L = r.lines;
  const s = r.seller ?? {};
  const o = doc.order;
  const vatPct = String(Math.round(Number(L.vat_rate ?? 0) * 1000) / 10);
  const delivered = doc.pod?.meter_gal ?? o.gallons;
  const method = doc.payment?.method ?? o.pay_method ?? "";
  // One bilingual line: English label, value, Arabic label (always this order, whatever the app language).
  const row = (k: string, value: React.ReactNode, vars: Record<string, string> = {}, cls = "") => (
    <tr className={cls}>
      <th lang="en">{fill(en(k), vars)}</th>
      <td dir="ltr">{value}</td>
      <th lang="ar" dir="rtl">
        {fill(ar(k), vars)}
      </th>
    </tr>
  );
  const pair = (k: string) => (
    <>
      <span lang="en">{en(k)}</span> <span lang="ar" dir="rtl">{ar(k)}</span>
    </>
  );
  const svc = (
    <>
      {en(o.service_type)} · <span dir="rtl">{ar(o.service_type)}</span>
    </>
  );

  return (
    <main className="screen">
      {top}
      {o.is_test && <div className="banner">{pair("rcTest")}</div>}
      <article className="rcpt" dir="ltr" aria-label={`${t("rcPage")} ${r.receipt_no}`}>
        <header className="rcpt-h">
          <div lang="en">
            <b>{s.name_en || "Nama Water Services"}</b>
            <small>{s.operator_en}</small>
            <small>{s.address_en}</small>
          </div>
          <div className="rcpt-t">
            <h4>
              <span lang="en">{en("rcTitle")}</span> · <span lang="ar">{ar("rcTitle")}</span>
            </h4>
            <b dir="ltr">{r.receipt_no}</b>
          </div>
          <div lang="ar" dir="rtl">
            <b>{s.name_ar || "نماء لخدمات المياه"}</b>
            <small>{s.operator_ar}</small>
            <small>{s.address_ar}</small>
          </div>
        </header>

        <table className="rcpt-kv">
          <tbody>
            {row("rcVatNo", s.vat_number ? s.vat_number : <span className="mut">{en("rcVatNoPending")} · <span dir="rtl">{ar("rcVatNoPending")}</span></span>)}
            {s.cr_no ? row("rcCr", s.cr_no) : null}
            {row("rcCustomer", <bdi>{doc.customer.name || "—"}</bdi>)}
            {row("rcOrder", ref.order(o.order_no))}
            {row("rcDate", (
              <>
                {when(o.delivered_at ?? r.issued_at, "en")}
                <br />
                <span dir="rtl">{when(o.delivered_at ?? r.issued_at, "ar")}</span>
              </>
            ))}
            {row("rcService", svc)}
            {row("rcGalOrdered", o.gallons.toLocaleString("en-US"))}
            {row("rcGalDelivered", delivered.toLocaleString("en-US"))}
          </tbody>
        </table>

        <table className="rcpt-lines">
          <thead>
            <tr>
              <th lang="en">{en("rcItem")}</th>
              <th dir="ltr">OMR · ر.ع.</th>
              <th lang="ar" dir="rtl">{ar("rcItem")}</th>
            </tr>
          </thead>
          <tbody>
            {row("rcWater", n3(L.water_charge), { g: o.gallons.toLocaleString("en-US") })}
            {row("rcFee", n3(L.delivery_fee))}
            {Number(L.discount) > 0 && row("rcDiscount", `−${n3(L.discount)}`)}
            {row("rcVat", n3(L.vat), { n: vatPct })}
            {Number(L.short_credit) > 0 && row("rcShort", `−${n3(L.short_credit)}`)}
            {row("rcTotal", <b>{n3(r.total)} OMR</b>, {}, "tot")}
          </tbody>
        </table>

        <table className="rcpt-kv">
          <tbody>
            {row("rcPaidBy", (
              <>
                {en(`rcMethod_${method}`)}
                {doc.payment?.card_last4 ? ` ••${doc.payment.card_last4}` : ""} · <span dir="rtl">{ar(`rcMethod_${method}`)}</span>
              </>
            ))}
            {doc.payment?.gateway_ref ? row("rcPayRef", doc.payment.gateway_ref) : null}
            {doc.pod &&
              row("rcProof", (
                <>
                  {fill(en("rcMeter"), { g: doc.pod.meter_gal.toLocaleString("en-US") })} · {when(doc.pod.at, "en")}
                  {doc.pod.photo ? ` · ${en("rcPhoto")}` : ""}
                  {doc.pod.signed ? ` · ${en("rcSigned")}` : doc.pod.left_at_tank ? ` · ${en("rcLeftAtTank")}` : ""}
                  <br />
                  <span dir="rtl">
                    {fill(ar("rcMeter"), { g: doc.pod.meter_gal.toLocaleString("en-US") })}
                    {doc.pod.photo ? ` · ${ar("rcPhoto")}` : ""}
                    {doc.pod.signed ? ` · ${ar("rcSigned")}` : doc.pod.left_at_tank ? ` · ${ar("rcLeftAtTank")}` : ""}
                  </span>
                </>
              ))}
            {(o.driver_name || o.tanker_plate) && row("rcDriver", <bdi>{[o.driver_name, o.tanker_plate].filter(Boolean).join(" · ")}</bdi>)}
          </tbody>
        </table>

        {doc.vat_pending && (
          <p className="rcpt-note">
            <span lang="en">{en("rcVatNote")}</span>
            <span lang="ar" dir="rtl">
              {ar("rcVatNote")}
            </span>
          </p>
        )}
        <p className="rcpt-note">
          <span lang="en">{en("rcThanks")}</span>
          <span lang="ar" dir="rtl">
            {ar("rcThanks")}
          </span>
        </p>
      </article>
      <div className="cert-actions no-print">
        {canPrint && (
          <button type="button" className="cta sec" onClick={() => window.print()}>
            {t("rcPrint")}
          </button>
        )}
        <button type="button" className="cta" onClick={share}>
          {t("rcShare")}
        </button>
      </div>
      {toast.node}
    </main>
  );
}
