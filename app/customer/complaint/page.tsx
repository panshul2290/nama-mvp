"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { useCx } from "@/components/customer/i18n";
import { dtshort, uuid } from "@/components/customer/fmt";
import { Icon } from "@/components/icons";
import { BackButton, Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { localDigits } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { ref, type Complaint } from "@/lib/types";

type Sla = { category: string; label: string; hours: number };

export default function ComplaintPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ComplaintForm />
    </Suspense>
  );
}

function ComplaintForm() {
  const orderId = useSearchParams().get("order");
  const profile = useCustomer();
  const { t, lang } = useCx();
  const [cats, setCats] = useState<Sla[] | null>(null);
  const [orderNo, setOrderNo] = useState<number | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Complaint | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    supabase()
      .from("complaint_sla")
      .select("category, label, hours")
      .then(({ data }) => setCats((data ?? []) as Sla[]));
  }, []);
  useEffect(() => {
    if (!orderId) return;
    supabase()
      .from("orders")
      .select("order_no")
      .eq("id", orderId)
      .maybeSingle<{ order_no: number }>()
      .then(({ data }) => setOrderNo(data?.order_no ?? null));
  }, [orderId]);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const tm = setTimeout(() => setPreview(url), 0);
    return () => {
      clearTimeout(tm);
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const category = cat ?? cats?.[0]?.category ?? null;

  async function submit() {
    if (!category) return;
    setBusy(true);
    setError(null);
    let photo: string | null = null;
    if (file) {
      const path = `${profile.id}/${uuid()}.jpg`;
      const up = await supabase().storage.from("evidence").upload(path, file, { contentType: file.type || "image/jpeg" });
      if (up.error) {
        setBusy(false);
        return setError(`${t("uploadFail")} (${up.error.message})`);
      }
      photo = path;
    }
    const { data, error } = await supabase()
      .rpc("file_complaint", { p_order_id: orderId, p_category: category, p_description: text.trim(), p_photo_path: photo })
      .single<Complaint>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    setDone(data);
  }

  const backHref = orderId ? `/customer/order?id=${orderId}` : "/customer";

  if (done) {
    return (
      <main className="screen">
        <div className="rq-h">
          <BackButton href={backHref} label={t("back")} />
          <div>
            <h3>{ref.complaint(done.case_no)}</h3>
          </div>
        </div>
        <div className="done-hero">
          <Icon name="check" />
          <div>
            <b>{t("cxSent")}</b>
            <small>{t("cxSentS", { h: localDigits(done.sla_hours, lang), d: dtshort(done.due_at, lang) })}</small>
          </div>
        </div>
        <Link href={`/customer/complaints?id=${done.id}`} className="cta">
          {t("viewCase")}
        </Link>
        <Link href={backHref} className="cta sec">
          {t("back")}
        </Link>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href={backHref} label={t("back")} />
        <div>
          <h3>{t("cxT")}</h3>
          {orderNo != null && <small>{ref.order(orderNo)}</small>}
        </div>
      </div>
      <p className="mut small" style={{ marginTop: 0 }}>
        {t("cxS")}
      </p>
      <div className="fld">
        <span className="lbl">{t("category")}</span>
        <div className="opts">
          {(cats ?? []).map((c) => (
            <button key={c.category} type="button" className={`opt ${category === c.category ? "on" : ""}`} onClick={() => setCat(c.category)}>
              {t(`cx_${c.category}`) === `cx_${c.category}` ? c.label : t(`cx_${c.category}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="fld">
        <label htmlFor="cxDesc">{t("what")}</label>
        <textarea id="cxDesc" rows={4} maxLength={2000} placeholder={t("whatPh")} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {file && preview ? (
        <div className="photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={t("attach")} />
        </div>
      ) : null}
      <button type="button" className="cta sec" onClick={() => input.current?.click()}>
        <Icon name="camera" size={16} /> {file ? t("changePhoto") : t("attach")}
      </button>
      {error && <div className="banner badb">{error}</div>}
      <button className="cta" disabled={busy || !category || text.trim().length < 3} onClick={submit}>
        {busy ? t("sending") : t("sendCx")}
      </button>
    </main>
  );
}
