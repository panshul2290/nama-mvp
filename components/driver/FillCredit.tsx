"use client";

// Filling credit for independent drivers (no company): the water charge at the NWS station is
// paid from it (confirm_fill refuses a fill it doesn't cover). Top-ups are simulated card
// payments. Company drivers draw on their company's credit, topped up in the company portal.
import { useCallback, useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { isMissing } from "@/lib/rpcCompat";
import { supabase } from "@/lib/supabase/client";
import { useT } from "@/lib/i18n";
import { DICT, useErrText, useFmt } from "./i18n";

export type FillCreditState = {
  independent: boolean;
  balance: number | string;
  low_balance: number | string | null;
  min_topup: number | string | null;
  max_topup: number | string | null;
  required: boolean;
  recent: { id: number; kind: string; amount: number | string; memo: string; created_at: string }[];
};

const PRESETS = [10, 20, 50];

export function FillCredit() {
  const { toast } = useDriver();
  const t = useT(DICT);
  const f = useFmt();
  const errText = useErrText();
  const [s, setS] = useState<FillCreditState | null | "missing">(null);
  const [amount, setAmount] = useState(20);
  const [card, setCard] = useState("4417");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    supabase()
      .rpc("my_fill_credit")
      .then(({ data, error }) => setS(error ? (isMissing(error) ? "missing" : null) : (data as FillCreditState)));
  }, []);
  useEffect(() => {
    const t0 = setTimeout(load, 0);
    return () => clearTimeout(t0);
  }, [load]);

  // Opened from a "top up" link or the low-credit notification (#fill): scroll here once loaded.
  const loaded = s !== null && s !== "missing";
  useEffect(() => {
    if (loaded && window.location.hash === "#fill") document.getElementById("fill")?.scrollIntoView({ block: "start" });
  }, [loaded]);

  if (s === null || s === "missing") return null;
  if (!s.independent)
    return (
      <>
        <h4 className="d-h4" id="fill">
          {t("fcT")}
        </h4>
        <p className="mut small">{t("fcCompany")}</p>
      </>
    );

  const bal = Number(s.balance);
  const low = s.low_balance != null && bal < Number(s.low_balance);
  const min = Number(s.min_topup ?? 5);
  const max = Number(s.max_topup ?? 2000);

  async function topup() {
    setBusy(true);
    const { data, error } = await supabase().rpc("driver_topup_fill_credit", { p_amount: amount, p_card_last4: card });
    setBusy(false);
    if (error) return toast(errText(error));
    setS(data as FillCreditState);
    toast(t("fcDone", { amt: f.omr(amount) }));
  }

  return (
    <>
      <h4 className="d-h4" id="fill">
        {t("fcT")}
      </h4>
      <div className={`card ${low ? "hl" : ""}`}>
        <div className="row">
          <div>
            <p>{t("fcBalance")}</p>
            <div className="money" style={{ fontSize: 22 }}>
              {f.omr(bal)}
            </div>
          </div>
          {low && <span className="st warn">{t("fcLow")}</span>}
        </div>
        <p className="small" style={{ marginTop: 6 }}>
          {s.required ? t("fcRequired") : t("fcInfo")}
        </p>
        <div className="opts" style={{ marginTop: 8 }}>
          {PRESETS.filter((p) => p >= min && p <= max).map((p) => (
            <button key={p} type="button" className={`opt ${amount === p ? "on" : ""}`} onClick={() => setAmount(p)}>
              {f.omr(p)}
            </button>
          ))}
        </div>
        <div className="fld" style={{ marginTop: 8 }}>
          <label htmlFor="fc-amt">{t("fcAmount", { min: f.omr(min), max: f.omr(max) })}</label>
          <input id="fc-amt" type="number" inputMode="decimal" min={min} max={max} step="0.5" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value))} />
        </div>
        <div className="fld">
          <label htmlFor="fc-card">{t("fcCard")}</label>
          <input id="fc-card" dir="ltr" inputMode="numeric" maxLength={4} value={card} onChange={(e) => setCard(e.target.value.replace(/\D/g, ""))} />
        </div>
        <p className="mut small">{t("fcSimulated")}</p>
        <button className="cta" disabled={busy || !(amount >= min && amount <= max) || !/^\d{4}$/.test(card)} onClick={topup}>
          {busy ? t("sending") : t("fcTopup", { amt: f.omr(amount || 0) })}
        </button>
      </div>
      {s.recent.length > 0 && (
        <div className="ch-list">
          {s.recent.slice(0, 8).map((r) => (
            <div key={r.id} className="lrow">
              <span>
                {t(`fcKind_${r.kind}`)}
                <small>
                  {f.date(r.created_at)} · {f.time(r.created_at)}
                </small>
              </span>
              <b className={`num ${Number(r.amount) < 0 ? "badt" : ""}`}>{f.omr(r.amount)}</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
