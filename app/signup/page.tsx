"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { NamaLogo } from "@/components/icons";
import { AuthFrame } from "@/components/portal/AuthChrome";
import { asApp, homeFor, rememberSession, type AppKey } from "@/components/portal/session";
import { BackButton, Loading } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";

type SignupRole = "customer" | "driver" | "owner" | "business";

const COPY: Record<SignupRole, { title: string; sub: string; app: AppKey; nameLabel: string; next: string }> = {
  customer: { title: "Create account", sub: "Order water to your door", app: "customer", nameLabel: "Full name", next: "" },
  driver: { title: "Create account", sub: "You’ll add your tanker next", app: "driver", nameLabel: "Full name", next: "" },
  owner: {
    title: "Register your fleet",
    sub: "Create the owner login for your tanker company. Next you’ll add your commercial registration and bank details, then your tankers and drivers.",
    app: "company",
    nameLabel: "Your full name",
    next: "NWS reviews every new company before its tankers can take jobs.",
  },
  business: {
    title: "Open an account",
    sub: "Create your login for the Business portal. Next you’ll add your organisation and sites; NWS sets your credit limit when it activates the account.",
    app: "business",
    nameLabel: "Your full name",
    next: "Your colleagues create their own logins, then you invite them from Team.",
  },
};

const roleFor = (app: AppKey | null): SignupRole => (app === "company" ? "owner" : app === "business" ? "business" : app === "driver" ? "driver" : "customer");

export default function SignupPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Signup />
    </Suspense>
  );
}

function Signup() {
  const app = asApp(useSearchParams().get("app"));
  const router = useRouter();
  const [role, setRole] = useState<SignupRole>(() => roleFor(app));
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[role];
  const desktop = role === "owner" || role === "business";
  // Phone apps let people switch between customer and driver, as before.
  const pickable = !app || app === "customer" || app === "driver";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { role, full_name: fullName.trim(), phone: phone.trim() || null },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setBusy(false);
    if (error) return setError(error.message);
    if (!data.session) return setSentTo(email.trim());
    rememberSession(true);
    router.replace(homeFor(role));
  }

  const loginHref = `/login?app=${copy.app}`;

  if (sentTo) {
    const body = (
      <>
        We sent a confirmation link to <b>{sentTo}</b>. Open it on this device to finish signing up.
      </>
    );
    if (desktop) {
      return (
        <AuthFrame app={copy.app}>
          <div>
            <h2>Check your email</h2>
            <p>{body}</p>
          </div>
          <Link className="si-btn gh" href={loginHref}>
            Back to sign in
          </Link>
        </AuthFrame>
      );
    }
    return (
      <main className="screen">
        <div className="dlogin">
          <NamaLogo className="ph-logo" />
          <h2>Check your email</h2>
          <p>{body}</p>
          <Link href={loginHref} className="cta sec">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  if (desktop) {
    return (
      <AuthFrame app={copy.app}>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.sub}</p>
        </div>
        <form onSubmit={submit}>
          {error && <div className="si-msg">{error}</div>}
          <div className="si-f">
            <label htmlFor="suN">{copy.nameLabel}</label>
            <div className="in">
              <input id="suN" required maxLength={120} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
          </div>
          <div className="si-f">
            <label htmlFor="suP">Mobile number (optional)</label>
            <div className="in">
              <input id="suP" type="tel" maxLength={32} autoComplete="tel" dir="ltr" placeholder="+968" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="si-f">
            <label htmlFor="suE">{role === "business" ? "Work email" : "Email"}</label>
            <div className="in">
              <input id="suE" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="si-f">
            <label htmlFor="suW">Password</label>
            <div className="in">
              <input id="suW" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <button className="si-btn" disabled={busy}>
            {busy ? "Creating account…" : role === "owner" ? "Create owner account" : "Create business login"}
          </button>
        </form>
        <p style={{ margin: 0, fontSize: 13 }}>{copy.next}</p>
        <div className="si-links">
          Already registered?{" "}
          <Link className="lk" href={loginHref}>
            Sign in
          </Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href={app ? loginHref : "/login"} />
        <div>
          <h3>{copy.title}</h3>
          <small>{copy.sub}</small>
        </div>
      </div>
      <form onSubmit={submit}>
        {pickable && (
          <div className="seg" role="radiogroup" aria-label="Account type">
            {(["customer", "driver"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
                {r === "customer" ? "Customer" : "Driver"}
              </button>
            ))}
          </div>
        )}
        {role === "driver" && <div className="banner info">Driving for a tanker company? Sign up here, then give your company owner this email so they can add you in the Company portal.</div>}
        {error && <div className="banner badb">{error}</div>}
        <div className="fld">
          <label htmlFor="name">Full name</label>
          <input id="name" required maxLength={120} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="phone">Mobile number (optional)</label>
          <input id="phone" type="tel" maxLength={32} autoComplete="tel" dir="ltr" placeholder="+968" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="cta" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
