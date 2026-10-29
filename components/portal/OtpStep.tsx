"use client";

import { useEffect, useState } from "react";
import { AUTH, authError } from "@/components/portal/authI18n";
import { useT } from "@/lib/i18n";
import { formatPhone } from "@/lib/phone";
import { supabase } from "@/lib/supabase/client";

const COOLDOWN_S = 60;
const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/**
 * "Enter the SMS code" step shared by sign-up and password reset. The code was just
 * sent when this mounts; resend() sends another (after a cooldown). On a correct code
 * Supabase signs the user in and onVerified() runs.
 * Demo mode shows the code on screen when the database's DEMO_SMS_CODES setting is on.
 */
export function OtpStep({
  phone,
  desktop,
  resend,
  onVerified,
  onChangeNumber,
}: {
  phone: string;
  desktop: boolean;
  resend: () => Promise<{ error: { message?: string; code?: string } | null }>;
  onVerified: () => void;
  onChangeNumber: () => void;
}) {
  const t = useT(AUTH);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const wait = Math.max(0, COOLDOWN_S - Math.floor((now - sentAt) / 1000));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Demo only: the SMS hook writes the code to the outbox a moment after sending; poll briefly.
  useEffect(() => {
    if (!DEMO) return;
    let tries = 0;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      const { data } = await supabase().rpc("demo_sms_code", { p_phone: phone });
      if (stop) return;
      if (typeof data === "string" && data) return setDemoCode(data);
      if (++tries < 10) timer = setTimeout(look, 2000);
    };
    timer = setTimeout(look, 800);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [phone, sentAt]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    const token = code.replace(/\D/g, "");
    if (token.length !== 6) return setError(t("badCode"));
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.verifyOtp({ phone, token, type: "sms" });
    setBusy(false);
    if (error) return setError(authError(t, error));
    onVerified();
  }

  async function again() {
    setError(null);
    setNote(null);
    setBusy(true);
    const { error } = await resend();
    setBusy(false);
    if (error) return setError(authError(t, error));
    setDemoCode(null);
    setSentAt(Date.now());
    setNote(t("resent"));
  }

  const sentLine = t("codeSent", { phone: formatPhone(phone) });
  const input = (
    <input
      id="otp"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      required
      dir="ltr"
      autoFocus
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
    />
  );
  const resendLabel = wait > 0 ? t("resendIn", { s: wait }) : t("resend");

  if (desktop) {
    return (
      <form onSubmit={verify}>
        <div>
          <h2>{t("codeTitle")}</h2>
          <p dir="auto">{sentLine}</p>
        </div>
        {error && <div className="si-msg">{error}</div>}
        {note && <div className="si-msg info">{note}</div>}
        {demoCode && <div className="si-msg info">{t("demoCode", { code: demoCode })}</div>}
        <div className="si-f">
          <label htmlFor="otp">{t("code")}</label>
          <div className="in">{input}</div>
        </div>
        <button className="si-btn" disabled={busy}>
          {busy ? t("verifying") : t("verify")}
        </button>
        <div className="si-row">
          <button type="button" className="lk" onClick={again} disabled={busy || wait > 0}>
            {resendLabel}
          </button>
          <button type="button" className="lk" onClick={onChangeNumber}>
            {t("changeNumber")}
          </button>
        </div>
      </form>
    );
  }

  const link = { background: "none", border: 0, padding: 0, color: "var(--link)", fontWeight: 700, font: "inherit", cursor: "pointer" } as const;
  return (
    <form onSubmit={verify}>
      <h2>{t("codeTitle")}</h2>
      <p dir="auto">{sentLine}</p>
      {error && <div className="banner badb">{error}</div>}
      {note && <div className="banner info">{note}</div>}
      {demoCode && <div className="banner info">{t("demoCode", { code: demoCode })}</div>}
      <div className="fld">
        <label htmlFor="otp">{t("code")}</label>
        {input}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "-2px 0 14px", fontSize: 13.5 }}>
        <button type="button" onClick={again} disabled={busy || wait > 0} style={{ ...link, opacity: wait > 0 ? 0.55 : 1 }}>
          {resendLabel}
        </button>
        <button type="button" onClick={onChangeNumber} style={link}>
          {t("changeNumber")}
        </button>
      </div>
      <button className="cta" disabled={busy}>
        {busy ? t("verifying") : t("verify")}
      </button>
    </form>
  );
}
