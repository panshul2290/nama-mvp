"use client";

import "./auth.css";
import Link from "next/link";
import { Icon, NamaLogo, type IconName } from "@/components/icons";
import type { AppKey } from "./session";

// Copy for each app's sign-in and sign-up screens (prototype.html: vSignin, vLauncher).
export const APP_INFO: Record<
  AppKey,
  { name: string; platform: string; icon: IconName; title: string; sub: string; emailLabel: string; blurb: string; signupRole: "customer" | "driver" | "owner" | "business" | null }
> = {
  nws: {
    name: "NWS staff portal",
    platform: "Web",
    icon: "map",
    title: "Sign in",
    sub: "For Nama staff — control room, permits, customer care and finance.",
    emailLabel: "Work email",
    blurb: "Control room, permits and enforcement, customers, complaints, reports and settings.",
    signupRole: null,
  },
  customer: {
    name: "Customer app",
    platform: "iOS and Android",
    icon: "phone",
    title: "Sign in",
    sub: "Order drinking water, wastewater pickup or treated water from permitted tankers.",
    emailLabel: "Email",
    blurb: "Households order water, pay, track the tanker live and rate every delivery.",
    signupRole: "customer",
  },
  business: {
    name: "Business portal",
    platform: "Web",
    icon: "building",
    title: "Sign in to your business account",
    sub: "Hotels, compounds, farms and government sites ordering on account.",
    emailLabel: "Work email",
    blurb: "Hotels, compounds, farms and government sites order in bulk on credit.",
    signupRole: "business",
  },
  driver: {
    name: "Driver app",
    platform: "iOS and Android",
    icon: "truck",
    title: "Sign in",
    sub: "For drivers of NWS-permitted tankers. Your company adds you in the Company portal.",
    emailLabel: "Email",
    blurb: "Drivers go online, accept jobs, fill at NWS stations and prove every delivery.",
    signupRole: "driver",
  },
  company: {
    name: "Company portal",
    platform: "Web",
    icon: "users",
    title: "Sign in to your company",
    sub: "Tanker owners — fleet, drivers, permits, contracts and earnings.",
    emailLabel: "Email",
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
  return (
    <div className="si-brand">
      <NamaLogo />
      <i className="dv" aria-hidden="true" />
      <span>
        <b>Tanker Operations</b>
        <span>{sub}</span>
      </span>
    </div>
  );
}

export function Credits({ copy = "© 2026 Nama Water Services. All data in this system belongs to NWS." }: { copy?: string }) {
  return (
    <>
      <div className="si-foot">
        <span>
          <small>Developed by</small>
          <b>Aldar Development Projects</b>
        </span>
      </div>
      <div className="si-copy">{copy}</div>
    </>
  );
}

/** Two-column desktop sign-in/sign-up frame: hero on the left, card on the right. */
export function AuthFrame({ app, children }: { app: AppKey; children: React.ReactNode }) {
  const info = APP_INFO[app];
  return (
    <div className="si">
      <div className="glow" />
      <Ripples />
      <div className="si-grid">
        <div className="si-left">
          <Brand sub={info.name} />
          <div className="si-hero">
            <div className="si-eb">
              <i />
              Permits, dispatch and tracking
            </div>
            <h1>
              Every tanker permitted.<span>Every delivery verified.</span>
            </h1>
            <p className="si-lead">
              One platform for drinking-water, wastewater and treated-effluent tankers across Oman — from the customer’s request to discharge at an approved plant.
            </p>
            <div className="si-steps">
              {[
                ["1", "Request", "Customers order in the app, the web portal or through the call centre"],
                ["2", "Dispatch", "The nearest permitted tanker gets the job, with earnings shown upfront"],
                ["3", "Verify", "GPS geofences, flow meters and proof of delivery close every trip"],
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
              <Icon name="back" size={16} />
              All apps
            </Link>
            <span className="sp" />
            <b>English</b>
          </div>
          <div className="si-card">
            <div className="si-app">
              <Icon name={info.icon} size={16} />
              {info.name}
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
