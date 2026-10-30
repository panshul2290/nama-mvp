"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useCustomer } from "@/components/CustomerContext";
import { CaseTimeline, EscalateBox } from "@/components/customer/ComplaintParts";
import { useNow } from "@/components/customer/hooks";
import { useCx } from "@/components/customer/i18n";
import { RefundPolicy } from "@/components/customer/RefundPolicy";
import { dshort, dtshort, omr3 } from "@/components/customer/fmt";
import { BackButton, Loading } from "@/components/Shell";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import { ref, type Complaint, type ComplaintNote } from "@/lib/types";

export default function ComplaintsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Complaints />
    </Suspense>
  );
}

const tone = (s: Complaint["state"]) => (s === "resolved" ? "ok" : s === "escalated" ? "bad" : "warn");

function Complaints() {
  const id = useSearchParams().get("id");
  return id ? <CaseDetail id={id} /> : <CaseList />;
}

function CaseList() {
  const profile = useCustomer();
  const { t, lang } = useCx();
  const [list, setList] = useState<Complaint[] | null>(null);
  useEffect(() => {
    supabase()
      .from("complaints")
      .select("*")
      .eq("customer_id", profile.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setList((data ?? []) as Complaint[]));
  }, [profile.id]);
  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href="/customer/account" label={t("back")} />
        <div>
          <h3>{t("myCx")}</h3>
        </div>
      </div>
      {list === null ? (
        <div className="empty">{t("loading")}</div>
      ) : list.length === 0 ? (
        <div className="empty">{t("none")}</div>
      ) : (
        list.map((c) => (
          <Link key={c.id} href={`/customer/complaints?id=${c.id}`} className="card">
            <div className="row">
              <h4>{ref.complaint(c.case_no)}</h4>
              <span className={`st ${tone(c.state)}`}>{t(`cxSt_${c.state}`)}</span>
            </div>
            <p>
              {t(`cx_${c.category}`)} · {dshort(c.created_at, lang)}
              <br />
              {c.description.length > 90 ? `${c.description.slice(0, 90)}…` : c.description}
            </p>
          </Link>
        ))
      )}
    </main>
  );
}

function CaseDetail({ id }: { id: string }) {
  const { t, lang } = useCx();
  const now = useNow(60_000);
  const [c, setC] = useState<Complaint | null>(null);
  const [orderNo, setOrderNo] = useState<number | null>(null);
  const [notes, setNotes] = useState<ComplaintNote[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNotes = useCallback(
    () =>
      supabase()
        .from("complaint_notes")
        .select("*")
        .eq("complaint_id", id)
        .order("created_at")
        .then(({ data }) => setNotes((data ?? []) as ComplaintNote[])),
    [id],
  );

  useEffect(() => {
    const db = supabase();
    db.from("complaints")
      .select("*")
      .eq("id", id)
      .maybeSingle<Complaint>()
      .then(({ data }) => {
        if (!data) return setMissing(true);
        setC(data);
        if (data.order_id)
          db.from("orders")
            .select("order_no")
            .eq("id", data.order_id)
            .maybeSingle<{ order_no: number }>()
            .then(({ data: o }) => setOrderNo(o?.order_no ?? null));
        if (data.photo_path)
          db.storage
            .from("evidence")
            .createSignedUrl(data.photo_path, 3600)
            .then(({ data: s }) => setPhoto(s?.signedUrl ?? null));
      });
    loadNotes();
    // State changes made by NWS arrive live.
    const ch = db
      .channel(`complaint-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "complaints", filter: `id=eq.${id}` }, (p) => {
        setC((prev) => ({ ...prev, ...(p.new as Complaint) }));
        loadNotes();
      })
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [id, loadNotes]);

  async function send() {
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("complaint_reply", { p_complaint_id: id, p_body: reply.trim() });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setReply("");
    loadNotes();
  }

  if (missing) {
    return (
      <main className="screen">
        <div className="rq-h">
          <BackButton href="/customer/complaints" label={t("back")} />
          <div>
            <h3>{t("notFound")}</h3>
          </div>
        </div>
      </main>
    );
  }
  if (!c) return <Loading />;

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href="/customer/complaints" label={t("back")} />
        <div>
          <h3>{ref.complaint(c.case_no)}</h3>
          <small>{t(`cx_${c.category}`)}</small>
        </div>
      </div>
      <div className="rq-card">
        <div className="rq-ch">
          <b>{t("caseStatus")}</b>
          <span className={`st ${tone(c.state)}`}>{t(`cxSt_${c.state}`)}</span>
        </div>
        {c.order_id && (
          <div className="rq-r">
            <span>{t("orderL")}</span>
            <b>
              <Link className="lk" href={`/customer/order?id=${c.order_id}`}>
                {orderNo != null ? ref.order(orderNo) : t("view")}
              </Link>
            </b>
          </div>
        )}
        {c.owner_team && (
          <div className="rq-r">
            <span>{t("team")}</span>
            <b>{c.owner_team}</b>
          </div>
        )}
        {Number(c.refund_amount) > 0 && (
          <div className="rq-r">
            <span>{t("refundL")}</span>
            <b>{omr3(c.refund_amount, lang)}</b>
          </div>
        )}
      </div>
      <CaseTimeline c={c} now={now} />
      {c.resolution && <div className="banner okb">{c.resolution}</div>}
      {Number(c.refund_amount) > 0 && <RefundPolicy part="complaint" amount={omr3(c.refund_amount, lang)} />}
      {photo && (
        <div className="photo" style={{ height: 160 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo} alt={t("attach")} />
        </div>
      )}

      <h4 className="cx-h">{t("updates")}</h4>
      <div className="chat">
        {notes.map((n) => (
          <div key={n.id} className={`bub ${n.author_role === "customer" ? "me" : ""}`}>
            {n.author_role !== "customer" && <b className="who">{t("nwsSupport")}</b>}
            {n.body}
            <small>{dtshort(n.created_at, lang)}</small>
          </div>
        ))}
      </div>
      {c.state !== "resolved" && (
        <>
          <div className="fld" style={{ marginTop: 10 }}>
            <label htmlFor="rp">{t("reply")}</label>
            <textarea id="rp" rows={3} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} />
          </div>
          {error && <div className="banner badb">{error}</div>}
          <button className="cta" disabled={busy || !reply.trim()} onClick={send}>
            {busy ? t("sending") : t("send")}
          </button>
        </>
      )}
      <EscalateBox
        c={c}
        onDone={(next) => {
          setC(next);
          loadNotes();
        }}
      />
    </main>
  );
}
