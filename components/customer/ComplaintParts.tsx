"use client";

// Customer complaint detail pieces (#33/#34): the status timeline with the promised answer
// time, and "Escalate to Nama 1442" with the number shown as selectable text and a call link.
import { useState } from "react";
import { useCx } from "@/components/customer/i18n";
import { dtshort } from "@/components/customer/fmt";
import { Sheet } from "@/components/customer/ui";
import { Icon } from "@/components/icons";
import { canEscalate, casePromise, caseSteps, NAMA_1442 } from "@/lib/complaints";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase/client";
import type { Complaint } from "@/lib/types";

const STEP_LABEL = { received: "tlReceived", review: "tlReview", escalated: "tlEscalated", resolved: "tlResolved" } as const;

export function CaseTimeline({ c, now }: { c: Complaint; now: number }) {
  const { t, lang, n } = useCx();
  const steps = caseSteps(c);
  const p = casePromise(c, now);
  return (
    <div className="rq-card">
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }} aria-label={t("caseStatus")}>
        {steps.map((s) => (
          <li key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start" }} aria-current={s.current ? "step" : undefined}>
            <span
              aria-hidden
              style={{
                width: 14, height: 14, borderRadius: "50%", flex: "none", marginTop: 3,
                background: s.done ? (s.key === "escalated" ? "var(--bad)" : s.key === "resolved" ? "var(--ok)" : "var(--accent)") : "var(--line)",
                boxShadow: s.current ? "0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent)" : undefined,
              }}
            />
            <span style={{ flex: 1 }}>
              <b style={{ fontWeight: s.current ? 800 : 600, color: s.done ? undefined : "var(--muted)" }}>{t(STEP_LABEL[s.key])}</b>
              {s.at && <small style={{ display: "block", color: "var(--muted)" }}>{dtshort(s.at, lang)}</small>}
            </span>
          </li>
        ))}
      </ol>
      <p className="small" style={{ margin: "12px 0 0", color: p.kind === "late" || p.kind === "missed" ? "var(--bad)" : undefined }}>
        {p.kind === "open"
          ? t("tlPromise", { h: n(p.hours), at: dtshort(p.due, lang) })
          : p.kind === "late"
            ? t("tlLate")
            : t(p.kind === "met" ? "tlMet" : "tlMissed", { h: n(p.hours) })}
      </p>
    </div>
  );
}

/** "Call Nama 1442": tel: links don't work everywhere (desktop, some webviews), so the number is also shown as text. */
export function Call1442() {
  const { t } = useCx();
  return (
    <p className="small" style={{ margin: "8px 0" }}>
      <a className="lk" href={`tel:${NAMA_1442}`}>
        <Icon name="headset" size={14} /> {t("call1442")}
      </a>
      <br />
      <span style={{ userSelect: "text" }}>{t("callNum", { n: "" })}</span>
      <bdi dir="ltr" style={{ userSelect: "all", fontWeight: 800 }}>
        {NAMA_1442}
      </bdi>
    </p>
  );
}

export function EscalateBox({ c, onDone }: { c: Complaint; onDone: (c: Complaint) => void }) {
  const { t, lang } = useCx();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function escalate() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase().rpc("escalate_complaint", { p_complaint_id: c.id, p_reason: why.trim() || null }).single<Complaint>();
    setBusy(false);
    if (error || !data) return setError(friendlyError(error));
    setOpen(false);
    setDone(true);
    onDone(data);
  }

  if (!canEscalate(c)) {
    return (
      <div className="banner badb" role="status">
        {done ? t("escDone") : t("escAlready", { at: dtshort(c.escalated_at ?? c.created_at, lang) })}
        <Call1442 />
      </div>
    );
  }
  return (
    <>
      <button className="cta sec" onClick={() => setOpen(true)}>
        {t("escT")}
      </button>
      {open && (
        <Sheet title={t("escT")} onClose={() => setOpen(false)}>
          <p className="mut small" style={{ marginTop: 0 }}>
            {t("escS")}
          </p>
          <div className="fld">
            <label htmlFor="escw">{t("escWhy")}</label>
            <textarea id="escw" rows={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
          </div>
          {error && <div className="banner badb">{error}</div>}
          <button className="cta danger" disabled={busy} onClick={escalate}>
            {busy ? t("escBusy") : t("escBtn")}
          </button>
          <Call1442 />
          <button className="cta sec" onClick={() => setOpen(false)}>
            {t("notNow")}
          </button>
        </Sheet>
      )}
    </>
  );
}
