"use client";

// Water-quality certificate for one delivery (E15): the tanker's test in force on the delivery
// day, its lab, parameters with limits and pass/fail, and validity. Printable (Print / save PDF)
// and shareable (the system share sheet, or the details copied).
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useCx } from "@/components/customer/i18n";
import { ddate, dtshort } from "@/components/customer/fmt";
import { loadCertificate, parameterRows, type Certificate } from "@/components/customer/waterQuality";
import { BackButton, Loading } from "@/components/Shell";
import { useToast } from "@/components/useToast";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { ref, type Order } from "@/lib/types";

export default function CertificatePage() {
  return (
    <Suspense fallback={<Loading />}>
      <CertificateView />
    </Suspense>
  );
}

function CertificateView() {
  const id = useSearchParams().get("order") ?? "";
  const router = useRouter();
  const { t, lang, n } = useCx();
  const toast = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [cert, setCert] = useState<Certificate | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;
    supabase()
      .from("orders")
      .select("*")
      .eq("id", id)
      .maybeSingle<Order>()
      .then(async ({ data: o }) => {
        if (!live) return;
        setOrder(o);
        if (!o || o.service_type === "WW" || !o.tanker_id) return setCert(null);
        try {
          const c = await loadCertificate(o.id, o.delivered_at ?? null);
          if (live) setCert(c);
        } catch (e) {
          if (live) setError(friendlyError(e as { message?: string }));
        }
      });
    return () => {
      live = false;
    };
  }, [id]);

  const back = () => (id ? router.push(`/customer/order?id=${id}`) : router.push("/customer/orders"));
  const orderNo = order ? ref.order(order.order_no) : "";
  const lab = cert?.lab || t("nwsLab");
  const rows = cert ? parameterRows(cert) : [];

  async function share() {
    if (!cert) return;
    const text = t("certShareText", { c: cert.cert_no, p: cert.plate ?? order?.tanker_plate ?? "", d: ddate(cert.tested_at, lang), l: lab, r: t(cert.passed ? "certPassed" : "certFailed") });
    const sample = cert.sample ? `\n${t("certSample")}` : "";
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: `${t("certPage")} ${cert.cert_no}`, text: `${text}\n${orderNo}${sample}` });
        return;
      }
      await navigator.clipboard.writeText(`${text}\n${orderNo}${sample}`);
      toast.show(t("certCopied"));
    } catch {
      /* the person closed the share sheet */
    }
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton onClick={back} label={t("certBack")} />
        <div>
          <h3>{t("certPage")}</h3>
          {orderNo && <small>{t("certFor", { o: orderNo })}</small>}
        </div>
      </div>
      {error ? (
        <div className="banner badb">{error}</div>
      ) : cert === undefined && !(order && (order.service_type === "WW" || !order.tanker_id)) ? (
        <div className="empty">{t("loading")}</div>
      ) : order?.service_type === "WW" ? (
        <p className="mut">{t("certWw")}</p>
      ) : !cert ? (
        <p className="mut">{t("certNone")}</p>
      ) : (
        <>
          {cert.sample && (
            <div className="banner" role="note">
              {t("certSample")}
            </div>
          )}
          <article className="cert" aria-label={`${t("certPage")} ${cert.cert_no}`}>
            <div className="cert-h">
              <div>
                <small className="mut">{lab}</small>
                <h4>{t("certPage")}</h4>
                <span className={`st ${cert.passed ? "ok" : "bad"}`} style={{ marginTop: 6 }}>
                  {t(cert.passed ? "certPassed" : "certFailed")}
                </span>
              </div>
              <Seal ok={cert.passed} />
            </div>
            <dl className="cert-kv">
              <dt>{t("certNo")}</dt>
              <dd dir="ltr">{cert.cert_no}</dd>
              {cert.test_id && (
                <>
                  <dt>{t("certTest")}</dt>
                  <dd dir="ltr">{cert.test_id.slice(0, 8).toUpperCase()}</dd>
                </>
              )}
              <dt>{t("certLab")}</dt>
              <dd>{lab}</dd>
              <dt>{t("certDate")}</dt>
              <dd>{ddate(cert.tested_at, lang)}</dd>
              <dt>{t("certValid")}</dt>
              <dd>{ddate(cert.valid_until, lang)}</dd>
              <dt>{t("certTanker")}</dt>
              <dd>
                <bdi>{cert.plate ?? order?.tanker_plate ?? "—"}</bdi>
              </dd>
              {cert.company && (
                <>
                  <dt>{t("certCompany")}</dt>
                  <dd>{cert.company}</dd>
                </>
              )}
              {order?.delivered_at && (
                <>
                  <dt>{t("certDelivered")}</dt>
                  <dd>{dtshort(order.delivered_at, lang)}</dd>
                </>
              )}
            </dl>
            {cert.valid_on_delivery !== null && (
              <p className={`small ${cert.valid_on_delivery ? "okt" : "badt"}`} style={{ margin: "0 0 10px" }}>
                {t(cert.valid_on_delivery ? "certValidOnDel" : "certExpiredOnDel")}
              </p>
            )}
            <table className="cx-table">
              <thead>
                <tr>
                  <th>{t("certParam")}</th>
                  <th>{t("certResult")}</th>
                  <th>{t("certLimit")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{t(r.key)}</td>
                    <td>{r.nd ? t("notDetected") : `${n(r.value)}${r.unit ? ` ${r.unit}` : ""}`}</td>
                    <td className="mut" dir="ltr">
                      {r.limit}
                    </td>
                    <td>
                      <span className={`st ${r.ok ? "ok" : "bad"}`}>{t(r.ok ? "pass" : "fail")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mut small" style={{ marginBottom: 0 }}>
              {t("wqStd")}
            </p>
          </article>
          <div className="cert-actions">
            <button type="button" className="cta sec" onClick={() => window.print()}>
              {t("certPrint")}
            </button>
            <button type="button" className="cta" onClick={share}>
              {t("certShare")}
            </button>
          </div>
        </>
      )}
      {toast.node}
    </main>
  );
}

function Seal({ ok }: { ok: boolean }) {
  const c = ok ? "var(--ok)" : "var(--bad)";
  return (
    <svg className="cert-seal" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="none" stroke={c} strokeWidth="2.5" strokeDasharray="3 2" />
      <circle cx="24" cy="24" r="15" fill={c} opacity=".14" />
      <path d="M24 13c-4 6-7 9.5-7 13a7 7 0 0 0 14 0c0-3.5-3-7-7-13z" fill={c} opacity=".85" />
    </svg>
  );
}
