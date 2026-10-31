"use client";

import Link from "next/link";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { IdentityFields, ID_DICT, idNoProblem, saveIdentityPhotos, verifyIdNumber, type DocKind, type IdPhotos, type IdType } from "@/components/customer/identity";
import { NamaLogo } from "@/components/icons";
import { AuthFrame } from "@/components/portal/AuthChrome";
import { AUTH, authError } from "@/components/portal/authI18n";
import { ChannelPicker, chooseChannel, OtpStep, type CodeChannel } from "@/components/portal/OtpStep";
import { admit, asApp, rememberSession, type AppKey } from "@/components/portal/session";
import { WrongAccount } from "@/components/portal/WrongAccount";
import { BackButton, Loading } from "@/components/Shell";
import { LangToggle, useLang, useT } from "@/lib/i18n";
import { isEmail, normalizePhone } from "@/lib/phone";
import { scratchClient, supabase } from "@/lib/supabase/client";
import { MIN_PASSWORD, passwordTooShort } from "@/lib/password";
import type { Role } from "@/lib/types";

type SignupRole = "customer" | "driver" | "owner" | "business";

// Dictionary keys (components/portal/authI18n.ts) for each role's copy.
const COPY: Record<SignupRole, { title: string; sub: string; app: AppKey; nameLabel: string; next: string; button: string }> = {
  customer: { title: "createAccount", sub: "subCustomer", app: "customer", nameLabel: "fullName", next: "", button: "createAccount" },
  driver: { title: "createAccount", sub: "subDriver", app: "driver", nameLabel: "fullName", next: "", button: "createAccount" },
  owner: { title: "ownerTitle", sub: "ownerSub", app: "company", nameLabel: "yourFullName", next: "ownerNext", button: "ownerBtn" },
  business: { title: "bizTitle", sub: "bizSub", app: "business", nameLabel: "yourFullName", next: "bizNext", button: "bizBtn" },
};

const roleFor = (app: AppKey | null): SignupRole => (app === "company" ? "owner" : app === "business" ? "business" : app === "driver" ? "driver" : "customer");

export default function SignupPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Signup />
    </Suspense>
  );
}

// Every account signs up with a mobile number and a password (email is optional).
// Supabase sends a code (by SMS or WhatsApp, 0037) to verify the number; the second step
// enters it. The new session is checked by admit() and kept in the new account's own app.
// Customers may add their ID / resident card / passport now or later in Account (#10).
function Signup() {
  const app = asApp(useSearchParams().get("app"));
  const router = useRouter();
  const t = useT(AUTH);
  const ti = useT(ID_DICT);
  const { lang } = useLang();
  const [channel, setChannel] = useState<CodeChannel>("sms");
  const [role, setRole] = useState<SignupRole>(() => roleFor(app));
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null); // E.164 the code was sent to
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<Role | null | undefined>(undefined);
  // E1 / #10: customers may give their ID / resident card / passport and a photo of it (optional).
  const [addId, setAddId] = useState(false);
  const [idType, setIdType] = useState<IdType>("civil_id");
  const [idNo, setIdNo] = useState("");
  const [photos, setPhotos] = useState<IdPhotos>({});
  const copy = COPY[role];
  const desktop = role === "owner" || role === "business";
  // Without an app (older links) people pick customer or driver; each app signs up its own kind only.
  const pickable = !app;

  async function done(scratch: SupabaseClient, session: Session) {
    const res = await admit(copy.app, scratch, session);
    if (!res.ok) {
      setCodeFor(null);
      return setWrong(res.wrong);
    }
    rememberSession(true, res.app);
    if (role === "customer" && res.role === "customer" && addId && (idNo.trim() || Object.values(photos).some(Boolean))) {
      // The account exists now: check the number (simulated) and upload the card photos. A problem
      // doesn't undo the sign-up; Account opens on the identity step instead.
      const db = supabase(res.app);
      const idErr = idNo.trim() ? await verifyIdNumber(db, idType, idNo) : null;
      const up = await saveIdentityPhotos(db, session.user.id, photos);
      if (idErr || up.problem) return router.replace(`/customer/account?identity=${idErr ? "number" : up.problem}`);
    }
    router.replace(res.home);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWrong(undefined);
    const e164 = normalizePhone(phone);
    if (!e164) return setError(t("badMobile"));
    const mail = email.trim().toLowerCase();
    if (mail && !isEmail(mail)) return setError(t("badEmail"));
    if (passwordTooShort(password)) return setError(t("pwShort"));
    if (role === "customer" && !desktop && addId && idNo.trim()) {
      const bad = idNoProblem(idType, idNo);
      if (bad) return setError(ti(bad));
    }
    setBusy(true);
    const picked = await chooseChannel(e164, channel, lang);
    if (picked) {
      setBusy(false);
      return setError(authError(t, picked));
    }
    const scratch = scratchClient();
    const { data, error } = await scratch.auth.signUp({
      phone: e164,
      password,
      // The sign-up trigger copies these into the profile (contact_email: optional, unverified).
      options: { data: { role, full_name: fullName.trim(), phone: e164, contact_email: mail || null } },
    });
    if (error) {
      setBusy(false);
      return setError(authError(t, error));
    }
    if (data.session) await done(scratch, data.session); // phone confirmation switched off in Supabase
    else setCodeFor(e164);
    setBusy(false);
  }

  const loginHref = `/login?app=${copy.app}`;
  const otp = codeFor && (
    <OtpStep
      phone={codeFor}
      desktop={desktop}
      channel={channel}
      resend={() => supabase().auth.resend({ type: "sms", phone: codeFor })}
      onVerified={done}
      onChangeNumber={() => setCodeFor(null)}
    />
  );

  if (desktop) {
    return (
      <AuthFrame app={copy.app}>
        {otp || (
          <>
            <div>
              <h2>{t(copy.title)}</h2>
              <p>{t(copy.sub)}</p>
            </div>
            <form onSubmit={submit}>
              {error && <div className="si-msg">{error}</div>}
              {wrong !== undefined && <WrongAccount role={wrong} desktop />}
              <div className="si-f">
                <label htmlFor="suN">{t(copy.nameLabel)}</label>
                <div className="in">
                  <input id="suN" required maxLength={120} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
              </div>
              <div className="si-f">
                <label htmlFor="suP">{t("mobile")}</label>
                <div className="in">
                  <input id="suP" type="tel" required maxLength={20} autoComplete="tel" dir="ltr" placeholder="+968 9123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
                <small style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.75 }}>{t("mobileHint")}</small>
              </div>
              <ChannelPicker value={channel} onChange={setChannel} desktop />
              <div className="si-f">
                <label htmlFor="suE">{role === "business" ? t("workEmailOpt") : t("emailOpt")}</label>
                <div className="in">
                  <input id="suE" type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
              <div className="si-f">
                <label htmlFor="suW">{t("password")}</label>
                <div className="in">
                  <input id="suW" type="password" required minLength={MIN_PASSWORD} aria-describedby="suWh" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <small id="suWh">{t("pwRule")}</small>
              </div>
              <button className="si-btn" disabled={busy}>
                {busy ? t("creating") : t(copy.button)}
              </button>
            </form>
            <p style={{ margin: 0, fontSize: 13 }}>{t(copy.next)}</p>
            <div className="si-links">
              {t("already")}{" "}
              <Link className="lk" href={loginHref}>
                {t("signIn")}
              </Link>
            </div>
          </>
        )}
      </AuthFrame>
    );
  }

  if (otp) {
    return (
      <main className="screen">
        <div className="dlogin">
          <NamaLogo className="ph-logo" />
          {otp}
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="rq-h">
        <BackButton href={app ? loginHref : "/login"} />
        <div style={{ flex: 1 }}>
          <h3>{t(copy.title)}</h3>
          <small>{t(copy.sub)}</small>
        </div>
        <LangToggle />
      </div>
      <form onSubmit={submit}>
        {pickable && (
          <div className="seg" role="radiogroup" aria-label={t("accountType")}>
            {(["customer", "driver"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
                {t(r)}
              </button>
            ))}
          </div>
        )}
        {role === "driver" && <div className="banner info">{t("driverBanner")}</div>}
        {error && <div className="banner badb">{error}</div>}
        {wrong !== undefined && <WrongAccount role={wrong} desktop={false} />}
        <div className="fld">
          <label htmlFor="name">{t("fullName")}</label>
          <input id="name" required maxLength={120} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="phone">{t("mobile")}</label>
          <input id="phone" type="tel" required maxLength={20} autoComplete="tel" dir="ltr" placeholder="+968 9123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <small style={{ display: "block", marginTop: 4, fontSize: 12, color: "var(--muted)" }}>{t("mobileHint")}</small>
        </div>
        <ChannelPicker value={channel} onChange={setChannel} desktop={false} />
        <div className="fld">
          <label htmlFor="email">{t("emailOpt")}</label>
          <input id="email" type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="password">{t("password")}</label>
          <input id="password" type="password" required minLength={MIN_PASSWORD} aria-describedby="pwHint" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <small id="pwHint" style={{ display: "block", marginTop: 4, fontSize: 12, color: "var(--muted)" }}>{t("pwRule")}</small>
        </div>
        {role === "customer" && (
          <>
            <h4 className="ch-sec" style={{ margin: "16px 0 4px" }}>
              {ti("idSecOpt")}
            </h4>
            <p className="mut small" style={{ marginTop: 0 }}>
              {ti("idSecOptS")}
            </p>
            <div className="seg" role="radiogroup" aria-label={ti("idSecOpt")}>
              <button type="button" role="radio" aria-checked={!addId} className={!addId ? "on" : ""} onClick={() => setAddId(false)}>
                {ti("idAddLater")}
              </button>
              <button type="button" role="radio" aria-checked={addId} className={addId ? "on" : ""} onClick={() => setAddId(true)}>
                {ti("idAddNow")}
              </button>
            </div>
            {addId && (
              <IdentityFields
                type={idType}
                no={idNo}
                photos={photos}
                onType={setIdType}
                onNo={setIdNo}
                onPhoto={(k: DocKind, f) => setPhotos((p) => ({ ...p, [k]: f }))}
              />
            )}
          </>
        )}
        <button className="cta" disabled={busy}>
          {busy ? t("creating") : t("createAccount")}
        </button>
      </form>
    </main>
  );
}
