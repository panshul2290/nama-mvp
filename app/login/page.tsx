"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { NamaLogo } from "@/components/icons";
import { APP_INFO, AuthFrame } from "@/components/portal/AuthChrome";
import { AUTH, authError } from "@/components/portal/authI18n";
import { ChannelPicker, chooseChannel, OtpStep, type CodeChannel } from "@/components/portal/OtpStep";
import { admit, asApp, isDesktopApp, rememberSession, resetRedirect, type AppKey } from "@/components/portal/session";
import { asRole, WrongAccount } from "@/components/portal/WrongAccount";
import { Loading } from "@/components/Shell";
import { LangToggle, useLang, useT } from "@/lib/i18n";
import { parseContact } from "@/lib/phone";
import { scratchClient, supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

export default function LoginPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ForApp />
    </Suspense>
  );
}

// A fresh form per app (the wrong-account message links from one app's sign-in to another's).
function ForApp() {
  const app = useSearchParams().get("app");
  return <Login key={app ?? ""} />;
}

// Sign-up link under each app's sign-in form (staff accounts are created by NWS).
const SIGNUP: Record<AppKey, [string, string] | null> = {
  nws: null,
  customer: ["New here?", "Create account"],
  driver: ["New driver?", "Create account"],
  business: ["New business customer?", "Open an account"],
  company: ["New tanker company?", "Register your fleet"],
};

// One field takes a mobile number or an email: mobile accounts (sign-up since 0019) sign in
// by phone, older and staff accounts by email. Both use a password.
// Each app accepts only its own kind of account: the sign-in runs on a scratch client and
// admit() moves the session into this app's cookie, or signs a wrong account out at once.
// Without ?app= (bookmarks, older links) any account signs in to its own app, as before.
// "Sign in with a code" (mobile accounts, not the NWS portal): a code by SMS or WhatsApp
// (signInWithOtp, never creates an account), checked on a scratch client and admitted
// exactly like the password path, so wrong-app accounts are refused and "Keep me signed in"
// applies.
function Login() {
  const params = useSearchParams();
  // ?next= returns to a page of the same app after signing in (e.g. the NWS wall screen).
  const returnTo = (app: string, home: string) => {
    const next = params.get("next");
    return next && next.startsWith(`/${app}/`) && !next.includes("//") && !next.includes("..") ? next : home;
  };
  const app = asApp(params.get("app"));
  const router = useRouter();
  const t = useT(AUTH);
  const { lang } = useLang();
  const [mode, setMode] = useState<"password" | "code">("password");
  const [channel, setChannel] = useState<CodeChannel>("sms");
  const [codeFor, setCodeFor] = useState<string | null>(null); // E.164 the code went to
  const codeLogin = app !== "nws";
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(true);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ?ended=1: this app's session ended on its own (password changed, signed out elsewhere).
  const [note, setNote] = useState<string | null>(() => (params.has("ended") ? t("sessionEnded") : null));
  const [busy, setBusy] = useState(false);
  // Set when an account of another kind tried this app (also ?wrong=<role> from the email-link callback or an app).
  const [wrong, setWrong] = useState<Role | null | undefined>(() => (params.has("wrong") ? asRole(params.get("wrong")) : undefined));
  const idRef = useRef<HTMLInputElement>(null);

  // Unknown numbers get the same answer as known ones (shouldCreateUser: false, no lookup).
  const sendCode = async (to: string) => {
    const { error } = await supabase().auth.signInWithOtp({ phone: to, options: { shouldCreateUser: false } });
    const unknown = error && (error.code === "otp_disabled" || /signups not allowed/i.test(error.message));
    return { error: unknown ? null : error };
  };

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setWrong(undefined);
    const who = parseContact(id);
    if (!who) {
      idRef.current?.focus();
      return setError(t("badId"));
    }
    if ("email" in who) return setError(t("codeNeedsMobile"));
    setBusy(true);
    const picked = await chooseChannel(who.phone, channel, lang);
    const { error } = picked ? { error: picked } : await sendCode(who.phone);
    setBusy(false);
    if (error) return setError(authError(t, error));
    setCodeFor(who.phone);
  }

  async function codeVerified(scratch: SupabaseClient, session: Session) {
    const res = await admit(app, scratch, session);
    if (!res.ok) {
      setCodeFor(null);
      return setWrong(res.wrong);
    }
    rememberSession(keep, res.app);
    router.replace(returnTo(res.app, res.home));
  }

  function switchMode() {
    setError(null);
    setNote(null);
    setWrong(undefined);
    setMode((m) => (m === "password" ? "code" : "password"));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "code") return requestCode(e);
    setError(null);
    setNote(null);
    setWrong(undefined);
    const who = parseContact(id);
    if (!who) {
      idRef.current?.focus();
      return setError(t("badId"));
    }
    setBusy(true);
    const scratch = scratchClient();
    const { data, error } = await scratch.auth.signInWithPassword({ ...who, password });
    if (error || !data.session) {
      setBusy(false);
      return setError(authError(t, error));
    }
    const res = await admit(app, scratch, data.session);
    setBusy(false);
    if (!res.ok) {
      setPassword("");
      return setWrong(res.wrong);
    }
    rememberSession(keep, res.app);
    router.replace(returnTo(res.app, res.home));
  }

  // Email accounts get a reset link; everyone else resets by SMS code on /login/reset.
  async function forgot() {
    setError(null);
    setNote(null);
    setWrong(undefined);
    const who = parseContact(id);
    if (who && "email" in who) {
      // This app's client keeps the PKCE verifier, in the cookie the callback reads (?app=).
      const { error } = await supabase(app).auth.resetPasswordForEmail(who.email, { redirectTo: resetRedirect(app) });
      if (error) return setError(authError(t, error));
      return setNote(t("resetEmailSent", { email: who.email }));
    }
    const q = new URLSearchParams();
    if (who) q.set("phone", who.phone);
    if (app) q.set("app", app);
    router.push(`/login/reset${q.size ? `?${q}` : ""}`);
  }

  function sso() {
    setError(null);
    setNote(t("ssoNote"));
    idRef.current?.focus();
  }

  const signupHref = `/signup${app ? `?app=${app}` : ""}`;
  const signup = app ? SIGNUP[app] : (["New here?", "Create account"] as [string, string]);

  const byCode = mode === "code";
  const otp = codeFor && (
    <OtpStep
      phone={codeFor}
      desktop={Boolean(app && isDesktopApp(app))}
      channel={channel}
      resend={() => sendCode(codeFor)}
      onVerified={codeVerified}
      onChangeNumber={() => setCodeFor(null)}
    />
  );
  const submitLabel = byCode ? (busy ? t("sending") : t("sendCode")) : busy ? t("signingIn") : t("signIn");

  // Web apps: the full-screen sign-in from the prototype.
  if (app && isDesktopApp(app)) {
    if (otp) return <AuthFrame app={app}>{otp}</AuthFrame>;
    return (
      <AuthFrame app={app}>
        <div>
          <h2>{byCode ? t("withCode") : t(`title_${app}`)}</h2>
          <p>{byCode ? t("codeLoginSub") : t(`sub_${app}`)}</p>
        </div>
        <form onSubmit={submit}>
          {error && <div className="si-msg">{error}</div>}
          {wrong !== undefined && <WrongAccount role={wrong} desktop />}
          {note && <div className="si-msg info">{note}</div>}
          <div className="si-f">
            <label htmlFor="siE">{byCode ? t("mobile") : t("idLabel")}</label>
            <div className="in">
              <input id="siE" ref={idRef} type="text" inputMode={byCode ? "tel" : "email"} autoComplete="username" dir="ltr" required placeholder={t("idHint")} value={id} onChange={(e) => setId(e.target.value)} />
            </div>
          </div>
          {byCode ? (
            <ChannelPicker value={channel} onChange={setChannel} desktop />
          ) : (
            <div className="si-f">
              <label htmlFor="siP">{t("password")}</label>
              <div className="in">
                <input id="siP" type={show ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="lk" onClick={() => setShow((s) => !s)} aria-pressed={show}>
                  {show ? t("hide") : t("show")}
                </button>
              </div>
            </div>
          )}
          <div className="si-row">
            <label className="si-ck">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              {t("keep")}
            </label>
            {!byCode && (
              <button type="button" className="lk" onClick={forgot}>
                {t("forgot")}
              </button>
            )}
          </div>
          <button className="si-btn" disabled={busy}>
            {submitLabel}
          </button>
        </form>
        {codeLogin && (
          <button type="button" className="si-btn gh" onClick={switchMode}>
            {byCode ? t("withPassword") : t("withCode")}
          </button>
        )}
        {app === "nws" && (
          <>
            <div className="si-or">{t("or")}</div>
            <button type="button" className="si-btn gh" onClick={sso}>
              {t("sso")}
            </button>
          </>
        )}
        {signup && (
          <div className="si-links">
            {t(`signupQ_${app}`)}{" "}
            <Link className="lk" href={signupHref}>
              {t(`signupA_${app}`)}
            </Link>
          </div>
        )}
      </AuthFrame>
    );
  }

  // Phone apps (and the Android APKs, which open /login with or without ?app=).
  const info = app ? APP_INFO[app] : null;
  if (otp) {
    return (
      <main className="screen">
        <div className="dlogin">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <NamaLogo className="ph-logo" />
            <LangToggle />
          </div>
          {otp}
        </div>
      </main>
    );
  }
  return (
    <main className="screen">
      <div className="dlogin">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <NamaLogo className="ph-logo" />
          <LangToggle />
        </div>
        <h2>{byCode ? t("withCode") : info ? info.name : "Water tankers you can trust, on time"}</h2>
        <p>{byCode ? t("codeLoginSub") : info ? info.sub : "Order drinking water, wastewater pickup or treated water from permitted tankers — or sign in as a driver to pick up jobs."}</p>
        <form onSubmit={submit}>
          {error && <div className="banner badb">{error}</div>}
          {wrong !== undefined && <WrongAccount role={wrong} desktop={false} />}
          {note && <div className="banner info">{note}</div>}
          <div className="fld">
            <label htmlFor="email">{byCode ? t("mobile") : t("idLabel")}</label>
            <input id="email" ref={idRef} type="text" inputMode={byCode ? "tel" : "email"} autoComplete="username" dir="ltr" required placeholder={t("idHint")} value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          {byCode ? (
            <ChannelPicker value={channel} onChange={setChannel} desktop={false} />
          ) : (
            <div className="fld">
              <label htmlFor="password">{t("password")}</label>
              <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "-2px 0 14px", fontSize: 13.5 }}>
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
              {t("keep")}
            </label>
            {!byCode && (
              <button type="button" onClick={forgot} style={{ background: "none", border: 0, padding: 0, color: "var(--link)", fontWeight: 700, font: "inherit", cursor: "pointer" }}>
                {t("forgot")}
              </button>
            )}
          </div>
          <button className="cta" disabled={busy}>
            {submitLabel}
          </button>
        </form>
        {codeLogin && (
          <button type="button" className="cta sec" onClick={switchMode}>
            {byCode ? t("withPassword") : t("withCode")}
          </button>
        )}
        {signup && (
          <Link href={signupHref} className="cta sec">
            {signup[1]}
          </Link>
        )}
      </div>
    </main>
  );
}
