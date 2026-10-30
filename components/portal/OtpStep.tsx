"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { AUTH, authError } from "@/components/portal/authI18n";
import { useLang, useT, type Lang } from "@/lib/i18n";
import { formatPhone } from "@/lib/phone";
import { isMissing } from "@/lib/rpcCompat";
import { scratchClient, supabase } from "@/lib/supabase/client";

const COOLDOWN_S = 60;
const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export type CodeChannel = "sms" | "whatsapp";

/**
 * Tell the Send SMS hook how the next code for this number should go (0037: SMS or WhatsApp,
 * and the language of the message). Call it just before signUp / signInWithOtp / resend.
 * Before the migration the RPC is missing and every code goes by SMS, as before.
 */
export async function chooseChannel(phone: string, channel: CodeChannel, lang: Lang) {
  const { error } = await supabase().rpc("request_code_channel", { p_phone: phone, p_channel: channel, p_lang: lang });
  return error && !isMissing(error) ? error : null;
}

/** SMS or WhatsApp, on the screens that send a code. */
export function ChannelPicker({ value, onChange, desktop }: { value: CodeChannel; onChange: (c: CodeChannel) => void; desktop: boolean }) {
  const t = useT(AUTH);
  const buttons = (["sms", "whatsapp"] as const).map((k) => (
    <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
      {t(k === "sms" ? "chSms" : "chWhatsapp")}
    </button>
  ));
  if (desktop) {
    return (
      <div className="si-f">
        <label id="chL">{t("channel")}</label>
        <div className="si-seg" role="radiogroup" aria-labelledby="chL">
          {buttons}
        </div>
      </div>
    );
  }
  return (
    <div className="fld">
      <label id="chL">{t("channel")}</label>
      <div className="seg" role="radiogroup" aria-labelledby="chL" style={{ marginBottom: 0 }}>
        {buttons}
      </div>
    </div>
  );
}

/**
 * "Enter the code" step shared by sign-up, code sign-in and password reset. The code was just
 * sent when this mounts (by SMS or WhatsApp: `channel`); resend() sends another (after a
 * cooldown), and "Send it by … instead" resends by the other channel. A correct code signs
 * the user in on a scratch client (memory only); onVerified() gets that client and the
 * session and decides which app keeps it (admit() in components/portal/session.ts).
 * Supabase checks WhatsApp codes like SMS codes (type 'sms'): the channel only changes how
 * the Send SMS hook delivers it (0037).
 * Demo mode shows the code on screen when the database's DEMO_SMS_CODES setting is on.
 */
export function OtpStep({
  phone,
  desktop,
  channel: initialChannel = "sms",
  resend,
  onVerified,
  onChangeNumber,
}: {
  phone: string;
  desktop: boolean;
  channel?: CodeChannel;
  resend: () => Promise<{ error: { message?: string; code?: string } | null }>;
  onVerified: (scratch: SupabaseClient, session: Session) => void | Promise<void>;
  onChangeNumber: () => void;
}) {
  const t = useT(AUTH);
  const { lang } = useLang();
  const [channel, setChannel] = useState<CodeChannel>(initialChannel);
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
    const scratch = scratchClient();
    const { data, error } = await scratch.auth.verifyOtp({ phone, token, type: "sms" });
    if (error || !data.session) {
      setBusy(false);
      return setError(authError(t, error));
    }
    await onVerified(scratch, data.session);
    setBusy(false);
  }

  async function again(next: CodeChannel = channel) {
    setError(null);
    setNote(null);
    setBusy(true);
    const picked = await chooseChannel(phone, next, lang);
    const { error } = picked ? { error: picked } : await resend();
    setBusy(false);
    if (error) return setError(authError(t, error));
    setChannel(next);
    setDemoCode(null);
    setSentAt(Date.now());
    setNote(t("resent"));
  }

  const other: CodeChannel = channel === "sms" ? "whatsapp" : "sms";
  const switchLabel = t(other === "sms" ? "useSms" : "useWhatsapp");
  const sentLine = t(channel === "whatsapp" ? "codeSentWa" : "codeSent", { phone: formatPhone(phone) });
  const codeLabel = t(channel === "whatsapp" ? "codeWa" : "code");
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
          <label htmlFor="otp">{codeLabel}</label>
          <div className="in">{input}</div>
        </div>
        <button className="si-btn" disabled={busy}>
          {busy ? t("verifying") : t("verify")}
        </button>
        <div className="si-row">
          <button type="button" className="lk" onClick={() => again()} disabled={busy || wait > 0}>
            {resendLabel}
          </button>
          <button type="button" className="lk" onClick={onChangeNumber}>
            {t("changeNumber")}
          </button>
        </div>
        <div className="si-row">
          <button type="button" className="lk" onClick={() => again(other)} disabled={busy || wait > 0}>
            {switchLabel}
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
        <label htmlFor="otp">{codeLabel}</label>
        {input}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "-2px 0 8px", fontSize: 13.5 }}>
        <button type="button" onClick={() => again()} disabled={busy || wait > 0} style={{ ...link, opacity: wait > 0 ? 0.55 : 1 }}>
          {resendLabel}
        </button>
        <button type="button" onClick={onChangeNumber} style={link}>
          {t("changeNumber")}
        </button>
      </div>
      <div style={{ margin: "0 0 14px", fontSize: 13.5 }}>
        <button type="button" onClick={() => again(other)} disabled={busy || wait > 0} style={{ ...link, opacity: wait > 0 ? 0.55 : 1 }}>
          {switchLabel}
        </button>
      </div>
      <button className="cta" disabled={busy}>
        {busy ? t("verifying") : t("verify")}
      </button>
    </form>
  );
}
