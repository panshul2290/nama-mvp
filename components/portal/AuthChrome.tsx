"use client";

import "./auth.css";
import Link from "next/link";
import { Icon, NamaLogo, type IconName } from "@/components/icons";
import { useLang, useT } from "@/lib/i18n";
import { AUTH } from "./authI18n";
import { PortalLangToggle } from "./i18n";
import type { AppKey } from "./session";

// Copy for each app's sign-in and sign-up screens (prototype.html: vSignin, vLauncher).
export const APP_INFO: Record<
  AppKey,
  { name: string; platform: string; icon: IconName; title: string; sub: string; blurb: string; signupRole: "customer" | "driver" | "owner" | "business" | null }
> = {
  nws: {
    name: "NWS staff portal",
    platform: "Web",
    icon: "map",
    title: "Sign in",
    sub: "For Nama staff — control room, permits, customer care and finance.",
    blurb: "Control room, permits and enforcement, customers, complaints, reports and settings.",
    signupRole: null,
  },
  customer: {
    name: "Customer app",
    platform: "iOS and Android",
    icon: "phone",
    title: "Sign in",
    sub: "Order drinking water, wastewater pickup or treated water from permitted tankers.",
    blurb: "Households order water, pay, track the tanker live and rate every delivery.",
    signupRole: "customer",
  },
  business: {
    name: "Business portal",
    platform: "Web",
    icon: "building",
    title: "Sign in to your business account",
    sub: "Hotels, compounds, farms and government sites ordering on account.",
    blurb: "Hotels, compounds, farms and government sites order in bulk on credit.",
    signupRole: "business",
  },
  driver: {
    name: "Driver app",
    platform: "iOS and Android",
    icon: "truck",
    title: "Sign in",
    sub: "For drivers of NWS-permitted tankers. Your company adds you in the Company portal.",
    blurb: "Drivers go online, accept jobs, fill at NWS stations and prove every delivery.",
    signupRole: "driver",
  },
  company: {
    name: "Company portal",
    platform: "Web",
    icon: "users",
    title: "Sign in to your company",
    sub: "Tanker owners — fleet, drivers, permits, contracts and earnings.",
    blurb: "Owners register tankers and drivers, renew permits, accept contracts and track earnings.",
    signupRole: "owner",
  },
};

/** The prototype's faint water ripples behind the auth screens. */
export function Ripples() {
  const paths: { d: string; o: number }[] = [];
  for (let i = 0; i < 16; i++) {
    const y = 40 + i * 28;
    const a = 5 + i * 0.9;
    let d = `M -20 ${y}`;
    for (let x = 0; x <= 1480; x += 120) d += ` Q ${x + 30} ${y - a} ${x + 60} ${y} T ${x + 120} ${y}`;
    paths.push({ d, o: 0.05 + i * 0.008 });
  }
  return (
    <svg className="rip" viewBox="0 0 1440 500" preserveAspectRatio="none" aria-hidden="true">
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke="#3FD6E3" strokeOpacity={p.o.toFixed(3)} strokeWidth="1.2" />
      ))}
    </svg>
  );
}

export function Brand({ sub }: { sub: string }) {
  const t = useT(AUTH);
  return (
    <div className="si-brand">
      <NamaLogo />
      <i className="dv" aria-hidden="true" />
      <span>
        <b>{t("tankerOps")}</b>
        <span>{sub}</span>
      </span>
    </div>
  );
}

export function Credits({ copy }: { copy?: string }) {
  const t = useT(AUTH);
  return (
    <>
      <div className="si-foot">
        {/* eslint-disable-next-line @next/next/no-img-element -- small static SVG, also in the static mobile export */}
        <img className="al" src="/brand/aldar-mark.svg" alt="" aria-hidden="true" />
        <span>
          <small>{t("devBy")}</small>
          {/* i18n-ignore: company name */}
          <b>Aldar Development Projects</b>
        </span>
      </div>
      <div className="si-copy">{copy ?? t("copy")}</div>
    </>
  );
}

/** Two-column desktop sign-in/sign-up frame: hero on the left, card on the right. */
export function AuthFrame({ app, children }: { app: AppKey; children: React.ReactNode }) {
  const info = APP_INFO[app];
  const { lang, dir } = useLang();
  const t = useT(AUTH);
  const name = t(`app_${app}`);
  return (
    <div className="si" dir={dir} lang={lang}>
      <div className="glow" />
      <Ripples />
      <div className="si-grid">
        <div className="si-left">
          <Brand sub={name} />
          <div className="si-hero">
            <div className="si-eb">
              <i />
              {t("heroEyebrow")}
            </div>
            <h1>
              {t("heroTitle")}
              <span>{t("heroTitle2")}</span>
            </h1>
            <p className="si-lead">{t("heroLead")}</p>
            <div className="si-steps">
              {[
                ["1", t("step1"), t("step1s")],
                ["2", t("step2"), t("step2s")],
                ["3", t("step3"), t("step3s")],
              ].map(([n, a, b]) => (
                <div className="si-step" key={n}>
                  <h3>
                    <i>{n}</i>
                    {a}
                  </h3>
                  <p>{b}</p>
                </div>
              ))}
            </div>
          </div>
          <Credits />
        </div>
        <div className="si-right">
          <div className="si-lang">
            <Link className="si-back" href="/">
              <Icon name="back" size={16} className="rtl-flip" />
              {t("allApps")}
            </Link>
            <span className="sp" />
            <PortalLangToggle />
          </div>
          <div className="si-card">
            <div className="si-app">
              <Icon name={info.icon} size={16} />
              {name}
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
