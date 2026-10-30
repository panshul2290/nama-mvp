"use client";

import "@/app/nws/nws.css";
import "./portal.css";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, NamaLogo, type IconName } from "@/components/icons";
import { supabase } from "@/lib/supabase/client";
import type { OrgRole, Profile, Role } from "@/lib/types";
import { ToastProvider } from "./kit";
import { appFor, areaApp, enforceSessionChoice, signOutApp } from "./session";

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const signIn = `/login?app=${appFor(expected)}`;
      if (await enforceSessionChoice()) return router.replace(signIn);
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace(signIn);
      const { data } = await db.from("profiles").select("id, role, full_name, phone, company_id, org_id, org_role").eq("id", auth.user.id).single();
      if (cancelled) return;
      if (!data) return router.replace(signIn);
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
  const root = tabs?.[0]?.href;

  // Signs out of this portal only; its sign-in opens again.
  async function signOut() {
    const key = areaApp(path);
    await signOutApp(key);
    router.replace(key ? `/login?app=${key}` : "/");
  }

  return (
    <div className="nws portal">
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
            <button className="pill" onClick={signOut}>
              <Icon name="logout" size={16} />
              Sign out
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
            <nav className="ptabs" aria-label={`${app} sections`}>
              {tabs.map((t) => {
                const on = t.href === root ? path === t.href : path.startsWith(t.href);
                return (
                  <Link key={t.href} href={t.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
                    {t.label}
                    {!!t.badge && <span className="tc">{t.badge}</span>}
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
  return (
    <div className="nws portal">
      <div className="pwrap">
        <div className="ploading" role="status" aria-label="Loading">
          <span className="spin" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
