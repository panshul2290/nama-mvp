"use client";

import "./auth.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { APP_INFO, Brand, Credits, Ripples } from "./AuthChrome";
import type { AppKey } from "./session";

const GROUPS: { title: string; apps: { key: AppKey; meta: string }[] }[] = [
  { title: "Nama Water Services", apps: [{ key: "nws", meta: "Control room, live map and alerts" }] },
  {
    title: "Customers",
    apps: [
      { key: "customer", meta: "Order, pay and track live" },
      { key: "business", meta: "Bulk orders on account" },
    ],
  },
  {
    title: "Tanker companies",
    apps: [
      { key: "driver", meta: "Jobs near you, upfront earnings" },
      { key: "company", meta: "Fleet, permits and payouts" },
    ],
  },
];

export function Launcher() {
  const router = useRouter();
  // Opens an app in its own phone-sized window, so two can sit side by side.
  const openWindow = (app: AppKey, left: number) => {
    const w = window.open(`/login?app=${app}`, `nama-${app}`, `popup,width=460,height=900,left=${left},top=40`);
    if (!w) router.push(`/login?app=${app}`);
  };
  return (
    <div className="si lch">
      <div className="glow" />
      <Ripples />
      <div className="lc-wrap">
        <div className="lc-top">
          <Brand sub="Integrated digital platform" />
        </div>
        <div className="lc-hero">
          <div className="si-eb">
            <i />
            Five connected apps, one live system
          </div>
          <h1>Choose an app to sign in</h1>
          <p className="si-lead">
            Place an order in the customer app and watch it reach a driver, the NWS control room and the tanker company in real time. Every app works on the same live data.
          </p>
        </div>
        <div className="lc-groups">
          {GROUPS.map((g) => (
            <section className="lc-g" key={g.title} style={{ "--n": g.apps.length } as React.CSSProperties}>
              <h2>{g.title}</h2>
              <div className="lc-cards">
                {g.apps.map(({ key, meta }) => {
                  const a = APP_INFO[key];
                  return (
                    <Link key={key} className="lc-card" href={`/login?app=${key}`}>
                      <span className="lc-ic">
                        <Icon name={a.icon} size={22} />
                      </span>
                      <span className="lc-t">
                        <b>{a.name}</b>
                        <em>{a.platform}</em>
                      </span>
                      <span className="lc-d">{a.blurb}</span>
                      <span className="lc-meta">
                        <i />
                        {meta}
                      </span>
                      <span className="lc-go">Open</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <section className="lc-live" aria-label="Watch an order end to end">
          <div className="lc-main">
            <span className="lc-ic">
              <Icon name="route" size={22} />
            </span>
            <div>
              <b>Watch an order end to end</b>
              <p>The customer app and the driver app side by side, updating live as the tanker is dispatched, fills, drives and delivers. The NWS control room and the company portal see the same job.</p>
              <div className="btns">
                <button className="si-btn" style={{ height: 40, padding: "0 16px" }} onClick={() => openWindow("customer", 40)}>
                  Open the Customer app
                </button>
                <button className="si-btn gh" style={{ height: 40, padding: "0 16px" }} onClick={() => openWindow("driver", 520)}>
                  Open the Driver app
                </button>
              </div>
            </div>
          </div>
          <aside>
            <h3>How to run it</h3>
            <ol>
              <li>
                Open the <b>Customer app</b> and the <b>Driver app</b> side by side in two browser windows. Each window needs its own sign-in, so use a private (incognito) window or a second browser for one of them.
              </li>
              <li>In the driver app, go online. In the customer app, request a tanker and pay.</li>
              <li>The driver accepts, fills at an NWS station, drives and captures proof of delivery — both apps update live.</li>
              <li>
                No second person? Run <code>npm run demo</code> — it plays the seeded customer and driver through a full order (request, accept, drive, deliver) on the live system.
              </li>
            </ol>
          </aside>
        </section>

        <div className="lc-foot">
          <Credits copy="© 2026 Nama Water Services · Demonstration system" />
        </div>
      </div>
    </div>
  );
}
