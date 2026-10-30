"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NamaLogo } from "@/components/icons";
import { LangProvider, useLang } from "@/lib/i18n";
import { signOutApp } from "@/components/portal/session";
import { currentApp, supabase } from "@/lib/supabase/client";

function appTitle(path: string): [string, string] {
  if (path.startsWith("/customer")) return ["Customer app", "For households · iOS and Android"];
  if (path.startsWith("/driver") || path.startsWith("/onboarding")) return ["Driver app", "For tanker drivers · iOS and Android"];
  return ["Tanker Operations", "Integrated digital platform"];
}

function Clock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: false }));
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  return <span suppressHydrationWarning>{now ?? "9:41"}</span>;
}

export function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <LangProvider>
      <Frame>{children}</Frame>
    </LangProvider>
  );
}

// Desktop portals (NWS staff, tanker companies, businesses) have their own layout.
const DESKTOP = ["/nws", "/company", "/business"];

function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { lang, dir } = useLang();
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [title, sub] = appTitle(path);

  // Each app has its own session: follow the one of the app on screen.
  useEffect(() => {
    const db = supabase();
    db.auth.getSession().then(({ data }) => setSignedIn(Boolean(data.session)));
    const { data } = db.auth.onAuthStateChange((_e, session) => setSignedIn(Boolean(session)));
    return () => data.subscription.unsubscribe();
  }, [path]);

  async function signOut() {
    const app = currentApp();
    await signOutApp(app);
    router.replace(app ? `/login?app=${app}` : "/login");
  }

  // The NWS staff portal is a desktop layout of its own (no phone frame).
  // The launcher at / is full-screen too.
  if (path === "/" || DESKTOP.some((p) => path.startsWith(p))) return <>{children}</>;

  return (
    <div className="page">
      <header className="ph-bar">
        <NamaLogo />
        <span className="dv" aria-hidden="true" />
        <span>
          <b>{title}</b>
          <small>{sub}</small>
        </span>
        <span className="sp" />
        {signedIn && (
          <button className="pill-btn" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>
      <div className="stage">
        <div className="phone" dir={dir} lang={lang}>
          <div className="sbar" aria-hidden="true">
            <Clock />
            <span className="sig">5G ▮▮▮</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
