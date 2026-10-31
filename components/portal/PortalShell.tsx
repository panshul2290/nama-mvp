"use client";

import "@/app/nws/nws.css";
import "./portal.css";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, NamaLogo, type IconName } from "@/components/icons";
import { localDigits, useLang, useT } from "@/lib/i18n";
import { contactPhones } from "@/lib/phones";
import { supabase } from "@/lib/supabase/client";
import type { OrgRole, Profile, Role } from "@/lib/types";
import { PORTAL } from "./dict";
import { PortalLangToggle } from "./i18n";
import { ToastProvider } from "./kit";
import { appFor, areaApp, enforceSessionChoice, signOutApp, useSessionEnd } from "./session";

export type PortalProfile = Profile & { company_id: string | null; org_id: string | null; org_role: OrgRole | null };

/**
 * Loads the signed-in user's profile (with company/org links) from this portal's own
 * session. A role that doesn't match (an edge case: each sign-in admits only its own
 * accounts) signs this portal out and its sign-in says which app to use. A portal never
 * opens another app. RLS guards every query anyway.
 */
export function usePortalProfile(expected: Role) {
  const router = useRouter();
  const [profile, setProfile] = useState<PortalProfile | null>(null);
  const [nonce, setNonce] = useState(0);
  useSessionEnd(`/login?app=${appFor(expected)}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const signIn = `/login?app=${appFor(expected)}`;
      if (await enforceSessionChoice()) return router.replace(signIn);
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace(signIn);
      const { data: row } = await db.from("profiles").select("id, role, full_name, company_id, org_id, org_role").eq("id", auth.user.id).single();
      if (cancelled) return;
      if (!row) return router.replace(signIn);
      const data = { ...row, phone: (await contactPhones(db, [row.id])).get(row.id) ?? null };
      if (cancelled) return;
      if (data.role !== expected) {
        await signOutApp();
        return router.replace(`${signIn}&wrong=${data.role}`);
      }
      setProfile(data as PortalProfile);
    })();
    return () => {
      cancelled = true;
    };
  }, [expected, router, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { profile, reload };
}

export type PortalTab = { href: string; label: string; icon?: IconName; badge?: number };

export function PortalShell({
  app,
  who,
  title,
  description,
  tabs,
  banner,
  actions,
  children,
}: {
  app: string;
  who: string;
  title: string;
  description: string;
  tabs?: PortalTab[];
  banner?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const { lang, dir } = useLang();
  const t = useT(PORTAL);
  const root = tabs?.[0]?.href;

  // Signs out of this portal only; its sign-in opens again.
  async function signOut() {
    const key = areaApp(path);
    await signOutApp(key);
    router.replace(key ? `/login?app=${key}` : "/");
  }

  return (
    <div className="nws portal" dir={dir} lang={lang}>
      <ToastProvider>
        <div className="pwrap">
          <header className="wtop">
            <NamaLogo />
            <i className="dv" aria-hidden="true" />
            <span>
              <b>{app}</b>
              <small>{who}</small>
            </span>
            <span className="sp" />
            <PortalLangToggle />
            <Link className="pill" href="/" title={t("allAppsTitle")}>
              <Icon name="home" size={16} />
              {t("allApps")}
            </Link>
            <button className="pill" onClick={signOut}>
              <Icon name="logout" size={16} className="rtl-flip" />
              {t("signOut")}
            </button>
          </header>
          <div className="vhead">
            <div>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
            {actions}
          </div>
          {banner}
          {tabs && (
            <nav className="ptabs" aria-label={t("sections", { app })}>
              {tabs.map((tab) => {
                const on = tab.href === root ? path === tab.href : path.startsWith(tab.href);
                return (
                  <Link key={tab.href} href={tab.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
                    {tab.label}
                    {!!tab.badge && <span className="tc">{localDigits(tab.badge, lang)}</span>}
                  </Link>
                );
              })}
            </nav>
          )}
          {children}
        </div>
      </ToastProvider>
    </div>
  );
}

/** Full-page loading state inside the dark portal frame. */
export function PortalLoading() {
  const { lang, dir } = useLang();
  return (
    <div className="nws portal" dir={dir} lang={lang}>
      <div className="pwrap">
        <div className="ploading" role="status" aria-label={PORTAL.loading[lang]}>
          <span className="spin" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
