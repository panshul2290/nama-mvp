"use client";

// NWS two-step sign-in (Supabase Auth MFA, TOTP; 0052, security review SEC-06).
//   StaffMfaGate  wraps the portal: a staff member who added an authenticator app is asked for
//                 its code after the password (the session goes aal1 → aal2); with STAFF_MFA on,
//                 a staff member without one must add it first (the database gives an aal1
//                 session no staff rights then).
//   MfaPanel      NWS → Two-step sign-in: add or remove the authenticator; admins switch
//                 STAFF_MFA (audited).
import { useCallback, useEffect, useState } from "react";
import { AuthFrame } from "@/components/portal/AuthChrome";
import { AUTH } from "@/components/portal/authI18n";
import { signOutApp } from "@/components/portal/session";
import { friendlyError } from "@/lib/errors";
import { useLang, useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";

type Gate = "checking" | "ok" | "challenge" | "enroll";
type Status = { required: boolean; aal: string; hasFactor: boolean; factorId: string | null; nextAal: string | null };

async function mfaState(): Promise<Status> {
  const db = supabase("nws");
  const [aal, st, fx] = await Promise.all([
    db.auth.mfa.getAuthenticatorAssuranceLevel(),
    db.rpc("staff_mfa_status"),
    db.auth.mfa.listFactors(),
  ]);
  const verified = (fx.data?.totp ?? []).filter((f) => f.status === "verified");
  return {
    // Before 0052 (no RPC) the second step is simply optional.
    required: Boolean((st.data as { required?: boolean } | null)?.required),
    aal: aal.data?.currentLevel ?? "aal1",
    nextAal: aal.data?.nextLevel ?? null,
    hasFactor: verified.length > 0,
    factorId: verified[0]?.id ?? null,
  };
}

export function StaffMfaGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<Gate>("checking");
  const [factorId, setFactorId] = useState<string | null>(null);
  const check = useCallback(async () => {
    const s = await mfaState();
    setFactorId(s.factorId);
    if (s.hasFactor && s.aal !== "aal2") return setGate("challenge");
    if (s.required && s.aal !== "aal2") return setGate("enroll");
    setGate("ok");
  }, []);
  useEffect(() => {
    const id = setTimeout(check, 0);
    return () => clearTimeout(id);
  }, [check]);

  if (gate === "ok") return <>{children}</>;
  if (gate === "checking") return null;
  return (
    <AuthFrame app="nws">
      {gate === "challenge" && factorId ? <MfaChallenge factorId={factorId} onDone={() => setGate("ok")} /> : <MfaEnroll required onDone={() => setGate("ok")} />}
      <SignOutLink />
    </AuthFrame>
  );
}

function SignOutLink() {
  const t = useT(AUTH);
  return (
    <button
      type="button"
      className="si-btn gh"
      onClick={async () => {
        await signOutApp("nws");
        window.location.replace("/login?app=nws");
      }}
    >
      {t("mfaSignOut")}
    </button>
  );
}

function CodeForm({ busy, error, onSubmit, label }: { busy: boolean; error: string | null; onSubmit: (code: string) => void; label: string }) {
  const t = useT(AUTH);
  const [code, setCode] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code.replace(/\D/g, ""));
      }}
    >
      {error && <div className="si-msg">{error}</div>}
      <div className="si-f">
        <label htmlFor="mfaC">{t("mfaCode")}</label>
        <div className="in">
          <input id="mfaC" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} dir="ltr" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
      </div>
      <button className="si-btn" disabled={busy || code.replace(/\D/g, "").length !== 6}>
        {busy ? t("mfaVerifying") : label}
      </button>
    </form>
  );
}

export function MfaChallenge({ factorId, onDone }: { factorId: string; onDone: () => void }) {
  const t = useT(AUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div>
        <h2>{t("mfaTitle")}</h2>
        <p>{t("mfaChallengeSub")}</p>
      </div>
      <CodeForm
        busy={busy}
        error={error}
        label={t("mfaVerify")}
        onSubmit={async (code) => {
          setBusy(true);
          setError(null);
          const { error: e } = await supabase("nws").auth.mfa.challengeAndVerify({ factorId, code });
          setBusy(false);
          if (e) return setError(t("mfaBadCode"));
          onDone();
        }}
      />
    </>
  );
}

export function MfaEnroll({ required = false, onDone }: { required?: boolean; onDone: () => void }) {
  const t = useT(AUTH);
  const [enrolled, setEnrolled] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const db = supabase("nws");
      // A setup started earlier and never finished blocks a new one: clear it.
      const fx = await db.auth.mfa.listFactors();
      for (const f of fx.data?.all ?? []) if (f.factor_type === "totp" && f.status !== "verified") await db.auth.mfa.unenroll({ factorId: f.id });
      const { data, error: e } = await db.auth.mfa.enroll({ factorType: "totp", friendlyName: `Nama NWS ${new Date().toISOString().slice(0, 10)}` });
      if (!live) return;
      if (e || !data) return setError(t("mfaUnavailable"));
      setEnrolled({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
    return () => {
      live = false;
    };
  }, [t]);

  return (
    <>
      <div>
        <h2>{t("mfaEnrollTitle")}</h2>
        <p>{t(required ? "mfaEnrollRequired" : "mfaEnrollSub")}</p>
      </div>
      {enrolled && (
        <div style={{ display: "grid", justifyItems: "center", gap: 8 }}>
          {/* The QR code is an SVG data URL from Supabase Auth (allowed by the CSP: img-src data:). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrolled.qr} alt={t("mfaQrAlt")} width={180} height={180} style={{ background: "#fff", padding: 8, borderRadius: 8 }} />
          <small>
            {t("mfaSecret")} <bdi dir="ltr" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{enrolled.secret}</bdi>
          </small>
        </div>
      )}
      {(enrolled || error) && (
        <CodeForm
          busy={busy || !enrolled}
          error={error}
          label={t("mfaVerify")}
          onSubmit={async (code) => {
            if (!enrolled) return;
            setBusy(true);
            setError(null);
            const { error: e } = await supabase("nws").auth.mfa.challengeAndVerify({ factorId: enrolled.id, code });
            setBusy(false);
            if (e) return setError(t("mfaBadCode"));
            onDone();
          }}
        />
      )}
    </>
  );
}

/** NWS → Two-step sign-in: this account's authenticator and, for admins, the STAFF_MFA rule. */
export function MfaPanel({ isAdmin, toast }: { isAdmin: boolean; toast: (m: string, bad?: boolean) => void }) {
  const t = useT(AUTH);
  const { lang } = useLang();
  const [s, setS] = useState<Status | null>(null);
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    mfaState().then(setS);
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);
  if (!s) return null;

  async function remove() {
    if (!s?.factorId) return;
    if (s.aal !== "aal2") return toast(t("mfaRemoveAal"), true);
    setBusy(true);
    const { error } = await supabase("nws").auth.mfa.unenroll({ factorId: s.factorId });
    setBusy(false);
    if (error) return toast(error.message, true);
    toast(t("mfaRemoved"));
    load();
  }

  async function setPolicy(on: boolean) {
    if (on && s?.aal !== "aal2") return toast(t("mfaPolicyNeedsAal"), true);
    setBusy(true);
    const { error } = await supabase("nws").rpc("staff_set_staff_mfa", { p_on: on, p_reason: reason.trim() });
    setBusy(false);
    if (error) return toast(friendlyError(error, lang), true);
    setReason("");
    toast(t("mfaPolicySaved"));
    load();
  }

  return (
    <>
      <div className="panel">
        <h2>{t("mfaTitle")}</h2>
        <div className="pad">
          <p>{s.hasFactor ? t("mfaOn") : t("mfaOff")}</p>
          {s.hasFactor ? (
            <button className="btn bad" disabled={busy} onClick={remove}>
              {t("mfaRemove")}
            </button>
          ) : adding ? (
            <div style={{ maxWidth: 420 }}>
              <MfaEnroll
                onDone={() => {
                  setAdding(false);
                  toast(t("mfaAdded"));
                  load();
                }}
              />
            </div>
          ) : (
            <button className="btn pri" onClick={() => setAdding(true)}>
              {t("mfaStart")}
            </button>
          )}
        </div>
      </div>
      {isAdmin && (
        <div className="panel">
          <h2>
            {t("mfaPolicy")} <small>{s.required ? t("mfaPolicyOn") : t("mfaPolicyOff")}</small>
          </h2>
          <div className="pad">
            <div className="fld">
              <label htmlFor="mfaR">{t("mfaReason")}</label>
              <input id="mfaR" className="in" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button className="btn pri" disabled={busy || reason.trim().length < 3} onClick={() => setPolicy(!s.required)}>
              {s.required ? t("mfaMakeOptional") : t("mfaRequire")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
