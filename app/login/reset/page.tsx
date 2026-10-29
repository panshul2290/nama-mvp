"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { NamaLogo } from "@/components/icons";
import { AUTH, authError } from "@/components/portal/authI18n";
import { OtpStep } from "@/components/portal/OtpStep";
import { asApp } from "@/components/portal/session";
import { Loading } from "@/components/Shell";
import { LangToggle, useT } from "@/lib/i18n";
import { formatPhone, parseContact } from "@/lib/phone";
import { supabase } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Reset />
    </Suspense>
  );
}

// Password reset.
//   Mobile accounts: enter the number → SMS code (signInWithOtp, never creates an account)
//   → the code signs them in → choose a new password.
//   Email accounts: the "Forgot password?" email link signs them in (via /auth/callback)
//   and lands here, straight on "choose a new password".
function Reset() {
  const params = useSearchParams();
  const app = asApp(params.get("app"));
  const router = useRouter();
  const t = useT(AUTH);
  const [step, setStep] = useState<"loading" | "request" | "code" | "password">("loading");
  const [id, setId] = useState(() => formatPhone(params.get("phone")));
  const [phone, setPhone] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase()
      .auth.getSession()
      .then(({ data }) => setStep(data.session ? "password" : "request"));
  }, []);

  // Unknown numbers get the same answer as known ones (no account lookup by number).
  const sendCode = async (to: string) => {
    const { error } = await supabase().auth.signInWithOtp({ phone: to, options: { shouldCreateUser: false } });
    const unknown = error && (error.code === "otp_disabled" || /signups not allowed/i.test(error.message));
    return { error: unknown ? null : error };
  };

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    const who = parseContact(id);
    if (!who) return setError(t("badId"));
    setBusy(true);
    if ("email" in who) {
      const { error } = await supabase().auth.resetPasswordForEmail(who.email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/login/reset`,
      });
      setBusy(false);
      if (error) return setError(authError(t, error));
      return setNote(t("resetEmailSent", { email: who.email }));
    }
    const { error } = await sendCode(who.phone);
    setBusy(false);
    if (error) return setError(authError(t, error));
    setPhone(who.phone);
    setStep("code");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(t("pwMismatch"));
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message.includes("session") ? t("linkExpired") : authError(t, error));
    router.replace("/");
  }

  const loginHref = `/login${app ? `?app=${app}` : ""}`;
  if (step === "loading") return <Loading />;

  return (
    <main className="screen">
      <div className="dlogin">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <NamaLogo className="ph-logo" />
          <LangToggle />
        </div>
        {step === "code" && phone ? (
          <OtpStep phone={phone} desktop={false} resend={() => sendCode(phone)} onVerified={() => setStep("password")} onChangeNumber={() => setStep("request")} />
        ) : step === "request" ? (
          <>
            <h2>{t("resetTitle")}</h2>
            <p>{t("resetSub")}</p>
            <form onSubmit={request}>
              {error && <div className="banner badb">{error}</div>}
              {note && <div className="banner info">{note}</div>}
              <div className="fld">
                <label htmlFor="rid">{t("idLabel")}</label>
                <input id="rid" type="text" inputMode="tel" autoComplete="username" dir="ltr" required autoFocus placeholder={t("idHint")} value={id} onChange={(e) => setId(e.target.value)} />
              </div>
              <button className="cta" disabled={busy}>
                {busy ? t("sending") : t("sendCode")}
              </button>
            </form>
          </>
        ) : (
          <>
            <h2>{t("newPwTitle")}</h2>
            <p>{t("newPwSub")}</p>
            <form onSubmit={save}>
              {error && <div className="banner badb">{error}</div>}
              <div className="fld">
                <label htmlFor="pw">{t("newPw")}</label>
                <input id="pw" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="pw2">{t("newPw2")}</label>
                <input id="pw2" type="password" required minLength={6} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <button className="cta" disabled={busy}>
                {busy ? t("saving") : t("savePw")}
              </button>
            </form>
          </>
        )}
        <Link href={loginHref} className="cta sec">
          {t("backToSignIn")}
        </Link>
      </div>
    </main>
  );
}
