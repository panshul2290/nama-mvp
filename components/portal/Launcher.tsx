"use client";

import "./auth.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { useLang, useT } from "@/lib/i18n";
import { APP_INFO, Brand, Credits, Ripples } from "./AuthChrome";
import { AUTH } from "./authI18n";
import { LAUNCHER } from "./dict";
import { PortalLangToggle } from "./i18n";
import type { AppKey } from "./session";

// Keys of LAUNCHER (components/portal/dict.ts): group title, and per app its meta and blurb.
const GROUPS: { title: string; apps: { key: AppKey; meta: string; blurb: string }[] }[] = [
  { title: "gNws", apps: [{ key: "nws", meta: "mNws", blurb: "bNws" }] },
  {
    title: "gCustomers",
    apps: [
      { key: "customer", meta: "mCustomer", blurb: "bCustomer" },
      { key: "business", meta: "mBusiness", blurb: "bBusiness" },
    ],
  },
  {
    title: "gCompanies",
    apps: [
      { key: "driver", meta: "mDriver", blurb: "bDriver" },
      { key: "company", meta: "mCompany", blurb: "bCompany" },
    ],
  },
];

export function Launcher() {
  const router = useRouter();
  const { lang, dir } = useLang();
  const t = useT(LAUNCHER);
  const ta = useT(AUTH);
  // Opens an app in its own phone-sized window, so two can sit side by side.
  const openWindow = (app: AppKey, left: number) => {
    const w = window.open(`/login?app=${app}`, `nama-${app}`, `popup,width=460,height=900,left=${left},top=40`);
    if (!w) router.push(`/login?app=${app}`);
  };
  return (
    <div className="si lch" dir={dir} lang={lang}>
      <div className="glow" />
      <Ripples />
      <div className="lc-wrap">
        <div className="lc-top">
          <Brand sub={t("platform")} />
          <PortalLangToggle />
        </div>
        <div className="lc-hero">
          <div className="si-eb">
            <i />
            {t("eyebrow")}
          </div>
          <h1>{t("title")}</h1>
          <p className="si-lead">{t("lead")}</p>
        </div>
        <div className="lc-groups">
          {GROUPS.map((g) => (
            <section className="lc-g" key={g.title} style={{ "--n": g.apps.length } as React.CSSProperties}>
              <h2>{t(g.title)}</h2>
              <div className="lc-cards">
                {g.apps.map(({ key, meta, blurb }) => {
                  const a = APP_INFO[key];
                  return (
                    <Link key={key} className="lc-card" href={`/login?app=${key}`}>
                      <span className="lc-ic">
                        <Icon name={a.icon} size={22} />
                      </span>
                      <span className="lc-t">
                        <b>{ta(`app_${key}`)}</b>
                        <em>{t(a.platform === "Web" ? "web" : "mobile")}</em>
                      </span>
                      <span className="lc-d">{t(blurb)}</span>
                      <span className="lc-meta">
                        <i />
                        {t(meta)}
                      </span>
                      <span className="lc-go">{t("open")}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <section className="lc-live" aria-label={t("watch")}>
          <div className="lc-main">
            <span className="lc-ic">
              <Icon name="route" size={22} />
            </span>
            <div>
              <b>{t("watch")}</b>
              <p>{t("watchBody")}</p>
              <div className="btns">
                <button className="si-btn" style={{ height: 40, padding: "0 16px" }} onClick={() => openWindow("customer", 40)}>
                  {t("openCustomer")}
                </button>
                <button className="si-btn gh" style={{ height: 40, padding: "0 16px" }} onClick={() => openWindow("driver", 520)}>
                  {t("openDriver")}
                </button>
              </div>
            </div>
          </div>
          <aside>
            <h3>{t("howTo")}</h3>
            <ol>
              <li>{t("how1")}</li>
              <li>{t("how2")}</li>
              <li>{t("how3")}</li>
              <li>
                {/* i18n-ignore: a command */}
                {t("how4a")} <code dir="ltr">npm run demo</code> {t("how4b")}
              </li>
            </ol>
          </aside>
        </section>

        <div className="lc-foot">
          <Credits copy={t("copy")} />
        </div>
      </div>
    </div>
  );
}
