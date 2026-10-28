"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { NamaLogo } from "@/components/icons";
import { APP_INFO, AuthFrame } from "@/components/portal/AuthChrome";
import { asApp, isDesktopApp, rememberSession, type AppKey } from "@/components/portal/session";
import { Loading } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Login />
    </Suspense>
  );
}

// Sign-up link under each app's sign-in form (staff accounts are created by NWS).
const SIGNUP: Record<AppKey, [string, string] | null> = {
  nws: null,
  customer: ["New here?", "Create account"],
  driver: ["New driver?", "Create account"],
  business: ["New business customer?", "Open an account"],
  company: ["New tanker company?", "Register your fleet"],
};

function Login() {
  const app = asApp(useSearchParams().get("app"));
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(true);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return setError(error.message);
    rememberSession(keep);
    router.replace("/");
  }

  async function forgot() {
    setError(null);
    setNote(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      emailRef.current?.focus();
      return setError("Enter your email above, then choose “Forgot password?” again.");
    }
    const { error } = await supabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/login/reset`,
    });
    if (error) return setError(error.message);
    setNote(`If ${email.trim()} has an account, a reset link is on its way. Open it on this device.`);
  }

  function sso() {
    setError(null);
    setNote("SSO simulated — NWS single sign-on isn’t connected in this demo. Sign in with your NWS email and password.");
    emailRef.current?.focus();
  }

  const signupHref = `/signup${app ? `?app=${app}` : ""}`;
  const signup = app ? SIGNUP[app] : (["New here?", "Create account"] as [string, string]);

  // Web apps: the full-screen sign-in from the prototype.
  if (app && isDesktopApp(app)) {
    const info = APP_INFO[app];
    return (
      <AuthFrame app={app}>
        <div>
          <h2>{info.title}</h2>
          <p>{info.sub}</p>
        </div>
        <form onSubmit={submit}>
          {error && <div className="si-msg">{error}</div>}
          {note && <div className="si-msg info">{note}</div>}
          <div className="si-f">
            <label htmlFor="siE">{info.emailLabel}</label>
            <div className="in">
              <input id="siE" ref={emailRef} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="si-f">
            <label htmlFor="siP">Password</label>
            <div className="in">
              <input id="siP" type={show ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="lk" onClick={() => setShow((s) => !s)} aria-pressed={show}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="si-row">
            <label className="si-ck">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              Keep me signed in
            </label>
            <button type="button" className="lk" onClick={forgot}>
              Forgot password?
            </button>
          </div>
          <button className="si-btn" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {app === "nws" && (
          <>
            <div className="si-or">or</div>
            <button type="button" className="si-btn gh" onClick={sso}>
              Continue with NWS single sign-on
            </button>
          </>
        )}
        {signup && (
          <div className="si-links">
            {signup[0]}{" "}
            <Link className="lk" href={signupHref}>
              {signup[1]}
            </Link>
          </div>
        )}
      </AuthFrame>
    );
  }

  // Phone apps (and the Android APKs, which open /login with or without ?app=).
  const info = app ? APP_INFO[app] : null;
  return (
    <main className="screen">
      <div className="dlogin">
        <NamaLogo className="ph-logo" />
        <h2>{info ? info.name : "Water tankers you can trust, on time"}</h2>
        <p>{info ? info.sub : "Order drinking water, wastewater pickup or treated water from permitted tankers — or sign in as a driver to pick up jobs."}</p>
        <form onSubmit={submit}>
          {error && <div className="banner badb">{error}</div>}
          {note && <div className="banner info">{note}</div>}
          <div className="fld">
            <label htmlFor="email">Email</label>
            <input id="email" ref={emailRef} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "-2px 0 14px", fontSize: 13.5 }}>
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
              Keep me signed in
            </label>
            <button type="button" onClick={forgot} style={{ background: "none", border: 0, padding: 0, color: "var(--link)", fontWeight: 700, font: "inherit", cursor: "pointer" }}>
              Forgot password?
            </button>
          </div>
          <button className="cta" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {signup && (
          <Link href={signupHref} className="cta sec">
            {signup[1]}
          </Link>
        )}
      </div>
    </main>
  );
}
